'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { visibleNodes, assignmentDialogMatches, membershipMatches } = require('../ui-oracles');
const pkg = 'io.github.mobileaidev.notallyx.sample';
const res = name => `${pkg}:id/${name}`;
const node = props => ({ visible: true, effectiveVisible: true, enabled: true, alpha: 1, ...props });

test('assignment dialog identity cannot be proved by a covered background or a missing/duplicate control', () => {
  const expected = { labels: ['Project', 'Prefix-ab', 'Common'] };
  const dialog = node({ children: [node({ resourceName: res('alertTitle'), text: '标签' }),
    node({ resourceName: 'android:id/button2', text: '取消' }), node({ resourceName: 'android:id/button1', text: '保存' }),
    ...expected.labels.map(text => node({ resourceName: res('Text'), text }))] });
  assert.equal(assignmentDialogMatches(visibleNodes({ root: dialog }), expected), true);
  for (const root of [node({ children: [] }), { enabled: true }, null]) {
    assert.equal(assignmentDialogMatches(visibleNodes({ root: dialog, windows: [{ root: dialog }, { root }] }), expected), false);
  }
  for (let index = 0; index < dialog.children.length; index++) {
    const removed = structuredClone(dialog); removed.children.splice(index, 1);
    assert.equal(assignmentDialogMatches(visibleNodes({ root: removed }), expected), false);
    const duplicated = structuredClone(dialog); duplicated.children.push(duplicated.children[index]);
    assert.equal(assignmentDialogMatches(visibleNodes({ root: duplicated }), expected), false);
  }
  assert.throws(() => assignmentDialogMatches([], { labels: ['Project', 'Project', 'Common'] }), /host_assignment_labels_required/);
  // No assertion about a custom CheckBox drawable or selection state is made here.
});

test('membership requires exact page and members within the actual list viewport', () => {
  const expected = { title: 'Common', titles: ['Text', 'List'] };
  const root = node({ children: [node({ resourceName: res('Toolbar'), children: [node({ text: 'Common' })] }),
    node({ resourceName: res('MainListView'), bounds: { left: 0, top: 200, right: 1080, bottom: 2000 }, children:
      expected.titles.map((text, i) => node({ resourceName: res('Title'), text, bounds: { left: 20, top: 250 + i * 200, right: 1000, bottom: 350 + i * 200 } })) })] });
  const check = value => membershipMatches(visibleNodes({ root: value }), expected);
  assert.equal(check(root), true);
  for (const mutate of [r => { r.children[0].children[0].text = '笔记'; }, r => { r.children[1].children.pop(); },
    r => { r.children[1].children[1].text = 'Wrong'; }, r => { r.children[1].children.push(r.children[1].children[0]); },
    r => { r.children[1].children[1].bounds.bottom = 2100; }, r => { r.children[1].children[0].bounds.top = 100; }]) {
    const changed = structuredClone(root); mutate(changed); assert.equal(check(changed), false);
  }
  assert.throws(() => membershipMatches([], { title: 'Common', titles: ['Text', 'Text'] }), /host_membership_expectation_required/);
});
