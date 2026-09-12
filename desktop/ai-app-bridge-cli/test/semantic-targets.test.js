'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findTappableNodeByText, tapText } = require('../bin/device-provider');
const { createProductionIntentDeviceAdapter } = require('../bin/intent/intent-production-adapter');
const { runExecution, executionSleep } = require('../bin/shared-kernel/execution-scope');
const { nativeTargetRef } = require('../test-support/native-target-fixture');

const bounds = { left: 0, top: 0, right: 200, bottom: 400 };
const node = extra => ({ targetRef: nativeTargetRef(), visible: true, effectiveVisible: true, enabled: true, bounds, children: [], ...extra });

test('text selection cannot cross a foreground dialog or an unknown/disabled foreground root', () => {
  const background = node({ text: 'Delete account' });
  for (const foreground of [node({ text: 'Confirm' }), { bounds, children: [] }, node({ enabled: false })]) {
    const tree = { root: background, windows: [{ type: 'activity', root: background }, { type: 'dialog', root: foreground }] };
    assert.equal(findTappableNodeByText(tree, 'Delete account').node, null);
  }
  const tree = { windows: [{ type: 'activity', root: background }, { type: 'dialog', root: node({ visible: false }) }] };
  assert.equal(findTappableNodeByText(tree, 'Delete account').node, background);
});

test('a target clipped by or hidden below an ancestor is not actionable', () => {
  const target = node({ text: 'Delete account', bounds: { left: 0, top: 150, right: 100, bottom: 190 } });
  for (const container of [
    node({ visible: false, children: [target] }),
    node({ bounds: { left: 0, top: 0, right: 100, bottom: 100 }, children: [target] }),
    node({ enabled: false, children: [target] }),
  ]) assert.equal(findTappableNodeByText({ root: node({ children: [container] }) }, 'Delete account').node, null);
});

test('automatic discovery never targets the underlying Flutter page through a native dialog', async () => {
  let effects = 0;
  let flutterReads = 0;
  const background = node({ className: 'io.flutter.embedding.android.FlutterView' });
  const result = await tapText({ explicitPackageName: true, packageName: 'example.app' }, 'Delete account', {}, {
    foregroundWindow: async () => ({ ok: true, packageName: 'example.app', component: 'example.app/.Main' }),
    bridgeTree: async () => ({ windows: [{ type: 'activity', root: background }, { type: 'dialog', root: node({ text: 'Confirm' }) }] }),
    flutterNodes: async () => { flutterReads++; return { nodes: [{ text: 'Delete account', actions: ['tap'], bounds }] }; },
    uiaTree: async () => '<hierarchy><node text="Confirm" enabled="true" bounds="[0,0][200,400]" /></hierarchy>',
    flutterAction: async () => { effects++; return { ok: true }; },
    tap: async () => { effects++; return { ok: true }; },
  });
  assert.equal(result.error, 'target_not_found');
  assert.equal(result.dispatched, false);
  assert.equal(effects, 0);
  assert.equal(flutterReads, 0);
  assert.ok(result.observations.some(item => item.error === 'native_foreground_blocks_flutter'));
});

const target = { serial: 'semantic-device', packageName: 'example.app' };
const control = extra => node({ className: 'android.widget.EditText', resourceName: 'example.app:id/Name', text: 'Name', editable: true,
  bounds: { left: 20, top: 40, right: 100, bottom: 80 }, ...extra });
const nativeTree = children => ({ windows: [{ type: 'activity', root: node({ className: 'DecorView', children }) }] });

test('all native Intent selectors preserve target identity after layout movement', async () => {
  for (const spec of [
    { action: 'tap' }, { action: 'inputText', value: 'New name' },
    { action: 'longPress', durationMs: 600 }, { action: 'swipe', deltaX: 20, deltaY: 30, durationMs: 300 },
  ]) {
    const calls = [];
    let reads = 0;
    const capture = kind => async (_ctx, ...args) => { calls.push({ kind, args }); return { ok: true }; };
    const adapter = createProductionIntentDeviceAdapter({ ports: {
      createBridgeContext: args => args,
      bridgeTree: async () => { reads++; return nativeTree([control({ bounds: { left: 30, top: 100, right: 110, bottom: 140 } })]); },
      tap: capture('tap'), inputText: capture('input'), nativeGesture: capture('gesture'),
    } });
    const result = await adapter.action({ ...target, rawTree: nativeTree([control()]),
      spec: { provider: 'native', selector: { resourceName: 'example.app:id/Name' }, ...spec } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(reads, 1); assert.equal(calls.length, 1);
    if (spec.action === 'inputText') assert.deepEqual(calls[0].args[1].nativeTarget, { selector: { resourceName: 'example.app:id/Name' }, targetRef: nativeTargetRef() });
    else if (spec.action === 'tap') assert.deepEqual(calls[0].args.slice(0, 2), [70, 120]);
    else {
      assert.equal(calls[0].kind, 'gesture');
      assert.deepEqual(calls[0].args[0].targetRef, nativeTargetRef());
      assert.equal(calls[0].args[0].startX, undefined); assert.equal(calls[0].args[0].startY, undefined);
    }
  }
});

test('changed native identity, editability, ambiguity or foreground window rejects before dispatch', async () => {
  const dialog = nativeTree([control()]); dialog.windows.push({ type: 'dialog', root: node({ children: [control()] }) });
  for (const [current, action, error] of [
    [nativeTree([control({ text: 'Other account' })]), 'tap', 'reobserve_required'],
    [nativeTree([control({ editable: undefined })]), 'inputText', 'native_target_not_editable'],
    [nativeTree([control(), control()]), 'tap', 'native_selector_ambiguous'],
    [dialog, 'tap', 'reobserve_required'],
  ]) {
    let effects = 0;
    const adapter = createProductionIntentDeviceAdapter({ ports: { createBridgeContext: args => args,
      bridgeTree: async () => current, tap: async () => { effects++; }, inputText: async () => { effects++; } } });
    const result = await adapter.action({ ...target, rawTree: nativeTree([control()]),
      spec: { provider: 'native', action, selector: { resourceName: 'example.app:id/Name' }, value: 'New name' } });
    assert.equal(result.error, error); assert.equal(result.dispatched, false); assert.equal(result.ambiguous, false); assert.equal(effects, 0);
  }
});

test('deadline or cancellation during target revalidation never dispatches a late native action', async () => {
  for (const reason of ['deadline_exceeded', 'cancelled']) {
    let effects = 0;
    const controller = new AbortController();
    const adapter = createProductionIntentDeviceAdapter({ ports: { createBridgeContext: args => args,
      bridgeTree: async () => {
        if (reason === 'cancelled') controller.abort({ code: 'cancelled' });
        await executionSleep(1000);
        return nativeTree([control()]);
      }, tap: async () => { effects++; return { ok: true }; } } });
    const result = await runExecution({ timeoutMs: 30, signal: controller.signal, mutation: true }, () => adapter.action({
      ...target, rawTree: nativeTree([control()]), spec: { provider: 'native', action: 'tap', selector: { text: 'Name' } },
    }));
    assert.equal(result.error, reason); assert.equal(result.dispatched, false); assert.equal(result.ambiguous, false); assert.equal(effects, 0);
  }
});

test('Flutter node ID reuse with different text fails revalidation', async () => {
  let effects = 0;
  const flutterNode = { id: 12, text: 'Name', tap: { bounds: { left: 10, top: 20, right: 80, bottom: 60 } } };
  const adapter = createProductionIntentDeviceAdapter({ ports: { createBridgeContext: args => args,
    bridgeTree: async () => nativeTree([control()]),
    flutterNodes: async () => ({ nodes: [{ ...flutterNode, text: 'Delete account' }] }),
    flutterAction: async () => { effects++; return { ok: true }; } } });
  const result = await adapter.action({ ...target, rawTree: { nodes: [flutterNode] }, spec: { provider: 'flutter', action: 'tap', selector: { nodeId: '12' } } });
  assert.equal(result.error, 'reobserve_required'); assert.equal(result.dispatched, false); assert.equal(effects, 0);
});

test('the former text-only UIA Intent path now requires a unique exact match', async () => {
  let effects = 0;
  const xml = text => `<hierarchy><node package="example.app" text="${text}" enabled="true" bounds="[0,0][100,80]"/></hierarchy>`;
  const adapter = createProductionIntentDeviceAdapter({ ports: { createBridgeContext: args => args, uiaTreeOnce: async () => xml('Save'),
    tap: async () => { effects++; return { ok: true }; } } });
  for (const [rawTree, spec, error] of [
    [xml('Save as'), { text: 'Save' }, 'uia_selector_not_found'],
    [xml('Save'), { text: 'Save', exact: false }, 'explicit_exact_uia_selector_required'],
    [xml('Save').replace('</hierarchy>', '<node package="example.app" text="Save" enabled="true" bounds="[0,100][100,180]"/></hierarchy>'), { text: 'Save' }, 'uia_selector_not_unique'],
  ]) {
    const result = await adapter.action({ ...target, rawTree, spec: { provider: 'uia', action: 'tap', ...spec } });
    assert.equal(result.error, error); assert.equal(result.dispatched, false);
  }
  assert.equal(effects, 0);
});

test('a pinned Flutter text command also respects the native foreground window', async () => {
  let effects = 0;
  const result = await tapText({ ...target, explicitPackageName: true }, 'Name', { provider: 'flutter' }, {
    foregroundWindow: async () => ({ ok: true, packageName: target.packageName, component: 'example.app/.Main' }),
    bridgeTree: async () => ({ windows: [{ type: 'dialog', root: node({ text: 'Confirm' }) }] }),
    flutterNodes: async () => { throw new Error('background Flutter cannot be read'); },
    flutterAction: async () => { effects++; return { ok: true }; },
  });
  assert.equal(result.error, 'native_foreground_blocks_flutter'); assert.equal(result.dispatched, false); assert.equal(effects, 0);
});
