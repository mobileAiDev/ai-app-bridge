'use strict';

async function main(ctx) {
  const labels = ctx.inputs.labels;
  // New route proof must be frozen from the actual preview, before this fixture mutates the app.
  frozenText(labels, 'routePreview');
  await assertTree(ctx, 'map-visible', (tree) => mapVisible(collectTexts(tree), labels));
  await callOk(ctx, 'tap-uia-text', { text: frozenText(labels, 'search') });
  await typeIntoSearch(ctx, frozenText(labels, 'poi'));
  await tapPoiTitle(ctx, frozenText(labels, 'poi'));
  await assertTree(ctx, 'poi-visible', (tree) => poiVisible(collectTexts(tree), labels));
  await tapIfFrozen(ctx, labels, 'cancel');
  await callOk(ctx, 'tap-uia-text', { text: frozenText(labels, 'search') });
  await typeIntoSearch(ctx, frozenText(labels, 'noResultQuery'));
  await assertTree(ctx, 'no-result-search', (tree) => collectTexts(tree).includes(labels.noResult));
  await tapIfFrozen(ctx, labels, 'cancel');
  await callOk(ctx, 'tap-uia-text', { text: frozenText(labels, 'search') });
  await typeIntoSearch(ctx, frozenText(labels, 'poi'));
  await tapPoiTitle(ctx, frozenText(labels, 'poi'));
  await callOk(ctx, 'tap-uia-text', { text: frozenText(labels, 'bookmark') });
  await assertTree(ctx, 'bookmark-added', (tree) => bookmarkState(tree, labels, 'saved'));
  await callOk(ctx, 'tap-uia-text', { text: frozenText(labels, 'bookmarkDelete') });
  await assertTree(ctx, 'bookmark-deleted', (tree) => bookmarkState(tree, labels, 'deleted'));
  await callOk(ctx, 'tap-uia-text', { text: frozenText(labels, 'bookmarkRestore') });
  await assertTree(ctx, 'bookmark-restored', (tree) => bookmarkState(tree, labels, 'saved'));
  await tapIfFrozen(ctx, labels, 'route');
  await tapIfFrozen(ctx, labels, 'routeDownloadLater');
  await assertTree(ctx, 'route-preview', (tree) => collectTexts(tree).includes(labels.routePreview));
  await tapIfFrozen(ctx, labels, 'cancel');
  await assertTree(ctx, 'route-cancelled', (tree) => mapVisible(collectTexts(tree), labels)
    && !collectTexts(tree).includes(labels.routePreview));
  await tapIfFrozen(ctx, labels, 'menu');
  await tapIfFrozen(ctx, labels, 'settings');
  const before = await callOk(ctx, 'uia-tree', {});
  const initial = settingState(uiaXml(before), labels.settingsRestore);
  if (initial === null) throw new Error('setting_checked_state_unavailable');
  await tapIfFrozen(ctx, labels, 'settingsRestore');
  await assertTree(ctx, 'settings-changed', (tree) => settingState(uiaXml({ result: tree }), labels.settingsRestore) === !initial);
  await tapIfFrozen(ctx, labels, 'settingsRestore');
  await assertTree(ctx, 'settings-restored', (tree) => settingState(uiaXml({ result: tree }), labels.settingsRestore) === initial);
  await tapIfFrozen(ctx, labels, 'back');
  await assertTree(ctx, 'map-after-settings', (tree) => mapVisible(collectTexts(tree), labels));
  await ctx.checkpoint('organic-maps-acceptance', { done: true });
  return { completed: true };
}

async function assertTree(ctx, name, predicate) {
  const tree = await callOk(ctx, 'uia-tree', {});
  await ctx.call('screenshot', {});
  return ctx.assert({
    name,
    predicateSummary: `independent current-tree postcondition: ${name}`,
    condition: predicate(tree.result),
    requiredEvidence: ['tree'],
    requireCoverage: 'complete',
    evidence: tree.evidence,
  });
}

function bookmarkState(tree, labels, expected) {
  const texts = collectTexts(tree);
  const visible = texts.some((text) => text.includes(labels.poi));
  return visible && (expected === 'saved'
    ? texts.includes(labels.bookmarkDelete) && !texts.includes(labels.bookmarkRestore) && !texts.includes(labels.bookmark)
    : texts.includes(labels.bookmarkRestore) && !texts.includes(labels.bookmarkDelete));
}

function mapVisible(texts, labels) {
  return [labels.search, labels.menu, labels.bookmarkList].every((text) => texts.includes(text))
    && !texts.includes(labels.cancel);
}

// Locate a labeled preference's own ancestor row; do not borrow another switch's state.
function settingState(xml, label) {
  const root = { attrs: {}, children: [] };
  const stack = [root];
  const targets = [];
  for (const match of String(xml).matchAll(/<\/?node\b[^>]*>/g)) {
    const tag = match[0];
    if (tag.startsWith('</')) { stack.pop(); continue; }
    const attrs = Object.fromEntries(Array.from(tag.matchAll(/([\w-]+)="([^"]*)"/g), (item) => [item[1], item[2]]));
    const parent = stack[stack.length - 1];
    const node = { attrs, parent, children: [] };
    parent.children.push(node);
    if (attrs.text === label || attrs['content-desc'] === label) targets.push(node);
    if (!tag.endsWith('/>')) stack.push(node);
  }
  if (targets.length !== 1) return null;
  for (let node = targets[0]; node && node !== root; node = node.parent) {
    const values = [];
    const visit = (item) => {
      if (item.attrs.checkable === 'true' && ['true', 'false'].includes(item.attrs.checked)) values.push(item.attrs.checked === 'true');
      item.children.forEach(visit);
    };
    visit(node);
    if (values.length > 0) return values.length === 1 ? values[0] : null;
  }
  return null;
}

async function tapPoiTitle(ctx, name) {
  const dump = await ctx.call('uia-tree', {});
  const title = findTitleBelowOverlay(uiaXml(dump), name);
  if (!title) {
    throw new Error('poi_title_not_found');
  }
  await ctx.call('tap', { tapX: title.tapX, tapY: title.tapY });
  await ctx.call('uia-tree', {});
}

function findTitleBelowOverlay(xml, name) {
  let overlayBottom = 0;
  const titles = [];
  const tags = String(xml).match(/<node\b[^>]*>/g) || [];
  for (const tag of tags) {
    const rid = ((tag.match(/resource-id="([^"]*)"/) || [])[1] || '');
    const text = ((tag.match(/text="([^"]*)"/) || [])[1] || '');
    const match = tag.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!match) continue;
    const top = Number(match[2]);
    const bottom = Number(match[4]);
    if (rid.endsWith('id/downloader_button')) {
      overlayBottom = bottom;
    }
    if (rid.endsWith('id/title') && text.includes(name)) {
      titles.push({
        tapX: Math.round((Number(match[1]) + Number(match[3])) / 2),
        tapY: Math.round((top + bottom) / 2),
        top,
      });
    }
  }
  return titles.find((item) => item.top > overlayBottom) || null;
}

async function typeIntoSearch(ctx, query) {
  const dump = await ctx.call('uia-tree', {});
  const field = findEdit(uiaXml(dump));
  if (!field) {
    throw new Error('search_edit_not_found');
  }
  await ctx.call('tap', { tapX: field.tapX, tapY: field.tapY });
  await ctx.call('input-text', { text: query });
}

function findEdit(xml) {
  const tags = String(xml).match(/<node\b[^>]*>/g) || [];
  for (const tag of tags) {
    if (!tag.includes('EditText')) continue;
    const match = tag.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!match) continue;
    return {
      tapX: Math.round((Number(match[1]) + Number(match[3])) / 2),
      tapY: Math.round((Number(match[2]) + Number(match[4])) / 2),
    };
  }
  return null;
}

function uiaXml(dump) {
  if (!dump) return '';
  if (typeof dump.result === 'string') return dump.result;
  if (dump.result && typeof dump.result.result === 'string') return dump.result.result;
  return typeof dump === 'string' ? dump : '';
}

async function tapIfFrozen(ctx, labels, key) {
  const value = labels[key];
  if (typeof value !== 'string' || value.length === 0) return;
  await callOk(ctx, 'tap-uia-text', { text: value });
}

async function callOk(ctx, command, args) {
  const result = await ctx.call(command, args);
  if (!result || result.ok === false) {
    throw new Error(result && result.error ? result.error : command);
  }
  return result;
}

function frozenText(labels, key) {
  const value = labels[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`label_not_frozen:${key}`);
  }
  return value;
}

function poiVisible(texts, labels) {
  const hasPoi = texts.some((text) => text.includes(labels.poi));
  const hasPlace = texts.includes(labels.bookmark)
    || texts.includes(labels.bookmarkDelete)
    || texts.includes(labels.route);
  return hasPoi && hasPlace;
}

function collectTexts(tree) {
  const xml = typeof tree === 'string' ? tree : uiaXml({ result: tree });
  if (xml.startsWith('<') || xml.includes('<hierarchy') || xml.includes('<node')) {
    return Array.from(xml.matchAll(/(?:text|content-desc)="([^"]+)"/g), (match) => match[1]);
  }
  const found = [];
  walk(tree && tree.root, found);
  return found;
}

function walk(node, found) {
  if (!node) return;
  if (typeof node.text === 'string') found.push(node.text);
  for (const child of node.children || []) walk(child, found);
}

module.exports = { main, bookmarkState, mapVisible, settingState };
