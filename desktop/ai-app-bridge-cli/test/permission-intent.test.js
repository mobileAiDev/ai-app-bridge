'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readPermissionState, changePermission, parsePermissionState, parsePermissionRequest } = require('../bin/android-permissions');
const { createPermissionIntent } = require('../bin/intent/permission-intent');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { getProcessDeviceMutationLease } = require('../bin/shared-kernel/device-mutation-lease');
const { commandSchema, commandContract, validateCommandArguments } = require('../bin/command-registry');
const { createCommandRouter } = require('../bin/command-router');
const { authorizeCommand } = require('../bin/script/script-catalog');
const { uiaXml } = require('../test-support/uia-target-fixture');

const packageName = 'example.requester';
const permission = 'android.permission.RECORD_AUDIO';
const params = { serial: 'test-device', packageName, permission, userId: 10 };
const packageDump = `Permission trees:
  ${permission}: granted=true, flags=[ USER_FIXED]
Packages:
  Package [example.requester.other] (ffff):
    appId=10489
    User 10: installed=true
      runtime permissions:
        ${permission}: granted=true, flags=[ USER_FIXED]
  Package [${packageName}] (abcd):
    appId=10488
    install permissions:
      android.permission.INTERNET: granted=true
    User 0: installed=true
      runtime permissions:
        ${permission}: granted=true, flags=[ ONE_TIME|USER_SET]
    User 10: installed=true
      runtime permissions:
        ${permission}: granted=false, flags=[ USER_SET| USER_SENSITIVE_WHEN_DENIED]
      enabledComponents:
        example.Activity
Queries:
  User 10:
    ${permission}: granted=true, flags=[ USER_FIXED]
`;
function activities({ token = 'abc', caller = packageName, action = 'android.content.pm.action.REQUEST_PERMISSIONS' } = {}) {
  return `ACTIVITY MANAGER ACTIVITIES
  RootTask:
    topResumedActivity=ActivityRecord{${token} u10 vendor.dialog/.Request t12}
    * Hist  #1: ActivityRecord{${token} u10 vendor.dialog/.Request t12}
      packageName=vendor.dialog
      launchedFromUid=1010488 launchedFromPackage=${caller} launchedFromFeature=null userId=10
      Intent { act=${action} cmp=vendor.dialog/.Request (has extras) }
      resultTo=ActivityRecord{app u10 ${packageName}/.Edit t12}
    * Hist  #0: ActivityRecord{app u10 ${packageName}/.Edit t12}
      packageName=${packageName}
      Intent { cmp=${packageName}/.Edit }
`;
}

test('permission query scopes exact package, Android user and runtime section; pipe-delimited flags remain distinct', () => {
  assert.deepEqual(parsePermissionState(packageDump, params), { packageName, permission, userId: 10, uid: 1010488,
    granted: false, flags: ['USER_SENSITIVE_WHEN_DENIED', 'USER_SET'] });
  assert.deepEqual(parsePermissionState(packageDump, { ...params, userId: 0 }).flags, ['ONE_TIME', 'USER_SET']);
  for (const [text, args, code] of [
    [packageDump, { ...params, packageName: 'absent.package' }, 'permission_package_not_found'],
    [packageDump, { ...params, userId: 11 }, 'permission_user_not_found'],
    [packageDump, { ...params, permission: 'android.permission.INTERNET' }, 'runtime_permission_not_found'],
    [packageDump.replace('User 10: installed=true', 'User 10: installed=false'), { ...params, packageName: 'example.requester.other' }, 'permission_package_not_installed'],
    [packageDump.replace('USER_SET| USER_SENSITIVE_WHEN_DENIED', 'USER_SET, USER_FIXED'), params, 'permission_state_unsupported'],
  ]) assert.throws(() => parsePermissionState(text, args), error => error.code === code);
});

test('current user is resolved once before fixture mutation; success requires an independent read for the same user', async () => {
  const calls = []; let changed = false;
  const run = async (_command, values) => {
    calls.push(values);
    if (values.includes('get-current-user')) return { stdout: '10\n' };
    if (values.includes('grant')) { changed = true; return { stdout: '' }; }
    return { stdout: changed ? packageDump.replace('granted=false', 'granted=true') : packageDump };
  };
  const result = await changePermission({ ...params, userId: undefined }, 'grant', run);
  assert.equal(result.verified, true); assert.equal(result.before.granted, false); assert.equal(result.granted, true);
  assert.deepEqual(calls[2], ['-s', params.serial, 'shell', 'pm', 'grant', '--user', '10', packageName, permission]);
  assert.equal(calls.filter(args => args.includes('get-current-user')).length, 1);
  await assert.rejects(changePermission(params, 'grant', async () => ({ stdout: packageDump })), error => error.code === 'permission_verification_failed' && error.dispatched);
  await assert.rejects(readPermissionState({ ...params, packageName: 'x;echo bad' }, () => assert.fail('invalid target must fail before ADB')), error => error.code === 'invalid_argument');
  await assert.rejects(readPermissionState(params, async () => { throw { code: 'ETIMEDOUT' }; }), error => error.code === 'permission_query_failed');
  await assert.rejects(changePermission(params, 'grant', async (_command, values) => {
    if (values.includes('grant')) throw { code: 255, stderr: 'java.lang.SecurityException: requires GRANT_RUNTIME_PERMISSIONS\n at System.check()' };
    return { stdout: packageDump };
  }), error => error.code === 'permission_change_denied' && error.dispatched && !error.ambiguous && error.details.reason.includes('GRANT_RUNTIME_PERMISSIONS'));
});

test('Activity identity comes from the top-resumed detailed record, independent of ROM package or labels', () => {
  const r = parsePermissionRequest(activities());
  assert.equal(r.request.requesterPackage, packageName); assert.equal(r.request.requesterUid, 1010488);
  assert.equal(r.request.token, 'abc'); assert.equal(r.request.packageName, 'vendor.dialog');
  assert.deepEqual(r.activeRequestTokens, ['abc']);
  assert.equal(r.request.component, 'vendor.dialog/vendor.dialog.Request');
  assert.equal(parsePermissionRequest(activities({ action: 'android.intent.action.VIEW' })).request, null);
  for (const bad of [activities().replace('launchedFromUid=', 'missingUid='), activities().replace('topResumedActivity=', 'unknown='), activities() + activities()]) {
    assert.throws(() => parsePermissionRequest(bad), error => error.code === 'permission_request_unsupported');
  }
});

test('permission-dialog is an Intent entry; old label heuristics and Script nesting are rejected', async () => {
  const args = { ...params, outcome: 'deny' };
  assert.deepEqual(commandContract('permission-dialog').entrypoints, { mcp: true, cli: true, script: false });
  assert.equal(commandContract('permission-dialog').role, 'execution');
  for (const field of ['buttonText', 'targetText', 'attempts', 'resourceId', 'port', 'requestId', 'feedback']) {
    assert.throws(() => validateCommandArguments('permission-dialog', { ...args, [field]: 'old' }), error => error.code === 'unsupported_argument');
  }
  for (const command of ['permission-state', 'permission-grant', 'permission-revoke']) {
    assert.equal(commandSchema(command).properties.port, undefined);
    validateCommandArguments(command, { ...params, requestId: 'script-action' });
  }
  assert.equal(authorizeCommand('permission-dialog', ['app.permissions']).ok, false);
  const router = createCommandRouter({ dispatchCommon: () => assert.fail(), loadIntent: () => ({ handle: received => {
    assert.deepEqual(received.permissionDialog, args); return { ok: true, command: 'intent' };
  } }) });
  assert.equal((await router.route('permission-dialog', args)).value.command, 'intent');
});

async function fixture(t, options = {}) {
  const serial = `permission-${Math.random()}`;
  const state = { ok: true, packageName, permission, serial, userId: 10, uid: 1010488, granted: false, flags: [] };
  const request = parsePermissionRequest(activities());
  let dialog = true; let token = 'abc'; let current = { ...state }; let label = 'Décision observée'; let treeReads = 0;
  const calls = []; const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const readRequest = async () => options.readRequest ? options.readRequest() : dialog
    ? { ...request, request: { ...request.request, token }, activeRequestTokens: [token] }
    : { ...request, foreground: { token: 'app', packageName, component: `${packageName}/.Edit`, userId: 10 }, activeRequestTokens: [], request: null };
  const readState = async () => { await options.beforeStateRead?.(); return options.readState ? options.readState() : { ...current, flags: [...current.flags] }; };
  const send = async values => {
    calls.push(values); if (options.sendInput) await options.sendInput();
    current = { ...state, granted: (options.outcome || 'allow').startsWith('allow'), flags: options.outcome === 'allow-once' ? ['ONE_TIME', 'USER_SET'] : options.outcome === 'deny' ? ['USER_SET'] : [] , ...options.after };
    dialog = options.keepDialog === true;
    return { ok: true, dispatched: true, ambiguous: false };
  };
  const workflow = await createPermissionIntent({ args: { serial, packageName, permission, outcome: options.outcome || 'allow', timeoutMs: options.timeoutMs || 60000 }, operationId: serial, store,
    dependencies: { readState, readRequest,
      ports: {
        createBridgeContext: args => args,
        foregroundWindow: async () => ({ ok: true, packageName: 'vendor.dialog', component: 'vendor.dialog/vendor.dialog.Request', activity: 'vendor.dialog.Request' }),
        uiaTreeOnce: async () => { treeReads++; if (options.treeRead) await options.treeRead(treeReads); return uiaXml(`<hierarchy><node package="vendor.dialog" class="FrameLayout" bounds="[0,0][400,800]"><node package="vendor.dialog" text="${label}" class="Button" resource-id="vendor.dialog:id/choice" enabled="true" clickable="true" bounds="[20,100][380,180]"/></node></hierarchy>`); },
        uiaTap: async (ctx, binding) => binding.target.selector.value !== label
          ? { ok: false, error: 'uia_reobserve_required', dispatched: false, ambiguous: false }
          : send({ kind: 'uia-node', actionId: ctx.runtimeActionId, binding }),
        keyevent: async (ctx, keyCode) => send({ kind: 'keyevent', actionId: ctx.runtimeActionId, keyCode }),
        tap: async () => assert.fail('Permission text choices must use a bound UIA node'),
      },
    } });
  t.after(async () => { if (!workflow.isFinished()) await workflow.cancel(); });
  const decide = (action = { action: 'tap', selector: { text: 'Décision observée' } }, extra = {}) => workflow.decide({ decisionId: `decision-${calls.length}-${Math.random()}`, basedOnRevision: workflow.status().revision, agentDecision: 'act', action, ...extra });
  return { workflow, serial, store, calls, decide, setToken: value => { token = value; }, setLabel: value => { label = value; }, setState: value => { current = { ...current, ...value }; }, close: () => { dialog = false; } };
}

test('all four outcomes require an owned decision, committed receipt, PackageManager state and original Activity closure', async t => {
  for (const outcome of ['allow', 'allow-once', 'deny', 'dismiss']) {
    const h = await fixture(t, { outcome });
    const initial = await h.workflow.start(); assert.equal(initial.ok, true, JSON.stringify(initial));
    assert.equal(h.calls.length, 0); assert.equal(h.workflow.status().status, 'waiting_for_decision');
    assert.equal(getProcessDeviceMutationLease().acquire(h.serial).error, 'target_busy');
    const result = await h.decide(outcome === 'dismiss' ? { action: 'back' } : undefined);
    assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.permissionDialog.verified, true);
    assert.equal(result.permissionDialog.dialogClosed, true); assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].kind, outcome === 'dismiss' ? 'keyevent' : 'uia-node');
    assert.equal(h.calls[0].actionId.startsWith(h.serial + ':'), true);
    if (outcome !== 'dismiss') assert.deepEqual(h.calls[0].binding.target.selector,
      { kind: 'text', value: 'Décision observée', exact: true, packageName: 'vendor.dialog' });
    assert.equal(getProcessDeviceMutationLease().status(h.serial).active, 0);
    const proof = h.store.read(result.permissionDialog.verificationEvidenceId);
    assert.equal(proof.record.payloadSummary.permissionDialog.after.granted, outcome.startsWith('allow'));
    assert.equal(h.store.read(result.permissionDialog.actionEvidenceId).record.ambiguous, false);
  }
});

test('agent completion, arbitrary keys and stale revisions cannot bypass verification or dispatch', async t => {
  const h = await fixture(t); await h.workflow.start();
  assert.equal((await h.decide(undefined, { agentDecision: 'complete' })).error, 'permission_requires_observed_decision');
  assert.equal((await h.decide({ action: 'back', keyCode: 3 })).error, 'permission_requires_observed_decision');
  assert.equal((await h.decide(undefined, { basedOnRevision: 0 })).error, 'invalid_argument');
  assert.equal(h.calls.length, 0);
  assert.equal((await h.decide()).status, 'completed');
});

test('a changed Activity instance, state, or label is never clicked using an old decision', async t => {
  for (const change of [h => h.setToken('new'), h => h.setState({ granted: true }), h => h.setLabel('A different decision')]) {
    const h = await fixture(t); await h.workflow.start(); change(h);
    const result = await h.decide(); assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(h.calls.length, 0);
  }
});

test('wrong requester is rejected and a manual outcome cannot be credited to an unexecuted Intent', async t => {
  const h = await fixture(t, { readRequest: async () => parsePermissionRequest(activities({ caller: 'other.package' })) });
  assert.equal((await h.workflow.start()).error, 'permission_requester_mismatch'); assert.equal(h.calls.length, 0);
  const manual = await fixture(t); await manual.workflow.start(); manual.setState({ granted: true }); manual.close();
  assert.equal((await manual.workflow.observe()).status, 'intervention_required'); assert.equal(manual.calls.length, 0);
});

test('request ownership is rechecked after the permission query, immediately before input', async t => {
  let reads = 0; let h;
  h = await fixture(t, { beforeStateRead: () => { if (++reads === 2) h.setToken('replaced-during-query'); } });
  await h.workflow.start();
  assert.equal((await h.decide()).error, 'permission_request_changed'); assert.equal(h.calls.length, 0);
});

test('UI provider exceptions retain diagnostic detail under a stable permission error code', async t => {
  const h = await fixture(t, { treeRead: () => { throw new Error('Command failed: adb offline\nUSB transport closed'); } });
  const r = await h.workflow.start();
  assert.equal(r.error, 'permission_ui_observation_failed');
  assert.match(r.permissionDialog.providerFailure.message, /USB transport closed/);
  assert.equal(h.calls.length, 0);
});

test('an elapsed deadline blocks input even before the timer callback is scheduled', async t => {
  const actualNow = Date.now;
  let reads = 0;
  const h = await fixture(t, { beforeStateRead: () => { if (++reads === 2) Date.now = () => actualNow() + 120000; } });
  try {
    await h.workflow.start(); const r = await h.decide();
    assert.equal(r.status, 'timeout'); assert.equal(h.calls.length, 0);
  } finally { Date.now = actualNow; }
});

test('successful input with a wrong or still-pending permission result is not a pass', async t => {
  const wrong = await fixture(t, { outcome: 'allow-once', after: { granted: true, flags: ['USER_SET'] } });
  await wrong.workflow.start(); const result = await wrong.decide();
  assert.equal(result.status, 'failed'); assert.equal(result.error, 'permission_outcome_mismatch'); assert.equal(result.permissionDialog.verified, false);
  const pending = await fixture(t, { keepDialog: true }); await pending.workflow.start();
  assert.equal((await pending.decide()).permissionDialog.verified, false); assert.equal(pending.workflow.isFinished(), false);
  pending.close(); assert.equal((await pending.workflow.observe()).status, 'completed');
});

test('cancel and timeout do not dismiss the dialog and release ownership after final verification', async t => {
  const h = await fixture(t); await h.workflow.start();
  const result = await h.workflow.cancel();
  assert.equal(result.status, 'cancelled'); assert.equal(result.permissionDialog.dialogClosed, false); assert.equal(h.calls.length, 0);
  assert.equal((await h.decide()).error, 'operation_stopped');
  const timed = await fixture(t, { timeoutMs: 25 }); await timed.workflow.start();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(timed.workflow.status().status, 'timeout'); assert.equal(timed.calls.length, 0);
  assert.equal(getProcessDeviceMutationLease().status(timed.serial).active, 0);
});

test('cancellation during permission revalidation prevents input; cancellation after dispatch waits for acknowledgement', { timeout: 5000 }, async t => {
  let unblock; let reached; let reads = 0;
  const started = new Promise(resolve => { reached = resolve; });
  const h = await fixture(t, { beforeStateRead: () => ++reads === 2 ? new Promise(resolve => { unblock = resolve; reached(); }) : null });
  await h.workflow.start(); const acting = h.decide(); await started;
  const cancelled = h.workflow.cancel(); assert.equal(getProcessDeviceMutationLease().acquire(h.serial).error, 'target_busy');
  unblock(); assert.equal((await acting).status, 'cancelled'); await cancelled; assert.equal(h.calls.length, 0);
  let release; let sent;
  const sentPromise = new Promise(resolve => { sent = resolve; });
  const inFlight = await fixture(t, { sendInput: () => new Promise(resolve => { release = resolve; sent(); }) });
  await inFlight.workflow.start(); const action = inFlight.decide(); await sentPromise;
  const stop = inFlight.workflow.cancel(); assert.equal(getProcessDeviceMutationLease().acquire(inFlight.serial).error, 'target_busy');
  release(); await action; const end = await stop;
  assert.equal(end.status, 'cancelled'); assert.equal(end.permissionDialog.after.granted, true); assert.equal(end.permissionDialog.verified, false);
  assert.equal(inFlight.calls.length, 1); assert.equal(getProcessDeviceMutationLease().status(inFlight.serial).active, 0);
});

test('uncommitted dispatch markers and receipts cannot become permission success', async t => {
  for (const blocked of ['dispatch-marker', 'action-receipt', 'checkpoint']) {
    const h = await fixture(t); await h.workflow.start(); const persist = h.store.persist;
    h.store.persist = (kind, record) => kind === blocked ? Promise.resolve({ ok: false, error: 'disk_full' }) : persist(kind, record);
    const result = await h.decide(); assert.equal(result.permissionDialog.verified, false); assert.notEqual(result.status, 'completed');
    assert.equal(h.calls.length, blocked === 'dispatch-marker' ? 0 : 1);
    assert.equal(getProcessDeviceMutationLease().status(h.serial).active, 0);
  }
});
