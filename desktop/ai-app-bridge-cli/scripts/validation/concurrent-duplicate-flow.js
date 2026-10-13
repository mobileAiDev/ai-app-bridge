'use strict';

// All business writes in this scenario originate from the Native/H5/Flutter UI.
// The HTTP control surface only creates an isolated run and reads its journal.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');

module.exports.main = async ctx => {
  const { outDir, runId, hostBase } = ctx.inputs;
  const native = 'io.github.mobileaidev.aiappbridge.sample', flutter = 'io.github.mobileaidev.bridge_workflow_lab';
  const began = Date.now(), calls = [];
  const save = (name, value) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2));
  const traced = { ...ctx, call: async (command, args) => {
    const atMs = Date.now(), reply = await ctx.call(command, args);
    const row = { command, args, atMs, ms: Date.now() - atMs, reply };
    calls.push(row); fs.appendFileSync(path.join(outDir, 'calls.jsonl'), JSON.stringify(row) + '\n');
    return reply;
  } };
  const lab = require('./lab-client')(traced);
  const { call, raw, wait, check, tapNative: tap, inputNative: input } = lab;
  const hostCall = async (command, args) => {
    const reply = await traced.call(command, args); assert(reply.ok && !reply.ambiguous); return reply.result;
  };
  const state = async name => {
    const response = await fetch(`${hostBase}/__state?run=${encodeURIComponent(runId)}`);
    assert(response.ok); const value = await response.json(); save(name, value); return value;
  };
  const screenshot = name => call('screenshot', { outFile: path.join(outDir, name + '.png') });
  async function approve(review) {
    await tap('lab_h5');
    await call('h5-wait', { selector: { text: '预览审核', tag: 'button' }, timeoutMs: 15000, intervalMs: 100 });
    await call('h5-input', { selector: { ariaLabel: '审核意见' }, text: review });
    await call('h5-scroll', { selector: { ariaLabel: '同意审核结果' } });
    await call('h5-click', { selector: { ariaLabel: '同意审核结果' } });
    await call('h5-scroll', { selector: { text: '预览审核', tag: 'button' } });
    await call('h5-click', { selector: { text: '预览审核', tag: 'button' } });
    await call('h5-click', { selector: { text: '确认', tag: 'button' } });
    await call('h5-wait', { selector: { text: '审核已完成', tag: 'p' }, timeoutMs: 15000, intervalMs: 100 });
  }
  let error, conflict, duplicate;
  try {
    const host = await hostCall('runtime', { operation: 'status' }); save('host-before.json', host);
    const ownership = await hostCall('device-ownership', { operation: 'status', serial: ctx.target.serial });
    assert.equal(ownership.active, 0);
    if (!ctx.inputs.resume) {
    lab.phase('native-create');
    await call('launch-activity', { activity: '.WorkflowLabActivity', clearTask: true,
      extra: [`lab_base_url=${ctx.inputs.deviceBase}`, `lab_run=${runId}`] });
    await wait('native', '巡检协作平台', 30000);
    await tap('lab_login_entry');
    await input('lab_account', 'bridge@example.test');
    await input('lab_password', 'fixture-password');
    await tap('lab_agreement'); await tap('lab_login_submit');
    await wait('native', '协作工作台');
    await tap('lab_sites'); await input('lab_query', 'SITE-002'); await tap('lab_search');
    await wait('native', '查询完成 1 项 · 第 1 页');
    await tap('open_SITE-002'); await tap('lab_edit');
    await input('lab_assignee', '并发验收员'); await input('lab_note', '真实 UI 并发与重复提交');
    await tap('lab_preview');
    await call('tap-native', { selector: { text: '确认', className: 'android.widget.Button' } });
    await wait('native', '工单已保存');
    lab.phase('first-h5-review');
    await approve('第一位审核员：版本 1');
    await tap('lab_close_h5'); await tap('lab_flutter'); lab.app(flutter);
    await wait('flutter', '工单 ORDER-1，版本 2', 30000);
    await lab.flutterInput('复核记录', 'Flutter 保留旧版本 2 的编辑');
    await lab.tapFlutter('确认现场复核完成');
    await screenshot('flutter-cached-revision-2');
    save('flutter-before-concurrent-edit.json', await call('flutter-nodes'));

    lab.phase('concurrent-h5-edit'); lab.app(native);
    await call('launch-activity', { activity: '.WorkflowLabActivity',
      extra: [`lab_base_url=${ctx.inputs.deviceBase}`, `lab_run=${runId}`] });
    await wait('native', '协作工作台'); await tap('lab_resume_order');
    await approve('第二位审核员：并发修改到版本 3');
    await screenshot('h5-concurrent-edit');
    const edited = await state('state-after-concurrent-edit.json');
    await check('Separate H5 UI committed revision 3 while Flutter retained revision 2',
      edited.orders['ORDER-1'].revision === 3 && edited.approvals === 2 && edited.flutterUpdates === 0);

    lab.phase('stale-flutter-submit'); lab.app(flutter);
    // Close the newly opened Native Activity and reveal the original Flutter
    // Activity below it. A launcher entry may select another same-package task.
    await call('keyevent', { keyCode: 4 });
    await wait('flutter', '工单 ORDER-1，版本 2', 15000);
    save('flutter-still-stale.json', await call('flutter-nodes'));
    await lab.tapFlutter('提交复核');
    } else {
      lab.phase('resume-original-confirmation'); lab.app(flutter);
      assert(Number.isSafeInteger(ctx.inputs.resume.taskId) && ctx.inputs.resume.taskId > 0);
      const focused = await call('adb-exec', { argv: ['shell', 'am', 'task', 'focus', String(ctx.inputs.resume.taskId)] });
      assert.equal(focused.exitCode, 0, focused.stderr);
      await call('keyevent', { keyCode: 4 });
      // Observe the already-dispatched opening action; never replay that tap.
      await wait('flutter', '确认操作', 15000);
      save('original-confirmation-after-return.json', await call('flutter-nodes'));
      await screenshot('original-confirmation-after-return');
      const before = await state('state-before-original-confirmation.json');
      assert.equal(before.orders['ORDER-1'].revision, 3);
      assert.equal(before.flutterUpdates, 0);
    }
    await lab.tapFlutter('确认操作');
    await wait('flutter', 'revision_conflict (HTTP 409)', 15000);
    await screenshot('visible-revision-conflict');
    const rejected = await state('state-after-conflict.json');
    await check('Rejected stale UI submission made no server change',
      rejected.orders['ORDER-1'].revision === 3 && rejected.flutterUpdates === 0);
    conflict = { ok: true, submittedRevision: 2, currentRevision: 3, automaticReplay: false };

    lab.phase('query-and-explicit-submit');
    await lab.tapFlutter('重新查询工单');
    await wait('flutter', '工单 ORDER-1，版本 3');
    await lab.flutterInput('复核记录', '查询版本 3 后明确提交一次');
    await lab.tapFlutter('提交复核');
    await wait('flutter', '确认操作');
    const firstAtMs = Date.now();
    const first = await raw('tap-flutter-text', { targetText: '确认操作' });
    const secondAtMs = Date.now();
    // Deliberately do not use the helper's semantic retry: this is exactly one
    // second UI attempt, not a business retry or two direct HTTP requests.
    const second = await raw('tap-flutter-text', { targetText: '确认操作' });
    save('duplicate-ui-attempts.json', { firstAtMs, secondAtMs, intervalMs: secondAtMs - firstAtMs, first, second });
    assert(first.ok && !first.ambiguous);
    await check('Second immediate confirmation is not dispatched after the dialog disappears',
      !second.ok && second.dispatched === false && second.ambiguous !== true);
    await wait('flutter', '复核成功', 15000);
    await wait('flutter', '工单 ORDER-1，版本 4');
    await screenshot('final-revision-4');
    const final = await state('server-state.json');
    await check('UI workflow commits one create, two different reviews and one explicit check',
      final.saveAttempts === 1 && Object.keys(final.orders).length === 1 && final.approvals === 2
      && final.flutterUpdates === 1 && final.orders['ORDER-1'].revision === 4
      && final.orders['ORDER-1'].checkNote === '查询版本 3 后明确提交一次');
    duplicate = { ok: true, uiAttempts: 2, intervalMs: secondAtMs - firstAtMs,
      secondDispatched: second.dispatched, secondError: second.error,
      mechanism: 'second confirmation target absent or non-actionable; only the first UI action dispatched',
      serverDeduplicationClaim: false, automaticReplay: false };
    const hostAfter = await hostCall('runtime', { operation: 'status' });
    await check('Host unchanged through actual UI conflicts and duplicate attempt', hostAfter.runtimeId === host.runtimeId);
  } catch (caught) { error = caught; }
  const result = { ...lab.report(error), elapsedMs: Date.now() - began, conflict, duplicate };
  save('program-report.json', result);
  return result;
};
