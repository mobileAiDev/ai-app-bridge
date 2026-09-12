'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const { createCommandRouter, isolatedCommandDefinitions } = require('../bin/command-router');
const { capabilityPayload } = require('../bin/mcp-server');
const { commandRouter } = require('../bin/execution-host');
const { runBridgeChecked, runGeneric } = require('../test-support/host-client');
const snapshot = require('./fixtures/legacy-surface-g0.json');
const capabilitySnapshot = require('./fixtures/legacy-capabilities-g0.json');

const MCP_SERVER = path.join(__dirname, '..', 'bin', 'mcp-server.js');
const SCRIPT_ENTRY = require.resolve('../bin/script/script-entry');
const INTENT_ENTRY = require.resolve('../bin/intent/intent-entry');

function payloadOf(result) {
  return JSON.parse(result.content[0].text);
}

function withoutIsolatedCommands(domains) {
  const next = {};
  for (const [domain, commands] of Object.entries(domains)) {
    next[domain] = commands.filter((item) => !['script', 'intent', 'evidence', 'tap-flutter'].includes(item.command));
  }
  return next;
}


test('G1 old commands do not load Script, Intent, or evidence modules', async () => {
  const router = createCommandRouter({
    loadScript: () => require('../bin/script/script-entry'),
    loadIntent: () => require('../bin/intent/intent-entry'),
    loadEvidence: () => { throw new Error('evidence must remain lazy'); },
    dispatchCommon: async (command) => ({ value: { ok: true, command } }),
  });
  const result = (await router.route('status', { packageName: 'com.example.app' })).value;
  assert.equal(result.ok, true);
  assert.equal(result.command, 'status');
  assert.equal(router.loads.script, 0);
  assert.equal(router.loads.intent, 0);
  assert.equal(router.loads.evidence, 0);
});

test('G1 evidence routes lazily without loading execution modules', async () => {
  const calls = [];
  const router = createCommandRouter({
    loadScript: () => { throw new Error('script must remain lazy'); },
    loadIntent: () => { throw new Error('intent must remain lazy'); },
    loadEvidence: () => ({ handle: async (args) => {
      calls.push(args);
      return { ok: true, integrity: 'verified' };
    } }),
    dispatchCommon: async () => { throw new Error('evidence must not use legacy dispatch'); },
  });
  const args = { operation: 'verify', archiveDir: '/local/archive', manifestSha256: 'a'.repeat(64) };
  assert.equal((await router.route('evidence', args)).value.integrity, 'verified');
  assert.deepEqual(calls, [args]);
  assert.deepEqual(router.loads, { script: 0, intent: 0, evidence: 1 });
});

test('G1 a throwing isolated loader does not break legacy dispatch', async () => {
  const router = createCommandRouter({
    loadScript: () => { throw new Error('script boom'); },
    loadIntent: () => { throw new Error('intent boom'); },
    dispatchCommon: async (command) => ({ value: { ok: true, command } }),
  });
  const failed = (await router.route('script', { operation: 'start' })).value;
  const legacy = (await router.route('tree', { packageName: 'com.example.app' })).value;
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'isolated_module_unavailable');
  assert.equal(legacy.ok, true);
  assert.equal(legacy.command, 'tree');
});

test('G1 an exclusive FactStore writer conflict is explicit and remains isolated', async () => {
  const router = createCommandRouter({
    loadScript: () => ({
      handle() {
        const error = new Error('store writer lock is busy');
        error.code = 'sfs_busy';
        throw error;
      },
    }),
    dispatchCommon: async () => ({ ok: true }),
  });
  const result = await router.route('script', {});
  const payload = result.value;
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'fact_store_writer_busy');
});




test('G1 public run routes isolated commands and leaves legacy errors unchanged', async () => {
  delete require.cache[SCRIPT_ENTRY];
  delete require.cache[INTENT_ENTRY];
  const unknown = await runGeneric({ command: 'page-summary' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Unknown command: page-summary/);
  const status = await runBridgeChecked('status', { serial: 'android-1' }, {
    rawRunner: async () => {
      throw new Error('status must not reach the runner without packageName or port');
    },
  });
  assert.equal(status.isError, true);
  assert.match(status.content[0].text, /packageName is required/);
  assert.equal(require.cache[SCRIPT_ENTRY], undefined);
  assert.equal(require.cache[INTENT_ENTRY], undefined);
  assert.equal(commandRouter.loads.script, 0);
  assert.equal(commandRouter.loads.intent, 0);
  assert.equal(commandRouter.loads.evidence, 0);

  const script = payloadOf(await runGeneric({ command: 'script', arguments: { operation: 'start' } }));
  const intent = payloadOf(await runGeneric({ command: 'intent', arguments: { operation: 'start' } }));
  assert.equal(script.ok, false);
  assert.equal(script.command, 'script');
  assert.notEqual(script.error, undefined);
  assert.equal(intent.ok, false);
  assert.equal(intent.command, 'intent');
  assert.equal(script.error, 'missing_argument');
  assert.equal(intent.error, 'missing_argument');
  assert.equal(commandRouter.loads.script, 0);
  assert.equal(commandRouter.loads.intent, 0);
});


test('G1 isolated modules do not import each other or Legacy', () => {
  const script = fs.readFileSync(path.join(__dirname, '../bin/script/script-entry.js'), 'utf8');
  const intent = fs.readFileSync(path.join(__dirname, '../bin/intent/intent-entry.js'), 'utf8');
  assert.equal(/intent|legacy|mcp-server|runBatch|runBridgeChecked/.test(script), false);
  assert.equal(/script|legacy|mcp-server|runBatch|runBridgeChecked/.test(intent), false);
});

test('G1 production wiring uses one segmented FactStore and no file or HistorySink backend', () => {
  const source = fs.readFileSync(path.join(__dirname, '../bin/execution-host.js'), 'utf8');
  assert.equal(/createFileEvidenceAdapter|createHistorySink|getSharedHistorySink|sharedHistorySink/.test(source), false);
  assert.match(source, /createSegmentedEvidenceAdapter\(getSharedFactStore\(\)\)/);
  assert.match(source, /createLegacyFactStoreAdapter\(sharedFactStore\)/);
});

async function listToolNames(surface) {
  const child = spawn(process.execPath, [MCP_SERVER], {
    env: { ...process.env, AI_APP_BRIDGE_MCP_SURFACE: surface },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames = [];
  let buffer = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const text = buffer.toString('utf8');
      const match = /^Content-Length:\s*(\d+)\r\n\r\n/i.exec(text);
      if (!match) break;
      const headerSize = match[0].length;
      const length = Number(match[1]);
      if (buffer.length < headerSize + length) break;
      frames.push(JSON.parse(buffer.subarray(headerSize, headerSize + length).toString('utf8')));
      buffer = buffer.subarray(headerSize + length);
    }
  });
  const send = (message) => {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  };
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'g1-surface', version: '0' },
    },
  });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listed = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${surface} tools/list timeout`)), 4000);
    const check = () => {
      const frame = frames.find((item) => item.id === 2);
      if (!frame) return;
      clearTimeout(timer);
      resolve((frame.result.tools || []).map((tool) => tool.name));
    };
    child.stdout.on('data', check);
    child.on('error', reject);
  });
  child.kill('SIGTERM');
  return listed;
}
