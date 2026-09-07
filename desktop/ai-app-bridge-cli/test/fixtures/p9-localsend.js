'use strict';

async function main(ctx) {
  const labels = ctx.inputs.labels;
  await ctx.call('flutter-tree', {});
  if (labels.skipOnboarding) {
    await ctx.call('tap-flutter-text', { text: labels.skipOnboarding });
    await ctx.call('flutter-tree', {});
  }
  await ctx.call('tap-flutter-text', { text: labels.settings });
  await ctx.call('flutter-tree', {});
  await ctx.call('tap-flutter-text', { text: labels.receive });
  await ctx.call('flutter-tree', {});
  await ctx.call('tap-flutter-text', { text: labels.settings });
  await ctx.call('flutter-tree', {});
  await ctx.call('scroll-flutter', { targetText: labels.about });
  await ctx.call('tap-flutter-text', { text: labels.aboutOpen });
  const about = await ctx.call('flutter-tree', {});
  const texts = collectTexts(about.result);
  const shot = await ctx.call('screenshot', {});
  await ctx.assert({
    name: 'about-visible',
    predicateSummary: 'frozen about label is on the tree',
    condition: texts.includes(labels.about),
    requiredEvidence: [],
    requireCoverage: 'complete',
    evidence: shot.evidence,
  });
  await ctx.call('tap-flutter-text', { text: labels.back });
  await ctx.call('tap-flutter-text', { text: labels.receive });
  await ctx.checkpoint('localsend-core', { done: true });
  return { passed: texts.includes(labels.about) };
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
