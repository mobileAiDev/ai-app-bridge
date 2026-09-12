'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { identityFor, resultFor } = require('../test-support/android-install-fixture');
const { settlementProof, prepareInstallJob, createAndroidInstallPort } = require('../bin/shared-kernel/android-install-execution');
const { createDeviceMutationLease } = require('../bin/shared-kernel/device-mutation-lease');
const { deviceOwnership } = require('../bin/shared-kernel/device-ownership-recovery');
const { canonicalJson, checksumOf } = require('../bin/shared-kernel/evidence-schema');

const artifact = { packageName: 'example.test', sha256: 'a'.repeat(64), bytes: 128, path: '/verified.apk' };
function fixture() {
  const identity = identityFor(artifact, 'original');
  let response = resultFor(identity), starts = 0, cancels = 0, reads = 0, acks = 0;
  const port = { prepare: async () => identity, start: async () => { starts++; return { ok: true, submitted: true }; },
    read: async (_id, cancel) => { reads++; if (cancel) cancels++; return response; },
    acknowledge: async () => { acks++; return { ok: true }; } };
  return { identity, port, setResponse: value => { response = value; }, get counts() { return { starts, cancels, reads, acks }; } };
}

test('commit completion is bound to the exact install, job, action, APK, boot and command', () => {
  const f = fixture(), value = resultFor(f.identity), proof = settlementProof(value, f.identity);
  assert.equal(proof.sessionId, 42); assert.equal(proof.requestSucceeded, true); assert.equal(proof.dispatched, true);
  const archived = JSON.parse(canonicalJson(value));
  assert.deepEqual(settlementProof(archived, f.identity), proof, 'Archive key ordering must not invalidate the original proof');
  assert.equal(proof.responseSha256, checksumOf({ shellReceipt: value.shellReceipt, installResult: value.installResult }));
  assert.equal(proof.responseSha256, checksumOf(proof.execution), 'Recovered evidence must carry the independently verifiable original response');
  assert.notEqual(proof.execution.shellReceipt, value.shellReceipt);
  for (const key of ['actionId', 'jobId', 'runtimeEpoch', 'commandSha256', 'deadlineUptimeMs']) {
    const changed = structuredClone(value); changed.shellReceipt[key] = 'wrong';
    assert.equal(settlementProof(changed, f.identity), null, key);
  }
  for (const changed of [{ installId: 'other' }, { apkSha256: 'b'.repeat(64) }, { sessionId: null }, { sessionId: -1 }, { code: 2 }]) {
    assert.equal(settlementProof({ ...value, installResult: { ...value.installResult, ...changed } }, f.identity), null);
  }
  for (const changed of [{ apkBytes: 1 }, { packageName: 'other' }, { allowDowngrade: true }]) {
    assert.equal(settlementProof(value, { ...f.identity, ...changed }), null);
  }
});

test('process exit, generic failure, pending interaction, warnings and truncated output cannot settle installation', () => {
  const f = fixture();
  for (const value of [resultFor(f.identity, { code: 1, stdout: 'Failure [null]' }),
    resultFor(f.identity, { code: 1, stdout: 'Completed with warning(s)' }),
    resultFor(f.identity, { stdout: 'Success\nextra output' }), resultFor(f.identity, { code: 1, stdout: '' }),
    { ...resultFor(f.identity), shellReceipt: { ...resultFor(f.identity).shellReceipt, exitCode: 137 } },
    { ...resultFor(f.identity), installResult: null }]) assert.equal(settlementProof(value, f.identity), null);
});

test('known terminal PM failure is preserved as failure, while precommit failures prove no install commit', () => {
  const f = fixture();
  const failed = settlementProof(resultFor(f.identity, { code: 1, stdout: 'Failure [INSTALL_FAILED_ABORTED: denied]' }), f.identity);
  assert.equal(failed.settled, true); assert.equal(failed.requestSucceeded, false); assert.equal(failed.dispatched, true);
  for (const phase of ['artifact-mismatch', 'create-failed', 'create-invalid', 'write-failed']) {
    const proof = settlementProof(resultFor(f.identity, { code: 1, stdout: 'problem', phase, sessionId: phase === 'write-failed' ? 42 : null }), f.identity);
    assert.equal(proof.settled, true); assert.equal(proof.requestSucceeded, false); assert.equal(proof.dispatched, false);
  }
});

test('job preparation cannot start installation; repeated start still dispatches once and cleanup is explicit', async () => {
  const f = fixture(), job = await prepareInstallJob({ timeoutMs: 1000 }, artifact, 'original', f.port);
  assert.equal(f.counts.starts, 0);
  job.start(); job.start(); const result = await job.done;
  assert.equal(result.executionReceipt.sessionId, 42); assert.equal(f.counts.starts, 1); assert.equal(f.counts.acks, 0);
  await job.acknowledge(result); assert.equal(f.counts.acks, 1);
});

test('cancel before admission dispatches no package operation and preserves the original rejected-admission receipt', async () => {
  const f = fixture();
  f.setResponse({ shellReceipt: { ...resultFor(f.identity).shellReceipt, ok: false, dispatched: false, exitCode: null, error: 'shell_action_cancelled' }, installResult: null });
  const job = await prepareInstallJob({ timeoutMs: 1000 }, artifact, 'original', f.port);
  const result = await job.cancel();
  assert.equal(result.cancelled, true); assert.equal(result.executionReceipt.phase, 'not-admitted');
  assert.equal(result.dispatched, false); assert.equal(f.counts.starts, 0); assert.equal(f.counts.cancels, 1);
});

test('cancel and timeout after admission never manufacture a completion or launch a replacement', async () => {
  for (const cancel of [false, true]) {
    const f = fixture(); f.setResponse({ shellReceipt: { ok: true, settled: false }, installResult: null });
    const job = await prepareInstallJob({ timeoutMs: cancel ? 1000 : 15 }, artifact, 'original', f.port);
    job.start();
    while (!f.counts.reads) await new Promise(resolve => setImmediate(resolve));
    if (cancel) job.cancel();
    const result = await job.done;
    assert.equal(result.settled, false); assert.equal(result.ambiguous, true); assert.equal(result.executionReceipt, null);
    assert.equal(f.counts.starts, 1); assert.equal(f.counts.cancels, 1); assert.equal(f.counts.acks, 0);
  }
});

test('lost submission response may settle only by reading that original job', async () => {
  const f = fixture();
  f.port.start = async () => { throw new Error('response lost after remote admission'); };
  const job = await prepareInstallJob({ timeoutMs: 1000 }, artifact, 'original', f.port);
  const result = await job.start();
  assert.equal(result.requestSucceeded, true); assert.equal(result.executionReceipt.actionId, 'original');
  assert.equal(f.counts.cancels, 1);
});

test('recovery rejects missing and mismatched completion, and fsyncs the original session proof before retiring it', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'install-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lease = createDeviceMutationLease({ directory }), f = fixture();
  const owner = lease.acquire('phone'); owner.retain(f.identity); owner.release();
  const newLease = createDeviceMutationLease({ directory });
  const recover = () => deviceOwnership({ operation: 'reconcile', serial: 'phone' }, { lease: newLease, installPortFactory: () => f.port });
  for (const value of [{ shellReceipt: { ok: true, settled: false }, installResult: null },
    { ...resultFor(f.identity), shellReceipt: { ...resultFor(f.identity).shellReceipt, actionId: 'wrong' } }]) {
    f.setResponse(value); assert.equal((await recover()).error, 'device_ownership_unresolved');
    assert.equal(newLease.acquire('phone').error, 'device_ownership_unresolved'); assert.equal(f.counts.acks, 0);
  }
  const original = resultFor(f.identity); f.setResponse(original);
  f.port.acknowledge = async () => {
    const persisted = createDeviceMutationLease({ directory }).status('phone');
    assert.equal(persisted.active, 0); assert.deepEqual(persisted.ownership.lastSettlement.proof, settlementProof(original, f.identity));
  };
  const recovered = await recover(); assert.equal(recovered.recovered, true); assert.equal(recovered.executionReceipt.sessionId, 42);
  assert.equal(f.counts.starts, 0);
});

test('invalid or incomplete phone JSON cannot be turned into a completion', async () => {
  const f = fixture();
  const port = createAndroidInstallPort({ serial: 'phone', shellPort: { query: async () => resultFor(f.identity).shellReceipt,
    output: async () => ({ stdout: '{"schemaVersion":', stderr: '' }) } });
  await assert.rejects(port.read(f.identity), { code: 'invalid_install_execution_response' });
});

test('a full phone installation store rejects before APK transfer or job preparation', async () => {
  let calls = 0, preparations = 0;
  const port = createAndroidInstallPort({ serial: 'phone', run: async () => {
    calls++; return { stdout: '{"ok":false,"error":"install_execution_store_full"}' };
  }, shellPort: { prepare: async () => { preparations++; } } });
  await assert.rejects(port.prepare(artifact, 'original'), { code: 'install_execution_store_full' });
  assert.equal(calls, 1); assert.equal(preparations, 0);
});
