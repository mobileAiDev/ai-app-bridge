'use strict';

const test = require('node:test');
const { stopRuntime, killRuntime } = require('../test-support/runtime-control');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { once } = require('node:events');
const { promisify } = require('node:util');
const { executeCommand } = require('../test-support/host-client');
const { createDeviceMutationLease, getProcessDeviceMutationLease, runDeviceEffect } = require('../bin/shared-kernel/device-mutation-lease');
const { createOwnershipStore } = require('../bin/shared-kernel/device-ownership-store');
const { createUiaRuntimeFixture } = require('../test-support/uia-runtime-fixture');
const protocol = require('../bin/shared-kernel/uia-protocol');

const cli = path.join(__dirname, '../bin/ai-app-bridge.js');
const journal = (directory, serial) => path.join(directory, `${protocol.digest(serial)}.json`);
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-uia-ack-'));
  const peer = await createUiaRuntimeFixture({ directory, ...options });
  t.after(async () => { await stopRuntime(); await peer.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const target = { serial: peer.serial, adb: peer.adb, packageName: 'example.uia', targetText: 'Button', feedback: 'off' };
  return { peer, target };
}
const ownership = serial => getProcessDeviceMutationLease().status(serial).ownership;
const reconcileInChild = async serial => {
  require('../bin/shared-kernel/host-fact-store').closeHostFactStore();
  let output;
  try { output = await promisify(execFile)(process.execPath, [cli, 'device-ownership', '--operation', 'reconcile', '--serial', serial]); }
  catch (error) { if (error.code !== 1 || !error.stdout) throw error; output = error; }
  const value = JSON.parse(output.stdout).value;
  await stopRuntime();
  return value;
};

for (const acknowledgedOnPhone of [false, true]) test(`Host SIGKILL with a durable pending acknowledgement; phone acknowledged=${acknowledgedOnPhone}`, { timeout: 15000 }, async t => {
  let reached;
  const atAck = new Promise(resolve => { reached = resolve; });
  const { peer, target } = await fixture(t, { onRequest: async (body, peer, req, res) => {
    if (body.op !== 'acknowledge') return;
    if (acknowledgedOnPhone) peer.respond(body);
    reached();
    return new Promise(resolve => res.once('close', () => resolve({ close: true })));
  } });
  const child = spawn(process.execPath, [cli, 'tap-uia-text', '--serial', target.serial, '--adb', target.adb,
    '--package-name', target.packageName, '--target-text', 'Button', '--request-id', 'crash-at-ack', '--feedback', 'off'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await atAck;
  const before = ownership(peer.serial);
  assert.equal(before.pending, null); assert.equal(before.pendingAcknowledgements.length, 1);
  const entry = before.pendingAcknowledgements[0];
  assert.equal(entry.proof.receiptJson, peer.records.get('crash-at-ack').receiptJson);
  await killRuntime(); await closed;
  if (acknowledgedOnPhone) {
    // JVM tests prove the actual retirement operation; simulate its completed
    // filesystem state here to exercise a fresh Host retry after that retirement.
    const previous = peer.peer.sessionPath; peer.rotate(); fs.rmSync(peer.phoneFile(previous), { recursive: true });
  } else { peer.peer.running = false; peer.publish(); }
  const result = await reconcileInChild(peer.serial);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.recovered, false);
  assert.equal(result.pendingAcknowledgements, 0, JSON.stringify(result)); assert.equal(result.cleanupErrors, undefined);
  assert.deepEqual(ownership(peer.serial).pendingAcknowledgements, []);
  assert.deepEqual(ownership(peer.serial).lastSettlement, before.lastSettlement);
  const retained = JSON.parse((await promisify(execFile)(process.execPath, [cli, 'device-ownership', '--operation', 'receipt',
    '--serial', peer.serial, '--runtime-epoch', entry.pending.runtimeEpoch, '--action-id', entry.pending.actionId])).stdout).value;
  assert.equal(retained.ok, true); assert.equal(retained.originalCompletionAvailable, true);
  assert.equal(retained.record.completion.json, entry.proof.receiptJson);
  assert.equal(retained.record.request.json, entry.pending.requestJson);
  assert.equal(result.acknowledgements[0].disposition, acknowledgedOnPhone ? 'not_retained' : 'acknowledged');
  assert.deepEqual(peer.dispatches, ['crash-at-ack']);
  assert.equal(peer.requests.filter(item => item.op === 'prepare').length, 1);
  if (!acknowledgedOnPhone) {
    const record = JSON.parse(fs.readFileSync(peer.phoneFile(`${entry.pending.target.sessionPath}/actions/${protocol.digest('crash-at-ack')}.json`)));
    assert.equal(record.acknowledged, true); assert.equal(record.receiptJson, entry.proof.receiptJson);
    assert.doesNotMatch(fs.readFileSync(path.join(peer.directory, 'adb.jsonl'), 'utf8'), /nohup|setsid|owner-status/);
  }
});

test('eight failed acknowledgements bound retained obligations and the next UIA action never prepares', async t => {
  let reject = true;
  const { peer, target } = await fixture(t, { onRequest: body => body.op === 'acknowledge' && reject
    ? { httpStatus: 503, ok: false, error: 'uia_journal_write_failed' } : undefined });
  for (let i = 0; i < 8; i++) {
    const result = await executeCommand('tap-uia-text', { ...target, requestId: `ack-${i}` });
    assert.equal(result.ok, true); assert.equal(result.cleanupError, 'uia_journal_write_failed');
  }
  assert.equal(ownership(peer.serial).pendingAcknowledgements.length, 8);
  const rejected = await executeCommand('tap-uia-text', { ...target, requestId: 'over-capacity' });
  assert.equal(rejected.error, 'device_acknowledgements_full');
  assert.equal(rejected.dispatched, false); assert.equal(rejected.ambiguous, false);
  assert.equal(peer.requests.filter(item => item.op === 'prepare').length, 8);
  reject = false;
  const recovered = await reconcileInChild(peer.serial);
  assert.equal(recovered.pendingAcknowledgements, 0); assert.equal(peer.dispatches.length, 8);
  assert.equal((await executeCommand('tap-uia-text', { ...target, requestId: 'after-cleanup' })).ok, true);
});

test('cleanup of older known receipts preserves a different unresolved effect', async t => {
  let reject = true;
  const { peer, target } = await fixture(t, { onRequest: body => body.op === 'acknowledge' && reject
    ? { httpStatus: 503, ok: false, error: 'uia_journal_write_failed' } : undefined });
  assert.equal((await executeCommand('tap-uia-text', { ...target, requestId: 'known' })).ok, true);
  const lease = getProcessDeviceMutationLease();
  await lease.run(peer.serial, () => runDeviceEffect({ kind: 'unknown-provider', actionId: 'still-unknown' },
    async () => ({ settled: false, dispatched: null, ambiguous: true })));
  const pending = ownership(peer.serial).pending;
  reject = false;
  const recovered = await reconcileInChild(peer.serial);
  assert.equal(recovered.error, 'device_ownership_unresolved'); assert.equal(recovered.pendingAcknowledgements, 0);
  assert.deepEqual(ownership(peer.serial).pending, pending); assert.deepEqual(peer.dispatches, ['known']);
});

test('invalid cleanup identity remains durable and cannot be replaced by a generic success flag', async t => {
  const { peer, target } = await fixture(t, { onRequest: body => body.op === 'acknowledge'
    ? { ok: true, acknowledged: true } : undefined });
  const result = await executeCommand('tap-uia-text', { ...target, requestId: 'invalid-ack' });
  assert.equal(result.ok, true); assert.equal(result.cleanupError, 'uia_acknowledgement_invalid');
  assert.equal(ownership(peer.serial).pendingAcknowledgements.length, 1);
  const reopened = await reconcileInChild(peer.serial);
  assert.equal(reopened.pendingAcknowledgements, 1); assert.equal(reopened.cleanupErrors[0].error, 'uia_acknowledgement_invalid');
  assert.deepEqual(peer.dispatches, ['invalid-ack']);
});

test('v1 journal upgrade preserves unknown ownership under the same physical lock', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-ownership-upgrade-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = { schemaVersion: 'aab.device-ownership/v1', serial: 'phone', phase: 'unresolved',
    pending: { id: 'previous', kind: 'native', actionId: 'original' }, reservations: [], lastSettlement: { retained: true } };
  fs.writeFileSync(journal(directory, 'phone'), JSON.stringify(original));
  const store = createOwnershipStore(directory), lease = createDeviceMutationLease({ directory });
  assert.deepEqual(store.read('phone'), { ...original, schemaVersion: 'aab.device-ownership/v2', pendingAcknowledgements: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(journal(directory, 'phone'))), original);
  assert.equal(lease.acquire('phone').error, 'device_ownership_unresolved');
  const held = store.lock('phone'); assert.equal(lease.acquire('phone').error, 'target_busy'); held.close();
  assert.equal((await lease.reconcile('phone', async pending => {
    assert.deepEqual(pending, original.pending); return { settled: true, original: true };
  })).ok, true);
  const upgraded = JSON.parse(fs.readFileSync(journal(directory, 'phone')));
  assert.equal(upgraded.schemaVersion, 'aab.device-ownership/v2'); assert.deepEqual(upgraded.pendingAcknowledgements, []);
});

test('corrupt acknowledgement bytes block acquisition before any further phone dispatch', async t => {
  const { peer, target } = await fixture(t, { onRequest: body => body.op === 'acknowledge'
    ? { httpStatus: 503, ok: false, error: 'uia_journal_write_failed' } : undefined });
  await executeCommand('tap-uia-text', { ...target, requestId: 'original' });
  const file = journal(getProcessDeviceMutationLease().directory, peer.serial), original = fs.readFileSync(file, 'utf8');
  t.after(() => fs.writeFileSync(file, original));
  const corrupt = JSON.parse(original); corrupt.pendingAcknowledgements[0].proof.receiptJson += ' ';
  fs.writeFileSync(file, JSON.stringify(corrupt));
  assert.equal((await executeCommand('tap-uia-text', { ...target, requestId: 'must-not-run' })).error, 'device_ownership_corrupt');
  assert.deepEqual(peer.dispatches, ['original']);
});

test('Host storage failure after phone acknowledgement retains the durable cleanup obligation for retry', async t => {
  let reject = true;
  const { peer, target } = await fixture(t, { onRequest: body => body.op === 'acknowledge' && reject
    ? { httpStatus: 503, ok: false, error: 'uia_journal_write_failed' } : undefined });
  await executeCommand('tap-uia-text', { ...target, requestId: 'host-storage-failure' });
  const lease = getProcessDeviceMutationLease(), file = journal(lease.directory, peer.serial);
  const original = fs.readFileSync(file, 'utf8'), rename = fs.renameSync;
  const { createUiaRuntimePort } = require('../bin/shared-kernel/uia-runtime-port');
  const { completion } = require('../bin/shared-kernel/device-acknowledgements');
  reject = false;
  fs.renameSync = (source, destination) => {
    if (destination === file) throw Object.assign(new Error('Injected Host commit failure'), { code: 'EIO' });
    return rename(source, destination);
  };
  let result;
  try {
    result = await lease.drainAcknowledgements(peer.serial, ({ pending, proof }) =>
      createUiaRuntimePort(pending.target).acknowledge(pending, completion(pending, proof)));
  } finally { fs.renameSync = rename; }
  assert.equal(result.remaining, 1); assert.equal(result.errors[0].error, 'device_ownership_unavailable');
  assert.equal(fs.readFileSync(file, 'utf8'), original); assert.equal(peer.records.get('host-storage-failure').acknowledged, true);
  assert.equal((await reconcileInChild(peer.serial)).pendingAcknowledgements, 0);
  assert.deepEqual(peer.dispatches, ['host-storage-failure']);
});

test('receipt queries have exact identity fields and cannot initiate recovery or accept a replacement target', () => {
  const { validateCommandArguments } = require('../bin/command-registry');
  const args = { operation: 'receipt', serial: 'phone', runtimeEpoch: '12345678-1234-4234-8234-123456789abc', actionId: 'script:回归' };
  assert.deepEqual(validateCommandArguments('device-ownership', args), args);
  assert.throws(() => validateCommandArguments('device-ownership', { ...args, runtimeEpoch: undefined }), { code: 'invalid_argument' });
  assert.throws(() => validateCommandArguments('device-ownership', { ...args, operation: 'reconcile' }), { code: 'invalid_argument' });
  assert.throws(() => validateCommandArguments('device-ownership', { ...args, adb: 'different' }), { code: 'unsupported_argument' });
});

test('redacted completion history is explicit and cannot masquerade as the original hashed receipt', async t => {
  const xml = '<hierarchy><node text="password=super-secret" package="example.uia" enabled="true" clickable="true" visible-to-user="true" bounds="[0,0][100,100]"/></hierarchy>';
  const { peer, target } = await fixture(t, { xml });
  const result = await executeCommand('tap-uia-text', { ...target, targetText: 'password=super-secret', requestId: 'sensitive-observation' });
  assert.equal(result.ok, true); assert.equal(result.cleanupError, undefined);
  assert.equal(result.completionHistory.originalCompletionAvailable, false);
  const retained = await executeCommand('device-ownership', { operation: 'receipt', serial: peer.serial,
    runtimeEpoch: result.runtimeEpoch, actionId: result.actionId });
  assert.equal(retained.originalCompletionAvailable, false);
  assert.equal(retained.record.completion.representation, 'redacted-json');
  assert.equal(retained.record.completion.originalSha256, result.executionReceipt.responseSha256);
  assert.equal(retained.record.completion.storedSha256, protocol.digest(retained.record.completion.json));
  assert.equal(JSON.stringify(retained).includes('super-secret'), false);
  assert.equal(peer.records.get('sensitive-observation').acknowledged, true);
});

test('unavailable completion storage keeps phone acknowledgement pending and recovery uses the original store directory', async t => {
  const { peer, target } = await fixture(t);
  const storeModule = require('../bin/shared-kernel/host-fact-store');
  const store = storeModule.getHostFactStore(), record = store.record;
  store.record = () => { throw Object.assign(new Error('Injected FactStore failure'), { code: 'EIO' }); };
  let result;
  try { result = await executeCommand('tap-uia-text', { ...target, requestId: 'history-unavailable' }); }
  finally { store.record = record; }
  assert.equal(result.ok, true); assert.equal(result.cleanupError, 'EIO');
  assert.equal(peer.requests.some(r => r.op === 'acknowledge'), false);
  const entry = ownership(peer.serial).pendingAcknowledgements[0];
  const different = path.join(peer.directory, 'different-facts');
  const busy = JSON.parse((await promisify(execFile)(process.execPath,
    [cli, 'device-ownership', '--operation', 'reconcile', '--serial', peer.serial])).stdout).value;
  assert.equal(busy.pendingAcknowledgements, 1); assert.equal(busy.cleanupErrors[0].error, 'fact_store_writer_busy');
  assert.equal(peer.requests.some(r => r.op === 'acknowledge'), false);
  storeModule.closeHostFactStore();
  const recovered = JSON.parse((await promisify(execFile)(process.execPath,
    [cli, 'device-ownership', '--operation', 'reconcile', '--serial', peer.serial],
    { env: { ...process.env, AI_APP_BRIDGE_FACT_STORE_DIR: different } })).stdout).value;
  assert.equal(recovered.pendingAcknowledgements, 0, JSON.stringify(recovered));
  assert.equal(recovered.acknowledgements[0].history.storeDirectory, entry.historyTarget.directory);
  const original = await executeCommand('device-ownership', { operation: 'receipt', serial: peer.serial,
    runtimeEpoch: result.runtimeEpoch, actionId: result.actionId });
  assert.equal(original.record.completion.json, result.executionReceipt.receiptJson);
  assert.deepEqual(peer.dispatches, ['history-unavailable']);
});
