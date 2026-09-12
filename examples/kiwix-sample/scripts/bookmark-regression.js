'use strict';

const fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto');
const flatten = node => node ? [node, ...(node.children || []).flatMap(flatten)] : [];
const matches = (read, label, type) => flatten(read.result.source)
  .filter(n => n.isVisible === '1' && n.label === label && n.type === type);
const has = (read, label, type = 'Button') => matches(read, label, type).length === 1;
// WDA may mark the background article title visible beneath a search overlay.
// Bind the result Button containing the exact title from this fresh tree.
const searchResults = (read, title) => flatten(read.result.source).filter(n => n.type === 'Button'
  && n.isVisible === '1' && n.children?.some(child => child.type === 'StaticText' && child.label === title));

// Authored from the 2026-09-11 real Kiwix search/save/cancel and restart Intents.
// Explicit baseline: the Climate change article's bookmark sheet is open, with
// exactly that bookmark saved in the independently captured Core Data store.
module.exports.main = async ctx => {
  const { outputDir, wdaSessionId } = ctx.inputs;
  if (!outputDir || !wdaSessionId) throw new Error('outputDir and an explicit WDA session are required');
  fs.mkdirSync(outputDir, { recursive: false });
  let sessionId = wdaSessionId, sequence = 0;
  const checks = [], artifacts = [], startedAtMs = Date.now();
  async function call(command, args = {}, native = true) {
    const read = await ctx.call(command, { ...(native ? { wdaSessionId: sessionId } : {}), ...args });
    fs.writeFileSync(path.join(outputDir, `${String(++sequence).padStart(3, '0')}-${command}.json`), JSON.stringify(read, null, 2) + '\n', { flag: 'wx' });
    if (!read.ok) throw new Error(`${command}: ${read.error}: ${JSON.stringify(read.result)}`);
    return read;
  }
  async function check(name, condition, read, stream = 'tree') {
    const verdict = await ctx.assert({ name, condition, requiredEvidence: [stream], evidence: read.evidence });
    checks.push(verdict);
    if (verdict.verdict !== 'passed') throw new Error(`${name}: ${verdict.verdict}`);
  }
  const tap = label => call('ios-tap-native', { selector: { label, type: 'Button' } });
  async function waitNative(name, predicate) {
    const deadline = Date.now() + 15000;
    let read;
    do {
      read = await call('ios-uia-tree');
      if (predicate(read)) break;
      if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    await check(name, predicate(read), read);
    return read;
  }
  async function page(title, article, body) {
    const deadline = Date.now() + 10000;
    let read;
    do {
      read = await call('ios-h5-dom', {}, false);
      if (read.result.dom.readyState === 'complete' && read.result.dom.title === title) break;
      if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    const dom = read.result.dom;
    await check(`${title}: actual local article title, URL and body`, dom.readyState === 'complete'
      && dom.title === title && dom.url === `zim://53293C1B-CED3-5244-564A-B40E435E2F0A/${article}`
      && dom.bodyText.includes(body) && !dom.bodyTextTruncated, read);
    return read;
  }
  async function screenshot(name) {
    const outFile = path.join(outputDir, name + '.png');
    const read = await call('ios-screenshot', { outFile }, false);
    const sha256 = createHash('sha256').update(fs.readFileSync(outFile)).digest('hex');
    await check(`${name}: actual screenshot bytes`, read.evidence.refs.some(ref => ref.stream === 'screenshot' && ref.sha256 === sha256), read, 'screenshot');
    artifacts.push({ name, path: outFile, sha256, evidence: read.evidence, binding: 'separate capture after nearby tree/DOM; not atomic' });
  }
  const sheetClosed = read => !has(read, 'Done') && !has(read, 'Bookmarks', 'StaticText') && has(read, 'Search', 'SearchField');
  await waitNative('baseline saved Climate change bookmark and removal control', read =>
    has(read, 'Climate change') && has(read, 'Remove Bookmark') && !has(read, 'Greenhouse gas'));
  await tap('Remove Bookmark');
  await waitNative('removing the existing bookmark leaves an empty list', read =>
    has(read, 'No bookmarks', 'StaticText') && has(read, 'Add Bookmark') && !has(read, 'Climate change'));
  await tap('Done');
  await waitNative('bookmark sheet closes before native search', sheetClosed);
  await call('ios-input-native-text', { selector: { label: 'Search', type: 'SearchField' }, text: 'Climate change' });
  const search = await waitNative('native search returns the exact Climate change result Button', read =>
    searchResults(read, 'Climate change').length === 1 && matches(read, 'Search', 'SearchField').some(n => n.value === 'Climate change'));
  await call('ios-tap-native', { selector: { elementId: searchResults(search, 'Climate change')[0].elementId, type: 'Button' } });
  await page('Climate change', 'Climate_change', 'climate change describes global warming');
  await tap('Show Bookmarks');
  await waitNative('unsaved article has an enabled Add Bookmark control', read =>
    has(read, 'No bookmarks', 'StaticText') && matches(read, 'Add Bookmark', 'Button').some(n => n.isEnabled === '1'));
  await tap('Add Bookmark');
  await waitNative('save publishes the real bookmark row and removal control', read =>
    has(read, 'Climate change') && has(read, 'Remove Bookmark') && !has(read, 'No bookmarks', 'StaticText'));
  await screenshot('saved-climate-bookmark');
  await tap('Done');
  await waitNative('saved bookmark sheet closes', sheetClosed);
  await call('ios-h5-click', { selector: { text: 'greenhouse gases', tag: 'a' } }, false);
  await page('Greenhouse gas', 'Greenhouse_gas', 'Greenhouse gases (GHGs)');
  await tap('Show Bookmarks');
  await waitNative('second article is unsaved while the first bookmark remains', read =>
    has(read, 'Add Bookmark') && has(read, 'Climate change') && !has(read, 'Greenhouse gas') && !has(read, 'Remove Bookmark'));
  await tap('Done');
  const beforeRestart = await waitNative('cancel closes the second article bookmark sheet', sheetClosed);
  await screenshot('greenhouse-bookmark-cancelled');
  const previousProcessId = beforeRestart.result.session.processId;
  await call('ios-wda-session', { operation: 'close' });
  await call('ios-launch-app', { terminateExisting: true }, false);
  const created = await call('ios-wda-session', { operation: 'create' }, false);
  sessionId = created.result.session.sessionId;
  const afterRestart = await waitNative('real App restart has a new process and home bookmark control', read =>
    read.result.session.processId !== previousProcessId && has(read, 'Show Bookmarks'));
  await tap('Show Bookmarks');
  await waitNative('saved bookmark survives restart and cancelled article is absent', read =>
    has(read, 'Climate change') && !has(read, 'Greenhouse gas') && !has(read, 'No bookmarks', 'StaticText'));
  await screenshot('bookmarks-after-restart');
  await tap('Climate change');
  await page('Climate change', 'Climate_change', 'climate change describes global warming');
  await screenshot('bookmark-reopens-actual-article');
  const result = { ok: true, startedAtMs, completedAtMs: Date.now(), elapsedMs: Date.now() - startedAtMs,
    sessionId, previousProcessId, processId: afterRestart.result.session.processId, checks, artifacts,
    scope: 'native bookmark removal/search/save, H5 navigation, cancel, real App restart and bookmark reopening; external Core Data verdict is recorded separately' };
  fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
};
