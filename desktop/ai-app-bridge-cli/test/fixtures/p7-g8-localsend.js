'use strict';

async function main(ctx) {
  await ctx.call('flutter-tree', {});
  await ctx.call('tap-flutter-text', { text: '设置' });
  await ctx.call('flutter-tree', {});
  await ctx.call('tap-flutter-text', { text: '发送' });
  await ctx.call('flutter-tree', {});
  await ctx.call('tap-flutter-text', { text: '接收' });
  const after = await ctx.call('flutter-tree', {});
  const texts = collectTexts(after.result);
  await ctx.assert({
    name: 'settings-visible',
    predicateSummary: '设置 is on the tree',
    condition: texts.includes('设置'),
    requiredEvidence: [],
    requireCoverage: 'complete',
    evidence: after.evidence,
  });
  await ctx.checkpoint('g8-done', { done: true });
  return { passed: texts.includes('设置') };
}

function collectTexts(tree) {
  const found = [];
  if (!tree) return found;
  if (tree.operable && Array.isArray(tree.operable.nodes)) {
    for (const node of tree.operable.nodes) {
      if (typeof node.text === 'string') found.push(node.text);
    }
    return found;
  }
  walk(tree.root || tree, found);
  if (Array.isArray(tree.nodes)) {
    for (const node of tree.nodes) walk(node, found);
  }
  return found;
}

function walk(node, found) {
  if (!node) return;
  if (typeof node.text === 'string') found.push(node.text);
  for (const child of node.children || []) walk(child, found);
}

module.exports = { main };
