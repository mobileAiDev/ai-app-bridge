'use strict';

// Two real Activity/tasks share one package. The launcher must expose and act
// on A while B remains alive; explicit task focus then returns to the same B.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');

module.exports.main = async ctx => {
  const { outDir, runId, businessRunId, hostBase, deviceBase } = ctx.inputs;
  const flutter = ctx.target.packageName, native = 'io.github.mobileaidev.aiappbridge.sample';
  const began = Date.now(), calls = [], states = [], checks = [];
  let app = flutter, phase = 'initial-runtime', error;
  const save = (name, value) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2));
  async function call(command, args = {}) {
    const atMs = Date.now();
    const target = ['adb-exec', 'runtime', 'device-ownership'].includes(command) ? args : { packageName: app, ...args };
    const reply = await ctx.call(command, target);
    calls.push({ phase, command, args: target, atMs, ms: Date.now() - atMs, reply });
    fs.appendFileSync(path.join(outDir, 'calls.jsonl'), JSON.stringify(calls.at(-1)) + '\n');
    assert(reply.ok && !reply.ambiguous, `${phase}: ${command}: ${reply.error}: ${reply.message || ''}`);
    return reply.result;
  }
  async function adb(argv, readOnly = false) {
    const result = await call('adb-exec', { argv, readOnly });
    assert.equal(result.exitCode, 0, result.stderr); return result.stdout;
  }
  const wait = (provider, targetText, timeoutMs = 15000) => call('wait-text', { provider, targetText, timeoutMs, intervalMs: 100 });
  const tapNative = contentDescription => call('tap-native', { selector: { contentDescription } });
  async function check(name, condition) {
    const verdict = await ctx.assert({ name, condition, scope: 'code' }); checks.push({ name, verdict: verdict.verdict });
    assert.equal(verdict.verdict, 'passed', name);
  }
  async function inspect(name, text) {
    await wait('flutter', text);
    const tree = await call('flutter-nodes'); save(name + '-tree.json', tree);
    const activities = await adb(['shell', 'dumpsys', 'activity', 'activities'], true);
    fs.writeFileSync(path.join(outDir, name + '-activities.txt'), activities);
    const match = activities.match(/topResumedActivity=ActivityRecord\{(\S+) u\d+ ([^ ]+) t(\d+)\}/);
    assert(match, 'Actual foreground Activity identity is missing');
    assert.equal(match[2], flutter + '/.MainActivity');
    const state = { name, text, runtimeEpoch: tree.runtimeEpoch, taskId: Number(match[3]), activityToken: match[1] };
    assert.equal(typeof state.runtimeEpoch, 'string'); states.push(state);
    save('engine-states.json', states);
    await call('screenshot', { outFile: path.join(outDir, name + '.png') });
    return { ...state, tree, activities };
  }
  const server = async () => {
    const response = await fetch(`${hostBase}/__state?run=${encodeURIComponent(businessRunId)}`);
    assert(response.ok); return response.json();
  };
  try {
    const hostBefore = await call('runtime', { operation: 'status' }); save('host-before.json', hostBefore);
    const ownership = await call('device-ownership', { operation: 'status', serial: ctx.target.serial });
    assert.equal(ownership.active, 0);
    const before = await server(); save('server-before.json', before);
    assert.equal(before.orders['ORDER-1'].revision, 4);

    phase = 'root-A';
    await call('launch-activity', { activity: '.MainActivity', action: 'android.intent.action.VIEW',
      data: `bridge-workflow-lab://recovery?run=${runId}&point=before-effect` });
    // Initial cold setup has a separate functional budget; all time is retained.
    await wait('flutter', 'Effect count: 0', 60000);
    const a = await inspect('A-initial', 'Effect count: 0');

    phase = 'second-engine-B'; app = native;
    await call('launch-activity', { activity: '.WorkflowLabActivity',
      extra: [`lab_base_url=${deviceBase}`, `lab_run=${businessRunId}`] });
    await wait('native', '协作工作台'); await tapNative('lab_resume_order'); await tapNative('lab_flutter');
    app = flutter;
    const b = await inspect('B-inspection', '工单 ORDER-1，版本 4');
    await check('Two simultaneously retained Activity/tasks have distinct Dart runtime epochs',
      a.taskId !== b.taskId && a.activityToken !== b.activityToken && a.runtimeEpoch !== b.runtimeEpoch
      && b.activities.includes(`ActivityRecord{${a.activityToken} u0 ${flutter}/.MainActivity t${a.taskId}}`));

    phase = 'original-launcher-return-A';
    await call('launch-app');
    const aReturned = await inspect('A-launcher-return', 'Effect count: 0');
    await check('Original launcher returns the actual root A tree and epoch',
      aReturned.taskId === a.taskId && aReturned.activityToken === a.activityToken && aReturned.runtimeEpoch === a.runtimeEpoch);
    await call('tap-flutter-text', { targetText: '执行新的明确动作' });
    await inspect('A-first-effect', 'Effect count: 1');

    phase = 'explicit-return-B';
    await adb(['shell', 'am', 'task', 'focus', String(b.taskId)]);
    const bReturned = await inspect('B-return', '工单 ORDER-1，版本 4');
    await check('Task focus returns the same B engine and Activity', bReturned.runtimeEpoch === b.runtimeEpoch
      && bReturned.taskId === b.taskId && bReturned.activityToken === b.activityToken);
    const note = `前台 B 编辑 ${runId}`;
    await call('input-flutter-text', { selector: { label: '复核记录', role: 'input' }, text: note, focus: false, hideKeyboard: false });
    const edited = await inspect('B-edited', '工单 ORDER-1，版本 4');
    await check('Input updates the visible B editor', edited.tree.nodes.some(node => node.role === 'input' && node.label === '复核记录' && node.text === note));

    phase = 'second-launcher-return-A'; await call('launch-app');
    const aAgain = await inspect('A-second-launcher-return', 'Effect count: 1');
    await check('A survives B editing with its own epoch and count', aAgain.runtimeEpoch === a.runtimeEpoch && aAgain.taskId === a.taskId);
    await call('tap-flutter-text', { targetText: '执行新的明确动作' });
    await inspect('A-second-effect', 'Effect count: 2');
    const journal = (await adb(['shell', 'run-as', flutter, 'cat', `files/flutter-recovery-${runId}.jsonl`], true)).trim().split('\n').map(JSON.parse);
    save('A-independent-journal.json', journal);
    await check('Exactly two explicit actions reached A; the fault action was never invoked', journal.at(-1).count === 2
      && journal.at(-1).deliveries === 2 && journal.filter(row => row.action === 'new-explicit').length === 2
      && !journal.some(row => row.action === 'original'));

    phase = 'B-retained-editor'; await adb(['shell', 'am', 'task', 'focus', String(b.taskId)]);
    const bAgain = await inspect('B-final', '工单 ORDER-1，版本 4');
    await check('B editor retained its value across both launcher switches', bAgain.runtimeEpoch === b.runtimeEpoch
      && bAgain.taskId === b.taskId && bAgain.tree.nodes.some(node => node.role === 'input' && node.label === '复核记录' && node.text === note));
    const after = await server(); save('server-after.json', after);
    await check('Business record and effect counts remain unchanged', JSON.stringify(before.orders) === JSON.stringify(after.orders)
      && before.flutterUpdates === after.flutterUpdates && before.approvals === after.approvals && before.saveAttempts === after.saveAttempts);
    const hostAfter = await call('runtime', { operation: 'status' }); save('host-after.json', hostAfter);
    await check('Host runtime is unchanged', hostBefore.runtimeId === hostAfter.runtimeId);
  } catch (caught) { error = caught; }
  const report = { ok: !error, elapsedMs: Date.now() - began, phase, calls: calls.length, checks, states,
    error: error ? String(error.stack || error) : null, automaticReplay: false,
    performanceClaim: false, originalLauncherReproduced: states.some(state => state.name === 'A-launcher-return') };
  save('program-report.json', report); return report;
};
