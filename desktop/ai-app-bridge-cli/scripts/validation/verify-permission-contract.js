'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createUiaRuntimeFixture } = require('../../test-support/uia-runtime-fixture');

// Controlled Android process fixture for exercising an actual installed MCP
// package. This is transport/packaging proof, separately labelled from device QA.
async function verifyPermissionContract({ out, run }) {
  const statePath = path.join(out, 'permission-device.json');
  const trace = path.join(out, 'permission-adb.jsonl');
  const adb = path.join(out, 'permission-adb');
  const target = { serial: 'controlled-permission-device', packageName: 'example.permission', permission: 'android.permission.RECORD_AUDIO', adb };
  const save = (file, data) => fs.writeFileSync(path.join(out, file), JSON.stringify(data, null, 2) + '\n');
  const reset = outcome => save('permission-device.json', { outcome, granted: false, flags: [], dialog: true });
  const runtime = await createUiaRuntimeFixture({ directory: path.join(out, 'permission-uia'), serial: target.serial,
    xml: '<hierarchy><node package="vendor.dialog" class="FrameLayout" bounds="[0,0][400,800]"><node package="vendor.dialog" text="Choisir ceci" class="Button" enabled="true" clickable="true" bounds="[20,100][380,180]"/></node></hierarchy>',
    onDispatch: () => {
      const state = JSON.parse(fs.readFileSync(statePath));
      state.dialog = false; state.granted = state.outcome.startsWith('allow');
      state.flags = state.outcome === 'allow-once' ? ['ONE_TIME', 'USER_SET'] : state.outcome === 'deny' ? ['USER_SET'] : [];
      fs.writeFileSync(statePath, JSON.stringify(state));
    } });
  try {
  fs.writeFileSync(adb, `#!${process.execPath}
const fs = require('node:fs');
if (require(${JSON.stringify(require.resolve('../../test-support/uia-runtime-fixture'))}).handleUiaRuntimeFixture(process.argv.slice(2), { directory: ${JSON.stringify(runtime.directory)} })) process.exit(0);
const call = require(${JSON.stringify(require.resolve('../../test-support/android-shell-fixture'))}).handleAndroidShellFixture(process.argv.slice(2));
if (call.handled) process.exit(0);
const args = call.args;
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + '\\n');
const file = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(file));
const save = () => fs.writeFileSync(file, JSON.stringify(state));
if (args.includes('get-current-user')) console.log('10');
else if (args.includes('dumpsys') && args.includes('package')) console.log('Packages:\\n  Package [example.permission] (123):\\n    appId=10488\\n    User 10: installed=true\\n      runtime permissions:\\n        android.permission.RECORD_AUDIO: granted=' + state.granted + ', flags=[ ' + state.flags.join('|') + ']');
else if (args.includes('dumpsys') && args.includes('activities')) {
  const component = state.dialog ? 'vendor.dialog/.Request' : 'example.permission/.Main';
  console.log('RootTask:\\n  topResumedActivity=ActivityRecord{abc u10 ' + component + ' t12}\\n  * Hist  #1: ActivityRecord{abc u10 ' + component + ' t12}\\n    launchedFromUid=1010488 launchedFromPackage=example.permission launchedFromFeature=null userId=10\\n    Intent { act=' + (state.dialog ? 'android.content.pm.action.REQUEST_PERMISSIONS' : 'android.intent.action.MAIN') + ' cmp=' + component + ' }');
} else if (args.includes('dumpsys') && args.includes('window')) console.log('mCurrentFocus=Window{abc u10 vendor.dialog/vendor.dialog.Request}');
else if (args.includes('input')) {
  state.dialog = false; state.granted = state.outcome.startsWith('allow');
  state.flags = state.outcome === 'allow-once' ? ['ONE_TIME','USER_SET'] : state.outcome === 'deny' ? ['USER_SET'] : []; save();
} else if (args.includes('pm') && (args.includes('grant') || args.includes('revoke'))) { state.granted = args.includes('grant'); state.flags = []; save(); }
else { console.error('unsupported controlled ADB call'); process.exit(2); }
`, { mode: 0o755 });
  const results = [];
  for (const outcome of ['allow', 'allow-once', 'deny', 'dismiss']) {
    reset(outcome);
    const start = await run('permission-dialog', { ...target, outcome });
    assert.equal(start.status, 'waiting_for_decision', JSON.stringify(start));
    assert.equal(start.permissionDialog.actionCount, 0);
    assert.equal(start.summary.nodes.some(node => node.text === 'Choisir ceci'), true);
    const result = await run('intent', { operation: 'decide', operationId: start.operationId, decision: {
      decisionId: 'observed-choice', basedOnRevision: start.revision, agentDecision: 'act',
      action: outcome === 'dismiss' ? { action: 'back' } : { action: 'tap', selector: { text: 'Choisir ceci' } },
    } });
    assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.permissionDialog.verified, true);
    save(`permission-${outcome}.json`, result);
    results.push({ outcome, operationId: start.operationId, status: result.status, verified: result.permissionDialog.verified });
  }
  reset('deny');
  const start = await run('permission-dialog', { ...target, outcome: 'deny' });
  const cancelled = await run('intent', { operation: 'cancel', operationId: start.operationId });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(JSON.parse(fs.readFileSync(statePath)).dialog, true);
  save('permission-cancel.json', cancelled);
  const invalid = await run('permission-dialog', { ...target, outcome: 'allow', buttonText: 'Allow' });
  assert.equal(invalid.error, 'unsupported_argument');
  const script = await run('script', { operation: 'start', script: {
    schemaVersion: 'aab.code-script/v1', language: 'javascript', target: { platform: 'android', serial: target.serial, packageName: target.packageName, adb },
    permissions: ['app.read', 'app.permissions'], source: `module.exports.main = async ctx => {
      const args = ${JSON.stringify({ adb, permission: target.permission })};
      const grant = await ctx.call('permission-grant', args);
      const revoke = await ctx.call('permission-revoke', args);
      const state = await ctx.call('permission-state', args);
      if (!grant.ok || !revoke.ok || !state.ok || !grant.result.verified || !revoke.result.verified || state.result.granted || state.result.userId !== 10) throw new Error('Permission fixture verification failed');
      return { permissionFixturesVerified: true, userId: state.result.userId };
    };`,
  } });
  let state = script;
  const deadline = Date.now() + 15000;
  while (!['completed', 'failed'].includes(state.status) && Date.now() < deadline) state = await run('script', { operation: 'wait', operationId: script.operationId, waitMs: 1000 });
  assert.equal(state.status, 'completed', JSON.stringify(state)); save('permission-script.json', state);
  const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.filter(args => args.includes('input')), [['-s', target.serial, 'shell', 'input', 'keyevent', '4']]);
  assert.equal(runtime.dispatches.length, 3);
  assert.equal(calls.filter(args => args.includes('pm')).every(args => args.includes('--user') && args.includes('10')), true);
  reset('deny');
  const pending = await run('permission-dialog', { ...target, outcome: 'deny' });
  assert.equal(pending.status, 'waiting_for_decision');
  return { source: 'controlled ADB through actual MCP process', outcomes: results, cancelled: cancelled.operationId,
    script: script.operationId, physicalInputs: 1, nodeActions: 3, shutdownOperationId: pending.operationId };
  } finally { await runtime.close(); }
}

async function verifyPermissionShutdown({ out, run, operationId }) {
  const archived = await run('evidence', { operation: 'export', namespace: 'intent', operationId, outputDir: path.join(out, 'shutdown-archive') });
  assert.equal(archived.ok, true, JSON.stringify(archived));
  const records = JSON.parse(fs.readFileSync(path.join(archived.archiveDir, 'records.json')));
  const final = records.findLast(record => record.payload.kind === 'checkpoint').payload.payloadSummary;
  assert.equal(final.status, 'cancelled'); assert.equal(final.permissionDialog.actionCount, 0); assert.equal(final.permissionDialog.dialogClosed, false);
  const verified = await run('evidence', { operation: 'verify', archiveDir: archived.archiveDir, manifestSha256: archived.manifestSha256 });
  assert.equal(verified.ok, true);
  return { operationId, status: final.status, inputCount: 0, manifestSha256: archived.manifestSha256, integrity: verified.integrity };
}

module.exports = { verifyPermissionContract, verifyPermissionShutdown };
