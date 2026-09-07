'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handle, resetIntentOperations } = require('../bin/intent/intent-entry');
const { createProductionIntentDeviceAdapter } = require('../bin/intent/intent-production-adapter');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { inputTextBridgePayload } = require('../bin/ai-app-bridge');
const target = { serial: 'native-edit-test', packageName: 'example.edit' };
function node(extra = {}) { return { visible: true, effectiveVisible: true, enabled: true, className: 'android.widget.EditText', resourceName: 'example.edit:id/title', text: 'Title', bounds: { left: 20, top: 40, right: 220, bottom: 100 }, children: [], ...extra }; }
function tree(children = [node()]) { return { root: node({ className: 'android.view.ViewGroup', text: '', resourceName: 'root', bounds: { left: 0, top: 0, right: 400, bottom: 800 }, children }) }; }
function adapter(calls = []) { return createProductionIntentDeviceAdapter({ ports: {
  createBridgeContext: (args) => args,
  inputText: async (...args) => { calls.push(['inputText', ...args]); return { ok: true }; },
  tap: async (...args) => { calls.push(['tap', ...args]); return { ok: true }; },
  swipe: async (...args) => { calls.push(['swipe', ...args]); return { ok: true }; },
  parseUiaViewport: () => { throw new Error('native JSON must not use UIA parser'); },
} }); }
function dispatch(device, action, rawTree = tree()) { return device.action({ ...target, actionId: 'edit:d1', spec: { provider: 'native', ...action }, rawTree }); }

test('native input uses unique visible editable selector and real runtime action options', async () => {
  const calls = [];
  const result = await dispatch(adapter(calls), { action: 'inputText', selector: { resourceName: 'example.edit:id/title' }, value: '新标题' });
  assert.equal(result.ok, true); assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'inputText'); assert.equal(calls[0][2], '新标题');
  assert.deepEqual(calls[0][3], { tapX: 120, tapY: 70, feedback: 'off', appLocalAction: true, runtimeActionId: 'edit:d1', requestId: 'edit:d1' });
  assert.deepEqual(inputTextBridgePayload('新标题', calls[0][3]), { text: '新标题', x: 120, y: 70, actionId: 'edit:d1' });
});
test('native selector rejects duplicate, invisible, noneditable and outside viewport without dispatch', async () => {
  const cases = [
    [tree([node(), node()]), 'native_selector_ambiguous'],
    [tree([node({ effectiveVisible: false })]), 'native_selector_not_found'],
    [tree([node({ className: 'android.widget.TextView' })]), 'native_target_not_editable'],
    [tree([node({ editable: false })]), 'native_target_not_editable'],
    [tree([node({ className: 'com.philkes.notallyx.presentation.view.StylableEditTextWithHistory' })]), 'native_target_not_editable'],
    [tree([node({ bounds: { left: 500, top: 10, right: 600, bottom: 100 } })]), 'native_selector_not_found'],
  ];
  for (const [rawTree, error] of cases) {
    const calls = []; const result = await dispatch(adapter(calls), { action: 'inputText', selector: { resourceName: 'example.edit:id/title' }, value: 'x' }, rawTree);
    assert.equal(result.error, error); assert.equal(result.ambiguous, false); assert.equal(result.dispatched, false); assert.equal(calls.length, 0);
  }
});
test('NotallyX custom editor requires the SDK editable type fact', async () => {
  const calls = [];
  const result = await dispatch(adapter(calls), { action: 'inputText', selector: { resourceName: 'example.edit:id/title' }, value: 'NotallyX title' },
    tree([node({ className: 'com.philkes.notallyx.presentation.view.StylableEditTextWithHistory', editable: true })]));
  assert.equal(result.ok, true); assert.equal(calls.length, 1); assert.equal(calls[0][0], 'inputText');
});
test('foreground dialog blocks underlying activity selectors and tap uses observed visible bounds', async () => {
  const rawTree = tree();
  rawTree.windows = [{ root: rawTree.root, bounds: rawTree.root.bounds }, { root: node({ resourceName: 'dialog', text: 'Confirm', className: 'android.widget.Button' }) }];
  const calls = []; const device = adapter(calls);
  const hidden = await dispatch(device, { action: 'tap', selector: { resourceName: 'example.edit:id/title' } }, rawTree);
  assert.equal(hidden.error, 'native_selector_not_found'); assert.equal(calls.length, 0);
  const tapped = await dispatch(device, { action: 'tap', selector: { text: 'Confirm' } }, rawTree);
  assert.equal(tapped.ok, true); assert.deepEqual(calls[0].slice(2, 4), [120, 70]);
});
test('unknown action cannot fall through to tap, including UIA', async () => {
  const calls = []; const device = adapter(calls);
  for (const provider of ['native', 'uia']) {
    const result = await dispatch(device, { provider, action: 'eraseEverything', text: 'Title' });
    assert.equal(result.error, 'unsupported_action'); assert.equal(result.dispatched, false);
  }
  assert.equal(calls.length, 0);
});
test('contentDescription selectors match the exact accessible name uniquely in the foreground', async () => {
  const button = node({ className: 'android.widget.ImageButton', text: '', contentDescription: '置于顶部' });
  const calls = []; const device = adapter(calls);
  assert.equal((await dispatch(device, { action: 'tap', selector: { contentDescription: '置于顶部' } }, tree([button]))).ok, true);
  assert.equal(calls.length, 1);
  const mismatch = await dispatch(device, { action: 'tap', selector: { text: '置于顶部' } }, tree([button]));
  assert.equal(mismatch.error, 'native_selector_not_found');
  const partial = await dispatch(device, { action: 'tap', selector: { contentDescription: '顶部' } }, tree([button]));
  assert.equal(partial.error, 'native_selector_not_found');
  const duplicate = await dispatch(device, { action: 'tap', selector: { contentDescription: '置于顶部' } }, tree([button, button]));
  assert.equal(duplicate.error, 'native_selector_ambiguous');
  const foreground = tree([button]); foreground.windows = [{ root: foreground.root }, { root: node({ text: 'Dialog', contentDescription: 'Cancel' }) }];
  const obscured = await dispatch(device, { action: 'tap', selector: { contentDescription: '置于顶部' } }, foreground);
  assert.equal(obscured.error, 'native_selector_not_found');
  assert.equal(calls.length, 1, 'ambiguous, partial and background matches never dispatch');
});
test('native scroll takes viewport from the current foreground root', async () => {
  const calls = []; const result = await dispatch(adapter(calls), { action: 'scroll', direction: 'down', durationMs: 250 });
  assert.equal(result.ok, true); assert.deepEqual(calls[0].slice(2), [200, 608, 200, 176, 250]);
});
test('Intent observe acquires and commits a fresh revision without a decision or mutation', async () => {
  resetIntentOperations(); let reads = 0; let actions = 0;
  const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const device = { observe: async ({ rawTreeId, provider }) => ({ ok: true, rawTreeId, provider, rawTree: tree([node({ text: `read-${++reads}` })]) }), action: async () => { actions++; return { ok: true }; } };
  const start = await handle({ operation: 'start', operationId: 'native-reobserve', goal: 'Edit', target, adapter: device, store });
  const next = await handle({ operation: 'observe', operationId: start.operationId, basedOnRevision: start.revision });
  assert.equal(next.ok, true); assert.equal(next.revision, 2); assert.notEqual(next.evidenceId, start.evidenceId); assert.equal(reads, 2); assert.equal(actions, 0);
  assert.equal(store.latest(start.operationId, 'observation').rawTree.root.children[0].text, 'read-2');
  assert.equal(store.latest(start.operationId, 'dispatch-marker'), null);
  const stale = await handle({ operation: 'decide', operationId: start.operationId, decision: { decisionId: 'old', basedOnRevision: 1, agentDecision: 'act', action: { action: 'tap', text: 'Title' } } });
  assert.equal(stale.error, 'reobserve_required'); assert.equal(actions, 0);
  handle({ operation: 'pause', operationId: start.operationId });
  const denied = await handle({ operation: 'observe', operationId: start.operationId });
  assert.equal(denied.error, 'not_waiting_for_decision'); assert.equal(reads, 2);
});
test('Intent cancellation during explicit observation remains cancelled', async () => {
  resetIntentOperations(); let resolve; let reads = 0;
  const device = { observe: async ({ rawTreeId, provider }) => { if (++reads > 1) await new Promise((done) => { resolve = done; }); return { ok: true, rawTreeId, provider, rawTree: tree() }; }, action: async () => { throw new Error('not allowed'); } };
  const first = await handle({ operation: 'start', operationId: 'observe-cancel', goal: 'Edit', target, adapter: device });
  const reading = handle({ operation: 'observe', operationId: first.operationId });
  handle({ operation: 'cancel', operationId: first.operationId }); resolve();
  assert.equal((await reading).status, 'cancelled');
});
