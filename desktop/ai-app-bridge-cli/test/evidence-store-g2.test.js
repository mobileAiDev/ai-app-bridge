'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { FactStore, createFactStore } = require('../bin/fact-store');
const { FactRecorder } = require('../bin/fact-recorder');
const {
  createLegacyFactStoreAdapter,
  createMemoryEvidenceAdapter,
  createSegmentedEvidenceAdapter,
} = require('../bin/shared-kernel/evidence-adapters');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { runBatch, runBridgeChecked } = require('../bin/mcp-server');

function payloadOf(result) {
  return JSON.parse(result.content[0].text);
}

function observation(operationId, extras = {}) {
  return {
    operationId,
    revision: extras.revision || 1,
    serial: 'b46093e6',
    packageName: 'com.example.app',
    provider: extras.provider || 'native',
    capturedAtMs: 1_700_000_000_000,
    foregroundTarget: 'com.example.app/.Main',
    rawTreeId: extras.rawTreeId || `${operationId}-tree-1`,
    ...extras,
  };
}

async function persistReadyAction(store, operationId) {
  const raw = await store.persist('observation', observation(operationId));
  const plan = await store.persist('plan', {
    operationId,
    revision: 1,
    planStepId: `${operationId}-step-1`,
    actionSpecHash: 'hash-1',
  });
  const marker = await store.persist('dispatch-marker', {
    actionId: `${operationId}-action-1`,
    operationId,
    planStepId: `${operationId}-step-1`,
    target: { serial: 'b46093e6', packageName: 'com.example.app' },
    actionSpecHash: 'hash-1',
    state: 'prepared',
  });
  return { raw, plan, marker };
}

async function legacyStillWorks() {
  const status = await runBridgeChecked('status', { serial: 'android-1' }, {
    rawRunner: async () => {
      throw new Error('status must not reach the runner without packageName or port');
    },
  });
  assert.equal(status.isError, true);
  assert.match(status.content[0].text, /status: packageName or explicit port is required in MCP mode/);
  const batch = payloadOf(await runBatch({ steps: [{ id: 's1', command: 'script' }] }));
  assert.equal(batch.error, 'unknown_batch_step_command');
}

test('G2 unified FactStore supports synchronous commit and bounded asynchronous offer', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const written = [];
  const store = new FactStore({
    record(fact) {
      if (fact.actionId === 'sync') {
        written.push(fact.actionId);
        return { ok: true, stored: true, globalSeq: written.length };
      }
      return gate.then(() => {
        written.push(fact.actionId);
        return { ok: true, stored: true, globalSeq: written.length };
      });
    },
    read() { return { ok: true, items: [], count: 0 }; },
    status() { return { ok: true, adapter: 'async-memory' }; },
    close() {},
  }, { queueLimit: 2 });

  assert.equal(store.record({ partition: 'action', actionId: 'sync' }).receipt.stored, true);
  const first = store.offer({ partition: 'app-log', actionId: 'async-1' });
  const second = store.offer({ partition: 'app-log', actionId: 'async-2' });
  const overflow = store.offer({ partition: 'app-log', actionId: 'async-3' });
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(overflow.accepted, false);
  assert.equal(overflow.reason, 'queue_full');
  assert.equal(store.status().writer.dropped, 1);
  release();
  await Promise.all([first.completion, second.completion]);
  assert.deepEqual(written, ['sync', 'async-1', 'async-2']);
  assert.equal(store.status().writer.queueLength, 0);
  await legacyStillWorks();
});

test('G2 Script and Intent EvidenceStores persist, read back, and verify checksums', async () => {
  const script = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const intent = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const written = await script.persist('observation', observation('script-op-1', { rawTree: { text: 'Hello' } }));
  assert.equal(written.ok, true);
  assert.equal(written.persisted, true);
  const read = script.read(written.evidenceId);
  assert.equal(read.ok, true);
  assert.equal(read.record.namespace, 'script');
  assert.equal(read.record.checksum, written.checksum);
  assert.equal(read.record.rawTree.text, 'Hello');

  const other = await intent.persist('observation', observation('intent-op-1'));
  assert.equal(script.read(other.evidenceId).error, 'not_found');
  assert.equal(intent.read(written.evidenceId).error, 'not_found');
});

test('G2 EvidenceStore exposes the same schema through durable commit and async offer', async () => {
  const facts = [];
  const factStore = new FactStore({
    record(fact, options) {
      facts.push({ fact, options });
      return { ok: true, stored: true, globalSeq: facts.length, durability: options.durability };
    },
    read(query) {
      const matches = facts
        .map((item, index) => ({ ...item.fact, globalSeq: index + 1 }))
        .filter((fact) => !query.actionId || fact.actionId === query.actionId);
      return { ok: true, items: matches.slice(0, query.limit), count: matches.length, hasMore: false };
    },
    status() { return { ok: true, adapter: 'memory' }; },
    close() {},
  });
  const script = createScriptEvidenceStore({ adapter: createSegmentedEvidenceAdapter(factStore) });

  const offered = script.offer('observation', observation('script-async'));
  assert.equal(offered.accepted, true);
  assert.equal((await offered.completion).persisted, true);
  assert.equal(script.read(offered.evidenceId).ok, true);
  assert.equal(facts[0].options.durability, 'sync');

  const unavailable = createIntentEvidenceStore({
    adapter: createMemoryEvidenceAdapter({ fault: 'enospc' }),
  });
  const failed = unavailable.offer('observation', observation('intent-async-failed'));
  assert.equal(failed.accepted, true);
  assert.deepEqual(await failed.completion, {
    ok: false,
    persisted: false,
    error: 'ENOSPC',
    detail: undefined,
  });
});

test('G2 namespace and operation state stay isolated, and missing gates block new actions', async () => {
  const shared = createMemoryEvidenceAdapter();
  const script = createScriptEvidenceStore({ adapter: shared });
  const intent = createIntentEvidenceStore({ adapter: shared });
  await script.persist('observation', observation('op-shared'));
  await intent.persist('observation', observation('op-shared'));
  assert.equal(script.list('op-shared').every((item) => item.namespace === 'script'), true);
  assert.equal(intent.list('op-shared').every((item) => item.namespace === 'intent'), true);
  assert.equal(script.canPrepareAction('op-shared').error, 'plan_or_decision_not_persisted');
  assert.equal(script.canDispatch('op-shared').error, 'plan_or_decision_not_persisted');

  const ready = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  assert.equal(ready.canExposeRevision('missing').error, 'evidence_not_persisted');
  await persistReadyAction(ready, 'script-ready');
  assert.equal(ready.canDispatch('script-ready').ok, true);

  const blocked = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter({ fault: 'enospc' }) });
  const failed = await blocked.persist('observation', observation('blocked-op'));
  assert.equal(failed.ok, false);
  assert.equal(failed.persisted, false);
  assert.equal(failed.error, 'ENOSPC');
  assert.equal(blocked.canDispatch('blocked-op').error, 'evidence_not_persisted');
});

test('G2 huge tree, serialize failure, and corrupt manifest have explicit results', async () => {
  const large = createScriptEvidenceStore({
    adapter: createMemoryEvidenceAdapter({ maxBytes: 2048 }),
    maxBytes: 2048,
  });
  const huge = await large.persist('observation', observation('huge-op', {
    rawTree: { nodes: Array.from({ length: 200 }, (_, index) => ({ id: index, text: 'n'.repeat(40) })) },
  }));
  assert.equal(huge.ok, false);
  assert.equal(huge.error, 'payload_too_large');

  const circular = { operationId: 'circ-op', revision: 1, serial: 'b46093e6', packageName: 'com.example.app', provider: 'native', capturedAtMs: 1 };
  circular.self = circular;
  const serialized = await large.persist('observation', circular);
  assert.equal(serialized.ok, false);
  assert.equal(serialized.error, 'serialize_failed');

  const corrupt = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter({ fault: 'corrupt_manifest' }) });
  const written = await corrupt.persist('observation', observation('corrupt-op'));
  assert.equal(written.ok, true);
  assert.equal(corrupt.read(written.evidenceId).error, 'checksum_mismatch');
  assert.equal(corrupt.status().error, 'corrupt_manifest');
  assert.equal(corrupt.canExposeRevision('corrupt-op').error, 'checksum_mismatch');
});

test('G2 segmented production adapter persists and reads an evidence id', async (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g2-evidence-')));
  const store = createFactStore({
    directory,
    profile: '64mb',
    budgetBytes: 4096 * 24,
    segmentSize: 4096,
    partitionQuotas: Array(8).fill(4096 * 2),
  });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const script = createScriptEvidenceStore({
    adapter: createSegmentedEvidenceAdapter(store),
  });
  const written = await script.persist('observation', observation('seg-op', { rawTree: { text: 'segmented' } }));
  assert.equal(written.ok, true);
  const read = script.read(written.evidenceId);
  assert.equal(read.ok, true);
  assert.equal(read.record.rawTree.text, 'segmented');
  assert.equal(read.record.checksum, written.checksum);
});

test('G2 segmented evidence adapter paginates beyond 1000 records and does not close a shared store', () => {
  const records = Array.from({ length: 1_005 }, (_, index) => ({
    payload: {
      namespace: 'script',
      operationId: 'many-records',
      evidenceId: `script:checkpoint:many-records:${index}`,
    },
  }));
  let closeCount = 0;
  const factStore = {
    record() { return { ok: true, receipt: { ok: true, stored: true, globalSeq: 1 } }; },
    read({ cursor, limit }) {
      const offset = cursor ? Number(cursor) : 0;
      const items = records.slice(offset, offset + limit);
      const next = offset + items.length;
      return {
        ok: true,
        items,
        count: items.length,
        cursor: String(next),
        hasMore: next < records.length,
      };
    },
    status() { return { ok: true }; },
    close() { closeCount += 1; },
  };

  const shared = createSegmentedEvidenceAdapter(factStore);
  assert.equal(shared.list({ namespace: 'script', operationId: 'many-records' }).length, 1_005);
  shared.close();
  assert.equal(closeCount, 0);

  createSegmentedEvidenceAdapter(factStore, { ownsStore: true }).close();
  assert.equal(closeCount, 1);
});

test('G2 one segmented FactStore persists Legacy, Script, and Intent together across reopen', async (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g2-unified-evidence-')));
  const options = {
    directory,
    profile: '64mb',
    budgetBytes: 4096 * 24,
    segmentSize: 4096,
    partitionQuotas: Array(8).fill(4096 * 2),
  };
  let store = createFactStore(options);
  t.after(() => {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const legacy = new FactRecorder({
    cache: createLegacyFactStoreAdapter(store),
    now: () => 1_700_000_000_000,
  });
  const script = createScriptEvidenceStore({ adapter: createSegmentedEvidenceAdapter(store) });
  const intent = createIntentEvidenceStore({ adapter: createSegmentedEvidenceAdapter(store) });

  const legacyReceipt = legacy.recordExecution({
    command: 'tap',
    args: {
      serial: 'device-1',
      packageName: 'com.example.legacy',
      requestId: 'legacy-action-1',
    },
    result: { ok: true },
    actionId: 'legacy-action-1',
  });
  const legacyDuplicate = legacy.recordExecution({
    command: 'tap',
    args: {
      serial: 'device-1',
      packageName: 'com.example.legacy',
      requestId: 'legacy-action-1',
    },
    result: { ok: true },
  });
  const scriptReceipt = await script.persist('observation', observation('script-unified'));
  const intentReceipt = await intent.persist('observation', observation('intent-unified'));
  assert.equal(legacyReceipt.stored, true);
  assert.equal(legacyDuplicate.deduplicated, true);
  assert.equal(scriptReceipt.persisted, true);
  assert.equal(intentReceipt.persisted, true);
  const legacyHistory = legacy.readHistory('events', {
    serial: 'device-1',
    packageName: 'com.example.legacy',
    includeActions: true,
    limit: 100,
  });
  assert.equal(legacyHistory.ok, true);
  assert.equal(legacyHistory.items.some((item) => item.command === 'tap'), true);

  store.close();
  store = createFactStore(options);
  const all = store.read({ limit: 100 });
  assert.equal(all.ok, true);
  assert.equal(all.items.some((item) => item.actionId === 'legacy-action-1'), true);
  assert.equal(all.items.some((item) => item.payload?.namespace === 'script'), true);
  assert.equal(all.items.some((item) => item.payload?.namespace === 'intent'), true);
});

test('G2 isolated modules share only the EvidenceStore and segmented FactStore seam', () => {
  const script = fs.readFileSync(path.join(__dirname, '../bin/script/script-evidence-store.js'), 'utf8');
  const intent = fs.readFileSync(path.join(__dirname, '../bin/intent/intent-evidence-store.js'), 'utf8');
  const schema = fs.readFileSync(path.join(__dirname, '../bin/shared-kernel/evidence-schema.js'), 'utf8');
  assert.equal(/intent|legacy|history-sink|mcp-server|runBatch/.test(script), false);
  assert.equal(/script|legacy|history-sink|mcp-server|runBatch/.test(intent), false);
  assert.equal(/script-evidence|intent-evidence|history-sink|legacy-dispatcher/.test(schema), false);
});
