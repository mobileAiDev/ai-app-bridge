'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { schema, executeAndroidShell, createAndroidShellPort, settlementProof, terminalReceipt } = require('../bin/shared-kernel/android-shell-execution');
const { createDeviceMutationLease } = require('../bin/shared-kernel/device-mutation-lease');
const { deviceOwnership } = require('../bin/shared-kernel/device-ownership-recovery');
const { CommandError, commandFailure } = require('../bin/command-errors');
const { runExecution } = require('../bin/shared-kernel/execution-scope');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-shell-execution-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lease = createDeviceMutationLease({ directory });
  const identity = { schemaVersion: schema, actionId: 'call:action', jobId: randomUUID(), runtimeEpoch: randomUUID(),
    commandSha256: '1'.repeat(64), deadlineUptimeMs: 12345678 };
  const receipt = { ...identity, ok: true, settled: true, dispatched: true, ambiguous: false, exitCode: 0 };
  const calls = [];
  const port = {
    async prepare() { calls.push('prepare'); return identity; },
    async start(request) {
      calls.push('start');
      assert.equal(lease.status('phone').ownership.pending.jobId, request.jobId, 'identity must be durable before dispatch');
      return { ok: true, submitted: true };
    },
    async query() { calls.push('query'); return receipt; },
    async cancel() { calls.push('cancel'); return receipt; },
    async output() { calls.push('output'); return { stdout: 'done', stderr: '' }; },
    async acknowledge(_identity, result) {
      calls.push('acknowledge');
      const state = createDeviceMutationLease({ directory }).status('phone').ownership;
      assert.equal(state.pending, null);
      assert.deepEqual(state.lastSettlement.proof, result.executionReceipt, 'phone cleanup requires fsynced Host proof');
      return { ok: true, acknowledged: true };
    },
  };
  const execute = () => lease.run('phone', () => executeAndroidShell({ adb: 'adb', serial: 'phone', argv: ['input', 'keyevent', '4'], port, timeoutMs: 1000 }));
  return { directory, lease, identity, receipt, port, calls, execute };
}

test('one matching receipt is persisted before acknowledgement, with the unchanged wire digest', async t => {
  const f = fixture(t);
  const result = await f.execute();
  assert.equal(result.stdout, 'done');
  assert.equal(result.executionReceipt.responseSha256, createHash('sha256').update(JSON.stringify(f.receipt)).digest('hex'));
  assert.deepEqual(settlementProof({ ...f.receipt, executionReceipt: result.executionReceipt }, f.identity), result.executionReceipt);
  assert.deepEqual(f.calls, ['prepare', 'start', 'query', 'output', 'acknowledge']);
  assert.equal(f.lease.status('phone').active, 0);
});

test('a failed command is settled and its completion proof survives public error normalization', async t => {
  const f = fixture(t);
  f.receipt.exitCode = 7;
  f.port.output = async () => ({ stdout: '', stderr: 'command rejected' });
  await assert.rejects(f.execute(), error => {
    const result = commandFailure(error, 'keyevent');
    assert.equal(result.error, 'adb_command_failed');
    assert.equal(result.settled, true); assert.equal(result.exitCode, 7);
    assert.equal(result.executionReceipt.jobId, f.identity.jobId);
    return true;
  });
  assert.equal(f.lease.status('phone').active, 0);
});

test('losing output does not discard an already verified completion or acknowledge unread output', async t => {
  const f = fixture(t);
  f.port.output = async () => { throw new Error('disconnected'); };
  await assert.rejects(f.execute(), error => error.code === 'shell_output_unavailable' && error.settled && error.executionReceipt.jobId === f.identity.jobId);
  assert.equal(f.lease.status('phone').active, 0);
  assert.equal(f.calls.includes('acknowledge'), false);
});

test('an unknown response keeps its original durable identity; recovery cannot replay or substitute the job', async t => {
  const f = fixture(t);
  f.port.query = async () => { throw new Error('response lost'); };
  let completion = { ok: true, settled: false };
  f.port.cancel = async () => completion;
  await assert.rejects(f.execute(), error => error.settled === false && error.ambiguous && error.dispatched === null);
  const fresh = createDeviceMutationLease({ directory: f.directory });
  assert.equal(fresh.acquire('phone').error, 'device_ownership_unresolved');
  const reconcile = () => deviceOwnership({ operation: 'reconcile', serial: 'phone' }, {
    lease: fresh, shellPortFactory: target => { assert.equal(target.serial, 'phone'); return f.port; },
  });
  assert.equal((await reconcile()).error, 'device_ownership_unresolved');
  completion = { ...f.receipt, jobId: randomUUID() };
  assert.equal((await reconcile()).error, 'device_ownership_unresolved');
  completion = f.receipt;
  const recovered = await reconcile();
  assert.equal(recovered.recovered, true);
  assert.deepEqual(recovered.executionReceipt, settlementProof(f.receipt, f.identity));
  assert.equal(f.calls.filter(c => c === 'start').length, 1);
  assert.equal(fresh.status('phone').active, 0);
});

test('cancellation keeps the original failure while an admission fence proves no command was sent', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  f.port.start = async () => { controller.abort({ code: 'cancelled' }); return { ok: true, submitted: true }; };
  Object.assign(f.receipt, { ok: false, error: 'shell_action_cancelled', dispatched: false, exitCode: null });
  await assert.rejects(runExecution({ signal: controller.signal }, f.execute), error => {
    assert.equal(error.code, 'cancelled'); assert.equal(error.dispatched, false);
    assert.equal(error.ambiguous, false); assert.equal(error.settled, true);
    return true;
  });
  assert.equal(f.lease.status('phone').active, 0);
});

test('failure before preparing a job leaves no fictitious remote action to reconcile', async t => {
  const f = fixture(t);
  f.port.prepare = async () => { throw new CommandError('shell_execution_store_full', 'Device receipt storage is full.'); };
  await assert.rejects(f.execute(), { code: 'shell_execution_store_full', dispatched: false });
  assert.equal(f.lease.status('phone').active, 0);
  assert.equal(f.calls.includes('start'), false);
});

test('terminal identity and exit metadata are strict, and argument limits reject before launch', async t => {
  const f = fixture(t);
  for (const changed of [{ runtimeEpoch: randomUUID() }, { actionId: 'another' }, { commandSha256: '2'.repeat(64) },
    { deadlineUptimeMs: 1 }, { exitCode: null }, { exitCode: 256 }, { ambiguous: true }, { settled: false }]) {
    assert.equal(terminalReceipt({ ...f.receipt, ...changed }, f.identity), false);
  }
  let calls = 0;
  const port = createAndroidShellPort({ adb: 'adb', serial: 'phone', run: async () => {
    calls++; return { stdout: JSON.stringify({ runtimeEpoch: randomUUID(), uptimeMs: 123 }) };
  } });
  for (const argv of [[], [''], ['printf', 'x\0y']]) await assert.rejects(port.prepare(argv), { code: 'invalid_shell_arguments' });
  assert.equal(calls, 0);
  await assert.rejects(port.prepare(['printf', 'x'.repeat(65536)]), { code: 'shell_arguments_too_large' });
  assert.equal(calls, 1, 'only the runtime probe ran; no job was staged');
});
