'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseForegroundWindow, tap } = require('../bin/device-provider');
const { parseForegroundWindowIdentity } = require('../bin/shared-kernel/android-foreground-identity');
const { androidForegroundFixture } = require('../test-support/android-foreground-fixture');
const parse = raw => parseForegroundWindowIdentity(raw, parseForegroundWindow(raw));

for (const prefix of ['', 'WM.LayoutParams', 'WindowManager.LayoutParams']) {
  test(`window fields accept ${prefix || 'bare'} attributes, whitespace and reordered multiline fields`, () => {
    const fixture = androidForegroundFixture('example.owner', { apiLevel: 25 });
    const raw = fixture.windowDump
      .replace(/mDisplayId=0 stackId=1 mSession=(Session\{[^}]+\})/, '$1\n    stackId=1 mDisplayId = 0')
      .replace('Session{ccbbaa', 'mSession = Session{ccbbaa')
      .replace('mOwnerUid=10001 showForAllUsers=false package=example.owner', 'package = example.owner\n    showForAllUsers=false mOwnerUid = 10001')
      .replace('mAttrs={(0,0)(fillxfill) ty=1}', `mAttrs = ${prefix}{\n fl=0\n ty = 1\n}`);
    const result = parse(raw);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.packageName, 'example.owner');
    assert.equal(result.windowType, 1);
    assert.equal(result.ownerPid, fixture.pid);
  });
}

test('conflicting field values preserve raw evidence and never invent ownership', () => {
  const raw = androidForegroundFixture('example.owner').windowDump.replace('mOwnerUid=10001', 'mOwnerUid=10002 mOwnerUid=10001');
  const result = parse(raw);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'foreground_window_owner_conflict');
  assert.notEqual(result.ownershipVerified, true);
  assert.match(result.evidence.window, /mOwnerUid=10002 mOwnerUid=10001/);
  assert.equal(result.diagnostic.field, 'mOwnerUid');
});

for (const foreground of [
  { ok: false, error: 'foreground_window_type_missing', evidence: { window: 'mAttrs=unknown' } },
  { ok: true, packageName: 'example.other', ownershipVerified: true, windowIdentity: 'other' },
]) test(`explicit device tap is dispatched with ${foreground.error || 'mismatching owner'} warning`, async () => {
  let dispatches = 0;
  const result = await tap({ explicitPackageName: true, packageName: 'example.owner' }, 10, 10, { scope: 'device' }, {
    foregroundWindow: async () => foreground,
    adb: async () => { dispatches++; return { dispatched: true, ambiguous: false }; },
  });
  assert.equal(dispatches, 1);
  assert.equal(result.ok, true);
  assert.equal(result.dispatched, true);
  assert.equal(result.ambiguous, false);
  assert.equal(result.foregroundObservations[0].status, foreground.ok ? 'mismatch' : 'unknown');
  assert.equal(result.warnings[0].code, foreground.error || 'foreground_package_mismatch');
  assert.deepEqual(result.foregroundObservations[0].actual, foreground);
});

for (const type of ['1', 'BASE_APPLICATION', 'TYPE_BASE_APPLICATION', 'android.view.WindowManager.LayoutParams.TYPE_BASE_APPLICATION']) {
  test(`window heading, focus and attributes accept line breaks with ${type}`, () => {
    const raw = androidForegroundFixture('example.owner', { apiLevel: 25 }).windowDump
      .replace(/Window\{/g, 'Window {\n  ')
      .replace('mAttrs={(0,0)(fillxfill) ty=1}', `mAttrs = WM.LayoutParams {\n taskId=-1\n extra=unchanged ty=${type}\n}`);
    const result = parse(raw);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.windowType, 1);
    assert.notEqual(result.taskId, -1);
  });
}

for (const [change, error] of [
  [raw => raw.replace('mOwnerUid=10001', ''), 'foreground_window_owner_missing'],
  [raw => raw.replace('ty=BASE_APPLICATION', 'ty=UNKNOWN_VENDOR_TYPE'), 'foreground_window_type_unsupported'],
  [raw => raw.replace('ty=BASE_APPLICATION', 'ty=BASE_APPLICATION ty=APPLICATION_OVERLAY'), 'foreground_window_type_conflict'],
]) test(`incomplete/conflicting window fields report ${error} without filling an owner`, () => {
  const result = parse(change(androidForegroundFixture('example.owner').windowDump));
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error, error);
  assert.equal(result.ownershipVerified, false);
  assert.ok(result.evidence.window);
  assert.ok(result.diagnostic.field);
  if (error === 'foreground_window_owner_missing') assert.equal(Object.hasOwn(result, 'ownerUid'), false);
});

test('numeric probe exit and stderr survive separately from a real action failure', async () => {
  const { foregroundWindow } = require('../bin/device-provider');
  const failure = Object.assign(new Error('adb command failed'), { code: 1, stderr: 'device offline', stdout: '' });
  const observation = await foregroundWindow({}, { adb: async () => { throw failure; } });
  assert.equal(observation.error, 'foreground_probe_failed');
  assert.equal(observation.cause.stderr, 'device offline');
  assert.equal(observation.cause.code, 1);
  assert.equal(observation.ownershipVerified, false);
  await assert.rejects(tap({ explicitPackageName: true, packageName: 'example.owner' }, 10, 10, { scope: 'device' }, {
    foregroundWindow: async () => observation,
    adb: async () => { throw Object.assign(new Error('input connection closed'), { code: 'device_disconnected', dispatched: false, ambiguous: false }); },
  }), error => error.code === 'device_disconnected' && error.dispatched === false
    && error.warnings[0].actual.cause.stderr === 'device offline');
});

test('Script exposes foreground feedback beside execution facts even when a provider has its own result payload', async () => {
  const { createScriptHostPort } = require('../bin/script/script-host-port');
  const warnings = [{ code: 'foreground_window_type_missing', source: 'android-window-manager', observedAtMs: 123 }];
  const foregroundObservations = [{ expected: { packageName: 'example.owner' }, actual: { ok: false, error: warnings[0].code }, status: 'unknown' }];
  for (const ok of [true, false]) {
    const host = createScriptHostPort({ target: { platform: 'android', serial: `script-foreground-${ok}`, packageName: 'example.owner' },
      executionId: `foreground-${ok}`, permissions: ['app.interact'],
      actions: async () => ({ ok, error: ok ? null : 'native_target_not_operable', dispatched: ok, ambiguous: false,
        result: { handled: ok }, warnings, foregroundObservations }) });
    const result = await host.call('tap-native', { selector: { text: 'Open' } });
    assert.equal(result.ok, ok);
    assert.equal(result.dispatched, ok);
    assert.equal(result.ambiguous, false);
    assert.deepEqual(result.warnings, warnings);
    assert.deepEqual(result.foregroundObservations, foregroundObservations);
    assert.deepEqual(result.result, { handled: ok });
  }
});
