'use strict';

// Executed by the public Bridge Script runtime. UI effects use android-executor.
module.exports.main = async ctx => {
  const { identity, chapter, sdkPort } = ctx.inputs;
  const checks = [], actions = [];
  const captureBoundaries = {}, captureEvidence = [];
  const systemInteractions = [];
  const started = performance.now();
  let sequence = 0;
  const check = (name, passed, actual) => checks.push({ name, passed: Boolean(passed), actual });
  async function call(command, args) {
    const reply = await ctx.call(command, args);
    if (!reply.ok || reply.result.ok === false) throw new Error(JSON.stringify(reply));
    return reply.result;
  }
  const executor = args => call('android-executor', { ...identity, ...args });
  const observe = async (engine = 'espresso', options = {}) => (await executor({ operation: 'observe', engine, ...options })).observation;
  async function capture(command) {
    const reply = await ctx.call(command, { port: sdkPort, view: 'decision-window', limit: 1000, ...captureBoundaries[command] });
    if (!reply.ok || reply.evidence.coverage.status !== 'complete' || reply.evidence.coverage.gap || !reply.evidence.coverage.committed)
      throw new Error('Incomplete capture suffix: ' + JSON.stringify(reply));
    captureEvidence.push({ command, evidence: reply.evidence });
    return reply.result;
  }
  async function beginCapture(command) {
    const initial = await ctx.call(command, { port: sdkPort, view: 'decision-window', limit: 1000 });
    if (!initial.ok || !initial.evidence.capture.watermarkCursor || !initial.evidence.capture.runtimeEpoch)
      throw new Error('Capture boundary missing: ' + command + ': ' + JSON.stringify(initial));
    captureBoundaries[command] = { factCursor: initial.evidence.capture.watermarkCursor, runtimeEpoch: initial.evidence.capture.runtimeEpoch };
    await capture(command);
  }
  function one(observation, predicate) {
    const nodes = observation.nodes.filter(predicate);
    if (nodes.length !== 1) throw new Error('Expected one current node, found ' + nodes.length);
    return nodes[0];
  }
  async function act(observation, type, node, options = {}) {
    const t = performance.now();
    const result = await executor({ operation: 'act', snapshotId: observation.snapshotId,
      actionId: chapter + '-' + (++sequence), action: { type, ...(node ? { nodeId: node.nodeId } : {}), ...options } });
    actions.push({ type, target: node ? { description: node.description, text: node.text, id: node.id } : null,
      elapsedMs: performance.now() - t, mechanism: result.action.mechanism });
    return result;
  }
  async function native(description, type = 'click', options = {}, engine = 'espresso') {
    let observed = await observe(engine);
    let node = one(observed, n => n.description === description);
    if (engine === 'espresso' && !node.visible) {
      await act(observed, 'scrollTo', node);
      observed = await observe(engine);
      node = one(observed, n => n.description === description);
    }
    return act(observed, type, node, options);
  }
  async function textButton(text) {
    const observed = await observe();
    return act(observed, 'click', one(observed, n => n.text === text));
  }
  async function waitFor(predicate, engine = 'espresso', options = {}, timeoutMs = 5000) {
    const deadline = performance.now() + timeoutMs;
    let observed;
    do {
      observed = await observe(engine, options);
      if (predicate(observed)) return observed;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (performance.now() < deadline);
    throw new Error('Expected UI state did not appear: ' + JSON.stringify(observed));
  }
  const contains = (o, text) => o.nodes.some(n => n.text === text);
  async function dismissPasswordSave(observed) {
    if (!observed.nodes.some(n => n.packageName === 'com.coloros.codebook')) return false;
    systemInteractions.push({ kind: 'password-save-dialog', observation: observed });
    await act(observed, 'click', one(observed, n => n.packageName === 'com.coloros.codebook' && n.text === '不保存'));
    check('取消系统保存密码窗口', !(await observe('uiautomator')).nodes.some(n => n.packageName === 'com.coloros.codebook'));
    return true;
  }
  async function launchFixture(args, rootDescription) {
    await dismissPasswordSave(await observe('uiautomator'));
    const reply = await ctx.call('launch-activity', args);
    if (!reply.ok || reply.result.ok === false) {
      if (reply.error !== 'foreground_package_mismatch' || reply.result.foreground?.packageName !== 'com.coloros.codebook')
        throw new Error(JSON.stringify(reply));
      systemInteractions.push({ kind: 'activity-launch-interrupted', reply });
      if (!await dismissPasswordSave(await observe('uiautomator'))) throw new Error(JSON.stringify(reply));
    }
    await waitFor(o => o.nodes.some(n => n.description === rootDescription));
  }
  async function back() { return act(await observe(), 'back'); }
  async function stateValue(key) {
    const items = (await capture('state')).items.filter(item => item.namespace + '.' + item.key === key);
    if (items.length === 0) throw new Error('State was not recorded: ' + key);
    return items.sort((a, b) => b.id - a.id)[0].value;
  }

  async function nativePage() {
    await native('native_increment');
    check('原生按钮点击及跨引擎回读', contains(await observe('uiautomator'), 'Native counter: 1'));
    await native('native_input', 'replaceText', { text: '' });
    await native('native_input', 'typeText', { text: 'Bridge-2026' });
    check('Espresso 键盘事件输入', one(await observe(), n => n.description === 'native_input').text === 'Bridge-2026');
    await act(await observe(), 'closeKeyboard');
    await native('native_input', 'replaceText', { text: '完整回归 中文商品 123' });
    check('Espresso 中文替换与 UIA 回读', one(await observe('uiautomator'), n => n.description === 'native_input').text === '完整回归 中文商品 123');
    await native('native_input', 'setText', { text: 'UIA 商品 456' }, 'uiautomator');
    check('UI Automator 输入与 Espresso 回读', one(await observe(), n => n.description === 'native_input').text === 'UIA 商品 456');
    await native('record_log');
    check('手动日志记录', (await capture('logs')).items.some(n => n.message === 'manual native log event'));
    await native('record_event');
    check('自定义事件记录', (await capture('events')).items.some(n => n.category === 'native_test' && n.name === 'manual_event'));
    await native('record_state');
    const state = await stateValue('native_test.screen');
    check('页面状态记录', state.action === 'record_state' && state.counter === 1 && state.input === 'UIA 商品 456', state);
    await native('record_network');
    check('手动网络事件记录', (await capture('network')).items.some(n => n.url === 'https://debug.local/native-test' && n.statusCode === 200));
    for (const [description, expected, name] of [
      ['run_okhttp_auto_capture', 'OkHttp auto capture: HTTP 200', 'OkHttp GET 与自动网络采集'],
      ['run_okhttp_auto_post', 'OkHttp auto POST: HTTP 200', 'OkHttp POST 与自动网络采集'],
      ['run_okhttp_auto_error', 'OkHttp auto error captured: ConnectException', 'OkHttp 连接失败分支']]) {
      await native(description);
      const o = await waitFor(o => !one(o, n => n.description === 'native_counter_status').text.endsWith('running'));
      const actual = one(o, n => n.description === 'native_counter_status').text;
      check(name, actual === expected, actual);
    }
    await native('open_dialog');
    check('原生对话框标题与正文', contains(await observe(), 'Native dialog body for bridge perception'));
    await textButton('Dialog Confirm');
    check('确认对话框并记录状态', (await stateValue('native_test.screen')).action === 'dialog_confirmed');
    await native('open_dialog');
    await textButton('Dialog Cancel');
    check('取消对话框并返回原页面', (await observe()).nodes.some(n => n.description === 'native_input'));
  }

  async function windows() {
    await native('window_contract_fixture');
    await native('window_background_choice_0');
    await native('window_background_choice_1');
    check('两个后台同名按钮分别可定位', (await stateValue('window_contract.fixture')).backgroundClicks === 2);
    await native('window_open_dialog');
    await native('window_dialog_choice');
    await native('window_dialog_input', 'replaceText', { text: '保存商品 42.50' });
    await native('window_dialog_popup');
    await native('window_popup_choice', 'click', {}, 'uiautomator');
    await native('window_dialog_confirm');
    const saved = await stateValue('window_contract.fixture');
    check('Dialog 内 Popup 点击后返回 Dialog 并保存输入', saved.dialogClicks === 1 && saved.popupClicks === 1 && saved.confirmClicks === 1 && saved.savedInput === '保存商品 42.50', saved);
    check('前景弹窗操作未误点同名后台按钮', saved.backgroundClicks === 2);
    await native('window_open_popup');
    await native('window_popup_choice', 'click', {}, 'uiautomator');
    check('Activity Popup 点击并关闭', (await stateValue('window_contract.fixture')).popupClicks === 2);
    await native('window_open_dialog');
    check('再次打开回读已保存输入', one(await observe(), n => n.description === 'window_dialog_input').text === '保存商品 42.50');
    await native('window_dialog_input', 'replaceText', { text: '取消的修改' });
    await native('window_dialog_cancel');
    check('取消编辑不覆盖已保存值', (await stateValue('window_contract.fixture')).savedInput === '保存商品 42.50');
    await native('window_open_child');
    check('子 Activity 已打开', contains(await observe(), 'Window Child Activity'));
    await native('window_child_return');
    const final = await stateValue('window_contract.fixture');
    check('子 Activity 返回结果与父页面计数', final.childReturns === 1 && !final.dialogOpen && !final.popupOpen && final.backgroundClicks === 2, final);
    await back();
    await waitFor(o => o.nodes.some(n => n.description === 'native_test_title'));
    return { windowExpected: final };
  }

  async function h5() {
    const root = await observe();
    await act(root, 'scrollTo', one(root, n => n.description === 'native_h5_webview'));
    const options = { webView: { by: 'description', value: 'native_h5_webview' } };
    async function web(id, type, fields = {}, extra = {}) {
      const o = await observe('espresso-web', { ...options, ...extra });
      return act(o, type, one(o, n => n.id === id), fields);
    }
    await web('native-h5-input', 'webClear');
    await web('native-h5-input', 'webKeys', { text: 'H5 内嵌商品 789' });
    check('WebView DOM 中文输入', one(await observe('espresso-web', options), n => n.id === 'native-h5-input').value === 'H5 内嵌商品 789');
    await web('native-h5-button', 'webClick');
    check('H5 按钮与 DOM 结果', one(await observe('espresso-web', options), n => n.id === 'native-h5-body').text === 'Native H5 clicked');
    const frame = { framePath: [{ name: 'native-h5-frame' }] };
    await web('frame-button', 'webClick', {}, frame);
    check('内嵌 iframe 点击与回读', one(await observe('espresso-web', { ...options, ...frame }), n => n.id === 'frame-button').text === 'Frame clicked');
    await web('native-h5-fetch-button', 'webClick');
    let o;
    const deadline = performance.now() + 2500;
    do { o = await observe('espresso-web', options); if (one(o, n => n.id === 'native-h5-body').text === 'Native H5 fetch finished') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (performance.now() < deadline);
    check('H5 Fetch 网络请求完成', one(o, n => n.id === 'native-h5-body').text === 'Native H5 fetch finished', one(o, n => n.id === 'native-h5-body').text);
  }

  async function permissions() {
    await native('request_camera_permission');
    check('已授权相机分支', contains(await observe(), 'Camera permission: already granted'));
    await native('request_microphone_permission');
    const dialog = await observe('uiautomator');
    const deny = one(dialog, n => typeof n.resourceId === 'string' && /:id\/permission_deny_button$/.test(n.resourceId));
    await act(dialog, 'click', deny);
    check('系统权限拒绝与回调', contains(await observe(), 'Microphone permission: denied'));
    check('PackageManager 独立核对拒绝', !(await call('permission-state', { permission: 'android.permission.RECORD_AUDIO' })).granted);
    await native('request_microphone_permission');
    const second = await observe('uiautomator');
    const allow = one(second, n => typeof n.resourceId === 'string' && /:id\/permission_allow_one_time_button$/.test(n.resourceId));
    await act(second, 'click', allow);
    check('系统权限仅本次允许与回调', contains(await observe(), 'Microphone permission: granted'));
    check('PackageManager 独立核对允许', (await call('permission-state', { permission: 'android.permission.RECORD_AUDIO' })).granted);
  }

  async function login() {
    const mode = ctx.inputs.loginMode;
    const extra = mode === 'success' ? ['start=welcome', 'duplicate_submit=true', 'dialog=true', 'animate=true'] :
      mode === 'home' ? ['start=home'] : ['start=login', 'outcome=' + mode, 'account_prefill=demo', 'password_prefill=fixture-only', 'terms_checked=true'];
    await launchFixture({ activity: 'io.github.mobileaidev.aiappbridge.sample.intentfixture.IntentLoginFixtureActivity', action: 'io.github.mobileaidev.aiappbridge.sample.REGRESSION_' + mode, extra }, 'intent_fixture_root');
    if (mode === 'success') {
      await native('login_entry');
      await waitFor(o => contains(o, 'Before signing in'));
      await textButton('Continue');
      await native('sign_in_help_not_submit');
      check('重复 Sign in 标签能区分帮助入口', contains(await observe(), 'Help opened; login was not submitted'));
      await native('login_submit');
      check('未同意协议时阻止登录', contains(await observe(), 'Please accept the terms'));
      await native('login_terms');
      await native('login_submit');
      check('空账号密码校验', contains(await observe(), 'Account and password are required'));
      await native('login_account', 'typeText', { text: 'demo@example.test' });
      await native('login_password', 'replaceText', { text: 'fixture-only' });
      await act(await observe(), 'closeKeyboard');
    }
    if (mode !== 'home') await native('login_submit');
    const expected = { success: 'Login successful', invalid: 'Account or password is incorrect', network: 'Network unavailable', timeout: 'Request timed out', otp: 'Enter the one-time code sent to the user', home: 'Already authenticated' }[mode];
    await waitFor(o => contains(o, expected), 'espresso', {}, mode === 'timeout' ? 12000 : 5000);
    check('登录场景终态: ' + mode, true, expected);
    if (mode === 'otp') {
      await native('otp_code', 'replaceText', { text: '123456' });
      await native('otp_submit');
      check('验证码填写与提交事件', (await capture('events')).items.some(n => n.name === 'otp_submit_attempt' && n.data.length === 6));
    }
    const oracle = await stateValue('intent_fixture.oracle');
    check('登录状态独立核对: ' + mode, oracle.authenticated === ['success', 'home'].includes(mode) && oracle.submitCount === (mode === 'success' ? 3 : mode === 'home' ? 0 : 1), oracle);
    if (mode === 'success') {
      const deadline = performance.now() + 1000;
      do {
        if (await dismissPasswordSave(await observe('uiautomator'))) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (performance.now() < deadline);
    }
  }

  try {
    const streams = chapter === 'native' ? ['logs', 'events', 'state', 'network'] : chapter === 'windows' ? ['state'] : chapter.startsWith('login-') ? (ctx.inputs.loginMode === 'otp' ? ['events', 'state'] : ['state']) : [];
    for (const stream of streams) await beginCapture(stream);
    let extra;
    if (chapter === 'native') await nativePage();
    else if (chapter === 'windows') extra = await windows();
    else if (chapter === 'h5') await h5();
    else if (chapter === 'permissions') await permissions();
    else if (chapter.startsWith('login-')) await login();
    else throw new Error('Unknown chapter: ' + chapter);
    return { ok: checks.every(c => c.passed), chapter, checks, actions, captureEvidence, systemInteractions, elapsedMs: performance.now() - started, ...extra };
  } catch (error) {
    return { ok: false, chapter, checks, actions, systemInteractions, elapsedMs: performance.now() - started, error: error.stack };
  }
};
