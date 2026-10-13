'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Ordinary JavaScript: branching, assertions and recovery execute in this
// process. The model receives the final report, not every individual command.
module.exports.main = async ctx => {
  const began = Date.now(), steps = [], checks = [], expectedFailures = [];
  let operationId, revision, phase = 'start';
  async function raw(command, args) {
    const started = Date.now();
    const r = await ctx.call(command, args);
    steps.push({ command, phase, ms: Date.now() - started, ok: r.ok, error: r.error,
      actionId: r.execution?.actionId ?? null, dispatched: r.dispatched, ambiguous: r.ambiguous });
    return r;
  }
  function requireOk(r) { if (!r.ok) throw new Error(`${phase}: ${r.command}: ${r.error}`); return r; }
  async function read(command, args) { return requireOk(await raw(command, args)); }
  async function check(name, condition, evidence) {
    const result = await ctx.assert({ name, condition, ...(evidence ? { requiredEvidence: ['tree'], evidence } : { scope: 'code' }) });
    checks.push({ name, verdict: result.verdict });
    if (result.verdict !== 'passed') throw new Error(`assertion: ${name}: ${result.verdict}`);
  }
  async function act(command, args, allowFailure = false) {
    let r;
    if (ctx.inputs.mode === 'intent') {
      const decision = { decisionId: `decision-${steps.length}`, basedOnRevision: revision, agentDecision: 'act',
        action: { action: 'command', command, arguments: args, observeAfter: true } };
      const outer = await raw('intent', { operation: 'decide', operationId, decision });
      if (!outer.result?.lastAction) return requireOk(outer);
      revision = outer.result.revision;
      const action = outer.result.lastAction;
      r = { ...action.result, command, error: action.error, ok: action.error == null,
        dispatched: action.dispatched, ambiguous: action.ambiguous };
    } else r = await raw(command, args);
    return allowFailure ? r : requireOk(r);
  }
  const tap = description => act('tap-native', { selector: { contentDescription: description } });
  const wait = text => read('wait-text', { provider: 'native', targetText: text, timeoutMs: 6000, intervalMs: 50 });
  const input = (description, text) => act('input-text', { selector: { contentDescription: description }, text, hideKeyboard: true });
  let state, error;
  try {
    await read('adb-exec', { argv: ['shell', 'am', 'force-stop', ctx.target.packageName] });
    await read('launch-activity', { activity: '.ComplexWorkflowFixtureActivity' });
    await wait('巡检工作台');
    if (ctx.inputs.mode === 'intent') {
      const started = await read('intent', { operation: 'start', goal: 'Complete the work-order app regression, recover known failures, verify the independent app state.',
        target: ctx.target, provider: 'native', background: false, timeoutMs: 120000 });
      operationId = started.result.operationId; revision = started.result.revision;
    }
    phase = 'query-and-disambiguate';
    await tap('workflow_tasks');
    await input('workflow_query', '巡检');
    await tap('workflow_search');
    await wait('查询完成');
    await act('tap-native', { selector: { text: '打开', within: { text: 'WO-102', ancestor: { contentDescription: 'work_order_row' } } } });
    await wait('工单详情 WO-102');
    phase = 'stale-reference-recovery';
    const observed = await read('tree', { compact: true, visibleOnly: true, maxNodes: 300 });
    const oldEdit = observed.result.nodes.find(n => n.contentDescription === 'workflow_edit');
    await tap('workflow_refresh');
    const stale = await act('tap-native', { selector: oldEdit.selector }, true);
    await check('Replaced view is not dispatched', !stale.ok && stale.dispatched === false && stale.ambiguous !== true);
    expectedFailures.push({ phase, error: stale.error, dispatched: stale.dispatched });
    await tap('workflow_edit');
    phase = 'cancel-and-form-validation';
    await tap('workflow_cancel_edit');
    await tap('workflow_edit');
    await tap('workflow_review');
    await wait('负责人和记录不能为空');
    await input('workflow_assignee', '测试员');
    await input('workflow_remark', '已完成现场巡检');
    await tap('workflow_priority');
    await tap('workflow_review');
    await wait('确认巡检结果');
    await act('tap-native', { selector: { text: '返回修改' } });
    await tap('workflow_review');
    phase = 'submit-and-recover';
    await act('tap-native', { selector: { text: '确认', className: 'android.widget.Button' } });
    await wait('服务暂时不可用，本次未保存');
    await tap('workflow_retry');
    await wait('巡检已保存');
    phase = 'cross-window-navigation';
    await tap('workflow_history');
    await wait('已保存 1 条 · WO-102');
    await tap('workflow_history_return');
    phase = 'settings';
    await tap('workflow_settings');
    await tap('workflow_notifications');
    await tap('workflow_save_settings');
    await wait('巡检工作台');
    phase = 'independent-verification';
    const saved = await read('adb-exec', { argv: ['shell', 'run-as', ctx.target.packageName, 'cat', 'files/complex-workflow.json'], readOnly: true });
    state = JSON.parse(saved.result.stdout);
    for (const [name, condition] of Object.entries({
      correctRecord: state.selectedId === 'WO-102', savedExactlyOnce: state.savedCount === 1 && state.submitAttempts === 2,
      inputPreserved: state.assignee === '测试员' && state.remark === '已完成现场巡检' && state.priority,
      cancelledAndValidated: state.cancelledDrafts === 1 && state.validationErrors === 1,
      settingsPersisted: state.notifications && state.settingsSaved === 1,
      noBackgroundAction: state.backgroundConfirms === 0, historyReturned: state.historyReturns === 1,
      allPages: ['loading','dashboard','tasks','detail','edit','review','submitting','retry','receipt','history','settings'].every(p => state.visits.includes(p)),
    })) await check(name, condition);
    if (operationId) await read('intent', { operation: 'decide', operationId,
      decision: { decisionId: 'complete', basedOnRevision: revision, agentDecision: 'complete', reason: 'Independent app state verified.' } });
  } catch (e) { error = String(e.message || e); }
  const elapsedMs = Date.now() - began;
  const report = { ok: !error, mode: ctx.inputs.mode || 'script', elapsedMs, withinMinute: elapsedMs <= 60000,
    phase, error: error || null, calls: steps.length, expectedFailures, checks, pages: state?.visits || [],
    receiptToHistoryMs: state ? state.trace.find(x => x.action === 'history_opened')?.atMs - state.trace.find(x => x.action === 'page:receipt')?.atMs : null };
  if (ctx.inputs.outDir) {
    fs.mkdirSync(ctx.inputs.outDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.inputs.outDir, 'details.json'), JSON.stringify({ report, steps, state }, null, 2));
  }
  return report;
};
