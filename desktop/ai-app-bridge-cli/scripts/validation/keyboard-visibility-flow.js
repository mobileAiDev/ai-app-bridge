'use strict';
module.exports.main = async ctx => {
  const fs = require('node:fs');
  const path = require('node:path');
  const lab = require(ctx.inputs.helperPath)(ctx);
  const { call, check, wait, tapFlutter: tap } = lab;
  const measurements = [];
  async function viewportUntil(name, predicate) {
    const deadline = Date.now() + 5000;
    do {
      const tree = await call('flutter-nodes');
      const bottom = tree.viewport.viewInsets.bottom;
      const labels = tree.nodes.map(node => node.label || node.text).filter(Boolean);
      measurements.push({ name, atMs: Date.now(), bottom, labels });
      if (predicate(bottom, labels)) return tree;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new Error(`${name}: current Flutter viewport did not reach the expected keyboard state`);
  }
  let error;
  let originalKeyboardSetting;
  try {
    if (ctx.inputs.config.realKeyboard) {
      const original = await call('adb-exec', { argv: ['shell', 'settings', 'get', 'secure', 'show_ime_with_hard_keyboard'], readOnly: true });
      originalKeyboardSetting = original.stdout.trim();
      await call('adb-exec', { argv: ['shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1'] });
    }
    await call('launch-activity', { activity: '.MainActivity', clearTask: ctx.inputs.config.clearTask === true,
      data: `bridge-workflow-lab://city?base=${encodeURIComponent(ctx.inputs.deviceBase)}&run=${encodeURIComponent(ctx.inputs.runId)}` });
    await call('wait-text', { provider: 'flutter', targetText: '账号登录',
      timeoutMs: ctx.inputs.config.startupTimeoutMs ?? 10000, intervalMs: 50 });
    lab.phase('visible-keyboard');
    await call('input-flutter-text', { selector: { label: '登录账号', role: 'input' }, text: 'bridge@example.test', hideKeyboard: false });
    const shown = await viewportUntil('shown', bottom => bottom > 0);
    await check('A real open keyboard still clips the viewport', shown.viewport.viewInsets.bottom > 0);
    await call('screenshot', { outFile: path.join(ctx.inputs.outDir, 'keyboard-visible.png') });
    lab.phase('hidden-keyboard');
    await call('flutter-action', { payload: { action: 'hideKeyboard' } });
    const hidden = await viewportUntil('hidden', bottom => bottom === 0);
    await check('Explicit dismissal refreshes the actual Flutter insets', hidden.viewport.viewInsets.bottom === 0);
    await lab.flutterInput('登录密码', 'fixture-password');
    await tap('同意用户协议');
    await tap('登录并继续');
    await wait('flutter', '附近门店');
    const destinations = ['首页', '活动', '订单', '我的'];
    const market = await viewportUntil('market', (bottom, labels) => bottom === 0 && destinations.every(label => labels.includes(label)));
    await check('All four navigation destinations are visible exactly once', destinations.every(label => market.nodes.filter(node => (node.label || node.text) === label).length === 1));
    await call('screenshot', { outFile: path.join(ctx.inputs.outDir, 'keyboard-hidden-navigation.png') });
    await tap('活动');
    await call('h5-wait', { selector: { text: '领取 CITY5', tag: 'button' }, timeoutMs: 10000, intervalMs: 50 });
    const state = await (await fetch(`${ctx.inputs.hostBase}/__state?run=${encodeURIComponent(ctx.inputs.runId)}`)).json();
    await check('The navigation reaches real H5 after one successful login', state.sessions === 1 && Object.keys(state.commerce.orders).length === 0);
  } catch (e) { error = e; }
  finally {
    if (originalKeyboardSetting !== undefined) {
      try {
        const restore = originalKeyboardSetting === 'null'
          ? ['shell', 'settings', 'delete', 'secure', 'show_ime_with_hard_keyboard']
          : ['shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', originalKeyboardSetting];
        await call('adb-exec', { argv: restore });
        const restored = await call('adb-exec', { argv: ['shell', 'settings', 'get', 'secure', 'show_ime_with_hard_keyboard'], readOnly: true });
        await check('The emulator keyboard preference is restored', restored.stdout.trim() === originalKeyboardSetting);
      } catch (restoreError) { error = error || restoreError; }
    }
  }
  fs.writeFileSync(path.join(ctx.inputs.outDir, 'keyboard-viewport.json'), JSON.stringify(measurements, null, 2));
  return lab.report(error);
};
