'use strict';

async function main(ctx) {
  const tree = await ctx.call('tree', {});
  const texts = collectTexts(tree.result);
  await ctx.checkpoint('after-tree', { step: 1 });
  const tap = await ctx.call('tap-text', { text: 'About' });
  const after = await ctx.call('tree', {});
  const verdict = await ctx.assert({
    name: 'license-visible',
    predicateSummary: 'License Notices is on the tree',
    condition: collectTexts(after.result).includes('License Notices'),
    requiredEvidence: [],
    requireCoverage: 'complete',
    evidence: after.evidence,
  });
  return {
    passed: verdict.verdict === 'passed',
    tapped: tap.execution.actionId,
    sawAbout: texts.includes('About'),
  };
}

function collectTexts(tree) {
  const found = [];
  walk(tree && tree.root, found);
  return found;
}

function walk(node, found) {
  if (!node) return;
  if (typeof node.text === 'string') found.push(node.text);
  for (const child of node.children || []) walk(child, found);
}

module.exports = { main };
