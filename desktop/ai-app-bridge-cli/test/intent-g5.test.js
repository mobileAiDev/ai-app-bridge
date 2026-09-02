'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createFakeIntentDeviceAdapter } = require('../bin/intent/intent-device-adapter');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { handle } = require('../bin/intent/intent-entry');
const { handle: scriptHandle } = require('../bin/script/script-entry');
const { runBatch, runBridgeChecked } = require('../bin/mcp-server');

const tree = {
  root: { id: 'home', className: 'Button', text: 'Home', clickable: true, children: [] },
};

function store() {
  return createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
}

test('G5 Intent does not import Script or Legacy', () => {
  for (const file of [
    'intent-entry.js',
    'intent-worker.js',
    'intent-runtime.js',
    'intent-observer.js',
    'intent-action-executor.js',
    'intent-device-adapter.js',
    'intent-errors.js',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '../bin/intent', file), 'utf8');
    assert.equal(/script\/|legacy\/|runBatch|runBridgeChecked|LegacyDispatcher|mcp-server/.test(source), false, file);
  }
});

test('G5 start without persisted evidence cannot enter waiting_for_decision', async () => {
  const blocked = createIntentEvidenceStore({
    adapter: {
      record: () => ({ ok: false, error: 'ENOSPC' }),
      readById: () => null,
      list: () => [],
      status: () => ({ ok: false, error: 'ENOSPC' }),
    },
  });
  const result = await handle({
    operation: 'start',
    operationId: 'blocked',
    goal: 'open settings',
    target: { serial: 'b46093e6', packageName: 'com.example.app' },
    store: blocked,
    adapter: createFakeIntentDeviceAdapter({ trees: { native: tree } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked_evidence_store');
  assert.notEqual(result.status, 'waiting_for_decision');
});

test('G5 stale revision and duplicate decisionId do not dispatch; one action per decision', async () => {
  const adapter = createFakeIntentDeviceAdapter({ trees: { native: tree } });
  const started = await handle({
    operation: 'start',
    operationId: 'g5-rev',
    goal: 'tap home',
    target: { serial: 'b46093e6', packageName: 'com.example.app' },
    store: store(),
    adapter,
  });
  assert.equal(started.status, 'waiting_for_decision');
  const stale = await handle({
    operation: 'decide',
    operationId: 'g5-rev',
    decision: { decisionId: 'd-stale', agentDecision: 'act', basedOnRevision: started.revision + 9, action: { action: 'tap', text: 'Home' } },
  });
  assert.equal(stale.error, 'reobserve_required');
  assert.equal(adapter.calls.filter((item) => item.name === 'action').length, 0);

  const first = await handle({
    operation: 'decide',
    operationId: 'g5-rev',
    decision: { decisionId: 'd1', agentDecision: 'act', basedOnRevision: started.revision, action: { action: 'tap', text: 'Home' } },
  });
  assert.equal(first.ok, true);
  assert.equal(adapter.calls.filter((item) => item.name === 'action').length, 1);

  const dup = await handle({
    operation: 'decide',
    operationId: 'g5-rev',
    decision: { decisionId: 'd1', agentDecision: 'act', basedOnRevision: first.revision, action: { action: 'tap', text: 'Home' } },
  });
  assert.equal(dup.error, 'duplicate_decision');
  assert.equal(adapter.calls.filter((item) => item.name === 'action').length, 1);
  assert.equal(dup.latestEvidenceIds.observation, first.latestEvidenceIds.observation);
  assert.equal(typeof dup.timings.summaryMs, 'number');
  assert.equal(dup.timings.totalMs >= first.timings.totalMs, true);
});

test('G5 receipt loss is ambiguous; status and cancel make zero device calls', async () => {
  const memory = createMemoryEvidenceAdapter();
  const failing = createIntentEvidenceStore({
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
  const adapter = createFakeIntentDeviceAdapter({ trees: { native: tree } });
  const started = await handle({
    operation: 'start',
    operationId: 'receipt',
    goal: 'tap',
    target: { serial: 'b46093e6', packageName: 'com.example.app' },
    store: failing,
    adapter,
  });
  const decided = await handle({
    operation: 'decide',
    operationId: 'receipt',
    decision: { decisionId: 'd-r', agentDecision: 'act', basedOnRevision: started.revision, action: { action: 'tap', text: 'Home' } },
  });
  assert.equal(decided.status, 'ambiguous');
  const after = adapter.callCount;
  const status = handle({ operation: 'status', operationId: 'receipt' });
  const cancelled = handle({ operation: 'cancel', operationId: 'receipt' });
  assert.equal(status.status, 'ambiguous');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(adapter.callCount, after);
});

test('G5 completes three observe-decide-action-observe rounds; Script and Legacy still work', async () => {
  const adapter = createFakeIntentDeviceAdapter({ trees: { native: tree } });
  let current = await handle({
    operation: 'start',
    operationId: 'rounds',
    goal: 'three taps',
    target: { serial: 'b46093e6', packageName: 'com.example.app' },
    store: store(),
    adapter,
  });
  for (let i = 1; i <= 3; i += 1) {
    current = await handle({
      operation: 'decide',
      operationId: 'rounds',
      decision: {
        decisionId: `d-${i}`,
        agentDecision: 'act',
        basedOnRevision: current.revision,
        action: { action: 'tap', text: 'Home' },
      },
    });
    assert.equal(current.ok, true);
    assert.equal(current.status, 'waiting_for_decision');
  }
  assert.equal(adapter.calls.filter((item) => item.name === 'observe').length, 4);
  assert.equal(adapter.calls.filter((item) => item.name === 'action').length, 3);
  const done = await handle({
    operation: 'decide',
    operationId: 'rounds',
    decision: { decisionId: 'done', agentDecision: 'complete', basedOnRevision: current.revision },
  });
  assert.equal(done.status, 'completed');

  const script = await scriptHandle({
    operation: 'start',
    script: {
      name: 'g5-reg',
      target: { serial: 'android-1', packageName: 'com.example.app' },
      steps: [{ id: 'o1', type: 'observe', provider: 'native' }],
    },
  });
  assert.equal(script.status, 'completed');
  const legacy = await runBridgeChecked('status', { serial: 'android-1' }, {
    rawRunner: async () => { throw new Error('no runner'); },
  });
  assert.match(legacy.content[0].text, /packageName or explicit port is required/);
  const batch = JSON.parse((await runBatch({ steps: [{ id: 's1', command: 'intent' }] })).content[0].text);
  assert.equal(batch.error, 'unknown_batch_step_command');
});
