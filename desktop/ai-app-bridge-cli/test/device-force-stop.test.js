'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createDeviceMutationLease, runDeviceEffect } = require('../bin/shared-kernel/device-mutation-lease');
const { validateCommandArguments, isAndroidMutation, commandContract } = require('../bin/command-registry');

test('force-stop is an independent public reset control', () => {
  assert.deepEqual(validateCommandArguments('device-ownership', { operation: 'force-stop', serial: 'phone' }),
    { operation: 'force-stop', serial: 'phone' });
  assert.equal(isAndroidMutation('device-ownership', { operation: 'force-stop' }), false);
  assert.match(commandContract('device-ownership').execution.conditionalMutation, /force-stop/);
});

test('reset archives and clears a retained UiAutomation test session', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-force-automation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { createHash } = require('node:crypto');
  const claim = { serial: 'phone', sessionId: 'stuck-test', descriptorFile: '/recorded/session.json' };
  const file = path.join(directory, 'automation-sessions', createHash('sha256').update('phone').digest('hex') + '.json');
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(claim));
  const { forceStopDevice } = require('../bin/shared-kernel/device-force-stop');
  let stoppedClaim;
  const result = await forceStopDevice({ serial: 'phone' }, { directory, stopHost: async () => [],
    stopDevice: async (serial, pending, timeoutMs, automation) => { stoppedClaim = automation; return { ok: true }; } });
  assert.deepEqual(stoppedClaim, claim);
  assert.equal(result.ok, true);
  assert.equal(require('../bin/executors/automation-owner').owner('phone', directory), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.automationArchivePath)), claim);
});

test('reset control excludes new admission, reconciliation and acknowledgements', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-force-control-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = require('../bin/shared-kernel/device-ownership-store').createOwnershipStore(directory);
  const control = store.controlLock('phone');
  try {
    const lease = createDeviceMutationLease({ directory });
    assert.equal(lease.acquire('phone').error, 'target_busy');
    assert.equal((await lease.reconcile('phone', () => { throw new Error('must not verify during reset'); })).error, 'target_busy');
    assert.equal((await lease.drainAcknowledgements('phone', () => { throw new Error('must not acknowledge during reset'); })).error, 'target_busy');
  } finally { control.close(); }
});

test('corrupt task journals cannot permanently prevent an explicit forced reset', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-force-corrupt-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = require('../bin/shared-kernel/device-ownership-store').createOwnershipStore(directory);
  const bytes = Buffer.from('{broken interrupted record');
  fs.writeFileSync(store.paths('phone').journal, bytes);
  assert.throws(() => store.read('phone'), { code: 'device_ownership_corrupt' });
  const { forceStopDevice } = require('../bin/shared-kernel/device-force-stop');
  const result = await forceStopDevice({ serial: 'phone' }, { directory, stopHost: async () => [],
    stopDevice: async () => ({ ok: true }) });
  assert.equal(result.ok, true);
  assert.equal(result.journalError, 'device_ownership_corrupt');
  assert.deepEqual(fs.readFileSync(result.archivePath), bytes);
  const next = createDeviceMutationLease({ directory }).acquire('phone');
  assert.equal(next.ok, true); next.release();
});

test('occupancy failures give agents exact force-stop arguments', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-force-hint-'));
  try {
    const owner = createDeviceMutationLease({ directory }).acquire('phone');
    try {
      const rejected = createDeviceMutationLease({ directory }).acquire('phone');
      assert.equal(rejected.error, 'target_busy');
      assert.deepEqual(rejected.recoveryHint.arguments, { operation: 'force-stop', serial: 'phone' });
    } finally { owner.release(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('reset releases an unknown action without claiming its original outcome', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-force-stop-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lease = createDeviceMutationLease({ directory });
  await lease.run('phone', () => runDeviceEffect({ kind: 'native', actionId: 'lost-receipt', runtimeEpoch: 'old-epoch' },
    async () => ({ ok: false, settled: false, dispatched: null, ambiguous: true })));
  assert.deepEqual(lease.status('phone').recoveryHint.arguments, { operation: 'force-stop', serial: 'phone' });
  const { forceStopDevice } = require('../bin/shared-kernel/device-force-stop');
  const reset = await forceStopDevice({ serial: 'phone' }, { directory, stopHost: async () => [],
    stopDevice: async () => ({ ok: true, stopped: true }) });
  assert.equal(reset.ok, true);
  assert.equal(reset.phase, 'idle');
  assert.equal(reset.abandoned[0].actionId, 'lost-receipt');
  assert.equal(reset.outcome, 'unknown');
  assert.equal(reset.executionReceipt, undefined);
  assert.equal(fs.existsSync(reset.archivePath), true);
  const otherAgent = createDeviceMutationLease({ directory });
  const next = otherAgent.acquire('phone');
  assert.equal(next.ok, true); next.release();
});

test('reset terminates a live Host owner and admits a different process', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-force-live-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const child = fork(path.join(__dirname, '../test-support/device-ownership-child.js'), [directory, 'phone', 'effect'],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  const { forceStopDevice } = require('../bin/shared-kernel/device-force-stop');
  const reset = await forceStopDevice({ serial: 'phone' }, { directory,
    stopDevice: async () => ({ ok: true, stopped: true }), runtimeEndpoint: null });
  assert.equal(reset.ok, true);
  await exited;
  assert.equal(child.signalCode, 'SIGKILL');
  const next = createDeviceMutationLease({ directory }).acquire('phone');
  assert.equal(next.ok, true); next.release();
});

test('a reused PID does not block reset or terminate its unrelated replacement', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-force-reused-pid-'));
  const child = fork(path.join(__dirname, '../test-support/device-ownership-child.js'), [directory, 'phone', 'hold'],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { child.kill('SIGKILL'); await exited; fs.rmSync(directory, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  const stopped = await require('../bin/shared-kernel/host-process-stop').stopHosts({ pid: child.pid, processStart: 'previous process' }, null);
  assert.deepEqual(stopped, []);
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  process.kill(child.pid, 0);
});

test('an offline phone cannot keep local occupancy; reset can be retried after reconnect', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-force-offline-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lease = createDeviceMutationLease({ directory });
  await lease.run('phone', () => runDeviceEffect({ kind: 'native', actionId: 'offline', target: { adb: '/original/adb' } },
    async () => ({ ok: false, settled: false, ambiguous: true })));
  const { forceStopDevice } = require('../bin/shared-kernel/device-force-stop');
  const offline = await forceStopDevice({ serial: 'phone' }, { directory, stopHost: async () => [],
    stopDevice: async () => { throw Object.assign(new Error('Disconnected'), { code: 'device_offline' }); } });
  assert.equal(offline.ownershipReleased, true);
  assert.equal(offline.remoteResetPending, true);
  assert.equal(lease.status('phone').active, 0);
  assert.equal(lease.acquire('phone').error, 'device_reset_required');
  assert.match(lease.acquire('phone').message, /Reconnect/);
  let original;
  const connected = await forceStopDevice({ serial: 'phone' }, { directory, stopHost: async () => [],
    stopDevice: async (serial, pending) => { original = pending[0].target.adb; return { ok: true }; } });
  assert.equal(original, '/original/adb');
  assert.equal(connected.ok, true);
  const next = lease.acquire('phone'); assert.equal(next.ok, true); next.release();
});

test('ADB process exit codes do not replace the public machine-readable reset error', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-force-adb-error-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { forceStopDevice } = require('../bin/shared-kernel/device-force-stop');
  const result = await forceStopDevice({ serial: 'phone' }, { directory, stopHost: async () => [],
    stopDevice: async () => { throw Object.assign(new Error('Reset subprocess failed'), { code: 2 }); } });
  assert.equal(result.error, 'force_stop_device_failed');
  assert.equal(result.ownershipReleased, true);
  assert.equal(result.remoteResetPending, true);
  assert.equal(result.remoteError.message, 'Reset subprocess failed');
});
