'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeTree } = require('../bin/shared-kernel/summary-transformer');
const { nodesOf } = require('../bin/shared-kernel/ios-native-target');
// Original native source from Kiwix's real Climate change bookmark sheet,
// intent:observation:kiwix-bookmark-20260911-01:4:17. Device/session metadata omitted.
const actual = require('./fixtures/kiwix-ios-bookmark-sheet.json');

test('long WKWebView content cannot displace visible native bookmark controls from the bounded summary', () => {
  const result = summarizeTree({ provider: 'native', rawTree: actual, rawTreeId: 'kiwix-sheet' });
  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'max_bytes');
  assert(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
  for (const label of ['Done', 'Add Bookmark']) {
    const matches = result.nodes.filter(n => n.label === label && n.elementType === 'Button' && n.visible);
    assert.equal(matches.length, 1, `${label} must remain available to the Agent`);
    assert.equal(matches[0].enabled, true);
  }
  assert(result.nodes.some(n => n.text === 'No bookmarks' && n.visible));
  const original = nodesOf(actual);
  for (const node of result.nodes) {
    assert.equal(node.elementId, original[node.sourceIndex].elementId);
    assert.equal(node.visible, original[node.sourceIndex].isVisible === '1');
  }
  assert.deepEqual(result.nodes.map(n => n.sourceIndex), result.nodes.map(n => n.sourceIndex).sort((a, b) => a - b));
});
