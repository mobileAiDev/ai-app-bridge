'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { inputNativeText } = require('../bin/device-provider');
const { withNativeTargetRefs, nativeBridgeStatus, nativeExecutionReceipt } = require('../test-support/native-target-fixture');

test('a View replaced during slow advisory observation is freshly bound before input', async () => {
  const ctx = { serial: 'observation-freshness', packageName: 'example.native', explicitPackageName: true, httpTimeoutMs: 5000 };
  const makeTree = () => withNativeTargetRefs({ root: { resourceName: 'id/editor', visible: true, enabled: true, editable: true,
    text: 'old', bounds: { left: 0, top: 0, right: 100, bottom: 100 } } });
  const replacement = makeTree();
  replacement.root.targetRef.viewId = 'new-editor-after-navigation';
  let current = makeTree(), acceptedEffects = 0;
  const result = await inputNativeText(ctx, 'next', { selector: { resourceName: 'id/editor' } }, {
    foregroundWindow: async () => {
      await new Promise(resolve => setImmediate(resolve));
      current = replacement;
      return { ok: true, packageName: ctx.packageName, component: 'example.native/.Main', windowIdentity: 'window-1' };
    },
    bridgeTree: async () => structuredClone(current), bridgeStatus: nativeBridgeStatus,
    bridgePost: async (_ctx, _path, request) => {
      const same = request.targetRef.viewId === current.root.targetRef.viewId;
      if (same) acceptedEffects++;
      return nativeExecutionReceipt(request, same ? {} : { ok: false, error: 'native_target_replaced', dispatched: false });
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.dispatched, true);
  assert.equal(acceptedEffects, 1);
  assert.equal(result.executionReceipt.kind, 'native');
});
