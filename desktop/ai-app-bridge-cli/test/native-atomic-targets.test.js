'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tap, tapText, inputTextBridgePayload } = require('../bin/device-provider');
const { createProductionIntentDeviceAdapter } = require('../bin/intent/intent-production-adapter');
const { nativeTargetRequest } = require('../bin/shared-kernel/native-target');
const { nativeTargetRef, nativeBridgeStatus: bridgeStatus, nativeExecutionReceipt } = require('../test-support/native-target-fixture');

const ctx = { serial: 'atomic-fixture', packageName: 'example.atomic', explicitPackageName: true, httpTimeoutMs: 5000 };
const foregroundWindow = async () => ({ ok: true, packageName: ctx.packageName, component: `${ctx.packageName}/.Main` });
const selector = { resourceName: 'id/Save' };
const targetRef = nativeTargetRef();
const nativeTarget = { selector, targetRef };
const tree = (ref = targetRef) => ({ root: { text: 'Save', resourceName: 'id/Save', editable: true,
  visible: true, enabled: true, bounds: { left: 0, top: 0, right: 100, bottom: 80 }, targetRef: ref } });

test('Native semantic tap sends its selector and reference without coordinates to a distinct SDK endpoint', async () => {
  const calls = [];
  const result = await tap(ctx, 50, 40, { nativeTarget, runtimeActionId: 'action-1' }, {
    foregroundWindow, bridgeStatus, adb: async () => { throw new Error('no device input'); },
    bridgePost: async (_ctx, endpoint, payload) => { calls.push({ endpoint, payload }); return nativeExecutionReceipt(payload, { targetValidation: targetRef.schemaVersion }); },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ endpoint: '/v1/action/tap-target', payload: { ...nativeTarget, actionId: 'action-1', execution: { schemaVersion: 'aab.native-execution/v1', actionId: 'action-1', runtimeEpoch: 'fixture-epoch', timeoutMs: 5000 } } }]);
});

test('SDK rejection or absent atomic endpoint never retries a coordinate or device action', async () => {
  for (const error of ['native_target_replaced', 'native_window_changed', 'native_target_obscured', 'HTTP 404: Not found']) {
    let attempts = 0;
    const result = await tap(ctx, 50, 40, { nativeTarget }, { foregroundWindow, bridgeStatus,
      adb: async () => { throw new Error('must not fall back'); },
      bridgePost: async (_ctx, endpoint) => {
        attempts++; assert.equal(endpoint, '/v1/action/tap-target');
        if (error.startsWith('HTTP')) throw Object.assign(new Error(error), { code: 'endpoint_unavailable', dispatched: false });
        return { ok: false, error, dispatched: false, ambiguous: false };
      },
    });
    assert.equal(attempts, 1); assert.equal(result.ok, false); assert.equal(result.dispatched, false); assert.equal(result.ambiguous, false);
    assert.equal(result.error, error.startsWith('HTTP') ? 'endpoint_unavailable' : error);
  }
});

test('coordinate tap remains an explicit primitive and a semantic target cannot become device input', async () => {
  let calls = 0;
  const dependencies = { foregroundWindow, bridgeStatus, bridgePost: async (_ctx, endpoint, payload) => {
    calls++; assert.equal(endpoint, '/v1/action/tap'); assert.equal(payload.x, 0); assert.equal(payload.y, 20); assert.equal(payload.execution.actionId, payload.actionId); return nativeExecutionReceipt(payload);
  }, adb: async () => { throw new Error('no device input'); } };
  assert.equal((await tap(ctx, 0, 20, {}, dependencies)).ok, true);
  for (const [context, options] of [[ctx, { nativeTarget, scope: 'device' }], [{ ...ctx, explicitPackageName: false }, { nativeTarget }]]) {
    assert.equal((await tap(context, 0, 20, options, dependencies)).error, 'native_target_requires_app_scope');
  }
  assert.equal(calls, 1);
});

test('automatic text discovery stops on a matched Native control without an SDK reference', async () => {
  const calls = [];
  const result = await tapText(ctx, 'Save', {}, { foregroundWindow, bridgeTree: async () => tree(null),
    flutterNodes: async () => { calls.push('flutter'); }, uiaTree: async () => { calls.push('uia'); },
    tap: async () => { calls.push('tap'); },
  });
  assert.equal(result.error, 'native_atomic_target_unavailable');
  assert.equal(result.dispatched, false); assert.equal(result.ambiguous, false); assert.deepEqual(calls, []);
});

test('text targeting carries an exact accessible-name selector and rejects replacement during observation', async () => {
  let reads = 0, effects = 0;
  const options = { foregroundWindow, bridgeTree: async () => tree(++reads === 1 ? targetRef : { ...targetRef, viewId: 'replacement' }),
    tap: async () => { effects++; }, uiaTree: async () => { throw new Error('no fallback'); } };
  assert.equal((await tapText(ctx, 'Save', {}, options)).error, 'reobserve_required');
  assert.equal(effects, 0);
  const accessible = tree(); accessible.root.text = ''; accessible.root.contentDescription = '保存';
  const result = await tapText(ctx, '保存', { provider: 'native' }, { foregroundWindow, bridgeTree: async () => accessible,
    tap: async (_ctx, _x, _y, options) => {
      assert.deepEqual(options.nativeTarget, { selector: { contentDescription: '保存' }, targetRef }); return { ok: true };
    },
  });
  assert.equal(result.ok, true);
});

test('Intent checks View instance identity and refuses missing metadata before invoking either mutation port', async () => {
  for (const action of [{ action: 'tap' }, { action: 'inputText', value: '' }]) {
    for (const replacement of [true, false]) {
      let effects = 0;
      const observed = tree(replacement ? targetRef : null);
      const current = tree(replacement ? { ...targetRef, viewId: 'new-view' } : null);
      const adapter = createProductionIntentDeviceAdapter({ ports: { createBridgeContext: args => args,
        bridgeTree: async () => current, tap: async () => { effects++; }, inputText: async () => { effects++; } } });
      const result = await adapter.action({ ...ctx, rawTree: observed, spec: { provider: 'native', selector, ...action } });
      assert.equal(result.error, replacement ? 'reobserve_required' : 'native_atomic_target_unavailable');
      assert.equal(result.dispatched, false); assert.equal(result.ambiguous, false); assert.equal(effects, 0);
    }
  }
});

test('Native input payload preserves empty input and cannot combine a reference with coordinates', () => {
  assert.deepEqual(inputTextBridgePayload('', { nativeTarget, runtimeActionId: 'input-1' }), { text: '', ...nativeTarget, actionId: 'input-1' });
  assert.throws(() => inputTextBridgePayload('x', { nativeTarget, tapX: 20, tapY: 30 }), { code: 'conflicting_input_target' });
});

test('unsupported or malformed target metadata is explicit and never silently filled', () => {
  for (const ref of [null, {}, { ...targetRef, schemaVersion: 'v0' }]) assert.equal(nativeTargetRequest({ targetRef: ref }, selector).error, 'native_atomic_target_unavailable');
  for (const ref of [{ ...targetRef, guard: 'x' }, { ...targetRef, viewId: 1 }, { ...targetRef, extra: true }]) {
    assert.equal(nativeTargetRequest({ targetRef: ref }, selector).error, 'invalid_native_target_reference');
  }
});
