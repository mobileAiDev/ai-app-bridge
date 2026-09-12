'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const protocol = require('../bin/shared-kernel/uia-protocol');
const { receiptBinding } = require('../test-support/uia-runtime-fixture');

function vector() {
  const prepared = protocol.actionRequest({ bootId: randomUUID(), runtimeEpoch: randomUUID(),
    target: { snapshotId: randomUUID(), ref: randomUUID(), selector: { kind: 'text', value: 'Button', exact: true, packageName: 'example.uia' } } },
  { actionId: 'intent:动作/decision-1', timeoutMs: 1000 });
  const { request, requestJson, requestSha256 } = prepared;
  const identity = { kind: 'uia-node', schemaVersion: protocol.schema, bootId: request.bootId, runtimeEpoch: request.runtimeEpoch,
    actionId: request.actionId, requestJson, requestSha256, target: { adb: '/controlled/adb', serial: 'controlled-device', root: protocol.rootDirectory,
      sessionPath: `${protocol.rootDirectory}/sessions/${request.runtimeEpoch}`, dexSha256: 'a'.repeat(64) } };
  const receipt = { schemaVersion: protocol.schema, bootId: request.bootId, runtimeEpoch: request.runtimeEpoch, actionId: request.actionId,
    requestSha256, settled: true, ok: true, dispatched: true, ambiguous: false, completion: 'original_callback', completedAtElapsedMs: 100,
    binding: receiptBinding(request), callback: { interactionId: 1, handled: true } };
  const wrap = value => {
    const receiptJson = JSON.stringify(value);
    return { schemaVersion: protocol.schema, bootId: request.bootId, runtimeEpoch: request.runtimeEpoch,
      actionId: request.actionId, requestSha256, settled: true, receiptJson, receiptSha256: protocol.digest(receiptJson) };
  };
  return { identity, request, receipt, wrap };
}

test('original Unicode Intent and Script action IDs remain exact in requests and completion proofs', () => {
  const { identity, receipt, wrap } = vector();
  assert.equal(protocol.validIdentity(identity), true);
  assert.equal(protocol.originalReceipt(wrap(receipt), identity).actionId, 'intent:动作/decision-1');
  assert.equal(protocol.settlementProof(wrap(receipt), identity).receiptJson, JSON.stringify(receipt));
});

for (const [name, mutate] of [
  ['other action', r => { r.actionId += '-other'; }],
  ['other snapshot', r => { r.binding.snapshotId = randomUUID(); }],
  ['other node', r => { r.binding.ref = randomUUID(); }],
  ['other selector', r => { r.binding.selector.value = 'Delete'; }],
  ['other policy', r => { r.binding.clickPolicy = 'exact_node'; }],
  ['other window', r => { r.binding.actionTarget.windowId++; }],
  ['unfocused window', r => { r.binding.window.focused = false; }],
  ['nondefault display', r => { r.binding.window.displayId = 1; }],
  ['other package', r => { r.binding.target.packageName = 'other.app'; }],
  ['other matched text', r => { r.binding.target.text = 'Delete'; }],
  ['disabled target', r => { r.binding.target.enabled = false; }],
  ['different clickable node', r => { r.binding.actionTarget.sourceId = '99'; }],
  ['missing original callback', r => { delete r.callback; }],
  ['wrong handled result', r => { r.callback.handled = false; }],
  ['unsupported identity guarantee', r => { r.binding.identityStrength = 'coordinate'; }],
]) test(`a correctly hashed but mismatched receipt cannot release ownership: ${name}`, () => {
  const { identity, receipt, wrap } = vector(); mutate(receipt);
  assert.equal(protocol.originalReceipt(wrap(receipt), identity), null);
  assert.equal(protocol.settlementProof(wrap(receipt), identity), null);
});

test('pre-admission cancellation and handled-false callbacks are settled failures', () => {
  const { identity, receipt, wrap } = vector();
  receipt.ok = false; receipt.error = 'uia_action_not_handled'; receipt.callback.handled = false;
  assert.equal(protocol.originalReceipt(wrap(receipt), identity).dispatched, true);
  receipt.completion = 'before_admission'; receipt.dispatched = false; delete receipt.callback; delete receipt.binding;
  assert.equal(protocol.originalReceipt(wrap(receipt), identity).dispatched, false);
});

test('durable completion requires exact original request bytes as well as receipt hash', () => {
  const { identity, receipt, wrap } = vector();
  const response = wrap(receipt);
  const saved = { ...response, schemaVersion: 'aab.uia.record.v2', phase: 'terminal', requestJson: identity.requestJson };
  assert.ok(protocol.recordResponse(saved, identity));
  assert.equal(protocol.recordResponse({ ...saved, requestJson: identity.requestJson + '\n' }, identity), null);
  assert.equal(protocol.recordResponse({ ...saved, receiptSha256: 'b'.repeat(64) }, identity), null);
});

function recoveryVector() {
  const value = vector(), { receipt, identity } = value;
  delete receipt.completedAtElapsedMs; delete receipt.binding; delete receipt.callback;
  Object.assign(receipt, { ok: false, dispatched: false, completion: 'recovered_before_admission', error: 'uia_owner_exited_before_admission',
    recovery: { authority: 'exclusive_runtime_root_lock', bootId: randomUUID(), observedAtElapsedMs: 5,
      priorPhase: 'queued', priorRecordSha256: 'b'.repeat(64), preparedAtElapsedMs: 100,
      originalDexSha256: identity.target.dexSha256, recoveryDexSha256: 'c'.repeat(64) } });
  return value;
}

test('a recovered non-dispatch credential preserves original identity and separates reboot clocks', () => {
  const { identity, receipt, wrap } = recoveryVector(), response = wrap(receipt);
  assert.equal(protocol.originalReceipt(response, identity).dispatched, false);
  assert.equal(protocol.settlementProof(response, identity).receiptJson, response.receiptJson);
  assert.equal(protocol.acknowledgementIdentity(identity, response).receiptSha256, response.receiptSha256);
  assert.deepEqual(protocol.recoveryIdentity(identity), { bootId: identity.bootId, runtimeEpoch: identity.runtimeEpoch,
    actionSha256: protocol.digest(identity.actionId), requestSha256: identity.requestSha256, originalDexSha256: identity.target.dexSha256 });
  const saved = { ...response, schemaVersion: 'aab.uia.record.v2', phase: 'terminal', requestJson: identity.requestJson,
    preparedAtElapsedMs: 100, deadlineElapsedMs: 1100, interactionId: 0, acknowledged: false };
  assert.ok(protocol.recordResponse(saved, identity));
  for (const extra of [{ preparedAtElapsedMs: 0 }, { deadlineElapsedMs: 1000 }, { interactionId: 1 }, { acknowledged: 'false' }])
    assert.equal(protocol.recordResponse({ ...saved, ...extra }, identity), null);
});

for (const [name, mutate] of [
  ['admitted original', r => { r.recovery.priorPhase = 'admitted'; }],
  ['unknown original', r => { r.recovery.priorPhase = 'unknown'; }],
  ['wrong authority', r => { r.recovery.authority = 'process_disappeared'; }],
  ['wrong original executable', r => { r.recovery.originalDexSha256 = 'd'.repeat(64); }],
  ['missing recovery executable', r => { delete r.recovery.recoveryDexSha256; }],
  ['wrong prior record hash', r => { r.recovery.priorRecordSha256 = 'invalid'; }],
  ['wrong recovery boot', r => { r.recovery.bootId = 'invalid'; }],
  ['backwards same-boot clock', (r, i) => { r.recovery.bootId = i.bootId; }],
  ['invalid clock', r => { r.recovery.observedAtElapsedMs = '5'; }],
  ['invented original time', r => { r.completedAtElapsedMs = 500; }],
  ['invented callback', r => { r.callback = { interactionId: 1, handled: false }; }],
  ['dispatched claim', r => { r.dispatched = true; }],
  ['wrong reason', r => { r.error = 'success'; }],
]) test(`recovery proof rejects ${name}`, () => {
  const { identity, receipt, wrap } = recoveryVector(); mutate(receipt, identity);
  assert.equal(protocol.originalReceipt(wrap(receipt), identity), null);
  assert.equal(protocol.settlementProof(wrap(receipt), identity), null);
});
