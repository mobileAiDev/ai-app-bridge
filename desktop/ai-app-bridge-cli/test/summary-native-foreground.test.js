'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeTree } = require('../bin/shared-kernel/summary-transformer');
const actual = require('./fixtures/notallyx-backup-dialog-native-tree.json');
const summarize = rawTree => summarizeTree({ provider: 'native', rawTree, rawTreeId: 'foreground-test' });
const node = (id, extra = {}) => ({ id, text: id, visible: true, effectiveVisible: true, children: [], ...extra });

test('Reader back transition selects the focused shelf instead of the still-attached exiting page', () => {
  const shelf = { windowId: 'shelf', type: 'activity', activityDecor: true, focused: true,
    focusable: true, focusOwnerWindowId: 'shelf', root: node('shelf') };
  const exiting = { windowId: 'reading', type: 'window', activityDecor: false, focused: false,
    focusable: true, focusOwnerWindowId: null, root: node('read_pv_page') };
  const result = summarize({ activity: 'reader.MainActivity', root: shelf.root, windows: [shelf, exiting] });
  assert.equal(result.activity, 'reader.MainActivity');
  assert.deepEqual(result.nodes.map(n => n.text), ['shelf']);
});

test('focus selection keeps a focused dialog and nonfocusable popup above its owner', () => {
  const activity = { windowId: 'activity', type: 'activity', activityDecor: true, focused: false, focusable: true,
    focusOwnerWindowId: 'dialog', root: node('activity') };
  const dialog = { windowId: 'dialog', type: 'dialog', focused: true, focusable: true,
    focusOwnerWindowId: 'dialog', root: node('dialog') };
  const exiting = { windowId: 'exiting', focused: false, focusable: true, focusOwnerWindowId: null, root: node('exiting') };
  assert.deepEqual(summarize({ windows: [activity, dialog, exiting] }).nodes.map(n => n.text), ['dialog']);
  const popup = { windowId: 'popup', type: 'popup', focused: false, focusable: false,
    focusOwnerWindowId: 'dialog', root: node('popup') };
  assert.deepEqual(summarize({ windows: [activity, dialog, exiting, popup] }).nodes.map(n => n.text), ['popup']);
});

test('opening Reader search uses the new Activity while focus still belongs to the previous page', () => {
  // Reduced from the OPPO 0.3.2 SearchActivity transition captured on 2026-09-14.
  const old = { windowId: 'shelf', activityDecor: false, focused: true, focusable: true,
    focusOwnerWindowId: 'shelf', root: node('shelf') };
  const current = { windowId: 'search', activityDecor: true, focused: false, focusable: true,
    focusOwnerWindowId: null, root: node('search') };
  const result = summarize({ activity: 'reader.SearchActivity', root: current.root, windows: [old, current] });
  assert.equal(result.activity, 'reader.SearchActivity');
  assert.deepEqual(result.nodes.map(n => n.text), ['search']);
});

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
