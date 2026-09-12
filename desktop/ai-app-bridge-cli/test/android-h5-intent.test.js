'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createH5Page } = require('../test-support/h5-renderer-fixture');
const h5 = require('../bin/shared-kernel/android-h5-target');
const { summarizeTree } = require('../bin/shared-kernel/summary-transformer');
const { createProductionIntentDeviceAdapter } = require('../bin/intent/intent-production-adapter');
const { normalizeObservationTarget } = require('../bin/intent/intent-observation-target');
const { intentProviderError } = require('../bin/intent/intent-provider');
const { validateCommandArguments, commandContract } = require('../bin/command-registry');
const renderer = fs.readFileSync(path.resolve(__dirname, '../../../shared/h5/renderer.js'), 'utf8')
  .replaceAll('__AAB_H5_STATE_KEY__', '__aabAndroidH5TargetV1').replaceAll('__AAB_H5_ERROR_PREFIX__', 'android_h5_');
function fixture() {
  const p = createH5Page(renderer);
  const editor = new p.Element('editor', '', 'INPUT');
  const button = new p.Element('save', 'Save', 'BUTTON');
  const snapshot = () => { const dom = p.snapshot(); return { ok: true, h5TargetSchema: h5.schema, dom,
    pageRef: { schemaVersion: h5.schema, runtimeEpoch: 'epoch', packageName: 'app.h5', processId: 42,
      activity: 'app.h5.Main', windowId: 'window', webViewId: 'webview', documentId: dom.documentId, url: dom.url } }; };
  return { p, editor, button, snapshot };
}

test('Android H5 summary exposes the actual document identity and empty editor', () => {
  const { snapshot } = fixture(), tree = snapshot();
  const summary = summarizeTree({ provider: 'h5', rawTree: tree, rawTreeId: 'observation-1' });
  assert.equal(summary.page.windowId, 'window');
  assert.equal(summary.nodes.find(node => node.elementId === 'e1').editable, true);
  assert.equal(intentProviderError({ platform: 'android' }, 'h5'), null);
  assert.deepEqual(normalizeObservationTarget({ platform: 'android' }, 'h5', { webViewId: 'webview' }), { webViewId: 'webview' });
});

test('Android renderer rejects changed route, original-node replacement, and native-probe geometry changes', () => {
  for (const change of ['route', 'replace', 'geometry']) {
    const { p, button, snapshot } = fixture(); p.hit = button;
    const selected = h5.selectH5Node(snapshot(), { text: 'Save' });
    const action = { operation: 'action', action: 'click', ...selected.targetRef };
    action.geometry = p.run({ ...action, operation: 'prepare' }).geometry;
    if (change === 'route') { p.history.pushState(null, '', 'changed'); p.history.replaceState(null, '', action.pageRef.url); }
    if (change === 'replace') { button.connected = false; new p.Element('save', 'Save', 'BUTTON'); }
    if (change === 'geometry') p.setScroll(0, 10);
    assert.equal(p.run(action).error, 'reobserve_required', change); assert.deepEqual(p.events, []);
  }
});

test('Android H5 Intent forwards the observed WebView and original action identity through the typed port', async () => {
  const { snapshot } = fixture(), tree = snapshot(), calls = [];
  const adapter = createProductionIntentDeviceAdapter({ ports: {
    createBridgeContext: target => ({ ...target, actionId: target.runtimeActionId }),
    h5Dom: async (ctx, options) => { calls.push({ ctx, options }); return tree; },
    h5Control: async (ctx, action, options) => { calls.push({ ctx, action, options }); return { ok: true, dispatched: true }; },
  } });
  const target = { serial: 'h5-fixture', packageName: 'app.h5', provider: 'h5', observationTarget: { webViewId: 'webview' } };
  const observation = await adapter.observe(target);
  assert.equal(observation.ok, true); assert.deepEqual(calls[0].options, target.observationTarget);
  const result = await adapter.action({ ...target, actionId: 'original-intent-decision', rawTree: observation.rawTree,
    spec: { provider: 'h5', action: 'inputText', selector: { elementId: 'e1' }, value: '' } });
  assert.equal(result.ok, true);
  assert.equal(calls[1].ctx.actionId, 'original-intent-decision'); assert.equal(calls[1].action, 'input');
  assert.equal(calls[1].options.text, ''); assert.deepEqual(calls[1].options.expectedTarget.pageRef, tree.pageRef);
  assert.equal(calls[1].options.webViewId, 'webview');
});

test('public Android H5 parameters are explicit and shared by CLI, MCP and Script', () => {
  const target = { serial: 'phone', packageName: 'app.h5' };
  assert.doesNotThrow(() => validateCommandArguments('h5-input', { ...target, selector: { ariaLabel: 'Editor' }, text: '' }));
  assert.throws(() => validateCommandArguments('h5-input', { ...target, selector: '#editor', value: '' }));
  assert.throws(() => validateCommandArguments('h5-eval', { ...target, script: '1' }));
  assert.throws(() => validateCommandArguments('h5-scroll', { ...target, deltaX: 0, deltaY: 0 }));
  assert.doesNotThrow(() => validateCommandArguments('h5-scroll', { ...target, deltaX: 0, deltaY: 480 }));
  assert.deepEqual(commandContract('h5-input').entrypoints, { cli: true, mcp: true, script: true });
  assert.equal(commandContract('h5-wait').execution.mutation, false);
});
