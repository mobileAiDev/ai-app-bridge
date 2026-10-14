'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compactUiaTree } = require('../bin/device-provider');
const { summarizeTree } = require('../bin/shared-kernel/summary-transformer');
const { uiaXml } = require('../test-support/uia-target-fixture');

test('default UIA compact read reaches the foreground page after hundreds of hidden background nodes', () => {
  const background = Array.from({ length: 650 }, (_, i) => `<node text="Old feed ${i}" visible-to-user="false" bounds="[0,0][0,0]"/>`).join('');
  const xml = `<hierarchy aab-truncated="false"><node bounds="[0,0][1080,2376]">${background}<node text="Author profile" visible-to-user="true" bounds="[20,150][500,210]"/></node></hierarchy>`;
  const visible = compactUiaTree(xml, { maxNodes: 80 });
  assert.ok(visible.nodes.some(node => node.text === 'Author profile'));
  assert.equal(visible.truncated, false);
  assert.equal(visible.options.visibleOnly, true);
  assert.equal(visible.coverage.projection.filtered, true);
  const all = compactUiaTree(xml, { visibleOnly: false, maxNodes: 1000 });
  assert.equal(all.nodes.length, 652);
  assert.equal(all.options.visibleOnly, false);
});

test('visible UIA observation retains partially visible controls with negative coordinates', () => {
  const xml = '<hierarchy><node bounds="[0,0][100,200]">'
    + '<node text="Partly visible" visible-to-user="true" bounds="[-80,20][10,60]"/>'
    + '<node text="Offscreen" bounds="[-100,20][-10,60]"/></node></hierarchy>';
  const tree = compactUiaTree(xml);
  assert.deepEqual(tree.nodes.map(node => node.text).filter(Boolean), ['Partly visible']);
  assert.equal(tree.nodes[1].bounds.left, -80);
});

test('UIA compact focus and selection preserve reported booleans and leave missing state unknown', () => {
  const tree = compactUiaTree('<hierarchy><node bounds="[0,0][100,200]">'
    + '<node text="Editor" focused="true" focusable="true" selected="false" bounds="[0,20][100,40]"/>'
    + '<node text="Legacy" bounds="[0,50][100,70]"/></node></hierarchy>');
  const editor = tree.nodes.find(node => node.text === 'Editor');
  const legacy = tree.nodes.find(node => node.text === 'Legacy');
  assert.equal(editor.focused, true);
  assert.equal(editor.focusable, true);
  assert.equal(editor.selected, false);
  for (const field of ['focused', 'focusable', 'selected']) assert.equal(Object.hasOwn(legacy, field), false);
});

for (const tag of ['node', 'android.view.View']) {
  test(`Intent UIA summary preserves the visible page and original reference after a long hidden ${tag} subtree`, () => {
    const background = Array.from({ length: 650 }, (_, i) => '<node text="Old feed ' + i + '" visible-to-user="true" bounds="[20,20][200,60]"/>').join('');
    const xml = uiaXml('<hierarchy aab-truncated="false"><node bounds="[0,0][1080,2376]">'
      + `<node visible-to-user="false">${background}</node>`
      + '<node text="Author profile" visible-to-user="true" clickable="true" bounds="[-20,150][500,210]"/>'
      + '<node text="Offscreen" bounds="[-100,20][-10,60]"/>'
      + '</node></hierarchy>').replace(/(<\/?)(node)(?=[\s>])/g, '$1' + tag);
    const summary = summarizeTree({ provider: 'uia', rawTree: xml, rawTreeId: 'actual-page', maxBytes: 4096, hardLimitMs: 1000 });
    assert.deepEqual(summary.nodes.map(node => node.text), ['Author profile']);
    assert.equal(summary.nodes[0].sourceIndex, 652);
    assert.equal(summary.nodes[0].targetRef.nodeRef, compactUiaTree(xml).nodes.find(node => node.text === 'Author profile').targetRef.nodeRef);
    assert.equal(summary.coverage.projection.filtered, true);
    assert.equal(summary.coverage.projection.omittedHiddenNodes, 652);
    assert.equal(summary.truncated, false);
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 4096);
  });
}
