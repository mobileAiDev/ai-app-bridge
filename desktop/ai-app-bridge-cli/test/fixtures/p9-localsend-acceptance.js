'use strict';

async function main(ctx) {
  const labels = ctx.inputs.labels;
  await ctx.call('flutter-tree', {});
  if (labels.skipOnboarding) {
    await callOk(ctx, 'tap-flutter-text', { text: labels.skipOnboarding });
    await ctx.call('flutter-tree', {});
  }
  await callOk(ctx, 'tap-flutter-text', { text: labels.send });
  const discovery = await callOk(ctx, 'uia-tree', {});
  const discoveryShot = await callOk(ctx, 'screenshot', {});
  await ctx.assert({
    name: 'empty-discovery',
    predicateSummary: 'frozen no-peer label is on the send page',
    condition: uiaXml(discovery).includes(labels.noPeer),
    requiredEvidence: ['tree'],
    requireCoverage: 'complete',
    evidence: discovery.evidence,
  });
  await callOk(ctx, 'tap-flutter-text', { text: labels.settings });
  await callOk(ctx, 'tap-flutter-text', { text: labels.receive });
  await callOk(ctx, 'tap-flutter-text', { text: labels.settings });
  await callOk(ctx, 'scroll-flutter', { targetText: labels.about });
  await callOk(ctx, 'tap-flutter-text', { text: labels.aboutOpen });
  const about = await callOk(ctx, 'flutter-tree', {});
  const aboutShot = await callOk(ctx, 'screenshot', {});
  await ctx.assert({
    name: 'about-visible',
    predicateSummary: 'frozen about label is on the flutter tree',
    condition: collectFlutterTexts(about.result).includes(labels.about),
    requiredEvidence: ['tree'],
    requireCoverage: 'complete',
    evidence: about.evidence,
  });
  await callOk(ctx, 'tap-flutter-text', { text: labels.back });
  await callOk(ctx, 'tap-flutter-text', { text: labels.send });
  await callOk(ctx, 'tap-uia-text', { text: labels.fileSelect });
  await callOk(ctx, 'tap-uia-text', { text: labels.cancel });
  await callOk(ctx, 'tap-uia-text', { text: labels.settings });
  await callOk(ctx, 'wait-text', { targetText: labels.theme, timeoutSec: 8 });
  await tapThemeValue(ctx, labels);
  await callOk(ctx, 'wait-text', { targetText: labels.themeLight, timeoutSec: 8 });
  await callOk(ctx, 'tap-uia-text', { text: labels.themeLight });
  await callOk(ctx, 'tap-uia-text', { text: labels.themeLight });
  await callOk(ctx, 'tap-uia-text', { text: labels.themeRestore });
  await tapLastUia(ctx, labels.themeRestore);
  await callOk(ctx, 'wait-text', { targetText: labels.language, timeoutSec: 8 });
  const languagePage = await callOk(ctx, 'uia-tree', {});
  const languageShot = await callOk(ctx, 'screenshot', {});
  await ctx.assert({
    name: 'language-page',
    predicateSummary: 'frozen language page title is on the uia tree',
    condition: uiaXml(languagePage).includes(labels.language),
    requiredEvidence: ['tree'],
    requireCoverage: 'complete',
    evidence: languagePage.evidence,
  });
  await callOk(ctx, 'tap-uia-text', { text: labels.languageEnglish });
  await callOk(ctx, 'wait-text', { targetText: labels.languageRestoreEn, timeoutSec: 8 });
  await callOk(ctx, 'tap-uia-text', { text: labels.languageRestoreEn });
  await callOk(ctx, 'wait-text', { targetText: labels.language, timeoutSec: 8 });
  await callOk(ctx, 'tap-uia-text', { text: labels.back });
  await callOk(ctx, 'tap-uia-text', { text: labels.receive });
  await callOk(ctx, 'tap-uia-text', { text: labels.settings });
  const restored = await callOk(ctx, 'uia-tree', {});
  await callOk(ctx, 'screenshot', {});
  await ctx.assert({
    name: 'theme-language-restored',
    predicateSummary: 'settings is restored after theme and language cycle',
    condition: settingsRestored(uiaXml(restored), labels),
    requiredEvidence: ['tree'],
    requireCoverage: 'complete',
    evidence: restored.evidence,
  });
  await callOk(ctx, 'tap-uia-text', { text: labels.receive });
  await callOk(ctx, 'tap-uia-text', { text: labels.settings });
  await callOk(ctx, 'tap-uia-text', { text: labels.send });
  await callOk(ctx, 'tap-uia-text', { text: labels.receive });
  await ctx.checkpoint('localsend-acceptance', { done: true });
  return { completed: true };
}

async function callOk(ctx, command, args) {
  const result = await ctx.call(command, args);
  if (!result || result.ok === false) {
    throw new Error(result && result.error ? result.error : command);
  }
  return result;
}

function collectFlutterTexts(tree) {
  const found = [];
  if (!tree) return found;
  if (tree.operable && Array.isArray(tree.operable.nodes)) {
    for (const node of tree.operable.nodes) {
      if (typeof node.text === 'string') found.push(node.text);
    }
  }
  walkFlutter(tree.root || tree, found);
  if (Array.isArray(tree.nodes)) {
    for (const node of tree.nodes) walkFlutter(node, found);
  }
  return found;
}

function walkFlutter(node, found) {
  if (!node) return;
  if (typeof node.text === 'string') found.push(node.text);
  for (const child of node.children || []) walkFlutter(child, found);
}

function uiaXml(dump) {
  if (!dump) return '';
  if (typeof dump.result === 'string') return dump.result;
  if (dump.result && typeof dump.result.result === 'string') return dump.result.result;
  return '';
}

function uiaButtons(xml) {
  const found = [];
  const nodes = String(xml).match(/<node\b[^>]*>/g) || [];
  for (const tag of nodes) {
    if (!tag.includes('android.widget.Button')) continue;
    const desc = ((tag.match(/content-desc="([^"]*)"/) || [])[1] || '').replace(/&#10;/g, '\n');
    const bounds = tag.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bounds) continue;
    found.push({
      desc,
      x: Math.round((Number(bounds[1]) + Number(bounds[3])) / 2),
      y: Math.round((Number(bounds[2]) + Number(bounds[4])) / 2),
    });
  }
  return found;
}

async function tapThemeValue(ctx, labels) {
  const dump = await callOk(ctx, 'uia-tree', {});
  const values = new Set([labels.themeRestore, labels.themeLight, labels.themeDark]);
  const node = uiaButtons(uiaXml(dump)).find((item) => values.has(item.desc));
  if (!node) {
    throw new Error('theme_value_not_found');
  }
  await callOk(ctx, 'tap', { tapX: node.x, tapY: node.y });
}

async function tapLastUia(ctx, text) {
  const dump = await callOk(ctx, 'uia-tree', {});
  const matches = uiaButtons(uiaXml(dump)).filter((node) => node.desc === text);
  const node = matches[matches.length - 1];
  if (!node) {
    throw new Error(`last_uia_not_found:${text}`);
  }
  await callOk(ctx, 'tap', { tapX: node.x, tapY: node.y });
}

function settingsRestored(xml, labels) {
  if (![labels.settings, labels.theme, labels.language].every((label) => xml.includes(label))) return false;
  const values = uiaButtons(xml).map((button) => button.desc);
  const required = [labels.themeRestore, labels.languageRestore];
  return required.every((value) => values.filter((item) => item === value).length
    >= required.filter((item) => item === value).length);
}

module.exports = { main, settingsRestored };
