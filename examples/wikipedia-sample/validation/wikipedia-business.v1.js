'use strict';

// Fixed P9 flow authored from the 2026-09-12 Wikipedia Intent observations.
// Only public Bridge commands mutate the device. The controller independently
// reads original SQLite/SharedPreferences and returns bounded evidence refs.
const fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto');
const PACKAGE = 'org.wikipedia.dev.bridge_sample';
const MAIN = 'org.wikipedia.main.MainActivity', PAGE = 'org.wikipedia.page.PageActivity';
const LIST = 'org.wikipedia.readinglist.ReadingListActivity';
const SETTINGS = 'org.wikipedia.settings.SettingsActivity';
const LANGUAGES = 'org.wikipedia.settings.languages.WikipediaLanguagesActivity';
const CN = '中文（中国大陆）', TW = '中文（臺灣）';
const MOON = '月球', EMPTY_QUERY = 'AABNoArticle20260912QXZV';
const ARTICLE_URL = 'https://zh.wikipedia.org/api/rest_v1/page/mobile-html/%E6%9C%88%E7%90%83';
const id = name => `${PACKAGE}:id/${name}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports.main = async ctx => {
  const { serial, outputDir, listName, cancelledListName, listDescription } = ctx.inputs;
  if (typeof serial !== 'string' || !path.isAbsolute(outputDir)
    || !/^AAB Script Moon [A-Za-z0-9-]+$/.test(listName)
    || !/^AAB Script Cancel [A-Za-z0-9-]+$/.test(cancelledListName)
    || typeof listDescription !== 'string' || listDescription.length === 0) {
    throw Error('Explicit device, new output directory and unique synthetic reading-list inputs required');
  }
  fs.mkdirSync(outputDir, { recursive: false });
  const startedAtMs = Date.now(), assertions = [], actions = [], artifacts = [], externalOracles = [], captures = [];
  const searchRequests = [];
  const reobservations = [];
  let sequence = 0, lastActionId = null, captureSinceMs, runtimeEpoch;
  async function call(command, args = {}, allowRefusal = false) {
    const read = await ctx.call(command, { ...args, feedback: 'off' });
    fs.writeFileSync(path.join(outputDir, `${String(++sequence).padStart(3, '0')}-${command}.json`), JSON.stringify(read, null, 2), { flag: 'wx' });
    if (!read.ok && !allowRefusal) throw Error(`${command}: ${JSON.stringify(read.result)}`);
    return read;
  }
  function recordMutation(command, read) {
    const kind = command === 'tap-uia' ? 'uia-node' : command === 'keyevent' ? 'android-shell' : 'native';
    const receipt = read.executionReceipt;
    if (receipt?.settled !== true || receipt.kind !== kind || typeof receipt.actionId !== 'string'
      || receipt.actionId.length === 0 || receipt.actionId !== read.execution?.actionId) {
      throw Error(`Original matching execution receipt required for ${command}`);
    }
    lastActionId = receipt.actionId;
    actions.push({ command, actionId: lastActionId, kind });
    return read;
  }
  async function mutate(command, args) {
    return recordMutation(command, await call(command, args));
  }
  function nativeNodes(read) {
    const window = [...read.result.windows].reverse().find(w => w.root.visible === true && w.root.alpha > 0);
    // During an Activity transition no window may be visible yet. That is an
    // unready observation, not permission to act on a hidden previous window.
    if (!window) return [];
    const result = [];
    const contains = (b, x, y) => x >= b.left && x < b.right && y >= b.top && y < b.bottom;
    function visit(node, ancestors = []) {
      if (node.visible !== true || node.effectiveVisible === false || node.alpha <= 0) return;
      const b = node.bounds, x = (b.left + b.right) / 2, y = (b.top + b.bottom) / 2;
      if (b.right > b.left && b.bottom > b.top && contains(window.bounds, x, y)
        && ancestors.every(a => contains(a.bounds, x, y))) result.push(node);
      for (const child of node.children || []) visit(child, [...ancestors, node]);
    }
    visit(window.root); return result;
  }
  function uiaNodes(read) {
    if (read.result.truncated) throw Error('Focused UIA observation exceeded the fixed scenario bound');
    if (read.result.nodes.some(n => n.packageName !== PACKAGE)) throw Error('UIA observed another foreground package');
    return read.result.nodes;
  }
  async function wait(command, args, predicate, description, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    do {
      const read = await call(command, args, true);
      if (read.ok) {
        if (predicate(read)) return read;
      } else if (command !== 'tree' || read.result.error !== 'no_current_activity') {
        throw Error(`${command}: ${JSON.stringify(read.result)}`);
      }
      // Between Activity pause and resume the SDK intentionally has no owner.
      // This bounded read-only wait observes again; it never replays an action.
      await sleep(180);
    } while (Date.now() < deadline);
    throw Error(`Wikipedia state timeout: ${description}`);
  }
  const native = (predicate, description) => wait('tree', { compact: false }, r => predicate(nativeNodes(r), r), description);
  const uia = (predicate, description) => wait('uia-tree', { compact: true, visibleOnly: true, maxNodes: 200 },
    r => predicate(uiaNodes(r), r), description);
  const hasText = (nodes, text) => nodes.some(n => n.text === text);
  const nativeId = (nodes, name) => nodes.find(n => n.resourceName === id(name));
  const uiaId = (nodes, name) => nodes.find(n => n.resourceId === id(name));
  async function check(name, condition, read, requiredEvidence = ['tree']) {
    const result = await ctx.assert({ name, condition, requiredEvidence, evidence: read.evidence });
    assertions.push(result);
    if (result.verdict !== 'passed') throw Error(`${name}: ${result.verdict}`);
  }
  async function tapNative(selector) {
    await native(nodes => nodes.filter(n => Object.entries(selector).every(([k, v]) => n[k] === v)
      && n.enabled === true).length === 1, `one enabled Native target ${JSON.stringify(selector)}`);
    return mutate('tap-native', { selector });
  }
  async function tapUia(predicate, description) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let previous;
      const read = await uia(nodes => {
        const matches = nodes.filter(predicate);
        if (matches.length !== 1 || matches[0].enabled !== true) { previous = undefined; return false; }
        const node = matches[0];
        const signature = JSON.stringify([node.className, node.resourceId, node.text, node.contentDescription,
          node.bounds, node.enabled, node.checked, node.clickable]);
        const stable = signature === previous; previous = signature;
        return stable;
      }, 'stable ' + description);
      const target = uiaNodes(read).find(predicate);
      if (!target.targetRef) throw Error('Observed UIA target reference is absent');
      const result = await call('tap-uia', { targetRef: target.targetRef }, true);
      if (result.ok) return recordMutation('tap-uia', result);
      const receipt = result.executionReceipt;
      // Reobserve only after an original settled receipt proves that this click
      // never reached admission. A dispatched or unknown outcome is not retried.
      if (receipt?.kind !== 'uia-node' || receipt.settled !== true
        || typeof receipt.actionId !== 'string' || receipt.actionId.length === 0
        || receipt.actionId !== result.execution?.actionId || receipt.dispatched !== false
        || receipt.ambiguous !== false || receipt.error !== 'uia_reobserve_required'
        || result.result.completion !== 'before_admission') {
        throw Error(`tap-uia: ${JSON.stringify(result.result)}`);
      }
      reobservations.push({ actionId: receipt.actionId, error: receipt.error, targetRef: target.targetRef });
      await sleep(180);
    }
    throw Error(`UIA target did not remain stable after three fresh observations: ${description}`);
  }
  async function tapContentsEntry(title) {
    await native(nodes => nodes.filter(n => n.resourceName === id('page_toc_item_text')
      && n.text === title && n.enabled === true).length === 1, `exact contents entry ${title}`);
    return mutate('tap-native', { selector: { resourceName: id('page_toc_item_text'),
      within: { text: title, ancestor: { className: 'android.widget.LinearLayout',
        parent: { resourceName: id('toc_list') } } } } });
  }
  async function input(name, text) {
    await native(nodes => nodes.filter(n => n.resourceName === id(name) && n.enabled === true
      && n.editable === true).length === 1, `visible editable ${name}`);
    await mutate('input-text', { selector: { resourceName: id(name) }, text });
    return native(nodes => nativeId(nodes, name)?.text === text, `exact input ${name}`);
  }
  function completeNetworkWindow(read) {
    const coverage = read.evidence.coverage, captured = read.evidence.capture;
    if (coverage.status !== 'complete' || coverage.gap !== false || coverage.committed !== true
      || captured.hasMore !== false || captured.runtimeEpoch !== runtimeEpoch || captured.targetKey !== PACKAGE) {
      throw Error('Search requires one complete committed network page within the 500-record bound');
    }
    return captured;
  }
  function searchResponses(read, query, inputStartedAtMs) {
    return read.result.items.filter(request => {
      if (request.method !== 'GET' || request.statusCode !== 200 || request.timestampMs < inputStartedAtMs) return false;
      const url = new URL(request.url);
      return url.origin === 'https://zh.wikipedia.org' && url.pathname === '/w/api.php'
        && url.searchParams.get('action') === 'query' && url.searchParams.get('generator') === 'prefixsearch'
        && url.searchParams.get('gpssearch') === query;
    });
  }
  async function inputSearch(query) {
    // The Host records this committed watermark before the input mutation. All
    // subsequent reads keep that lower cursor until this input is asserted.
    const before = await call('network', { sinceMs: captureSinceMs, runtimeEpoch, limit: 500 });
    const boundary = completeNetworkWindow(before);
    if (typeof boundary.watermarkCursor !== 'string' || boundary.watermarkCursor.length === 0) {
      throw Error('Original pre-input network watermark is unavailable');
    }
    const inputStartedAtMs = Date.now();
    await input('search_src_text', query);
    const actionId = lastActionId;
    const read = await wait('network', { factCursor: boundary.watermarkCursor,
      runtimeEpoch: boundary.runtimeEpoch, sinceMs: captureSinceMs, limit: 500 }, r => {
      completeNetworkWindow(r);
      return searchResponses(r, query, inputStartedAtMs).length > 0;
    }, `this input's successful search request for ${query}`, 20000);
    const responses = searchResponses(read, query, inputStartedAtMs);
    await check(`This input records a successful search request for ${query}`, responses.length > 0, read, ['network']);
    searchRequests.push({ query, actionId, inputStartedAtMs, runtimeEpoch: boundary.runtimeEpoch,
      targetKey: boundary.targetKey, lowerCursor: boundary.watermarkCursor,
      responses: responses.map(request => ({ id: request.id, timestampMs: request.timestampMs,
        statusCode: request.statusCode, url: request.url })) });
  }
  const back = () => mutate('keyevent', { keyCode: 4 });
  const home = () => native((nodes, r) => r.result.activity === MAIN && nativeId(nodes, 'nav_tab_search')?.enabled === true
    && nativeId(nodes, 'nav_tab_more')?.enabled === true && !nativeId(nodes, 'search_src_text'), 'Main navigation');
  const article = () => native((nodes, r) => r.result.activity === PAGE
    && nativeId(nodes, 'page_contents')?.enabled === true && nativeId(nodes, 'page_save')?.enabled === true, 'loaded article toolbar');
  async function oracle(stage) {
    const reply = await ctx.askAgent({ question: `Read and verify original Wikipedia business files for ${stage}.`,
      options: [{ id: 'recorded', label: 'Independent evidence verified' }], context: {
        kind: 'wikipedia.business-oracle/v1', stage, serial, packageName: PACKAGE,
        listName, cancelledListName, listDescription, lastActionId,
      } });
    if (reply?.kind !== 'wikipedia.business-oracle-result/v1' || reply.stage !== stage || reply.verdict !== 'passed'
      || typeof reply.artifact?.path !== 'string' || !/^[a-f0-9]{64}$/.test(reply.artifact.sha256)
      || !Array.isArray(reply.verifiedPredicates) || reply.verifiedPredicates.length === 0
      || !reply.verifiedPredicates.every(p => typeof p === 'string' && p.length > 0)) {
      throw Error(`Independent Wikipedia verification did not pass: ${stage}`);
    }
    externalOracles.push(reply);
    // Freeze/resume invalidates old observations; every next action reobserves.
  }
  async function captureReady() {
    return wait('status', { full: true }, r => {
      const p = r.result.capturePersistence;
      if (!p || ['failed', 'disabled'].includes(p.attachmentState)) throw Error('Wikipedia persistent capture is unavailable');
      return p.attachmentState === 'attached' && p.persistent === true && p.lifecycleState === 'OPEN';
    }, 'persistent SDK capture');
  }
  async function capture(stage) {
    const ready = await captureReady();
    if (ready.result.debugBridge.runtimeEpoch !== runtimeEpoch) throw Error('Wikipedia SDK process changed during the fixed scenario');
    const counts = {};
    for (const command of ['state', 'events', 'logs', 'network']) {
      let factCursor;
      for (let page = 0; ; page++) {
        if (page === 30) throw Error(`Bounded capture pagination exceeded: ${command}`);
        const read = await call(command, { sinceMs: captureSinceMs, limit: 100, ...(factCursor ? { factCursor } : {}) });
        const coverage = read.evidence.coverage, captured = read.evidence.capture;
        if (!coverage.committed || coverage.gap || captured.runtimeEpoch !== runtimeEpoch || captured.targetKey !== PACKAGE) {
          throw Error(`Incomplete current Wikipedia ${command} evidence`);
        }
        if (!captured.hasMore) {
          if (coverage.status !== 'complete') throw Error('Final capture page is not complete');
          counts[command] = page + 1; break;
        }
        if (!captured.nextCursor || captured.nextCursor === factCursor) throw Error('Capture cursor did not advance');
        factCursor = captured.nextCursor;
      }
    }
    const file = path.join(outputDir, `${stage}.png`);
    await call('screenshot', { outFile: file });
    artifacts.push({ path: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
    captures.push({ stage, pages: counts });
    await ctx.checkpoint(stage, { stage, atMs: Date.now() });
  }
  async function openSearch() {
    await home();
    // Reselecting Search opens its editor directly. Start from the observed Home
    // tab so this fixed flow always selects Search before opening its card.
    await tapNative({ resourceName: id('nav_tab_home') });
    await native((nodes, r) => r.result.activity === MAIN && nativeId(nodes, 'nav_tab_home')?.selected === true
      && nativeId(nodes, 'nav_tab_search')?.selected === false, 'selected Home tab');
    await tapNative({ resourceName: id('nav_tab_search') });
    await tapNative({ resourceName: id('search_text_view') });
    return native(nodes => nativeId(nodes, 'search_src_text')?.editable === true
      && nativeId(nodes, 'search_src_text')?.enabled === true, 'settled visible search editor');
  }
  async function moonDocument() {
    return wait('h5-dom', {}, r => r.result.pageRef.packageName === PACKAGE && r.result.pageRef.activity === PAGE
      && r.result.pageRef.url === ARTICLE_URL && r.result.dom.url === ARTICLE_URL && r.result.dom.readyState === 'complete'
      && r.result.dom.bodyText.includes('地球唯一的天然卫星'), 'original Moon H5 document', 20000);
  }
  async function openMoon() {
    await inputSearch(MOON);
    const read = await uia(nodes => uiaId(nodes, 'search_src_text')?.text === MOON
      && nodes.filter(n => n.className === 'android.widget.TextView' && n.resourceId === null && n.text === MOON).length === 2,
    'two observed Moon title/description nodes');
    const candidates = uiaNodes(read).filter(n => n.className === 'android.widget.TextView'
      && n.resourceId === null && n.text === MOON).sort((a, b) => a.bounds.top - b.bounds.top);
    if (candidates.length !== 2 || candidates[0].bounds.left !== candidates[1].bounds.left
      || candidates[0].bounds.bottom >= candidates[1].bounds.top || !candidates[0].targetRef
      || candidates.some(n => n.enabled !== true)) throw Error('Frozen title-above-description search structure changed');
    await check('Moon search distinguishes the input, title and same-name description',
      uiaId(uiaNodes(read), 'search_src_text').text === MOON && candidates.length === 2, read);
    await mutate('tap-uia', { targetRef: candidates[0].targetRef });
    await article();
    const document = await moonDocument();
    await check('Search opens the actual Chinese Moon article and its original body',
      document.result.dom.bodyText.includes('地球唯一的天然卫星'), document);
    return document;
  }
  async function returnToMain() {
    await article(); await back();
    const read = await native(nodes => nativeId(nodes, 'search_src_text')?.text === MOON, 'article returns to Moon search');
    await check('Back restores the original search query', nativeId(nativeNodes(read), 'search_src_text').text === MOON, read);
    await tapNative({ contentDescription: '转到上一层级' }); return home();
  }
  const languageOrder = read => nativeNodes(read).filter(n => n.resourceName === id('wiki_language_title') && [CN, TW].includes(n.text))
    .sort((a, b) => a.bounds.top - b.bounds.top).map(n => n.text);
  const exactOrder = (read, expected) => {
    const titles = nativeNodes(read).filter(n => n.resourceName === id('wiki_language_title'));
    return titles.length === 3 && titles.some(n => n.text === '添加语言')
      && JSON.stringify(languageOrder(read)) === JSON.stringify(expected);
  };
  async function reorderLanguage(first, second) {
    const read = await native((_, r) => r.result.activity === LANGUAGES && exactOrder(r, [first, second]), 'settled language rows');
    const titles = nativeNodes(read).filter(n => n.resourceName === id('wiki_language_title') && [CN, TW].includes(n.text))
      .sort((a, b) => a.bounds.top - b.bounds.top);
    await mutate('native-gesture', { payload: { action: 'swipe', selector: {
      resourceName: id('wiki_language_drag_handle'), within: { text: first,
        ancestor: { className: 'org.wikipedia.settings.languages.WikipediaLanguagesItemView' } } },
      deltaX: 0, deltaY: titles[1].bounds.bottom - (titles[0].bounds.top + titles[0].bounds.bottom) / 2, durationMs: 900 } });
    return native((_, r) => r.result.activity === LANGUAGES && exactOrder(r, [second, first]), 'changed language order');
  }
  async function openSettings() {
    await home(); await tapNative({ resourceName: id('nav_tab_more') }); await tapNative({ text: '设置' });
    return native((nodes, r) => r.result.activity === SETTINGS && hasText(nodes, '维基百科语言'), 'Wikipedia Settings');
  }
  async function languageSettings() {
    await tapNative({ text: '维基百科语言' });
    let read = await native((_, r) => r.result.activity === LANGUAGES && exactOrder(r, [CN, TW]), 'frozen Wikipedia language priority');
    await check('Wikipedia language priority initially matches Chinese mainland then Taiwan', exactOrder(read, [CN, TW]), read);
    read = await reorderLanguage(CN, TW);
    await check('Dragging the original language row changes Wikipedia language priority', exactOrder(read, [TW, CN]), read);
    await oracle('language-changed'); await capture('language-changed');
    read = await reorderLanguage(TW, CN);
    await check('Dragging back restores the original Wikipedia language priority', exactOrder(read, [CN, TW]), read);
    await oracle('language-restored');
    await tapNative({ contentDescription: '转到上一层级' });
    await native((nodes, r) => r.result.activity === SETTINGS && hasText(nodes, '维基百科语言'), 'returned Settings');
    await back(); await home();
  }

  // Upstream MainFragment uses this explicit extra to return to Main instead of
  // automatically continuing an article viewed in the preceding minute.
  await call('launch-app', { activity: 'org.wikipedia.DefaultIcon', clearTask: true,
    extra: ['returnToMain=true'] });
  await home(); await oracle('baseline');
  const ready = await captureReady(); captureSinceMs = ready.result.updatedAtMs; runtimeEpoch = ready.result.debugBridge.runtimeEpoch;
  if (!Number.isSafeInteger(captureSinceMs) || typeof runtimeEpoch !== 'string') throw Error('SDK capture boundary missing');
  await ctx.progress({ stage: 'core', message: 'Real search, article body, section navigation, return and Settings' });
  await openSearch(); const firstArticle = await openMoon();
  // Wikipedia restores the previous reading position. Its original lead-section
  // handler sets WebView.scrollY to zero; establish that state before measuring
  // the subsequent named-section navigation.
  await tapNative({ resourceName: id('page_contents') });
  await tapContentsEntry(MOON);
  const articleStart = await wait('h5-dom', {}, r => r.result.pageRef.documentId === firstArticle.result.pageRef.documentId
    && r.result.dom.viewport.scrollY === 0, 'original contents lead entry returns to article start');
  await check('The original contents lead entry restores the same article to its start',
    articleStart.result.pageRef.documentId === firstArticle.result.pageRef.documentId
      && articleStart.result.dom.viewport.scrollY === 0, articleStart);
  await native(nodes => nativeId(nodes, 'page_contents')?.enabled === true
    && !nativeId(nodes, 'page_toc_item_text'), 'contents drawer closed after lead navigation');
  await tapNative({ resourceName: id('page_contents') });
  let read = await native(nodes => nodes.some(n => n.resourceName === id('page_toc_item_text') && n.text === '名称和语源'), 'named contents section');
  await check('The article exposes its named section in the Native contents panel', hasText(nativeNodes(read), '名称和语源'), read);
  await tapContentsEntry('名称和语源');
  read = await wait('h5-dom', {}, r => r.result.pageRef.documentId === articleStart.result.pageRef.documentId
    && r.result.dom.viewport.scrollY > articleStart.result.dom.viewport.scrollY
    && r.result.dom.bodyText.includes('名称和语源'), 'selected section in the same original document');
  await check('Native contents navigation scrolls the same original H5 document',
    read.result.pageRef.documentId === articleStart.result.pageRef.documentId
      && read.result.dom.viewport.scrollY > articleStart.result.dom.viewport.scrollY, read);
  await capture('core-section'); await returnToMain();
  read = await openSettings();
  await check('Core navigation reaches the actual Wikipedia Settings activity', read.result.activity === SETTINGS, read);
  const coreElapsedMs = Date.now() - startedAtMs;
  await ctx.progress({ stage: 'acceptance', coreElapsedMs, message: 'Language priority, no results, collection cancel/create/delete, theme restore and repeat navigation' });
  await languageSettings();
  await openSearch(); await inputSearch(EMPTY_QUERY);
  read = await uia(nodes => uiaId(nodes, 'search_src_text')?.text === EMPTY_QUERY
    && nodes.filter(n => n.text === '没有结果').length === 2, 'both configured languages show no results');
  await check('The unknown query has explicit no results in both language sections',
    uiaId(uiaNodes(read), 'search_src_text').text === EMPTY_QUERY && uiaNodes(read).filter(n => n.text === '没有结果').length === 2, read);
  await capture('no-results'); await openMoon();
  await tapNative({ resourceName: id('page_save') });
  await native(nodes => nativeId(nodes, 'touch_outside')?.enabled === true, 'original save bottom sheet');
  await tapUia(n => n.text === '新建收藏', 'save sheet new reading list');
  await input('text_input', cancelledListName); await tapNative({ resourceName: 'android:id/button2' });
  read = await uia(nodes => hasText(nodes, '新建收藏') && !hasText(nodes, cancelledListName), 'cancel returns to original save sheet');
  await check('Cancel closes the synthetic collection editor', hasText(uiaNodes(read), '新建收藏'), read);
  await oracle('list-cancelled');
  await tapUia(n => n.text === '新建收藏', 'fresh new-list control after independent snapshot');
  await input('text_input', listName); await input('secondary_text_input', listDescription);
  await tapNative({ resourceName: 'android:id/button1' });
  read = await native(nodes => hasText(nodes, `已添加月球至${listName}。`), 'named collection creation confirmation');
  await check('The original App confirms adding Moon to this run\'s exact collection', hasText(nativeNodes(read), `已添加月球至${listName}。`), read);
  await returnToMain();
  await tapNative({ resourceName: id('nav_tab_reading_lists') });
  await tapUia(n => n.text === '收藏', 'saved collection tab'); await tapUia(n => n.text === listName, 'this run\'s collection row');
  read = await native((nodes, r) => r.result.activity === LIST && nativeId(nodes, 'item_title')?.text === listName
    && nativeId(nodes, 'page_list_item_title')?.text === MOON, 'reopened exact collection and Moon article');
  await check('Reopening shows the exact collection title, description and Moon article',
    nativeId(nativeNodes(read), 'item_title').text === listName && nativeId(nativeNodes(read), 'item_description')?.text === listDescription
      && nativeId(nativeNodes(read), 'page_list_item_title').text === MOON, read);
  // Upstream numPagesOffline counts only offline && STATUS_SAVED, while queued
  // downloads retain the secondary action/progress controls. Wait for that real
  // business UI before the controller independently checks the SQLite status.
  read = await wait('tree', { compact: false }, r => {
    const nodes = nativeNodes(r);
    return r.result.activity === LIST && nativeId(nodes, 'item_title')?.text === listName
      && nativeId(nodes, 'page_list_item_title')?.text === MOON
      && nativeId(nodes, 'item_reading_list_statistical_description')?.text?.startsWith('1篇（共1篇）条目可离线阅读')
      && !nativeId(nodes, 'page_list_item_action') && !nativeId(nodes, 'page_list_item_action_container')
      && !nativeId(nodes, 'page_list_item_circular_progress_bar');
  }, 'one saved offline article with no pending download controls', 60000);
  await check('The exact collection shows one ready offline article without pending download controls',
    nativeId(nativeNodes(read), 'item_reading_list_statistical_description').text.startsWith('1篇（共1篇）条目可离线阅读')
      && !nativeId(nativeNodes(read), 'page_list_item_action') && !nativeId(nativeNodes(read), 'page_list_item_circular_progress_bar'), read);
  await oracle('list-created');
  await capture('saved-collection');
  await tapUia(n => n.resourceId === id('item_overflow_menu'), 'original collection overflow menu'); await tapNative({ text: '删除收藏' });
  read = await native(nodes => hasText(nodes, `您确定要删除“${listName}”吗？`), 'exact synthetic collection deletion confirmation');
  await check('Deletion is restricted to the exact synthetic collection', hasText(nativeNodes(read), `您确定要删除“${listName}”吗？`), read);
  await tapNative({ resourceName: 'android:id/button1' }); await home();
  await openSearch(); await openMoon(); await tapNative({ resourceName: id('page_theme') });
  await native(nodes => nativeId(nodes, 'theme_chooser_match_system_theme_switch')?.enabled === true, 'visible theme controls');
  read = await uia(nodes => uiaId(nodes, 'theme_chooser_match_system_theme_switch')?.checked === true
    && uiaId(nodes, 'button_theme_light')?.enabled === false, 'original system-matching theme');
  await check('System matching disables explicit light theme at baseline',
    uiaId(uiaNodes(read), 'theme_chooser_match_system_theme_switch').checked === true && uiaId(uiaNodes(read), 'button_theme_light').enabled === false, read);
  await tapUia(n => n.resourceId === id('theme_chooser_match_system_theme_switch'), 'disable system-theme matching');
  await tapUia(n => n.resourceId === id('button_theme_light'), 'enabled explicit light theme');
  await native(nodes => nativeId(nodes, 'theme_chooser_match_system_theme_switch')?.enabled === true
    && nativeId(nodes, 'button_theme_light')?.enabled === true, 'visible theme controls after recreation');
  read = await uia(nodes => uiaId(nodes, 'theme_chooser_match_system_theme_switch')?.checked === false
    && uiaId(nodes, 'theme_chooser_dark_mode_dim_images_switch')?.enabled === false
    && uiaId(nodes, 'button_theme_light')?.enabled === true, 'settled light-theme sheet after Activity recreation');
  await check('Light theme settles with system matching off and dark-image dimming disabled',
    uiaId(uiaNodes(read), 'theme_chooser_match_system_theme_switch').checked === false
      && uiaId(uiaNodes(read), 'theme_chooser_dark_mode_dim_images_switch').enabled === false, read);
  await oracle('theme-light'); await capture('light-theme');
  await tapUia(n => n.resourceId === id('theme_chooser_match_system_theme_switch'), 'restore system-theme matching');
  read = await uia(nodes => uiaId(nodes, 'theme_chooser_match_system_theme_switch')?.checked === true
    && uiaId(nodes, 'button_theme_light')?.enabled === false, 'settled original system theme');
  await check('The system-matching theme controls are restored',
    uiaId(uiaNodes(read), 'theme_chooser_match_system_theme_switch').checked === true && uiaId(uiaNodes(read), 'button_theme_light').enabled === false, read);
  await oracle('theme-restored'); await back(); await article(); await moonDocument(); await returnToMain();
  await openSearch(); await openMoon(); await capture('repeat-article'); read = await returnToMain();
  await check('Repeated article and back navigation ends on Wikipedia Main', read.result.activity === MAIN, read);
  await oracle('final-restored'); await home(); await capture('finished');
  return { gate: 'passed', scope: 'Wikipedia fixed Android P9 business acceptance, including Wikipedia language priority change and restoration',
    startedAtMs, coreElapsedMs, acceptanceElapsedMs: Date.now() - startedAtMs,
    assertions, actions, artifacts, externalOracles, captures, reobservations,
    searchRequests,
    initialization: 'Intent completed onboarding and coachmarks; existing default Moon bookmark preserved; only named synthetic collections mutated' };
};
