'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createMemoryEvidenceAdapter, createFileEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { readScriptRecovery } = require('../bin/script/script-recovery-view');
const { createScriptSupervisor } = require('../bin/script/script-supervisor');
const { createProductionHost, handle } = require('../bin/script/script-entry');
const { validateCommandArguments } = require('../bin/command-registry');

const target = { platform: 'android', serial: 'recovery-view-test', packageName: 'example.recovery' };
async function facts() {
  const adapter = createMemoryEvidenceAdapter(), store = createScriptEvidenceStore({ adapter });
  await store.persist('checkpoint', { operationId: 'original', revision: 1, stepId: 'before-order',
    checkpoint: { name: 'before-order', state: { phase: 'submit' } }, checkpointActionSequence: 0, actionSequence: 0 });
  const checkpoint = store.latest('original', 'checkpoint');
  async function append(sequence, receipt = true) {
    const common = { operationId: 'original', revision: 1, target, command: 'tap-text', label: `order-${sequence}`,
      actionId: `original:action-${sequence}`, actionSequence: sequence };
    const marked = await store.persist('dispatch-marker', { ...common, planStepId: common.actionId, actionSpecHash: 'a'.repeat(64), state: 'prepared' });
    assert.equal(marked.ok, true, JSON.stringify(marked));
    if (receipt) {
      const saved = await store.persist('action-receipt', { ...common, startedAtMs: 1, completedAtMs: 2,
        mechanicalStatus: 'ok', dispatched: true, ambiguous: false, executionReceipt: { actionId: common.actionId, runtimeEpoch: 'epoch', settled: true } });
      assert.equal(saved.ok, true, JSON.stringify(saved));
    }
  }
  return { adapter, store, checkpoint, append };
}

test('recovery pages pin a checkpoint and high watermark while new actions are appended', async () => {
  const f = await facts(); await f.append(1); await f.append(2, false); await f.append(3);
  const first = readScriptRecovery({ store: f.store, operationId: 'original', limit: 1 });
  assert.equal(first.ok, true); assert.equal(first.hasMore, true);
  assert.equal(first.items[0].command, 'tap-text'); assert.equal(first.items[0].label, 'order-1');
  assert.equal(first.items[0].executionReceipt.runtimeEpoch, 'epoch');
  await f.append(4);
  const second = readScriptRecovery({ store: f.store, operationId: 'original', cursor: first.cursor, limit: 10 });
  assert.deepEqual(second.items.map(row => row.actionSequence), [2, 3]);
  assert.equal(second.items[0].receiptRef, null); assert.equal(second.items[0].ambiguous, true);
  assert.equal(second.items[0].dispatched, null); assert.equal(second.hasMore, false);
  assert.deepEqual(second.through, first.through);
  assert.equal(readScriptRecovery({ store: f.store, operationId: 'other', cursor: first.cursor }).ok, false);
});

test('retention gaps, missing checkpoints and corrupt records are not silently classified as no dispatch', async () => {
  const f = await facts(); await f.append(1); await f.append(3);
  const view = readScriptRecovery({ store: f.store, operationId: 'original' });
  assert.deepEqual(view.coverage.gaps, [{ fromActionSequence: 2, throughActionSequence: 2 }]);
  const filtered = { ...f.store, list: id => f.store.list(id).filter(row => row.evidenceId !== f.checkpoint.evidenceId) };
  assert.equal(readScriptRecovery({ store: filtered, operationId: 'original', checkpointId: f.checkpoint.evidenceId }).error, 'recovery_checkpoint_unavailable');
  const corrupt = { ...f.store, list: id => f.store.list(id).map(row => row.kind === 'dispatch-marker' ? { ...row, command: 'changed' } : row) };
  assert.equal(readScriptRecovery({ store: corrupt, operationId: 'original' }).error, 'checksum_mismatch');
  const broken = { list() { throw Object.assign(new Error('cannot read partition'), { code: 'evidence_read_failed' }); } };
  assert.equal(readScriptRecovery({ store: broken, operationId: 'original' }).error, 'evidence_read_failed');
});

test('expired cursors and invalid query options fail locally with a fresh-query hint', async () => {
  const f = await facts(); await f.append(1); await f.append(2);
  const first = readScriptRecovery({ store: f.store, operationId: 'original', limit: 1 });
  const filtered = { ...f.store, list: id => f.store.list(id).filter(row => row.evidenceId !== first.through.evidenceId) };
  assert.equal(readScriptRecovery({ store: filtered, operationId: 'original', cursor: first.cursor }).error, 'recovery_cursor_expired');
  assert.equal(readScriptRecovery({ store: f.store, operationId: 'original', cursor: 'broken' }).error, 'invalid_recovery_cursor');
  assert.equal(readScriptRecovery({ store: f.store, operationId: 'original', limit: 0 }).ok, false);
  assert.equal(readScriptRecovery({ store: f.store, operationId: 'original', unknown: true }).ok, false);
  assert.doesNotThrow(() => validateCommandArguments('script', { operation: 'recovery', operationId: 'original', cursor: first.cursor, limit: 1 }));
});

for (const language of ['javascript', 'python']) for (const fresh of [false, true]) for (const recording of [false, true]) {
  test(`${language} ${fresh ? 'fresh' : 'live'} Host ${recording ? 'with' : 'without'} recording reads original facts after a child crash and explicitly continues without replay`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-recovery-view-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const reopen = () => createScriptEvidenceStore({ adapter: createFileEvidenceAdapter({ dir: directory }) });
    const create = () => createScriptSupervisor({ createHost: createProductionHost });
    const sup = create(), store = reopen(), effects = [];
    const actions = async (command, args) => { effects.push(args.text); return { ok: true, dispatched: true }; };
    const source = language === 'javascript' ? `module.exports.main = async ctx => {
      if (ctx.resume()?.phase === 'query') {
        const facts = await ctx.recovery();
        if (!facts.ok || facts.items.length !== 1 || facts.items[0].label !== 'submit-order') throw new Error('original facts missing');
        await ctx.call('tap-text', {text:'Query existing order'}, {label:'query-order'});
        return facts;
      }
      await ctx.checkpoint('before-order', {phase:'submit'});
      await ctx.call('tap-text', {text:'Submit'}, {label:'submit-order'});
      process.exit(31);
    };` : `import os
def main(ctx):
    if ctx.resume() and ctx.resume().get('phase') == 'query':
        facts = ctx.recovery()
        if not facts['ok'] or len(facts['items']) != 1 or facts['items'][0]['label'] != 'submit-order': raise RuntimeError('original facts missing')
        ctx.call('tap-text', {'text':'Query existing order'}, {'label':'query-order'})
        return facts
    ctx.checkpoint('before-order', {'phase':'submit'})
    ctx.call('tap-text', {'text':'Submit'}, {'label':'submit-order'})
    os._exit(31)
`;
    const script = { schemaVersion: 'aab.code-script/v1', language, source, target,
      policy: { restartPolicy: 'checkpoint', timeoutMs: 5000 } };
    const recordingDir = path.join(directory, 'recording');
    const start = await handle({ supervisor: sup, store, operation: 'start', operationId: 'crashed', script, actions,
      ...(recording ? { recordingDir } : {}) });
    assert.equal(start.ok, true); await sup.registry.get('crashed').running;
    const before = reopen().list('crashed');
    const firstRecording = store.latest('crashed', 'checkpoint').recording;
    const originalFiles = recording ? fs.readdirSync(firstRecording.directory).map(name => [name, fs.readFileSync(path.join(firstRecording.directory, name))]) : [];
    const nextSup = fresh ? create() : sup;
    const view = await handle({ supervisor: nextSup, store: reopen(), operation: 'recovery', operationId: 'crashed' });
    assert.equal(view.ok, true); assert.equal(view.items[0].command, 'tap-text');
    assert.equal(view.items[0].label, 'submit-order'); assert.deepEqual(effects, ['Submit']);
    const reply = await handle({ supervisor: nextSup, store: reopen(), operation: 'resume', operationId: 'crashed', actions,
      recovery: { checkpoint: { name: 'query-original', state: { phase: 'query' } } }, waitMs: 2000 });
    assert.equal(reply.ok, true, JSON.stringify(reply)); assert.equal(reply.status, 'completed');
    assert.equal(reply.result.items[0].actionId, 'crashed:action-1');
    assert.deepEqual(effects, ['Submit', 'Query existing order']);
    const after = reopen().list('crashed');
    for (const old of before) assert.deepEqual(after.find(row => row.evidenceId === old.evidenceId), old);
    if (!recording) { assert.equal(after.some(row => row.kind === 'attachment'), false); return; }
    const secondRecording = reopen().latest('crashed', 'checkpoint').recording;
    assert.notEqual(secondRecording.recordingId, firstRecording.recordingId);
    assert.notEqual(secondRecording.directory, firstRecording.directory);
    assert.equal(secondRecording.previousRecordingId, firstRecording.recordingId);
    assert.equal(secondRecording.rootDirectory, recordingDir);
    for (const [name, bytes] of originalFiles) assert.deepEqual(fs.readFileSync(path.join(firstRecording.directory, name)), bytes);
    assert.equal(new Set(after.filter(row => row.kind === 'attachment').map(row => row.recordingId)).size, 2);
  });
}

for (const language of ['javascript', 'python']) for (const fresh of [false, true]) for (const recording of [false, true]) {
  test(`${language} ${fresh ? 'fresh' : 'live'} Host ${recording ? 'with' : 'without'} recording keeps the original recovery boundary through repeated crashes until a program checkpoint`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-repeated-recovery-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const reopen = () => createScriptEvidenceStore({ adapter: createFileEvidenceAdapter({ dir: directory }) });
    const create = () => createScriptSupervisor({ createHost: createProductionHost });
    let supervisor = create();
    const effects = [];
    const actions = async (command, args) => { effects.push(args.text); return { ok: true, dispatched: true }; };
    const source = language === 'javascript' ? `exports.main=async ctx=>{
      const state=ctx.resume();
      if(state?.phase==='after') {
        const view=await ctx.recovery();
        if(!view.ok || view.items.length!==0) throw new Error('checkpoint did not advance boundary');
        return {advanced:true};
      }
      if(state?.phase==='query') {
        const view=await ctx.recovery();
        if(!view.ok || view.items.length!==1 || view.items[0].actionId!=='repeated:action-1') throw new Error('original action missing');
        if(state.advance) await ctx.checkpoint('after-reconcile',{phase:'after'});
        process.exit(31);
      }
      await ctx.checkpoint('before-order',{phase:'submit'});
      await ctx.call('tap-text',{text:'Submit'},{label:'submit-original'});
      process.exit(31);
    };` : `import os
def main(ctx):
    state=ctx.resume()
    if state and state.get('phase')=='after':
        view=ctx.recovery()
        if not view['ok'] or len(view['items'])!=0: raise RuntimeError('checkpoint did not advance boundary')
        return {'advanced':True}
    if state and state.get('phase')=='query':
        view=ctx.recovery()
        if not view['ok'] or len(view['items'])!=1 or view['items'][0]['actionId']!='repeated:action-1': raise RuntimeError('original action missing')
        if state.get('advance'): ctx.checkpoint('after-reconcile',{'phase':'after'})
        os._exit(31)
    ctx.checkpoint('before-order',{'phase':'submit'})
    ctx.call('tap-text',{'text':'Submit'},{'label':'submit-original'})
    os._exit(31)
`;
    const script = { schemaVersion: 'aab.code-script/v1', language, source, target,
      policy: { restartPolicy: 'checkpoint', timeoutMs: 5000 } };
    async function run(operation, extra = {}) {
      if (fresh && operation === 'resume') supervisor = create();
      const reply = await handle({ supervisor, store: reopen(), operation, operationId: 'repeated', actions, ...extra });
      assert.equal(reply.ok, true, JSON.stringify(reply));
      await supervisor.registry.get('repeated').running;
      return supervisor.registry.get('repeated');
    }
    const first = await run('start', { script, ...(recording ? { recordingDir: path.join(directory, 'recording') } : {}) });
    assert.equal(first.error, 'child_crashed');
    const original = reopen().list('repeated').filter(row => row.kind === 'dispatch-marker' || row.kind === 'action-receipt');
    const recover = advance => ({ recovery: { checkpoint: { name: 'query-original', state: { phase: 'query', advance } } } });
    for (const extra of [recover(false), {}, recover(false)]) {
      const stopped = await run('resume', extra);
      assert.equal(stopped.error, 'child_crashed');
      const view = await handle({ supervisor, store: reopen(), operation: 'recovery', operationId: 'repeated' });
      assert.equal(view.ok, true, JSON.stringify(view));
      assert.deepEqual(view.items.map(row => row.actionId), ['repeated:action-1']);
      assert.equal(view.checkpoint.actionSequence, 0);
    }
    assert.equal((await run('resume', recover(true))).error, 'child_crashed');
    const advanced = await handle({ supervisor, store: reopen(), operation: 'recovery', operationId: 'repeated' });
    assert.equal(advanced.ok, true); assert.deepEqual(advanced.items, []);
    assert.equal(advanced.checkpoint.actionSequence, 1);
    assert.equal((await run('resume')).status, 'completed');
    assert.deepEqual(effects, ['Submit']);
    for (const old of original) assert.deepEqual(reopen().list('repeated').find(row => row.evidenceId === old.evidenceId), old);
  });
}
