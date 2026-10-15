'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { createPowerManager } = require('../bin/power');
const { createWorkPower } = require('../bin/power/work-activity');
const { createScriptSupervisor } = require('../bin/script/script-supervisor');
const { createProductionHost, handle } = require('../bin/script/script-entry');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { createIntentWorker } = require('../bin/intent/intent-worker');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const target = { platform: 'android', serial: 'power-lifecycle', packageName: 'example.work' };

function fixture(t, acquireAdapter) {
  let acquisitions = 0, releases = 0;
  const manager = createPowerManager({ acquireAdapter: acquireAdapter || (async () => {
    acquisitions++;
    return { coverage: {}, renew: async () => ({ coverage: {} }), release: async () => { releases++; return { released: true }; } };
  }) });
  const work = createWorkPower({ manager, enabled: true });
  t.after(async () => { await work.close(); await manager.close(); });
  return { manager, work, get acquisitions() { return acquisitions; }, get releases() { return releases; } };
}

test('ordinary work reuses assertions, and disabling automatic work leaves explicit sessions intact', async t => {
  const f = fixture(t);
  const explicit = await f.manager.acquire({ ownerId: 'explicit', target: { platform: 'host' }, mode: 'both', leaseMs: 10000 });
  for (let i = 0; i < 30; i++) assert.deepEqual(await f.work.beforeCommand('tree', target), []);
  assert.equal(f.acquisitions, 3, 'one explicit plus Host and selected Android activity assertions');
  f.work.begin({ ownerId: 'script:long', target, timeoutMs: 20000 });
  await delay(0);
  assert.equal(f.acquisitions, 5);
  await f.work.configure(false);
  assert.equal(f.manager.status({ leaseId: explicit.leaseId }).state, 'active');
  assert.equal(f.releases, 4);
  assert.deepEqual(await f.work.beforeCommand('tree', target), []);
  assert.equal(f.acquisitions, 5);
});

test('failed automatic protection is reported without probing a disconnected device on every action', async t => {
  let attempts = 0, time = 1000;
  const manager = createPowerManager({ acquireAdapter: async () => {
    attempts++; throw Object.assign(new Error('The device is disconnected'), { code: 'device_disconnected' });
  } });
  const work = createWorkPower({ manager, enabled: true, now: () => time });
  t.after(async () => { await work.close(); await manager.close(); });
  for (let i = 0; i < 20; i++) {
    const warnings = await work.beforeCommand('tree', target);
    assert.equal(warnings.length, 2); assert.ok(warnings.every(x => x.blocking === false && x.retryAtMs === 31000));
  }
  assert.equal(attempts, 2);
  time = 31001; await work.beforeCommand('tree', target); assert.equal(attempts, 4);
  await work.configure(false); await work.configure(true);
  await work.beforeCommand('tree', target); assert.equal(attempts, 6, 'explicit re-enable retries immediately');
});

test('finish during slow assertion startup releases its own resources without delaying unrelated work', async t => {
  let ready; const started = new Promise(resolve => { ready = resolve; });
  let releaseStartup;
  const f = fixture(t, async () => { ready(); await new Promise(resolve => { releaseStartup = resolve; });
    return { coverage: {}, renew: async () => ({ coverage: {} }), release: async () => ({ released: true }) }; });
  f.work.begin({ ownerId: 'script:slow', target: { platform: 'web' }, timeoutMs: 5000 });
  await started;
  const ending = f.work.end({ ownerId: 'script:slow' });
  releaseStartup(); await ending;
  assert.deepEqual(f.work.status().activeOperations, []);
  assert.ok(f.manager.status().leases.every(x => x.state === 'released'));
});

for (const language of ['javascript', 'python']) for (const ending of ['complete', 'crash', 'cancel', 'timeout']) {
  test(`${language} Script ${ending} releases operation protection while retaining its durable outcome`, async t => {
    const f = fixture(t), store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
    const supervisor = createScriptSupervisor({ createHost: createProductionHost });
    const source = language === 'javascript'
      ? ending === 'complete' ? 'module.exports.main=async ctx=>({done:true});'
        : ending === 'crash' ? 'module.exports.main=async ctx=>process.exit(31);'
          : 'module.exports.main=async ctx=>{while(true){}};'
      : ending === 'complete' ? 'def main(ctx):\n    return {"done":True}\n'
        : ending === 'crash' ? 'import os\ndef main(ctx):\n    os._exit(31)\n'
          : 'def main(ctx):\n    while True: pass\n';
    const operationId = `${language}-${ending}`;
    const started = await handle({ supervisor, store, operation: 'start', operationId, workPower: f.work,
      actions: async () => assert.fail('This lifecycle fixture must not dispatch a device effect'),
      script: { schemaVersion: 'aab.code-script/v1', language, source, target,
        policy: { timeoutMs: ending === 'timeout' ? 200 : 5000 } } });
    assert.equal(started.ok, true, JSON.stringify(started));
    if (ending === 'cancel') await handle({ supervisor, store, operation: 'cancel', operationId });
    await supervisor.registry.get(operationId).running;
    const result = store.latest(operationId, 'checkpoint');
    assert.equal(result.status, ending === 'complete' ? 'completed' : ending === 'cancel' ? 'cancelled' : 'failed');
    assert.deepEqual(f.work.status().activeOperations, []);
    assert.equal(f.acquisitions, 2); assert.equal(f.releases, 2);
  });
}

for (const ending of ['complete', 'cancel', 'timeout', 'store-failure']) {
  test(`Intent ${ending} releases protection after terminal persistence`, async t => {
    const f = fixture(t), backing = createMemoryEvidenceAdapter();
    const store = createIntentEvidenceStore({ adapter: { ...backing, record: row =>
      ending === 'store-failure' && row.stepId === 'intent-started' ? { ok: false, error: 'ENOSPC' } : backing.record(row) } });
    const worker = createIntentWorker({ operationId: `intent-power-${ending}`, target, store, workPower: f.work,
      timeoutMs: ending === 'timeout' ? 60 : 5000,
      adapter: { observe: async ({ rawTreeId }) => ({ ok: true, rawTreeId, rawTree: { root: { text: 'Ready', visible: true, children: [] } } }) } });
    assert.equal(f.acquisitions, 0, 'creating a worker is not active work');
    const state = await worker.start();
    if (ending === 'complete') await worker.decide({ decisionId: 'done', basedOnRevision: state.revision, agentDecision: 'complete' });
    if (ending === 'cancel') await worker.cancel();
    const until = Date.now() + 1500;
    while ((!worker.isFinished() || f.work.status().activeOperations.length) && Date.now() < until) await delay(5);
    assert.equal(worker.isFinished(), true); assert.deepEqual(f.work.status().activeOperations, []);
    assert.equal(f.acquisitions, 2); assert.equal(f.releases, 2);
    if (ending !== 'store-failure') assert.equal(store.latest(worker.operationId, 'checkpoint').payloadSummary.status,
      ending === 'complete' ? 'completed' : ending === 'cancel' ? 'cancelled' : 'timeout');
  });
}
