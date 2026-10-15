'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, fork } = require('node:child_process');
const { createDeviceMutationLease, runDeviceEffect } = require('../bin/shared-kernel/device-mutation-lease');
const { deviceOwnership } = require('../bin/shared-kernel/device-ownership-recovery');
const { schema } = require('../bin/shared-kernel/flutter-execution');
const { commandSchema, validateCommandArguments } = require('../bin/command-registry');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-ownership-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, lease: createDeviceMutationLease({ directory }) };
}

function denyNewFiles(directory) {
  if (process.platform === 'win32') {
    const icacls = path.join(process.env.SystemRoot, 'System32', 'icacls.exe');
    // Deny FILE_ADD_FILE on this directory only, without changing its children's ACLs.
    execFileSync(icacls, [directory, '/deny', '*S-1-1-0:(WD)']);
    return () => execFileSync(icacls, [directory, '/remove:d', '*S-1-1-0']);
  }
  const mode = fs.statSync(directory).mode & 0o777;
  fs.chmodSync(directory, mode & ~0o222);
  return () => fs.chmodSync(directory, mode);
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
  assert.equal(replies.filter(r => r.ok).length, 1, JSON.stringify(replies));
  assert(replies.filter(r => !r.ok).every(r => r.error === 'target_busy'));
  const other = lease.acquire('different-phone'); assert.equal(other.ok, true); other.release();
  const winner = children[replies.findIndex(r => r.ok)]; winner.proc.send('release'); await winner.closed;
  const after = lease.acquire('same-phone'); assert.equal(after.ok, true); after.release();
});

test('SQLite readers of the lock file do not masquerade as a device owner', t => {
  const { DatabaseSync } = require('node:sqlite');
  const { createOwnershipStore } = require('../bin/shared-kernel/device-ownership-store');
  const { directory, lease } = fixture(t), store = createOwnershipStore(directory);
  const reader = new DatabaseSync(store.paths('observed-phone').lock);
  try {
    reader.exec('BEGIN; SELECT * FROM sqlite_schema');
    const owner = lease.acquire('observed-phone');
    assert.equal(owner.ok, true, JSON.stringify(owner));
    try {
      assert.equal(createDeviceMutationLease({ directory }).acquire('observed-phone').error, 'target_busy');
    } finally { owner.release(); reader.exec('ROLLBACK'); }
  } finally { reader.close(); }
});

test('device ownership remains exclusive with the previous SQLite lock mode', t => {
  const { DatabaseSync } = require('node:sqlite');
  const { createOwnershipStore } = require('../bin/shared-kernel/device-ownership-store');
  const { directory, lease } = fixture(t), store = createOwnershipStore(directory);
  const previous = new DatabaseSync(store.paths('mixed-version-phone').lock);
  try {
    previous.exec('BEGIN EXCLUSIVE');
    assert.equal(lease.acquire('mixed-version-phone').error, 'target_busy');
    previous.exec('ROLLBACK');
    const owner = lease.acquire('mixed-version-phone');
    assert.equal(owner.ok, true);
    try { assert.throws(() => previous.exec('BEGIN EXCLUSIVE'), error => error.errcode === 5); }
    finally { owner.release(); }
    previous.exec('BEGIN EXCLUSIVE; ROLLBACK');
  } finally { previous.close(); }
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
  const busy = reader.status('in-flight');
  assert.equal(busy.unresolved, true);
  assert.equal(busy.ownership.pending.actionId, 'child-action');
  assert.equal(reader.status('in-flight').phase, 'unresolved');
  const unknown = await reader.reconcile('in-flight', async () => ({ settled: false, error: 'response_lost' }));
  assert.equal(unknown.error, 'device_ownership_unresolved');
  const recovered = await reader.reconcile('in-flight', async pending => ({ settled: pending.actionId === 'child-action', actionId: pending.actionId }));
  assert.equal(recovered.recovered, true);
  const next = createDeviceMutationLease({ directory }).acquire('in-flight'); assert.equal(next.ok, true); next.release();
});

test('unknown managed settlement is preserved while later explicit mutations run', async t => {
  const { directory, lease } = fixture(t);
  let effects = 0;
  const result = await lease.run('pending', async () => {
    const outcome = await runDeviceEffect({ kind: 'flutter', actionId: 'action', runtimeEpoch: 'epoch' }, async () => ({ ok: false, settled: false, ambiguous: true, dispatched: null }));
    await lease.run('pending', () => { effects++; return { ok: true }; });
    return outcome;
  });
  assert.equal(result.settled, false);
  assert.equal((await createDeviceMutationLease({ directory }).run('pending', () => { effects++; return { ok: true }; })).ok, true);
  assert.equal(effects, 2);
  assert.equal(JSON.parse(fs.readFileSync(result.warnings[0].archivePath)).pending.actionId, 'action');
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
  assert.equal(blocked.ok, true); assert.equal(dispatched, true);
  assert.equal(JSON.parse(fs.readFileSync(blocked.warnings[0].archivePath)).pending.path, '/v1/h5/eval');
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

test('corrupt journal bytes are archived, but inaccessible files still fail before action', async t => {
  const { directory, lease } = fixture(t);
  let actions = 0;
  const held = lease.acquire('phone'); held.release();
  const journal = path.join(directory, fs.readdirSync(directory).find(n => n.endsWith('.json')));
  fs.writeFileSync(journal, '{broken');
  const continued = await lease.run('phone', () => { actions++; return { ok: true }; });
  assert.equal(fs.readFileSync(continued.warnings[0].archivePath, 'utf8'), '{broken');
  fs.rmSync(journal); fs.mkdirSync(journal);
  await assert.rejects(lease.run('phone', () => { actions++; }));
  assert.equal(actions, 1);
});

test('unwritable ownership metadata prevents dispatch', async t => {
  const { createOwnershipStore } = require('../bin/shared-kernel/device-ownership-store');
  const { directory, lease } = fixture(t);
  const owner = lease.acquire('phone'); owner.release();
  const journal = createOwnershipStore(directory).paths('phone').journal;
  const original = fs.readFileSync(journal);
  const restore = denyNewFiles(directory);
  let actions = 0;
  try {
    assert.throws(
      () => fs.writeFileSync(path.join(directory, 'permission-probe'), '', { flag: 'wx' }),
      error => ['EACCES', 'EPERM'].includes(error.code),
      'the fixture must really deny creation before testing dispatch',
    );
    await assert.rejects(lease.run('phone', () => { actions++; }), {
      code: 'device_ownership_unavailable',
      dispatched: false,
    });
    assert.deepEqual(fs.readFileSync(journal), original);
  } finally { restore(); }
  assert.equal(actions, 0);
  await lease.run('phone', () => { actions++; });
  assert.equal(actions, 1, 'a failed metadata write must release both ownership locks');
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

test('normal reconcile forbids implicit force, target substitution and ownership path arguments', () => {
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
  assert.equal(createDeviceMutationLease({ directory }).status('installer').unresolved, true);
  await assert.rejects(Promise.resolve().then(() => installation.settle({ settled: true })), { code: 'device_ownership_lost' });
});
