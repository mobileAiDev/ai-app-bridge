'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createFileEvidenceAdapter, createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createFakeScriptDeviceAdapter } = require('../bin/script/script-device-adapter');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { handle, resetScriptOperations } = require('../bin/script/script-entry');
const { createScriptWorker } = require('../bin/script/script-worker');
const { compileScript } = require('../bin/script/script-compiler');

const TREE = {
  root: {
    id: 'root',
    className: 'Button',
    text: 'About',
    clickable: true,
    children: [],
  },
};

function scriptDoc() {
  return {
    name: 's17',
    target: { serial: 'b46093e6', packageName: 'com.example.app' },
    steps: [
      { id: 'o1', type: 'observe', provider: 'native' },
      { id: 'a1', type: 'action', action: 'tap', text: 'About' },
      { id: 'k1', type: 'checkpoint' },
      { id: 's1', type: 'assert', text: 'About' },
    ],
  };
}

function timingKeys(timings) {
  return [
    'workerOverheadMs',
    'targetLeaseWaitMs',
    'providerAcquireMs',
    'evidenceCommitMs',
    'summaryMs',
    'decisionWaitMs',
    'actionMs',
    'receiptCommitMs',
    'totalMs',
  ].every((key) => typeof timings?.[key] === 'number');
}

test('S17 Script results include evidence IDs, timings, and sliced progress', async () => {
  resetScriptOperations();
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const adapter = createFakeScriptDeviceAdapter({ trees: { native: TREE } });
  const result = await handle({
    operation: 'start',
    operationId: 's17-progress',
    script: scriptDoc(),
    store,
    adapter,
  });
  assert.equal(result.status, 'completed');
  assert.equal(typeof result.evidenceId, 'string');
  assert.equal(typeof result.latestEvidenceIds.observation, 'string');
  assert.equal(typeof result.latestEvidenceIds.plan, 'string');
  assert.equal(typeof result.latestEvidenceIds.marker, 'string');
  assert.equal(typeof result.latestEvidenceIds.receipt, 'string');
  assert.equal(typeof result.latestEvidenceIds.checkpoint, 'string');
  assert.equal(timingKeys(result.timings), true);
  const progress = await handle({
    operation: 'progress',
    operationId: 's17-progress',
    afterSequence: 1,
    eventLimit: 2,
  });
  assert.equal(progress.events.length <= 2, true);
  assert.equal(progress.events.every((event) => event.sequence > 1), true);
});

test('S17 Script pause then restore from persisted checkpoint after memory reset', async () => {
  resetScriptOperations();
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const adapter = createFakeScriptDeviceAdapter({ trees: { native: TREE } });
  const worker = createScriptWorker({
    operationId: 's17-restore',
    compiled: compileScript(scriptDoc()),
    store,
    adapter,
  });
  worker.pause();
  const paused = await worker.start();
  assert.equal(paused.status, 'paused_manual');
  assert.equal(paused.completedStepIds.includes('o1'), true);
  resetScriptOperations();
  const missing = handle({ operation: 'status', operationId: 's17-restore' });
  assert.equal((await missing).error, 'unknown_operation');
  const resumed = await handle({
    operation: 'resume',
    operationId: 's17-restore',
    store,
    adapter,
  });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.completedStepIds.includes('s1'), true);
  assert.equal(adapter.calls.filter((item) => item.name === 'action').length, 1);
});

test('S17 ambiguous receipt is not auto-replayed on restore', async () => {
  resetScriptOperations();
  const memory = createMemoryEvidenceAdapter();
  const store = createScriptEvidenceStore({
    adapter: {
      record(envelope) {
        if (envelope.kind === 'action-receipt') {
          const stored = memory.record({ ...envelope, ambiguous: true });
          return stored;
        }
        return memory.record(envelope);
      },
      readById: (id) => memory.readById(id),
      list: (query) => memory.list(query),
      status: () => memory.status(),
    },
  });
  const started = await handle({
    operation: 'start',
    operationId: 's17-ambiguous',
    script: scriptDoc(),
    store,
    adapter: createFakeScriptDeviceAdapter({
      trees: { native: TREE },
      actionResult: { ok: true, mechanicalStatus: 'ok', ambiguous: true },
    }),
  });
  assert.equal(started.status, 'ambiguous');
  resetScriptOperations();
  const restored = await handle({
    operation: 'resume',
    operationId: 's17-ambiguous',
    store,
    adapter: createFakeScriptDeviceAdapter({ trees: { native: TREE } }),
  });
  assert.equal(restored.error, 'ambiguous');
  assert.equal(restored.status, 'ambiguous');
});

test('S17 a later receipt-persist failure restores as ambiguous and does not replay', async () => {
  resetScriptOperations();
  const memory = createMemoryEvidenceAdapter();
  let receipts = 0;
  const store = createScriptEvidenceStore({
    adapter: {
      record(envelope) {
        if (envelope.kind === 'action-receipt') {
          receipts += 1;
          if (receipts === 2) return { ok: false, error: 'receipt_not_persisted' };
        }
        return memory.record(envelope);
      },
      readById: (id) => memory.readById(id),
      list: (query) => memory.list(query),
      status: () => memory.status(),
    },
  });
  const adapter = createFakeScriptDeviceAdapter({ trees: { native: TREE } });
  const started = await handle({
    operation: 'start',
    operationId: 's17-second-receipt',
    script: {
      name: 's17-two-actions',
      target: { serial: 'b46093e6', packageName: 'com.example.app' },
      steps: [
        { id: 'o1', type: 'observe', provider: 'native' },
        { id: 'a1', type: 'action', action: 'tap', text: 'About' },
        { id: 'o2', type: 'observe', provider: 'native' },
        { id: 'a2', type: 'action', action: 'tap', text: 'About' },
      ],
    },
    store,
    adapter,
  });
  assert.equal(started.status, 'ambiguous');
  assert.equal(started.failedStepId, 'a2');
  const actions = adapter.calls.filter((item) => item.name === 'action').length;
  resetScriptOperations();
  const restored = await handle({
    operation: 'resume',
    operationId: 's17-second-receipt',
    store,
    adapter,
  });
  assert.equal(restored.error, 'ambiguous');
  assert.equal(adapter.calls.filter((item) => item.name === 'action').length, actions);
});

test('S17 Script restores from a durable file store after in-memory operations reset', async () => {
  resetScriptOperations();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's17-file-store-'));
  const store = createScriptEvidenceStore({ adapter: createFileEvidenceAdapter({ dir }) });
  const adapter = createFakeScriptDeviceAdapter({ trees: { native: TREE } });
  const worker = createScriptWorker({
    operationId: 's17-file-restore',
    compiled: compileScript(scriptDoc()),
    store,
    adapter,
  });
  worker.pause();
  const paused = await worker.start();
  assert.equal(paused.status, 'paused_manual');
  assert.equal(paused.completedStepIds.includes('o1'), true);
  resetScriptOperations();
  const missing = await handle({ operation: 'status', operationId: 's17-file-restore' });
  assert.equal(missing.error, 'unknown_operation');
  const restored = await handle({
    operation: 'resume',
    operationId: 's17-file-restore',
    store: createScriptEvidenceStore({ adapter: createFileEvidenceAdapter({ dir }) }),
    adapter: createFakeScriptDeviceAdapter({ trees: { native: TREE } }),
  });
  assert.equal(restored.status, 'completed');
  assert.equal(restored.completedStepIds.includes('s1'), true);
  assert.equal(timingKeys(restored.timings), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
