'use strict';

const test = require('node:test');
const { stopRuntime, killRuntime } = require('../test-support/runtime-control');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { executeCommand } = require('../test-support/host-client');
const { getProcessDeviceMutationLease } = require('../bin/shared-kernel/device-mutation-lease');
const { createUiaRuntimeFixture } = require('../test-support/uia-runtime-fixture');

const cli = path.join(__dirname, '../bin/ai-app-bridge.js');
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-uia-execution-'));
  const peer = await createUiaRuntimeFixture({ directory, ...options });
  t.after(async () => { await stopRuntime(); await peer.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const target = { serial: peer.serial, adb: peer.adb, packageName: 'example.uia', targetText: 'Button', feedback: 'off' };
  return { peer, target };
}
const clickArgs = (target, id) => [cli, 'tap-uia-text', '--serial', target.serial, '--adb', target.adb,
  '--package-name', target.packageName, '--target-text', target.targetText, '--request-id', id, '--feedback', 'off'];

test('the public CLI sends a bound node action with its exact composite ID and commits before acknowledgement', async t => {
  let proofAtAck;
  const { peer, target } = await fixture(t, { onRequest: body => {
    if (body.op === 'acknowledge') proofAtAck = getProcessDeviceMutationLease().status(peer.serial).ownership.lastSettlement.proof;
  } });
  const id = 'script:回归/step-1';
  const result = JSON.parse((await promisify(execFile)(process.execPath, clickArgs(target, id))).stdout).value;
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.actionId, id);
  assert.equal(result.source, 'uia-node-runtime'); assert.equal(result.dispatched, true);
  assert.deepEqual(peer.dispatches, [id]); assert.equal(proofAtAck.actionId, id);
  assert.equal(proofAtAck.responseSha256, result.executionReceipt.responseSha256);
  const ownership = await executeCommand('device-ownership', { operation: 'status', serial: peer.serial });
  assert.equal(ownership.active, 0);
  assert.deepEqual(ownership.ownership.pendingAcknowledgements, []);
  assert.equal(JSON.stringify(ownership).includes(peer.peer.token), false);
  assert.doesNotMatch(fs.readFileSync(path.join(peer.directory, 'adb.jsonl'), 'utf8'), /uiautomator|"input"|window.xml/);
});

test('full unacknowledged capacity rejects before action preparation and leaves shared ownership idle', async t => {
  const { peer, target } = await fixture(t, { capacity: 1, onRequest: body => body.op === 'acknowledge'
    ? { httpStatus: 503, ok: false, error: 'uia_journal_write_failed' } : undefined });
  assert.equal((await executeCommand('tap-uia-text', { ...target, requestId: 'first' })).ok, true);
  const result = await executeCommand('tap-uia-text', { ...target, requestId: 'full' });
  assert.equal(result.error, 'uia_action_capacity_exhausted'); assert.equal(result.dispatched, false); assert.equal(result.ambiguous, false);
  assert.equal(peer.requests.filter(r => r.op === 'prepare').length, 1);
  assert.equal((await executeCommand('device-ownership', { operation: 'status', serial: peer.serial })).active, 0);
});

test('a lost terminal HTTP response recovers the same original action without replay', async t => {
  const { peer, target } = await fixture(t, { onRequest: (body, fixture) => {
    if (body.op === 'start') { fixture.respond(body); return { close: true }; }
  } });
  const result = await executeCommand('tap-uia-text', { ...target, requestId: 'lost-start' });
  assert.equal(result.ok, false); assert.equal(result.settled, true); assert.equal(result.dispatched, true); assert.equal(result.ambiguous, false);
  assert.equal(result.executionReceipt.actionId, 'lost-start'); assert.deepEqual(peer.dispatches, ['lost-start']);
  assert.equal(peer.records.get('lost-start').acknowledged, true);
  assert.equal((await executeCommand('device-ownership', { operation: 'status', serial: peer.serial })).active, 0);
});

test('a killed Host retains occupancy until another process reads the original durable receipt', { timeout: 20000 }, async t => {
  let admitted;
  const admission = new Promise(resolve => { admitted = resolve; });
  const { peer, target } = await fixture(t, { autoComplete: false, onDispatch: admitted });
  const child = spawn(process.execPath, clickArgs(target, 'killed-host'), { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await admission; await killRuntime(); await closed;
  const blocked = await executeCommand('tap-uia-text', { ...target, requestId: 'must-not-dispatch' });
  assert.equal(blocked.error, 'device_ownership_unresolved'); assert.deepEqual(peer.dispatches, ['killed-host']);
  const unknown = await executeCommand('device-ownership', { operation: 'reconcile', serial: peer.serial });
  assert.equal(unknown.error, 'device_ownership_unresolved');
  peer.complete('killed-host');
  // A stopped original session can only be settled from its saved action file.
  peer.peer.running = false; peer.publish();
  require('../bin/shared-kernel/host-fact-store').closeHostFactStore();
  const reopened = JSON.parse((await promisify(execFile)(process.execPath,
    [cli, 'device-ownership', '--operation', 'reconcile', '--serial', peer.serial])).stdout).value;
  assert.equal(reopened.ok, true, JSON.stringify(reopened)); assert.equal(reopened.recovered, true);
  assert.equal(reopened.executionReceipt.actionId, 'killed-host'); assert.equal(reopened.executionReceipt.dispatched, true);
  assert.equal(reopened.cleanupErrors, undefined); assert.equal(reopened.pendingAcknowledgements, 0);
  const saved = JSON.parse(fs.readFileSync(peer.phoneFile(`${peer.peer.sessionPath}/actions/${require('../bin/shared-kernel/uia-protocol').digest('killed-host')}.json`)));
  assert.equal(saved.acknowledged, true);
  assert.deepEqual(peer.dispatches, ['killed-host']);
});

test('a matching outer identity with a mismatched node receipt remains unresolved until corrected', async t => {
  let malformed = true;
  const { peer, target } = await fixture(t, { onRequest: (body, fixture) => {
    if (body.op === 'start') {
      fixture.respond(body);
      fixture.complete(JSON.parse(body.requestJson).actionId, { mutate: r => { r.binding.ref = 'cccccccc-cccc-4ccc-cccc-cccccccccccc'; } });
    }
    if (['start', 'cancel', 'query'].includes(body.op) && malformed) return fixture.envelope(fixture.records.get(JSON.parse(body.requestJson).actionId));
  } });
  const result = await executeCommand('tap-uia-text', { ...target, requestId: 'mismatched-node' });
  assert.equal(result.settled, false); assert.equal(result.ambiguous, true);
  assert.equal((await executeCommand('device-ownership', { operation: 'reconcile', serial: peer.serial })).error, 'device_ownership_unresolved');
  malformed = false; peer.complete('mismatched-node');
  const recovered = await executeCommand('device-ownership', { operation: 'reconcile', serial: peer.serial });
  assert.equal(recovered.ok, true); assert.equal(recovered.executionReceipt.actionId, 'mismatched-node');
  assert.deepEqual(peer.dispatches, ['mismatched-node']);
});

test('a killed Host and dead phone owner recover a prepared action through public reconciliation and cold FactStore query', { timeout: 25000 }, async t => {
  let prepared;
  const waiting = new Promise(resolve => { prepared = resolve; });
  const { peer, target } = await fixture(t, { onRequest: (body, fixture) => {
    if (body.op === 'prepare') { fixture.respond(body); prepared(); return { close: true }; }
    if (body.op === 'cancel') return { close: true };
  } });
  const actionId = 'intent:准入前退出/step-1';
  const child = spawn(process.execPath, clickArgs(target, actionId), { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await waiting; await killRuntime(); await closed;
  const file = peer.phoneFile(`${peer.peer.sessionPath}/actions/${require('../bin/shared-kernel/uia-protocol').digest(actionId)}.json`);
  const original = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(original).phase, 'prepared');
  const blocked = await executeCommand('device-ownership', { operation: 'reconcile', serial: peer.serial });
  assert.equal(blocked.error, 'device_ownership_unresolved');
  assert.match(JSON.stringify(blocked), /uia_runtime_already_running/); assert.equal(fs.readFileSync(file, 'utf8'), original);
  peer.killOwner(); // Leave running:true in the original descriptor, as with a real SIGKILL.
  require('../bin/shared-kernel/host-fact-store').closeHostFactStore();
  const result = JSON.parse((await promisify(execFile)(process.execPath,
    [cli, 'device-ownership', '--operation', 'reconcile', '--serial', peer.serial])).stdout).value;
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.recovered, true);
  assert.equal(result.executionReceipt.dispatched, false); assert.equal(result.executionReceipt.ambiguous, false);
  assert.equal(result.pendingAcknowledgements, 0); assert.equal(result.cleanupErrors, undefined);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')), receipt = JSON.parse(saved.receiptJson);
  assert.equal(receipt.completion, 'recovered_before_admission'); assert.equal(saved.acknowledged, true);
  assert.equal(receipt.recovery.priorRecordSha256, require('../bin/shared-kernel/uia-protocol').digest(original));
  assert.equal(saved.requestJson, JSON.parse(original).requestJson);
  const history = JSON.parse((await promisify(execFile)(process.execPath, [cli, 'device-ownership', '--operation', 'receipt',
    '--serial', peer.serial, '--runtime-epoch', peer.peer.runtimeEpoch, '--action-id', actionId])).stdout).value;
  assert.equal(history.ok, true); assert.equal(history.originalCompletionAvailable, true);
  assert.equal(history.record.completion.json, saved.receiptJson); assert.deepEqual(peer.dispatches, []);
  assert.doesNotMatch(fs.readFileSync(path.join(peer.directory, 'adb.jsonl'), 'utf8'), /setsid|uiautomator|"input"/);
});
