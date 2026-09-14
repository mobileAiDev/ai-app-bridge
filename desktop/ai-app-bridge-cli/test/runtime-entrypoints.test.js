'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runCli } = require('../test-support/cli-client');
const { createMcpClient, payloadOf } = require('../scripts/validation/mcp-jsonrpc-client');
const { encodeReply, decodeReply } = require('../bin/runtime-protocol');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-runtime-entry-'));
  const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb',
    AI_APP_BRIDGE_RUNTIME_HOME: path.join(directory, 'runtimes') };
  const clients = [];
  const cli = (command, args, options = {}) => runCli(command, args, { cwd: directory, ...options, env: { ...env, ...options.env } });
  t.after(async () => {
    const stopped = await cli('runtime', { operation: 'stop' });
    assert.equal(stopped.value.ok, true, JSON.stringify(stopped));
    for (const client of clients) await client.close({ stopRuntime: false });
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, env, cli, async mcp(cwd = directory, overrides = {}) {
    const index = clients.length;
    const client = createMcpClient({ serverPath: path.resolve(__dirname, '../bin/mcp-server.js'), cwd, env: { ...env, ...overrides },
      transcriptPath: path.join(directory, `mcp-${index}.jsonl`), stderrPath: path.join(directory, `mcp-${index}.log`) });
    clients.push(client);
    await client.initialize();
    return { client, run: async (command, args) => payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } })) };
  } };
}

async function waitFor(run, state, states) {
  while (!states.includes(state.status)) {
    assert.equal(state.ok, true, JSON.stringify(state));
    state = await run('script', { operation: 'wait', operationId: state.operationId, afterSequence: state.eventSequence, waitMs: 1000 });
  }
  return state;
}
const questionScript = { schemaVersion: 'aab.code-script/v1', language: 'javascript', permissions: [], policy: { timeoutMs: 20000 },
  source: "module.exports.main = async ctx => await ctx.askAgent({question:'Keep this task alive across connections'});" };

test('CLI PATH lookup and explicit MCP ADB share one runtime and Script result', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const bin = path.join(f.directory, 'tools'); fs.mkdirSync(bin);
  const adb = path.join(bin, process.platform === 'win32' ? 'adb.exe' : 'adb');
  fs.copyFileSync(process.execPath, adb); fs.chmodSync(adb, 0o755);
  const automatic = { ADB: undefined, PATH: `tools${path.delimiter}${process.env.PATH || ''}` };
  const source = "module.exports.main = async ctx => ({ answer: await ctx.askAgent({question:'Same ADB?'}), adb: process.env.ADB });";
  const started = await f.cli('script', { operation: 'start', script: { ...questionScript, source } }, { env: automatic });
  assert.equal(started.value.ok, true, JSON.stringify(started));
  const otherDirectory = path.join(f.directory, 'other'); fs.mkdirSync(otherDirectory);
  const { run } = await f.mcp(otherDirectory, { ADB: adb });
  const waiting = await waitFor(run, await run('script', { operation: 'status', operationId: started.value.operationId }),
    ['waiting_for_agent', 'failed', 'cancelled']);
  assert.equal(waiting.status, 'waiting_for_agent', JSON.stringify(waiting));
  const question = waiting.events.find(event => event.type === 'agent_question_created');
  const decided = await run('script', { operation: 'decide', operationId: waiting.operationId,
    requestId: question.requestId, revision: question.revision, decision: 'same executable' });
  assert.equal((await waitFor(run, decided, ['completed', 'failed', 'cancelled'])).status, 'completed');
  const result = await f.cli('script', { operation: 'result', operationId: waiting.operationId }, { env: automatic });
  assert.deepEqual(result.value.result, { answer: 'same executable', adb: fs.realpathSync(adb) }, JSON.stringify(result));
  const owner = await run('runtime', { operation: 'status' });
  assert.equal((await f.cli('runtime', { operation: 'status' }, { env: automatic })).value.runtimeId, owner.runtimeId);
  const other = path.join(f.directory, 'other-adb'); fs.copyFileSync(adb, other); fs.chmodSync(other, 0o755);
  const rejected = await f.cli('script', { operation: 'result', operationId: waiting.operationId }, { env: { ADB: other } });
  assert.equal(rejected.value.error, 'runtime_configuration_mismatch');
  assert.equal(rejected.value.dispatched, false);
  if (process.platform !== 'win32') {
    const alias = path.join(f.directory, 'adb-alias'); fs.symlinkSync(adb, alias);
    const aliased = await f.cli('script', { operation: 'result', operationId: waiting.operationId }, { env: { ADB: alias } });
    assert.deepEqual(aliased.value.result, result.value.result);
  }
  await run('runtime', { operation: 'stop' });
  const recovered = await run('script', { operation: 'result', operationId: waiting.operationId });
  assert.deepEqual(recovered.result, result.value.result);
  const reverse = await f.cli('script', { operation: 'result', operationId: waiting.operationId }, { env: automatic });
  assert.deepEqual(reverse.value.result, result.value.result);
});

test('a host without ADB can still start a runtime and execute device-independent Scripts', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const options = { env: { ADB: path.join(f.directory, 'not-installed-adb') } };
  const started = await f.cli('script', { operation: 'start', script: { ...questionScript,
    source: 'module.exports.main = async () => 42;' } }, options);
  const final = await waitFor(async (command, args) => (await f.cli(command, args, options)).value,
    started.value, ['completed', 'failed', 'cancelled']);
  assert.equal(final.status, 'completed', JSON.stringify(final));
  assert.equal((await f.cli('script', { operation: 'result', operationId: started.value.operationId }, options)).value.result, 42);
});

test('runtime replies retain JSON false/zero/null, raw XML, bytes and separate history', () => {
  for (const value of [false, 0, null, { empty: '', accepted: false }, '<hierarchy/>', Buffer.from([0, 255, 1])]) {
    const reply = { value, history: { status: 'stored' } };
    assert.deepEqual(decodeReply(JSON.parse(JSON.stringify(encodeReply(reply)))), reply);
  }
  assert.throws(() => encodeReply({ value: undefined }), { code: 'runtime_result_missing' });
  assert.throws(() => decodeReply({ kind: 'json' }), { code: 'runtime_protocol_error' });
});

test('CLI starts a real Script, another directory answers through MCP, and a later CLI reads the same result', { timeout: 20000 }, async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'marker.txt'), 'original caller directory');
  fs.writeFileSync(path.join(f.directory, 'flow.js'), "module.exports.main = async ctx => ({ answer: await ctx.askAgent({question:'Return JSON false'}), marker: require('node:fs').readFileSync('marker.txt','utf8'), cwd: process.cwd() });");
  const other = path.join(f.directory, 'other'); fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'marker.txt'), 'wrong directory');
  const started = await f.cli('script', { operation: 'start', script: { ...questionScript, source: undefined, sourcePath: './flow.js' } });
  assert.equal(started.code, 0, JSON.stringify(started));
  const { client, run } = await f.mcp(other);
  const runtime = await run('runtime', { operation: 'status' });
  const waiting = await waitFor(run, started.value, ['waiting_for_agent', 'failed', 'cancelled']);
  assert.equal(waiting.status, 'waiting_for_agent', JSON.stringify(waiting));
  const question = waiting.events.find(event => event.type === 'agent_question_created');
  const decided = await run('script', { operation: 'decide', operationId: waiting.operationId,
    requestId: question.requestId, revision: question.revision, decision: false });
  await waitFor(run, decided, ['completed', 'failed', 'cancelled']);
  await client.close({ stopRuntime: false, stdinEof: true });
  const final = await f.cli('script', { operation: 'status', operationId: waiting.operationId }, { cwd: other });
  assert.equal(final.value.status, 'completed', JSON.stringify(final));
  assert.deepEqual((await f.cli('script', { operation: 'result', operationId: waiting.operationId })).value.result,
    { answer: false, marker: 'original caller directory', cwd: fs.realpathSync(f.directory) });
  assert.equal((await f.cli('runtime', { operation: 'status' })).value.runtimeId, runtime.runtimeId);
});

test('MCP disconnect leaves its Script live for CLI decision/cancel; both entries export and verify the durable result', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const { client, run } = await f.mcp();
  const started = await run('script', { operation: 'start', script: questionScript });
  const waiting = await waitFor(run, started, ['waiting_for_agent', 'failed', 'cancelled']);
  assert.equal(waiting.status, 'waiting_for_agent');
  const runtime = await run('runtime', { operation: 'status' });
  await client.close({ stopRuntime: false });
  assert.equal((await f.cli('script', { operation: 'status', operationId: started.operationId })).value.status, 'waiting_for_agent');
  const question = waiting.events.find(event => event.type === 'agent_question_created');
  const stale = await f.cli('script', { operation: 'decide', operationId: started.operationId,
    requestId: question.requestId, revision: question.revision + 1, decision: { should: 'reject' } });
  assert.equal(stale.code, 1); assert.equal(stale.value.error, 'stale_decide');
  const cancelled = await f.cli('script', { operation: 'cancel', operationId: started.operationId });
  assert.equal(cancelled.value.status, 'cancelled');
  const archive = await f.cli('evidence', { operation: 'export', namespace: 'script', operationId: started.operationId, outputDir: './archive' });
  assert.equal(archive.value.ok, true, JSON.stringify(archive));
  assert(fs.existsSync(path.join(f.directory, 'archive', 'records.json')));
  const second = await f.mcp();
  assert.equal((await second.run('runtime', { operation: 'status' })).runtimeId, runtime.runtimeId);
  const verified = await second.run('evidence', { operation: 'verify', archiveDir: './archive', manifestSha256: archive.value.manifestSha256 });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  await second.client.close();
  const offline = await f.cli('evidence', { operation: 'verify', archiveDir: './archive', manifestSha256: archive.value.manifestSha256 }, {
    env: { AI_APP_BRIDGE_FACT_CACHE_PROFILE: 'deliberately-invalid', AI_APP_BRIDGE_RUNTIME_HOME: path.join(f.directory, 'must-not-create') },
  });
  assert.equal(offline.value.ok, true, JSON.stringify(offline));
  assert.equal(fs.existsSync(path.join(f.directory, 'must-not-create')), false);
});

test('four concurrent CLI starts converge on one OS-locked runtime', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => f.cli('runtime', { operation: 'start' })));
  for (const result of results) assert.equal(result.value.ok, true, JSON.stringify(result));
  assert.equal(new Set(results.map(result => result.value.runtimeId)).size, 1);
  assert.equal(new Set(results.map(result => result.value.pid)).size, 1);
});

test('a live owner that stops answering is never replaced or replayed', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const owner = (await f.cli('runtime', { operation: 'start' })).value;
  assert.equal(owner.status, 'running');
  process.kill(owner.pid, 'SIGSTOP');
  try {
    const rejected = await f.cli('script', { operation: 'start', operationId: 'must-not-start', script: questionScript });
    assert.equal(rejected.value.error, 'runtime_unresponsive', JSON.stringify(rejected));
    assert.equal(rejected.value.dispatched, false);
  } finally { process.kill(owner.pid, 'SIGCONT'); }
  assert.equal((await f.cli('runtime', { operation: 'status' })).value.runtimeId, owner.runtimeId);
  const absent = await f.cli('script', { operation: 'status', operationId: 'must-not-start' });
  assert.equal(absent.value.error, 'unknown_operation', JSON.stringify(absent));
});

test('CLI decisions preserve structured JSON across a disconnected MCP and a symlink to the same store', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const { client, run } = await f.mcp();
  const started = await run('script', { operation: 'start', script: questionScript });
  const waiting = await waitFor(run, started, ['waiting_for_agent', 'failed', 'cancelled']);
  assert.equal(waiting.status, 'waiting_for_agent');
  const owner = await run('runtime', { operation: 'status' });
  await client.close({ stopRuntime: false });
  const alias = path.join(f.directory, 'facts-alias');
  fs.symlinkSync(path.join(f.directory, 'facts'), alias, 'dir');
  const options = { env: { AI_APP_BRIDGE_FACT_STORE_DIR: alias } };
  assert.equal((await f.cli('runtime', { operation: 'status' }, options)).value.runtimeId, owner.runtimeId);
  const question = waiting.events.find(event => event.type === 'agent_question_created');
  const decision = { accepted: false, count: 0, empty: null, text: 'CLI 中文回答', values: [false, 0] };
  const decided = await f.cli('script', { operation: 'decide', operationId: started.operationId,
    requestId: question.requestId, revision: question.revision, decision }, options);
  const final = await waitFor(async (command, args) => (await f.cli(command, args, options)).value,
    decided.value, ['completed', 'failed', 'cancelled']);
  assert.equal(final.status, 'completed', JSON.stringify(final));
  assert.deepEqual((await f.cli('script', { operation: 'result', operationId: started.operationId })).value.result, decision);
});

test('SIGTERM to the runtime drains its actual Script and a new owner reads the durable cancellation', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const { run } = await f.mcp();
  const started = await run('script', { operation: 'start', script: questionScript });
  assert.equal((await waitFor(run, started, ['waiting_for_agent', 'failed', 'cancelled'])).status, 'waiting_for_agent');
  const owner = await run('runtime', { operation: 'status' });
  assert.equal(owner.status, 'running');
  process.kill(owner.pid, 'SIGTERM');
  let state;
  const deadline = Date.now() + 10000;
  do {
    state = await f.cli('runtime', { operation: 'status' });
    if (state.value.status === 'stopped') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.equal(state.value.status, 'stopped', JSON.stringify(state));
  const recovered = await f.cli('script', { operation: 'status', operationId: started.operationId });
  assert.equal(recovered.value.status, 'cancelled', JSON.stringify(recovered));
  assert.notEqual((await run('runtime', { operation: 'status' })).runtimeId, owner.runtimeId);
});

test('a different build or configuration cannot execute on the live runtime, while explicit inspection and stop remain possible', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const started = await f.cli('runtime', { operation: 'start' });
  const configured = await f.cli('script', { operation: 'runtime-status' }, { env: { AI_APP_BRIDGE_FACT_CACHE_PROFILE: '256mb' } });
  assert.equal(configured.value.error, 'runtime_configuration_mismatch');
  const installation = path.join(f.directory, 'other-build'); fs.mkdirSync(installation);
  fs.cpSync(path.resolve(__dirname, '../bin'), path.join(installation, 'bin'), { recursive: true });
  fs.cpSync(path.resolve(__dirname, '../runtime'), path.join(installation, 'runtime'), { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '../package.json'), path.join(installation, 'package.json'));
  fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(installation, 'node_modules'), 'dir');
  fs.appendFileSync(path.join(installation, 'bin/command-discovery.js'), '\n// Another build.\n');
  const cliPath = path.join(installation, 'bin/ai-app-bridge.js');
  const rejected = await f.cli('script', { operation: 'runtime-status' }, { cliPath });
  assert.equal(rejected.value.error, 'runtime_code_mismatch', JSON.stringify(rejected));
  const status = await f.cli('runtime', { operation: 'status' }, { cliPath });
  assert.equal(status.value.compatible, false); assert.equal(status.value.runtimeId, started.value.runtimeId);
  assert.equal((await f.cli('runtime', { operation: 'stop' }, { cliPath })).value.status, 'stopped');
});
