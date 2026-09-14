'use strict';

const { randomUUID } = require('node:crypto');
const { CommandError } = require('./command-errors');
const fs = require('node:fs');
const { originalDeviceOutcome, deviceCommandProof } = require('./ios-device-outcome');
const { initializationProof, recoverLegacySetup } = require('./ios-wda-startup');
const managed = require('./shared-kernel/managed-sdk-execution');
const { runDeviceEffect } = require('./shared-kernel/device-mutation-lease');
const { checkExecution, runExecution } = require('./shared-kernel/execution-scope');

const schemas = { h5: 'aab.h5-execution/v1', flutter: 'aab.flutter-execution/v1', wda: 'aab.wda-execution/v1' };

function iosDeviceKey(device) {
  if (typeof device?.udid !== 'string' || !device.udid) {
    throw new CommandError('ios_device_identity_unavailable', 'devicectl must supply the physical iOS UDID before mutation or recovery.');
  }
  return `ios:${device.udid}`;
}

async function lookupCompletion(port, kind, identity, first) {
  let page = first;
  let after = 0;
  let through;
  let cursor;
  while (true) {
    checkExecution();
    if (!page) {
      const query = new URLSearchParams({ ...(kind === 'wda' ? {} : { kind }), ...identity, ...(cursor === undefined ? {} : { cursor }) });
      page = await port.get(`${kind === 'wda' ? '/aab/execution/result' : '/v1/execution/result'}?${query}`);
    }
    if (page.ok !== true) return page;
    if (page.executionResult) {
      if (page.actionId !== identity.actionId || page.runtimeEpoch !== identity.runtimeEpoch
        || !managed.terminalReceipt(schemas[kind], page.executionResult, identity)) {
        return { ok: false, error: 'invalid_ios_completion_receipt', settled: false };
      }
      return page;
    }
    if (page.found !== false || typeof page.hasMore !== 'boolean') return { ok: false, error: 'invalid_ios_completion_page', settled: false };
    if (!page.hasMore) return { ok: false, error: 'ios_original_completion_unavailable', settled: false, ...identity };
    if (!Number.isSafeInteger(page.nextSequence) || page.nextSequence <= after
      || !Number.isSafeInteger(page.throughSequence) || page.nextSequence >= page.throughSequence
      || typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor.length > 2048
      || (through !== undefined && page.throughSequence !== through)) {
      return { ok: false, error: 'invalid_ios_completion_cursor', settled: false };
    }
    after = page.nextSequence; through = page.throughSequence; cursor = page.nextCursor; page = null;
  }
}

async function executeIOSAction({ port, kind, payload, status, target, timeoutMs, actionId }) {
  if (kind === 'h5' && status.debugBridge?.h5TargetSchema !== require('./shared-kernel/ios-h5-target').schema) {
    return { ok: false, error: 'ios_h5_target_schema_required', dispatched: false, ambiguous: false,
      message: 'Update the selected App SDK to one that binds H5 actions to observed WebViews and documents.' };
  }
  const runtime = kind === 'h5'
    ? { runtimeEpoch: status.debugBridge?.runtimeEpoch, executionSchema: status.debugBridge?.h5ExecutionSchema }
    : { runtimeEpoch: status.flutter?.layout?.operable?.runtimeEpoch, executionSchema: status.debugBridge?.flutterExecutionSchema };
  if (runtime.executionSchema !== schemas[kind] || typeof runtime.runtimeEpoch !== 'string' || !runtime.runtimeEpoch) {
    return { ok: false, error: 'ios_managed_execution_unavailable', dispatched: false, ambiguous: false,
      message: 'The selected iOS SDK/Flutter engine must advertise managed execution before an action can run.' };
  }
  const identity = { actionId: actionId ?? randomUUID(), runtimeEpoch: runtime.runtimeEpoch };
  return runDeviceEffect({ kind: `ios-${kind}`, ...identity, target }, async () => {
    const result = await managed.executeManagedAction({ kind, schema: schemas[kind], runtime, payload,
      actionId: identity.actionId, timeoutMs,
      send: request => port.post(kind === 'h5' ? '/v1/h5/action' : '/v1/flutter/action', request),
      cancel: original => runExecution({ timeoutMs: 4000 }, async () => {
        const cancelled = await port.post(`/v1/${kind}/cancel`, original);
        if (cancelled.ok !== true) return cancelled;
        return lookupCompletion(port, kind, original, cancelled);
      }),
    });
    return { ...result, executionReceipt: managed.settlementProof(`ios-${kind}`, schemas[kind], result, identity) };
  }, result => result.executionReceipt);
}

async function reconcileIOS({ lease, device, args, createPort, readWdaTestSummary }) {
  const original = args.setupResultPath ? lease.status(iosDeviceKey(device)).ownership : null;
  const result = await lease.reconcile(iosDeviceKey(device), async pending => {
    if (pending.target?.deviceId !== device.udid
        || args.bundleId && pending.target?.bundleId && pending.target.bundleId !== args.bundleId) {
      return { settled: false, error: 'ios_original_completion_identity_required' };
    }
    if (pending.kind === 'ios-wda-start' || pending.kind === 'ios-command' && pending.command === 'ios-setup') {
      try {
        const proof = pending.kind === 'ios-wda-start'
          ? initializationProof(await readWdaTestSummary(pending.invocation.resultBundlePath), pending.invocation, device.udid)
          : original?.pending?.id === pending.id && await recoverLegacySetup({ pending, owner: original.owner,
            resultPath: args.setupResultPath, device, readSummary: readWdaTestSummary });
        return proof || { settled: false, error: 'ios_original_wda_startup_outcome_unresolved' };
      } catch (error) { return { settled: false, error: 'ios_wda_startup_completion_unavailable', cause: error.code || 'invalid_result' }; }
    }
    if (args.setupResultPath) return { settled: false, error: 'ios_original_completion_identity_required' };
    if (pending.kind === 'ios-command') {
      const invocation = pending.invocation;
      const index = Array.isArray(invocation?.arguments) ? invocation.arguments.indexOf('--json-output') : -1;
      if (!invocation?.resultPath || index < 0 || invocation?.arguments?.[index + 1] !== invocation.resultPath) {
        return { settled: false, error: 'ios_original_command_identity_unavailable' };
      }
      try {
        const reply = JSON.parse(await fs.promises.readFile(invocation.resultPath, 'utf8'));
        const outcome = originalDeviceOutcome(reply, invocation.arguments);
        return outcome ? deviceCommandProof(outcome, invocation)
          : { settled: false, error: 'ios_original_command_outcome_unresolved' };
      } catch (error) { return { settled: false, error: 'ios_command_completion_unavailable', cause: error.code || 'invalid_json' }; }
    }
    const kind = pending.kind === 'ios-h5' ? 'h5' : pending.kind === 'ios-flutter' ? 'flutter' : null;
    if (!kind
      || typeof pending.actionId !== 'string' || typeof pending.runtimeEpoch !== 'string') {
      return { settled: false, error: 'ios_original_completion_identity_required' };
    }
    const identity = { actionId: pending.actionId, runtimeEpoch: pending.runtimeEpoch };
    try {
      // Reconnect to the original device/App. The process serving durable
      // history may be new; the queried action/epoch can never be replaced.
      const target = { ...pending.target, timeoutMs: args.timeoutMs ?? 30000 };
      if (args.runtimeUrl !== undefined) {
        delete target.iosHost; delete target.iosPort; target.runtimeUrl = args.runtimeUrl;
      } else if (args.iosHost !== undefined || args.iosPort !== undefined) {
        delete target.runtimeUrl;
        for (const key of ['iosHost', 'iosPort']) if (args[key] !== undefined) target[key] = args[key];
      }
      if (args.devicectl !== undefined) target.devicectl = args.devicectl;
      const port = await createPort(target);
      const reply = await lookupCompletion(port, kind, identity);
      if (reply.ok !== true || reply.receipt?.committed !== true
        || !Number.isSafeInteger(reply.receipt?.sequence) || reply.receipt.sequence < 1
        || !/^[a-f0-9]{64}$/.test(reply.receipt?.sha256)) {
        return { settled: false, error: reply.error || 'ios_durable_completion_required' };
      }
      return managed.settlementProof(`ios-${kind}`, schemas[kind], reply.executionResult, identity)
        || { settled: false, error: 'invalid_ios_completion_receipt' };
    } catch (error) { return { settled: false, error: error.code || 'ios_completion_query_failed', message: error.message }; }
  });
  if (result.recovered && result.executionReceipt?.kind === 'ios-command') {
    try { await fs.promises.rm(result.executionReceipt.invocation.resultPath, { force: true }); }
    catch (error) { result.cleanupError = error.code || 'ios_command_receipt_cleanup_failed'; }
  }
  return result;
}

module.exports = { iosDeviceKey, executeIOSAction, lookupCompletion, reconcileIOS };
