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
    Object.entries({ ...original.targetRef, ...change }).reverse()) };
  const calls = [];
  const fresh = () => ({ ok: true, truncated: false, nodes: [current] });
  const action = payload => { calls.push(payload); return { ok: true }; };
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
  return { calls, current, act: () => adapter.action({ deviceId: 'phone', bundleId: 'sample',
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
    test(`${platform} Flutter Intent rejects a changed ${field} before dispatch`, async () => {
      const h = fixture(platform, { [field]: value });
      assert.equal((await h.act()).error, 'reobserve_required');
      assert.deepEqual(h.calls, []);
    });
  }

  for (const [field, value] of [['label', 'Weight (lb)'], ['hint', 'Load in lb']]) {
    test(`${platform} Flutter Intent rejects a changed field ${field} before dispatch`, async () => {
      const h = fixture(platform, {}, { [field]: value });
      assert.equal((await h.act()).error, 'reobserve_required');
      assert.deepEqual(h.calls, []);
    });
  }

  test(`${platform} Flutter Intent allows a validation message to change on the same editor`, async () => {
    const h = fixture(platform, {}, { errorText: 'Weight must be positive' });
    assert.equal((await h.act()).ok, true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].text, '45');
  });
}
