'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { authorizeCommand, catalogPayload, DENY_DEFAULT, DENY_PERMANENT } = require('../bin/script/script-catalog');
const { compileScriptSpec } = require('../bin/script/script-spec');
const { createBoundedScriptRegistry } = require('../bin/script/bounded-script-registry');
const { createFakeHostPort } = require('../bin/script/fake-host-port');
const { createTestScriptSupervisor: createScriptSupervisor } = require('./helpers/script-supervisor');
const { handle, resetScriptOperations } = require('../bin/script/script-entry');
const { capabilityPayload } = require('../bin/mcp-server');

function spec(overrides = {}) {
  return {
    schemaVersion: 'aab.code-script/v1',
    name: 'p2',
    language: overrides.language || 'js',
    source: overrides.source || 'async function main(ctx) { return { passed: true }; }\nmodule.exports = { main };',
    target: { serial: 'serial-1', packageName: 'com.example.app' },
    inputs: overrides.inputs || {},
    permissions: overrides.permissions,
    policy: overrides.policy,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('P2 ScriptSpec aliases language and defaults restartPolicy to none', () => {
  const js = compileScriptSpec(spec({ language: 'js' }));
  const py = compileScriptSpec(spec({ language: 'py' }));
  assert.equal(js.ok, true);
  assert.equal(js.spec.language, 'javascript');
  assert.equal(py.spec.language, 'python');
  assert.equal(js.spec.policy.restartPolicy, 'none');
  const both = compileScriptSpec({ ...spec(), source: 'x', sourcePath: './x.js' });
  assert.equal(both.ok, false);
});

test('P2 start returns before a long fake program finishes', async () => {
  resetScriptOperations();
  let finished = false;
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    program: async () => {
      await delay(80);
      finished = true;
      return { passed: true };
    },
  });
  assert.equal(started.ok, true);
  assert.equal(started.status, 'running');
  assert.equal(finished, false);
  await delay(100);
  const status = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  assert.equal(status.status, 'completed');
  assert.equal(finished, true);
});

test('P2 wait expires with timedOut and does not accept isolatedTimeoutMs from the caller', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    program: async () => {
      await delay(80);
      return { passed: true };
    },
  });
  const waiting = await supervisor.handle({
    operation: 'wait',
    operationId: started.operationId,
    waitMs: 20,
    afterSequence: 999,
  });
  assert.equal(waiting.ok, true);
  assert.equal(waiting.timedOut, true);
  assert.equal(waiting.error, null);
  const blocked = await supervisor.handle({
    operation: 'wait',
    operationId: started.operationId,
    waitMs: 10,
    isolatedTimeoutMs: 1,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'unsupported_argument');
});

test('P2 wrapIsolatedEntry uses waitMs+5000 and rejects caller isolatedTimeoutMs', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../bin/mcp-server.js'), 'utf8');
  assert.match(source, /args\.isolatedTimeoutMs = resolved\.waitMs \+ 5000/);
  assert.match(source, /unsupported_argument/);
  const { commandRouter } = require('../bin/mcp-server');
  const waitArgs = { operation: 'wait', waitMs: 1000 };
  const routed = JSON.parse((await commandRouter.route('script', waitArgs)).content[0].text);
  assert.equal(waitArgs.isolatedTimeoutMs, 6000);
  assert.equal(routed.ok, false);
  const rejected = JSON.parse((await commandRouter.route('script', {
    operation: 'wait',
    waitMs: 1000,
    isolatedTimeoutMs: 12,
  })).content[0].text);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'unsupported_argument');
});

test('P2 ctx.call envelope and assert distinguish coverage from condition', async () => {
  const host = createFakeHostPort({
    executionId: 'exec-1',
    target: { serial: 'p2-device', packageName: 'com.example.app' },
    handlers: {
      network: async (request) => captureFixture(request, 'network', [{ statusCode: 200 }]),
    },
  });
  const network = await host.call('network', {}, { evidenceWindow: { timeoutMs: 1000 } });
  assert.equal(network.command, 'network');
  assert.equal(network.result.items[0].statusCode, 200);
  assert.equal(network.execution.executionId, 'exec-1');
  assert.equal(network.evidence.coverage.status, 'complete');
  const passed = await host.assert({
    name: 'ok',
    condition: true,
    evidence: network.evidence,
    requireCoverage: 'complete',
  });
  const failed = await host.assert({
    name: 'bad',
    condition: false,
    evidence: network.evidence,
    requireCoverage: 'complete',
  });
  const inconclusive = await host.assert({
    name: 'gap',
    condition: false,
    evidence: { coverage: { status: 'partial', gap: true, committed: false } },
    requireCoverage: 'complete',
  });
  assert.equal(passed.verdict, 'passed');
  assert.equal(failed.verdict, 'failed');
  assert.equal(inconclusive.verdict, 'inconclusive');
  const denied = await host.call('clear-app-data', {});
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'command_not_in_default_allowlist');
  assert.deepEqual(denied.execution, { executionId: 'exec-1', callId: 'call-2', actionId: null });
  assert.deepEqual(denied.evidence, {
    window: { afterActionId: null, closedAtMs: 0 },
    coverage: { status: 'unavailable', gap: true, committed: false },
    refs: [],
  });
  assert.deepEqual(denied.timings, {});
});

test('P2 registry stays bounded after 10000 completed operations', async () => {
  const registry = createBoundedScriptRegistry({ maxOperations: 64, maxEvents: 8, maxEventBytes: 4096 });
  const supervisor = createScriptSupervisor({ registry, createHost: createFakeHostPort });
  for (let index = 0; index < 10_000; index += 1) {
    const started = await supervisor.handle({
      operation: 'start',
      operationId: `op-${index}`,
      script: spec(),
      program: async () => ({ passed: true }),
    });
    assert.equal(started.ok, true);
    await supervisor.handle({
      operation: 'wait',
      operationId: started.operationId,
      waitMs: 100,
    });
  }
  await delay(10);
  assert.equal(registry.size <= 64, true);
  assert.equal(registry.retainedBytes() <= 64 * 4096, true);
});

test('P2 catalog and capabilities stay machine-readable', () => {
  const catalog = catalogPayload();
  assert.equal(catalog.runtime, 'trusted-local-code');
  assert.equal(authorizeCommand('h5-eval').error, 'command_permanently_denied');
  assert.equal(authorizeCommand('install-apk').error, 'command_not_in_default_allowlist');
  assert.equal(DENY_DEFAULT.includes('clear-app-data'), true);
  assert.equal(DENY_PERMANENT.includes('web-command'), true);
  const payload = capabilityPayload({ command: 'script' });
  assert.equal(payload.catalog.internalOnly[0], 'page-summary');
  assert.match(payload.warning, /not an OS sandbox/);
});

test('P2 new Script modules stay isolated from Legacy and Intent', () => {
  const files = [
    'script-spec.js',
    'script-catalog.js',
    'script-supervisor.js',
    'fake-runtime-adapter.js',
    'fake-host-port.js',
    'fake-agent-port.js',
    'bounded-script-registry.js',
    'node-runtime-adapter.js',
    'python-runtime-adapter.js',
    'script-session-channel.js',
    'script-sdk.js',
    'templates/checkpoint-reentry.js',
    'script-ledger.js',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '../bin/script', file), 'utf8');
    assert.equal(/intent\/|legacy\/|runBatch|runBridgeChecked|mcp-server/.test(source), false, file);
  }
});

test('P2 handle routes code specs without blocking on the old worker', async () => {
  resetScriptOperations();
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const result = await handle({
    operation: 'start',
    supervisor,
    script: spec(),
    program: async (ctx) => {
      const tree = await ctx.call('tree', {});
      return { passed: tree.ok === true };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'running');
  const status = await handle({
    operation: 'status',
    operationId: result.operationId,
    supervisor,
  });
  assert.equal(status.ok, true);
  assert.equal(status.operationId, result.operationId);
  const waiting = await handle({
    operation: 'wait',
    operationId: result.operationId,
    supervisor,
    waitMs: 0,
  });
  assert.equal(waiting.ok, true);
  assert.equal(waiting.error, null);
});

test('P2 ten-minute fake clock run is not gated by a 120s isolated timeout', async () => {
  let clock = 1_000_000;
  let finished = false;
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort, now: () => clock });
  const wallStarted = Date.now();
  const started = await supervisor.handle({
    operation: 'start',
    script: spec({ policy: { timeoutMs: 600_000 } }),
    program: async () => {
      await Promise.resolve();
      clock += 600_000;
      finished = true;
      return { passed: true };
    },
  });
  const startWallMs = Date.now() - wallStarted;
  assert.equal(started.ok, true);
  assert.equal(started.status, 'running');
  assert.equal(finished, false);
  assert.equal(startWallMs < 100, true);
  await delay(10);
  const status = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  assert.equal(status.status, 'completed');
  assert.equal(clock, 1_600_000);
  const wrap = fs.readFileSync(path.join(__dirname, '../bin/mcp-server.js'), 'utf8');
  assert.match(wrap, /args\.isolatedTimeoutMs = 120000/);
  assert.doesNotMatch(wrap, /isolatedTimeoutMs = 600000/);
});

test('P2 wait wakes on the next event without polling', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    program: async (ctx) => {
      await delay(30);
      await ctx.progress({ stage: 'mid', message: 'tick' });
      return { passed: true };
    },
  });
  const afterStart = started.eventSequence;
  const began = Date.now();
  const waiting = await supervisor.handle({
    operation: 'wait',
    operationId: started.operationId,
    waitMs: 5000,
    afterSequence: afterStart,
  });
  const elapsed = Date.now() - began;
  assert.equal(waiting.ok, true);
  assert.equal(waiting.timedOut, false);
  assert.equal(waiting.eventSequence > afterStart, true);
  assert.equal(elapsed < 1000, true);
  const source = fs.readFileSync(path.join(__dirname, '../bin/script/script-supervisor.js'), 'utf8');
  const waitStart = source.indexOf('async function wait(');
  const waitEnd = source.indexOf('function snapshot(');
  assert.equal(waitStart > 0 && waitEnd > waitStart, true);
  assert.doesNotMatch(source.slice(waitStart, waitEnd), /setInterval|Math\.min\(20/);
});

test('P2 wait rejects invalid waitMs instead of substituting 30000', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    program: async () => ({ passed: true }),
  });
  const rejected = await supervisor.handle({
    operation: 'wait',
    operationId: started.operationId,
    waitMs: 70_000,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'invalid_argument');
  const { commandRouter } = require('../bin/mcp-server');
  const routed = JSON.parse((await commandRouter.route('script', {
    operation: 'wait',
    waitMs: -1,
  })).content[0].text);
  assert.equal(routed.ok, false);
  assert.equal(routed.error, 'invalid_argument');
});

test('P2 pause resume decide and cancel stay on the supervisor', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  let asked = null;
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    program: async (ctx) => {
      asked = await ctx.askAgent({ question: 'continue?' });
      await new Promise(() => {}); // Keep this test operation live for cancellation.
    },
  });
  await delay(20);
  const paused = await supervisor.handle({ operation: 'pause', operationId: started.operationId });
  assert.equal(paused.status, 'paused_manual');
  const resumed = await supervisor.handle({ operation: 'resume', operationId: started.operationId });
  assert.equal(resumed.status, 'running');
  const pending = supervisor.handle({ operation: 'status', operationId: started.operationId });
  const decided = await supervisor.handle({
    operation: 'decide',
    operationId: started.operationId,
    requestId: 'ask-1',
    revision: 1,
    decision: 'yes',
  });
  assert.equal(decided.ok, true);
  await pending;
  await delay(10);
  const cancelled = await supervisor.handle({ operation: 'cancel', operationId: started.operationId });
  assert.equal(cancelled.status, 'cancelled');
});

test('P2 interact catalog commands receive an actionId', async () => {
  const host = createFakeHostPort({ executionId: 'exec-2', target: { serial: 'test-serial' } });
  const tap = await host.call('tap-flutter-text', { text: 'Go' });
  const scroll = await host.call('h5-scroll', {});
  assert.equal(tap.execution.actionId, 'exec-2:action-1');
  assert.equal(scroll.execution.actionId, 'exec-2:action-2');
  const tree = await host.call('tree', {});
  const waiting = await host.call('wait-text', { targetText: 'Go' });
  const h5Wait = await host.call('h5-wait', {});
  assert.equal(tree.execution.actionId, null);
  assert.equal(waiting.execution.actionId, null);
  assert.equal(h5Wait.execution.actionId, null);
});

test('P2 registry refuses a duplicate live operationId', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const first = await supervisor.handle({
    operation: 'start',
    operationId: 'same-id',
    script: spec(),
    program: async () => {
      await delay(80);
      return { passed: true };
    },
  });
  const second = await supervisor.handle({
    operation: 'start',
    operationId: 'same-id',
    script: spec(),
    program: async () => ({ passed: true }),
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.error, 'operation_exists');
  const status = await supervisor.handle({ operation: 'status', operationId: 'same-id' });
  assert.equal(status.ok, true);
  assert.equal(status.status, 'running');
});

test('P2 registry refuses a new start instead of evicting a live operation', async () => {
  const registry = createBoundedScriptRegistry({ maxOperations: 1 });
  const supervisor = createScriptSupervisor({ registry, createHost: createFakeHostPort });
  const first = await supervisor.handle({
    operation: 'start',
    operationId: 'live-1',
    script: spec(),
    program: async () => {
      await delay(80);
      return { passed: true };
    },
  });
  const second = await supervisor.handle({
    operation: 'start',
    operationId: 'live-2',
    script: spec(),
    program: async () => ({ passed: true }),
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.error, 'registry_full');
  const status = await supervisor.handle({ operation: 'status', operationId: 'live-1' });
  assert.equal(status.ok, true);
  assert.equal(status.status, 'running');
});

test('P2 start freezes sourcePath contents and rejects oversized inputs', async () => {
  const file = path.join(os.tmpdir(), `aab-p2-source-${Date.now()}.js`);
  fs.writeFileSync(file, 'module.exports = { main() { return { n: 1 }; } };');
  const first = compileScriptSpec({
    schemaVersion: 'aab.code-script/v1',
    language: 'js',
    sourcePath: file,
    target: { serial: 's', packageName: 'p' },
  });
  assert.equal(first.ok, true);
  assert.match(first.spec.source, /n: 1/);
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: {
      schemaVersion: 'aab.code-script/v1',
      language: 'js',
      sourcePath: file,
      target: { serial: 's', packageName: 'p' },
    },
    program: async () => ({ passed: true }),
  });
  fs.writeFileSync(file, 'module.exports = { main() { return { n: 2 }; } };');
  const record = supervisor.registry.get(started.operationId);
  assert.match(record.spec.source, /n: 1/);
  assert.equal(record.hash, first.hash);
  const second = compileScriptSpec({
    schemaVersion: 'aab.code-script/v1',
    language: 'js',
    sourcePath: file,
    target: { serial: 's', packageName: 'p' },
  });
  assert.notEqual(second.hash, first.hash);
  fs.unlinkSync(file);
  const missing = compileScriptSpec({
    schemaVersion: 'aab.code-script/v1',
    language: 'js',
    sourcePath: file,
    target: { serial: 's', packageName: 'p' },
  });
  assert.equal(missing.ok, false);
  const huge = compileScriptSpec(spec({
    inputs: { blob: 'x'.repeat(2_000_000) },
    policy: { maxOutputBytes: 1024 },
  }));
  assert.equal(huge.ok, false);
  assert.equal(huge.field, 'inputs');
});

test('P2 runtime-status is routed to the supervisor without a script payload', async () => {
  resetScriptOperations();
  const result = await handle({ operation: 'runtime-status' });
  assert.equal(result.ok, true);
  assert.equal(result.runtimes.fake.available, true);
  assert.equal(result.runtimes.javascript.available, true);
  assert.equal(typeof result.runtimes.python.available, 'boolean');
});

test('P2 assert is inconclusive when requiredEvidence refs are missing', async () => {
  const host = createFakeHostPort({
    executionId: 'exec-3',
    target: { serial: 'p2-device', packageName: 'com.example.app' },
    handlers: {
      network: async (request) => captureFixture(request, 'network', [{ statusCode: 200 }]),
    },
  });
  const missing = await host.assert({
    name: 'need-network',
    condition: true,
    requireCoverage: 'complete',
    requiredEvidence: ['network'],
    evidence: { coverage: { status: 'complete', gap: false, committed: true }, refs: [] },
  });
  const network = await host.call('network', {});
  const present = await host.assert({
    name: 'have-network',
    condition: true,
    requireCoverage: 'complete',
    requiredEvidence: ['network'],
    evidence: network.evidence,
  });
  assert.equal(missing.verdict, 'inconclusive');
  assert.equal(present.verdict, 'passed');
  const missingFields = await host.assert({
    name: 'missing-coverage-fields',
    condition: true,
    requireCoverage: 'complete',
    evidence: { coverage: { status: 'complete' } },
  });
  const missingCoverage = await host.assert({
    name: 'missing-coverage',
    condition: true,
    requireCoverage: 'complete',
    evidence: {},
  });
  assert.equal(missingFields.verdict, 'inconclusive');
  assert.equal(missingCoverage.verdict, 'inconclusive');
});

test('P2 progress and output bounds are enforced rather than truncated', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec({ policy: { maxProgressBytes: 32, maxOutputBytes: 32 } }),
    program: async (ctx) => {
      await ctx.progress({ stage: 'too-big', message: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' });
      return { passed: true, blob: 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy' };
    },
  });
  await delay(20);
  const status = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  assert.equal(status.status, 'failed');
  assert.equal(status.error, 'progress_too_large');
});

function captureFixture(request, stream, items) {
  const runtimeEpoch = 'test-epoch';
  const targetKey = request.packageName || 'test-target';
  return {
    ok: true, items,
    coverage: { status: 'complete', gap: false, committed: true },
    refs: [{ stream, mobileFactId: 'test-fact', runtimeEpoch, targetKey }],
    runtimeEpoch, targetKey, watermarkCursor: 'test-watermark', hasMore: false,
    window: {
      afterActionId: request.afterActionId ?? null, factCursor: request.factCursor ?? null,
      sinceId: request.sinceId ?? null, sinceMs: request.sinceMs ?? null,
      runtimeEpoch, targetKey, filterApplied: true,
    },
  };
}
