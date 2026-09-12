'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createDeviceMutationLease, runDeviceEffect } = require('../bin/shared-kernel/device-mutation-lease');
const { deviceOwnership } = require('../bin/shared-kernel/device-ownership-recovery');
const { schema } = require('../bin/shared-kernel/flutter-execution');
const { commandSchema, validateCommandArguments } = require('../bin/command-registry');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-ownership-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, lease: createDeviceMutationLease({ directory }) };
}

function child(directory, serial, mode = 'idle') {
  const proc = fork(path.join(__dirname, '../test-support/device-ownership-child.js'), [directory, serial, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const closed = new Promise(resolve => proc.once('exit', (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.once('message', resolve);
    proc.once('error', reject);
    proc.once('exit', () => reject(new Error(`Child exited before readiness: ${stderr}`)));
  });
  return { proc, ready, closed, async stop() { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); await closed; } };
}

test('independent managers contend by physical serial and preserve reentrant ownership', async t => {
  const { directory, lease } = fixture(t);
  const other = createDeviceMutationLease({ directory });
  const held = lease.acquire('phone');
  assert.equal(other.acquire('phone').error, 'target_busy');
  const separate = other.acquire('second-phone'); assert.equal(separate.ok, true); separate.release();
  assert.equal(await held.run(() => other.run('phone', async () => ({ ok: true }))).then(x => x.ok), true);
  assert.equal(other.acquire('phone').error, 'target_busy');
  held.release();
  const next = other.acquire('phone'); assert.equal(next.ok, true); next.release();
});

test('simultaneous OS processes admit exactly one owner and allow another serial', async t => {
  const { directory, lease } = fixture(t);
  const children = Array.from({ length: 5 }, () => child(directory, 'same-phone'));
  t.after(async () => { await Promise.all(children.map(c => c.stop())); });
  const replies = await Promise.all(children.map(c => c.ready));
  assert.equal(replies.filter(r => r.ok).length, 1);
  assert(replies.filter(r => !r.ok).every(r => r.error === 'target_busy'));
  const other = lease.acquire('different-phone'); assert.equal(other.ok, true); other.release();
  const winner = children[replies.findIndex(r => r.ok)]; winner.proc.send('release'); await winner.closed;
  const after = lease.acquire('same-phone'); assert.equal(after.ok, true); after.release();
});

test('process death releases an idle owner without PID guesses or expiry', async t => {
  const { directory, lease } = fixture(t);
  const writer = child(directory, 'idle-phone'); t.after(() => writer.stop());
  assert((await writer.ready).ok);
  assert.equal(lease.status('idle-phone').phase, 'owned');
  await writer.stop();
  const next = lease.acquire('idle-phone'); assert.equal(next.ok, true); next.release();
});

test('SIGKILL during dispatch keeps a durable unresolved action across fresh managers', async t => {
  const { directory } = fixture(t);
  const writer = child(directory, 'in-flight', 'effect'); t.after(() => writer.stop());
  assert((await writer.ready).ok); await writer.stop();
  const reader = createDeviceMutationLease({ directory });
  const busy = reader.acquire('in-flight');
  assert.equal(busy.error, 'device_ownership_unresolved');
  assert.equal(busy.ownership.pending.actionId, 'child-action');
  assert.equal(reader.status('in-flight').phase, 'unresolved');
  const unknown = await reader.reconcile('in-flight', async () => ({ settled: false, error: 'response_lost' }));
  assert.equal(unknown.error, 'device_ownership_unresolved');
  const recovered = await reader.reconcile('in-flight', async pending => ({ settled: pending.actionId === 'child-action', actionId: pending.actionId }));
  assert.equal(recovered.recovered, true);
  const next = createDeviceMutationLease({ directory }).acquire('in-flight'); assert.equal(next.ok, true); next.release();
});

test('unknown managed settlement prevents both nested and later mutations', async t => {
  const { directory, lease } = fixture(t);
  let effects = 0;
  const result = await lease.run('pending', async () => {
    const outcome = await runDeviceEffect({ kind: 'flutter', actionId: 'action', runtimeEpoch: 'epoch' }, async () => ({ ok: false, settled: false, ambiguous: true, dispatched: null }));
    const nested = await lease.run('pending', () => { effects++; });
    assert.equal(nested.error, 'device_ownership_unresolved');
    return outcome;
  });
  assert.equal(result.settled, false);
  assert.equal((await createDeviceMutationLease({ directory }).run('pending', () => { effects++; })).error, 'device_ownership_unresolved');
  assert.equal(effects, 0);
});

test('verified settlement survives wrappers and cancel transport retains original identity', async t => {
  const { lease } = fixture(t);
  await lease.run('known', async () => runDeviceEffect({ kind: 'flutter', actionId: 'original', runtimeEpoch: 'epoch' }, async () => {
    await runDeviceEffect({ kind: 'http-cancel' }, async () => {
      assert.equal(lease.status('known').ownership.pending.actionId, 'original');
      return { ok: true };
    });
    return { ok: false, settled: true, dispatched: true, ambiguous: false };
  }));
  assert.equal(lease.status('known').active, 0);
  assert.equal(lease.status('known').ownership.lastSettlement.proof.actionId, 'original');
});

test('an untyped SDK error cannot release a possibly queued remote mutation', async t => {
  const { directory, lease } = fixture(t);
  const result = await lease.run('h5-phone', () => runDeviceEffect({ kind: 'sdk-http', path: '/v1/h5/eval' },
    async () => ({ ok: false, error: 'h5_eval_timeout' })));
  assert.equal(result.error, 'h5_eval_timeout');
  const fresh = createDeviceMutationLease({ directory });
  assert.equal(fresh.status('h5-phone').ownership.pending.path, '/v1/h5/eval');
  let dispatched = false;
  const blocked = await fresh.run('h5-phone', () => { dispatched = true; return { ok: true }; });
  assert.equal(blocked.error, 'device_ownership_unresolved'); assert.equal(dispatched, false);
});

test('an active owner cannot be reconciled and stale tokens cannot remove a new owner', async t => {
  const { directory, lease } = fixture(t);
  const token = lease.acquire('phone');
  assert.equal((await createDeviceMutationLease({ directory }).reconcile('phone', () => { throw new Error('must not verify'); })).error, 'target_busy');
  token.release();
  const next = lease.acquire('phone');
  token.release();
  await assert.rejects(token.run(async () => {}), { code: 'device_ownership_lost' });
  assert.equal(createDeviceMutationLease({ directory }).acquire('phone').error, 'target_busy');
  next.release();
});

test('corrupt journals reject before action', async t => {
  const { directory, lease } = fixture(t);
  let actions = 0;
  const held = lease.acquire('phone'); held.release();
  const journal = path.join(directory, fs.readdirSync(directory).find(n => n.endsWith('.json')));
  fs.writeFileSync(journal, '{broken');
  await assert.rejects(lease.run('phone', () => { actions++; }), { code: 'device_ownership_corrupt' });
  fs.rmSync(journal); fs.mkdirSync(journal);
  await assert.rejects(lease.run('phone', () => { actions++; }), { code: 'device_ownership_corrupt' });
  assert.equal(actions, 0);
});

test('unwritable ownership metadata prevents dispatch', async t => {
  const { directory, lease } = fixture(t);
  const owner = lease.acquire('phone'); owner.release();
  fs.chmodSync(directory, 0o500);
  let actions = 0;
  try { await assert.rejects(lease.run('phone', () => { actions++; }), { code: 'device_ownership_unavailable' }); }
  finally { fs.chmodSync(directory, 0o700); }
  assert.equal(actions, 0);
});

test('public recovery verifies matching SDK completion and never treats idle or wrong identity as settlement', async t => {
  const { directory, lease } = fixture(t);
  const identity = { actionId: 'recovery-action', runtimeEpoch: 'original-epoch' };
  await lease.run('phone', () => runDeviceEffect({ kind: 'flutter', ...identity, target: { packageName: 'example.original', adb: 'adb' } },
    async () => ({ ok: false, dispatched: null, ambiguous: true, settled: false })));
  const requests = [];
  let reply = { ok: false, error: 'flutter_action_not_active' };
  const ports = { createBridgeContext: value => value,
    flutterCompletion: async (ctx, body) => { requests.push({ ctx, route: '/v1/flutter/cancel', body }); return reply; } };
  let result = await deviceOwnership({ operation: 'reconcile', serial: 'phone' }, { lease, ports });
  assert.equal(result.error, 'device_ownership_unresolved');
  const sdk = { ok: false, error: 'flutter_action_cancelled', dispatched: true, ambiguous: false, settled: true,
    ...identity, execution: { schemaVersion: schema, ...identity, settled: true } };
  reply = { ok: true, ...identity, executionResult: { ...sdk, actionId: 'wrong-action' } };
  assert.equal((await deviceOwnership({ operation: 'reconcile', serial: 'phone' }, { lease, ports })).error, 'device_ownership_unresolved');
  reply.executionResult = sdk;
  result = await deviceOwnership({ operation: 'reconcile', serial: 'phone' }, { lease, ports });
  assert.equal(result.recovered, true);
  assert.deepEqual(result.settlement.proof.execution, sdk.execution);
  assert.equal(requests.filter(r => r.body).length, 3);
  assert(requests.filter(r => r.body).every(r => r.route === '/v1/flutter/cancel' && r.body.actionId === identity.actionId && r.ctx.packageName === 'example.original'));
  assert.equal(createDeviceMutationLease({ directory }).status('phone').active, 0);
});

test('recovery has a strict public contract with no force, target substitution or ownership path argument', () => {
  assert.deepEqual(commandSchema('device-ownership').required, ['operation', 'serial']);
  assert.throws(() => validateCommandArguments('device-ownership', { serial: 'phone', operation: 'release' }), { code: 'invalid_argument' });
  for (const name of ['force', 'packageName', 'directory', 'adb']) {
    assert.throws(() => validateCommandArguments('device-ownership', { serial: 'phone', operation: 'reconcile', [name]: 'replacement' }), { code: 'unsupported_argument' });
  }
});

test('a long-lived install reservation survives nested UI calls and owner release until its own completion', async t => {
  const { directory, lease } = fixture(t);
  const owner = lease.acquire('installer');
  const installation = owner.retain({ kind: 'install', actionId: 'install:job' });
  assert.equal((await owner.run(() => runDeviceEffect({ kind: 'adb' }, async () => ({ ok: true })))).ok, true);
  assert.equal(lease.status('installer').ownership.reservations.length, 1);
  installation.settle({ settled: false });
  owner.release();
  assert.equal(createDeviceMutationLease({ directory }).acquire('installer').error, 'device_ownership_unresolved');
  await assert.rejects(Promise.resolve().then(() => installation.settle({ settled: true })), { code: 'device_ownership_lost' });
});
