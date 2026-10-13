'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { validateCommandArguments } = require('../bin/command-registry');
const { validateValue } = require('../bin/shared-kernel/argument-schema');
const web = require('../bin/shared-kernel/web-dom-target');
const android = require('../bin/shared-kernel/android-h5-target');
const ios = require('../bin/shared-kernel/ios-h5-target');
const flutter = require('../bin/shared-kernel/flutter-h5-target');
const element = { elementId: 'e1', tag: 'input', id: 'query', name: '', type: 'text', role: '',
  ariaLabel: '', placeholder: 'Search', href: '', text: 'original', visible: true, disabled: false,
  editable: true, checked: null, ariaChecked: null, value: 'original', bounds: { left: 0, top: 0 },
  interaction: { status: 'ready' }, context: { source: 'ancestor-dom-text', ancestors: [], truncated: false } };
const pages = [
  [web, { schemaVersion: web.schema, sessionId: 'browser', runtimeEpoch: 'epoch', targetId: 'main', navigationId: 'nav', url: 'https://example.test/' }],
  [android, { schemaVersion: android.schema, runtimeEpoch: 'epoch', packageName: 'app.test', processId: 42, activity: 'app.Main', windowId: 'window', webViewId: 'view', documentId: 'doc', url: 'https://example.test/' }],
  [ios, { schemaVersion: ios.schema, runtimeEpoch: 'epoch', bundleId: 'app.test', processId: 42, webViewId: 'view', documentId: 'doc', url: 'https://example.test/' }],
  [flutter, { schemaVersion: flutter.schema, runtimeEpoch: 'epoch', adapterId: 'article', adapterGeneration: 'generation', documentId: 'doc', url: 'https://example.test/' }],
];

for (const [contract, pageRef] of pages) {
  test(`${contract.schema} accepts full observations but still requires valid identity fields`, () => {
    const expectedTarget = { pageRef: { ...pageRef, viewport: { width: 1280 }, observedAt: 7 }, element };
    assert.doesNotThrow(() => validateValue(expectedTarget, contract.expectedTargetSchema));
    for (const part of ['pageRef', 'element']) {
      for (const key of contract.expectedTargetSchema.properties[part].required) {
        const missing = structuredClone(expectedTarget); delete missing[part][key];
        assert.throws(() => validateValue(missing, contract.expectedTargetSchema), error => error.code === 'missing_argument');
        const invalid = structuredClone(expectedTarget); invalid[part][key] = null;
        assert.throws(() => validateValue(invalid, contract.expectedTargetSchema), error => error.code === 'invalid_argument');
      }
    }
    assert.throws(() => validateValue({ elementId: 'e1', visible: true }, contract.selectorSchema), error => error.code === 'unsupported_argument');
  });
}

test('typed Web click/input and raw Web commands accept the original complete control', () => {
  const pageRef = { ...pages[0][1], viewport: { width: 1280 } }, expectedTarget = { pageRef, element };
  const bound = { sessionId: 'browser', runtimeEpoch: 'epoch', targetId: 'main' };
  for (const [command, extra] of [['web-click', {}], ['web-input', { value: 'next' }]]) {
    assert.deepEqual(validateCommandArguments(command, { ...bound, selector: { elementId: 'e1' }, expectedTarget, ...extra }).expectedTarget, expectedTarget);
    assert.throws(() => validateCommandArguments(command, { ...bound, selector: element, expectedTarget, ...extra }), error => error.code === 'unsupported_argument');
  }
  assert.doesNotThrow(() => validateCommandArguments('web-command', { ...bound, name: 'input',
    arguments: { selector: { elementId: 'e1' }, expectedTarget, value: 'next' } }));
});

for (const [contract, pageRef] of pages.slice(1)) {
  test(`${contract.schema} projects both observations before comparison and keeps original attributes for wire diagnostics`, () => {
    const expectedTarget = { pageRef: { ...pageRef, observation: 'before' }, element };
    const tree = { h5TargetSchema: contract.schema, pageRef: { ...pageRef, observation: 'after' },
      dom: { truncated: false, controls: [{ ...element, text: 'changed' }] } };
    const selected = contract.selectH5Node(tree, { elementId: 'e1' }, expectedTarget);
    assert.equal(selected.ok, true);
    assert.deepEqual(selected.targetRef.pageRef, pageRef);
    assert.deepEqual(Object.keys(selected.targetRef.element), ['elementId', 'tag', 'id', 'name', 'type', 'text', 'ariaLabel', 'href']);
    assert.equal(selected.targetRef.element.text, 'original');
    assert.equal(selected.node.text, 'changed');
    assert.equal(expectedTarget.element.context, element.context, 'caller observation is not mutated');
    for (const key of Object.keys(pageRef).filter(key => key !== 'schemaVersion')) {
      const stale = structuredClone(expectedTarget); stale.pageRef[key] = typeof pageRef[key] === 'number' ? 99 : 'different';
      assert.equal(contract.selectH5Node(tree, { elementId: 'e1' }, stale).error, 'reobserve_required', key);
    }
    const replaced = structuredClone(expectedTarget); replaced.element.elementId = 'old-element';
    assert.equal(contract.selectH5Node(tree, { elementId: 'e1' }, replaced).error, 'reobserve_required');
  });
}

test('raw Flutter H5 commands validate complete identity then project metadata before either platform wire', () => {
  const expectedTarget = { pageRef: { ...pages[3][1], viewport: { width: 1280 } }, element };
  for (const [command, target] of [['flutter-action', { serial: 'phone', packageName: 'app.test' }],
    ['ios-flutter-action', { deviceId: 'phone', bundleId: 'app.test' }]]) {
    const payload = { action: 'h5Control', operation: 'input', expectedTarget, text: 'next' };
    const result = validateCommandArguments(command, { ...target, payload });
    assert.deepEqual(result.payload.expectedTarget, flutter.projectTarget(expectedTarget));
    assert.equal(result.payload.expectedTarget.element.context, undefined);
    assert.equal(payload.expectedTarget.element.context, element.context);
    const invalid = structuredClone(payload); delete invalid.expectedTarget.pageRef.adapterGeneration;
    assert.throws(() => validateCommandArguments(command, { ...target, payload: invalid }), error => error.code === 'missing_argument');
    assert.throws(() => validateCommandArguments(command, { ...target, payload: { ...payload, extraAction: true } }), error => error.code === 'unsupported_argument');
  }
});
