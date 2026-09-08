'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { handle } = require('../bin/shared-kernel/evidence-archive');
const { buildEnvelope } = require('../bin/shared-kernel/evidence-schema');

const OPERATION = 'archive-operation';
const APP = 'example.notes';
const SERIAL = 'phone-one';
const TARGET = { serial: SERIAL, packageName: APP };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function fact(namespace, kind, fields, globalSeq) {
  const built = buildEnvelope(namespace, kind, {
    operationId: OPERATION,
    revision: 1,
    evidenceId: `${namespace}:${kind}:${OPERATION}:${globalSeq}`,
    ...fields,
  }, { now: () => 1000 + globalSeq, sequence: globalSeq });
  assert.equal(built.ok, true, JSON.stringify(built));
  return {
    partition: ['observation', 'summary'].includes(kind) ? 'ui' : 'action',
    targetKey: `evidence:${namespace}:${OPERATION}`,
    app: { platform: 'host', packageName: namespace },
    runtimeEpoch: OPERATION,
    actionId: built.envelope.evidenceId,
    timestamps: { occurredAtMs: 1000 + globalSeq, observedAtMs: 1000 + globalSeq, ingestedAtMs: 1000 + globalSeq },
    payload: built.envelope,
    globalSeq,
  };
}

function intentFacts({ systemRoute = false } = {}) {
  const rawTreeId = `${OPERATION}:1`;
  const observedPackage = systemRoute ? 'com.android.documentsui' : APP;
  const observation = fact('intent', 'observation', {
    ...TARGET, packageName: observedPackage, provider: systemRoute ? 'uia' : 'native',
    capturedAtMs: 900, rawTreeId,
    rawTree: '<hierarchy><node package="example.notes" text="中文 &amp; café" /></hierarchy>',
    ...(systemRoute ? { requestedTarget: { ...TARGET, foregroundPackages: [observedPackage] },
      route: { packageName: observedPackage, provider: 'uia', activity: '.FilesActivity' } } : {}),
  }, 1);
  const action = { action: 'tap', text: 'Open', provider: systemRoute ? 'uia' : 'native' };
  const actionId = `${OPERATION}:decision-one`;
  const foreground = systemRoute ? { packageName: observedPackage, provider: 'uia', activity: '.FilesActivity' } : undefined;
  return [
    observation,
    fact('intent', 'summary', { rawTreeId, summary: { text: 'Open' }, target: TARGET }, 2),
    fact('intent', 'decision', { decisionId: 'decision-one', basedOnEvidenceIds: [observation.payload.evidenceId],
      actionSpecHash: 'action-hash', agentDecision: 'act', action, target: TARGET }, 3),
    fact('intent', 'dispatch-marker', { actionId, decisionId: 'decision-one', actionSpecHash: 'action-hash',
      target: TARGET, action, state: 'prepared', ...(foreground ? { foreground } : {}) }, 4),
    fact('intent', 'action-receipt', { actionId, startedAtMs: 1010, completedAtMs: 1020,
      mechanicalStatus: 'ok', target: TARGET, rawTreeId, basedOnEvidenceIds: [observation.payload.evidenceId],
      parentFactId: observation.payload.evidenceId }, 5),
  ];
}

function changedFact(original, change) {
  const { namespace, kind, checksum, persisted, committedAtMs, ...fields } = original.payload;
  return fact(namespace, kind, { ...fields, ...change }, original.globalSeq);
}

function scriptFacts({ dispatchTarget = TARGET, receiptFields = {} } = {}) {
  const actionId = `${OPERATION}:action-1`;
  return [
    fact('script', 'checkpoint', { stepId: 'start', status: 'running', target: TARGET }, 1),
    fact('script', 'dispatch-marker', { actionId, planStepId: actionId, actionSpecHash: 'action-hash',
      target: dispatchTarget, state: 'prepared' }, 2),
    fact('script', 'action-receipt', { actionId, startedAtMs: 1010, completedAtMs: 1020,
      mechanicalStatus: 'ok', ...receiptFields }, 3),
    fact('script', 'checkpoint', { stepId: 'start', status: 'completed', target: TARGET }, 4),
  ];
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-evidence-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, outputDir: path.join(root, 'archive') };
}

function fakeStore(facts, options = {}) {
  let statusCalls = 0;
  const calls = [];
  let drained = false;
  return {
    calls,
    async drain() { drained = true; },
    status() {
      statusCalls += 1;
      const status = { ok: true, authoritative: true, persistence: true, storeId: 'store-one',
        sequences: { nextGlobalSeq: (facts.at(-1)?.globalSeq || 0) + 1 },
        quota: { partitions: { ui: { firstSequence: 1, evictedRecords: 0 }, action: { firstSequence: 2, evictedRecords: 0 } } },
        ...options.status };
      return options.statusAt ? options.statusAt(statusCalls, status) : status;
    },
    read(query) {
      assert.equal(drained, true, 'pending writes must be drained before taking a snapshot');
      calls.push(query);
      if (options.read) return options.read(query, calls.length);
      assert.equal(query.targetKey, `evidence:${options.namespace || facts[0]?.payload.namespace || 'intent'}:${OPERATION}`);
      assert.equal(query.limit, 1000);
      const offset = query.cursor === undefined ? 0 : Number(query.cursor.slice('page:'.length));
      const items = facts.slice(offset, offset + query.limit);
      return { ok: true, items, gap: false, cursorExpired: false, hasMore: offset + items.length < facts.length,
        cursor: `page:${offset + items.length}` };
    },
  };
}

async function exportFacts(outputDir, facts, options) {
  const store = fakeStore(facts, options);
  const result = await handle({ operation: 'export', namespace: facts[0]?.payload.namespace || 'intent',
    operationId: OPERATION, outputDir }, { getFactStore: () => store });
  return { result, store };
}

function verify(archiveDir, manifestSha256) {
  return handle({ operation: 'verify', archiveDir, manifestSha256 }, {
    getFactStore() { assert.fail('offline verification must never open a FactStore'); },
  });
}

function manifestAt(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
}

function rewriteManifest(directory, change) {
  const manifest = manifestAt(directory);
  change(manifest);
  const bytes = Buffer.from(JSON.stringify(manifest) + '\n');
  fs.writeFileSync(path.join(directory, 'manifest.json'), bytes);
  return digest(bytes);
}

function replaceRecords(directory, change) {
  const records = JSON.parse(fs.readFileSync(path.join(directory, 'records.json')));
  change(records);
  const bytes = Buffer.from(JSON.stringify(records) + '\n');
  fs.writeFileSync(path.join(directory, 'records.json'), bytes);
  return rewriteManifest(directory, manifest => {
    manifest.records.bytes = bytes.length;
    manifest.records.sha256 = digest(bytes);
  });
}

test('exports retained Intent records and verifies them after relocation without the source store', async t => {
  const { root, outputDir } = fixture(t);
  const facts = intentFacts();
  const before = clone(facts);
  const { result } = await exportFacts(outputDir, facts);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(facts, before, 'export must not mutate source objects');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outputDir, 'records.json'))), facts);
  const manifest = manifestAt(outputDir);
  assert.equal(manifest.source.storeId, 'store-one');
  assert.equal(manifest.source.throughGlobalSeq, 5);
  assert.equal(manifest.recordCount, 5);
  assert.equal(manifest.coverage.scope, 'retained-host-records');
  assert.equal(manifest.coverage.priorHistoryComplete, 'unknown');
  assert.equal(manifest.coverage.referenceClosure, 'complete');
  assert.equal(manifest.coverage.executionStatus, 'not-inferred');
  assert.equal(manifest.coverage.businessVerdict, 'not-evaluated');
  const moved = path.join(root, 'relocated');
  fs.renameSync(outputDir, moved);
  const checked = await verify(moved, result.manifestSha256);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.equal(checked.integrity, 'verified');
  assert.equal(checked.archiveDir, moved);
});

test('pages more than 1000 records and preserves noncontiguous global sequences', async t => {
  const { outputDir } = fixture(t);
  const facts = Array.from({ length: 1003 }, (_, index) => fact('script', 'checkpoint', {
    stepId: `step-${index}`, target: TARGET,
  }, index * 3 + 1));
  const { result, store } = await exportFacts(outputDir, facts);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.recordCount, 1003);
  assert.deepEqual(store.calls.map(call => call.cursor), [undefined, 'page:1000']);
  assert.equal(manifestAt(outputDir).lastGlobalSeq, 3007);
  assert.equal((await verify(outputDir, result.manifestSha256)).ok, true);
});

test('preserves raw source strings exactly, including escapes, Unicode and null values', async t => {
  const { outputDir } = fixture(t);
  const source = 'async function main(ctx) {\n  return `路径 \\ ${ctx.inputs.name} 中文`;\n}\n';
  const facts = [fact('script', 'checkpoint', { stepId: 'start', target: TARGET, source, inputs: { missing: null } }, 1)];
  const { result } = await exportFacts(outputDir, facts);
  assert.equal(result.ok, true, JSON.stringify(result));
  const stored = JSON.parse(fs.readFileSync(path.join(outputDir, 'records.json')))[0].payload;
  assert.equal(stored.source, source);
  assert.equal(stored.inputs.missing, null);
  assert.equal((await verify(outputDir, result.manifestSha256)).ok, true);
});

test('preserves prior retention losses without claiming complete historical coverage', async t => {
  const { outputDir } = fixture(t);
  const quota = { partitions: { ui: { firstSequence: 30, evictedRecords: 29 }, action: { firstSequence: 15, evictedRecords: 14 } } };
  const { result } = await exportFacts(outputDir, intentFacts(), { status: { quota } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(manifestAt(outputDir).source.retention, quota.partitions);
  assert.equal(result.coverage.priorHistoryComplete, 'unknown');
});

for (const [label, change, error] of [
  ['payload operation', facts => { facts[0].payload.operationId = 'other-operation'; }, 'record_scope_mismatch'],
  ['payload namespace', facts => { facts[0].payload.namespace = 'script'; }, 'record_scope_mismatch'],
  ['outer target key', facts => { facts[0].targetKey = 'evidence:intent:other-operation'; }, 'fact_binding_mismatch'],
  ['outer epoch', facts => { facts[0].runtimeEpoch = 'other-operation'; }, 'fact_binding_mismatch'],
  ['outer evidence id', facts => { facts[0].actionId = 'another-evidence'; }, 'fact_binding_mismatch'],
  ['uncommitted evidence', facts => { facts[0].payload.persisted = false; }, 'invalid_evidence_record'],
  ['raw tree checksum', facts => { facts[0].payload.rawTree = '<hierarchy />'; }, 'record_checksum_mismatch'],
  ['duplicate sequence', facts => { facts[1].globalSeq = facts[0].globalSeq; }, 'invalid_record_sequence'],
  ['reversed sequence', facts => { [facts[0], facts[1]] = [facts[1], facts[0]]; }, 'invalid_record_sequence'],
  ['zero sequence', facts => { facts[0].globalSeq = 0; }, 'invalid_record_sequence'],
  ['fractional sequence', facts => { facts[0].globalSeq = 0.5; }, 'invalid_record_sequence'],
  ['duplicate evidence id', facts => { facts[1] = { ...clone(facts[0]), globalSeq: 2 }; }, 'duplicate_evidence_id'],
]) {
  test(`rejects ${label} without publishing an archive`, async t => {
    const { outputDir } = fixture(t);
    const facts = intentFacts();
    change(facts);
    const store = fakeStore(facts, { namespace: 'intent' });
    const result = await handle({ operation: 'export', namespace: 'intent', operationId: OPERATION, outputDir }, { getFactStore: () => store });
    assert.equal(result.ok, false);
    assert.equal(result.error, error, JSON.stringify(result));
    assert.equal(fs.existsSync(outputDir), false);
  });
}

test('rejects a fact above the frozen source high watermark', async t => {
  const { outputDir } = fixture(t);
  const { result } = await exportFacts(outputDir, intentFacts(), { status: { sequences: { nextGlobalSeq: 4 } } });
  assert.equal(result.error, 'invalid_record_sequence');
  assert.equal(fs.existsSync(outputDir), false);
});

test('requires a numeric source high watermark without coercion', async t => {
  const { outputDir } = fixture(t);
  const { result } = await exportFacts(outputDir, intentFacts(), { status: { sequences: { nextGlobalSeq: '6' } } });
  assert.equal(result.error, 'invalid_store_snapshot');
  assert.equal(fs.existsSync(outputDir), false);
});

for (const field of ['storeId', 'watermark']) {
  test(`rejects a changed ${field} at the end of export`, async t => {
    const { outputDir } = fixture(t);
    const { result } = await exportFacts(outputDir, intentFacts(), {
      statusAt: (call, status) => call === 1 ? status : field === 'storeId'
        ? { ...status, storeId: 'new-store' } : { ...status, sequences: { nextGlobalSeq: 9 } },
    });
    assert.equal(result.error, 'store_changed_during_export');
    assert.equal(fs.existsSync(outputDir), false);
  });
}

for (const status of [{ authoritative: false }, { persistence: false }, { ok: false }]) {
  test(`rejects an unavailable source ${JSON.stringify(status)}`, async t => {
    const { outputDir } = fixture(t);
    const { result } = await exportFacts(outputDir, intentFacts(), { status });
    assert.equal(result.error, 'fact_store_unavailable');
    assert.equal(fs.existsSync(outputDir), false);
  });
}

test('does not turn an unknown operation into an empty successful archive', async t => {
  const { outputDir } = fixture(t);
  const { result } = await exportFacts(outputDir, []);
  assert.equal(result.error, 'operation_not_found');
  assert.equal(fs.existsSync(outputDir), false);
});

for (const [label, response, error] of [
  ['read error', { ok: false, error: 'reader_failed' }, 'fact_store_read_failed'],
  ['expired cursor', { ok: true, gap: true, cursorExpired: true, items: [], hasMore: false }, 'evidence_gap'],
  ['missing coverage', { ok: true, items: [], hasMore: false }, 'evidence_gap'],
  ['invalid items', { ok: true, gap: false, cursorExpired: false, items: {}, hasMore: false }, 'invalid_store_page'],
]) {
  test(`fails closed on ${label}`, async t => {
    const { outputDir } = fixture(t);
    const { result } = await exportFacts(outputDir, intentFacts(), { read: () => response });
    assert.equal(result.error, error);
    assert.equal(fs.existsSync(outputDir), false);
  });
}

test('fails closed when a later page cannot be read', async t => {
  const { outputDir } = fixture(t);
  const facts = intentFacts();
  const { result, store } = await exportFacts(outputDir, facts, { read: (_query, call) => call === 1
    ? { ok: true, gap: false, cursorExpired: false, items: facts.slice(0, 2), hasMore: true, cursor: 'page:2' }
    : { ok: false, error: 'cursor_expired' } });
  assert.equal(store.calls.length, 2);
  assert.equal(result.error, 'fact_store_read_failed');
  assert.equal(result.detail, 'cursor_expired');
  assert.equal(fs.existsSync(outputDir), false);
});

for (const [label, cursor, items] of [['missing', undefined, true], ['empty', '', true], ['empty page', 'page:1', false]]) {
  test(`rejects a ${label} continuation cursor`, async t => {
    const { outputDir } = fixture(t);
    const facts = intentFacts();
    const { result, store } = await exportFacts(outputDir, facts, { read: (_query, call) => call === 1
      ? { ok: true, gap: false, cursorExpired: false, items: items ? facts.slice(0, 1) : [], hasMore: true, cursor }
      : { ok: false, error: 'unexpected_second_read' } });
    assert.equal(result.error, 'invalid_store_cursor', JSON.stringify(result));
    assert.equal(store.calls.length, 1);
    assert.equal(fs.existsSync(outputDir), false);
  });
}

test('rejects a repeating continuation cursor', async t => {
  const { outputDir } = fixture(t);
  const facts = intentFacts();
  const { result, store } = await exportFacts(outputDir, facts, { read: (_query, call) => ({
    ok: true, gap: false, cursorExpired: false, items: [facts[call - 1]], hasMore: true, cursor: 'stuck',
  }) });
  assert.equal(result.error, 'invalid_store_cursor');
  assert.equal(store.calls.length, 2);
  assert.equal(fs.existsSync(outputDir), false);
});

test('rejects more than 10000 retained records without partial output', async t => {
  const { outputDir } = fixture(t);
  const facts = Array.from({ length: 10001 }, (_, index) => fact('script', 'checkpoint', {
    stepId: `step-${index}`, target: TARGET,
  }, index + 1));
  const { result } = await exportFacts(outputDir, facts);
  assert.equal(result.error, 'archive_limit_exceeded');
  assert.equal(fs.existsSync(outputDir), false);
});

test('does not replace an existing output directory or read the source store', async t => {
  const { outputDir } = fixture(t);
  fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, 'keep.txt'), 'original');
  const result = await handle({ operation: 'export', namespace: 'intent', operationId: OPERATION, outputDir }, {
    getFactStore() { assert.fail('existing output must be rejected before source access'); },
  });
  assert.equal(result.error, 'output_exists');
  assert.equal(fs.readFileSync(path.join(outputDir, 'keep.txt'), 'utf8'), 'original');
});

test('reports missing internal references as partial while preserving the records', async t => {
  const { outputDir } = fixture(t);
  const facts = intentFacts().filter(item => item.payload.kind !== 'observation');
  const { result } = await exportFacts(outputDir, facts);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.coverage.referenceClosure, 'partial');
  for (const field of ['rawTreeId', 'basedOnEvidenceIds', 'parentFactId']) {
    assert(result.coverage.missingReferences.some(item => item.field === field));
  }
  assert.equal((await verify(outputDir, result.manifestSha256)).ok, true);
});

test('an observation with no persisted summary is explicitly partial', async t => {
  const { outputDir } = fixture(t);
  const { result } = await exportFacts(outputDir, intentFacts().filter(item => item.payload.kind !== 'summary'));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.coverage.referenceClosure, 'partial');
  assert(result.coverage.missingReferences.some(item => item.field === 'summary'));
});

test('a Script receipt whose dispatch marker is missing is explicitly partial', async t => {
  const { outputDir } = fixture(t);
  const { result } = await exportFacts(outputDir, scriptFacts().filter(item => item.payload.kind !== 'dispatch-marker'));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.coverage.referenceClosure, 'partial');
  assert(result.coverage.missingReferences.some(item => item.field === 'actionId'));
});

test('allows a routed Intent observation of a system package without rewriting its owner', async t => {
  const { outputDir } = fixture(t);
  const { result } = await exportFacts(outputDir, intentFacts({ systemRoute: true }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert(result.targets.some(item => item.role === 'owner' && item.value.packageName === APP));
  assert(result.targets.some(item => item.role === 'observed' && item.value.packageName === 'com.android.documentsui'));
  assert(result.targets.some(item => item.role === 'foreground'
    && item.value.packageName === 'com.android.documentsui' && item.value.provider === 'uia'));
  assert.equal(result.targets.some(item => item.role === 'dispatch'), false,
    'an Intent marker context target is not proof of the actual foreground dispatch target');
  assert.equal((await verify(outputDir, result.manifestSha256)).ok, true);
});

test('preserves a Script system package dispatch target separately from the owning App', async t => {
  const { outputDir } = fixture(t);
  const { result } = await exportFacts(outputDir, scriptFacts({ dispatchTarget: { serial: SERIAL, packageName: 'com.android.documentsui' } }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert(result.targets.some(item => item.role === 'owner' && item.value.packageName === APP));
  assert(result.targets.some(item => item.role === 'dispatch' && item.value.packageName === 'com.android.documentsui'));
  assert.equal((await verify(outputDir, result.manifestSha256)).ok, true);
});

test('preserves an explicit Script serial override supported by the current Host contract', async t => {
  const { outputDir } = fixture(t);
  const dispatchTarget = { serial: 'phone-two', packageName: APP };
  const { result } = await exportFacts(outputDir, scriptFacts({ dispatchTarget }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert(result.targets.some(item => item.role === 'owner' && item.value.serial === SERIAL));
  assert(result.targets.some(item => item.role === 'dispatch' && item.value.serial === 'phone-two'));
  const records = JSON.parse(fs.readFileSync(path.join(outputDir, 'records.json')));
  assert.deepEqual(records.find(item => item.payload.kind === 'dispatch-marker').payload.target, dispatchTarget);
  assert.equal((await verify(outputDir, result.manifestSha256)).ok, true);
});

test('external phone capture refs remain references and do not become included payloads', async t => {
  const { outputDir } = fixture(t);
  const ref = { targetKey: APP, runtimeEpoch: 'phone-epoch', globalSeq: 99, partition: 'network' };
  const facts = scriptFacts({ receiptFields: { evidenceRefs: [ref, 'screenshot:/not-readable-by-export.png'] } });
  const { result } = await exportFacts(outputDir, facts);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.coverage.externalPayloads, 'not-included');
  assert.equal(result.coverage.externalReferences.length, 2);
  assert.deepEqual(result.coverage.externalReferences[0].ref, ref);
  assert.deepEqual(fs.readdirSync(outputDir).sort(), ['manifest.json', 'records.json']);
  assert.equal((await verify(outputDir, result.manifestSha256)).ok, true);
});

for (const value of [undefined, '', 'a'.repeat(63), 'G'.repeat(64)]) {
  test(`offline verification requires a frozen manifest digest (${String(value)})`, async t => {
    const { outputDir } = fixture(t);
    const { result } = await exportFacts(outputDir, intentFacts());
    assert.equal(result.ok, true);
    const checked = await verify(outputDir, value);
    assert.equal(checked.error, 'invalid_argument');
    assert.equal(checked.field, 'manifestSha256');
  });
}

test('rejects changed manifest bytes even when the changed manifest is valid JSON', async t => {
  const { outputDir } = fixture(t);
  const { result } = await exportFacts(outputDir, intentFacts());
  rewriteManifest(outputDir, manifest => { manifest.operationId = 'replacement-operation'; });
  assert.equal((await verify(outputDir, result.manifestSha256)).error, 'manifest_checksum_mismatch');
});

test('rejects changed records using the original frozen manifest', async t => {
  const { outputDir } = fixture(t);
  const { result } = await exportFacts(outputDir, intentFacts());
  fs.appendFileSync(path.join(outputDir, 'records.json'), ' ');
  assert.equal((await verify(outputDir, result.manifestSha256)).error, 'records_checksum_mismatch');
});

test('verifies envelope checksums independently of a newly frozen file manifest', async t => {
  const { outputDir } = fixture(t);
  await exportFacts(outputDir, intentFacts());
  const root = replaceRecords(outputDir, records => { records[0].payload.rawTree = 'changed raw tree'; });
  assert.equal((await verify(outputDir, root)).error, 'record_checksum_mismatch');
});

for (const [field, value] of [['recordCount', 999], ['targets', []], ['coverage', { businessVerdict: 'passed' }]]) {
  test(`recomputes manifest ${field} instead of trusting its declared analysis`, async t => {
    const { outputDir } = fixture(t);
    await exportFacts(outputDir, intentFacts());
    const root = rewriteManifest(outputDir, manifest => { manifest[field] = value; });
    const checked = await verify(outputDir, root);
    assert.equal(checked.error, 'manifest_analysis_mismatch');
    assert.equal(checked.detail, field);
  });
}

test('rejects an unsupported archive schema with a matching frozen root', async t => {
  const { outputDir } = fixture(t);
  await exportFacts(outputDir, intentFacts());
  const root = rewriteManifest(outputDir, manifest => { manifest.schemaVersion = 'aab.evidence-archive/v999'; });
  assert.equal((await verify(outputDir, root)).error, 'unsupported_archive_schema');
});

test('rejects a manifest that requests records outside the archive directory', async t => {
  const { outputDir } = fixture(t);
  await exportFacts(outputDir, intentFacts());
  const root = rewriteManifest(outputDir, manifest => { manifest.records.path = '../outside.json'; });
  assert.equal((await verify(outputDir, root)).error, 'invalid_archive_path');
});

for (const name of ['manifest.json', 'records.json']) {
  test(`rejects a symlink in place of ${name}`, async t => {
    const { root, outputDir } = fixture(t);
    const { result } = await exportFacts(outputDir, intentFacts());
    const outside = path.join(root, name);
    fs.renameSync(path.join(outputDir, name), outside);
    fs.symlinkSync(outside, path.join(outputDir, name));
    assert.equal((await verify(outputDir, result.manifestSha256)).error, 'invalid_archive_file');
  });
}

test('rejects a symlink used as the archive directory', async t => {
  const { root, outputDir } = fixture(t);
  const { result } = await exportFacts(outputDir, intentFacts());
  const link = path.join(root, 'archive-link');
  fs.symlinkSync(outputDir, link);
  assert.equal((await verify(link, result.manifestSha256)).error, 'invalid_archive_directory');
});

test('rejects an oversized records file before reading its content', async t => {
  const { outputDir } = fixture(t);
  const { result } = await exportFacts(outputDir, intentFacts());
  fs.truncateSync(path.join(outputDir, 'records.json'), 128 * 1024 * 1024 + 1);
  assert.equal((await verify(outputDir, result.manifestSha256)).error, 'archive_limit_exceeded');
});

for (const name of ['manifest.json', 'records.json']) {
  test(`returns an explicit failure when ${name} is missing`, async t => {
    const { outputDir } = fixture(t);
    const { result } = await exportFacts(outputDir, intentFacts());
    fs.unlinkSync(path.join(outputDir, name));
    const checked = await verify(outputDir, result.manifestSha256);
    assert.equal(checked.ok, false);
    assert.equal(checked.error, 'ENOENT');
  });
}

test('a matching root hash cannot make malformed manifest JSON verifiable', async t => {
  const { outputDir } = fixture(t);
  await exportFacts(outputDir, intentFacts());
  const bytes = Buffer.from('{"schemaVersion":');
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), bytes);
  const checked = await verify(outputDir, digest(bytes));
  assert.equal(checked.ok, false);
  assert.equal(checked.error, 'archive_failed');
});

for (const [label, change] of [
  ['future basedOnEvidenceIds', facts => {
    facts[2] = changedFact(facts[2], { basedOnEvidenceIds: [facts[4].payload.evidenceId] });
  }],
  ['future parentFactId', facts => {
    facts[1] = changedFact(facts[1], { parentFactId: facts[2].payload.evidenceId });
  }],
  ['summary observation revision mismatch', facts => {
    facts[1] = changedFact(facts[1], { revision: 2 });
  }],
  ['summary before its observation', facts => {
    facts[0].globalSeq = 2; facts[1].globalSeq = 1; facts.sort((a, b) => a.globalSeq - b.globalSeq);
  }],
  ['receipt before its dispatch marker', facts => {
    facts[3].globalSeq = 5; facts[4].globalSeq = 4; facts.sort((a, b) => a.globalSeq - b.globalSeq);
  }],
  ['receipt package differs from its marker', facts => {
    facts[4] = changedFact(facts[4], { target: { ...TARGET, packageName: 'example.other' } });
  }],
  ['receipt serial differs from its marker', facts => {
    facts[4] = changedFact(facts[4], { target: { ...TARGET, serial: 'phone-two' } });
  }],
  ['marker before its decision', facts => {
    facts[2].globalSeq = 4; facts[3].globalSeq = 3; facts.sort((a, b) => a.globalSeq - b.globalSeq);
  }],
  ['marker decision revision mismatch', facts => {
    facts[3] = changedFact(facts[3], { revision: 2 });
  }],
  ['marker decision action hash mismatch', facts => {
    facts[3] = changedFact(facts[3], { actionSpecHash: 'different-action' });
  }],
]) {
  test(`rejects ${label} even when every envelope checksum is valid`, async t => {
    const { outputDir } = fixture(t);
    const facts = intentFacts();
    change(facts);
    const { result } = await exportFacts(outputDir, facts);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid_reference_binding', JSON.stringify(result));
    assert.equal(fs.existsSync(outputDir), false);
  });
}

for (const [label, index] of [['rawTreeId', 0], ['decisionId', 2], ['marker actionId', 3]]) {
  test(`rejects ambiguous duplicate ${label} with distinct evidence ids`, async t => {
    const { outputDir } = fixture(t);
    const facts = intentFacts();
    const { namespace, kind, checksum, persisted, committedAtMs, evidenceId, ...fields } = facts[index].payload;
    facts.push(fact(namespace, kind, fields, 6));
    const { result } = await exportFacts(outputDir, facts);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'ambiguous_evidence_reference', JSON.stringify(result));
    assert.equal(fs.existsSync(outputDir), false);
  });
}

test('compares receipt and marker targets canonically without depending on property order', async t => {
  const { outputDir } = fixture(t);
  const facts = intentFacts();
  facts[4] = changedFact(facts[4], { target: { packageName: APP, serial: SERIAL } });
  const { result } = await exportFacts(outputDir, facts);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.coverage.referenceClosure, 'complete');
  assert.equal((await verify(outputDir, result.manifestSha256)).ok, true);
});

test('a foreign operation reference is reported missing rather than resolved from the surrounding store', async t => {
  const { outputDir } = fixture(t);
  const facts = intentFacts();
  const otherEvidence = 'intent:observation:other-operation:1';
  facts[2] = changedFact(facts[2], { basedOnEvidenceIds: [otherEvidence] });
  const { result } = await exportFacts(outputDir, facts);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.coverage.referenceClosure, 'partial');
  assert(result.coverage.missingReferences.some(item => item.field === 'basedOnEvidenceIds' && item.value === otherEvidence));
  assert.equal((await verify(outputDir, result.manifestSha256)).ok, true);
});
