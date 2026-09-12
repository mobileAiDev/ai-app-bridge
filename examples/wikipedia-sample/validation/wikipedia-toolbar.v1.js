'use strict';

// Authored from wikipedia-toolbar-intent-20260912-01, its Native observations,
// and the independent SharedPreferences results. All business actions use Bridge.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const PACKAGE = 'org.wikipedia.dev.bridge_sample';
const CUSTOMIZE = 'org.wikipedia.page.customize.CustomizeToolbarActivity';
const DEFAULT = [0, 1, 2, 3, 4], REORDERED = [1, 0, 2, 3, 4];
const MENU = [5, 6, 7, 8, 13, 9, 10, 11, 12];

module.exports.main = async ctx => {
  const assertions = [], actions = [], independent = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  async function call(command, args = {}) {
    const result = await ctx.call(command, args);
    if (!result.ok) throw Error(JSON.stringify(result));
    return result;
  }
  function nodes(observation) {
    const windows = observation.result.windows;
    const window = [...windows].reverse().find(w => w.root.visible === true && w.root.alpha > 0);
    if (!window) throw Error('No visible original window');
    const result = [];
    function visit(node) {
      if (node.visible !== true || node.alpha <= 0) return;
      result.push(node);
      for (const child of node.children || []) visit(child);
    }
    visit(window.root); return result;
  }
  async function waitFor(predicate, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    let observation;
    do {
      observation = await call('tree', { compact: false });
      if (predicate(observation, nodes(observation))) return observation;
      await new Promise(resolve => setTimeout(resolve, 150));
    } while (Date.now() < deadline);
    throw Error('Expected Wikipedia state did not appear');
  }
  async function check(name, condition, observation) {
    const result = await ctx.assert({ name, condition, requiredEvidence: ['tree'], evidence: observation.evidence });
    assertions.push(result);
    if (result.verdict !== 'passed') throw Error(JSON.stringify(result));
  }
  async function mutate(command, args) {
    const result = await call(command, args);
    if (!result.executionReceipt?.settled || result.executionReceipt.kind !== 'native'
      || result.executionReceipt.actionId !== result.execution.actionId) throw Error('Original Native receipt missing');
    actions.push({ command, actionId: result.execution.actionId });
  }
  const tap = text => mutate('tap-text', { targetText: text, provider: 'native' });
  async function oracle(stage, expected) {
    const deadline = Date.now() + 5000;
    do {
      const { stdout } = await execute(ctx.inputs.python, [ctx.inputs.oraclePath, ctx.inputs.serial], { timeout: 20000 });
      const result = JSON.parse(stdout);
      if (result.packageName !== PACKAGE || result.serial !== ctx.inputs.serial) throw Error('Oracle target mismatch');
      independent.push({ stage, ...result });
      await ctx.checkpoint(stage, result);
      if (expected(result.values)) return result.values;
      await new Promise(resolve => setTimeout(resolve, 150));
    } while (Date.now() < deadline);
    throw Error(`Persisted Wikipedia state did not settle: ${stage}`);
  }
  const order = observation => nodes(observation)
    .filter(n => n.resourceName === PACKAGE + ':id/listItem')
    .sort((a, b) => a.bounds.top - b.bounds.top).slice(0, 5).map(n => n.text);
  const labels = ['保存', '语言', '在条目内查找', '主题', '目录'];

  const popup = await waitFor((_, list) => list.some(n => n.text === '知道了'), 30000);
  await check('The real one-time coachmark is visible', nodes(popup).some(n => n.text === '自定义您的工具栏'), popup);
  await tap('知道了');
  const dismissed = await waitFor((_, list) => list.some(n => n.contentDescription === '更多选项') && !list.some(n => n.text === '知道了'));
  const dismissedPrefs = await oracle('coachmark-dismissed', v => v.showCustomizeToolbarTooltip.value === false);
  await check('Coachmark dismissal persisted', dismissedPrefs.showCustomizeToolbarTooltip.present && dismissedPrefs.showCustomizeToolbarTooltip.value === false, dismissed);
  await call('screenshot');
  await tap('更多选项');
  await waitFor((_, list) => list.some(n => n.text === '自定义工具栏' && n.clickable));
  await tap('自定义工具栏');
  const before = await waitFor((o, list) => o.result.activity === CUSTOMIZE && list.some(n => n.text === '保存'));
  await check('Initial toolbar has the frozen default order', same(order(before), labels), before);
  const save = nodes(before).find(n => n.text === '保存');
  const language = nodes(before).find(n => n.text === '语言');
  await mutate('native-gesture', { payload: { action: 'swipe',
    selector: { resourceName: PACKAGE + ':id/dragHandle', within: { text: '保存', ancestor: { className: 'org.wikipedia.page.customize.CustomizeToolbarItemView' } } },
    deltaX: 0, deltaY: language.bounds.bottom - (save.bounds.top + save.bounds.bottom) / 2, durationMs: 900 } });
  const reordered = await waitFor(o => same(order(o), ['语言', '保存', ...labels.slice(2)]));
  const reorderedPrefs = await oracle('toolbar-reordered', v => same(v.customizeToolbarOrder.value, REORDERED) && same(v.customizeToolbarMenuOrder.value, MENU));
  await check('Drag reordered the real UI and persisted exact IDs', same(reorderedPrefs.customizeToolbarOrder.value, REORDERED)
    && same(reorderedPrefs.customizeToolbarMenuOrder.value, MENU), reordered);
  await call('screenshot');
  await tap('转到上一层级');
  await waitFor((o, list) => o.result.activity === 'org.wikipedia.page.PageActivity' && list.some(n => n.contentDescription === '更多选项'));
  await tap('更多选项');
  await waitFor((_, list) => list.some(n => n.text === '自定义工具栏' && n.clickable));
  await tap('自定义工具栏');
  const reopened = await waitFor(o => o.result.activity === CUSTOMIZE && same(order(o), ['语言', '保存', ...labels.slice(2)]));
  await check('Reopening retained the changed toolbar', same((await oracle('toolbar-reopened', v => same(v.customizeToolbarOrder.value, REORDERED))).customizeToolbarOrder.value, REORDERED), reopened);
  await mutate('native-gesture', { payload: { action: 'scroll', selector: { resourceName: PACKAGE + ':id/recyclerView' }, direction: 'down', durationMs: 500 } });
  await waitFor((_, list) => list.some(n => n.text === '重置为默认设置'));
  await tap('重置为默认设置');
  const restored = await waitFor(o => same(order(o), labels));
  const restoredPrefs = await oracle('toolbar-restored', v => same(v.customizeToolbarOrder.value, DEFAULT) && same(v.customizeToolbarMenuOrder.value, MENU));
  await check('Reset restored the toolbar and menu on disk', same(restoredPrefs.customizeToolbarOrder.value, DEFAULT)
    && same(restoredPrefs.customizeToolbarMenuOrder.value, MENU), restored);
  await call('screenshot');
  return { gate: 'passed', scope: 'Real Wikipedia coachmark and toolbar customization; article network acceptance remains open', assertions, actions, independent };
};
