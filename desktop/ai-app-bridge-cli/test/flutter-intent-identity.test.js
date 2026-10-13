'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createIOSIntentDeviceAdapter } = require('../bin/intent/ios-intent-adapter');
const { createProductionIntentDeviceAdapter } = require('../bin/intent/intent-production-adapter');
const { createTargetLease } = require('../bin/shared-kernel/target-lease-protocol');

function fixture(platform, change = {}, nodeChange = {}) {
  const bounds = { left: 20, top: 40, right: 100, bottom: 80 };
  const original = { id: 'weight', text: '42.5', value: '42.5', label: 'Weight (kg)',
    hint: 'Load in kg', widgetType: 'EditableText', role: 'input',
    input: { bounds }, targetRef: { schemaVersion: 'aab.flutter-target/v1',
      runtimeEpoch: 'engine-1', elementId: 'weight', guard: 'guard-1' } };
  // Swift dictionaries do not preserve the key order of the Dart JSON payload.
  const current = { ...original, ...nodeChange, targetRef: Object.fromEntries(
    Object.entries({ ...original.targetRef,
      ...(nodeChange.label || nodeChange.hint ? { guard: 'changed-editor-semantics' } : {}), ...change }).reverse()) };
  const calls = [], effects = [];
  const fresh = () => ({ ok: true, truncated: false, nodes: [current] });
  const action = payload => {
    calls.push(payload);
    const error = payload.targetRef.runtimeEpoch !== current.targetRef.runtimeEpoch ? 'flutter_runtime_changed'
      : payload.targetRef.elementId !== current.targetRef.elementId ? 'flutter_target_replaced'
        : payload.targetRef.guard !== current.targetRef.guard ? 'flutter_target_changed' : null;
    if (error) return { ok: false, error, dispatched: false, ambiguous: false };
    effects.push(payload); return { ok: true };
  };
  const adapter = platform === 'ios'
    ? createIOSIntentDeviceAdapter({ provider: { async run(command, args) {
      return command === 'ios-flutter-nodes' ? fresh() : action(args.payload);
    } } })
    : createProductionIntentDeviceAdapter({ lease: createTargetLease(), ports: {
      createBridgeContext: args => args,
      bridgeTree: async () => ({ root: { visible: true, bounds } }),
      flutterNodes: async () => fresh(),
      flutterAction: async (_ctx, payload) => action(payload),
    } });
  return { calls, effects, current, act: () => adapter.action({ deviceId: 'phone', bundleId: 'sample',
    serial: 'phone', packageName: 'sample', actionId: 'intent:weight',
    rawTree: { ok: true, truncated: false, nodes: [original] },
    spec: { provider: 'flutter', action: 'inputText', selector: { nodeId: 'weight' },
      value: '45' } }) };
}

for (const platform of ['ios', 'android']) {
  test(`${platform} Flutter Intent accepts the same identity with reordered JSON keys`, async () => {
    const h = fixture(platform);
    assert.equal((await h.act()).ok, true);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0].targetRef, h.current.targetRef);
  });

  for (const [field, value] of [['runtimeEpoch', 'engine-2'], ['elementId', 'replacement'], ['guard', 'guard-2']]) {
    test(`${platform} Flutter Intent rejects a changed ${field} before input`, async () => {
      const h = fixture(platform, { [field]: value });
      const result = await h.act();
      assert.equal(result.error, platform === 'ios' ? 'reobserve_required' : {
        runtimeEpoch: 'flutter_runtime_changed', elementId: 'flutter_target_replaced', guard: 'flutter_target_changed',
      }[field]);
      assert.equal(result.dispatched, false);
      assert.equal(h.calls.length, platform === 'ios' ? 0 : 1);
      assert.deepEqual(h.effects, []);
    });
  }

  for (const [field, value] of [['label', 'Weight (lb)'], ['hint', 'Load in lb']]) {
    test(`${platform} Flutter Intent rejects a changed field ${field} before input`, async () => {
      const h = fixture(platform, {}, { [field]: value });
      const result = await h.act();
      assert.equal(result.error, platform === 'ios' ? 'reobserve_required' : 'flutter_target_changed');
      assert.equal(result.dispatched, false);
      assert.equal(h.calls.length, platform === 'ios' ? 0 : 1);
      assert.deepEqual(h.effects, []);
    });
  }

  test(`${platform} Flutter Intent allows a validation message to change on the same editor`, async () => {
    const h = fixture(platform, {}, { errorText: 'Weight must be positive' });
    assert.equal((await h.act()).ok, true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].text, '45');
  });
}
