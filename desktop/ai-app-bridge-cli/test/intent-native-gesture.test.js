'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProductionIntentDeviceAdapter } = require('../bin/intent/intent-production-adapter');
const { handle, resetIntentOperations } = require('../bin/intent/intent-entry');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');

const target = { serial: 'native-gesture-test', packageName: 'example.gesture', adb: '/test/adb', port: 19091 };
function node(extra = {}) {
  return { visible: true, effectiveVisible: true, enabled: true, className: 'android.view.View',
    text: 'Task row', resourceName: 'example.gesture:id/DragHandle', contentDescription: 'Move task',
    bounds: { left: 100, top: 200, right: 300, bottom: 260 }, children: [], ...extra };
}
function tree(children = [node()]) {
  return { root: node({ text: '', resourceName: 'root', contentDescription: '',
    bounds: { left: 0, top: 0, right: 600, bottom: 900 }, children }) };
}
function spec(extra = {}) {
  return { action: 'swipe', provider: 'native', selector: { text: 'Task row' }, deltaX: 150, deltaY: 0, durationMs: 500, ...extra };
}
function adapter(calls, extraPorts = {}) {
  return createProductionIntentDeviceAdapter({ ports: {
    createBridgeContext: (args) => args,
    swipe: async (...args) => {
      calls.push(args);
      const [, startX, startY, endX, endY, durationMs] = args;
      return { ok: true, transport: 'adb', startX, startY, endX, endY, durationMs };
    },
    ...extraPorts,
  } });
}
function dispatch(device, action = spec(), rawTree = tree()) {
  return device.action({ ...target, actionId: 'gesture:decision-1', spec: action, rawTree });
}

test('native swipe resolves exact text/resource/description at the observed node center', async () => {
  for (const selector of [{ text: 'Task row' }, { resourceName: 'example.gesture:id/DragHandle' }, { contentDescription: 'Move task' }]) {
    const calls = [];
    const result = await dispatch(adapter(calls), spec({ selector }));
    assert.equal(result.ok, true);
    assert.equal(result.mechanicalStatus, 'ok');
    assert.deepEqual(calls, [[target, 200, 230, 350, 230, 500]]);
    assert.deepEqual(result.providerResult, { ok: true, transport: 'adb', startX: 200, startY: 230, endX: 350, endY: 230, durationMs: 500 });
    assert.equal(Object.hasOwn(result.providerResult, 'actionId'), false, 'ADB swipe does not receive a runtime causal ID');
  }
  const calls = [];
  assert.equal((await dispatch(adapter(calls), spec({ deltaX: 0, deltaY: -180, durationMs: 900 }))).ok, true);
  assert.deepEqual(calls[0].slice(1), [200, 230, 200, 50, 900]);
});

test('native swipe rejects invalid numeric values and zero movement before dispatch', async () => {
  const cases = [
    ...[undefined, null, '150', NaN, Infinity, -Infinity].map((deltaX) => [spec({ deltaX }), 'invalid_swipe_delta']),
    ...[undefined, null, '0', NaN, Infinity, -Infinity].map((deltaY) => [spec({ deltaY }), 'invalid_swipe_delta']),
    ...[undefined, null, '500', 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((durationMs) => [spec({ durationMs }), 'invalid_swipe_duration']),
    [spec({ deltaX: 0, deltaY: 0 }), 'swipe_delta_zero'],
    [spec({ deltaX: 0.1, deltaY: 0.1 }), 'swipe_delta_zero'],
  ];
  for (const [action, error] of cases) {
    const calls = []; const result = await dispatch(adapter(calls), action);
    assert.equal(result.error, error);
    assert.equal(result.dispatched, false);
    assert.equal(result.ambiguous, false);
    assert.equal(calls.length, 0);
  }
});

test('native swipe checks actual rounded endpoints against foreground window bounds', async () => {
  const calls = []; const device = adapter(calls);
  assert.equal((await dispatch(device, spec({ deltaX: 399, deltaY: 669 }))).ok, true);
  assert.deepEqual(calls[0].slice(1), [200, 230, 599, 899, 500]);
  for (const extra of [{ deltaX: 400 }, { deltaX: 399.6 }, { deltaX: -201 }, { deltaY: 670 }, { deltaY: -231 }, { deltaX: Number.MAX_VALUE }]) {
    const result = await dispatch(device, spec(extra));
    assert.equal(result.error, 'swipe_endpoint_out_of_bounds');
    assert.equal(result.dispatched, false);
    assert.equal(result.ambiguous, false);
  }
  assert.equal(calls.length, 1);
});

test('native swipe requires one explicit exact selector and an eligible observed node', async () => {
  const cases = [
    [spec({ selector: undefined, text: 'Task row' }), tree(), 'explicit_native_selector_required'],
    [spec({ selector: {} }), tree(), 'explicit_native_selector_required'],
    [spec({ selector: { text: 'Task row', resourceName: 'example.gesture:id/DragHandle' } }), tree(), 'explicit_native_selector_required'],
    [spec({ selector: { text: 'Task' } }), tree(), 'native_selector_not_found'],
    [spec(), tree([node(), node()]), 'native_selector_ambiguous'],
    [spec(), tree([node({ effectiveVisible: false })]), 'native_selector_not_found'],
    [spec(), tree([node({ enabled: false })]), 'native_selector_not_found'],
    [spec(), tree([node({ bounds: { left: 600, top: 200, right: 700, bottom: 260 } })]), 'native_selector_not_found'],
    [spec(), null, 'visible_observed_window_required'],
  ];
  for (const [action, rawTree, error] of cases) {
    const calls = []; const result = await dispatch(adapter(calls), action, rawTree);
    assert.equal(result.error, error);
    assert.equal(result.dispatched, false);
    assert.equal(result.ambiguous, false);
    assert.equal(calls.length, 0);
  }
});

test('native swipe cannot target an underlying activity or leave the foreground dialog', async () => {
  const rawTree = tree();
  const dialog = node({ text: '', resourceName: 'dialog', contentDescription: '',
    bounds: { left: 100, top: 150, right: 450, bottom: 350 }, children: [node({ text: 'Dialog row' })] });
  rawTree.windows = [{ root: rawTree.root }, { root: dialog }];
  const calls = []; const device = adapter(calls);
  assert.equal((await dispatch(device, spec(), rawTree)).error, 'native_selector_not_found');
  const result = await dispatch(device, spec({ selector: { text: 'Dialog row' }, deltaX: 250 }), rawTree);
  assert.equal(result.error, 'swipe_endpoint_out_of_bounds');
  assert.equal(calls.length, 0);
});

test('native swipe does not use another provider or synthesize a missing port', async () => {
  for (const provider of ['uia', 'flutter']) {
    const calls = []; const result = await dispatch(adapter(calls), spec({ provider }));
    assert.equal(result.error, 'swipe_provider_unsupported');
    assert.equal(result.dispatched, false); assert.equal(calls.length, 0);
  }
  const calls = [];
  const missing = await dispatch(adapter(calls, { swipe: undefined }));
  assert.equal(missing.error, 'swipe_port_unavailable');
  assert.equal(missing.dispatched, false); assert.equal(missing.ambiguous, false);
});

test('native swipe retains ambiguous throws and invalid provider receipts', async () => {
  const thrown = await dispatch(adapter([], { swipe: async () => { throw new Error('adb connection lost'); } }));
  assert.equal(thrown.ok, false); assert.equal(thrown.ambiguous, true); assert.equal(thrown.error, 'adb connection lost');
  const invalid = await dispatch(adapter([], { swipe: async () => undefined }));
  assert.equal(invalid.ok, false); assert.equal(invalid.ambiguous, true); assert.equal(invalid.error, 'invalid_action_receipt');
});

test('Intent persists observed-revision gesture receipt with Host action ID and ADB coordinates', async () => {
  resetIntentOperations();
  const calls = []; let observations = 0;
  const device = adapter(calls, { bridgeTree: async () => { observations += 1; return tree(); } });
  const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const start = await handle({ operation: 'start', operationId: 'native-gesture-integration', goal: 'Move task', target, adapter: device, store });
  assert.equal(start.status, 'waiting_for_decision');
  const observed = store.latest(start.operationId, 'observation');
  const next = await handle({ operation: 'decide', operationId: start.operationId, decision: {
    decisionId: 'swipe-row', agentDecision: 'act', basedOnRevision: start.revision, action: spec(),
  } });
  assert.equal(next.status, 'waiting_for_decision');
  assert.equal(calls.length, 1); assert.equal(observations, 2, 'one prior observation and one after action; no selector requery');
  const receipt = store.latest(start.operationId, 'action-receipt');
  assert.equal(receipt.actionId, 'native-gesture-integration:swipe-row');
  assert.equal(receipt.rawTreeId, observed.rawTreeId);
  assert.equal(receipt.mechanicalStatus, 'ok');
  assert.deepEqual(receipt.providerResult.providerResult, { ok: true, transport: 'adb', startX: 200, startY: 230, endX: 350, endY: 230, durationMs: 500 });
  const stale = await handle({ operation: 'decide', operationId: start.operationId, decision: {
    decisionId: 'stale-swipe', agentDecision: 'act', basedOnRevision: start.revision, action: spec(),
  } });
  assert.equal(stale.error, 'reobserve_required'); assert.equal(calls.length, 1);
});
