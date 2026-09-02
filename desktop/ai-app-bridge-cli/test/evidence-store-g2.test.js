'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createFactStore } = require('../bin/fact-store');
const { createHistorySink } = require('../bin/legacy/history-sink');
const { createMemoryEvidenceAdapter, createSegmentedEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
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

test('G2 HistorySink init failure, ENOSPC, queue full, hang, and crash do not affect Legacy', async () => {
  const initFailed = createHistorySink({
    adapterFactory: () => { throw new Error('disk missing'); },
  });
  assert.equal(initFailed.offer({ kind: 'log' }).accepted, false);
  assert.equal(initFailed.status().reason, 'init_failed');

  const enospc = createHistorySink({
    adapter: { record: () => ({ ok: false, error: 'ENOSPC' }) },
  });
  assert.equal(enospc.offer({ kind: 'log' }).accepted, true);

  const queued = [];
  const full = createHistorySink({
    queueLimit: 2,
    adapter: { record: () => new Promise(() => {}) },
  });
  assert.equal(full.offer({ n: 1 }).accepted, true);
  assert.equal(full.offer({ n: 2 }).accepted, true);
  assert.equal(full.offer({ n: 3 }).accepted, false);
  assert.equal(full.offer({ n: 3 }).reason, 'queue_full');
  assert.equal(full.status().dropped >= 1, true);

  const crashed = createHistorySink({
    adapter: {
      record() {
        queued.push('crash');
        throw new Error('writer_crash');
      },
    },
  });
  assert.equal(crashed.offer({ n: 1 }).accepted, true);

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

test('G2 isolated modules keep HistorySink, Script, and Intent imports separate', () => {
  const history = fs.readFileSync(path.join(__dirname, '../bin/legacy/history-sink.js'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../bin/script/script-evidence-store.js'), 'utf8');
  const intent = fs.readFileSync(path.join(__dirname, '../bin/intent/intent-evidence-store.js'), 'utf8');
  const schema = fs.readFileSync(path.join(__dirname, '../bin/shared-kernel/evidence-schema.js'), 'utf8');
  assert.equal(/script|intent/.test(history), false);
  assert.equal(/intent|legacy|history-sink|mcp-server|runBatch/.test(script), false);
  assert.equal(/script|legacy|history-sink|mcp-server|runBatch/.test(intent), false);
  assert.equal(/script-evidence|intent-evidence|history-sink|legacy-dispatcher/.test(schema), false);
});
