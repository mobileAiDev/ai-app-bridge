'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runBridgeChecked } = require('../test-support/host-client');
const { FactRecorder } = require('../bin/fact-recorder');
const { TargetExecution } = require('../bin/target-execution');
const { CommandError } = require('../bin/command-errors');

function recorder(append) {
  return new FactRecorder({ cache: { append, query: () => ({ ok: true, items: [] }),
    status: () => ({ persistence: true, degraded: false }) } });
}
const payload = result => JSON.parse(result.content[0].text);

test('history rejection and exception remain visible with feedback off, without changing or repeating a settled action', async () => {
  for (const append of [() => ({ ok: false, stored: false, error: 'store_full' }), () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }]) {
    let calls = 0;
    const result = await runBridgeChecked('keyevent', { serial: 'history-phone', keyCode: 0, feedback: 'off' }, {
      targetExecution: new TargetExecution(), factRecorder: recorder(append), rawRunner: async () => {
        calls++; return { ok: true, settled: true, dispatched: true, ambiguous: false, executionReceipt: { kind: 'test-original', actionId: 'original' } };
      } });
    const value = payload(result);
    assert.equal(calls, 1); assert.equal(value.ok, true); assert.equal(value.settled, true);
    assert.equal(value.executionReceipt.actionId, 'original'); assert.equal(value._history.status, 'partial');
    assert.equal(value._history.action.stored, false); assert.equal(value._history.errors.length, 1);
    assert.equal(value._history.replayed, false); assert.deepEqual(result._meta['ai-app-bridge/history'], value._history);
  }
});

test('evidence failure is separate from successful action history and disabled feedback does not hide it', async () => {
  const result = await runBridgeChecked('tree', { serial: 'history-phone', packageName: 'example.app', feedback: 'off' }, {
    targetExecution: new TargetExecution(), factRecorder: recorder(partition => partition === 'action'
      ? { ok: true, stored: true, globalSeq: 1 } : { ok: false, stored: false, error: 'ui_quota_exceeded' }),
    rawRunner: async () => ({ ok: true, tree: { id: 42, text: 'actual page' } }),
  });
  const value = payload(result); assert.equal(value.ok, true); assert.equal(value._history.status, 'partial');
  assert.equal(value._history.action.stored, true); assert.equal(value._history.evidence[0].error, 'ui_quota_exceeded');
});

test('history initialization errors and explicitly disabled history have distinct machine states', async () => {
  for (const failed of [false, true]) {
    let calls = 0;
    const result = await runBridgeChecked('keyevent', { serial: 'history-phone', keyCode: 0, feedback: 'off' }, {
      targetExecution: new TargetExecution(), factRecorderFactory: () => {
        if (failed) throw Object.assign(new Error('unavailable'), { code: 'store_unavailable' });
        return null;
      }, rawRunner: async () => { calls++; return { ok: true }; },
    });
    assert.equal(calls, 1); assert.equal(payload(result)._history.status, failed ? 'unavailable' : 'disabled');
  }
});

test('an action error retains its dispatch state and receipt when error history also fails', async () => {
  const result = await runBridgeChecked('keyevent', { serial: 'history-phone', keyCode: 0, feedback: 'off' }, {
    targetExecution: new TargetExecution(), factRecorder: recorder(() => ({ ok: false, stored: false, error: 'store_full' })),
    rawRunner: async () => { throw new CommandError('shell_output_unavailable', 'Original command settled, output unavailable.', {
      settled: true, dispatched: true, ambiguous: false, executionReceipt: { actionId: 'original', settled: true } }); },
  });
  const value = payload(result); assert.equal(result.isError, true); assert.equal(value.error, 'shell_output_unavailable');
  assert.equal(value.settled, true); assert.equal(value.executionReceipt.actionId, 'original');
  assert.equal(value._history.status, 'partial'); assert.equal(value._history.action.error, 'store_full');
});

test('raw text results carry history in MCP metadata without rewriting the original text', async () => {
  const result = await runBridgeChecked('uia-tree', { serial: 'history-phone', feedback: 'off' }, {
    targetExecution: new TargetExecution(), factRecorder: recorder(() => ({ ok: false, stored: false, error: 'store_full' })),
    rawRunner: async () => '<hierarchy/>',
  });
  assert.equal(result.content[0].text, '<hierarchy/>'); assert.equal(result._meta['ai-app-bridge/history'].status, 'partial');
});

test('failed evidence append does not poison deduplication and prevent a later read from recording that evidence', () => {
  let attempts = 0;
  const facts = recorder(() => ++attempts === 1 ? { ok: false, stored: false, error: 'store_full' }
    : { ok: true, stored: true, globalSeq: 1 });
  const args = { sessionId: 'web', runtimeEpoch: 'epoch' }, result = { ok: true, items: [{ id: 12, message: 'hello' }] };
  assert.equal(facts.recordEvidence('web-logs', args, result)[0].stored, false);
  assert.equal(facts.recordEvidence('web-logs', args, result)[0].stored, true);
  assert.deepEqual(facts.recordEvidence('web-logs', args, result), []); assert.equal(attempts, 2);
});

test('re-reading idempotent successes and errors does not grow cached feedback or repeat execution', async () => {
  for (const fails of [false, true]) {
    let calls = 0;
    const dependencies = { targetExecution: new TargetExecution(),
      factRecorder: recorder(() => ({ ok: true, stored: true, globalSeq: 1 })),
      rawRunner: async () => { calls++; if (fails) throw new CommandError('provider_rejected', 'Rejected without dispatch.'); return { ok: true }; } };
    for (let i = 0; i < 20; i++) {
      const value = payload(await runBridgeChecked('keyevent', { serial: 'history-phone', keyCode: 0, requestId: 'same-call' }, dependencies));
      assert.equal(value._feedback.evidence.length, 1); assert.equal(value._history.status, 'stored');
      if (fails) { assert.equal(value.error, 'provider_rejected'); assert.equal(value.dispatched, false); }
    }
    assert.equal(calls, 1);
  }
});
