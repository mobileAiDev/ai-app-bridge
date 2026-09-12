'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inputNativeText } = require('../bin/device-provider');
const { commandContract, commandSchema, validateCommandArguments, parseCliOptions } = require('../bin/command-registry');
const { nativeSelector } = require('../bin/shared-kernel/execution-contracts');
const { withNativeTargetRefs, nativeBridgeStatus, nativeExecutionReceipt } = require('../test-support/native-target-fixture');

const ctx = { serial: 'native-input-selector', packageName: 'example.native', explicitPackageName: true, httpTimeoutMs: 5000 };
const foreground = { ok: true, packageName: ctx.packageName, component: 'example.native/.Main' };
const selector = { resourceName: 'id/editor', within: { text: 'Second', ancestor: { resourceName: 'id/row' } } };
function tree() {
  const view = (resourceName, top, bottom, extra = {}) => ({ resourceName, visible: true, enabled: true,
    bounds: { left: 0, top, right: 400, bottom }, ...extra });
  return withNativeTargetRefs({ root: view('id/root', 0, 800, { children: ['First', 'Second'].map((text, index) =>
    view('id/row', index * 300, index * 300 + 300, { children: [
      view('id/title', index * 300, index * 300 + 100, { text }),
      view('id/editor', index * 300 + 100, index * 300 + 200, { text: 'Previous', editable: true }),
    ] })) }) });
}

test('input-text exposes the Intent selector and empty text to CLI, MCP and Script', () => {
  const contract = commandContract('input-text');
  assert.deepEqual(contract.entrypoints, { mcp: true, cli: true, script: true });
  assert.equal(contract.script.permission, 'app.interact');
  assert.deepEqual(commandSchema('input-text').properties.selector, nativeSelector);
  const target = { serial: ctx.serial, packageName: ctx.packageName, text: '' };
  assert.deepEqual(validateCommandArguments('input-text', parseCliOptions('input-text', {
    ...target, selector: JSON.stringify(selector),
  })), { ...target, selector });
  for (const extra of [{ selector: {} }, { selector, tapX: 1, tapY: 2 }, { selector, nativeTarget: {} },
    { selector: { text: 'Previous', resourceName: 'id/editor' } }])
    assert.throws(() => validateCommandArguments('input-text', { ...target, ...extra }));
  assert.throws(() => validateCommandArguments('input-text', { serial: ctx.serial, selector, text: 'x' }),
    { code: 'missing_argument', field: 'packageName' });
});

test('scoped Unicode input and clearing dispatch to the original editor with native completion receipts', async () => {
  for (const text of ['地图 Musée\n第二行', '']) {
    const snapshot = tree(), calls = [], actionId = text ? 'input-unicode' : 'input-clear';
    const result = await inputNativeText(ctx, text, { selector, requestId: actionId }, {
      foregroundWindow: async () => foreground, bridgeTree: async () => snapshot, bridgeStatus: nativeBridgeStatus,
      bridgePost: async (_ctx, endpoint, body) => { calls.push({ endpoint, body }); return nativeExecutionReceipt(body); },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.executionReceipt.kind, 'native');
    assert.equal(result.executionReceipt.actionId, actionId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpoint, '/v1/action/input-target');
    assert.equal(calls[0].body.text, text);
    assert.deepEqual(calls[0].body.selector, selector);
    assert.deepEqual(calls[0].body.targetRef, snapshot.root.children[1].children[1].targetRef);
    assert.equal(Object.hasOwn(calls[0].body, 'x'), false);
    assert.equal(Object.hasOwn(calls[0].body, 'y'), false);
  }
});

test('ambiguous, replaced, noneditable, wrong-foreground and unbound editors never receive input', async () => {
  const errors = { ambiguous: 'native_selector_ambiguous', replaced: 'reobserve_required',
    noneditable: 'native_target_not_editable', foreground: 'foreground_changed_during_observation',
    unbound: 'native_atomic_target_unavailable' };
  for (const [scenario, error] of Object.entries(errors)) {
    const original = tree(), changed = structuredClone(original);
    if (scenario === 'replaced') changed.root.children[1].children[1].targetRef.viewId = 'replacement';
    if (scenario === 'noneditable') original.root.children[1].children[1].editable = false;
    if (scenario === 'unbound') delete original.root.children[1].children[1].targetRef;
    let reads = 0, foregroundReads = 0;
    const result = await inputNativeText(ctx, 'must-not-write', { selector: scenario === 'ambiguous' ? { text: 'Previous' } : selector }, {
      foregroundWindow: async () => scenario === 'foreground' && ++foregroundReads > 1
        ? { ...foreground, component: 'example.native/.Other' } : foreground,
      bridgeTree: async () => scenario === 'replaced' && ++reads > 1 ? changed : original,
      bridgePost: async () => assert.fail('No mutation may be sent'),
    });
    assert.equal(result.ok, false, scenario);
    assert.equal(result.dispatched, false, scenario);
    assert.equal(result.error, error, scenario);
  }
});
