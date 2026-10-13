'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const host = require('../bin/execution-host');
const { foregroundWindow } = require('../bin/device-provider');
const { readForegroundFeedback } = require('../bin/shared-kernel/android-foreground-feedback');
const { androidForegroundFixture } = require('../test-support/android-foreground-fixture');
const { createTestScriptSupervisor } = require('./helpers/script-supervisor');
const { createFakeHostPort } = require('../bin/script/fake-host-port');
const { createResponseStore } = require('../bin/response-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
test.after(() => host.close());

test('Script start waitMs parses through the same CLI contract as wait', () => {
  const { parseCliOptions, validateCommandArguments } = require('../bin/command-registry');
  const args = parseCliOptions('script', { operation: 'start', waitMs: '60000', script: JSON.stringify({
    schemaVersion: 'aab.code-script/v1', language: 'javascript', source: 'module.exports.main = async () => 42;',
    target: { platform: 'android', serial: 'fixture-device' },
  }) });
  assert.equal(validateCommandArguments('script', args).waitMs, 60000);
});

test('foreground advice uses one window observation rather than five ownership probes', async () => {
  const fixture = androidForegroundFixture('example.app');
  const calls = [];
  const result = await readForegroundFeedback({ packageName: 'example.app' }, (ctx, options) => foregroundWindow(ctx, {
    ...options, adb: async (_, argv) => {
      calls.push(argv.join(' '));
      return { stdout: argv.includes('window') ? fixture.windowDump : argv.includes('package') ? fixture.packageDump : fixture.processDump };
    },
  }));
  assert.equal(result.foregroundObservations[0].status, 'match');
  assert.equal(calls.length, 1, 'advice must not reverify process and package ownership on each UI command');
  assert.equal(result.foregroundObservations[0].actual.ownershipVerified, false);
});

test('Intent takes one foreground observation per capture or action', async () => {
  let probes = 0, presses = 0;
  const adapter = require('../bin/intent/intent-production-adapter').createProductionIntentDeviceAdapter({ ports: {
    createBridgeContext: args => args,
    bridgeTree: async () => ({ ok: true, nodes: [] }),
    foregroundWindow: async () => { probes++; return { ok: true, packageName: 'example.app' }; },
    keyevent: async () => { presses++; return { ok: true }; },
  } });
  const observation = await adapter.observe({ serial: 'advice-fixture', packageName: 'example.app', provider: 'native' });
  assert.equal(observation.ok, true);
  assert.equal(probes, 1);
  await adapter.action({ serial: 'advice-fixture', packageName: 'example.app', route: observation.route,
    spec: { provider: 'native', action: 'back' } });
  assert.equal(probes, 2);
  assert.equal(presses, 1);
});

test('large transition diagnostics retain Intent continuation and an immediately usable observation', async () => {
  const actual = { ok: false, error: 'foreground_changed_during_verification', packageName: 'example.app',
    ownershipVerified: false, evidence: { window: 'window details\n'.repeat(6000) },
    current: { ok: false, evidence: { dump: 'transition details\n'.repeat(6000) } } };
  const observation = { source: 'android-window-manager', actual, status: 'unknown', observedAtMs: 123 };
  const raw = { ok: true, operationId: 'intent-transition', revision: 1, status: 'waiting_for_decision',
    summary: { provider: 'native', warnings: [{ ...observation, code: actual.error }],
      foregroundObservations: [observation], nodes: [{ text: 'Continue', clickable: true }] } };
  const dependencies = { rawRunner: async () => raw, factRecorder: null, observationCollector: null,
    responseStore: createResponseStore({ adapter: createMemoryEvidenceAdapter() }) };
  const { publicReply, finishReply } = require('../bin/public-reply');
  const response = await finishReply({ body: publicReply({ command: 'intent', reply: { value: raw } }),
    extract: { mode: 'auto' }, getStore: () => dependencies.responseStore });
  assert.equal(response.execution.ok, true);
  assert.equal(response.control.operationId, raw.operationId);
  assert.equal(response.control.revision, 1);
  assert.ok(response.value, 'diagnostic text must not remove the page from the first reply');
  assert.ok(Buffer.byteLength(JSON.stringify(response.control)) < 8192);
  const read = (await host.run({ command: 'response', arguments: { operation: 'read', ref: response.control.source.ref },
    extract: { mode: 'select', path: '/summary/foregroundObservations/0/actual/current/evidence/dump' },
    output: { maxBytes: 262144 } }, dependencies)).value;
  assert.equal(read.value, actual.current.evidence.dump);
});

test('default Script wait ignores routine progress and returns when the full program completes', async () => {
  const supervisor = createTestScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({ operation: 'start', script: {
    schemaVersion: 'aab.code-script/v1', language: 'javascript', source: 'module.exports.main = async () => ({ok:true});',
    target: { platform: 'android', serial: 'wait-fixture', packageName: 'example.app' },
  }, program: async ctx => {
    for (let i = 0; i < 6; i++) { await ctx.progress({ step: i }); await new Promise(resolve => setTimeout(resolve, 5)); }
    return { ok: true };
  } });
  const waited = await supervisor.handle({ operation: 'wait', operationId: started.operationId, afterSequence: started.eventSequence, waitMs: 1000 });
  assert.equal(waited.status, 'completed');
  assert.equal(waited.timedOut, false);
});

test('SDK requests reuse endpoint discovery while checking the current ADB route', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-route-cost-'));
  const server = require('node:http').createServer((_, response) => response.end(JSON.stringify({ ok: true, nodes: [] })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const logPath = path.join(directory, 'adb.jsonl');
  const adb = require('../test-support/adb-http-fixture').createAdbHttpFixture({ directory, logPath,
    serial: 'fixture-device', port: server.address().port });
  const provider = require('../bin/device-provider');
  for (let i = 0; i < 3; i++) await provider.bridgeTree(provider.createBridgeContext({ adb, serial: 'fixture-device', packageName: 'example.app' }));
  const calls = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(args => args.includes('files/ai_app_bridge_endpoint.json')).length, 1);
  assert.equal(calls.filter(args => args.includes('--list')).length, 3);
});

test('Flutter commands request operable observations and do not report a read failure as an uncertain mutation', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-operable-'));
  const paths = [];
  const server = require('node:http').createServer((request, response) => {
    paths.push(request.url);
    response.end(JSON.stringify({ ok: false, error: 'flutter_observation_timeout' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const adb = require('../test-support/adb-http-fixture').createAdbHttpFixture({ directory,
    logPath: path.join(directory, 'adb.jsonl'), serial: 'fixture-device', port: server.address().port });
  const provider = require('../bin/device-provider');
  const context = provider.createBridgeContext({ adb, serial: 'fixture-device', packageName: 'example.app' });
  const observed = await provider.flutterNodes(context);
  assert.equal(observed.dispatched, false);
  assert.equal(observed.ambiguous, false);
  const action = await provider.flutterAction(context, { action: 'tapText', text: 'Continue' }, {}, { foregroundFeedback: {} });
  assert.equal(action.error, 'flutter_observation_timeout');
  assert.equal(action.dispatched, false);
  assert.equal(action.ambiguous, false);
  assert.deepEqual(paths, ['/v1/flutter/snapshot?scope=operable', '/v1/flutter/snapshot?scope=operable']);
});

test('a disconnected SDK read reconnects once; a dispatched write is never replayed', async () => {
  const { bridgeRequest } = require('../bin/device-provider');
  for (const readOnly of [true, false]) {
    let prepares = 0, attempts = 0;
    const work = () => bridgeRequest({}, async () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('socket disconnected'), { code: 'ECONNRESET' });
      return { ok: true };
    }, { readOnly, ensureForward: async () => { prepares++; } });
    if (readOnly) assert.equal((await work()).ok, true);
    else await assert.rejects(work(), { code: 'ECONNRESET' });
    assert.equal(attempts, readOnly ? 2 : 1);
    assert.equal(prepares, attempts);
  }
});

test('Script start can wait, ask the Agent, resume the same program and return its persisted result', async () => {
  const { createEvidenceStore } = require('../bin/shared-kernel/evidence-store');
  const store = createEvidenceStore({ namespace: 'script', adapter: createMemoryEvidenceAdapter() });
  const supervisor = createTestScriptSupervisor({ createHost: createFakeHostPort });
  let entered = 0;
  const script = { schemaVersion: 'aab.code-script/v1', language: 'javascript',
    source: 'module.exports.main = async () => ({ok:true});', target: { platform: 'android', serial: 'ask-fixture' } };
  const waiting = await supervisor.handle({ operation: 'start', script, store, waitMs: 1000,
    program: async ctx => { entered++; const answer = await ctx.askAgent({ question: 'An unexpected page appeared. Continue?' }); return { answer }; } });
  assert.equal(waiting.status, 'waiting_for_agent');
  const pending = waiting.pendingQuestion;
  assert.equal(pending.request.question, 'An unexpected page appeared. Continue?');
  await supervisor.handle({ operation: 'decide', operationId: waiting.operationId, requestId: pending.requestId,
    revision: pending.revision, decision: 'continue' });
  const finished = await supervisor.handle({ operation: 'wait', operationId: waiting.operationId, waitMs: 1000 });
  assert.equal(finished.status, 'completed');
  const result = supervisor.handle({ operation: 'result', operationId: waiting.operationId });
  assert.deepEqual(result.result, { answer: 'continue' });
  assert.equal(entered, 1);
  const single = await supervisor.handle({ operation: 'start', script, store, waitMs: 1000, program: async () => ({ count: 42 }) });
  assert.equal(single.status, 'completed');
  assert.deepEqual(single.result, { count: 42 });
});
