'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tapNative } = require('../bin/device-provider');
const { commandContract, commandSchema, validateCommandArguments, parseCliOptions } = require('../bin/command-registry');
const { nativeSelector } = require('../bin/shared-kernel/execution-contracts');
const { withNativeTargetRefs, nativeBridgeStatus, nativeExecutionReceipt } = require('../test-support/native-target-fixture');

const ctx = { serial: 'native-tap', packageName: 'example.native', explicitPackageName: true, httpTimeoutMs: 5000 };
const foreground = { ok: true, packageName: ctx.packageName, component: 'example.native/.Main' };
const selector = { resourceName: 'id/open', within: { text: 'Second', ancestor: { resourceName: 'id/row' } } };
function tree() {
  const view = (resourceName, top, bottom, extra = {}) => ({ resourceName, visible: true, enabled: true,
    bounds: { left: 0, top, right: 400, bottom }, ...extra });
  return withNativeTargetRefs({ root: view('id/root', 0, 800, { children: ['First', 'Second'].map((text, index) =>
    view('id/row', index * 300, index * 300 + 300, { children: [
      view('id/title', index * 300, index * 300 + 100, { text }),
      view('id/open', index * 300 + 100, index * 300 + 200, { text: 'Open', clickable: true }),
    ] })) }) });
}

test('tap-native shares the Intent selector contract with CLI, MCP and Script', () => {
  const contract = commandContract('tap-native');
  assert.deepEqual(contract.entrypoints, { mcp: true, cli: true, script: true });
  assert.equal(contract.script.permission, 'app.interact');
  assert.equal(contract.execution.mutation, true);
  assert.deepEqual(commandSchema('tap-native').properties.selector, nativeSelector);
  const target = { serial: ctx.serial, packageName: ctx.packageName };
  assert.deepEqual(validateCommandArguments('tap-native', parseCliOptions('tap-native', { ...target, selector: JSON.stringify(selector) })), { ...target, selector });
  for (const bad of [{}, { text: 'Open', resourceName: 'id/open' }, { text: 'Open', within: { text: 'Second' } }]) {
    assert.throws(() => validateCommandArguments('tap-native', { ...target, selector: bad }));
  }
  assert.throws(() => validateCommandArguments('tap-native', { ...target, selector, targetRef: {} }));
  assert.throws(() => validateCommandArguments('tap-native', { serial: ctx.serial, selector }), { code: 'missing_argument', field: 'packageName' });
});

test('a scoped repeated control sends one bound SDK tap and retains its original receipt', async () => {
  const snapshot = tree(), calls = [];
  const result = await tapNative(ctx, { selector, requestId: 'script:call:tap' }, {
    foregroundWindow: async () => foreground, bridgeTree: async () => snapshot, bridgeStatus: nativeBridgeStatus,
    bridgePost: async (_ctx, endpoint, body) => { calls.push({ endpoint, body }); return nativeExecutionReceipt(body); },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.executionReceipt.kind, 'native');
  assert.equal(result.executionReceipt.actionId, 'script:call:tap');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, '/v1/action/tap-target');
  assert.deepEqual(calls[0].body.selector, selector);
  assert.deepEqual(calls[0].body.targetRef, snapshot.root.children[1].children[1].targetRef);
  assert.equal(Object.hasOwn(calls[0].body, 'x'), false);
  assert.equal(Object.hasOwn(calls[0].body, 'y'), false);
});

test('ambiguous, replaced, wrong-foreground and unbound selections never dispatch', async () => {
  for (const scenario of ['ambiguous', 'replaced', 'foreground', 'unbound']) {
    const original = tree(), changed = structuredClone(original);
    if (scenario === 'replaced') changed.root.children[1].children[1].targetRef.viewId = 'replaced-view';
    if (scenario === 'unbound') delete original.root.children[1].children[1].targetRef;
    let reads = 0, foregroundReads = 0;
    const result = await tapNative(ctx, { selector: scenario === 'ambiguous' ? { text: 'Open' } : selector }, {
      foregroundWindow: async () => scenario === 'foreground' && ++foregroundReads > 1
        ? { ...foreground, component: 'example.native/.Other' } : foreground,
      bridgeTree: async () => scenario === 'replaced' && ++reads > 1 ? changed : original,
      bridgePost: async () => assert.fail('No mutation may be sent'),
    });
    assert.equal(result.ok, false, scenario); assert.equal(result.dispatched, false, scenario);
    assert.equal(result.error, { ambiguous: 'native_selector_ambiguous', replaced: 'reobserve_required',
      foreground: 'foreground_changed_during_observation', unbound: 'native_atomic_target_unavailable' }[scenario]);
  }
});
