'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// App identity and selectors are observations from the frozen public bundle.
// Device identity, queries and business expectations are explicit inputs.
const PACKAGE = 'io.github.mobileaidev.notallyx.sample';
const ACTIVITY = 'com.philkes.notallyx.presentation.activity.main.MainActivity';
const WAIT_MS = 12000;
const MAX_SCROLLS = 8;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const sorted = values => [...new Set(values)].sort();
const sameSet = (left, right) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function children(node) {
  // The supplied raw trees omit children on leaves. Explicit null is a gap.
  if (!own(node, 'children')) return [];
  if (!Array.isArray(node.children)) throw new Error('public-contract-gap: non-array raw children');
  return node.children;
}

function validBounds(bounds) {
  return bounds && ['left', 'top', 'right', 'bottom'].every(key => Number.isFinite(bounds[key])) &&
    bounds.right > bounds.left && bounds.bottom > bounds.top;
}

function inside(inner, outer) {
  return validBounds(inner) && validBounds(outer) && inner.left >= outer.left &&
    inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom;
}

function overlaps(a, b) {
  return validBounds(a) && validBounds(b) && a.left < b.right && a.right > b.left &&
    a.top < b.bottom && a.bottom > b.top;
}

function inspectTree(data) {
  if (!data || data.ok !== true || data.activity !== ACTIVITY || data.windowCount !== 1 ||
      !Array.isArray(data.windows) || data.windows.length !== 1 ||
      data.windows[0].type !== 'activity' || data.windows[0].index !== 0 ||
      !data.windows[0].root || !validBounds(data.windows[0].bounds)) {
    throw new Error('public-contract-gap: expected one raw activity window at index 0');
  }
  const entries = [];
  function visit(node, ancestors) {
    if (!node || typeof node !== 'object') throw new Error('public-contract-gap: invalid raw node');
    entries.push({node, ancestors});
    for (const child of children(node)) visit(child, [...ancestors, node]);
  }
  visit(data.windows[0].root, []); // Deliberately ignore the duplicate top-level root.
  const visible = entries.filter(entry => entry.node.effectiveVisible === true);
  const unique = predicate => {
    const matches = visible.filter(entry => predicate(entry.node));
    return matches.length === 1 ? matches[0] : null;
  };
  const byId = id => unique(node => node.resourceName === `${PACKAGE}:id/${id}`);
  const list = byId('MainListView');
  const input = byId('EnterSearchKeyword');
  let viewport = null;
  if (list) {
    const bounds = [list.node.bounds, ...list.ancestors.map(node => node.bounds), data.windows[0].bounds];
    if (!bounds.every(validBounds)) throw new Error('public-contract-gap: missing list/ancestor bounds');
    viewport = {
      left: Math.max(...bounds.map(value => value.left)),
      top: Math.max(...bounds.map(value => value.top)),
      right: Math.min(...bounds.map(value => value.right)),
      bottom: Math.min(...bounds.map(value => value.bottom)),
    };
  }
  const withinList = entry => list && entry.ancestors.includes(list.node);
  const titleEntries = visible.filter(entry => withinList(entry) && entry.node.resourceName === `${PACKAGE}:id/Title`);
  if (titleEntries.some(entry => typeof entry.node.text !== 'string' || !entry.node.text.length)) {
    throw new Error('public-contract-gap: a visible title has no explicit nonempty text');
  }
  const externalControls = visible.filter(entry => entry.node.clickable === true && !withinList(entry) &&
    (!list || !list.ancestors.includes(entry.node)));
  const readable = titleEntries.filter(entry => inside(entry.node.bounds, viewport) &&
    entry.ancestors.every(node => inside(entry.node.bounds, node.bounds)) &&
    !externalControls.some(control => overlaps(entry.node.bounds, control.node.bounds)));
  const direct = list ? children(list.node).filter(node => node.effectiveVisible === true) : [];
  const header = direct.find(node => node.text === '已置顶' && inside(node.bounds, viewport));
  const cards = direct.filter(node => node.simpleClassName === 'MaterialCardView');
  const image = byId('ImageView');
  const snapshot = {
    activity: data.activity,
    windowType: data.windows[0].type,
    windowIndex: data.windows[0].index,
    windowBounds: data.windows[0].bounds,
    query: input ? {textPresent: own(input.node, 'text'), text: input.node.text} : null,
    viewport,
    readableTitles: readable.map(entry => entry.node.text),
    titleBounds: titleEntries.map(entry => ({text: entry.node.text, bounds: entry.node.bounds,
      readable: readable.includes(entry)})),
    directListChildren: direct.map(node => ({className: node.simpleClassName,
      textPresent: own(node, 'text'), text: node.text, bounds: node.bounds})),
    emptyIllustration: Boolean(image && image.node.contentDescription === 'Background' && inside(image.node.bounds, viewport)),
  };
  return {
    entries, visible, list, input, viewport, titleEntries, readable, snapshot,
    search: unique(node => node.contentDescription === '搜索'),
    cancel: unique(node => node.contentDescription === '取消'),
    toolbar: byId('Toolbar'),
    atTop: Boolean(header && header.bounds.top - viewport.top <= header.bounds.bottom - header.bounds.top),
    terminalCardFits: Boolean(cards.length && inside(cards.at(-1).bounds, viewport)),
    signature: JSON.stringify(snapshot),
  };
}

function queryIs(view, query) {
  return Boolean(view.input && own(view.input.node, 'text') && view.input.node.text === query &&
    view.cancel && view.list && validBounds(view.viewport));
}

function homeIsReady(view) {
  return Boolean(!view.input && view.search && !view.cancel && view.toolbar && view.list &&
    view.readable.length > 0 && view.visible.some(entry => entry.node.text === '笔记'));
}

module.exports.main = async function main(ctx) {
  const inputs = ctx.inputs;
  if (!inputs || typeof inputs.out !== 'string' || !path.isAbsolute(inputs.out)) {
    throw new Error('inputs.out must be an absolute, fresh output directory');
  }
  const out = inputs.out;
  const device = inputs.device;
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error('inputs.out must be empty');
  fs.mkdirSync(out, {recursive: true});
  for (const directory of ['calls', 'pages', 'assertions', 'screenshots', 'actions']) {
    fs.mkdirSync(path.join(out, directory));
  }
  const write = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2) + '\n');
  const summary = {
    schemaVersion: 'intent-reuse-search-result/v1',
    startedAt: new Date().toISOString(), status: 'running', currentPhase: 'inputs',
    expected: inputs.expected, cancelAfterTitle: inputs.cancelAfterTitle,
    calls: [], assertions: [], pages: [], stages: {},
    limitations: [
      'Keyboard-state envelopes are preserved without interpreting undocumented response fields. Viewport restoration is asserted; direct keyboard Boolean verification remains with the controller.',
      'Screenshots and trees are sequential captures with matching observations before and after, not an atomic capture.',
      'Scroll endpoints use the observed pinned heading or a settled unchanged in-list gesture with the final card fitting the viewport; the public tree provides no explicit scroll-end metric.',
      'APK hash, database, preferences, and independent business acceptance are controller responsibilities.',
    ],
  };
  let sequence = 0;
  let pageSequence = 0;
  let latestTree = null;
  let baselineBottom;
  let baselineWidth;
  const saveSummary = () => write('summary.json', summary);
  saveSummary();
  write('inputs.json', inputs);

  async function call(command, args, label) {
    const id = String(++sequence).padStart(4, '0');
    const file = `calls/${id}-${label}-${command}.json`;
    const request = {command, arguments: args, requestedAt: new Date().toISOString()};
    write(file, {request, state: 'requested'});
    summary.calls.push({file, command, label, state: 'requested'});
    saveSummary();
    try {
      const envelope = await ctx.call(command, args);
      write(file, {request, completedAt: new Date().toISOString(), envelope});
      summary.calls.at(-1).state = envelope.ok === true ? 'returned-ok' : 'returned-error';
      saveSummary();
      if (envelope.ok !== true) throw new Error(`${label}:${command}:${JSON.stringify(envelope.error)}`);
      return {envelope, file};
    } catch (error) {
      // If the SDK threw, retain the request and the thrown error separately.
      write(`${file}.error.json`, {message: error.message, stack: error.stack, at: new Date().toISOString()});
      throw error;
    }
  }

  async function check(name, condition, read, details = {}) {
    const spec = read ? {name, condition: Boolean(condition), requiredEvidence: ['tree'], evidence: read.envelope.evidence} :
      {scope: 'code', name, condition: Boolean(condition)};
    const result = await ctx.assert(spec);
    const record = {at: new Date().toISOString(), name, condition: Boolean(condition),
      scope: read ? 'device' : 'code', treeCallFile: read ? read.file : null, details, result};
    const file = `assertions/${String(summary.assertions.length + 1).padStart(4, '0')}-${name}.json`;
    write(file, record);
    summary.assertions.push({file, name, scope: record.scope, verdict: result.verdict});
    saveSummary();
    if (result.verdict !== 'passed') throw new Error(`${name}:${result.verdict}:${result.reason || ''}`);
    return record;
  }

  async function tree(label) {
    const read = await call('tree', {compact: false}, label);
    latestTree = read;
    return {read, view: inspectTree(read.envelope.result)};
  }

  async function screenshot(label) {
    const file = `screenshots/${String(sequence + 1).padStart(4, '0')}-${label}.png`;
    const read = await call('screenshot', {packageName: PACKAGE, outFile: path.join(out, file)}, label);
    const bytes = fs.readFileSync(path.join(out, file));
    await check(`${label}.png-file`, bytes.length >= 24 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), null,
    {screenshotCallFile: read.file, file});
    return {read, file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)};
  }

  async function waitStable(label, predicate) {
    const deadline = Date.now() + WAIT_MS;
    let previous = null;
    let current;
    do {
      current = await tree(`${label}-poll`);
      if (predicate(current.view) && previous === current.view.signature) return current;
      previous = predicate(current.view) ? current.view.signature : null;
      // Poll pacing only. Passing requires a fresh matching observation.
      await sleep(150);
    } while (Date.now() < deadline);
    await screenshot(`${label}-timeout`);
    await check(`${label}.observable-deadline`, false, current.read,
      {deadlineMs: WAIT_MS, lastSnapshot: current.view.snapshot});
  }

  async function page(label, predicate) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = await waitStable(label, predicate);
      const keyboard = await call('keyboard-state', {}, `${label}-keyboard`);
      const shot = await screenshot(`${label}-${attempt}`);
      const after = await tree(`${label}-after-screenshot`);
      const file = `pages/${String(++pageSequence).padStart(3, '0')}-${label}.json`;
      const stable = before.view.signature === after.view.signature && predicate(after.view);
      const record = {label, at: new Date().toISOString(), stable,
        association: 'sequential screenshot between equal raw-tree snapshots; not atomic',
        beforeTreeCallFile: before.read.file, treeCallFile: after.read.file,
        screenshotCallFile: shot.read.file, screenshotFile: shot.file,
        screenshotSha256: shot.sha256, keyboardCallFile: keyboard.file,
        keyboardInterpretation: 'raw response preserved; public response schema unavailable',
        snapshot: after.view.snapshot};
      write(file, record);
      summary.pages.push({file, label, stable, readableTitles: record.snapshot.readableTitles});
      saveSummary();
      if (stable) {
        await check(`${label}.capture-bounds`, shot.width === after.view.snapshot.windowBounds.right &&
          shot.height === after.view.snapshot.windowBounds.bottom, null,
        {pageFile: file, width: shot.width, height: shot.height});
        return {...after, file, record};
      }
      if (attempt === 3) await check(`${label}.stable-around-screenshot`, false, after.read, {pageFile: file});
    }
  }

  async function checkTarget(label) {
    const read = await call('status', {}, `${label}-target`);
    const value = read.envelope.result;
    await check(`${label}.target-status-fields`, value.app?.packageName === PACKAGE &&
      value.app?.versionName === '7.11.2-aab-baseline' && value.app?.versionCode === 71120 &&
      value.android?.manufacturer === device.manufacturer && value.android?.model === device.model &&
      value.android?.sdkInt === device.sdkInt && value.activity?.current === ACTIVITY &&
      value._feedback?.target?.serial === device.serial && value._feedback?.target?.packageName === PACKAGE,
    null, {statusCallFile: read.file, expectedSerial: device.serial, expectedPackage: PACKAGE,
      note: 'Payload comparison recorded as code; raw status envelope is retained.'});
  }

  function fullViewport(view) {
    return validBounds(view.viewport) && view.viewport.bottom === baselineBottom &&
      view.viewport.right - view.viewport.left === baselineWidth;
  }

  async function action(label, command, predicate, select, argsFor) {
    await checkTarget(label);
    const current = await page(`${label}-before`, predicate);
    const entry = select(current.view);
    const valid = entry && entry.node.enabled === true &&
      inside(entry.node.bounds, current.view.snapshot.windowBounds) &&
      entry.ancestors.every(node => inside(entry.node.bounds, node.bounds));
    await check(`${label}.current-locator`, valid, current.read, {pageFile: current.file});
    const args = argsFor(entry.node, current.view);
    write(`actions/${String(sequence + 1).padStart(4, '0')}-${label}.json`, {
      at: new Date().toISOString(), command, arguments: args,
      basedOnTreeCallFile: current.read.file, basedOnPageFile: current.file,
      locator: {resourceName: entry.node.resourceName, contentDescription: entry.node.contentDescription,
        className: entry.node.simpleClassName, bounds: entry.node.bounds},
    });
    return call(command, args, label);
  }

  const center = bounds => ({tapX: Math.round((bounds.left + bounds.right) / 2),
    tapY: Math.round((bounds.top + bounds.bottom) / 2)});
  async function setQuery(label, previousQuery, nextQuery, hideKeyboard) {
    return action(label, 'input-text', view => queryIs(view, previousQuery), view =>
      view.input && view.input.node.editable === true ? view.input : null,
    node => ({...center(node.bounds), text: nextQuery, hideKeyboard}));
  }

  async function swipe(label, query, direction) {
    return action(label, 'swipe', view => queryIs(view, query) && fullViewport(view), view => view.list,
      (_node, view) => {
        const b = view.viewport;
        const x = Math.round((b.left + b.right) / 2);
        const high = Math.round(b.top + (b.bottom - b.top) * 0.2);
        const low = Math.round(b.top + (b.bottom - b.top) * 0.8);
        return {startX: x, endX: x, startY: direction === 'earlier' ? high : low,
          endY: direction === 'earlier' ? low : high, durationMs: 400};
      });
  }

  async function resultPage(label, query, wanted, exact) {
    const current = await page(label, view => queryIs(view, query) && fullViewport(view) && view.readable.length > 0);
    const actual = current.view.snapshot.readableTitles;
    const observed = current.view.titleEntries.map(entry => entry.node.text);
    await check(`${label}.query-viewport-and-results`, queryIs(current.view, query) && fullViewport(current.view) &&
      !current.view.snapshot.emptyIllustration && actual.length === new Set(actual).size &&
      (exact ? sameSet(actual, wanted) && sameSet(observed, wanted) : observed.every(title => wanted.includes(title))),
    current.read, {pageFile: current.file, expected: wanted, readable: actual, observedIncludingClipped: observed});
    return current;
  }

  async function toTop(label, query, wanted, current, recordPage) {
    for (let index = 1; !current.view.atTop && index <= MAX_SCROLLS; index++) {
      const previous = current.view.signature;
      await swipe(`${label}-earlier-${index}`, query, 'earlier');
      current = await recordPage(`${label}-earlier-${index}-result`, query, wanted);
      await check(`${label}-earlier-${index}.list-moved`, current.view.signature !== previous,
        null, {pageFile: current.file, comparison: 'previous and current page geometry; code scope'});
    }
    await check(`${label}.top-heading-visible`, current.view.atTop, current.read, {pageFile: current.file});
    return current;
  }

  try {
    const expected = inputs.expected;
    const validDevice = device && ['serial', 'manufacturer', 'model'].every(key =>
      typeof device[key] === 'string' && device[key].length > 0) &&
      Number.isInteger(device.sdkInt) && device.sdkInt > 0;
    const validExpected = expected && ['title', 'body', 'empty'].every(stage =>
      expected[stage] && typeof expected[stage].query === 'string' && expected[stage].query.length > 0 &&
      Array.isArray(expected[stage].titles) && expected[stage].titles.every(title => typeof title === 'string' && title.length > 0) &&
      new Set(expected[stage].titles).size === expected[stage].titles.length);
    await check('inputs.explicit-contract', validExpected && validDevice && expected.title.titles.length === 1 &&
      expected.body.titles.length > 1 && expected.empty.titles.length === 0 && typeof inputs.cancelAfterTitle === 'boolean', null);
    await checkTarget('initial');
    summary.currentPhase = 'home';
    const initial = await page('home-initial', homeIsReady);
    baselineBottom = initial.view.viewport.bottom;
    baselineWidth = initial.view.viewport.right - initial.view.viewport.left;
    const restoredAnchors = initial.view.snapshot.readableTitles.slice(0, 2);
    await check('home.ready-and-query-not-on-first-screen', homeIsReady(initial.view) &&
      !initial.view.titleEntries.some(entry => entry.node.text === expected.title.query), initial.read,
    {pageFile: initial.file, titleQuery: expected.title.query, restoredAnchors});

    await action('open-search', 'tap', homeIsReady,
      view => view.search?.node.clickable === true ? view.search : null, node => center(node.bounds));
    const opened = await page('search-open', view => queryIs(view, '') && view.readable.length > 0);
    await check('search.open-with-explicit-empty-input', queryIs(opened.view, ''), opened.read,
      {pageFile: opened.file, currentViewport: opened.view.viewport, baselineBottom});

    summary.currentPhase = 'title';
    await setQuery('title-input', '', expected.title.query, false);
    // This wait is independent of expected.title.titles, so a wrong injected
    // expected title reaches a fresh failing assertion instead of timing out on it.
    const filtered = await page('title-filtered-with-keyboard', view => queryIs(view, expected.title.query) &&
      view.titleEntries.length > 0 && view.titleEntries.every(entry => entry.node.text === expected.title.query));
    await check('title.filtered-set-equality', sameSet(filtered.view.snapshot.readableTitles, expected.title.titles),
      filtered.read, {pageFile: filtered.file, expected: expected.title.titles,
        actual: filtered.view.snapshot.readableTitles, actualViewport: filtered.view.viewport});
    await action('title-hide-keyboard', 'hide-keyboard', view => queryIs(view, expected.title.query),
      view => view.input, () => ({}));
    const titleFull = await resultPage('title-full', expected.title.query, expected.title.titles, true);
    await check('title.short-card-fits-full-viewport', titleFull.view.atTop && titleFull.view.terminalCardFits,
      titleFull.read, {pageFile: titleFull.file});
    await swipe('title-scroll-check', expected.title.query, 'later');
    const titleAfter = await resultPage('title-after-scroll', expected.title.query, expected.title.titles, true);
    await check('title.short-list-unchanged-after-in-list-swipe', titleAfter.view.signature === titleFull.view.signature,
      null, {beforePageFile: titleFull.file, afterPageFile: titleAfter.file});
    summary.stages.title = {status: 'passed', pages: [filtered.file, titleFull.file, titleAfter.file]};
    saveSummary();

    if (inputs.cancelAfterTitle === true) {
      summary.status = 'cancellation-checkpoint';
      summary.currentPhase = 'title-complete';
      write('cancellation-checkpoint.json', {at: new Date().toISOString(), title: summary.stages.title,
        callsBeforeCheckpoint: sequence, subsequentBusinessPhase: 'body'});
      saveSummary();
      await ctx.progress({phase: 'title-complete'});
      const decision = await ctx.askAgent({question: 'intent-reuse cancellation checkpoint'});
      write('unexpected-checkpoint-resumption.json', {at: new Date().toISOString(), decision});
      throw new Error('cancellation checkpoint resumed; this cancellation-only branch dispatches no body action');
    }

    summary.currentPhase = 'body';
    await setQuery('body-input', expected.title.query, expected.body.query, true);
    await waitStable('body-filtering', view => queryIs(view, expected.body.query) && fullViewport(view) &&
      view.titleEntries.some(entry => entry.node.text !== expected.title.query));
    const bodyPages = [];
    const bodySeen = new Set();
    async function bodyPage(label, query, wanted) {
      const current = await resultPage(label, query, wanted, false);
      bodyPages.push(current.file);
      for (const title of current.view.snapshot.readableTitles) bodySeen.add(title);
      write('body-union.json', {pages: bodyPages, observed: sorted([...bodySeen]), expected: expected.body.titles,
        scope: 'code aggregation; each included page has its own device assertion'});
      return current;
    }
    let body = await bodyPage('body-initial-page', expected.body.query, expected.body.titles);
    body = await toTop('body', expected.body.query, expected.body.titles, body, bodyPage);
    let reachedEnd = false;
    for (let index = 1; index <= MAX_SCROLLS; index++) {
      const previous = body.view.signature;
      const beforePage = body.file;
      await swipe(`body-later-${index}`, expected.body.query, 'later');
      body = await bodyPage(`body-later-${index}-result`, expected.body.query, expected.body.titles);
      if (body.view.signature === previous) {
        await check(`body-later-${index}.terminal-card-fits`, body.view.terminalCardFits, body.read,
          {pageFile: body.file});
        await check('body.settled-end-geometry', body.view.signature === previous, null,
          {beforePageFile: beforePage, afterPageFile: body.file});
        reachedEnd = true;
        break;
      }
    }
    await check('body.reached-observed-end-within-bound', reachedEnd, null,
      {maxScrolls: MAX_SCROLLS, pageFiles: bodyPages});
    await check('body.cross-page-set-equality', sameSet([...bodySeen], expected.body.titles), null,
      {pageFiles: bodyPages, actual: sorted([...bodySeen]), expected: expected.body.titles});
    summary.stages.body = {status: 'passed', pages: bodyPages, observed: sorted([...bodySeen])};
    saveSummary();

    summary.currentPhase = 'empty';
    await setQuery('empty-input', expected.body.query, expected.empty.query, true);
    const empty = await page('empty-results', view => queryIs(view, expected.empty.query) && fullViewport(view) &&
      view.titleEntries.length === 0 && view.snapshot.emptyIllustration);
    await check('empty.query-zero-titles-and-illustration', queryIs(empty.view, expected.empty.query) &&
      sameSet(empty.view.snapshot.readableTitles, expected.empty.titles) && empty.view.titleEntries.length === 0 &&
      empty.view.snapshot.emptyIllustration, empty.read, {pageFile: empty.file});
    summary.stages.empty = {status: 'passed', pages: [empty.file]};
    saveSummary();

    summary.currentPhase = 'clear';
    await setQuery('clear-input', expected.empty.query, '', true);
    async function clearPage(label) {
      const current = await page(label, view => queryIs(view, '') && fullViewport(view) &&
        view.readable.length > 0 && !view.snapshot.emptyIllustration);
      await check(`${label}.explicit-empty-input-and-restored-results`, queryIs(current.view, '') &&
        !current.view.snapshot.emptyIllustration && current.view.readable.length > 0, current.read, {pageFile: current.file});
      return current;
    }
    let cleared = await clearPage('clear-results');
    cleared = await toTop('clear', '', [], cleared, clearPage);
    await check('clear.baseline-note-anchors-restored', restoredAnchors.every(title =>
      cleared.view.snapshot.readableTitles.includes(title)), cleared.read, {pageFile: cleared.file, restoredAnchors});
    summary.stages.clear = {status: 'passed', pages: [cleared.file], scope: 'empty input and visible baseline note anchors'};
    saveSummary();

    summary.currentPhase = 'home-return';
    await action('close-search', 'tap', view => queryIs(view, '') && fullViewport(view),
      view => view.cancel?.node.clickable === true ? view.cancel : null, node => center(node.bounds));
    const home = await page('home-return', homeIsReady);
    await check('home.search-closed-and-baseline-notes-restored', homeIsReady(home.view) && fullViewport(home.view) &&
      restoredAnchors.every(title => home.view.snapshot.readableTitles.includes(title)), home.read,
    {pageFile: home.file, restoredAnchors});
    summary.stages.homeReturn = {status: 'passed', pages: [home.file]};
    summary.status = 'ui-assertions-passed';
    summary.currentPhase = 'complete';
    summary.finishedAt = new Date().toISOString();
    saveSummary();
    return summary;
  } catch (error) {
    summary.status = 'failed-or-interrupted';
    summary.finishedAt = new Date().toISOString();
    summary.error = {message: error.message, stack: error.stack};
    summary.lastTreeCallFile = latestTree ? latestTree.file : null;
    saveSummary();
    throw error;
  }
};
