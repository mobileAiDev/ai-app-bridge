'use strict';

async function main(ctx) {
  const labels = ctx.inputs.labels;
  await callOk(ctx, 'wait-text', { targetText: labels.home, timeoutSec: 8, requireActivity: 'MainActivity' });
  await callOk(ctx, 'tap', { tapX: 540, tapY: 2256 });
  await callOk(ctx, 'tap-text', { text: labels.searchField });
  await callOk(ctx, 'wait-text', { targetText: labels.searchField, timeoutSec: 8 });
  await callOk(ctx, 'input-text', { text: labels.articleTitle, tapX: 621, tapY: 215 });
  await callOk(ctx, 'hide-keyboard', {});
  await callOk(ctx, 'wait-text', { targetText: labels.resultMarker, timeoutSec: 8 });
  await callOk(ctx, 'tap', { tapX: 540, tapY: 590 });
  await callOk(ctx, 'wait-text', { targetText: labels.toc, timeoutSec: 8 });
  const articleTitle = await callOk(ctx, 'uia-tree', { compact: true, textFilter: labels.articleTitle, maxNodes: 16 });
  const articleToc = await callOk(ctx, 'uia-tree', { compact: true, textFilter: labels.toc, maxNodes: 16 });
  const articleShot = await callOk(ctx, 'screenshot', {});
  await ctx.assert({
    name: 'article-visible',
    predicateSummary: 'frozen article title and TOC chrome are in the compact uia tree',
    condition: compactHasText(articleTitle, labels.articleTitle) && compactHasText(articleToc, labels.toc),
    requiredEvidence: [],
    requireCoverage: 'complete',
    evidence: articleShot.evidence,
  });
  await callOk(ctx, 'tap-uia-text', { text: labels.toc });
  await callOk(ctx, 'wait-text', { targetText: labels.tocSection, timeoutSec: 8 });
  const toc = await callOk(ctx, 'tree', {});
  const tocShot = await callOk(ctx, 'screenshot', {});
  await ctx.assert({
    name: 'toc-visible',
    predicateSummary: 'frozen TOC section is on the tree',
    condition: collectTexts(toc.result).includes(labels.tocSection),
    requiredEvidence: [],
    requireCoverage: 'complete',
    evidence: tocShot.evidence,
  });
  await callOk(ctx, 'tap', { tapX: 573, tapY: 570 });
  await callOk(ctx, 'wait-text', { targetText: labels.toc, timeoutSec: 8 });
  await callOk(ctx, 'swipe', { startX: 540, startY: 400, endX: 540, endY: 1400, durationMs: 400 });
  await callOk(ctx, 'swipe', { startX: 540, startY: 400, endX: 540, endY: 1400, durationMs: 400 });
  await callOk(ctx, 'tap-text', { text: labels.back });
  await callOk(ctx, 'wait-text', { targetText: labels.resultMarker, timeoutSec: 8 });
  await callOk(ctx, 'tap-text', { text: labels.back });
  await callOk(ctx, 'wait-text', { targetText: labels.home, timeoutSec: 8 });
  await callOk(ctx, 'tap-text', { text: labels.more });
  await callOk(ctx, 'wait-text', { targetText: labels.settings, timeoutSec: 8 });
  await callOk(ctx, 'tap-text', { text: labels.settings });
  await callOk(ctx, 'wait-text', { targetText: labels.settingsTheme, timeoutSec: 8 });
  const settings = await callOk(ctx, 'tree', {});
  const settingsShot = await callOk(ctx, 'screenshot', {});
  await ctx.assert({
    name: 'settings-visible',
    predicateSummary: 'frozen settings theme row is on the tree',
    condition: collectTexts(settings.result).includes(labels.settingsTheme),
    requiredEvidence: [],
    requireCoverage: 'complete',
    evidence: settingsShot.evidence,
  });
  await ctx.checkpoint('wikipedia-core', { done: true });
  return { passed: collectTexts(settings.result).includes(labels.settingsTheme) };
}

async function callOk(ctx, command, args) {
  const result = await ctx.call(command, args);
  if (!result || result.ok === false) {
    throw new Error(result && result.error ? result.error : command);
  }
  return result;
}

function collectTexts(tree) {
  const found = [];
  walk(tree && tree.root, found);
  return found;
}

function compactHasText(callResult, expected) {
  const nodes = callResult && callResult.result && Array.isArray(callResult.result.nodes)
    ? callResult.result.nodes
    : [];
  return nodes.some((node) => [node.text, node.contentDescription]
    .some((value) => typeof value === 'string' && value.includes(expected)));
}

function walk(node, found) {
  if (!node) return;
  if (typeof node.text === 'string') found.push(node.text);
  for (const child of node.children || []) walk(child, found);
}

module.exports = { main };
