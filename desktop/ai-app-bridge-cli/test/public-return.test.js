'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { publicReply, publicFailure, exitCodeFor } = require('../bin/public-reply');
const { CommandError } = require('../bin/command-errors');
const { encodeReply, decodeReply } = require('../bin/runtime-protocol');
const { createMcpClient } = require('../scripts/validation/mcp-jsonrpc-client');
const host = require('../bin/execution-host');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-public-return-'));
const env = { ...process.env, ADB: '/unavailable-public-return-adb',
  AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'facts'),
  AI_APP_BRIDGE_RUNTIME_HOME: path.join(directory, 'runtimes') };
const cli = path.resolve(__dirname, '../bin/ai-app-bridge.js');
const target = { serial: 'public-return-device', packageName: 'example.app', feedback: 'off' };
test.after(async () => { await host.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('public validation rejects missing and invalid extract before touching a provider or storage', async () => {
  let calls = 0;
  const dependencies = { rawRunner: async () => { calls++; return { ok: true }; }, factRecorder: null, observationCollector: null };
  for (const fields of [{}, { extract: 'null' }, { extract: true }, { extract: {} },
    { extract: { mode: 'regex', pattern: '[', inputPath: '' } }, { extract: null, output: { maxBytes: 1 } }]) {
    const { value: reply } = await host.run({ command: 'tree', arguments: target, ...fields }, dependencies);
    assert.equal(reply.failureStage, 'validation');
    assert.equal(reply.execution.ok, false);
    assert.equal(reply.execution.dispatched, false);
    assert.equal(exitCodeFor(reply), 1);
  }
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(env.AI_APP_BRIDGE_FACT_STORE_DIR), false);
});

test('CLI parses envelope flags first and reports their validation failures in one public reply', () => {
  for (const [flags, field] of [[[], 'extract'], [['--extract'], 'extract'],
    [['--extract', '--feedback', 'off'], 'extract'], [['--extract', '"null"'], 'extract'],
    [['--extract', '{'], 'extract'], [['--extract', 'null', '--output'], 'output']]) {
    const result = spawnSync(process.execPath, [cli, 'status', ...flags], { env, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    const reply = JSON.parse(result.stdout);
    assert.equal(reply.failureStage, 'validation');
    assert.equal(reply.execution.field, field);
    assert.equal(reply.execution.dispatched, false);
    assert.equal(result.stdout, JSON.stringify(reply) + '\n');
  }
  assert.equal(fs.existsSync(env.AI_APP_BRIDGE_RUNTIME_HOME), false);
});

test('Host, MCP and CLI validation errors honor a valid budget before business validation', async () => {
  const unknown = 'x'.repeat(6000);
  const request = { command: 'tree', arguments: { ...target, [unknown]: true }, extract: null, output: { maxBytes: 16384 } };
  const check = reply => {
    assert.equal(reply.failureStage, 'validation');
    assert.equal(reply.execution.dispatched, false);
    assert.equal(reply.delivery.limitBytes, 16384);
    assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= 16384);
  };
  check((await host.run(request, { rawRunner() { assert.fail('invalid request dispatched'); } })).value);
  const client = createMcpClient({ serverPath: path.resolve(__dirname, '../bin/mcp-server.js'), env,
    transcriptPath: path.join(directory, 'budget-mcp.jsonl'), stderrPath: path.join(directory, 'budget-mcp.stderr') });
  try {
    await client.initialize();
    const result = await client.request('tools/call', { name: 'run', arguments: request });
    check(JSON.parse(result.result.content[0].text));
    assert.equal(result.result.isError, true);
  } finally { await client.close({ stopRuntime: false }); }
  for (const args of [[`--${unknown}`, 'true', '--extract', 'null'], ['--extract', 'x'.repeat(20000)],
    ['--extract', 'null', 'x'.repeat(20000)], ['--extract', 'null', '--' + 'X'.repeat(20000)]]) {
    const result = spawnSync(process.execPath, [cli, 'tree', '--serial', target.serial,
      '--package-name', target.packageName, '--output', '{"maxBytes":16384}', ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    check(JSON.parse(result.stdout));
  }
  const early = spawnSync(process.execPath, [cli, 'tree', 'x'.repeat(20000), '--extract', 'null', '--output', '{"maxBytes":16384}'], { env, encoding: 'utf8' });
  assert.equal(early.status, 1); check(JSON.parse(early.stdout));
  assert.equal(fs.existsSync(env.AI_APP_BRIDGE_RUNTIME_HOME), false);
});

test('null keeps the original value and feedback and executes a mutation only once', async () => {
  let calls = 0;
  const value = { ok: true, dispatched: true, ambiguous: false, settled: true,
    executionReceipt: { actionId: 'original-action' }, _feedback: { evidence: [], marker: 'kept' },
    data: { execution: { ok: false }, control: { operationId: 'business-data' } } };
  const { value: reply } = await host.run({ command: 'tap-text', extract: null, arguments: { ...target, targetText: 'Save' } }, {
    rawRunner: async () => { calls++; return value; }, factRecorder: null, observationCollector: null,
  });
  assert.equal(calls, 1);
  assert.equal(reply.value._feedback.marker, 'kept');
  assert.deepEqual(reply.value.data, value.data);
  assert.equal(reply.control.operationId, undefined);
  assert.deepEqual(reply.execution.executionReceipt, { actionId: 'original-action' });
  assert.equal(reply.extraction.status, 'skipped');
  assert.equal(reply.control.source.persisted, false);
  assert.equal(reply.control.source.reason, 'not_requested');
  assert.equal(reply.control.source.ref, undefined);
  assert.equal(exitCodeFor(reply), 0);
  assert.deepEqual(decodeReply(JSON.parse(JSON.stringify(encodeReply({ value: reply })))).value, reply);
});

test('completed raw JSON, text and bytes preserve their values through the public host', async () => {
  for (const value of [null, false, 0, [], '原始文本\n第二行', Buffer.from([0, 255, 13, 10])]) {
    const { value: reply } = await host.run({ command: 'uia-tree', extract: null, arguments: target }, {
      rawRunner: async () => value, factRecorder: null, observationCollector: null,
    });
    assert.deepEqual(reply.value, Buffer.isBuffer(value) ? value.toString('base64') : value);
    assert.equal(reply.kind, Buffer.isBuffer(value) ? 'bytes' : typeof value === 'string' ? 'text' : 'json');
    assert.equal(reply.execution.ok, true);
    assert.equal(exitCodeFor(reply), 0);
  }
});

test('unknown and ambiguous execution cannot become success from an otherwise usable value', () => {
  for (const value of [{ data: 'no outcome' }, { ok: null }, { ok: true, ambiguous: true }, { ok: false, error: 'failed' }]) {
    const reply = publicReply({ command: 'tap', reply: { value }, completed: true });
    assert.deepEqual(reply.value, value);
    assert.equal(reply.failureStage, 'execution');
    assert.equal(exitCodeFor(reply), 1);
  }
  const reply = publicFailure({ command: 'tap', stage: 'execution',
    error: new CommandError('runtime_connection_lost', 'response lost', { dispatched: null, ambiguous: true }) });
  assert.equal(reply.execution.dispatched, null);
  assert.equal(reply.execution.ambiguous, true);
});

test('Script and both Intent facades protect continuation without copying full history', () => {
  const history = { items: [{ payload: 'large source content' }], lastSequence: 11, hasMore: true, gap: false };
  for (const command of ['intent', 'install-apk', 'permission-dialog']) {
    const value = { ok: true, operationId: 'op', status: 'waiting_for_decision', revision: 3, history,
      lastAction: { ok: false, actionId: 'previous-action' } };
    const reply = publicReply({ command, reply: { value } });
    assert.deepEqual(reply.control.history, { lastSequence: 11, hasMore: true, gap: false });
    assert.equal(reply.control.revision, 3);
    assert.deepEqual(reply.control.lastAction, value.lastAction);
    assert.equal(reply.execution.ok, true, 'past action failure is not this status request');
    assert.deepEqual(reply.value.history, history);
  }
  const question = { requestId: 'ask-1', revision: 1, request: { question: 'Continue?', context: { phase: 'test' } } };
  const reply = publicReply({ command: 'script', reply: { value: { ok: true, status: 'waiting_for_agent',
    operationId: 'script-op', events: [], pendingQuestion: question, history, eventSequence: 20 } } });
  assert.deepEqual(reply.control.pendingQuestion, question);
  assert.equal(reply.control.eventSequence, 20);
});

test('actual MCP tools/list exposes nullable required extract without starting a Runtime', async () => {
  const client = createMcpClient({ serverPath: path.resolve(__dirname, '../bin/mcp-server.js'), env,
    transcriptPath: path.join(directory, 'mcp.jsonl'), stderrPath: path.join(directory, 'mcp.stderr') });
  try {
    await client.initialize();
    const { result: { tools } } = await client.request('tools/list', {});
    assert.deepEqual(tools.map(tool => tool.name), ['capabilities', 'run']);
    const schema = tools.find(tool => tool.name === 'run').inputSchema;
    assert.deepEqual(schema.required, ['command', 'extract']);
    assert.equal(schema.properties.extract.oneOf[0].type, 'null');
    assert.match(schema.properties.extract.description, /do not repeat the action/);
    const result = await client.request('tools/call', { name: 'run', arguments: { command: 'status' } });
    const reply = JSON.parse(result.result.content[0].text);
    assert.equal(result.result.isError, true);
    assert.equal(reply.execution.field, 'extract');
    assert.equal(result.result._meta, undefined);
    assert.equal(result.result.structuredContent, undefined);
    assert.equal(fs.existsSync(env.AI_APP_BRIDGE_RUNTIME_HOME), false);
  } finally { await client.close({ stopRuntime: false }); }
});

test('capture continuation retains the original coverage and watermarks without promoting business data', () => {
  const metadata = { coverage: { status: 'partial', gap: true, committed: false },
    window: { afterActionId: 'action-1' }, runtimeEpoch: 'epoch-1', targetKey: 'example.app',
    storeGeneration: 3, watermarkCursor: 'end', nextCursor: 'next', hasMore: true, throughWatermark: false,
    barrier: { settled: false }, _factCache: { history: true, cursor: 'archive-next', hasMore: true } };
  for (const command of ['logs', 'ios-network', 'web-events', 'webview-console']) {
    const reply = publicReply({ command, reply: { value: { ok: true, ...metadata, items: [{ coverage: 'business' }] } } });
    for (const [key, value] of Object.entries(metadata)) assert.deepEqual(reply.control[key], value);
    assert.equal(reply.control.items, undefined);
  }
  const reply = publicReply({ command: 'tap-text', reply: { value: { ok: true, ...metadata } } });
  assert.equal(reply.control.coverage, undefined);
  assert.equal(reply.control._factCache, undefined);
});

test('local runtime status and offline evidence verify use the same public reply without Runtime startup', () => {
  const stopped = spawnSync(process.execPath, [cli, 'runtime', '--extract', 'null', '--operation', 'status'], { env, encoding: 'utf8' });
  const reply = JSON.parse(stopped.stdout);
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  assert.equal(reply.value.status, 'stopped');
  assert.equal(reply.execution.ok, true);
  const verify = spawnSync(process.execPath, [cli, 'evidence', '--extract', 'null', '--operation', 'verify',
    '--archive-dir', path.join(directory, 'missing-archive'), '--manifest-sha256', '0'.repeat(64)], { env, encoding: 'utf8' });
  const failure = JSON.parse(verify.stdout);
  assert.equal(verify.status, 1);
  assert.equal(failure.failureStage, 'execution');
  assert.equal(failure.execution.ok, false);
  assert.equal(fs.existsSync(path.join(env.AI_APP_BRIDGE_RUNTIME_HOME, 'endpoint.json')), false);
  assert.equal(fs.existsSync(env.AI_APP_BRIDGE_FACT_STORE_DIR), false);
});
