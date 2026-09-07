'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeTree } = require('../bin/shared-kernel/summary-transformer');
const actual = require('./fixtures/notallyx-backup-dialog-native-tree.json');
const summarize = rawTree => summarizeTree({ provider: 'native', rawTree, rawTreeId: 'foreground-test' });
const node = (id, extra = {}) => ({ id, text: id, visible: true, effectiveVisible: true, children: [], ...extra });

test('real long NotallyX settings page cannot displace the foreground backup dialog', () => {
  const result = summarize(actual);
  assert.equal(result.ok, true);
  assert.equal(result.truncated, false);
  assert(result.nodes.some(n => n.resourceName?.endsWith(':id/alertTitle') && n.text === '备份密码'));
  assert(result.nodes.some(n => n.resourceName === 'android:id/button2' && n.text === '取消'));
  assert(!result.nodes.some(n => n.resourceName?.endsWith(':id/ImportBackup')));
  assert(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
});

test('foreground selection retains original preorder indices and never duplicates the root', () => {
  const background = node('background', { children: [node('first'), node('second')] });
  const result = summarize({ root: background, windows: [{ root: background }, { root: node('dialog', { children: [node('button')] }) }] });
  assert.deepEqual(result.nodes.map(n => [n.nodeId, n.sourceIndex]), [['dialog', 3], ['button', 4]]);
});

test('hidden roots are skipped; unknown or disabled foreground roots never expose background controls', () => {
  const background = node('background');
  for (const overlay of [node('unknown', { visible: undefined, effectiveVisible: undefined }), node('disabled', { enabled: false })]) {
    const result = summarize({ root: background, windows: [{ root: background }, { root: overlay }] });
    assert(!result.nodes.some(n => n.text === 'background'));
    assert.equal(result.nodes[0].text, overlay.text);
  }
  for (const hidden of [{ visible: false }, { effectiveVisible: false }, { visibility: 'gone' }, { alpha: 0 }]) {
    const result = summarize({ windows: [{ root: background }, { root: node('hidden', hidden) }] });
    assert.deepEqual(result.nodes.map(n => n.text), ['background']);
  }
  assert.deepEqual(summarize({ root: background, windows: [{ root: node('hidden', { visible: false }) }] }).nodes, []);
  assert.deepEqual(summarize({ root: background, windows: [{ root: background }, null] }).nodes, []);
  assert.deepEqual(summarize({ root: background, windows: [] }).nodes.map(n => n.text), ['background']);
});
