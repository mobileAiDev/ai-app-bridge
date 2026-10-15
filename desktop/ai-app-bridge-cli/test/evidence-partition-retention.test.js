'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CLI = path.resolve(__dirname, '..');
const { FactStore } = require(CLI + '/bin/fact-store');
const { SegmentedFactStoreAdapter, PARTITIONS } = require(CLI + '/bin/segmented-fact-store');
const { createSegmentedEvidenceAdapter } = require(CLI + '/bin/shared-kernel/evidence-adapters');
const { createScriptEvidenceStore } = require(CLI + '/bin/script/script-evidence-store');
const { buildEnvelope } = require(CLI + '/bin/shared-kernel/evidence-schema');
const { readScriptInventory } = require(CLI + '/bin/script/script-inventory');
const { readScriptRecovery } = require(CLI + '/bin/script/script-recovery-view');
const archive = require(CLI + '/bin/shared-kernel/evidence-archive');
const OPERATION = 'retained-operation';
const TARGET = { platform: 'android', serial: 'fixture-only', packageName: 'fixture.only' };

function fixture(t, { smallPartition = 'network' } = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-partition-retention-')));
  const adapter = new SegmentedFactStoreAdapter({ directory, profile: '64mb', segmentSize: 4096,
    budgetBytes: 8 * 1024 * 1024,
    partitionQuotas: PARTITIONS.map(p => p !== smallPartition && ['action', 'ui'].includes(p) ? 2 * 1024 * 1024 : 8192) });
  const factStore = new FactStore(adapter);
  const store = createScriptEvidenceStore({ adapter: createSegmentedEvidenceAdapter(factStore) });
  t.after(() => { factStore.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let serial = 0;
  function append(kind, fields = {}, operationId = OPERATION) {
    serial += 1;
    const built = buildEnvelope('script', kind, { operationId, revision: serial,
      evidenceId: 'evidence-' + serial, ...fields }, { sequence: serial, now: () => 1700000000000 + serial });
    assert.equal(built.ok, true, JSON.stringify(built));
    const envelope = built.envelope;
    const receipt = adapter.record({ partition: ['observation', 'summary'].includes(kind) ? 'ui' : 'action',
      targetKey: `evidence:script:${operationId}`, app: { platform: 'host', packageName: 'script' },
      runtimeEpoch: operationId, actionId: envelope.evidenceId,
      timestamps: { occurredAtMs: envelope.committedAtMs, observedAtMs: envelope.committedAtMs }, payload: envelope },
    { durability: 'memory' });
    assert.equal(receipt.ok, true);
    return { envelope, sequence: receipt.globalSeq };
  }
  function seed({ mixed = true, partition = 'action' } = {}) {
    const rows = [];
    for (let i = 0; i < 1001; i += 1) {
      if ((mixed && i % 3 === 0) || (!mixed && partition === 'ui')) {
        rows.push(append('observation', { target: TARGET, provider: 'native', capturedAtMs: 1000 + i,
          rawTreeId: 'tree-' + i, rawTree: { text: i === 0 ? 'x'.repeat(20000) : 'row-' + i } }));
      } else if (mixed && i % 3 === 1) {
        rows.push(append('summary', { revision: i, rawTreeId: 'tree-' + (i - 1) }));
      } else rows.push(append('checkpoint', { stepId: 'step-' + i, status: 'running' }));
    }
    return rows;
  }
  function evict(partition = smallPartition) {
    for (let i = 0; i < 20; i += 1) {
      if (partition === 'ui') append('observation', { target: TARGET, provider: 'native',
        capturedAtMs: 2000 + i, rawTree: { text: 'x'.repeat(1500) } }, 'other-observations');
      else if (partition === 'action') append('checkpoint', { stepId: 'noise-' + i,
        status: 'running', detail: 'x'.repeat(1500) }, 'other-actions');
      else adapter.record({ partition, targetKey: 'unrelated-noise', app: { platform: 'host', packageName: 'noise' },
        runtimeEpoch: 'noise', actionId: 'noise-' + i,
        timestamps: { occurredAtMs: 1800000000000 + i, observedAtMs: 1800000000000 + i },
        payload: { text: 'x'.repeat(1500) } }, { durability: 'memory' });
    }
    assert(adapter.status().quota.partitions[partition].evictedRecords > 0);
  }
  const outputDir = path.join(directory, 'exported');
  const exportEvidence = () => archive.handle({ operation: 'export', namespace: 'script',
    operationId: OPERATION, outputDir }, { getFactStore: () => factStore });
  return { directory, adapter, factStore, store, append, seed, evict, outputDir, exportEvidence };
}

test('retained evidence crosses pages and large-fact chunks despite unrelated network eviction', async t => {
  const h = fixture(t); const expected = h.seed(); h.evict();
  assert.equal(h.adapter.status().quota.partitions.action.evictedRecords, 0);
  assert.equal(h.adapter.status().quota.partitions.ui.evictedRecords, 0);
  const global = h.factStore.read({ limit: 1000 });
  assert.equal(global.ok, true); assert.equal(global.hasMore, true);
  assert.equal(h.factStore.read({ cursor: global.cursor, limit: 1000 }).error, 'cursor_expired');
  const rows = h.store.list();
  assert.deepEqual(rows.map(r => r.evidenceId), expected.map(r => r.envelope.evidenceId));
  assert.deepEqual(rows[0].rawTree, expected[0].envelope.rawTree);
  assert.deepEqual(h.store.list(OPERATION), rows);
  assert.deepEqual(h.store.read(expected[0].envelope.evidenceId).record, expected[0].envelope);
  const inventory = readScriptInventory({ store: h.store, view: 'attention', limit: 100 });
  assert.equal(inventory.ok, true, JSON.stringify(inventory));
  assert.deepEqual(inventory.items.map(r => r.operationId), [OPERATION]);
  assert.equal(inventory.throughId, expected.at(-1).envelope.evidenceId);
  assert.equal(inventory.coverage.completeHistory, false);
  const recovery = readScriptRecovery({ store: h.store, operationId: OPERATION });
  assert.equal(recovery.ok, true, JSON.stringify(recovery));
  const exported = await h.exportEvidence();
  assert.equal(exported.ok, true, JSON.stringify(exported)); assert.equal(exported.recordCount, 1001);
  const archiveRows = JSON.parse(fs.readFileSync(path.join(h.outputDir, 'records.json')));
  assert.deepEqual(archiveRows.map(r => r.globalSeq), expected.map(r => r.sequence));
  assert.deepEqual(archiveRows.map(r => r.payload), rows);
  assert.equal(exported.coverage.priorHistoryComplete, 'unknown');
  assert.equal((await archive.handle({ operation: 'verify', archiveDir: h.outputDir,
    manifestSha256: exported.manifestSha256 })).ok, true);
});

test('unrelated partition eviction between internal pages does not invalidate selected evidence', t => {
  const h = fixture(t); const expected = h.seed(); const read = h.adapter.read.bind(h.adapter); let injected = false;
  h.adapter.read = query => {
    if (query.cursor && !injected) { injected = true; h.evict(); }
    return read(query);
  };
  const rows = h.store.list(OPERATION);
  assert.equal(injected, true); assert.deepEqual(rows.map(r => r.evidenceId), expected.map(r => r.envelope.evidenceId));
});

for (const partition of ['ui', 'action']) test(`selected ${partition} eviction between internal pages remains an explicit failure`, async t => {
  const h = fixture(t, { smallPartition: partition });
  h.seed({ mixed: false, partition: partition === 'ui' ? 'action' : 'ui' });
  const read = h.adapter.read.bind(h.adapter); let injected = false;
  h.adapter.read = query => {
    if (query.cursor && !injected) { injected = true; h.evict(partition); }
    return read(query);
  };
  const inventory = readScriptInventory({ store: h.store, view: 'attention', limit: 100 });
  assert.equal(injected, true); assert.equal(inventory.ok, false);
  assert.equal(inventory.error, 'evidence_read_failed'); assert.equal(inventory.message, 'cursor_expired');
  const exported = await h.exportEvidence();
  assert.equal(exported.ok, false); assert.equal(exported.error, 'fact_store_read_failed');
  assert.equal(exported.detail, 'cursor_expired'); assert.equal(fs.existsSync(h.outputDir), false);
});

test('archive still rejects global snapshot changes during scoped evidence traversal', async t => {
  const h = fixture(t); h.seed(); const read = h.adapter.read.bind(h.adapter); let injected = false;
  h.adapter.read = query => {
    const result = read(query);
    if (!injected && result.hasMore) { injected = true; h.evict(); }
    return result;
  };
  const exported = await h.exportEvidence();
  assert.equal(injected, true); assert.equal(exported.ok, false);
  assert.equal(exported.error, 'store_changed_during_export'); assert.equal(fs.existsSync(h.outputDir), false);
});

test('evidence partition selection does not relax cursor scope signatures', t => {
  const h = fixture(t); h.seed();
  const first = h.factStore.read({ partitions: ['action', 'ui'], limit: 1 });
  assert.equal(first.ok, true); assert.equal(first.hasMore, true);
  assert.equal(h.factStore.read({ partitions: ['action'], cursor: first.cursor }).error, 'invalid_cursor');
  assert.equal(h.factStore.read({ cursor: first.cursor }).error, 'invalid_cursor');
});
