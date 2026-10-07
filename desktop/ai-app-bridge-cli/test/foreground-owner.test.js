'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { foregroundWindow, parseForegroundWindow, tap } = require('../bin/device-provider');
const { parseForegroundWindowIdentity, verifyForegroundPackageUid, verifyForegroundProcessIdentity,
  sameForegroundWindow, validForegroundIdentity } = require('../bin/shared-kernel/android-foreground-identity');
const { androidForegroundFixture } = require('../test-support/android-foreground-fixture');

const host = 'example.owner', guest = 'example.projected';
const fixture = options => androidForegroundFixture(host, { title: `${guest}/.GuestActivity`, ...options });
const parsed = dump => parseForegroundWindowIdentity(dump, parseForegroundWindow(dump));
const verified = value => verifyForegroundPackageUid(verifyForegroundProcessIdentity(parsed(value.windowDump), value.processDump), value.packageDump);

// WindowManager.LayoutParams can continue flags on the next line after ty.
// Observed on the physical API 36 device, with no trailing space after the type.
const wrapAttributes = dump => dump.replace(/(\bty=[A-Z_0-9]+)\}\n/, '$1\n      fl=LAYOUT_IN_SCREEN HARDWARE_ACCELERATED\n    }\n');

function transport(value, change = {}) {
  const calls = [];
  let windowReads = 0, processReads = 0;
  return { calls, adb: async (_ctx, args) => {
    calls.push(args);
    if (args.join(' ') === 'shell dumpsys window -a') return { stdout: ++windowReads === 1 ? value.windowDump : change.windowDump ?? value.windowDump };
    if (args.join(' ') === `shell cat /proc/sys/kernel/random/boot_id /proc/${value.pid}/stat /proc/${value.pid}/status`)
      return { stdout: ++processReads === 1 ? value.processDump : change.processDump ?? value.processDump };
    if (args.join(' ') === `shell dumpsys package ${value.packageName}`) return { stdout: change.packageDump ?? value.packageDump };
    assert.fail(`Unexpected device command: ${args.join(' ')}`);
  } };
}

test('actual foreground query resolves owner despite a guest title and brackets package/process reads', async () => {
  const value = fixture(), ports = transport(value);
  const result = await foregroundWindow({ packageName: host }, ports);
  assert.equal(result.ok, true); assert.equal(result.packageName, host);
  assert.equal(result.projectedComponent, `${guest}/.GuestActivity`);
  assert.equal(result.component, `${host}/${host}.MainActivity`);
  assert.equal(result.ownerUid, value.uid); assert.equal(result.ownerPid, value.pid);
  assert.equal(result.processStartTicks, '34951868'); assert.equal(validForegroundIdentity(result), true);
  assert.deepEqual(ports.calls.map(args => args[1]), ['dumpsys', 'cat', 'dumpsys', 'dumpsys', 'cat']);
});

// Sources: AOSP WindowState.dump in android-7.1.2_r39 / android-11.0.0_r48.
// Android 7 writes stackId + mAppToken, Android 11 rootTaskId + mActivityRecord;
// neither container ID is the Activity task ID. Numeric LayoutParams are valid.
for (const apiLevel of [25, 30, 36]) test(`API ${apiLevel} owner format preserves actual Activity task and package user`, async () => {
  const value = fixture({ apiLevel, taskId: 93, userId: 10 });
  const result = await foregroundWindow({}, transport(value));
  assert.equal(result.ok, true, result.error); assert.equal(result.taskId, 93);
  assert.equal(result.userId, 10); assert.equal(result.packageUid, 1010001);
});

for (const apiLevel of [25, 30, 36]) test(`API ${apiLevel} multiline attributes retain complete owner verification`, async () => {
  const value = fixture({ apiLevel });
  value.windowDump = wrapAttributes(value.windowDump);
  const ports = transport(value);
  const result = await foregroundWindow({}, ports);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.packageName, host); assert.equal(result.windowType, 1);
  assert.equal(result.ownerUid, value.uid); assert.equal(result.ownerPid, value.pid);
  assert.equal(result.processStartTicks, '34951868'); assert.equal(validForegroundIdentity(result), true);
  assert.deepEqual(ports.calls.map(args => args[1]), ['dumpsys', 'cat', 'dumpsys', 'dumpsys', 'cat']);
});

for (const [name, mutate, error] of [
  ['missing type', s => s.replace('ty=BASE_APPLICATION', 'flags=0'), 'foreground_window_type_missing'],
  ['unknown symbolic type', s => s.replace('ty=BASE_APPLICATION', 'ty=FUTURE_TYPE'), 'foreground_window_type_unsupported'],
  ['unknown numeric type', s => s.replace('ty=BASE_APPLICATION', 'ty=9999'), 'foreground_window_type_unsupported'],
  ['duplicate attributes', s => s.replace('      fl=', '    mAttrs={ty=BASE_APPLICATION\n      fl='), 'foreground_window_type_missing'],
  ['foreign Activity', s => s.replace(`mActivityRecord=ActivityRecord{ddeeff u0 ${host}/`, `mActivityRecord=ActivityRecord{ddeeff u0 ${guest}/`), 'foreground_activity_owner_conflict'],
]) test(`multiline attributes reject ${name}`, () => {
  const result = parsed(mutate(wrapAttributes(fixture().windowDump)));
  assert.equal(result.ok, false); assert.equal(result.error, error);
});

test('multiline attributes still reject process owner changes during verification', async () => {
  const value = fixture(); value.windowDump = wrapAttributes(value.windowDump);
  const result = await foregroundWindow({}, transport(value, {
    processDump: value.processDump.replace('Uid:\t10001\t10001', 'Uid:\t10002\t10001'),
  }));
  assert.equal(result.ok, false); assert.equal(result.error, 'foreground_process_changed_during_verification');
});

test('non-Activity system window with a non-component title keeps its owner and null Activity', async () => {
  const value = androidForegroundFixture('com.android.systemui', { windowKind: 'non-activity', title: 'ImmersiveModeConfirmation' });
  value.windowDump += `mFocusedApp=ActivityRecord{other u0 ${host}/.BehindSystemWindow t98}\n`;
  const result = await foregroundWindow({}, transport(value));
  assert.equal(result.ok, true, result.error); assert.equal(result.packageName, 'com.android.systemui');
  assert.equal(result.windowKind, 'non-activity'); assert.equal(result.windowType, 2014);
  assert.equal(result.taskId, null); assert.equal(result.activity, null); assert.equal(result.component, null);
  assert.equal(validForegroundIdentity(result), true);
});

test('Android 11 trusted application overlay is a known non-Activity window type', async () => {
  const value = androidForegroundFixture('example.system', { apiLevel: 30, windowKind: 'non-activity',
    title: 'Trusted overlay', windowType: 'TRUSTED_APPLICATION_OVERLAY' });
  const result = await foregroundWindow({}, transport(value));
  assert.equal(result.ok, true, result.error); assert.equal(result.windowType, 2042);
  assert.equal(result.windowKind, 'non-activity'); assert.equal(validForegroundIdentity(result), true);
});

for (const [name, mutate, error] of [
  ['missing owner', s => s.replace(/^.*mOwnerUid=.*\n/m, ''), 'foreground_window_owner_missing'],
  ['missing type', s => s.replace(/^.*mAttrs=.*\n/m, ''), 'foreground_window_type_missing'],
  ['unknown type', s => s.replace('ty=BASE_APPLICATION', 'ty=9999'), 'foreground_window_type_unsupported'],
  ['missing Activity', s => s.replace(/^.*mActivityRecord=.*\n/m, ''), 'foreground_activity_missing'],
  ['foreign Activity', s => s.replace(`mActivityRecord=ActivityRecord{ddeeff u0 ${host}/`, `mActivityRecord=ActivityRecord{ddeeff u0 ${guest}/`), 'foreground_activity_owner_conflict'],
  ['foreign Activity user', s => s.replace('ActivityRecord{ddeeff u0', 'ActivityRecord{ddeeff u10'), 'foreground_activity_owner_conflict'],
  ['conflicting task', s => s.replace('taskId=23', 'taskId=24'), 'foreground_activity_owner_conflict'],
  ['conflicting owner user', s => s.replace('mOwnerUid=10001', 'mOwnerUid=1010001'), 'foreground_window_owner_conflict'],
  ['conflicting display', s => s.replace('mDisplayId=0 taskId', 'mDisplayId=1 taskId'), 'foreground_window_owner_conflict'],
  ['conflicting title', s => s.replace('Window #0 Window{aabbcc u0 example.projected/.GuestActivity}', 'Window #0 Window{aabbcc u0 ChangedTitle}'), 'foreground_window_owner_conflict'],
  ['duplicate WindowState', s => s + s.slice(s.indexOf('  Window #0')), 'foreground_window_identity_ambiguous'],
  ['system type with Activity', s => s.replace('ty=BASE_APPLICATION', 'ty=STATUS_BAR_PANEL'), 'foreground_window_type_conflict'],
]) test(`reject ${name} without substituting a title or background Activity`, () => {
  const result = parsed(mutate(fixture().windowDump));
  assert.equal(result.ok, false); assert.equal(result.error, error);
});

test('an Activity marker cannot substitute for an unobserved focused WindowState', () => {
  assert.equal(parsed(`mCurrentFocus=null\nmFocusedApp=ActivityRecord{aa u0 ${host}/.Main t23}`).error, 'foreground_window_identity_missing');
});

test('exact package UID validation rejects shared-UID other packages, absent users and conflicting records', () => {
  const value = fixture(), foreground = parsed(value.windowDump);
  for (const dump of [value.packageDump.replaceAll(host, 'example.other'),
    value.packageDump.replace('installed=true', 'installed=false'),
    value.packageDump.replace('User 0:', 'User 1:'), value.packageDump + value.packageDump]) {
    assert.equal(verifyForegroundPackageUid(foreground, dump).error, 'foreground_package_uid_unverified');
  }
  assert.equal(verifyForegroundPackageUid(foreground, value.packageDump.replace('appId=10001', 'appId=10002')).error, 'foreground_package_uid_mismatch');
});

test('an updated preinstalled app is verified from active Packages, not its hidden bundled version', () => {
  const value = fixture(), foreground = parsed(value.windowDump);
  const hidden = value.packageDump.replace('Packages:', 'Hidden system packages:').replace('appId=10001', 'appId=10002');
  assert.equal(verifyForegroundPackageUid(foreground, value.packageDump + '\n' + hidden).ok, true);
  assert.equal(verifyForegroundPackageUid(foreground, hidden).error, 'foreground_package_uid_unverified');
  const duplicate = value.packageDump + value.packageDump.replace('Packages:\n', '');
  assert.equal(verifyForegroundPackageUid(foreground, duplicate).error, 'foreground_package_uid_unverified');
});

test('process verification binds the same PID and all four UIDs, not its projected process name', () => {
  const value = fixture(), foreground = parsed(value.windowDump);
  assert.equal(verifyForegroundProcessIdentity(foreground, value.processDump.replace('(fixture owner)', '(projected guest)')).ok, true);
  for (const dump of [value.processDump.replace('Pid:\t4321', 'Pid:\t4322'),
    value.processDump.replace('Uid:\t10001\t10001', 'Uid:\t10002\t10001'), value.processDump.replace('34951868', '0')]) {
    assert.equal(verifyForegroundProcessIdentity(foreground, dump).error, 'foreground_process_owner_conflict');
  }
  assert.equal(verifyForegroundProcessIdentity(foreground, '').error, 'foreground_process_identity_missing');
});

for (const [name, options] of [['token', { token: 'aabbdd' }], ['pid', { pid: 4322 }], ['task', { taskId: 24 }], ['uid', { appId: 10002 }]]) {
  test(`query rejects ${name} change while verifying ownership`, async () => {
    const result = await foregroundWindow({}, transport(fixture(), { windowDump: fixture(options).windowDump }));
    assert.equal(result.error, 'foreground_changed_during_verification'); assert.equal(result.ownershipVerified, false);
  });
}
for (const [name, options] of [['birth', { startTicks: '34951869' }], ['boot', { bootId: '2457c3c8-cc65-4fa8-b835-fd601361df91' }]]) {
  test(`query rejects process ${name} change even with the same PID and window`, async () => {
    const result = await foregroundWindow({}, transport(fixture(), fixture(options)));
    assert.equal(result.error, 'foreground_process_changed_during_verification'); assert.equal(result.ownershipVerified, false);
  });
}

test('window equality cannot accept absent identity and includes lifetime beyond the same component', () => {
  const original = verified(fixture());
  assert.equal(sameForegroundWindow(original, verified(fixture())), true);
  assert.equal(sameForegroundWindow({ packageName: host, component: 'same' }, { packageName: host, component: 'same' }), false);
  assert.equal(sameForegroundWindow(original, { ...original, windowIdentity: '' }), false);
  for (const options of [{ token: 'different' }, { pid: 4322 }, { startTicks: '34951869' }, { appId: 10002 }])
    assert.equal(sameForegroundWindow(original, verified(fixture(options))), false);
});

test('app-scoped tap rejects a foreign actual owner even when its title names the requested app', async () => {
  const value = androidForegroundFixture('example.foreign', { title: `${host}/.MainActivity` });
  const result = await tap({ explicitPackageName: true, packageName: host }, 10, 10, { scope: 'device' }, {
    foregroundWindow: () => foregroundWindow({}, transport(value)),
    adb: async () => assert.fail('Foreign owner must not dispatch any input'),
  });
  assert.equal(result.error, 'foreground_package_mismatch'); assert.equal(result.dispatched, false);
});
