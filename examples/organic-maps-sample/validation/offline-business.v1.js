'use strict';

// Authored from organic-maps-complete-20260912-03 and independent KML/settings reads.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const PACKAGE = 'app.organicmaps.bridge_sample.web.debug';
const PALACE = '摩納哥親王宮', MUSEUM = '摩納哥海洋博物館';
const EMPTY = '很抱歉，没有搜到任何地点。';
const id = name => PACKAGE + ':id/' + name;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports.main = async ctx => {
  const startedAtMs = Date.now(), assertions = [], actions = [], independent = [];
  async function call(command, args = {}) {
    const result = await ctx.call(command, args);
    if (!result.ok) throw Error(JSON.stringify(result));
    return result;
  }
  function nodes(observation) {
    const window = [...observation.result.windows].reverse().find(w => w.root.visible && w.root.alpha > 0);
    if (!window) throw Error('No visible Native window');
    const list = [];
    const contains = (b, x, y) => b && x >= b.left && x < b.right && y >= b.top && y < b.bottom;
    function visit(node, ancestors = []) {
      if (!node.visible || node.effectiveVisible === false || node.alpha <= 0) return;
      const b = node.bounds, x = (b.left + b.right) / 2, y = (b.top + b.bottom) / 2;
      if (b.right > b.left && b.bottom > b.top && contains(window.bounds, x, y)
        && ancestors.every(a => contains(a.bounds, x, y))) list.push(node);
      for (const child of node.children || []) visit(child, [...ancestors, node]);
    }
    visit(window.root); return list;
  }
  const hasText = (list, text) => list.some(n => n.text === text);
  const hasId = (list, name) => list.some(n => n.resourceName === id(name));
  const checked = (list, text) => list.some(n => n.text === text && n.checked === true);
  async function waitFor(predicate, description, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    do {
      last = await ctx.call('tree', { compact: false });
      if (last.ok && predicate(nodes(last), last)) return last;
      await sleep(200);
    } while (Date.now() < deadline);
    throw Error(JSON.stringify({ error: 'organic_maps_state_timeout', description, lastError: last.error }));
  }
  async function check(name, condition, observation) {
    const result = await ctx.assert({ name, condition, requiredEvidence: ['tree'], evidence: observation.evidence });
    assertions.push(result);
    if (result.verdict !== 'passed') throw Error(JSON.stringify(result));
  }
  async function mutate(command, args) {
    const result = await call(command, args), receipt = result.executionReceipt;
    const kind = command === 'keyevent' ? 'android-shell' : 'native';
    if (!receipt?.settled || receipt.kind !== kind || receipt.actionId !== result.execution.actionId)
      throw Error('Original matching mutation receipt missing: ' + command);
    actions.push({ command, actionId: receipt.actionId, kind }); return result;
  }
  const tap = selector => mutate('tap-native', { selector });
  async function oracle(stage, predicate) {
    const deadline = Date.now() + 6000;
    do {
      const { stdout } = await execute(ctx.inputs.python, [ctx.inputs.oraclePath, ctx.inputs.serial], { timeout: 20000 });
      const result = JSON.parse(stdout);
      if (result.packageName !== PACKAGE || result.serial !== ctx.inputs.serial) throw Error('Oracle target mismatch');
      independent.push({ stage, ...result }); await ctx.checkpoint(stage, result);
      if (predicate(result)) return result;
      await sleep(200);
    } while (Date.now() < deadline);
    throw Error('Independent Organic Maps state did not settle: ' + stage);
  }
  const savedPalace = o => o.placemarks.length === 1
    && o.placemarks[0].name === 'Palais princier de Monaco'
    && o.placemarks[0].coordinates === '7.420057,43.731165,0';
  async function captureReady() {
    const deadline = Date.now() + 15000;
    let last;
    do {
      last = await ctx.call('status', { full: true });
      if (last.ok) {
        const state = last.result.capturePersistence;
        if (!state) throw Error('SDK capturePersistence contract missing');
        if (state.attachmentState === 'attached' && state.persistent && state.lifecycleState === 'OPEN') return last;
        if (['failed', 'disabled'].includes(state.attachmentState)) throw Error(JSON.stringify(state));
      }
      await sleep(200);
    } while (Date.now() < deadline);
    throw Error(JSON.stringify({ error: 'organic_maps_capture_ready_timeout', last }));
  }
  let captureSinceMs, runtimeEpoch;
  async function capture(stage) {
    const ready = await captureReady();
    if (ready.result.debugBridge.runtimeEpoch !== runtimeEpoch) throw Error('Unexpected App restart during the frozen scenario');
    for (const command of ['state', 'events', 'logs']) {
      let factCursor;
      for (let page = 0; ; page++) {
        if (page === 20) throw Error('Capture pagination exceeded the bounded map scenario');
        const result = await call(command, { sinceMs: captureSinceMs, limit: 100, ...(factCursor ? { factCursor } : {}) });
        const coverage = result.evidence.coverage, capture = result.evidence.capture;
        if (!coverage.committed || coverage.gap || capture.runtimeEpoch !== runtimeEpoch || capture.targetKey !== PACKAGE)
          throw Error(JSON.stringify({ error: 'organic_maps_capture_incomplete', stage, command, evidence: result.evidence }));
        if (!capture.hasMore) {
          if (coverage.status !== 'complete') throw Error('Final capture page is not complete');
          break;
        }
        if (!capture.nextCursor || capture.nextCursor === factCursor) throw Error('Capture pagination did not advance');
        factCursor = capture.nextCursor;
      }
    }
    await call('screenshot'); await ctx.checkpoint(stage, { stage, atMs: Date.now() });
  }
  const home = () => waitFor(list => hasId(list, 'btn_search') && hasId(list, 'btn_bookmarks')
    && !hasId(list, 'tv__title') && !hasId(list, 'pedestrian') && !hasId(list, 'query'), 'map home');
  const detail = (title, button) => waitFor(list => list.some(n => n.resourceName === id('tv__title') && n.text === title)
    && hasText(list, button), 'place detail: ' + title);
  async function search(text, button = 'btn_search') {
    await tap({ resourceName: id(button) });
    await waitFor(list => list.some(n => n.resourceName === id('query') && n.editable === true), 'visible search editor');
    await mutate('input-text', { selector: { resourceName: id('query') }, text });
  }
  async function openSavedPalace() {
    await tap({ resourceName: id('btn_bookmarks') });
    await waitFor(list => hasText(list, '我的地点') && hasText(list, '1 个书签'), 'one saved bookmark');
    await tap({ text: '我的地点' });
    const list = await waitFor(list => list.some(n => n.resourceName === id('tv__bookmark_name') && n.text === PALACE), 'saved palace list');
    await check('The bookmark list contains the saved palace', hasText(nodes(list), PALACE), list);
    await tap({ resourceName: id('tv__bookmark_name') });
    return detail(PALACE, '删除');
  }
  const settings = () => waitFor(list => hasText(list, '测量单位') && hasText(list, '自动下载'), 'settings');
  async function units() {
    await tap({ text: '测量单位' });
    return waitFor(list => hasText(list, '公里') && hasText(list, '英里'), 'units picker');
  }

  await ctx.progress({ stage: 'core', message: 'Offline POI search, saved bookmark and walking-route cancellation' });
  const baseline = await oracle('baseline', () => true);
  if (baseline.placemarks.length !== 0 || baseline.settings.Units !== 'Metric'
    || baseline.settings.AutoDownloadEnabled !== 'false') throw Error('Frozen empty-bookmark and metric baseline required');
  const ready = await captureReady();
  captureSinceMs = ready.result.updatedAtMs; runtimeEpoch = ready.result.debugBridge.runtimeEpoch;
  if (!Number.isSafeInteger(captureSinceMs) || !runtimeEpoch) throw Error('SDK capture boundary missing');
  await home();
  await search('Palais Princier');
  await waitFor(list => hasText(list, 'Palais princier de Monaco'), 'palace search result');
  await tap({ text: 'Palais princier de Monaco' });
  let observation = await detail(PALACE, '保存');
  await check('Offline search opens the named palace detail', hasText(nodes(observation), 'Palais princier de Monaco'), observation);
  await tap({ text: '保存' }); observation = await detail(PALACE, '删除');
  let disk = await oracle('palace-saved', savedPalace);
  await check('Saving the palace writes its exact name and coordinates to KML', savedPalace(disk), observation);
  await capture('palace-saved-evidence');
  await tap({ text: '从这出发' });
  observation = await waitFor(list => hasId(list, 'routing_btn_search') && hasText(list, PALACE), 'route origin');
  if (!nodes(observation).some(n => n.resourceName === id('pedestrian') && n.checked === true)) {
    await tap({ resourceName: id('pedestrian') });
    await waitFor(list => list.some(n => n.resourceName === id('pedestrian') && n.checked === true), 'walking router');
  }
  await search('Musée océanographique', 'routing_btn_search');
  await waitFor(list => hasText(list, 'Musée Océanographique') && hasText(list, '博物馆 • ¥'), 'museum result excluding the same-name bus stop');
  await tap({ text: 'Musée Océanographique', within: { text: '博物馆 • ¥',
    ancestor: { className: 'android.widget.RelativeLayout', parent: { resourceName: id('recycler') } } } });
  await detail(MUSEUM, '到这去'); await tap({ text: '到这去' });
  observation = await waitFor(list => hasText(list, PALACE) && hasText(list, MUSEUM)
    && list.some(n => n.resourceName === id('time') && n.text), 'computed route preview', 20000);
  await check('The fixed walking route joins both POIs with the expected distance and duration',
    hasText(nodes(observation), ctx.inputs.expectedRouteText)
      && nodes(observation).some(n => n.resourceName === id('pedestrian') && n.checked === true), observation);
  await capture('route-preview'); await tap({ resourceName: id('back') }); observation = await home();
  disk = await oracle('route-cancelled', savedPalace);
  await check('Cancelling the route returns home and preserves the bookmark', savedPalace(disk)
    && !hasId(nodes(observation), 'pedestrian'), observation);
  const coreElapsedMs = Date.now() - startedAtMs;

  await ctx.progress({ stage: 'acceptance', coreElapsedMs, message: 'No results, bookmark deletion/restoration, settings and cleanup' });
  await search('BridgeNoSuchPOI20260912XYZ');
  observation = await waitFor(list => hasText(list, EMPTY), 'explicit empty search result');
  await check('An unknown POI shows the explicit no-results state', hasText(nodes(observation), EMPTY), observation);
  await capture('no-result'); await tap({ resourceName: id('close_search') }); await home();
  await openSavedPalace();
  await tap({ text: '删除' }); observation = await detail(PALACE, '恢复');
  disk = await oracle('palace-deleted', o => o.placemarks.length === 0);
  await check('Deleting the bookmark removes the actual KML placemark', disk.placemarks.length === 0, observation);
  await tap({ text: '恢复' }); observation = await detail(PALACE, '删除');
  disk = await oracle('palace-restored', savedPalace);
  await check('Restoring the bookmark restores its business identity and coordinates', savedPalace(disk), observation);
  await capture('bookmark-restored'); await tap({ resourceName: id('close_button') }); await home();
  await tap({ resourceName: id('menu_button') }); await waitFor(list => hasText(list, '设置'), 'map menu');
  await tap({ text: '设置' }); await settings();
  observation = await units(); await check('The initial units control is metric', checked(nodes(observation), '公里'), observation);
  await tap({ text: '英里' }); await settings(); disk = await oracle('units-miles', o => o.settings.Units === 'Foot');
  observation = await units();
  await check('Miles selection agrees with the real settings file', checked(nodes(observation), '英里') && disk.settings.Units === 'Foot', observation);
  await capture('miles-selected'); await tap({ text: '公里' }); await settings();
  disk = await oracle('units-restored', o => o.settings.Units === 'Metric'); observation = await units();
  await check('Metric selection and stored units are restored', checked(nodes(observation), '公里')
    && disk.settings.Units === baseline.settings.Units && disk.settings.AutoDownloadEnabled === 'false', observation);
  await capture('metric-restored'); await tap({ text: '取消' }); await settings();
  await mutate('keyevent', { keyCode: 4 }); await home();
  await openSavedPalace(); await tap({ text: '删除' }); await detail(PALACE, '恢复');
  disk = await oracle('final-empty-bookmarks', o => o.placemarks.length === 0);
  await tap({ resourceName: id('close_button') }); observation = await home();
  await check('Cleanup restores empty bookmarks, metric units and the map home page', disk.placemarks.length === 0
    && disk.settings.Units === baseline.settings.Units && disk.settings.AutoDownloadEnabled === baseline.settings.AutoDownloadEnabled, observation);
  await capture('finished');
  return { gate: 'passed', scope: 'Organic Maps fixed offline P9 core and acceptance', coreElapsedMs,
    acceptanceElapsedMs: Date.now() - startedAtMs, assertions, actions, independent,
    initialization: 'Installation, onboarding and validated offline map download completed through Intent before repeatable runs' };
};
