'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectNativeNode } = require('../bin/shared-kernel/native-target');
const { selectUiaNode } = require('../bin/shared-kernel/uia-target');
const { observedTarget, actionRequest } = require('../bin/shared-kernel/uia-protocol');
const { validateCommandArguments } = require('../bin/command-registry');
const { intentActionSchema } = require('../bin/shared-kernel/execution-contracts');
const { validateValue } = require('../bin/shared-kernel/argument-schema');
const { withActionGuidance } = require('../bin/shared-kernel/action-guidance');
const { withNativeTargetRefs } = require('../test-support/native-target-fixture');
const { uiaXml } = require('../test-support/uia-target-fixture');

const node = (extra = {}, children = []) => ({ text: '', resourceName: '', contentDescription: '',
  className: 'android.widget.LinearLayout', visible: true, enabled: true, clickable: false, checked: false,
  bounds: { left: 0, top: 0, right: 300, bottom: 500 }, ...extra, children });
const button = extra => node({ text: '同意', className: 'android.widget.Button', clickable: true, checkable: true, ...extra });
const fixture = () => node({}, [
  node({ text: '请阅读并同意条款', className: 'android.widget.TextView' }),
  node({ text: '同意', className: 'android.widget.TextView' }),
  node({ resourceName: 'id/row', contentDescription: 'Primary' }, [node({ text: '个人协议' }), button()]),
  node({ resourceName: 'id/row', contentDescription: 'Secondary' }, [node({ text: '企业协议' }), button({ checked: true })]),
]);
const xml = root => uiaXml(`<hierarchy>${serialize(root)}</hierarchy>`);
test('Native exact labels never confuse a truncated preview with a complete label; contains and viewId remain available', () => {
  const raw = withNativeTargetRefs({ root: button({ text: 'prefix', textTruncated: true }) });
  assert.equal(selectNativeNode(raw, { selector: { text: 'prefix' } }).ok, false);
  assert.equal(selectNativeNode(raw, { selector: { textContains: 'prefix' } }).ok, true);
  assert.equal(selectNativeNode(raw, { selector: { viewId: raw.root.targetRef.viewId } }).ok, true);
});
function serialize(node) {
  const names = { className: 'class', resourceName: 'resource-id', contentDescription: 'content-desc', visible: 'visible-to-user' };
  const attrs = Object.entries(node).filter(([key]) => !['children', 'bounds'].includes(key))
    .map(([key, value]) => `${names[key] || key}="${String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`).join(' ');
  return `<node package="test.app" ${attrs} bounds="[0,0][300,500]">${node.children.map(serialize).join('')}</node>`;
}

for (const provider of ['native', 'uia']) {
  const select = (selector, root = fixture()) => provider === 'native'
    ? selectNativeNode(withNativeTargetRefs({ root }), { selector }) : selectUiaNode(xml(root), { selector }, 'test.app');
  test(`${provider}: exact text and explicit contains combine with class/state, including false`, () => {
    assert.equal(select({ text: '同意' }).matched, 3);
    assert.equal(select({ textContains: '同意' }).matched, 4);
    assert.equal(select({ text: '同意', className: 'android.widget.Button' }).matched, 2);
    assert.equal(select({ textContains: '同意', clickable: true, checked: false }).ok, true);
    assert.equal(select({ textContains: '同意', clickable: true, checked: true }).ok, true);
    assert.equal(select({ contentDescriptionContains: 'Second', resourceName: 'id/row' }).ok, true);
    assert.equal(select({ text: '不存在', clickable: true }).matched, 0);
  });
  test(`${provider}: direct containers and neighboring labels select the intended row`, () => {
    for (const within of [
      { contentDescription: 'Secondary', resourceName: 'id/row' },
      { text: '企业协议', ancestor: { className: 'android.widget.LinearLayout', resourceName: 'id/row', parent: { className: 'android.widget.LinearLayout' } } },
    ]) {
      const result = select({ text: '同意', clickable: true, within });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.node.checked, provider === 'uia' ? 'true' : true);
    }
  });
  test(`${provider}: duplicate scopes and anchors are sets, with uniqueness applied to final targets`, () => {
    const root = fixture(); root.children[2].children[0].text = '企业协议';
    const within = { text: '企业协议', ancestor: { resourceName: 'id/row' } };
    assert.equal(select({ text: '同意', checked: true, within }, root).ok, true);
    assert.equal(select({ text: '同意', within }, root).matched, 2);
    assert.equal(select({ text: '同意', checked: true, within: { resourceName: 'id/row' } }, root).ok, true);
    assert.equal(select({ text: '同意', within: { resourceName: 'absent' } }, root).error, `${provider}_scope_not_found`);
  });
  test(`${provider}: hidden ancestors never contribute a matching child`, () => {
    const root = fixture(); root.children[3].visible = false;
    assert.equal(select({ text: '同意', clickable: true }, root).ok, true);
    assert.equal(select({ text: '同意', checked: true }, root).matched, 0);
  });
  test(`${provider}: public commands and Intent accept combinations and reject misspelled fields/types`, () => {
    const command = provider === 'uia' ? 'tap-uia' : 'tap-native';
    const selector = { textContains: '同意', className: 'android.widget.Button', clickable: true,
      within: { text: '企业协议', ancestor: { resourceName: 'id/row' } } };
    const args = { serial: 'd', packageName: 'test.app', selector };
    assert.deepEqual(validateCommandArguments(command, args), args);
    validateValue({ action: 'tap', provider, selector }, intentActionSchema(provider, 'android'));
    for (const bad of [{}, { text: '同意', clickable: 'true' }, { class: 'Button' }, { textContains: '' },
      { text: '同意', within: {} }, { text: '同意', within: { className: 'Row', ancestor: {} } }])
      assert.throws(() => validateCommandArguments(command, { ...args, selector: bad }));
    if (provider === 'native') {
      const older = withActionGuidance(command, args, { ok: false, error: 'unsupported_argument', field: 'selector.className', dispatched: false });
      assert.match(older.guidance.message, /app SDK/);
      assert.equal(older.guidance.nextActions[0].command, 'tree');
    }
    const code = `${provider}_scope_anchor_not_found`;
    const result = withActionGuidance(command, args, { ok: false, error: code, dispatched: false });
    assert.equal(result.guidance.nextActions[0].command, provider === 'uia' ? 'uia-tree' : 'tree');
    for (const call of result.guidance.nextActions) validateCommandArguments(call.command, call.arguments);
  });
}

test('UIA compound query binds exactly the selected observed node without widening its package', () => {
  const source = xml(fixture());
  const selector = { textContains: '同意', checked: true, within: { resourceName: 'id/row' } };
  const selected = selectUiaNode(source, { selector }, 'test.app');
  const binding = observedTarget(source, selected.node, selector, 'test.app');
  const { request } = actionRequest(binding, { timeoutMs: 1000 });
  assert.equal(request.target.selector.kind, 'nodeRef');
  assert.equal(request.target.selector.value, selected.node['aab-ref']);
  assert.equal(request.target.selector.packageName, 'test.app');
  assert.equal(selectUiaNode(source, { selector }, 'another.app').ok, false);
});

test('UIA class-named XML and self-closing siblings retain the correct scope ancestry', () => {
  const source = uiaXml('<hierarchy><android.widget.LinearLayout package="test.app" content-desc="row"><android.widget.TextView package="test.app" text="label"/><android.widget.Button package="test.app" text="同意" enabled="true" bounds="[0,0][100,80]"/></android.widget.LinearLayout></hierarchy>');
  assert.equal(selectUiaNode(source, { selector: { text: '同意', className: 'android.widget.Button', within: { text: 'label', ancestor: { contentDescription: 'row' } } } }, 'test.app').ok, true);
});

test('the Native convenience text path retains candidates beyond the former first 20', async () => {
  const tree = withNativeTargetRefs({ root: node({}, Array.from({ length: 65 }, () => button())) });
  const result = await require('../bin/device-provider').tapText({ serial: 'candidate-count', packageName: 'test.app', explicitPackageName: true }, '同意', {}, {
    foregroundWindow: async () => ({ ok: true, packageName: 'test.app' }), bridgeTree: async () => tree,
    tap: async () => assert.fail('No target has been chosen'),
  });
  assert.equal(result.matched, 65); assert.equal(result.candidates.length, 65);
  const chosen = selectNativeNode(tree, { selector: result.candidates[44].selector });
  assert.equal(chosen.node, tree.root.children[44]);
});

test('the UIA convenience text path retains references beyond the former first 20', () => {
  const source = xml(node({}, Array.from({ length: 65 }, () => button())));
  assert.throws(() => require('../bin/device-provider').findUiaNodeByAny(source, { texts: ['同意'], exact: true, requireUnique: true, packageName: 'test.app' }), error => {
    assert.equal(error.details.matched, 65); assert.equal(error.details.candidates.length, 65);
    const chosen = selectUiaNode(source, { selector: error.details.candidates[44].selector }, 'test.app');
    assert.equal(chosen.node['aab-ref'], error.details.candidates[44].targetRef.nodeRef);
    return true;
  });
});
