'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createFileEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { createBoundedScriptRegistry } = require('../bin/script/bounded-script-registry');
const { createScriptSupervisor } = require('../bin/script/script-supervisor');
const { createProductionHost, handle } = require('../bin/script/script-entry');

async function fixture(t, source, actions = async () => assert.fail('Unexpected device command')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-evicted-recovery-'));
  const store = createScriptEvidenceStore({ adapter: createFileEvidenceAdapter({ dir: directory }) });
  const supervisor = createScriptSupervisor({ registry: createBoundedScriptRegistry({ maxOperations: 1 }),
    createHost: createProductionHost });
  t.after(async () => { await supervisor.cancelAll(); fs.rmSync(directory, { recursive: true, force: true }); });
  const script = { schemaVersion: 'aab.code-script/v1', language: 'javascript', source,
    target: { platform: 'android', serial: 'evicted-recovery-fixture', packageName: 'example.recovery' },
    policy: { restartPolicy: 'checkpoint', timeoutMs: 5000 } };
  const context = { supervisor, store, actions };
  const started = await handle({ ...context, operation: 'start', operationId: 'original', script, waitMs: 2000 });
  const evict = async () => {
    const filler = await handle({ ...context, operation: 'start', operationId: 'filler', waitMs: 2000,
      script: { schemaVersion: 'aab.code-script/v1', language: 'javascript', source: 'module.exports.main = () => true;' } });
    assert.equal(filler.status, 'completed');
    assert.equal(supervisor.registry.get('original'), null);
    assert.equal(supervisor.knownOperation('original'), true, 'the retained ledger still knows the evicted operation');
  };
  return { ...context, script, started, evict };
}

const crashSource = `module.exports.main = async ctx => {
  if (ctx.resume()) return { resumed: true, state: ctx.resume() };
  await ctx.checkpoint('ready', { phase: 'continue' });
  process.exit(31);
};`;
const recovery = { checkpoint: { name: 'agent-query', state: { phase: 'query' } } };

test('an evicted crashed Script restores its durable checkpoint without reusing the event cursor or admitting duplicate start', async t => {
  const f = await fixture(t, crashSource);
  assert.equal(f.started.error, 'child_crashed');
  const before = f.store.list('original');
  await f.evict();
  const duplicate = await handle({ ...f, operation: 'start', operationId: 'original', script: f.script });
  assert.equal(duplicate.error, 'operation_exists');
  const restored = await handle({ ...f, operation: 'resume', operationId: 'original', waitMs: 2000 });
  assert.equal(restored.status, 'completed', JSON.stringify(restored));
  assert.deepEqual(restored.result, { resumed: true, state: { phase: 'continue' } });
  const current = await handle({ ...f, operation: 'status', operationId: 'original', afterSequence: f.started.eventSequence, limit: 100 });
  assert(current.eventSequence > f.started.eventSequence, 'a retained event cursor must advance after reentry');
  assert(current.events.length > 0);
  const all = (await handle({ ...f, operation: 'status', operationId: 'original', afterSequence: 0, limit: 100 })).history.items;
  assert(all.every((event, index) => index === 0 || event.sequence > all[index - 1].sequence));
  for (const old of before) assert.deepEqual(f.store.list('original').find(row => row.evidenceId === old.evidenceId), old);
  assert.equal((await handle({ ...f, operation: 'resume', operationId: 'original' })).error, 'not_resumable');
});

test('eviction retains an unknown effect and requires explicit recovery before a new action', async t => {
  const effects = [];
  const f = await fixture(t, `module.exports.main = async ctx => {
    if (ctx.resume()?.phase === 'query') {
      const status = await ctx.call('status', {});
      if (!status.result.paid) throw new Error('Unconfirmed effect');
      return await ctx.call('tap-text', {text:'Refund'});
    }
    await ctx.checkpoint('before-payment', {phase:'submit'});
    return await ctx.call('tap-text', {text:'Pay'});
  };`, async (command, args) => {
    if (command === 'status') return { ok: true, paid: effects.includes('Pay') };
    effects.push(args.text);
    return args.text === 'Pay' ? { ok: false, error: 'response_lost', dispatched: null, ambiguous: true }
      : { ok: true, dispatched: true };
  });
  assert.equal(f.started.status, 'failed');
  const original = f.store.list('original').find(row => row.kind === 'action-receipt');
  assert.equal(original.ambiguous, true);
  await f.evict();
  const blocked = await handle({ ...f, operation: 'resume', operationId: 'original' });
  assert.equal(blocked.error, 'ambiguous');
  assert.deepEqual(effects, ['Pay']);
  const restored = await handle({ ...f, operation: 'resume', operationId: 'original', recovery, waitMs: 2000 });
  assert.equal(restored.status, 'completed', JSON.stringify(restored));
  assert.equal(restored.result.execution.actionId, 'original:action-2');
  assert.deepEqual(effects, ['Pay', 'Refund']);
  assert.deepEqual(f.store.list('original').find(row => row.evidenceId === original.evidenceId), original);
});

test('evicted checkpoints with invalid checksums do not start a child', async t => {
  const f = await fixture(t, crashSource);
  await f.evict();
  const store = { ...f.store, list: id => f.store.list(id).map(row => row.kind === 'checkpoint'
    ? { ...row, hash: 'tampered' } : row) };
  const result = await handle({ ...f, store, operation: 'resume', operationId: 'original', recovery });
  assert.equal(result.error, 'checksum_mismatch');
  assert.equal(f.supervisor.registry.get('original'), null);
});

test('an evicted completed Script remains terminal and its result remains readable', async t => {
  const f = await fixture(t, 'module.exports.main = async ctx => { await ctx.checkpoint("done", {}); return 42; };');
  assert.equal(f.started.status, 'completed');
  await f.evict();
  for (const extra of [{}, { recovery }]) {
    const result = await handle({ ...f, operation: 'resume', operationId: 'original', ...extra });
    assert.equal(result.error, 'not_resumable');
  }
  assert.equal((await handle({ ...f, operation: 'result', operationId: 'original' })).result, 42);
  assert.equal(f.supervisor.registry.get('original'), null);
});

test('an evicted cancelled Script requires explicit recovery and preserves its cancellation record', async t => {
  const f = await fixture(t, `module.exports.main = async ctx => {
    if (ctx.resume()?.phase === 'query') return 'continued';
    await ctx.checkpoint('ready', {});
    return await ctx.askAgent({question:'Continue?'});
  };`);
  assert.equal(f.started.status, 'waiting_for_agent');
  assert.equal((await handle({ ...f, operation: 'cancel', operationId: 'original' })).status, 'cancelled');
  const cancelled = f.store.latest('original', 'checkpoint');
  await f.evict();
  assert.equal((await handle({ ...f, operation: 'resume', operationId: 'original' })).error, 'not_resumable');
  const result = await handle({ ...f, operation: 'resume', operationId: 'original', recovery, waitMs: 2000 });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.result, 'continued');
  assert.deepEqual(f.store.list('original').find(row => row.evidenceId === cancelled.evidenceId), cancelled);
});

test('ledger-only status stays readable when an evicted Script has no supplied durable store', async t => {
  const f = await fixture(t, crashSource);
  await f.evict();
  const status = await handle({ supervisor: f.supervisor, operation: 'status', operationId: 'original' });
  assert.equal(status.status, 'failed');
  assert.equal(status.error, 'child_crashed');
  assert.equal(f.supervisor.registry.get('original'), null);
});
