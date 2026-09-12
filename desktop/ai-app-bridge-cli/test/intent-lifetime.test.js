'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ownershipRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-intent-lifetime-ownership-'));
process.env.AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR = ownershipRoot;
test.after(() => fs.rmSync(ownershipRoot, { recursive: true, force: true }));
const { setTimeout: delay } = require('node:timers/promises');
const { createIntentWorker } = require('../bin/intent/intent-worker');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createMemoryEvidenceAdapter, createSegmentedEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { execFileBounded } = require('../bin/shared-kernel/execution-io');
const { executionSleep } = require('../bin/shared-kernel/execution-scope');
const entry = require('../bin/intent/intent-entry');

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tree = { root: { className: 'Button', text: 'Save', visible: true, enabled: true, bounds: { left: 0, top: 0, right: 100, bottom: 100 } } };
let sequence = 0;
function fixture(options = {}) {
  let reads = 0, effects = 0;
  const backing = createMemoryEvidenceAdapter();
  const store = createIntentEvidenceStore({ adapter: { ...backing, record: envelope => options.record ? options.record(envelope, backing) : backing.record(envelope) } });
  const operationId = `lifetime-${++sequence}`;
  const target = { platform: 'android', serial: operationId, packageName: 'example.app' };
  const adapter = { observe: async ({ rawTreeId, provider }) => {
    reads++; await options.observe?.(reads);
    return { ok: true, rawTreeId, provider, rawTree: tree };
  }, action: async args => { effects++; return options.action ? options.action(args) : { ok: true, dispatched: true }; } };
  const worker = createIntentWorker({ operationId, goal: 'Exercise the Intent lifecycle', target, store, adapter,
    timeoutMs: options.timeoutMs ?? 1000, mode: options.mode || 'supervised', agent: options.agent });
  return { worker, store, target, adapter, get reads() { return reads; }, get effects() { return effects; } };
}
const decision = (state, extra = {}) => ({ decisionId: 'save', basedOnRevision: state.revision, agentDecision: 'act',
  ...(extra.agentDecision && extra.agentDecision !== 'act' ? {} : { action: { action: 'tap', selector: { text: 'Save' } } }), ...extra });

test('cancel drains initial observation before terminal persistence and cannot revive the Intent', { timeout: 3000 }, async () => {
  const entered = deferred(), release = deferred();
  const h = fixture({ observe: async () => { entered.resolve(); await release.promise; } });
  const starting = h.worker.start(); await entered.promise;
  let settled = false;
  const cancelling = h.worker.cancel().then(value => { settled = true; return value; });
  try {
    await delay(10); assert.equal(settled, false);
    assert.equal(h.worker.status().status, 'cancelling'); assert.equal(h.worker.isFinished(), false);
    assert.equal(h.store.latest(h.worker.operationId, 'checkpoint').stepId, 'intent-started');
  } finally { release.resolve(); }
  assert.equal((await starting).status, 'cancelled');
  const stopped = await cancelling;
  assert.equal(stopped.status, 'cancelled'); assert.ok(stopped.terminalEvidenceId);
  assert.equal(h.store.latest(h.worker.operationId, 'observation'), null);
  assert.equal(h.worker.status().pendingOperations, 0);
  assert.equal((await h.worker.decide(decision(stopped))).error, 'operation_stopped'); assert.equal(h.effects, 0);
});

test('cancel during post-action observation keeps the committed receipt and forbids a second action', { timeout: 3000 }, async () => {
  const entered = deferred(), release = deferred();
  const h = fixture({ observe: async reads => { if (reads === 2) { entered.resolve(); await release.promise; } } });
  const started = await h.worker.start();
  const acting = h.worker.decide(decision(started)); await entered.promise;
  const cancelling = h.worker.cancel(); release.resolve();
  await acting;
  const stopped = await cancelling;
  assert.equal(stopped.status, 'cancelled'); assert.equal(h.effects, 1);
  assert.equal(stopped.lastAction.dispatched, true); assert.equal(stopped.lastAction.ambiguous, false);
  const terminal = h.store.latest(h.worker.operationId, 'checkpoint');
  assert.equal(terminal.payloadSummary.status, 'cancelled'); assert.equal(terminal.payloadSummary.lastAction.receiptId, stopped.lastAction.receiptId);
  assert.equal((await h.worker.resume()).error, 'operation_stopped'); assert.equal(h.effects, 1);
});

test('cancel wins over a terminal decision whose durability has not settled', { timeout: 3000 }, async () => {
  const entered = deferred(), release = deferred();
  const h = fixture({ record: async (envelope, backing) => {
    if (envelope.kind === 'decision') { entered.resolve(); await release.promise; }
    return backing.record(envelope);
  } });
  const started = await h.worker.start();
  const completing = h.worker.decide(decision(started, { agentDecision: 'complete' })); await entered.promise;
  const cancelling = h.worker.cancel(); release.resolve();
  assert.equal((await completing).status, 'cancelled'); assert.equal((await cancelling).status, 'cancelled');
  assert.equal(h.store.list(h.worker.operationId).filter(record => record.stepId === 'intent-terminal').length, 1);
  assert.equal(h.store.latest(h.worker.operationId, 'checkpoint').payloadSummary.status, 'cancelled');
});

test('terminal status is exposed only after its durable checkpoint completes', { timeout: 3000 }, async () => {
  const entered = deferred(), release = deferred();
  const h = fixture({ record: async (envelope, backing) => {
    if (envelope.stepId === 'intent-terminal') { entered.resolve(); await release.promise; }
    return backing.record(envelope);
  } });
  const started = await h.worker.start();
  const completing = h.worker.decide(decision(started, { agentDecision: 'complete', reason: 'The observed goal is complete.' }));
  await entered.promise;
  try { assert.equal(h.worker.status().status, 'finishing'); assert.equal(h.worker.isFinished(), false); }
  finally { release.resolve(); }
  const done = await completing;
  assert.equal(done.status, 'completed'); assert.equal(done.error, null); assert.equal(done.ok, true);
  assert.equal((await h.worker.cancel()).status, 'completed', 'cancel cannot rewrite a settled result');
});

test('failed terminal persistence cannot produce a completed operation', async () => {
  const h = fixture({ record: (envelope, backing) => envelope.stepId === 'intent-terminal' ? { ok: false, error: 'disk_full' } : backing.record(envelope) });
  const started = await h.worker.start();
  const done = await h.worker.decide(decision(started, { agentDecision: 'complete' }));
  assert.equal(done.status, 'blocked_evidence_store'); assert.equal(done.error, 'disk_full'); assert.equal(done.terminalEvidenceId, null);
  assert.equal(h.store.list(h.worker.operationId).some(record => record.stepId === 'intent-terminal'), false);
});

test('idle decision waits consume the total Intent deadline', { timeout: 3000 }, async () => {
  const h = fixture({ timeoutMs: 35 });
  assert.equal((await h.worker.start()).status, 'waiting_for_decision');
  const deadline = Date.now() + 1000;
  while (!h.worker.isFinished() && Date.now() < deadline) await delay(5);
  assert.equal(h.worker.status().status, 'timeout'); assert.equal(h.worker.status().error, 'deadline_exceeded');
  assert.equal(h.store.latest(h.worker.operationId, 'checkpoint').payloadSummary.status, 'timeout'); assert.equal(h.effects, 0);
});

test('a blocked Agent reply is cancelled promptly and its late decision never dispatches', { timeout: 3000 }, async () => {
  const entered = deferred(), reply = deferred(); let signal;
  const h = fixture({ mode: 'autonomous', agent: { decide: input => { signal = input.signal; entered.resolve(); return reply.promise; } } });
  const starting = h.worker.start(); await entered.promise;
  const cancelled = await h.worker.cancel();
  assert.equal(signal.aborted, true); assert.equal(cancelled.status, 'cancelled'); assert.equal((await starting).status, 'cancelled');
  reply.resolve(decision({ revision: 1 })); await delay(5);
  assert.equal(h.effects, 0); assert.equal(h.worker.status().status, 'cancelled');
});

test('pausing invalidates an old Agent reply and resuming obtains a new decision', { timeout: 3000 }, async () => {
  const entered = deferred(), first = deferred(); let calls = 0;
  const h = fixture({ mode: 'autonomous', agent: { decide: input => {
    if (++calls === 1) { entered.resolve(); return first.promise; }
    return decision(input, { decisionId: 'new-terminal', agentDecision: 'complete' });
  } } });
  const starting = h.worker.start(); await entered.promise;
  assert.equal(h.worker.pause().status, 'paused'); assert.equal((await starting).status, 'paused');
  const done = await h.worker.resume(); first.resolve(decision({ revision: 1 })); await delay(5);
  assert.equal(done.status, 'completed'); assert.equal(calls, 2); assert.equal(h.effects, 0);
});

test('autonomous decisions must carry their own observation revision', { timeout: 3000 }, async () => {
  let calls = 0;
  const h = fixture({ mode: 'autonomous', agent: { decide: input => {
    calls++;
    return calls === 1 ? { decisionId: 'unbound', agentDecision: 'complete' }
      : { decisionId: 'bound', basedOnRevision: input.revision, agentDecision: 'complete' };
  } } });
  const rejected = await h.worker.start();
  assert.equal(rejected.status, 'waiting_for_decision'); assert.equal(rejected.error, 'missing_argument'); assert.equal(calls, 1);
  assert.equal((await h.worker.decide({ decisionId: 'bound', basedOnRevision: rejected.revision, agentDecision: 'complete' })).status, 'completed');
  const decisions = h.store.list(h.worker.operationId).filter(record => record.kind === 'decision');
  assert.deepEqual(decisions.map(record => record.decisionId), ['bound']);
});

test('a rejected pause during an action does not silently stop autonomous execution', { timeout: 3000 }, async () => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const h = fixture({ mode: 'autonomous', action: async () => { entered.resolve(); await release.promise; return { ok: true, dispatched: true }; },
    agent: { decide: input => decision(input, { decisionId: `step-${++calls}`, agentDecision: calls === 1 ? 'act' : 'complete' }) } });
  const starting = h.worker.start(); await entered.promise;
  try { assert.equal(h.worker.pause().error, 'operation_busy'); }
  finally { release.resolve(); }
  assert.equal((await starting).status, 'completed'); assert.equal(calls, 2); assert.equal(h.effects, 1);
});

test('cancelling real subprocess I/O waits for the child to exit', { timeout: 4000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-owned-child-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'pid');
  const h = fixture({ timeoutMs: 3000, observe: () => execFileBounded(process.execPath,
    ['-e', `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(pidFile + '.tmp')},String(process.pid));fs.renameSync(${JSON.stringify(pidFile + '.tmp')},${JSON.stringify(pidFile)});setInterval(()=>{},1000);`], { timeout: 5000 }) });
  const starting = h.worker.start();
  const deadline = Date.now() + 1000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) await delay(5);
  assert.ok(fs.existsSync(pidFile)); const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'ready must contain the actual child PID');
  const done = await h.worker.cancel();
  assert.equal(done.status, 'cancelled'); assert.equal((await starting).status, 'cancelled');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); assert.equal(h.effects, 0);
});

test('cancellation of an accepted action records uncertainty before the terminal checkpoint', { timeout: 3000 }, async () => {
  const entered = deferred();
  const h = fixture({ action: async () => {
    require('../bin/shared-kernel/execution-scope').markExecutionDispatched(); entered.resolve();
    await executionSleep(5000); return { ok: true };
  } });
  const started = await h.worker.start(); const acting = h.worker.decide(decision(started)); await entered.promise;
  const cancelled = await h.worker.cancel(); await acting;
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.lastAction.ambiguous, true); assert.equal(cancelled.lastAction.dispatched, true);
  const rows = h.store.list(h.worker.operationId); assert.equal(rows.at(-1).stepId, 'intent-terminal');
  assert.equal(rows.find(record => record.kind === 'action-receipt').ambiguous, true);
});

test('recovery reads the durable terminal state and refuses operation ID reuse', async () => {
  const h = fixture(); const started = await h.worker.start();
  await h.worker.decide(decision(started, { agentDecision: 'complete' }));
  const restoredStore = createIntentEvidenceStore({ adapter: {
    record: () => { throw new Error('recovery is read-only'); }, readById: id => h.store.list(h.worker.operationId).find(record => record.evidenceId === id), list: () => h.store.list(h.worker.operationId),
  } });
  const recovered = entry.handle({ operation: 'status', operationId: h.worker.operationId, store: restoredStore });
  assert.equal(recovered.status, 'completed'); assert.equal(recovered.live, false); assert.equal(recovered.recovered, true);
  assert.equal((await entry.handle({ operation: 'start', operationId: h.worker.operationId, goal: 'must not replay', target: h.target, store: restoredStore, adapter: h.adapter })).error, 'operation_exists');
  assert.equal(h.effects, 0);
});

test('terminal decisions cannot complete a stale observation', async () => {
  const h = fixture(); const started = await h.worker.start();
  const result = await h.worker.decide(decision(started, { agentDecision: 'complete', basedOnRevision: 999 }));
  assert.equal(result.error, 'reobserve_required'); assert.equal(result.status, 'waiting_for_decision');
  await h.worker.cancel();
});

test('recovery without a terminal checkpoint reports an interrupted action and never replays it', async () => {
  const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const operationId = 'interrupted-lifetime';
  const marker = await store.persist('dispatch-marker', { operationId, revision: 1, actionId: 'lost-receipt',
    target: { platform: 'android', serial: 'interrupted-device', packageName: 'example.app' }, decisionId: 'lost-decision',
    actionSpecHash: 'frozen-action', state: 'prepared', timestampMs: Date.now() });
  assert.equal(marker.ok, true, JSON.stringify(marker));
  const state = entry.handle({ operation: 'status', operationId, store });
  assert.equal(state.status, 'interrupted'); assert.equal(state.error, 'runtime_restarted'); assert.equal(state.ambiguous, true);
  assert.deepEqual(state.unmatchedActionIds, ['lost-receipt']); assert.equal(state.restartPolicy, 'none');
  assert.equal((await entry.handle({ operation: 'decide', operationId, decision: decision({ revision: 1 }) })).error, 'unknown_operation');
});

test('a failed durable read cannot masquerade as an unknown operation or missing record', () => {
  const adapter = createSegmentedEvidenceAdapter({ record: () => {}, read: () => ({ ok: false, error: 'segment_unavailable' }) });
  const store = createIntentEvidenceStore({ adapter });
  assert.throws(() => entry.handle({ operation: 'status', operationId: 'unreadable-lifetime', store }), { code: 'evidence_read_failed' });
  assert.throws(() => store.read('unreadable-record'), { code: 'evidence_read_failed' });
});

test('status requires an explicit operation ID before reading durable evidence', () => {
  const store = { list: () => assert.fail('missing operationId must not query evidence from every operation') };
  for (const operationId of [undefined, null, '', 1, []]) {
    const result = entry.handle({ operation: 'status', operationId, store });
    assert.equal(result.error, 'operationId_required'); assert.equal(result.field, 'operationId');
  }
});

test('pending workflow factories reserve capacity and shutdown cancels them before start', { timeout: 3000 }, async t => {
  await entry.resetIntentOperations();
  const gate = deferred(); let starts = 0, cancels = 0;
  t.mock.method(require('../bin/intent/install-intent'), 'createInstallIntent', async ({ operationId }) => {
    await gate.promise;
    let finished = false;
    return { start: () => { starts++; assert.fail('a workflow created after intake closes cannot start'); },
      cancel: async () => { cancels++; finished = true; return { operationId, status: 'cancelled' }; },
      isFinished: () => finished, status: () => ({ status: finished ? 'cancelled' : 'created' }) };
  });
  const pending = Array.from({ length: 256 }, (_, index) => entry.handle({ operation: 'start', operationId: `pending-factory-${index}`, install: { serial: 'factory-probe' } }));
  try {
    assert.equal((await entry.handle({ operation: 'start', operationId: 'pending-factory-0', install: {} })).error, 'operation_exists');
    assert.equal((await entry.handle({ operation: 'start', operationId: 'overflow-factory', install: {} })).error, 'registry_full');
    let stopped = false;
    const stopping = entry.cancelActiveIntents().then(() => { stopped = true; });
    await delay(5); assert.equal(stopped, false);
    assert.equal((await entry.handle({ operation: 'start', goal: 'too late' })).error, 'runtime_stopping');
    gate.resolve();
    const results = await Promise.all(pending); await stopping;
    assert.equal(results.every(result => result.status === 'cancelled'), true); assert.equal(starts, 0); assert.equal(cancels, 256);
  } finally { gate.resolve(); await Promise.allSettled(pending); await entry.resetIntentOperations(); }
});
