'use strict';

async function main(ctx) {
  const labels = ctx.inputs.labels;
  await ctx.call('uia-tree', {});
  if (labels.skipOnboarding) {
    await ctx.call('tap-uia-text', { text: labels.skipOnboarding });
    await ctx.call('uia-tree', {});
  }
  await ctx.call('tap-uia-text', { text: frozenText(labels, 'search') });
  await typeIntoSearch(ctx, frozenText(labels, 'poi'));
  await tapPoiTitle(ctx, frozenText(labels, 'poi'));
  const detail = await ctx.call('uia-tree', {});
  const shot = await ctx.call('screenshot', {});
  const texts = collectTexts(detail.result);
  await ctx.assert({
    name: 'poi-visible',
    predicateSummary: 'frozen POI is on the tree',
    condition: poiVisible(texts, labels),
    requiredEvidence: [],
    requireCoverage: 'complete',
    evidence: shot.evidence,
  });
  await tapIfFrozen(ctx, labels, 'bookmark');
  await tapIfFrozen(ctx, labels, 'route');
  await tapIfFrozen(ctx, labels, 'routeDownloadLater');
  await tapIfFrozen(ctx, labels, 'cancel');
  await ctx.checkpoint('organic-maps-core', { done: true });
  return { passed: true };
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
  await ctx.call('tap-uia-text', { text: value });
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

module.exports = { main };
