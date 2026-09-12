'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createExecutionLedger } = require('../bin/shared-kernel/execution-ledger');

function fact(kind, extra = {}) {
  return {
    executionId: 'ex-1',
    revision: 1,
    kind,
    target: { platform: 'android', serial: 's', packageName: 'p' },
    timestampMs: 1000,
    actionId: extra.actionId,
    parentFactId: extra.parentFactId,
    payloadSummary: extra.payloadSummary,
    evidenceRefs: extra.evidenceRefs,
    timings: extra.timings,
    logs: extra.logs,
  };
}

test('P6 ExecutionLedger records Host facts and pages afterSequence', () => {
  const ledger = createExecutionLedger();
  const first = ledger.record(fact('decision', { actionId: 'd1', payloadSummary: 'tap search' }));
  assert.equal(first.ok, true);
  assert.equal(first.sequence, 1);
  ledger.record(fact('action-receipt', { actionId: 'a1', payloadSummary: 'ok' }));
  const page = ledger.query('ex-1', 1, 10);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].kind, 'action-receipt');
  assert.equal(page.items[0].schemaVersion, 'aab.execution-fact/v1');
  assert.equal(Object.hasOwn(page.items[0], 'logs'), false);
});

test('P6 ExecutionLedger accepts an explicit sequence for shared event cursors', () => {
  const ledger = createExecutionLedger();
  ledger.record(fact('script_started', { payloadSummary: 'start' }));
  ledger.record({ ...fact('call_started', { payloadSummary: 'tap' }), sequence: 3 });
  const page = ledger.query('ex-1', 2, 10);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].kind, 'call_started');
  assert.equal(page.items[0].sequence, 3);
  assert.equal(page.lastSequence, 3);
});

test('P6 ExecutionLedger snapshot and latest stay kind-specific', () => {
  const ledger = createExecutionLedger();
  ledger.record(fact('observation', { payloadSummary: 'home' }));
  ledger.record(fact('decision', { payloadSummary: 'open settings' }));
  const snap = ledger.snapshot('ex-1');
  assert.equal(snap.lastSequence, 2);
  assert.equal(snap.lastFact.kind, 'decision');
  assert.equal(ledger.latest('ex-1', 'observation').payloadSummary, 'home');
  assert.equal(ledger.latest('ex-1', 'progress'), null);
});

test('P6 ExecutionLedger reports a retention gap after per-execution eviction', () => {
  const ledger = createExecutionLedger({ maxEvents: 1 });
  ledger.record(fact('decision', { payloadSummary: 'one' }));
  ledger.record(fact('action-receipt', { payloadSummary: 'two' }));
  const page = ledger.query('ex-1', 0, 10);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].kind, 'action-receipt');
  assert.equal(page.gap, true);
});

test('P6 ExecutionLedger bounds the number of retained executions', () => {
  const ledger = createExecutionLedger({ maxExecutions: 2 });
  ledger.record(fact('decision', { payloadSummary: 'one' }));
  ledger.record({ ...fact('decision', { payloadSummary: 'two' }), executionId: 'ex-2' });
  ledger.record({ ...fact('decision', { payloadSummary: 'three' }), executionId: 'ex-3' });
  assert.equal(ledger.snapshot('ex-1').lastFact.payloadSummary, 'one');
  assert.equal(ledger.snapshot('ex-1').gap, true);
  assert.equal(ledger.query('ex-1', 0, 10).gap, true);
  assert.equal(ledger.query('ex-1', 0, 10).items.length, 0);
  assert.equal(ledger.snapshot('ex-2').lastFact.payloadSummary, 'two');
  assert.equal(ledger.snapshot('ex-3').lastFact.payloadSummary, 'three');
  ledger.record(fact('decision', { payloadSummary: 'one-again' }));
  assert.equal(ledger.snapshot('ex-1').gap, true);
  assert.equal(ledger.query('ex-1', 0, 10).gap, true);
  assert.equal(ledger.query('ex-1', 0, 10).items[0].sequence, 2);
});

test('P6 ExecutionLedger page lastSequence is the last returned fact', () => {
  const ledger = createExecutionLedger();
  ledger.record(fact('decision', { payloadSummary: 'one' }));
  ledger.record(fact('action-receipt', { payloadSummary: 'two' }));
  ledger.record(fact('observation', { payloadSummary: 'three' }));
  const first = ledger.query('ex-1', 0, 1);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].kind, 'decision');
  assert.equal(first.lastSequence, 1);
  assert.equal(first.hasMore, true);
  const next = ledger.query('ex-1', first.lastSequence, 1);
  assert.equal(next.items[0].kind, 'action-receipt');
  assert.equal(next.lastSequence, 2);
  assert.equal(next.hasMore, true);
  const rest = ledger.query('ex-1', next.lastSequence, 10);
  assert.equal(rest.items[0].kind, 'observation');
  assert.equal(rest.hasMore, false);
});

test('P6 ExecutionLedger empty page does not advance lastSequence past unread facts', () => {
  const ledger = createExecutionLedger();
  ledger.record(fact('decision', { payloadSummary: 'one' }));
  ledger.record(fact('action-receipt', { payloadSummary: 'two' }));
  const empty = ledger.query('ex-1', 0, 0);
  assert.equal(empty.items.length, 0);
  assert.equal(empty.lastSequence, 0);
  assert.equal(empty.hasMore, true);
  const next = ledger.query('ex-1', empty.lastSequence, 1);
  assert.equal(next.items[0].kind, 'decision');
  assert.equal(next.lastSequence, 1);
});

test('P6 ExecutionLedger is Intent/Script/Legacy-neutral', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../bin/shared-kernel/execution-ledger.js'),
    'utf8',
  );
  assert.equal(/intent\/|script\/|legacy\/|runBatch|runBridgeChecked|mcp-server/.test(source), false);
});
