'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createFactStore } = require('../bin/fact-store');
const { createMemoryEvidenceAdapter, createFileEvidenceAdapter, createSegmentedEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createIntentWorker } = require('../bin/intent/intent-worker');
const { buildEnvelope, checksumOf, verifyChecksum } = require('../bin/shared-kernel/evidence-schema');
const { createHash } = require('node:crypto');

const target = { platform: 'android', serial: 'checksum-host-only', packageName: 'example.checksum' };
function observation(operationId, extra = {}) {
  return { operationId, revision: 1, target, provider: 'native', capturedAtMs: 1,
    foregroundTarget: target.packageName, rawTreeId: `${operationId}:1`, rawTree: { root: { text: 'Home' } }, ...extra };
}
function nativeStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-evidence-checksum-'));
  let facts = createFactStore({ directory, profile: '64mb' });
  t.after(() => { facts.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const evidence = () => createIntentEvidenceStore({ adapter: createSegmentedEvidenceAdapter(facts) });
  return { store: evidence(), reopen() { facts.close(); facts = createFactStore({ directory, profile: '64mb' }); return evidence(); } };
}

test('the native FactStore preserves hashed original receipt bytes through write, close and reopen', async t => {
  const durable = nativeStore(t);
  const receiptJson = String.raw`{"actionId":"intent:\u8282\u70b9","resourceName":"sample:id\/next","settled":true}`;
  const digest = raw => createHash('sha256').update(raw).digest('hex');
  const executionReceipt = { kind: 'uia-node', settled: true, receiptJson, responseSha256: digest(receiptJson) };
  const saved = await durable.store.persist('checkpoint', { operationId: 'uia-original-bytes', revision: 1, target, stepId: 'original-receipt',
    payloadSummary: { executionReceipt } });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const reopened = durable.reopen().read(saved.evidenceId);
  assert.equal(reopened.ok, true);
  assert.deepEqual(reopened.record.payloadSummary.executionReceipt, executionReceipt);
  assert.equal(digest(reopened.record.payloadSummary.executionReceipt.receiptJson), executionReceipt.responseSha256);
});

test('Intent transient unavailable capture commits through native FactStore without a checksum block', async (t) => {
  const durable = nativeStore(t);
  const worker = createIntentWorker({
    operationId: 'transient-capture', target, store: durable.store,
    adapter: { observe: async ({ rawTreeId }) => ({ ok: true, rawTreeId, foregroundTarget: target.packageName, rawTree: { root: { text: 'Home' } } }) },
    captureRequirements: { streams: ['events'] },
    // Real restart failure shape: window is absent; epoch metadata is explicitly null.
    capturePort: { observe: async () => ({
      coverage: { status: 'unavailable', gap: false, committed: false }, refs: [], items: [],
      runtimeEpoch: null, targetKey: null, storeGeneration: null, watermarkCursor: null,
      nextCursor: null, hasMore: false, throughWatermark: null,
    }) },
  });
  const result = await worker.start();
  assert.equal(result.status, 'waiting_for_decision', JSON.stringify(result));
  assert.equal(result.actionSteps, 0);
  const read = durable.store.read(result.evidenceId);
  assert.equal(read.ok, true);
  assert.equal(read.record.captureCoverage.status, 'unavailable', 'unavailable capture never becomes complete');
  const reopened = durable.reopen();
  assert.equal(reopened.read(result.evidenceId).ok, true);
  assert.equal(reopened.canExposeRevision('transient-capture').ok, true);
});

test('native FactStore keeps checksums for actual Intent receipts with absent resolved and matched fields', async (t) => {
  const durable = nativeStore(t);
  const worker = createIntentWorker({
    operationId: 'receipt-normalization', target, store: durable.store,
    adapter: {
      observe: async ({ rawTreeId }) => ({ ok: true, rawTreeId, foregroundTarget: target.packageName, rawTree: { root: { text: 'Home' } } }),
      action: async () => ({ ok: true, mechanicalStatus: 'ok' }),
    },
  });
  const start = await worker.start();
  assert.equal(start.status, 'waiting_for_decision');
  const result = await worker.decide({ decisionId: 'd1', agentDecision: 'act', basedOnRevision: start.revision, action: { action: 'tap', selector: { text: 'Home' } } });
  assert.equal(result.status, 'waiting_for_decision');
  const receipt = durable.store.latest('receipt-normalization', 'action-receipt');
  assert.equal(durable.store.read(receipt.evidenceId).ok, true);
  assert.equal(durable.reopen().read(receipt.evidenceId).ok, true);
});

test('evidence checksums cover the redacted durable representation before commit and offer', async (t) => {
  const durable = nativeStore(t);
  const fileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-evidence-json-'));
  t.after(() => fs.rmSync(fileDirectory, { recursive: true, force: true }));
  const stores = [durable.store,
    createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() }),
    createIntentEvidenceStore({ adapter: createFileEvidenceAdapter({ dir: fileDirectory }) }),
  ];
  for (let i = 0; i < stores.length; i += 1) {
    const record = observation(`sanitized-${i}`, { rawTree: {
      root: { text: 'Home', token: 'test-secret-token', absent: undefined, invalidNumber: NaN },
      nestedJson: '{ "password": "test-secret-password" }',
      authorization: 'Bearer test-secret-bearer',
    } });
    const receipt = i === 1 ? await stores[i].offer('observation', record).completion : await stores[i].persist('observation', record);
    assert.equal(receipt.ok, true);
    const read = stores[i].read(receipt.evidenceId);
    assert.equal(read.ok, true);
    assert.equal(read.record.checksum, receipt.checksum);
    assert.equal(read.record.rawTree.root.token, '[REDACTED]');
    assert.equal(read.record.rawTree.root.invalidNumber, null);
    assert.equal(JSON.stringify(read.record).includes('test-secret'), false);
    assert.equal(record.rawTree.root.token, 'test-secret-token', 'normalization never mutates caller data');
  }
});

test('async evidence offer freezes caller-owned nested values before the writer runs', async () => {
  const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const record = observation('detached');
  const offered = store.offer('observation', record);
  record.rawTree.root.text = 'mutated after offer';
  const receipt = await offered.completion;
  const read = store.read(receipt.evidenceId);
  assert.equal(read.ok, true);
  assert.equal(read.record.rawTree.root.text, 'Home');
});

test('unchanged legacy evidence hashes remain valid and mismatched legacy records stay rejected', () => {
  const body = { ...observation('legacy'), namespace: 'intent', kind: 'observation', evidenceId: 'intent:observation:legacy:1:1', committedAtMs: 2 };
  const legacy = { ...body, checksum: checksumOf(body), persisted: true };
  const built = buildEnvelope('intent', 'observation', observation('legacy'), { now: () => 2, sequence: 1 });
  assert.equal(built.envelope.schemaVersion, 'aab.execution-evidence/v1');
  assert.equal(verifyChecksum(built.envelope).ok, true);
  assert.notEqual(built.envelope.checksum, legacy.checksum);
  assert.equal(verifyChecksum(legacy).ok, true);
  const oldMismatch = { ...legacy, optionalField: null };
  const bytesBefore = JSON.stringify(oldMismatch);
  assert.deepEqual(verifyChecksum(oldMismatch), { ok: false, error: 'checksum_mismatch' });
  assert.equal(JSON.stringify(oldMismatch), bytesBefore, 'old records are not repaired or rewritten during verification');
});
