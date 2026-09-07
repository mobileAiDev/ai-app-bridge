'use strict';

async function main(ctx) {
  const labels = ctx.inputs.labels;
  await callOk(ctx, 'wait-text', { targetText: labels.home, timeoutSec: 8, requireActivity: 'MainActivity' });
  await callOk(ctx, 'tap', { tapX: 540, tapY: 2256 });
  await callOk(ctx, 'tap-text', { text: labels.searchField });
  await callOk(ctx, 'wait-text', { targetText: labels.back, timeoutSec: 8 });
  await callOk(ctx, 'input-text', { text: labels.noResultQuery, tapX: 621, tapY: 215 });
  await callOk(ctx, 'wait-text', { targetText: labels.noResultQuery, timeoutSec: 8 });
  await callOk(ctx, 'hide-keyboard', {});
  await callOk(ctx, 'wait-text', { targetText: labels.noResult, timeoutSec: 15 });
  const empty = await callOk(ctx, 'uia-tree', { compact: true, textFilter: labels.noResult, maxNodes: 16 });
  const emptyShot = await callOk(ctx, 'screenshot', {});
  await ctx.assert({
    name: 'no-result',
    predicateSummary: 'frozen no-result label is in the compact uia tree',
    condition: compactHasText(empty, labels.noResult),
    requiredEvidence: [],
    requireCoverage: 'complete',
    evidence: emptyShot.evidence,
  });
  await callOk(ctx, 'tap-uia-text', { text: labels.clearQuery });
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
  await callOk(ctx, 'wait-text', { targetText: labels.readingList, timeoutSec: 8 });
  await callOk(ctx, 'tap-text', { text: labels.readingList });
  const listed = await ctx.call('wait-text', { targetText: labels.testList, timeoutSec: 4 });
  if (!listed || listed.ok === false) {
    await callOk(ctx, 'wait-text', { targetText: labels.readingListSheet, timeoutSec: 8 });
    await callOk(ctx, 'tap-uia-text', { text: labels.readingListSheet });
    await callOk(ctx, 'wait-text', { targetText: labels.listNameField, timeoutSec: 8 });
    await callOk(ctx, 'input-text', { text: labels.testList });
    await callOk(ctx, 'tap-uia-text', { text: labels.confirm });
    await callOk(ctx, 'wait-text', { targetText: labels.savedToList, timeoutSec: 8 });
  } else {
    await callOk(ctx, 'tap-uia-text', { text: labels.testList });
  }
  await callOk(ctx, 'wait-text', { targetText: labels.savedToList, timeoutSec: 8 });
  await callOk(ctx, 'tap-text', { text: labels.readingList });
  await callOk(ctx, 'wait-text', { targetText: labels.testList, timeoutSec: 8 });
  const testListDump = await callOk(ctx, 'uia-tree', { compact: true, textFilter: labels.testList, maxNodes: 16 });
  const sheetShot = await callOk(ctx, 'screenshot', {});
  await ctx.assert({
    name: 'reading-list-sheet',
    predicateSummary: 'test collection p9-test is in the compact uia tree after opening the reading list',
    condition: compactHasText(testListDump, labels.testList),
    requiredEvidence: [],
    requireCoverage: 'complete',
    evidence: sheetShot.evidence,
  });
  await callOk(ctx, 'tap-uia-text', { text: labels.testList });
  await callOk(ctx, 'wait-text', { targetText: labels.readingList, timeoutSec: 8 });
  await callOk(ctx, 'tap-text', { text: labels.theme });
  await callOk(ctx, 'wait-text', { targetText: labels.themeRestore, timeoutSec: 8 });
  await callOk(ctx, 'tap-uia-text', { text: labels.themeRestore });
  await callOk(ctx, 'tap', { tapX: 315, tapY: 1965 });
  await callOk(ctx, 'tap-uia-text', { text: labels.themeRestore });
  await callOk(ctx, 'tap', { tapX: 84, tapY: 216 });
  await callOk(ctx, 'wait-text', { targetText: labels.language, timeoutSec: 8 });
  await callOk(ctx, 'tap-text', { text: labels.language });
  await callOk(ctx, 'wait-text', { targetText: labels.languageLinksTitle, timeoutSec: 8 });
  await callOk(ctx, 'wait-text', { targetText: labels.languagePage, timeoutSec: 60, intervalMs: 3000 });
  await callOk(ctx, 'wait-text', { targetText: labels.languageSwitch, timeoutSec: 10 });
  await callOk(ctx, 'tap-uia-text', { text: labels.languageSwitch, exact: true });
  await callOk(ctx, 'wait-text', { targetText: labels.switchedTitle, timeoutSec: 60 });
  await callOk(ctx, 'wait-text', { targetText: labels.toc, timeoutSec: 15 });
  const switched = await callOk(ctx, 'uia-tree', { compact: true, textFilter: labels.switchedTitle, maxNodes: 16 });
  const switchedShot = await callOk(ctx, 'screenshot', {});
  await ctx.assert({
    name: 'language-switched',
    predicateSummary: 'Afrikaans Moon title is in the compact uia tree after language switch',
    condition: compactHasText(switched, labels.switchedTitle),
    requiredEvidence: [],
    requireCoverage: 'complete',
    evidence: switchedShot.evidence,
  });
  await callOk(ctx, 'tap-uia-text', { text: labels.back });
  await callOk(ctx, 'wait-text', {
    targetText: labels.articleTitle,
    absentText: labels.switchedTitle,
    timeoutSec: 60,
    requireActivity: 'PageActivity',
  });
  await callOk(ctx, 'swipe', { startX: 540, startY: 400, endX: 540, endY: 1400, durationMs: 400 });
  await callOk(ctx, 'swipe', { startX: 540, startY: 400, endX: 540, endY: 1400, durationMs: 400 });
  const restored = await callOk(ctx, 'uia-tree', {
    compact: true,
    textFilter: labels.articleTitle,
    visibleOnly: true,
    maxNodes: 16,
  });
  const restoredShot = await callOk(ctx, 'screenshot', {});
  await ctx.assert({
    name: 'theme-language-restored',
    predicateSummary: 'visible Chinese article text is in compact uia nodes after theme cycle and back-stack language restore',
    condition: compactHasText(restored, labels.articleTitle),
    requiredEvidence: [],
    requireCoverage: 'complete',
    evidence: restoredShot.evidence,
  });
  await callOk(ctx, 'tap-uia-text', { text: labels.back });
  await callOk(ctx, 'wait-text', { targetText: labels.resultMarker, timeoutSec: 8, requireActivity: 'SearchActivity' });
  const leftArticle = await callOk(ctx, 'uia-tree', { compact: true, textFilter: labels.resultMarker, maxNodes: 16 });
  const leftShot = await callOk(ctx, 'screenshot', {});
  await ctx.assert({
    name: 'left-article-search',
    predicateSummary: 'search result marker is in the compact uia tree after leaving PageActivity',
    condition: compactHasText(leftArticle, labels.resultMarker),
    requiredEvidence: [],
    requireCoverage: 'complete',
    evidence: leftShot.evidence,
  });
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
  await callOk(ctx, 'tap-text', { text: labels.back });
  await callOk(ctx, 'wait-text', { targetText: labels.home, timeoutSec: 8 });
  await callOk(ctx, 'tap', { tapX: 540, tapY: 2256 });
  await callOk(ctx, 'tap-text', { text: labels.searchField });
  await callOk(ctx, 'input-text', { text: labels.articleTitle, tapX: 621, tapY: 215 });
  await callOk(ctx, 'hide-keyboard', {});
  await callOk(ctx, 'wait-text', { targetText: labels.resultMarker, timeoutSec: 8 });
  await callOk(ctx, 'tap', { tapX: 540, tapY: 590 });
  await callOk(ctx, 'wait-text', { targetText: labels.toc, timeoutSec: 8 });
  await callOk(ctx, 'tap-uia-text', { text: labels.back });
  await callOk(ctx, 'wait-text', { targetText: labels.resultMarker, timeoutSec: 8, requireActivity: 'SearchActivity' });
  const repeatLeft = await callOk(ctx, 'uia-tree', { compact: true, textFilter: labels.resultMarker, maxNodes: 16 });
  const repeatLeftShot = await callOk(ctx, 'screenshot', {});
  await ctx.assert({
    name: 'repeat-left-article-search',
    predicateSummary: 'search result marker is in the compact uia tree after the repeat article back',
    condition: compactHasText(repeatLeft, labels.resultMarker),
    requiredEvidence: [],
    requireCoverage: 'complete',
    evidence: repeatLeftShot.evidence,
  });
  await ctx.checkpoint('wikipedia-acceptance', { done: true });
  return { passed: true };
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
