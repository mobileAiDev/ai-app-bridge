'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createFileEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { createScriptSupervisor } = require('../bin/script/script-supervisor');
const { createProductionHost, handle } = require('../bin/script/script-entry');
const { validateCommandArguments, parseCliOptions } = require('../bin/command-registry');

const source = `module.exports.main = async ctx => {
  if (ctx.resume()?.phase === 'query') {
    const status = await ctx.call('status', {});
    if (!status.result.paid) throw new Error('Payment is not confirmed');
    await ctx.checkpoint('queried', {phase:'refund'});
    const next = await ctx.call('tap-text', {text:'Refund'});
    return {paid:status.result.paid, actionId:next.execution.actionId};
  }
  await ctx.checkpoint('before-payment', {phase:'submit'});
  await ctx.call('tap-text', {text:'Pay'});
  process.exit(31);
};`;
const recovery = { checkpoint: { name: 'agent-query', state: { phase: 'query' } }, reason: 'Inspect the original payment before refunding; do not submit it again.' };
const supervisor = () => createScriptSupervisor({ createHost: createProductionHost });
async function fixture(t, unknown = false, { dropReceipt = false, language = 'javascript' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-explicit-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reopen = () => createScriptEvidenceStore({ adapter: createFileEvidenceAdapter({ dir }) });
  const effects = [], sup = supervisor(), backing = reopen();
  const store = dropReceipt ? { ...backing, persist: (kind, row) => kind === 'action-receipt' && row.actionId === 'interrupted:action-1'
    ? { ok: false, error: 'ENOSPC' } : backing.persist(kind, row) } : backing;
  const actions = async (command, args) => {
    if (command === 'status') return { ok: true, paid: effects.includes('Pay') };
    effects.push(args.text);
    if (unknown && args.text === 'Pay') throw new Error('lost_transport');
    return { ok: true, dispatched: true };
  };
  const python = `import os
def main(ctx):
  if ctx.resume() and ctx.resume().get('phase') == 'query':
    status = ctx.call('status', {})
    if not status['result']['paid']: raise RuntimeError('Payment is not confirmed')
    ctx.checkpoint('queried', {'phase':'refund'})
    result = ctx.call('tap-text', {'text':'Refund'})
    return {'paid':status['result']['paid'], 'actionId':result['execution']['actionId']}
  ctx.checkpoint('before-payment', {'phase':'submit'})
  ctx.call('tap-text', {'text':'Pay'})
  os._exit(31)
`;
  const script = { schemaVersion: 'aab.code-script/v1', language, source: language === 'python' ? python : source,
    target: { platform: 'android', serial: 'recovery-fixture', packageName: 'example.recovery' },
    policy: { restartPolicy: 'checkpoint', timeoutMs: 5000 } };
  const started = await handle({ supervisor: sup, store, operation: 'start', operationId: 'interrupted', script, actions });
  assert(started.ok, JSON.stringify(started)); await sup.registry.get('interrupted').running;
  const before = reopen().list('interrupted');
  return { sup, store, reopen, effects, actions, script, before };
}

for (const fresh of [false, true]) for (const unknown of [false, true]) {
  test(`explicit recovery queries a ${unknown ? 'lost' : 'confirmed'} receipt on ${fresh ? 'restored' : 'live'} Host without replay`, async t => {
    const f = await fixture(t, unknown), sup = fresh ? supervisor() : f.sup, store = fresh ? f.reopen() : f.store;
    const ordinary = await handle({ supervisor: sup, store, operation: 'resume', operationId: 'interrupted', actions: f.actions });
    assert.equal(ordinary.ok, false); assert.deepEqual(f.effects, ['Pay']);
    const reply = await handle({ supervisor: sup, store, operation: 'resume', operationId: 'interrupted', recovery, actions: f.actions, waitMs: 2000 });
    assert(reply.ok, JSON.stringify(reply)); assert.equal(reply.status, 'completed');
    assert.deepEqual(reply.result, { paid: true, actionId: 'interrupted:action-2' });
    assert.deepEqual(f.effects, ['Pay', 'Refund']);
    const records = f.reopen().list('interrupted');
    for (const old of f.before) assert.deepEqual(records.find(r => r.evidenceId === old.evidenceId), old, 'Original evidence is immutable');
    const decision = records.find(r => r.kind === 'checkpoint' && r.recovery);
    assert.equal(decision.checkpoint.name, 'agent-query'); assert.equal(decision.checkpointActionSequence, 1);
    assert.equal(decision.recovery.reason, recovery.reason);
    if (unknown) assert.equal(records.find(r => r.kind === 'action-receipt' && r.actionId.endsWith(':action-1')).ambiguous, true);
    const again = await handle({ supervisor: sup, store, operation: 'resume', operationId: 'interrupted', recovery, actions: f.actions });
    assert.equal(again.error, 'not_resumable'); assert.deepEqual(f.effects, ['Pay', 'Refund']);
  });
}

for (const fresh of [false, true]) test(`failed recovery persistence starts no child on ${fresh ? 'restored' : 'live'} Host`, async t => {
  const f = await fixture(t), sup = fresh ? supervisor() : f.sup, backing = f.reopen();
  const store = { ...backing, persist: (kind, row) => row.recovery ? { ok: false, error: 'ENOSPC' } : backing.persist(kind, row) };
  if (!fresh) f.sup.registry.get('interrupted').store = store;
  const result = await handle({ supervisor: sup, store, operation: 'resume', operationId: 'interrupted', recovery, actions: f.actions });
  assert.equal(result.error, 'ENOSPC'); assert.deepEqual(f.effects, ['Pay']);
  assert.deepEqual(backing.list('interrupted'), f.before);
  if (!fresh) assert.equal(f.sup.registry.get('interrupted').lastCheckpoint.name, 'before-payment');
});

test('recovery schema is discoverable and CLI JSON parsing preserves the exact state', () => {
  const args = { operation: 'resume', operationId: 'interrupted', recovery };
  assert.doesNotThrow(() => validateCommandArguments('script', args));
  assert.deepEqual(parseCliOptions('script', { ...args, recovery: JSON.stringify(recovery) }).recovery, recovery);
  assert.throws(() => validateCommandArguments('script', { ...args, operation: 'pause' }));
  assert.throws(() => validateCommandArguments('script', { ...args, recovery: { checkpoint: { name: 'agent-query' } } }));
});

test('an ordinary ambiguous resume includes the original checkpoint and a valid status hint', async t => {
  const f = await fixture(t);
  const result = await handle({ supervisor: f.sup, store: f.store, operation: 'resume', operationId: 'interrupted', actions: f.actions });
  assert.equal(result.error, 'ambiguous'); assert.match(result.message, /recovery\.checkpoint/);
  assert.deepEqual(result.recoveryCheckpoint, { name: 'before-payment', state: { phase: 'submit' } });
  const next = result.guidance.nextActions.find(n => n.command === 'script');
  assert.equal(next.arguments.operationId, 'interrupted');
  assert.doesNotThrow(() => validateCommandArguments(next.command, next.arguments));
});

test('Python accepts the explicit recovery state after a process crash', async t => {
  const f = await fixture(t, false, { language: 'python' });
  const reply = await handle({ supervisor: supervisor(), store: f.reopen(), operation: 'resume', operationId: 'interrupted', recovery, actions: f.actions, waitMs: 2000 });
  assert(reply.ok, JSON.stringify(reply)); assert.equal(reply.status, 'completed');
  assert.deepEqual(reply.result, { paid: true, actionId: 'interrupted:action-2' });
  assert.deepEqual(f.effects, ['Pay', 'Refund']);
});

test('recovery preserves an unmatched dispatch marker and does not invent its missing receipt', async t => {
  const f = await fixture(t, false, { dropReceipt: true }), store = f.reopen(), sup = supervisor();
  const blocked = await handle({ supervisor: sup, store, operation: 'resume', operationId: 'interrupted', actions: f.actions });
  assert.equal(blocked.error, 'ambiguous');
  assert.deepEqual(blocked.actions, [{ actionId: 'interrupted:action-1', actionSequence: 1, dispatched: null, ambiguous: true }]);
  const reply = await handle({ supervisor: sup, store, operation: 'resume', operationId: 'interrupted', recovery, actions: f.actions, waitMs: 2000 });
  assert(reply.ok, JSON.stringify(reply)); assert.equal(reply.status, 'completed');
  const rows = store.list('interrupted');
  assert.equal(rows.filter(r => r.kind === 'dispatch-marker').length, 2);
  assert.equal(rows.filter(r => r.kind === 'action-receipt').length, 1);
  assert.equal(rows.find(r => r.kind === 'action-receipt').actionId, 'interrupted:action-2');
  assert.deepEqual(f.effects, ['Pay', 'Refund']);
});

for (const operation of ['status', 'wait']) test(`restored ${operation} returns unknown action facts without failing the read or starting a child`, async t => {
  const f = await fixture(t, false, { dropReceipt: true }), store = f.reopen(), sup = supervisor();
  const before = store.list('interrupted');
  const result = await handle({ supervisor: sup, store, operation, operationId: 'interrupted', actions: f.actions, waitMs: 0 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'failed'); assert.equal(result.restored, true);
  assert.equal(result.resumable, false);
  assert.equal(result.recovery.error, 'ambiguous');
  assert.deepEqual(result.recovery.recoveryCheckpoint, { name: 'before-payment', state: { phase: 'submit' } });
  assert.deepEqual(result.recovery.actions, [{ actionId: 'interrupted:action-1', actionSequence: 1, dispatched: null, ambiguous: true }]);
  assert.equal(sup.knownOperation('interrupted'), false);
  assert.deepEqual(store.list('interrupted'), before); assert.deepEqual(f.effects, ['Pay']);
});

for (const fresh of [false, true]) test(`concurrent explicit recovery commits and starts once on ${fresh ? 'restored' : 'live'} Host`, async t => {
  const f = await fixture(t), sup = fresh ? supervisor() : f.sup, backing = f.reopen();
  let release, offered;
  const waiting = new Promise(resolve => { offered = resolve; });
  const store = { ...backing, persist: async (kind, row) => {
    if (row.recovery) { offered(); await new Promise(resolve => { release = resolve; }); }
    return backing.persist(kind, row);
  } };
  if (!fresh) f.sup.registry.get('interrupted').store = store;
  const args = { supervisor: sup, store, operation: 'resume', operationId: 'interrupted', recovery, actions: f.actions, waitMs: 2000 };
  const first = handle(args); await waiting;
  assert.equal((await handle(args)).error, 'operation_busy'); assert.deepEqual(f.effects, ['Pay']);
  release(); const reply = await first;
  assert(reply.ok, JSON.stringify(reply)); assert.equal(reply.status, 'completed');
  assert.equal(backing.list('interrupted').filter(r => r.recovery).length, 1);
  assert.deepEqual(f.effects, ['Pay', 'Refund']);
});

for (const fresh of [false, true]) test(`explicit recovery can continue a settled cancellation on ${fresh ? 'restored' : 'live'} Host`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-cancelled-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createScriptEvidenceStore({ adapter: createFileEvidenceAdapter({ dir }) });
  const sup = supervisor(), effects = [];
  const actions = async (command, args) => {
    if (command === 'status') return { ok: true, paid: effects.includes('Pay') };
    effects.push(args.text); return { ok: true, dispatched: true };
  };
  const script = { schemaVersion: 'aab.code-script/v1', language: 'javascript',
    source: source.replace('process.exit(31);', 'await ctx.askAgent({question:"Continue?"});'),
    target: { platform: 'android', serial: 'cancelled-recovery', packageName: 'example.recovery' },
    policy: { restartPolicy: 'checkpoint', timeoutMs: 5000 } };
  const waiting = await handle({ supervisor: sup, store, operation: 'start', operationId: 'cancelled', script, actions, waitMs: 2000 });
  assert.equal(waiting.status, 'waiting_for_agent');
  const cancelled = await handle({ supervisor: sup, store, operation: 'cancel', operationId: 'cancelled' });
  assert.equal(cancelled.status, 'cancelled'); assert.deepEqual(effects, ['Pay']);
  const oldRows = store.list('cancelled');
  const selected = fresh ? supervisor() : sup;
  const ordinary = await handle({ supervisor: selected, store, operation: 'resume', operationId: 'cancelled', actions });
  assert.equal(ordinary.ok, false); assert.deepEqual(effects, ['Pay']);
  const reply = await handle({ supervisor: selected, store, operation: 'resume', operationId: 'cancelled', recovery, actions, waitMs: 2000 });
  assert(reply.ok, JSON.stringify(reply)); assert.equal(reply.status, 'completed');
  assert.deepEqual(effects, ['Pay', 'Refund']);
  assert.equal(reply.result.actionId, 'cancelled:action-2');
  const rows = store.list('cancelled');
  for (const old of oldRows) assert.deepEqual(rows.find(row => row.evidenceId === old.evidenceId), old);
});
