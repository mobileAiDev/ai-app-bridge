'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { currentExecution, checkExecution, withoutExecution } = require('./execution-scope');

function terminalReceipt(schema, result, identity) {
  const execution = result?.execution;
  return execution?.schemaVersion === schema && execution.actionId === identity.actionId
    && execution.runtimeEpoch === identity.runtimeEpoch && execution.settled === true
    && result.actionId === identity.actionId && result.runtimeEpoch === identity.runtimeEpoch && result.settled === true
    && typeof result.ok === 'boolean' && typeof result.dispatched === 'boolean' && typeof result.ambiguous === 'boolean'
    && (result.ok === false ? typeof result.error === 'string' && result.error.length > 0 : result.ambiguous === false);
}

// Managed SDK execution validates one original action identity. Closing HTTP
// is never a completion receipt. Cleanup addresses the exact dispatched peer.
async function executeManagedAction({ kind, schema, runtime, payload, actionId, timeoutMs, send, cancel }) {
  if (runtime?.executionSchema !== schema || typeof runtime.runtimeEpoch !== 'string' || !runtime.runtimeEpoch) return {
    ok: false, error: `${kind}_execution_unavailable`, dispatched: false, ambiguous: false,
    message: `The app SDK does not advertise managed ${kind} execution. Update the SDK and observe again.`,
  };
  checkExecution();
  const identity = { actionId: actionId ?? randomUUID(), runtimeEpoch: runtime.runtimeEpoch };
  const scope = currentExecution();
  const remaining = Math.min(scope ? scope.deadlineMs - Date.now() : Infinity, timeoutMs, 2147483647);
  if (!(remaining >= 1)) return { ok: false, error: 'deadline_exceeded', dispatched: false, ambiguous: false };
  const request = { ...payload, actionId: identity.actionId,
    execution: { schemaVersion: schema, ...identity, timeoutMs: Math.floor(remaining) } };
  let failure;
  try {
    const result = await send(request);
    if (terminalReceipt(schema, result, identity)) return { ...result, request, executionReceipt: settlementProof(kind, schema, result, identity) };
    if (result?.ok === false && typeof result.error === 'string' && result.error
        && result.dispatched === false && result.ambiguous === false && !result.execution) return { ...result, request, executionReceipt: settlementProof(kind, schema, result, identity) };
    const pending = result?.schemaVersion === schema && result.actionId === identity.actionId
      && result.runtimeEpoch === identity.runtimeEpoch && result.ok === false && result.settled === false
      && result.dispatched === null && result.ambiguous === true && typeof result.error === 'string' && result.error;
    failure = { code: pending ? result.error : `invalid_${kind}_execution_receipt`, response: result };
  } catch (error) {
    if (error.aiAppBridgeRequestNotStarted === true || error.dispatched === false) return {
      ok: false, error: error.code || `${kind}_request_not_started`, message: error.message,
      dispatched: false, ambiguous: false, request,
    };
    failure = error;
  }
  let cancellation;
  try { cancellation = await withoutExecution(() => cancel(identity)); }
  catch (error) { cancellation = { ok: false, error: error.code || error.message }; }
  let receipt;
  if (cancellation?.ok === true && cancellation.actionId === identity.actionId && cancellation.runtimeEpoch === identity.runtimeEpoch
      && terminalReceipt(schema, cancellation.executionResult, identity)) receipt = cancellation.executionResult;
  else if (cancellation?.ok !== false || typeof cancellation.error !== 'string' || !cancellation.error) {
    cancellation = { ok: false, error: `invalid_${kind}_cancel_receipt`, response: cancellation };
  }
  return { ok: false, error: failure.code || `${kind}_action_response_lost`,
    actionId: identity.actionId, runtimeEpoch: identity.runtimeEpoch, request,
    dispatched: receipt?.dispatched ?? null, ambiguous: receipt?.ambiguous ?? true, settled: Boolean(receipt),
    cancellation, executionReceipt: receipt ? settlementProof(kind, schema, receipt, identity) : null, ...(failure.response === undefined ? {} : { response: failure.response }) };
}

function settlementProof(kind, schema, result, identity) {
  const receipt = terminalReceipt(schema, result, identity) ? result
    : result?.cancellation?.ok === true && terminalReceipt(schema, result.cancellation.executionResult, identity)
      ? result.cancellation.executionResult : null;
  if (receipt) {
    const { request, executionReceipt, transport, ...wireReceipt } = receipt;
    return { kind, settled: true, actionId: identity.actionId, runtimeEpoch: identity.runtimeEpoch,
    execution: receipt.execution, dispatched: receipt.dispatched, ambiguous: receipt.ambiguous, error: receipt.error ?? null,
    responseSha256: createHash('sha256').update(JSON.stringify(wireReceipt)).digest('hex') };
  }
  if (result?.dispatched === false && result.ambiguous === false && result.settled !== false && !result.execution) return {
    kind, settled: true, actionId: identity.actionId, runtimeEpoch: identity.runtimeEpoch,
    dispatched: false, ambiguous: false, error: result.error ?? null,
  };
  return null;
}

module.exports = { executeManagedAction, terminalReceipt, settlementProof };
