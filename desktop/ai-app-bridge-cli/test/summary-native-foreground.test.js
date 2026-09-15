'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeTree } = require('../bin/shared-kernel/summary-transformer');
const { selectNativeNode } = require('../bin/shared-kernel/native-target');
const actual = require('./fixtures/notallyx-backup-dialog-native-tree.json');
const summarize = rawTree => summarizeTree({ provider: 'native', rawTree, rawTreeId: 'foreground-test' });
const node = (id, extra = {}) => ({ id, text: id, visible: true, effectiveVisible: true, children: [], ...extra });

test('SDK foreground dialog resolves repeated text despite a different focus owner', () => {
  const bounds = { left: 0, top: 0, right: 300, bottom: 500 };
  const choice = id => node(id, { text: 'Choice', bounds });
  const activity = { windowId: 'activity', activityDecor: true, focused: false, focusOwnerWindowId: null,
    bounds, root: node('activity', { bounds, children: [choice('background-1'), choice('background-2')] }) };
  const dialog = { windowId: 'dialog', focused: true, focusOwnerWindowId: 'dialog', bounds,
    root: node('dialog', { bounds, children: [choice('dialog-choice'), node('Confirm', { bounds })] }) };
  const tree = { foregroundWindowId: 'dialog', windows: [activity, dialog] };
  const selected = selectNativeNode(tree, { selector: { text: 'Choice' } }, false);
  assert.equal(selected.ok, true);
  assert.equal(selected.node.id, 'dialog-choice');
  assert.equal(selectNativeNode(tree, { selector: { text: 'Confirm' } }, false).ok, true);
  assert(!summarize(tree).nodes.some(n => n.nodeId === 'background-1'));
});

test('Reader back transition selects the focused shelf instead of the still-attached exiting page', () => {
  const shelf = { windowId: 'shelf', type: 'activity', activityDecor: true, focused: true,
    focusable: true, focusOwnerWindowId: 'shelf', root: node('shelf') };
  const exiting = { windowId: 'reading', type: 'window', activityDecor: false, focused: false,
    focusable: true, focusOwnerWindowId: null, root: node('read_pv_page') };
  const result = summarize({ foregroundWindowId: 'shelf', activity: 'reader.MainActivity', root: shelf.root, windows: [shelf, exiting] });
  assert.equal(result.activity, 'reader.MainActivity');
  assert.deepEqual(result.nodes.map(n => n.text), ['shelf']);
});

test('SDK selection keeps a dialog and nonfocusable popup despite independent focus owners', () => {
  const activity = { windowId: 'activity', type: 'activity', activityDecor: true, focused: false, focusable: true,
    focusOwnerWindowId: null, root: node('activity') };
  const dialog = { windowId: 'dialog', type: 'dialog', focused: true, focusable: true,
    focusOwnerWindowId: 'dialog', root: node('dialog') };
  const exiting = { windowId: 'exiting', focused: false, focusable: true, focusOwnerWindowId: null, root: node('exiting') };
  assert.deepEqual(summarize({ foregroundWindowId: 'dialog', windows: [activity, dialog, exiting] }).nodes.map(n => n.text), ['dialog']);
  const popup = { windowId: 'popup', type: 'popup', focused: false, focusable: false,
    focusOwnerWindowId: 'dialog', root: node('popup') };
  assert.deepEqual(summarize({ foregroundWindowId: 'popup', windows: [activity, dialog, exiting, popup] }).nodes.map(n => n.text), ['popup']);
});

test('opening Reader search uses the new Activity while focus still belongs to the previous page', () => {
  // Reduced from the OPPO 0.3.2 SearchActivity transition captured on 2026-09-14.
  const old = { windowId: 'shelf', activityDecor: false, focused: true, focusable: true,
    focusOwnerWindowId: 'shelf', root: node('shelf') };
  const current = { windowId: 'search', activityDecor: true, focused: false, focusable: true,
    focusOwnerWindowId: null, root: node('search') };
  const result = summarize({ foregroundWindowId: 'search', activity: 'reader.SearchActivity', root: current.root, windows: [old, current] });
  assert.equal(result.activity, 'reader.SearchActivity');
  assert.deepEqual(result.nodes.map(n => n.text), ['search']);
});

test('real long NotallyX settings page cannot displace the foreground backup dialog', () => {
  // Archived layout predates window identities. Add explicit synthetic SDK
  // metadata to exercise this large layout without changing the source capture.
  const result = summarize({ ...actual, foregroundWindowId: 'dialog', windows: actual.windows.map((window, i) =>
    ({ ...window, windowId: i === 0 ? 'activity' : 'dialog' })) });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, false);
  assert(result.nodes.some(n => n.resourceName?.endsWith(':id/alertTitle') && n.text === '备份密码'));
  assert(result.nodes.some(n => n.resourceName === 'android:id/button2' && n.text === '取消'));
  assert(!result.nodes.some(n => n.resourceName?.endsWith(':id/ImportBackup')));
  assert(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
});

test('foreground selection retains original preorder indices and never duplicates the root', () => {
  const background = node('background', { children: [node('first'), node('second')] });
  const result = summarize({ foregroundWindowId: 'dialog', root: background,
    windows: [{ windowId: 'activity', root: background }, { windowId: 'dialog', root: node('dialog', { children: [node('button')] }) }] });
  assert.deepEqual(result.nodes.map(n => [n.nodeId, n.sourceIndex]), [['dialog', 3], ['button', 4]]);
});

test('invalid or hidden SDK selections never expose background controls', () => {
  const background = node('background');
  for (const overlay of [node('unknown', { visible: undefined, effectiveVisible: undefined }), node('disabled', { enabled: false })]) {
    const result = summarize({ foregroundWindowId: 'overlay', root: background,
      windows: [{ windowId: 'activity', root: background }, { windowId: 'overlay', root: overlay }] });
    assert(!result.nodes.some(n => n.text === 'background'));
    assert.equal(result.nodes[0].text, overlay.text);
  }
  for (const hidden of [{ visible: false }, { effectiveVisible: false }, { visibility: 'gone' }, { alpha: 0 }]) {
    const result = summarize({ foregroundWindowId: 'hidden',
      windows: [{ windowId: 'activity', root: background }, { windowId: 'hidden', root: node('hidden', hidden) }] });
    assert.deepEqual(result.nodes, []);
  }
  assert.deepEqual(summarize({ root: background, windows: [{ root: node('hidden', { visible: false }) }] }).nodes, []);
  assert.deepEqual(summarize({ root: background, windows: [{ root: background }, null] }).nodes, []);
  assert.deepEqual(summarize({ root: background, windows: [] }).nodes.map(n => n.text), ['background']);
});

test('missing, absent or duplicate SDK foreground identities reject without focus or order fallback', () => {
  const window = { windowId: 'activity', activityDecor: true, focused: true, root: node('background') };
  for (const tree of [{ windows: [window] }, { foregroundWindowId: 'missing', windows: [window] },
    { foregroundWindowId: 'activity', windows: [window, window] }]) {
    assert.deepEqual(summarize(tree).nodes, []);
    assert.equal(selectNativeNode(tree, { selector: { text: 'background' } }, false).dispatched, false);
  }
  assert.equal(selectNativeNode({ windows: [window] }, { selector: { text: 'background' } }, false).error,
    'native_window_metadata_unavailable');
});
