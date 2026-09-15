'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createProductionIntentDeviceAdapter } = require('../bin/intent/intent-production-adapter');
const { handle, resetIntentOperations } = require('../bin/intent/intent-entry');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');

const { nativeTargetRef } = require('../test-support/native-target-fixture');

const target = { platform: 'android', serial: 'native-long-press-test', packageName: 'example.notes', adb: '/test/adb', port: 19091 };
function node(extra = {}) {
  return { targetRef: nativeTargetRef(), visible: true, effectiveVisible: true, enabled: true, text: 'Note A', resourceName: 'example.notes:id/Title', contentDescription: 'Select note A',
    bounds: { left: 100, top: 200, right: 300, bottom: 260 }, children: [], ...extra };
}
function tree(children = [node()]) {
  return { root: node({ text: '', resourceName: 'root', contentDescription: '', bounds: { left: 0, top: 0, right: 600, bottom: 900 }, children }) };
}
function action(extra = {}) { return { action: 'longPress', provider: 'native', selector: { text: 'Note A' }, durationMs: 700, ...extra }; }
function harness(overrides = {}) {
  const calls = [];
  const device = createProductionIntentDeviceAdapter({ ports: {
    createBridgeContext: args => args,
    bridgeTree: async () => device.liveTree,
    nativeGesture: async (...args) => {
      calls.push(args);
      return { ok: true, transport: 'bridge', ...args[1] };
    },
    tap: async () => { throw new Error('longPress must not fall back to tap'); },
    swipe: async () => { throw new Error('longPress must not go through the native swipe action'); },
    ...overrides,
  } });
  return { device, calls };
}
const dispatch = (device, spec = action(), rawTree = tree()) => { device.liveTree = rawTree; return device.action({ ...target, actionId: 'host:longpress', spec, rawTree }); };

test('native longPress sends a bound target and action ID to the SDK', async () => {
  for (const selector of [{ text: 'Note A' }, { resourceName: 'example.notes:id/Title' }, { contentDescription: 'Select note A' }]) {
    const { device, calls } = harness();
    const result = await dispatch(device, action({ selector }));
    assert.equal(result.ok, true);
    const payload = { action: 'longPress', selector, targetRef: nativeTargetRef(), actionId: 'host:longpress', durationMs: 700 };
    assert.deepEqual(calls, [[{ serial: target.serial, packageName: target.packageName, adb: target.adb, port: target.port, runtimeActionId: 'host:longpress' }, payload]]);
    assert.deepEqual(result.providerResult, { ok: true, transport: 'bridge', ...payload });
  }
});

test('native longPress requires explicit bounded integer duration before any dispatch', async () => {
  for (const durationMs of [undefined, null, false, '700', NaN, Infinity, -Infinity, 0, -1, 499, 10001, 500.5]) {
    const { device, calls } = harness();
    const result = await dispatch(device, action({ durationMs }));
    assert.equal(result.error, 'invalid_long_press_duration');
    assert.equal(result.dispatched, false); assert.equal(result.ambiguous, false); assert.equal(calls.length, 0);
  }
  for (const durationMs of [500, 10000]) assert.equal((await dispatch(harness().device, action({ durationMs }))).ok, true);
});

test('native longPress rejects ambiguous/hidden/out-of-window nodes and invalid selectors', async () => {
  const cases = [
    [action({ selector: undefined, text: 'Note A' }), tree(), 'explicit_native_selector_required'],
    [action({ selector: { text: 'Note A', resourceName: 'example.notes:id/Title' } }), tree(), 'explicit_native_selector_required'],
    [action(), tree([node(), node()]), 'native_selector_ambiguous'],
    [action(), tree([node({ visible: false })]), 'native_selector_not_found'],
    [action(), tree([node({ enabled: false })]), 'native_selector_not_found'],
    [action(), tree([node({ bounds: { left: 600, top: 200, right: 700, bottom: 260 } })]), 'native_selector_not_found'],
    [action(), tree([node({ bounds: { left: NaN, top: 200, right: 300, bottom: 260 } })]), 'native_selector_not_found'],
    [action(), null, 'visible_observed_window_required'],
  ];
  for (const [spec, rawTree, error] of cases) {
    const { device, calls } = harness(); const result = await dispatch(device, spec, rawTree);
    assert.equal(result.error, error); assert.equal(result.dispatched, false); assert.equal(calls.length, 0);
  }
});

test('native longPress uses only the foreground dialog and rejects a covered activity', async () => {
  const rawTree = tree();
  rawTree.foregroundWindowId = 'dialog';
  rawTree.windows = [{ windowId: 'activity', root: rawTree.root }, { windowId: 'dialog', root: node({ text: '', bounds: { left: 100, top: 150, right: 450, bottom: 350 }, children: [node({ text: 'Dialog note' })] }) }];
  const { device, calls } = harness();
  assert.equal((await dispatch(device, action(), rawTree)).error, 'native_selector_not_found');
  assert.equal(calls.length, 0);
  assert.equal((await dispatch(device, action({ selector: { text: 'Dialog note' } }), rawTree)).ok, true);
  assert.equal(calls.length, 1);
});

test('unknown or ineligible foreground windows block longPress instead of falling back to the activity', async () => {
  for (const foreground of [
    { root: node({ text: 'Dialog', bounds: { left: 0, top: 0, right: NaN, bottom: 400 } }) },
    { root: node({ text: 'Dialog', enabled: false }) },
    { root: node({ text: 'Dialog', visible: undefined, effectiveVisible: undefined }) },
    { root: null },
  ]) {
    const rawTree = tree(); rawTree.foregroundWindowId = 'foreground';
    rawTree.windows = [{ windowId: 'activity', root: rawTree.root }, { ...foreground, windowId: 'foreground' }];
    const { device, calls } = harness(); const result = await dispatch(device, action(), rawTree);
    assert.equal(result.error, 'visible_observed_window_required'); assert.equal(result.dispatched, false); assert.equal(calls.length, 0);
  }
  const rawTree = tree(); rawTree.foregroundWindowId = 'activity';
  rawTree.windows = [{ windowId: 'activity', root: rawTree.root }, { windowId: 'hidden', root: node({ visible: false, effectiveVisible: false }) }];
  assert.equal((await dispatch(harness().device, action(), rawTree)).ok, true, 'SDK may select the Activity when the overlay is hidden');
});

test('native longPress never silently changes provider or falls back when its port is absent', async () => {
  for (const provider of ['uia', 'flutter']) {
    const { device, calls } = harness(); const result = await dispatch(device, action({ provider }));
    assert.equal(result.error, 'long_press_provider_unsupported'); assert.equal(result.dispatched, false); assert.equal(calls.length, 0);
  }
  const result = await dispatch(harness({ nativeGesture: undefined }).device);
  assert.equal(result.error, 'native_gesture_port_unavailable'); assert.equal(result.dispatched, false); assert.equal(result.ambiguous, false);
});

test('longPress uncertain transport failures and invalid receipts remain ambiguous', async () => {
  const thrown = await dispatch(harness({ nativeGesture: async () => { throw new Error('SDK disconnected after input'); } }).device);
  assert.equal(thrown.ok, false); assert.equal(thrown.ambiguous, true);
  const invalid = await dispatch(harness({ nativeGesture: async () => undefined }).device);
  assert.equal(invalid.error, 'invalid_action_receipt'); assert.equal(invalid.ambiguous, true);
});

test('Intent executor persists rejected and uncertain longPress receipts without claiming a safe success', async () => {
  resetIntentOperations();
  for (const [name, spec, rawTree, expectedError, expectedDispatched, expectedAmbiguous] of [
    ['invalid-duration', action({ durationMs: NaN }), tree(), 'invalid_argument', false, false],
    ['duplicate-node', action(), tree([node(), node()]), 'native_selector_ambiguous', false, false],
    ['lost-receipt', action(), tree(), 'ambiguous', true, true],
  ]) {
    let dispatched = 0;
    const { device } = harness({ bridgeTree: async () => rawTree, nativeGesture: async () => { dispatched += 1; throw new Error('SDK outcome unknown'); } });
    const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
    const start = await handle({ operation: 'start', operationId: `longPress-${name}`, goal: 'Select note', target, adapter: device, store });
    const result = await handle({ operation: 'decide', operationId: start.operationId, decision: { decisionId: name, agentDecision: 'act', basedOnRevision: start.revision, action: spec } });
    assert.equal(result.error, expectedError);
    assert.equal(dispatched, expectedDispatched ? 1 : 0);
    const receipt = store.latest(start.operationId, 'action-receipt');
    if (name === 'invalid-duration') {
      assert.equal(result.field, 'decision.action.durationMs');
      assert.equal(receipt, null);
      assert.equal(store.latest(start.operationId, 'decision'), null);
      continue;
    }
    assert.equal(receipt.dispatched, expectedDispatched); assert.equal(receipt.ambiguous, expectedAmbiguous); assert.equal(receipt.mechanicalStatus, 'failed');
  }
});

test('Intent records the selected SDK target and rejects stale revision reuse', async () => {
  resetIntentOperations();
  let observations = 0;
  const { device, calls } = harness({ bridgeTree: async () => { observations++; return tree(); } });
  const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const start = await handle({ operation: 'start', operationId: 'long-press-sdk-executor', goal: 'Select note A', target, adapter: device, store });
  assert.equal(start.status, 'waiting_for_decision');
  const before = store.latest(start.operationId, 'observation');
  const next = await handle({ operation: 'decide', operationId: start.operationId, decision: { decisionId: 'hold-note', agentDecision: 'act', basedOnRevision: start.revision, action: action() } });
  assert.equal(next.status, 'waiting_for_decision'); assert.equal(calls.length, 1); assert.equal(observations, 3);
  const receipt = store.latest(start.operationId, 'action-receipt');
  assert.equal(receipt.actionId, 'long-press-sdk-executor:hold-note');
  assert.equal(receipt.rawTreeId, before.rawTreeId); assert.equal(receipt.mechanicalStatus, 'ok');
  assert.equal(receipt.dispatched, true); assert.equal(receipt.ambiguous, false);
  assert.deepEqual(receipt.providerResult.providerResult, { ok: true, transport: 'bridge', ...calls[0][1] });
  assert.deepEqual(calls[0][1].targetRef, nativeTargetRef()); assert.equal(calls[0][1].actionId, receipt.actionId);
  const stale = await handle({ operation: 'decide', operationId: start.operationId, decision: { decisionId: 'stale-hold', agentDecision: 'act', basedOnRevision: start.revision, action: action() } });
  assert.equal(stale.error, 'reobserve_required'); assert.equal(calls.length, 1);
});
