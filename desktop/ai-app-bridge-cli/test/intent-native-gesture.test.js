'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProductionIntentDeviceAdapter } = require('../bin/intent/intent-production-adapter');
const { handle, resetIntentOperations } = require('../bin/intent/intent-entry');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { nativeTargetRef } = require('../test-support/native-target-fixture');

const target = { platform: 'android', serial: 'native-gesture-test', packageName: 'example.gesture', adb: '/test/adb', port: 19091 };
function node(extra = {}) {
  return { targetRef: nativeTargetRef(), visible: true, effectiveVisible: true, enabled: true, className: 'android.view.View',
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
  const device = createProductionIntentDeviceAdapter({ ports: {
    bridgeTree: async () => device.liveTree,
    createBridgeContext: (args) => args,
    nativeGesture: async (...args) => {
      calls.push(args);
      return { ok: true, transport: 'bridge', ...args[1] };
    },
    swipe: async () => { throw Error('SDK gestures must not use device input'); },
    ...extraPorts,
  } });
  return device;
}
function dispatch(device, action = spec(), rawTree = tree()) {
  device.liveTree = rawTree;
  return device.action({ ...target, actionId: 'gesture:decision-1', spec: action, rawTree });
}

test('native swipe passes exact text/resource/description and a reference with relative movement', async () => {
  for (const selector of [{ text: 'Task row' }, { resourceName: 'example.gesture:id/DragHandle' }, { contentDescription: 'Move task' }]) {
    const calls = [];
    const result = await dispatch(adapter(calls), spec({ selector }));
    assert.equal(result.ok, true);
    assert.equal(result.mechanicalStatus, 'ok');
    const payload = { action: 'swipe', selector, targetRef: nativeTargetRef(), actionId: 'gesture:decision-1', deltaX: 150, deltaY: 0, durationMs: 500 };
    assert.deepEqual(calls, [[{ serial: target.serial, packageName: target.packageName, adb: target.adb, port: target.port, runtimeActionId: 'gesture:decision-1' }, payload]]);
    assert.deepEqual(result.providerResult, { ok: true, transport: 'bridge', ...payload });
  }
  const calls = [];
  assert.equal((await dispatch(adapter(calls), spec({ deltaX: 0, deltaY: -180, durationMs: 900 }))).ok, true);
  assert.deepEqual(calls[0][1], { action: 'swipe', selector: { text: 'Task row' }, targetRef: nativeTargetRef(), actionId: 'gesture:decision-1', deltaX: 0, deltaY: -180, durationMs: 900 });
});

test('native swipe rejects invalid numeric values before dispatch', async () => {
  const cases = [
    ...[undefined, null, '150', NaN, Infinity, -Infinity].map((deltaX) => [spec({ deltaX }), 'invalid_swipe_delta']),
    ...[undefined, null, '0', NaN, Infinity, -Infinity].map((deltaY) => [spec({ deltaY }), 'invalid_swipe_delta']),
    ...[undefined, null, '500', 0, -1, 0.5, NaN, Infinity, 10001, Number.MAX_SAFE_INTEGER + 1].map((durationMs) => [spec({ durationMs }), 'invalid_swipe_duration']),
  ];
  for (const [action, error] of cases) {
    const calls = []; const result = await dispatch(adapter(calls), action);
    assert.equal(result.error, error);
    assert.equal(result.dispatched, false);
    assert.equal(result.ambiguous, false);
    assert.equal(calls.length, 0);
  }
});

test('SDK endpoint and rounded-zero rejections are retained without another dispatch', async () => {
  for (const error of ['swipe_endpoint_out_of_bounds', 'swipe_delta_zero']) {
    const calls = [];
    const device = adapter(calls, { nativeGesture: async (_ctx, payload) => { calls.push(payload); return { ok: false, error, dispatched: false, ambiguous: false }; } });
    const result = await dispatch(device, spec({ deltaX: 399.6 }));
    assert.equal(result.error, error); assert.equal(result.dispatched, false); assert.equal(result.ambiguous, false);
    assert.equal(calls.length, 1); assert.equal(calls[0].deltaX, 399.6); assert.equal(Object.hasOwn(calls[0], 'startX'), false);
  }
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

test('native swipe cannot target an underlying activity', async () => {
  const rawTree = tree();
  const dialog = node({ text: '', resourceName: 'dialog', contentDescription: '',
    bounds: { left: 100, top: 150, right: 450, bottom: 350 }, children: [node({ text: 'Dialog row' })] });
  rawTree.foregroundWindowId = 'dialog';
  rawTree.windows = [{ windowId: 'activity', root: rawTree.root }, { windowId: 'dialog', root: dialog }];
  const calls = []; const device = adapter(calls);
  assert.equal((await dispatch(device, spec(), rawTree)).error, 'native_selector_not_found');
  assert.equal(calls.length, 0);
  assert.equal((await dispatch(device, spec({ selector: { text: 'Dialog row' }, deltaX: 10 }), rawTree)).ok, true);
  assert.equal(calls.length, 1);
});

test('native swipe does not use another provider or synthesize a missing port', async () => {
  for (const provider of ['uia', 'flutter']) {
    const calls = []; const result = await dispatch(adapter(calls), spec({ provider }));
    assert.equal(result.error, 'swipe_provider_unsupported');
    assert.equal(result.dispatched, false); assert.equal(calls.length, 0);
  }
  const calls = [];
  const missing = await dispatch(adapter(calls, { nativeGesture: undefined }));
  assert.equal(missing.error, 'native_gesture_port_unavailable');
  assert.equal(missing.dispatched, false); assert.equal(missing.ambiguous, false);
});

test('native swipe retains ambiguous throws and invalid provider receipts', async () => {
  const thrown = await dispatch(adapter([], { nativeGesture: async () => { throw new Error('SDK connection lost'); } }));
  assert.equal(thrown.ok, false); assert.equal(thrown.ambiguous, true); assert.equal(thrown.error, 'SDK connection lost');
  const invalid = await dispatch(adapter([], { nativeGesture: async () => undefined }));
  assert.equal(invalid.ok, false); assert.equal(invalid.ambiguous, true); assert.equal(invalid.error, 'invalid_action_receipt');
});

test('Intent persists observed-revision SDK gesture receipt with the same action ID', async () => {
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
  assert.equal(calls.length, 1); assert.equal(observations, 3, 'prior observation, dispatch revalidation, and post-action observation');
  const receipt = store.latest(start.operationId, 'action-receipt');
  assert.equal(receipt.actionId, 'native-gesture-integration:swipe-row');
  assert.equal(receipt.rawTreeId, observed.rawTreeId);
  assert.equal(receipt.mechanicalStatus, 'ok');
  assert.deepEqual(receipt.providerResult.providerResult, { ok: true, transport: 'bridge', ...calls[0][1] });
  assert.equal(calls[0][1].actionId, receipt.actionId);
  const stale = await handle({ operation: 'decide', operationId: start.operationId, decision: {
    decisionId: 'stale-swipe', agentDecision: 'act', basedOnRevision: start.revision, action: spec(),
  } });
  assert.equal(stale.error, 'reobserve_required'); assert.equal(calls.length, 1);
});
