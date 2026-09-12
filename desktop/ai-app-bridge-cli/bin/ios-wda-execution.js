'use strict';

const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const managed = require('./shared-kernel/managed-sdk-execution');
const { runDeviceEffect } = require('./shared-kernel/device-mutation-lease');
const { runExecution } = require('./shared-kernel/execution-scope');
const { iosDeviceKey, lookupCompletion } = require('./ios-execution');

const schema = 'aab.wda-execution/v1';
function proof(result, identity, target) {
  const terminal = managed.terminalReceipt(schema, result, identity) ? result : result?.cancellation?.executionResult;
  if (terminal && !isDeepStrictEqual(terminal.execution?.target, target)) return null;
  return managed.settlementProof('ios-wda', schema, result, identity);
}
function completionPort(port) { return { get: route => port.request('GET', route, null) }; }

async function executeWDAAction({ port, args, operation, selected, payload = {} }) {
  const identity = { actionId: args.runtimeActionId ?? args.requestId ?? randomUUID(), runtimeEpoch: port.runtimeBinding.runtimeEpoch };
  const target = { ...selected, runnerBundleId: port.runtimeBinding.bundleId, operation };
  const connection = { deviceId: port.device.udid, wdaRunnerBundleId: args.wdaRunnerBundleId,
    ...Object.fromEntries(['wdaUrl', 'devicectl'].filter(key => args[key] !== undefined).map(key => [key, args[key]])) };
  return runDeviceEffect({ kind: 'ios-wda', ...identity, target: connection, executionTarget: target }, async () => {
    const result = await managed.executeManagedAction({ kind: 'wda', schema,
      runtime: { runtimeEpoch: identity.runtimeEpoch, executionSchema: port.status.executionSchema },
      payload: { operation, target: selected, payload }, actionId: identity.actionId, timeoutMs: args.timeoutMs ?? 30000,
      send: async request => {
        const reply = await port.request('POST', '/aab/action', request, selected);
        if (managed.terminalReceipt(schema, reply, identity) && !isDeepStrictEqual(reply.execution.target, target)) {
          return { ok: false, error: 'ios_wda_completion_target_mismatch', settled: false, dispatched: null, ambiguous: true };
        }
        return reply;
      },
      cancel: original => runExecution({ timeoutMs: 4000 }, async () => {
        const cancelled = await port.request('POST', '/aab/execution/cancel', original);
        if (cancelled.ok !== true) return cancelled;
        const found = await lookupCompletion(completionPort(port), 'wda', original, cancelled);
        if (found.executionResult && !isDeepStrictEqual(found.executionResult.execution?.target, target))
          return { ok: false, error: 'ios_wda_completion_target_mismatch', settled: false };
        return found;
      }),
    });
    return { ...result, executionReceipt: proof(result, identity, target) };
  }, result => result.executionReceipt);
}

async function reconcileWDA({ lease, device, args, createPort }) {
  return lease.reconcile(iosDeviceKey(device), async pending => {
    if (pending.kind !== 'ios-wda' || pending.target?.deviceId !== device.udid
      || pending.target?.wdaRunnerBundleId !== args.wdaRunnerBundleId
      || pending.executionTarget?.runnerBundleId !== args.wdaRunnerBundleId
      || typeof pending.actionId !== 'string' || typeof pending.runtimeEpoch !== 'string')
      return { settled: false, error: 'ios_wda_original_identity_required' };
    const identity = { actionId: pending.actionId, runtimeEpoch: pending.runtimeEpoch };
    try {
      const target = { ...pending.target, timeoutMs: args.timeoutMs ?? 30000 };
      for (const key of ['wdaUrl', 'devicectl']) if (args[key] !== undefined) target[key] = args[key];
      const port = await createPort(target);
      const found = await lookupCompletion(completionPort(port), 'wda', identity);
      if (found.ok !== true || found.receipt?.committed !== true
          || !Number.isSafeInteger(found.receipt.sequence) || found.receipt.sequence < 1
          || !/^[a-f0-9]{64}$/.test(found.receipt.sha256))
        return { settled: false, error: found.error || 'ios_wda_durable_completion_required' };
      return proof(found.executionResult, identity, pending.executionTarget)
        || { settled: false, error: 'ios_wda_completion_target_mismatch' };
    } catch (error) { return { settled: false, error: error.code || 'ios_wda_completion_query_failed', message: error.message }; }
  });
}

module.exports = { executeWDAAction, reconcileWDA, completionPort };
