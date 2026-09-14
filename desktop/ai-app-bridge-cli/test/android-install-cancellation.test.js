'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { promisify } = require('node:util');
const execute = promisify(require('node:child_process').execFile);
const { identityFor } = require('../test-support/android-install-fixture');
const { createInstallCancellationPort, cancellationProof } = require('../bin/shared-kernel/android-install-cancellation');
const { createDeviceMutationLease } = require('../bin/shared-kernel/device-mutation-lease');
const { deviceOwnership } = require('../bin/shared-kernel/device-ownership-recovery');
const { validateCommandArguments, isMutationCommand, isAndroidMutation } = require('../bin/command-registry');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

test('cancel-install is an explicit mutation with an original actionId and its own reconciliation lock', () => {
  const args = { operation: 'cancel-install', serial: 'phone', actionId: 'original' };
  assert.doesNotThrow(() => validateCommandArguments('device-ownership', args));
  assert.throws(() => validateCommandArguments('device-ownership', { operation: 'cancel-install', serial: 'phone' }));
  assert.equal(isMutationCommand('device-ownership', args), true);
  assert.equal(isAndroidMutation('device-ownership', args), false, 'Reconciliation must acquire its own lock around the retained original');
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'install-cancel-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const identity = identityFor({ packageName: 'example.app', sha256: 'a'.repeat(64), bytes: 128 }, 'original');
  const install = path.join(directory, 'ai-app-bridge-install/v1', identity.installId);
  fs.mkdirSync(install, { recursive: true }); fs.writeFileSync(path.join(install, 'session'), '42');
  fs.writeFileSync(path.join(directory, 'boot'), identity.runtimeEpoch);
  const run = (_adb, argv) => execute('/bin/sh', ['-c', argv.at(-1).slice(1, -1).replaceAll("'\\''", "'")
    .replaceAll('/data/local/tmp', directory).replaceAll('/proc/sys/kernel/random/boot_id', path.join(directory, 'boot'))]);
  let prepares = 0, effects = 0, lost = false, expire = false, output = 'Success\n';
  const jobs = new Map();
  const shellPort = {
    async prepare(argv, actionId) {
      prepares++; assert.deepEqual(argv, ['pm', 'install-abandon', '42']);
      const child = { schemaVersion: 'aab.android-shell-execution/v1', actionId, jobId: randomUUID(),
        runtimeEpoch: identity.runtimeEpoch, deadlineUptimeMs: 12345,
        commandSha256: createHash('sha256').update(`exec ${argv.map(quote).join(' ')}\n`).digest('hex') };
      jobs.set(child.jobId, { child, started: false }); return child;
    },
    async start(child) {
      assert.ok(fs.existsSync(path.join(install, 'abandon.json')), 'Save the original cancellation identity before dispatch');
      const job = jobs.get(child.jobId);
      if (job.started) return { ok: false, error: 'shell_action_id_reused' };
      job.started = true;
      if (expire) { expire = false; job.expired = true; return { ok: true, submitted: true }; }
      effects++;
      if (lost) throw new Error('lost original response');
      return { ok: true, submitted: true };
    },
    async query(child) {
      if (jobs.get(child.jobId)?.expired) return { ...child, ok: false, error: 'shell_action_timeout', settled: true, dispatched: false, ambiguous: false, exitCode: null };
      return jobs.get(child.jobId)?.started ? { ...child, ok: true, settled: true, dispatched: true, ambiguous: false, exitCode: 0 }
        : { ok: true, settled: false };
    },
    async output() { return { stdout: output, stderr: '' }; },
  };
  const port = () => createInstallCancellationPort({ serial: 'phone', run, shellPort, timeoutMs: 1000 });
  return { identity, directory, install, port, expireOnce: () => { expire = true; }, setLost: value => { lost = value; }, setOutput: value => { output = value; },
    get counts() { return { prepares, effects }; } };
}

test('lost original commit callback can be settled by abandoning exactly its saved PM session', async t => {
  const f = fixture(t), result = await f.port().cancel(f.identity);
  const proof = cancellationProof(result, f.identity);
  assert.equal(proof.phase, 'session-abandoned'); assert.equal(proof.sessionId, 42);
  assert.equal(proof.requestSucceeded, null, 'Cancellation is not proof of installation failure or rollback');
  assert.deepEqual(f.counts, { prepares: 1, effects: 1 });
  for (const changed of [{ actionId: 'wrong' }, { runtimeEpoch: randomUUID() }, { installId: randomUUID() }]) {
    assert.equal(cancellationProof(result, { ...f.identity, ...changed }), null);
  }
  assert.equal(cancellationProof({ ...result, output: { stdout: 'Success\nunknown', stderr: '' } }, f.identity), null);
});

test('a restarted Host reads the saved cancellation receipt without replaying PM or allocating a new job', async t => {
  const f = fixture(t); f.setLost(true);
  await assert.rejects(f.port().cancel(f.identity), /lost original response/);
  const recovered = await f.port().read(f.identity);
  assert.equal(cancellationProof(recovered, f.identity).settled, true);
  const retried = await f.port().cancel(f.identity);
  assert.equal(cancellationProof(retried, f.identity).settled, true);
  assert.deepEqual(f.counts, { prepares: 1, effects: 1 });
});

test('an explicitly retried cancellation may replace a job proven never dispatched', async t => {
  const f = fixture(t); f.expireOnce();
  assert.equal(cancellationProof(await f.port().cancel(f.identity), f.identity), null);
  const result = await f.port().cancel(f.identity);
  assert.equal(cancellationProof(result, f.identity).settled, true);
  assert.equal(result.mapping.previous.receipt.dispatched, false);
  assert.deepEqual(f.counts, { prepares: 2, effects: 1 });
});

test('changed boot or cancellation mapping fails before dispatch and nonfinal PM output remains unresolved', async t => {
  const f = fixture(t); f.setOutput('Failure [null]');
  const result = await f.port().cancel(f.identity);
  assert.equal(cancellationProof(result, f.identity), null);
  fs.writeFileSync(path.join(f.install, 'abandon.json'), JSON.stringify({ ...result.mapping, sessionId: 99 }));
  await assert.rejects(f.port().cancel(f.identity), { code: 'invalid_install_cancellation_identity' });
  fs.writeFileSync(path.join(f.directory, 'boot'), randomUUID());
  await assert.rejects(f.port().cancel(f.identity), { code: 'shell_runtime_changed' });
  assert.deepEqual(f.counts, { prepares: 1, effects: 1 });
});

test('public recovery requires the selected original action and persists cancellation proof before cleanup', async t => {
  const f = fixture(t), lease = createDeviceMutationLease({ directory: path.join(f.directory, 'ownership') });
  const owner = lease.acquire('phone'); owner.retain(f.identity); owner.release();
  const port = { read: async () => ({ shellReceipt: { ok: true, settled: false } }),
    readCancellation: identity => f.port().read(identity), cancelInstall: identity => f.port().cancel(identity),
    acknowledgeCancellation: async (_identity, result) => {
      assert.equal(lease.status('phone').phase, 'idle');
      assert.deepEqual(lease.status('phone').ownership.lastSettlement.proof, cancellationProof(result, f.identity));
    } };
  const options = { lease, installPortFactory: () => port };
  assert.equal((await deviceOwnership({ operation: 'reconcile', serial: 'phone' }, options)).error, 'device_ownership_unresolved');
  const wrong = await deviceOwnership({ operation: 'cancel-install', serial: 'phone', actionId: 'wrong' }, options);
  assert.equal(wrong.recovery.error, 'install_action_mismatch'); assert.equal(f.counts.effects, 0);
  const recovered = await deviceOwnership({ operation: 'cancel-install', serial: 'phone', actionId: 'original' }, options);
  assert.equal(recovered.phase, 'idle'); assert.equal(recovered.executionReceipt.phase, 'session-abandoned');
  assert.deepEqual(f.counts, { prepares: 1, effects: 1 });
});
