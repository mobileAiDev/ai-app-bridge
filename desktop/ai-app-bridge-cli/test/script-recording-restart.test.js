'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createFileEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { createScriptSupervisor } = require('../bin/script/script-supervisor');
const { createProductionHost, handle } = require('../bin/script/script-entry');
const archive = require('../bin/shared-kernel/evidence-archive');

async function interrupted(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-recording-restart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reopen = () => createScriptEvidenceStore({ adapter: createFileEvidenceAdapter({ dir: path.join(root, 'facts') }) });
  const store = reopen(), effects = [];
  const actions = async (command, args) => { effects.push(args.text); return { ok: true, dispatched: true }; };
  const script = { schemaVersion: 'aab.code-script/v1', language: 'javascript',
    target: { platform: 'android', serial: 'recording-restart', packageName: 'example.recording' },
    policy: { restartPolicy: 'checkpoint', timeoutMs: 5000 },
    source: `module.exports.main=async ctx=>{
      const phase=ctx.resume()?.phase;
      if(phase==='continue') { await ctx.call('tap-text',{text:'Second'}); await ctx.checkpoint('after-second',{phase:'done'}); process.exit(31); }
      if(phase==='done') { await ctx.call('tap-text',{text:'Third'}); return {done:true}; }
      await ctx.call('tap-text',{text:'First'});
      await ctx.checkpoint('after-first',{phase:'continue'});
      process.exit(31);
    };` };
  const supervisor = createScriptSupervisor({ createHost: createProductionHost });
  const start = await handle({ supervisor, store, operation: 'start', operationId: 'recorded', script, actions,
    recordingDir: path.join(root, 'recording') });
  assert.equal(start.ok, true); await supervisor.registry.get('recorded').running;
  return { root, store, reopen, actions, effects };
}

test('repeated Host restarts create immutable recording attempts, export all retained attempts and verify offline', async t => {
  const f = await interrupted(t);
  const before = f.reopen().list('recorded');
  for (let attempt = 0; attempt < 2; attempt++) {
    const supervisor = createScriptSupervisor({ createHost: createProductionHost });
    const resumed = await handle({ supervisor, store: f.reopen(), operation: 'resume', operationId: 'recorded', actions: f.actions });
    assert.equal(resumed.ok, true, JSON.stringify(resumed)); await supervisor.registry.get('recorded').running;
  }
  assert.deepEqual(f.effects, ['First', 'Second', 'Third']);
  const records = f.reopen().list('recorded');
  for (const old of before) assert.deepEqual(records.find(row => row.evidenceId === old.evidenceId), old);
  const attachments = records.filter(row => row.kind === 'attachment');
  assert.equal(new Set(attachments.map(row => row.recordingId)).size, 3);
  assert.equal(new Set(attachments.map(row => row.directory)).size, 3);
  const facts = records.map((payload, index) => ({ payload, globalSeq: index + 1,
    targetKey: 'evidence:script:recorded', runtimeEpoch: 'recorded', actionId: payload.evidenceId }));
  const exported = await archive.handle({ operation: 'export', namespace: 'script', operationId: 'recorded',
    outputDir: path.join(f.root, 'export'), includeRecordedPayloads: true }, { getFactStore: () => ({
    drain: async () => {}, status: () => ({ ok: true, authoritative: true, persistence: true, storeId: 'test-store', sequences: { nextGlobalSeq: facts.length + 1 } }),
    read: () => ({ ok: true, items: facts, gap: false, cursorExpired: false, hasMore: false }),
  }) });
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.equal(exported.recordedPayloads.counts.scriptCalls, 3);
  const verified = await archive.handle({ operation: 'verify', archiveDir: exported.archiveDir, manifestSha256: exported.manifestSha256 }, {
    getFactStore() { assert.fail('Offline verification must not reopen the live store'); },
  });
  assert.equal(verified.ok, true, JSON.stringify(verified));
});

test('failed attempt persistence starts no new child and leaves previous attachments intact', async t => {
  const f = await interrupted(t), backing = f.reopen(), before = backing.list('recorded');
  const store = { ...backing, persist: async (kind, row) => row.recording?.previousRecordingId
    ? { ok: false, error: 'ENOSPC' } : backing.persist(kind, row) };
  const supervisor = createScriptSupervisor({ createHost: createProductionHost });
  const result = await handle({ supervisor, store, operation: 'resume', operationId: 'recorded', actions: f.actions });
  assert.equal(result.error, 'ENOSPC'); assert.deepEqual(f.effects, ['First']);
  assert.deepEqual(backing.list('recorded'), before);
  assert.equal(supervisor.registry.get('recorded'), null);
});

test('recording identity mismatch is a local recoverable failure, not an implicit new recording', async t => {
  const f = await interrupted(t);
  fs.writeFileSync(path.join(f.root, 'recording', 'script-recording.json'), JSON.stringify({ schemaVersion: 'aab.script-recording/v1', operationId: 'other' }));
  const result = await handle({ supervisor: createScriptSupervisor({ createHost: createProductionHost }), store: f.reopen(),
    operation: 'resume', operationId: 'recorded', actions: f.actions });
  assert.equal(result.error, 'recording_identity_mismatch'); assert.deepEqual(f.effects, ['First']);
  assert.equal(fs.readdirSync(path.join(f.root, 'recording')).filter(name => name.startsWith('attempt-')).length, 1);
});
