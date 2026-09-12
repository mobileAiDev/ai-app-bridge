'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createEvidenceStore } = require('../bin/shared-kernel/evidence-store');
const { createEvidenceRecording, jsonHash, sha256, MAX_FILE_BYTES } = require('../bin/shared-kernel/evidence-recording');
const { handle } = require('../bin/shared-kernel/evidence-archive');
const { analyzeRecordedPayloads } = require('../bin/shared-kernel/recorded-payload-archive');
const { createScriptSupervisor } = require('../bin/script/script-supervisor');
const { createIntentWorker } = require('../bin/intent/intent-worker');

const TARGET = { platform: 'android', serial: 'phone', packageName: 'example.notes' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

function setup(t, namespace = 'script') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-recording-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const operationId = 'recorded-operation';
  const store = createEvidenceStore({ namespace, adapter: createMemoryEvidenceAdapter() });
  const directory = path.join(root, 'recording');
  const recording = createEvidenceRecording({ directory, namespace, operationId, store });
  const facts = () => store.list(operationId).map((payload, i) => ({ payload, globalSeq: i + 1,
    targetKey: `evidence:${namespace}:${operationId}`, runtimeEpoch: operationId, actionId: payload.evidenceId }));
  const exportArchive = (outputDir = path.join(root, 'export'), includeRecordedPayloads = true) => handle({
    operation: 'export', operationId, namespace, outputDir, includeRecordedPayloads,
  }, { getFactStore: () => ({ drain: async () => {},
    status: () => ({ ok: true, authoritative: true, persistence: true, storeId: 'test-store',
      sequences: { nextGlobalSeq: facts().length + 1 } }),
    read: () => ({ ok: true, items: facts(), gap: false, cursorExpired: false, hasMore: false }),
  }) });
  return { root, operationId, store, recording, directory, facts, exportArchive };
}

const verify = (archiveDir, manifestSha256) => handle({ operation: 'verify', archiveDir, manifestSha256 }, {
  getFactStore() { assert.fail('offline verify must not open a store'); },
});

function callData(operationId, result = { page: '首页' }, command = 'tree', refs = []) {
  return { command, args: {}, startedAtMs: 10, completedAtMs: 20, envelope: {
    ok: true, command, result, error: null, ambiguous: false,
    execution: { executionId: operationId, callId: 'call-1', actionId: null },
    evidence: { observationId: 'observed-1', source: { scope: 'execution', command, payloadSha256: jsonHash(result) },
      window: { afterActionId: null, closedAtMs: 20 }, coverage: { status: 'complete', gap: false, committed: true }, refs },
  } };
}

test('archives full calls, screenshots and failed assertions independently of original files', async t => {
  const f = setup(t);
  const screenshot = path.join(f.root, 'screen.png');
  fs.writeFileSync(screenshot, PNG);
  const ref = { stream: 'screenshot', screenshotId: screenshot, sha256: sha256(PNG) };
  const data = callData(f.operationId, { path: screenshot }, 'screenshot', [ref]);
  assert.equal((await f.recording.record({ kind: 'script-call', revision: 1, target: TARGET, data })).ok, true);
  fs.writeFileSync(screenshot, 'overwritten original');
  const assertion = { name: 'wrong expectation', scope: 'device', condition: false, evidence: data.envelope.evidence };
  assert.equal((await f.recording.record({ kind: 'script-assertion', revision: 1, target: TARGET,
    data: { assertion, result: { name: assertion.name, scope: 'device', verdict: 'failed' } } })).ok, true);
  const exported = await f.exportArchive();
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.equal(exported.recordedPayloads.counts.assertions.failed, 1);
  assert.equal(exported.recordedPayloads.counts.screenshots, 1);
  assert.equal(exported.recordedPayloads.businessVerdict, 'not-evaluated');
  const moved = path.join(f.root, 'moved');
  fs.renameSync(exported.archiveDir, moved);
  fs.rmSync(f.directory, { recursive: true });
  assert.equal((await verify(moved, exported.manifestSha256)).ok, true);
  const copied = exported.recordedPayloads.files.find(file => file.path.endsWith('.png'));
  assert.deepEqual(fs.readFileSync(path.join(moved, copied.path)), PNG);
});

test('copies screenshot bytes before awaiting an earlier persistence operation', async t => {
  const f = setup(t);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const recording = createEvidenceRecording({ directory: path.join(f.root, 'blocked'), namespace: 'script',
    operationId: f.operationId, store: { persist: async () => { await blocked; return { ok: true, persisted: true }; } } });
  const first = recording.record({ kind: 'script-call', revision: 1, target: TARGET, data: callData(f.operationId) });
  const screenshot = path.join(f.root, 'screen.png');
  fs.writeFileSync(screenshot, PNG);
  const second = recording.record({ kind: 'script-call', revision: 1, target: TARGET,
    data: callData(f.operationId, { path: screenshot }, 'screenshot', [{ stream: 'screenshot', screenshotId: screenshot, sha256: sha256(PNG) }]) });
  fs.writeFileSync(screenshot, 'different bytes');
  release();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'blocked', '2-1.png')), PNG);
});

test('redacts credentials while retaining distinct original and archived source hashes', async t => {
  const f = setup(t);
  const data = callData(f.operationId, { password: 'private-value', normal: '保留' });
  await f.recording.record({ kind: 'script-call', revision: 1, target: TARGET, data });
  const record = f.facts()[0].payload;
  const bytes = fs.readFileSync(path.join(f.directory, record.file.name), 'utf8');
  assert(!bytes.includes('private-value'));
  assert(bytes.includes('[REDACTED]'));
  assert.equal(record.representation, 'redacted-json');
  assert.notEqual(record.sourcePayload.originalSha256, record.sourcePayload.archivedSha256);
  assert.equal((await f.exportArchive()).ok, true);
});

for (const mode of ['hash', 'symlink', 'not-png', 'missing-hash']) {
  test(`rejects ${mode} screenshot instead of publishing an attachment`, async t => {
    const f = setup(t);
    const file = path.join(f.root, 'screen.png');
    fs.writeFileSync(file, mode === 'not-png' ? Buffer.alloc(32) : PNG);
    const ref = { stream: 'screenshot', screenshotId: file,
      sha256: mode === 'hash' ? 'a'.repeat(64) : sha256(fs.readFileSync(file)) };
    if (mode === 'missing-hash') delete ref.sha256;
    if (mode === 'symlink') {
      fs.renameSync(file, file + '.original'); fs.symlinkSync(file + '.original', file);
    }
    const result = await f.recording.record({ kind: 'script-call', revision: 1, target: TARGET,
      data: callData(f.operationId, {}, 'screenshot', [ref]) });
    assert.equal(result.ok, false);
    assert.equal(f.facts().length, 0);
    assert.equal((await f.recording.record({ kind: 'script-call', revision: 1, target: TARGET,
      data: callData(f.operationId) })).error, result.error, 'recording failure is sticky');
  });
}

test('rejects oversized payloads and existing directories without replacing files', async t => {
  const f = setup(t);
  assert.throws(() => createEvidenceRecording({ directory: f.directory, namespace: 'script', operationId: f.operationId, store: f.store }),
    { code: 'output_exists' });
  const result = await f.recording.record({ kind: 'script-call', revision: 1, target: TARGET,
    data: callData(f.operationId, 'x'.repeat(MAX_FILE_BYTES)) });
  assert.equal(result.error, 'recording_limit_exceeded');
  assert.equal(f.facts().length, 0);
});

for (const mutation of ['delete', 'tamper', 'symlink']) {
  test(`offline verify rejects ${mutation} of an included payload`, async t => {
    const f = setup(t);
    await f.recording.record({ kind: 'script-call', revision: 1, target: TARGET, data: callData(f.operationId) });
    const exported = await f.exportArchive();
    assert.equal(exported.ok, true, JSON.stringify(exported));
    const file = path.join(exported.archiveDir, exported.recordedPayloads.files[0].path);
    if (mutation === 'delete') fs.unlinkSync(file);
    if (mutation === 'tamper') fs.appendFileSync(file, ' ');
    if (mutation === 'symlink') { fs.renameSync(file, file + '.outside'); fs.symlinkSync(file + '.outside', file); }
    assert.equal((await verify(exported.archiveDir, exported.manifestSha256)).ok, false);
  });
}

function mobilePage() {
  return { stream: 'events', items: [{ id: 12, timestampMs: 15, type: 'event', name: 'ui.stable', source: 'sdk' }],
    refs: [{ mobileFactId: 'fact-12', stream: 'events', captureId: 12, capturedAtMs: 15, runtimeEpoch: 'old-epoch', targetKey: TARGET.packageName }],
    runtimeEpoch: 'current-epoch', targetKey: TARGET.packageName, storeGeneration: 2, hasMore: false,
    watermarkCursor: 'cursor', nextCursor: null, throughWatermark: 16,
    window: { afterActionId: null, runtimeEpoch: null, filterApplied: true, targetKey: TARGET.packageName },
    coverage: { status: 'complete', gap: false, committed: true }, gap: false, committed: true };
}

test('Web capture archives retain binary bodies and bind Host refs to the exact document', async t => {
  const f = setup(t);
  const target = { platform: 'web', sessionId: 'browser', runtimeEpoch: 'document', targetId: 'main' };
  const targetKey = 'web:["browser","main","network"]';
  const ref = { source: 'host-fact-store', stream: 'network', globalSeq: 16, runtimeEpoch: 'document', targetKey };
  const item = { ...target, id: 16, ref, captureId: 'capture-1', sourceSequence: 1,
    association: 'unattributed', actionId: null, requestBody: 'AP8=', requestBodyEncoding: 'base64', requestBodyState: 'complete' };
  const data = callData(f.operationId, { items: [item] }, 'web-network', [ref]);
  data.envelope.evidence.capture = { runtimeEpoch: 'document', targetKey };
  await f.recording.record({ kind: 'script-call', revision: 1, target, data });
  const exported = await f.exportArchive();
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.equal(exported.recordedPayloads.counts.boundWebItems, 1);
  assert.equal(exported.recordedPayloads.counts.mobileItems, 0);
  fs.rmSync(f.directory, { recursive: true });
  assert.equal((await verify(exported.archiveDir, exported.manifestSha256)).ok, true);
});

test('Web capture archives reject a ref from another browser document', async t => {
  const f = setup(t);
  const target = { platform: 'web', sessionId: 'browser', runtimeEpoch: 'document', targetId: 'main' };
  const targetKey = 'web:["browser","main","network"]';
  const ref = { source: 'host-fact-store', stream: 'network', globalSeq: 16, runtimeEpoch: 'another', targetKey };
  const item = { ...target, id: 16, ref, captureId: 'capture-1', sourceSequence: 1, association: 'unattributed', actionId: null };
  const data = callData(f.operationId, { items: [item] }, 'web-network', [ref]);
  data.envelope.evidence.capture = { runtimeEpoch: 'document', targetKey };
  await f.recording.record({ kind: 'script-call', revision: 1, target, data });
  assert.equal((await f.exportArchive()).error, 'web_capture_ref_binding_mismatch');
});

test('Intent recording retains original pages and old-epoch refs without an extra device query', async t => {
  const f = setup(t, 'intent');
  let queries = 0;
  const worker = createIntentWorker({ operationId: f.operationId, target: TARGET, store: f.store, recording: f.recording,
    adapter: { observe: async () => ({ ok: true, rawTreeId: 'tree-1', rawTree: { nodes: [] } }) },
    captureRequirements: { streams: ['events'], view: 'connected-history' },
    capturePort: { observe: async () => { queries += 1; return mobilePage(); } } });
  assert.equal((await worker.start()).ok, true);
  const exported = await f.exportArchive();
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.equal(queries, 1);
  assert.equal(exported.recordedPayloads.counts.boundMobileItems, 1);
  assert.equal((await verify(exported.archiveDir, exported.manifestSha256)).ok, true);
});

test('Intent recording preserves structured capture errors through portable verification', async t => {
  const f = setup(t, 'intent');
  const worker = createIntentWorker({ operationId: f.operationId, target: TARGET, store: f.store, recording: f.recording,
    adapter: { observe: async () => ({ ok: true, rawTreeId: 'tree-1', rawTree: { nodes: [] } }) },
    captureRequirements: { streams: ['events'] },
    capturePort: { observe: async () => ({ ok: false, error: 'invalid_argument', field: 'limit', message: 'limit must be an integer',
      coverage: { status: 'unavailable', gap: true, committed: false }, gap: true, committed: false, refs: [], items: [] }) } });
  const started = await worker.start(); assert.equal(started.ok, true); assert.equal(started.capture.coverage.status, 'unavailable');
  const exported = await f.exportArchive(); assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.equal((await verify(exported.archiveDir, exported.manifestSha256)).ok, true);
});

for (const [field, value] of [['operationId', 'other-operation'], ['target', { serial: 'other' }]]) {
  test(`does not trust a checksummed payload with a different ${field}`, async t => {
    const f = setup(t);
    await f.recording.record({ kind: 'script-call', revision: 1, target: TARGET, data: callData(f.operationId) });
    const facts = f.facts();
    const file = facts[0].payload.file;
    const doc = JSON.parse(fs.readFileSync(path.join(f.directory, file.name)));
    doc[field] = value;
    const bytes = Buffer.from(JSON.stringify(doc));
    file.sha256 = sha256(bytes); file.bytes = bytes.length;
    assert.throws(() => analyzeRecordedPayloads(facts, () => bytes), { code: 'attachment_binding_mismatch' });
  });
}

test('Script captures before bounded event eviction, including Host verdicts without author file writes', async t => {
  const f = setup(t);
  const supervisor = createScriptSupervisor({ createRuntime: () => ({ start: async ({ host }) => {
    for (let i = 0; i < 150; i += 1) {
      await host.call('tree', {}, { timeoutMs: 500 });
      await host.assert({ name: `claim-${i}`, scope: 'code', condition: i !== 149 });
    }
    return { ok: true };
  } }) });
  const started = await supervisor.handle({ operation: 'start', operationId: f.operationId, store: f.store,
    recordingDir: path.join(f.root, 'script-recording'),
    script: { schemaVersion: 'aab.code-script/v1', language: 'javascript', source: 'unused by fixture', target: TARGET },
    actions: async () => ({ ok: true, nodes: [{ text: '首页' }] }) });
  assert.equal(started.ok, true);
  await supervisor.registry.get(f.operationId).running;
  const status = supervisor.handle({ operation: 'status', operationId: f.operationId });
  assert.equal(status.status, 'completed');
  assert(status.events.length <= 256);
  const exported = await f.exportArchive();
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.equal(exported.recordedPayloads.counts.scriptCalls, 150);
  assert.deepEqual(exported.recordedPayloads.counts.assertions, { passed: 149, failed: 1, inconclusive: 0 });
  const first = JSON.parse(fs.readFileSync(path.join(exported.archiveDir, exported.recordedPayloads.attachments[0].path)));
  assert.deepEqual(first.data.options, { timeoutMs: 500 });
});

test('a recording persistence failure prevents the child from dispatching its next action', async t => {
  const f = setup(t);
  let dispatched = 0, returned;
  const persist = f.store.persist;
  f.store.persist = (kind, body) => kind === 'attachment' ? { ok: false, error: 'disk-failure' } : persist(kind, body);
  const supervisor = createScriptSupervisor({ createRuntime: () => ({ start: async ({ host }) => {
    returned = await host.call('tree');
    await host.call('tap', { x: 10, y: 20 });
    return { ok: true };
  } }) });
  const started = await supervisor.handle({ operation: 'start', operationId: f.operationId, store: f.store,
    recordingDir: path.join(f.root, 'failed-recording'),
    script: { schemaVersion: 'aab.code-script/v1', language: 'javascript', source: 'fixture', target: TARGET },
    actions: async command => { if (command === 'tap') dispatched += 1; return { ok: true }; } });
  assert.equal(started.ok, true);
  await supervisor.registry.get(f.operationId).running;
  assert.equal(returned.error, 'recording_not_persisted');
  assert.equal(dispatched, 0);
  const state = supervisor.handle({ operation: 'status', operationId: f.operationId });
  assert.equal(state.status, 'failed'); assert.equal(state.error, 'recording_not_persisted');
});

test('rejects checkpoint restart recording before runtime start or directory creation', async t => {
  const f = setup(t);
  const output = path.join(f.root, 'unsupported');
  const supervisor = createScriptSupervisor({ createRuntime() { assert.fail('must reject before runtime creation'); } });
  const result = await supervisor.handle({ operation: 'start', store: f.store, recordingDir: output,
    script: { schemaVersion: 'aab.code-script/v1', language: 'javascript', source: 'fixture', target: TARGET,
      policy: { restartPolicy: 'checkpoint' } } });
  assert.equal(result.error, 'recording_restart_unsupported');
  assert.equal(fs.existsSync(output), false);
});

for (const [field, value, error] of [
  ['captureId', 999, 'capture_ref_binding_mismatch'],
  ['targetKey', 'another-app', 'capture_ref_binding_mismatch'],
  ['capturedAtMs', 999, 'capture_ref_binding_mismatch'],
]) {
  test(`refuses a mobile ref whose ${field} contradicts the included item`, async t => {
    const f = setup(t);
    const page = mobilePage(); page.refs[0][field] = value;
    const data = callData(f.operationId, { items: page.items }, 'events', page.refs);
    data.envelope.evidence.capture = { runtimeEpoch: page.runtimeEpoch, targetKey: page.targetKey };
    data.envelope.evidence.window = page.window;
    await f.recording.record({ kind: 'script-call', revision: 1, target: TARGET, data });
    const exported = await f.exportArchive();
    assert.equal(exported.error, error);
    assert.equal(fs.existsSync(path.join(f.root, 'export')), false);
  });
}

test('a rejected child assertion with forged evidence is retained without accepting the claim', async t => {
  const f = setup(t);
  await f.recording.record({ kind: 'script-assertion', revision: 1, target: TARGET, data: {
    assertion: { name: 'forged', condition: true, scope: 'device', evidence: { observationId: 'forged-id' } },
    result: { name: 'forged', verdict: 'inconclusive', scope: 'device', reason: 'evidence_not_host_issued' },
  } });
  const exported = await f.exportArchive();
  assert.equal(exported.ok, true);
  assert.deepEqual(exported.recordedPayloads.counts.assertions, { passed: 0, failed: 0, inconclusive: 1 });
});

test('payload inclusion refuses a missing recording while explicit records-only export remains diagnostic', async t => {
  const f = setup(t);
  await f.recording.record({ kind: 'script-call', revision: 1, target: TARGET, data: callData(f.operationId) });
  fs.rmSync(f.directory, { recursive: true });
  assert.equal((await f.exportArchive()).ok, false);
  const retained = await f.exportArchive(path.join(f.root, 'records-only'), false);
  assert.equal(retained.ok, true); assert.equal(retained.coverage.externalPayloads, 'not-included');
  assert.equal(retained.recordedPayloads, undefined);
});
