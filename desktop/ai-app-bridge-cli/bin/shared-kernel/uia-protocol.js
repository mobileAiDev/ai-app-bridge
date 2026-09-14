'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { CommandError } = require('../command-errors');
const { parseXmlAttributes } = require('./xml-attributes');

const schema = 'aab.uia.execution.v1';
const runtimeSchema = 'aab.uia.runtime.v1';
const snapshotSchema = 'aab.uia.snapshot.v1';
const rootDirectory = '/data/local/tmp/ai-app-bridge-uia/v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const targetRefSchema = { type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'bootId', 'runtimeEpoch', 'snapshotId', 'nodeRef'],
  properties: { schemaVersion: { const: 'aab.uia.target/v1' },
    ...Object.fromEntries(['bootId', 'runtimeEpoch', 'snapshotId', 'nodeRef'].map(key => [key, { type: 'string', pattern: uuid.source }])) } };
const isUuid = value => typeof value === 'string' && value.length === 36 && uuid.test(value);
const isHash = value => typeof value === 'string' && value.length === 64 && hash.test(value);
const isActionId = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && value.isWellFormed();
const digest = value => createHash('sha256').update(value).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = (code, message) => { throw new CommandError(code, message, { dispatched: false, ambiguous: false }); };

function validRoot(root) {
  const prefix = '/data/local/tmp/ai-app-bridge-uia-test-';
  return root === rootDirectory || typeof root === 'string' && root.startsWith(prefix) && root.length > prefix.length && !/[^a-z0-9-]/.test(root.slice(prefix.length));
}

function validRequest(request) {
  if (!exactKeys(request, ['schemaVersion', 'bootId', 'runtimeEpoch', 'actionId', 'timeoutMs', 'target', 'clickPolicy'])
    || request.schemaVersion !== schema || ![request.bootId, request.runtimeEpoch].every(isUuid) || !isActionId(request.actionId)
    || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 60000
    || !['exact_node', 'nearest_clickable_ancestor'].includes(request.clickPolicy)
    || !exactKeys(request.target, ['snapshotId', 'ref', 'selector']) || !isUuid(request.target.snapshotId) || !isUuid(request.target.ref)) return false;
  const selector = request.target.selector;
  return exactKeys(selector, ['kind', 'value', 'exact', 'packageName'])
    && ['text', 'contentDescription', 'resourceName', 'nodeRef'].includes(selector.kind)
    && typeof selector.value === 'string' && selector.value.length > 0 && selector.value.length <= 4096
    && typeof selector.exact === 'boolean' && (selector.packageName === null || typeof selector.packageName === 'string' && selector.packageName.length > 0)
    && (selector.kind !== 'nodeRef' || selector.exact === true && selector.value === request.target.ref && typeof selector.packageName === 'string');
}

function snapshotIdentity(xml) {
  const opening = typeof xml === 'string' && xml.match(/<hierarchy\b[^>]*>/);
  const metadata = opening && parseXmlAttributes(opening[0]);
  if (!metadata || !metadata['aab-schema']) return null;
  if (metadata['aab-schema'] !== snapshotSchema
    || !['aab-boot-id', 'aab-runtime-epoch', 'aab-snapshot-id'].every(key => isUuid(metadata[key])))
    fail('uia_bound_observation_required', 'Observe UIA again using the node runtime before selecting an action.');
  return { bootId: metadata['aab-boot-id'], runtimeEpoch: metadata['aab-runtime-epoch'], snapshotId: metadata['aab-snapshot-id'] };
}

function nodeTargetRef(snapshot, node) {
  if (!snapshot) return undefined;
  if (!isUuid(node?.['aab-ref'])) fail('uia_bound_observation_required', 'The observed UIA node has no valid runtime reference.');
  return { schemaVersion: 'aab.uia.target/v1', ...snapshot, nodeRef: node['aab-ref'] };
}

function bindingFromTargetRef(ref, packageName) {
  if (!exactKeys(ref, targetRefSchema.required) || ref.schemaVersion !== 'aab.uia.target/v1'
    || !['bootId', 'runtimeEpoch', 'snapshotId', 'nodeRef'].every(key => isUuid(ref[key])))
    fail('uia_bound_observation_required', 'Use the complete targetRef from a fresh UIA observation.');
  return { bootId: ref.bootId, runtimeEpoch: ref.runtimeEpoch,
    target: { snapshotId: ref.snapshotId, ref: ref.nodeRef,
      selector: { kind: 'nodeRef', value: ref.nodeRef, exact: true, packageName } } };
}

function observedTarget(xml, node, selector, packageName, { exact = true } = {}) {
  const ref = nodeTargetRef(snapshotIdentity(xml), node);
  if (!ref) fail('uia_bound_observation_required', 'Observe UIA again using the node runtime before selecting an action.');
  const keys = Object.keys(selector || {});
  if (keys.length !== 1) fail('invalid_uia_selector', 'A UIA action requires exactly one selector field.');
  return { bootId: ref.bootId, runtimeEpoch: ref.runtimeEpoch,
    target: { snapshotId: ref.snapshotId, ref: ref.nodeRef,
      selector: { kind: keys[0], value: selector[keys[0]], exact, packageName } } };
}

function actionRequest(binding, { timeoutMs, actionId = randomUUID(), clickPolicy = 'nearest_clickable_ancestor' } = {}) {
  if (!record(binding)) fail('invalid_uia_execution_request', 'A bound UIA observation is required.');
  const request = { schemaVersion: schema, bootId: binding.bootId, runtimeEpoch: binding.runtimeEpoch,
    actionId, timeoutMs, target: binding.target, clickPolicy };
  if (!validRequest(request)) fail('invalid_uia_execution_request', 'UIA requires a valid observed node, original action identity, selector and millisecond deadline.');
  const requestJson = JSON.stringify(request);
  if (Buffer.byteLength(requestJson) > 32768) fail('uia_request_capacity_exhausted', 'The UIA action request exceeds 32 KiB.');
  return { request, requestJson, requestSha256: digest(requestJson) };
}

function validDescriptor(value, root) {
  return record(value) && validRoot(root) && value.schemaVersion === runtimeSchema
    && isUuid(value.bootId) && isUuid(value.runtimeEpoch) && isHash(value.dexSha256)
    && Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isSafeInteger(value.apiLevel) && value.apiLevel >= 25
    && value.socketName === `aab-uia-${value.runtimeEpoch}` && isHash(value.token)
    && value.sessionPath === `${root}/sessions/${value.runtimeEpoch}` && typeof value.running === 'boolean';
}

function validIdentity(identity) {
  if (!record(identity) || identity.kind !== 'uia-node' || identity.schemaVersion !== schema
    || ![identity.bootId, identity.runtimeEpoch].every(isUuid) || !isActionId(identity.actionId)
    || typeof identity.requestJson !== 'string' || !isHash(identity.requestSha256)
    || digest(identity.requestJson) !== identity.requestSha256 || Buffer.byteLength(identity.requestJson) > 32768
    || !record(identity.target) || typeof identity.target.serial !== 'string' || !identity.target.serial
    || typeof identity.target.adb !== 'string' || !identity.target.adb || !validRoot(identity.target.root)
    || identity.target.sessionPath !== `${identity.target.root}/sessions/${identity.runtimeEpoch}` || !isHash(identity.target.dexSha256)) return false;
  let request;
  try { request = JSON.parse(identity.requestJson); } catch { return false; }
  return validRequest(request) && ['bootId', 'runtimeEpoch', 'actionId'].every(key => request[key] === identity[key]);
}

function originalReceipt(response, identity) {
  if (!validIdentity(identity) || !record(response) || response.schemaVersion !== schema || response.settled !== true
    || !['bootId', 'runtimeEpoch', 'actionId', 'requestSha256'].every(key => response[key] === identity[key])
    || typeof response.receiptJson !== 'string' || !isHash(response.receiptSha256)
    || Buffer.byteLength(response.receiptJson) > 65536 || digest(response.receiptJson) !== response.receiptSha256) return null;
  let receipt;
  try { receipt = JSON.parse(response.receiptJson); } catch { return null; }
  if (!record(receipt) || receipt.schemaVersion !== schema || receipt.settled !== true || receipt.ambiguous !== false
    || !['bootId', 'runtimeEpoch', 'actionId', 'requestSha256'].every(key => receipt[key] === identity[key])
    || typeof receipt.ok !== 'boolean' || typeof receipt.dispatched !== 'boolean'
    || receipt.ok === false && (typeof receipt.error !== 'string' || !receipt.error)
    || receipt.ok === true && Object.hasOwn(receipt, 'error')) return null;
  const request = JSON.parse(identity.requestJson);
  if (receipt.completion === 'recovered_before_admission') return validRecoveryReceipt(receipt, identity, request) ? receipt : null;
  if (!Number.isSafeInteger(receipt.completedAtElapsedMs) || receipt.completedAtElapsedMs < 0
    || !['original_callback', 'admission_rejected', 'before_admission'].includes(receipt.completion)
    || Object.hasOwn(receipt, 'recovery')) return null;
  if (Object.hasOwn(receipt, 'binding') && !matchingBinding(receipt.binding, request)) return null;
  if (receipt.completion === 'original_callback') {
    if (receipt.dispatched !== true || !Number.isSafeInteger(receipt.callback?.interactionId) || receipt.callback.interactionId < 1
      || receipt.callback.handled !== receipt.ok || !record(receipt.binding)) return null;
  } else if (receipt.dispatched !== false || receipt.ok !== false || Object.hasOwn(receipt, 'callback')
    || receipt.completion === 'admission_rejected' && !record(receipt.binding)) return null;
  return receipt;
}

function validRecoveryReceipt(receipt, identity, request) {
  if (!exactKeys(receipt, ['schemaVersion', 'bootId', 'runtimeEpoch', 'actionId', 'requestSha256',
    'settled', 'ok', 'dispatched', 'ambiguous', 'completion', 'error', 'recovery'])
    || receipt.ok !== false || receipt.dispatched !== false || receipt.error !== 'uia_owner_exited_before_admission') return false;
  const value = receipt.recovery;
  return exactKeys(value, ['authority', 'bootId', 'observedAtElapsedMs', 'priorPhase', 'priorRecordSha256',
    'preparedAtElapsedMs', 'originalDexSha256', 'recoveryDexSha256'])
    && value.authority === 'exclusive_runtime_root_lock' && isUuid(value.bootId)
    && ['prepared', 'queued'].includes(value.priorPhase) && isHash(value.priorRecordSha256) && isHash(value.recoveryDexSha256)
    && value.originalDexSha256 === identity.target.dexSha256
    && Number.isSafeInteger(value.preparedAtElapsedMs) && value.preparedAtElapsedMs >= 0
    && Number.isSafeInteger(value.preparedAtElapsedMs + request.timeoutMs)
    && Number.isSafeInteger(value.observedAtElapsedMs) && value.observedAtElapsedMs >= 0
    && (value.bootId !== identity.bootId || value.observedAtElapsedMs >= value.preparedAtElapsedMs);
}

function matchingBinding(binding, request) {
  if (!record(binding) || binding.snapshotId !== request.target.snapshotId || binding.ref !== request.target.ref
    || !isDeepStrictEqual(binding.selector, request.target.selector) || binding.clickPolicy !== request.clickPolicy
    || binding.identityStrength !== 'same_connection_node_and_reobserved_attributes'
    || !record(binding.window) || !Number.isSafeInteger(binding.window.id) || binding.window.id < 0
    || binding.window.displayId !== 0 || binding.window.focused !== true) return false;
  const { target, actionTarget } = binding;
  for (const node of [target, actionTarget]) {
    if (!record(node) || node.windowId !== binding.window.id || typeof node.sourceId !== 'string'
      || !/^-?[0-9]{1,20}$/.test(node.sourceId) || node.enabled !== true || node.visible !== true) return false;
  }
  const selector = request.target.selector;
  const value = selector.kind === 'nodeRef' ? binding.ref : target[selector.kind];
  if (typeof value !== 'string' || !(selector.exact ? value === selector.value : value.includes(selector.value))
    || selector.packageName !== null && target.packageName !== selector.packageName || actionTarget.clickable !== true) return false;
  return !(request.clickPolicy === 'exact_node' || target.clickable === true) || isDeepStrictEqual(target, actionTarget);
}

function recordResponse(value, identity) {
  if (!record(value) || value.schemaVersion !== 'aab.uia.record.v2' || value.phase !== 'terminal'
    || value.requestJson !== identity.requestJson || !['bootId', 'runtimeEpoch', 'actionId', 'requestSha256'].every(key => value[key] === identity[key])) return null;
  const response = { schemaVersion: schema, bootId: value.bootId, runtimeEpoch: value.runtimeEpoch, actionId: value.actionId,
    requestSha256: value.requestSha256, settled: true, phase: 'terminal', receiptJson: value.receiptJson, receiptSha256: value.receiptSha256 };
  const receipt = originalReceipt(response, identity);
  if (!receipt) return null;
  if (receipt.completion === 'recovered_before_admission'
    && (value.preparedAtElapsedMs !== receipt.recovery.preparedAtElapsedMs
      || value.deadlineElapsedMs !== value.preparedAtElapsedMs + JSON.parse(identity.requestJson).timeoutMs
      || value.interactionId !== 0 || typeof value.acknowledged !== 'boolean')) return null;
  return response;
}

function settlementProof(response, identity) {
  const receipt = originalReceipt(response, identity);
  return receipt ? { kind: 'uia-node', schemaVersion: schema, settled: true, bootId: identity.bootId,
    runtimeEpoch: identity.runtimeEpoch, actionId: identity.actionId, requestSha256: identity.requestSha256,
    dispatched: receipt.dispatched, ambiguous: false, error: receipt.error ?? null,
    responseSha256: response.receiptSha256, receiptJson: response.receiptJson } : null;
}

function acknowledgementIdentity(identity, response) {
  if (!originalReceipt(response, identity)) fail('uia_completion_identity_mismatch', 'Only a validated original UIA receipt may be acknowledged.');
  return { bootId: identity.bootId, runtimeEpoch: identity.runtimeEpoch, actionSha256: digest(identity.actionId),
    requestSha256: identity.requestSha256, receiptSha256: response.receiptSha256, originalDexSha256: identity.target.dexSha256 };
}

function recoveryIdentity(identity) {
  if (!validIdentity(identity)) fail('invalid_uia_execution_identity', 'Recovery requires the complete original UIA request and target identity.');
  return { bootId: identity.bootId, runtimeEpoch: identity.runtimeEpoch, actionSha256: digest(identity.actionId),
    requestSha256: identity.requestSha256, originalDexSha256: identity.target.dexSha256 };
}

function acknowledgementMatches(response, identity) {
  return exactKeys(response, ['ok', 'schemaVersion', 'identity', 'disposition']) && response.ok === true
    && response.schemaVersion === 'aab.uia.ack.v1' && isDeepStrictEqual(response.identity, identity)
    && ['acknowledged', 'not_retained'].includes(response.disposition);
}

module.exports = { schema, runtimeSchema, snapshotSchema, rootDirectory, digest, validRoot, validRequest,
  targetRefSchema, snapshotIdentity, nodeTargetRef, bindingFromTargetRef,
  actionRequest, observedTarget, validDescriptor, validIdentity, originalReceipt, recordResponse, settlementProof,
  acknowledgementIdentity, acknowledgementMatches, recoveryIdentity };
