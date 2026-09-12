'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createFakeIntentDeviceAdapter } = require('../bin/intent/intent-device-adapter');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { handle } = require('./helpers/intent-entry');

const tree = {
  root: { id: 'home', className: 'Button', text: 'Home', clickable: true, children: [] },
};

test('P6 Intent persist writes decision action and receipt into ExecutionLedger', async () => {
  const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const started = await handle({
    operation: 'start',
    operationId: 'p6-ledger',
    goal: 'tap home',
    target: { platform: 'android', serial: 's1', packageName: 'pkg' },
    store,
    adapter: createFakeIntentDeviceAdapter({ trees: { native: tree } }),
  });
  assert.equal(started.status, 'waiting_for_decision');
  const acted = await handle({
    operation: 'decide',
    operationId: 'p6-ledger',
    decision: {
      decisionId: 'd1',
      agentDecision: 'act',
      basedOnRevision: started.revision,
      action: { action: 'tap', selector: { text: 'Home' } },
      reason: 'home button visible',
    },
  });
  assert.equal(acted.ok, true);
  const status = await handle({
    operation: 'status',
    operationId: 'p6-ledger',
    afterSequence: 0,
  });
  const kinds = status.history.items.map((item) => item.kind);
  assert.equal(kinds.includes('observation'), true);
  assert.equal(kinds.includes('decision'), true);
  assert.equal(kinds.includes('dispatch-marker'), true);
  assert.equal(kinds.includes('action-receipt'), true);
  assert.equal(status.history.items.every((item) => item.schemaVersion === 'aab.execution-fact/v1'), true);
  assert.equal(status.history.items.every((item) => Object.hasOwn(item, 'logs') === false), true);
  const decision = status.history.items.find((item) => item.kind === 'decision');
  assert.equal(decision.payloadSummary.decisionId, 'd1');
  assert.equal(decision.payloadSummary.agentDecision, 'act');
  assert.equal(decision.payloadSummary.mode, 'supervised');
  assert.equal(decision.payloadSummary.action.action, 'tap');
  assert.equal(decision.payloadSummary.action.selector.text, 'Home');
  assert.equal(decision.payloadSummary.reason, 'home button visible');
  assert.equal(decision.timestampMs != null, true);
  assert.equal(decision.target.serial, 's1');
  assert.equal(decision.revision, started.revision);
  const summary = status.history.items.find((item) => item.kind === 'summary');
  assert.equal(summary.target.serial, 's1');
  assert.equal(summary.timestampMs != null, true);
  const marker = status.history.items.find((item) => item.kind === 'dispatch-marker');
  assert.equal(marker.payloadSummary.state, 'prepared');
  assert.equal(marker.payloadSummary.decisionId, 'd1');
  assert.equal(marker.payloadSummary.action.selector.text, 'Home');
  const receipt = status.history.items.find((item) => item.kind === 'action-receipt');
  assert.equal(receipt.payloadSummary.mechanicalStatus, 'ok');
  assert.equal(receipt.payloadSummary.ambiguous, false);
  assert.equal(receipt.payloadSummary.action.selector.text, 'Home');
  assert.equal(receipt.payloadSummary.rawTreeId, 'p6-ledger:1');
  assert.equal(receipt.payloadSummary.basedOnEvidenceIds[0], decision.payloadSummary.basedOnEvidenceIds[0]);
  assert.equal(receipt.parentFactId, decision.payloadSummary.basedOnEvidenceIds[0]);
  assert.equal(receipt.revision, started.revision);
  assert.equal(receipt.target.serial, 's1');
  assert.equal(receipt.evidenceRefs[0].includes(':undefined:'), false);
  assert.equal(receipt.timings.startedAtMs != null, true);
  const observation = status.history.items.find((item) => item.kind === 'observation');
  assert.equal(observation.payloadSummary.provider, 'native');
  assert.equal(observation.target.serial, 's1');
});

test('P6 Intent status reads ExecutionLedger after the live worker is evicted', async () => {
  const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const adapter = createFakeIntentDeviceAdapter({ trees: { native: tree } });
  const first = await handle({
    operation: 'start',
    operationId: 'p6-evicted',
    goal: 'tap home',
    target: { platform: 'android', serial: 's1', packageName: 'pkg' },
    store,
    adapter,
  });
  await handle({
    operation: 'decide',
    operationId: 'p6-evicted',
    decision: {
      decisionId: 'done',
      agentDecision: 'complete',
      basedOnRevision: first.revision,
    },
  });
  await handle({
    operation: 'start',
    operationId: 'p6-live',
    goal: 'next',
    target: { platform: 'android', serial: 's1', packageName: 'pkg' },
    store,
    adapter,
  });
  const evicted = await handle({
    operation: 'status',
    operationId: 'p6-evicted',
    afterSequence: 0,
  });
  assert.equal(evicted.ok, true);
  assert.equal(evicted.status, 'completed');
  assert.equal(evicted.history.items.some((item) => (
    item.kind === 'decision' && item.payloadSummary.agentDecision === 'complete'
  )), true);
});

test('P6 Intent ledger wiring stays off Script and Legacy modules', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../bin/intent/intent-evidence-store.js'),
    'utf8',
  );
  assert.equal(/script\/|legacy\/|runBatch|runBridgeChecked|mcp-server/.test(source), false);
});
