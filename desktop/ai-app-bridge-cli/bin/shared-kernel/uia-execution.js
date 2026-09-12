'use strict';

const { CommandError } = require('../command-errors');
const { createUiaRuntimePort } = require('./uia-runtime-port');
const { runDeviceEffect, isDeviceSettlementDurable, completeDeviceAcknowledgement } = require('./device-mutation-lease');
const { currentExecution, runExecution, checkExecution, withoutExecution, executionSleep } = require('./execution-scope');
const protocol = require('./uia-protocol');

function matchingPending(response, identity) {
  return response?.schemaVersion === protocol.schema && response.settled === false && response.ok === false
    && response.dispatched === null && response.ambiguous === true
    && ['bootId', 'runtimeEpoch', 'actionId', 'requestSha256'].every(key => response[key] === identity[key])
    && ['prepared', 'queued', 'admitted', 'unknown', 'terminal'].includes(response.phase)
    && typeof response.error === 'string' && response.error.length > 0;
}

async function executeUiaAction({ adb, serial, binding, actionId, timeoutMs = 10000, clickPolicy = 'nearest_clickable_ancestor',
  port = createUiaRuntimePort({ adb, serial, timeoutMs }) } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)
    throw new CommandError('invalid_argument', 'UIA timeoutMs must be a positive integer in milliseconds.', { dispatched: false, ambiguous: false });
  if (!currentExecution()) return runExecution({ timeoutMs, mutation: true },
    () => executeUiaAction({ adb, serial, binding, actionId, timeoutMs, clickPolicy, port }));
  checkExecution();
  const candidate = protocol.actionRequest(binding, { actionId, timeoutMs: Math.min(timeoutMs, 60000), clickPolicy });
  let connection;
  try {
    connection = await port.ensure();
    if (connection.peer.bootId !== binding?.bootId || connection.peer.runtimeEpoch !== binding?.runtimeEpoch) {
      throw new CommandError('uia_stale_runtime', 'The observed UIA runtime has changed. Observe the target again.');
    }
    if (connection.status.count === connection.status.capacity) {
      throw new CommandError('uia_action_capacity_exhausted', 'The UIA action journal is full. Reconcile pending actions and retain their completion receipts; a new observation rotates only a fully acknowledged session.');
    }
  } catch (error) {
    return { ok: false, error: error.code || 'uia_runtime_unavailable', message: error.message, dispatched: false, ambiguous: false };
  }
  checkExecution();
  const remaining = Math.floor(Math.min(timeoutMs, currentExecution().deadlineMs - Date.now(), 60000));
  if (remaining < 1) throw new CommandError('deadline_exceeded', 'The UIA execution budget expired before preparation.', { dispatched: false, ambiguous: false });
  const prepared = protocol.actionRequest(binding, { actionId: candidate.request.actionId, timeoutMs: remaining, clickPolicy });
  const { request, requestJson, requestSha256 } = prepared;
  const identity = { kind: 'uia-node', schemaVersion: protocol.schema, actionId: request.actionId,
    bootId: request.bootId, runtimeEpoch: request.runtimeEpoch, requestJson, requestSha256,
    target: { adb, serial, root: connection.peer.sessionPath.split('/sessions/')[0],
      sessionPath: connection.peer.sessionPath, dexSha256: connection.peer.dexSha256 } };
  if (!protocol.validIdentity(identity)) throw new CommandError('invalid_uia_execution_identity', 'The UIA runtime did not yield a valid original action identity.', { dispatched: false, ambiguous: false });

  let terminal;
  const result = await runDeviceEffect(identity, async () => {
    let response, failure;
    try {
      response = await port.action(connection, 'prepare', identity);
      if (!protocol.originalReceipt(response, identity)) {
        if (!matchingPending(response, identity)) throw new CommandError('invalid_uia_execution_receipt', 'UIA preparation did not return the original action identity.');
        if (response.error !== 'uia_action_pending') throw new CommandError(response.error, 'UIA could not prepare this action durably.');
        if (response.phase === 'prepared') {
          checkExecution();
          response = await port.action(connection, 'start', identity);
        }
      }
      for (;;) {
        const receipt = protocol.originalReceipt(response, identity);
        if (receipt) { terminal = response; return { ...receipt, request, executionReceipt: protocol.settlementProof(response, identity) }; }
        if (!matchingPending(response, identity)) throw new CommandError('invalid_uia_execution_receipt', 'UIA did not return a matching original action state.');
        if (response.error !== 'uia_action_pending') throw new CommandError(response.error, 'The original UIA action has not completed.');
        checkExecution();
        await executionSleep(25);
        response = await port.action(connection, 'query', identity);
      }
    } catch (error) { failure = error; }

    let recovery;
    try {
      recovery = await withoutExecution(() => runExecution({ timeoutMs: 5000, mutation: false }, () => port.recover(identity)));
    } catch (error) { recovery = { ok: false, error: error.code || 'uia_completion_query_failed' }; }
    const receipt = protocol.originalReceipt(recovery, identity);
    if (receipt) terminal = recovery;
    return { ok: false, error: failure.code || 'uia_action_response_lost', message: failure.message,
      actionId: identity.actionId, bootId: identity.bootId, runtimeEpoch: identity.runtimeEpoch, request,
      settled: Boolean(receipt), dispatched: receipt?.dispatched ?? null, ambiguous: receipt ? false : true,
      recovery, executionReceipt: receipt ? protocol.settlementProof(recovery, identity) : null };
  }, value => value?.executionReceipt || false);

  // Shared ownership commits the proof before the phone may acknowledge it.
  // A history/acknowledgement failure never changes the already known effect.
  if (terminal && isDeviceSettlementDurable(result.executionReceipt)) {
    try {
      const acknowledgement = await completeDeviceAcknowledgement(result.executionReceipt, () => withoutExecution(() =>
        runExecution({ timeoutMs: 5000, mutation: false }, () => port.acknowledge(identity, terminal))));
      result.completionHistory = acknowledgement.history;
    } catch (error) { result.cleanupError = error.code || 'uia_acknowledgement_failed'; }
  }
  return result;
}

module.exports = { executeUiaAction, matchingPending, ...protocol };
