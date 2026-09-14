'use strict';
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

// Reader fixture: the named book/chapters must already be downloaded; font size 28.
// Permissions: app.read, app.interact, capture.read. inputs.outputDir selects screenshots.
// Retry only a rejected UIA observation; never replay an ambiguous action.
module.exports.main = async ctx => {
  const startedAt = Date.now();
  const assertions = [];
  const receipts = [];
  const chapter2 = '第2章 修仙者降临 陈浔口吐白沫';
  const chapter3 = '第3章 春去秋来 二十载岁月';
  const book = '系统赋我长生，活着终会无敌';
  const id = name => `com.ldp.reader:id/${name}`;
  const call = async (command, args = {}) => {
    const deadline = Date.now() + 8000;
    let response;
    for (;;) {
      response = await ctx.call(command, args);
      if (!response.ok && command === 'uia-tree' && response.error === 'uia_tree_changed'
        && response.dispatched === false && Date.now() < deadline) {
        await delay(180);
        continue;
      }
      break;
    }
    if (!response.ok) throw new Error(`${command}:${response.error}:${JSON.stringify(response.result)}`);
    if (response.execution.actionId) receipts.push({command, actionId:response.execution.actionId, receipt:response.executionReceipt});
    return response;
  };
  const assert = async (name, condition, response, stream = 'tree') => {
    const result = await ctx.assert({name, condition, requiredEvidence:[stream], evidence:response.evidence});
    assertions.push(result);
    if (result.verdict !== 'passed') throw new Error(`${name}:${result.verdict}${result.reason ? ':' + result.reason : ''}`);
  };
  const observe = async (name, command, predicate) => {
    const deadline = Date.now() + 12000;
    let response;
    do {
      response = await call(command, {compact:true, visibleOnly:true, maxNodes:500});
      if (predicate(response.result.nodes)) break;
      await delay(200);
    } while (Date.now() < deadline);
    await assert(name, predicate(response.result.nodes), response, 'tree');
    return response;
  };
  const has = name => nodes => nodes.some(n => n.resourceName === id(name));
  const native = (name, predicate) => observe(name, 'tree', predicate);
  const body = async title => {
    const page = await native('目录抽屉已关闭', nodes => has('read_pv_page')(nodes) && !has('read_ll_catalog_drawer')(nodes));
    if (has('read_tv_category')(page.result.nodes)) {
      await tap({resourceName:id('read_pv_page')});
      await native('阅读菜单已关闭', nodes => !has('read_tv_category')(nodes) && has('read_pv_page')(nodes));
    }
    return observe(`正文可读：${title}`, 'uia-tree', nodes =>
      nodes.some(n => n.text === title) && nodes.filter(n => typeof n.text === 'string' && n.text.length > 12).length >= 4);
  };
  const tap = selector => call('tap-native', {selector});
  const menu = async () => {
    const page = await native('阅读页面控件可见', has('read_pv_page'));
    if (!has('read_tv_category')(page.result.nodes)) await tap({resourceName:id('read_pv_page')});
    await native('阅读菜单已打开', has('read_tv_category'));
  };
  const screenshot = name => call('screenshot', {outFile:path.join(ctx.inputs.outputDir, `${name}.png`)});

  const installed = await call('status');
  await native('书架目标书籍可见', nodes => nodes.some(n => n.resourceName === id('coll_book_tv_name') && n.text === book));
  await tap({text:book});
  await menu();
  await tap({resourceName:id('read_tv_category')});
  await native('起始目录包含第3章', nodes => nodes.some(n => n.resourceName === id('category_tv_chapter') && n.text === chapter3));
  await tap({text:chapter3});
  await body(chapter3);
  const before = await call('events', {sinceMs:Date.now() - 1000, limit:200});
  const boundary = before.evidence.capture;
  if (before.evidence.coverage.status !== 'complete' || before.evidence.coverage.gap || !before.evidence.coverage.committed
      || boundary.hasMore || !boundary.watermarkCursor || !boundary.runtimeEpoch || !boundary.targetKey) {
    throw new Error('Native event pre-action capture boundary unavailable');
  }
  const open = await tap({resourceName:id('read_pv_page')});
  const events = await call('events', {factCursor:boundary.watermarkCursor, afterActionId:open.execution.actionId, runtimeEpoch:boundary.runtimeEpoch, limit:200});
  await assert('Native 点击对应的手机持久化事件可查询', events.result.items.length > 0, events, 'events');
  await native('阅读菜单已打开', has('read_tv_setting'));
  await tap({resourceName:id('read_tv_setting')});
  await native('设置窗口字号保持28', nodes => nodes.some(n => n.resourceName === id('read_setting_tv_font') && n.text === '28'));
  await screenshot('script-settings');
  await call('keyevent', {keyCode:4});
  await native('设置窗口已关闭', nodes => has('read_pv_page')(nodes) && !has('read_setting_tv_font')(nodes));

  await menu();
  await tap({resourceName:id('read_tv_pre_chapter')});
  await body(chapter2);
  await screenshot('script-chapter2');
  await menu();
  await tap({resourceName:id('read_tv_category')});
  await native('目录包含已观察的第3章', nodes => nodes.some(n => n.resourceName === id('category_tv_chapter') && n.text === chapter3));
  await tap({text:chapter3});
  await body(chapter3);
  await call('keyevent', {keyCode:4});
  await native('书架显示目标书籍', nodes => nodes.some(n => n.resourceName === id('coll_book_tv_name') && n.text === book));
  await screenshot('script-shelf');
  await tap({text:book});
  await body(chapter3);
  await screenshot('script-restored');
  return {verdict:'passed', sdkVersion:installed.result.debugBridge.version, book, restoredChapter:chapter3, elapsedMs:Date.now()-startedAt,
    assertions, receipts, capture:{runtimeEpoch:boundary.runtimeEpoch, targetKey:boundary.targetKey,
      committed:events.evidence.coverage.committed, gap:events.evidence.coverage.gap, itemCount:events.result.items.length},
    uiaRetry:true};
};
