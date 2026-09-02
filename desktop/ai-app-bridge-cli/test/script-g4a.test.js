'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createTargetLease } = require('../bin/shared-kernel/target-lease-protocol');
const { compileScript } = require('../bin/script/script-compiler');
const { createFakeScriptDeviceAdapter } = require('../bin/script/script-device-adapter');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { handle, resetScriptOperations } = require('../bin/script/script-entry');
const { createScriptWorker } = require('../bin/script/script-worker');
const { runBatch, runBridgeChecked, runGeneric } = require('../bin/mcp-server');

const nativeTree = {
  root: {
    id: 'root',
    className: 'FrameLayout',
    children: [
      { id: 'about', className: 'Button', text: 'About', clickable: true },
      { id: 'license', className: 'TextView', text: 'License Notices' },
    ],
  },
};

function scriptDoc() {
  return {
    name: 'g4a',
    target: { serial: 'b46093e6', packageName: 'com.example.app' },
    steps: [
      { id: 'o1', type: 'observe', provider: 'native' },
      { id: 'a1', type: 'action', action: 'tap', text: 'About' },
      { id: 'k1', type: 'checkpoint' },
      { id: 's1', type: 'assert', text: 'License Notices' },
    ],
  };
}

async function runScript(overrides = {}) {
  const adapter = overrides.adapter || createFakeScriptDeviceAdapter({
    trees: { native: nativeTree },
    lease: createTargetLease(),
    actionResult: overrides.actionResult || { ok: true, mechanicalStatus: 'ok', ambiguous: false },
  });
  const store = overrides.store || createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const result = await handle({
    operation: 'start',
    script: overrides.script || scriptDoc(),
    store,
    adapter,
    now: overrides.now,
  });
  return { result, adapter, store };
}

test('G4-A Script does not import Legacy, Intent, Batch, or runBridgeChecked', () => {
  const files = [
    'script-entry.js',
    'script-worker.js',
    'script-runtime.js',
    'script-compiler.js',
    'script-executor.js',
    'script-device-adapter.js',
    'script-errors.js',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '../bin/script', file), 'utf8');
    assert.equal(/intent\/|legacy\/|runBatch|runBridgeChecked|LegacyDispatcher|mcp-server/.test(source), false, file);
  }
});

test('G4-A fake adapter maxActive is 1 and evidence gates block dispatch', async () => {
  resetScriptOperations();
  const { result, adapter } = await runScript();
  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(adapter.maxActive, 1);
  assert.equal(adapter.calls.filter((item) => item.name === 'action').length, 1);

  const blockedAdapter = createFakeScriptDeviceAdapter({ trees: { native: nativeTree }, lease: createTargetLease() });
  const blocked = await handle({
    operation: 'start',
    script: {
      name: 'blocked',
      target: { serial: 'b46093e6', packageName: 'com.example.app' },
      steps: [{ id: 'a1', type: 'action', action: 'tap', text: 'About' }],
    },
    store: createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() }),
    adapter: blockedAdapter,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'evidence_not_persisted');
  assert.equal(blockedAdapter.calls.filter((item) => item.name === 'action').length, 0);
});

test('G4-A receipt failure stops later steps and checkpoint continues without pausing', async () => {
  resetScriptOperations();
  const memory = createMemoryEvidenceAdapter();
  const receiptStore = createScriptEvidenceStore({
    adapter: {
      record(envelope) {
        if (envelope.kind === 'action-receipt') return { ok: false, error: 'receipt_not_persisted' };
        return memory.record(envelope);
      },
      readById: (id) => memory.readById(id),
      list: (query) => memory.list(query),
      status: () => memory.status(),
    },
  });
  const { result, adapter } = await runScript({ store: receiptStore });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.error, 'receipt_not_persisted');
  assert.equal(result.failedStepId, 'a1');
  assert.equal(result.completedStepIds.includes('s1'), false);
  assert.equal(adapter.calls.filter((item) => item.name === 'action').length, 1);

  const { result: continued, adapter: continuedAdapter } = await runScript();
  assert.equal(continued.status, 'completed');
  assert.equal(continued.completedStepIds.includes('k1'), true);
  assert.equal(continued.pauseReason, null);
  assert.equal(continuedAdapter.calls.filter((item) => item.name === 'observe').length, 1);
});

test('G4-A only execution failure or explicit pause enters paused, and ambiguous actions are not retried', async () => {
  resetScriptOperations();
  const { result } = await runScript({
    actionResult: { ok: true, mechanicalStatus: 'ok', ambiguous: true },
  });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.error, 'ambiguous');

  const adapter = createFakeScriptDeviceAdapter({ trees: { native: nativeTree }, lease: createTargetLease() });
  const started = await handle({
    operation: 'start',
    operationId: 'pause-me',
    script: scriptDoc(),
    store: createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() }),
    adapter,
  });
  assert.equal(started.status, 'completed');
  const paused = handle({ operation: 'pause', operationId: 'manual-late' });
  assert.equal(paused.error, 'unknown_operation');

  const worker = createScriptWorker({
    operationId: 'manual',
    compiled: compileScript(scriptDoc()),
    store: createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() }),
    adapter: createFakeScriptDeviceAdapter({ trees: { native: nativeTree }, lease: createTargetLease() }),
  });
  const pause = worker.pause();
  assert.equal(pause.status, 'created');
  const running = worker.start();
  const after = await running;
  assert.equal(after.status, 'paused_manual');
  assert.equal(after.pauseReason, 'pause_requested');
});

test('G4-A worker crash leaves Legacy and Intent usable; finished Script makes no later device calls', async () => {
  resetScriptOperations();
  const worker = createScriptWorker({
    operationId: 'crash',
    compiled: compileScript(scriptDoc()),
    store: createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() }),
    adapter: createFakeScriptDeviceAdapter({ trees: { native: nativeTree } }),
  });
  worker.runtime.state = null;
  await assert.rejects(() => worker.start());

  const status = await runBridgeChecked('status', { serial: 'android-1' }, {
    rawRunner: async () => {
      throw new Error('status must not reach the runner without packageName or port');
    },
  });
  assert.match(status.content[0].text, /packageName or explicit port is required/);
  const intent = JSON.parse((await runGeneric({ command: 'intent', arguments: { operation: 'status' } })).content[0].text);
  assert.equal(intent.command, 'intent');
  const batch = JSON.parse((await runBatch({ steps: [{ id: 's1', command: 'script' }] })).content[0].text);
  assert.equal(batch.error, 'unknown_batch_step_command');

  const { result, adapter } = await runScript();
  const calls = adapter.callCount;
  assert.equal(result.status, 'completed');
  adapter.now = () => Date.now() + 30 * 60 * 1000;
  assert.equal(adapter.callCount, calls);
});
