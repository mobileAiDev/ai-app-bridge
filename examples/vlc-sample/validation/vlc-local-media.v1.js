'use strict';

// Authored from vlc-playback-intent-20260912-02 and its independent device reads.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const PACKAGE = 'org.videolan.vlc.bridge_sample.debug';
const VIDEO = 'Bridge Video Fixture';
const VIDEO_URI = 'file:///storage/emulated/0/Movies/BridgeVLCFixture/Bridge%20Video%20Fixture.mp4';
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
  const hasLabel = (list, label) => list.some(n => n.contentDescription === label);
  const hasId = (list, name) => list.some(n => n.resourceName === id(name));
  async function waitFor(predicate, description, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    do {
      // Read-only polling also covers the known socket closure during App restart.
      // Mutations are never retried or replayed here.
      last = await ctx.call('tree', { compact: false });
      if (last.ok && predicate(nodes(last), last)) return last;
      await sleep(200);
    } while (Date.now() < deadline);
    throw Error(JSON.stringify({ error: 'vlc_state_timeout', description, lastError: last.error }));
  }
  async function check(name, condition, observation) {
    const result = await ctx.assert({ name, condition, requiredEvidence: ['tree'], evidence: observation.evidence });
    assertions.push(result);
    if (result.verdict !== 'passed') throw Error(JSON.stringify(result));
  }
  async function mutate(command, args) {
    const result = await call(command, args), receipt = result.executionReceipt;
    const expectedKind = command === 'keyevent' ? 'android-shell' : 'native';
    if (!receipt?.settled || receipt.kind !== expectedKind || receipt.actionId !== result.execution.actionId)
      throw Error('Original matching mutation receipt missing: ' + command);
    actions.push({ command, actionId: receipt.actionId, kind: receipt.kind });
    return result;
  }
  const tap = selector => mutate('tap-native', { selector });
  const back = () => mutate('keyevent', { keyCode: 4 });
  async function oracle(stage, predicate = () => true) {
    const deadline = Date.now() + 6000;
    let result;
    do {
      const { stdout } = await execute(ctx.inputs.python, [ctx.inputs.oraclePath, ctx.inputs.serial], { timeout: 25000 });
      result = JSON.parse(stdout);
      if (result.packageName !== PACKAGE || result.serial !== ctx.inputs.serial) throw Error('Independent oracle target mismatch');
      independent.push({ stage, ...result });
      await ctx.checkpoint(stage, result);
      if (predicate(result)) return result;
      await sleep(200);
    } while (Date.now() < deadline);
    throw Error('Independent VLC state did not settle: ' + stage);
  }
  const media = (o, state) => o.mediaSession?.title === VIDEO && o.mediaSession.state === state;
  const preference = (o, key) => o.preferences.values[key]?.value;
  let captureSinceMs;
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
    throw Error(JSON.stringify({ error: 'vlc_capture_ready_timeout', last }));
  }
  async function capture(stage) {
    const ready = await captureReady(), epoch = ready.result.debugBridge.runtimeEpoch;
    for (const command of ['state', 'events', 'logs']) {
      let factCursor;
      for (let page = 0; ; page++) {
        if (page === 20) throw Error('Capture pagination exceeded the bounded VLC scenario');
        const result = await call(command, { sinceMs: captureSinceMs, limit: 500, ...(factCursor ? { factCursor } : {}) });
        const coverage = result.evidence.coverage, capture = result.evidence.capture;
        if (!coverage.committed || coverage.gap || capture.runtimeEpoch !== epoch || capture.targetKey !== PACKAGE)
          throw Error(JSON.stringify({ error: 'vlc_capture_incomplete', stage, command, evidence: result.evidence }));
        if (!capture.hasMore) {
          if (coverage.status !== 'complete') throw Error('Final capture page is not complete');
          break;
        }
        if (!capture.nextCursor || capture.nextCursor === factCursor) throw Error('Capture pagination did not advance');
        factCursor = capture.nextCursor;
      }
    }
    await call('screenshot');
    await ctx.checkpoint(stage, { stage, atMs: Date.now() });
  }
  const videoList = () => waitFor(list => hasId(list, 'nav_video') && hasText(list, VIDEO)
    && !hasText(list, '正在加载'), 'video library');
  async function pausePlayer(stage) {
    let observation = await call('tree', { compact: false });
    if (!hasLabel(nodes(observation), '暂停')) {
      await tap({ resourceName: id('player_root') });
      observation = await waitFor(list => hasLabel(list, '暂停'), 'visible pause control');
    }
    await tap({ contentDescription: '暂停' });
    const paused = await waitFor(list => hasLabel(list, '播放') && hasId(list, 'player_overlay_seekbar'), 'paused video controls');
    const independent = await oracle(stage, o => media(o, 'PAUSED'));
    return { observation: paused, independent };
  }
  async function openVideo(stage, savedPosition = null) {
    await tap({ text: VIDEO });
    const observation = await waitFor(list => hasId(list, 'player_root'), 'video player');
    const result = await oracle(stage, o => media(o, 'PLAYING') && (savedPosition === null
      || Math.abs(o.mediaSession.positionMs - savedPosition) <= 1500));
    return { observation, independent: result };
  }

  const baseline = await oracle('baseline');
  if (preference(baseline, 'app_onboarding_done') !== true || preference(baseline, 'app_theme') !== '-1')
    throw Error('Frozen onboarding and system-theme baseline required');
  // The SDK supplies the device clock. This window excludes previous runs' historical gaps,
  // while retaining any real startup loss caused by either restart inside this Script.
  captureSinceMs = (await captureReady()).result.updatedAtMs;
  if (!Number.isSafeInteger(captureSinceMs)) throw Error('SDK capture time boundary missing');
  await waitFor(list => hasId(list, 'nav_video'), 'main navigation');
  await tap({ resourceName: id('nav_video') });
  await videoList();
  await tap({ contentDescription: '更多选项' });
  await waitFor(list => hasText(list, '刷新'), 'refresh menu');
  await tap({ text: '刷新' });
  const scanned = await videoList();
  await check('Fixed video appears in the scanned library with its exact duration', hasText(nodes(scanned), '3:00'), scanned);
  await capture('scanned-library');

  const opened = await openVideo('opened-playing');
  await check('The real system player opened the fixed video', media(opened.independent, 'PLAYING'), opened.observation);
  const firstPause = await pausePlayer('first-pause');
  const seekbar = nodes(firstPause.observation).find(n => n.resourceName === id('player_overlay_seekbar'));
  await mutate('native-gesture', { payload: { action: 'swipe', selector: { resourceName: id('player_overlay_seekbar') },
    deltaX: Math.round(-(seekbar.bounds.right - seekbar.bounds.left) / 6), deltaY: 0, durationMs: 450 } });
  const soughtTree = await waitFor(list => hasLabel(list, '播放'), 'paused seek result');
  const sought = await oracle('sought', o => media(o, 'PAUSED') && o.mediaSession.positionMs >= 50000 && o.mediaSession.positionMs <= 70000);
  await check('A real seek moved playback to the observed one-third region', media(sought, 'PAUSED'), soughtTree);
  await sleep(1200);
  const stable = await oracle('paused-stable');
  await check('Paused playback position remains unchanged', media(stable, 'PAUSED')
    && stable.mediaSession.positionMs === sought.mediaSession.positionMs, soughtTree);
  await capture('paused-seek');
  await tap({ contentDescription: '播放' });
  await oracle('resumed-playing', o => media(o, 'PLAYING'));
  await sleep(2000);
  const progressed = await pausePlayer('progressed-pause');
  await check('Playback advances after resuming', progressed.independent.mediaSession.positionMs > sought.mediaSession.positionMs + 1000,
    progressed.observation);
  await back();
  const returned = await videoList();
  const exited = await oracle('exited', o => preference(o, 'position_in_media') === progressed.independent.mediaSession.positionMs);
  await check('Returning to the library persists the exact media and position', preference(exited, 'current_media') === VIDEO_URI, returned);
  const coreElapsedMs = Date.now() - startedAtMs;

  const saved = preference(exited, 'position_in_media');
  const restored = await openVideo('restored-playing', saved);
  await check('Reopening starts from the position stored on disk', Math.abs(restored.independent.mediaSession.positionMs - saved) <= 1500, restored.observation);
  await pausePlayer('restored-pause'); await capture('restored-video'); await back(); await videoList();
  await openVideo('repeat-playing'); await pausePlayer('repeat-pause'); await back();
  const repeated = await videoList();
  await check('Repeated play and return leaves the library operable', hasText(nodes(repeated), VIDEO), repeated);

  await tap({ contentDescription: '浏览' });
  await waitFor(list => hasText(list, 'Movies'), 'Movies favorite'); await tap({ text: 'Movies' });
  await waitFor(list => hasText(list, 'BridgeVLCEmpty'), 'fixture parent directory'); await tap({ text: 'BridgeVLCEmpty' });
  const empty = await waitFor(list => hasText(list, 'BridgeVLCEmpty') && hasText(list, '未找到媒体文件，请传输一些文件到您的设备，或调整您的偏好设置。')
    && !hasText(list, '正在加载'), 'empty directory');
  const { stdout: entries } = await execute('adb', ['-s', ctx.inputs.serial, 'shell', 'ls', '-A', '/sdcard/Movies/BridgeVLCEmpty'], { timeout: 15000 });
  await ctx.checkpoint('independent-empty-directory', { directory: '/sdcard/Movies/BridgeVLCEmpty', entries });
  await check('The empty-directory UI agrees with the actual filesystem', entries === '' && !hasId(nodes(empty), 'browser_container'), empty);
  await capture('empty-directory');
  await tap({ contentDescription: '文件夹: 浏览器' });
  await waitFor(list => hasLabel(list, '更多'), 'main navigation'); await tap({ contentDescription: '更多' });
  await waitFor(list => hasText(list, '设置'), 'More page');

  async function changeTheme(label, value, stage) {
    await tap({ text: '设置' });
    let observation = await waitFor(list => hasText(list, '媒体库文件夹'), 'settings');
    for (let count = 0; !hasText(nodes(observation), '界面'); count++) {
      if (count === 5) throw Error('Interface preference did not become visible');
      await mutate('native-gesture', { payload: { action: 'scroll', selector: { resourceName: id('recycler_view') }, direction: 'down', durationMs: 450 } });
      observation = await call('tree', { compact: false });
    }
    await tap({ text: '界面' }); await waitFor(list => hasText(list, '自动切换夜间模式'), 'interface preferences');
    await tap({ text: '自动切换夜间模式' }); await waitFor(list => hasText(list, label), 'theme options');
    await tap({ text: label });
    const confirmation = await waitFor(list => hasText(list, '重新启动 VLC'), 'restart confirmation');
    const epoch = confirmation.result.root.targetRef.runtimeEpoch;
    await oracle(stage + '-persisted', o => preference(o, 'app_theme') === value);
    await tap({ text: '确定' });
    const restarted = await waitFor((list, o) => hasText(list, '设置') && o.result.root.targetRef.runtimeEpoch !== epoch, 'restarted VLC', 20000);
    const result = await oracle(stage + '-restarted');
    await check(stage + ': theme persisted and a new App runtime is active', preference(result, 'app_theme') === value, restarted);
    await capture(stage);
  }
  await changeTheme('亮色主题', '1', 'light-theme');
  await changeTheme('跟随系统模式', '-1', 'restored-theme');
  await tap({ resourceName: id('nav_video') }); await videoList();
  return { gate: 'passed', scope: 'VLC P9 local-video core and acceptance: scan, playback, seek, pause, restore, repeat, empty directory and applied/restored theme',
    coreElapsedMs, acceptanceElapsedMs: Date.now() - startedAtMs,
    initialization: 'First-launch and permission Intent completed before this repeatable Script', assertions, actions, independent };
};
