'use strict';

const { getProcessDeviceMutationLease } = require('./device-mutation-lease');
const protocols = { flutter: require('./flutter-execution'), native: require('./native-execution'), h5: require('./h5-execution') };
const shellProtocol = require('./android-shell-execution');
const installProtocol = require('./android-install-execution');
const { cancellationProof } = require('./android-install-cancellation');
const uiaProtocol = require('./uia-protocol');
const { createUiaRuntimePort } = require('./uia-runtime-port');
const acknowledgements = require('./device-acknowledgements');

async function deviceOwnership(args, { lease = getProcessDeviceMutationLease(), ports,
  shellPortFactory = shellProtocol.createAndroidShellPort, installPortFactory = installProtocol.createAndroidInstallPort,
  uiaPortFactory = createUiaRuntimePort } = {}) {
  if (args.operation === 'status') return lease.status(args.serial);
  if (args.operation === 'receipt') return require('./device-completion-history').readCompletion(args);
  const bridge = ports || require('../device-provider');
  const installCleanup = [];
  const recovered = await lease.reconcile(args.serial, async pending => {
    if (args.operation === 'cancel-install' && (pending.kind !== 'android-install' || pending.actionId !== args.actionId))
      return { settled: false, error: 'install_action_mismatch', actionId: pending.actionId };
    if (pending.kind === 'android-test-executor') {
      try { return await require('../executors/android-host').recoverAndroidExecutor(pending); }
      catch (error) { return { settled: false, error: error.code || 'executor_completion_query_failed', message: error.message }; }
    }
    if (pending.kind === 'flutter-test-executor') {
      try { return await require('../executors/flutter-host').recoverFlutterExecutor(pending); }
      catch (error) { return { settled: false, error: error.code || 'executor_completion_query_failed', message: error.message }; }
    }
    if (pending.kind === 'uia-node') {
      if (!uiaProtocol.validIdentity(pending) || pending.target.serial !== args.serial) return { settled: false, error: 'invalid_uia_execution_identity' };
      try {
        const port = uiaPortFactory({ ...pending.target, timeoutMs: args.timeoutMs ?? 5000 });
        const result = await port.recover(pending);
        const proof = uiaProtocol.settlementProof(result, pending);
        if (!proof) return { settled: false, error: result?.error || 'uia_original_completion_unavailable', actionId: pending.actionId };
        return proof;
      } catch (error) { return { settled: false, error: error.code || 'uia_completion_query_failed', message: error.message }; }
    }
    if (pending.kind === 'android-install') {
      if (pending.target?.serial !== args.serial || typeof pending.target.adb !== 'string' || !installProtocol.validIdentity(pending)) {
        return { settled: false, error: 'invalid_install_execution_identity' };
      }
      try {
        const port = installPortFactory({ ...pending.target, timeoutMs: args.timeoutMs ?? 5000 });
        let result, readError;
        try { result = await port.read(pending, true); }
        catch (error) { readError = error; }
        const proof = installProtocol.settlementProof(result, pending);
        if (proof) {
          installCleanup.push({ port, pending, result });
          return proof;
        }
        const cancellation = args.operation === 'cancel-install' ? await port.cancelInstall(pending) : await port.readCancellation?.(pending);
        const cancelled = cancellationProof(cancellation, pending);
        if (!cancelled) return { settled: false, error: readError?.code || 'install_completion_unavailable', actionId: pending.actionId };
        installCleanup.push({ port, pending, result: cancellation, cancelled: true });
        return cancelled;
      } catch (error) { return { settled: false, error: error.code || 'install_completion_query_failed' }; }
    }
    if (pending.kind === 'android-shell') {
      if (pending.target?.serial !== args.serial || typeof pending.target.adb !== 'string') {
        return { settled: false, error: 'remote_completion_proof_unavailable' };
      }
      try {
        const port = shellPortFactory({ ...pending.target, timeoutMs: args.timeoutMs ?? 5000 });
        const result = await port.cancel(pending);
        return shellProtocol.settlementProof(result, pending)
          || { settled: false, error: result?.error || 'shell_action_not_settled', actionId: pending.actionId };
      } catch (error) {
        return { settled: false, error: error.code || 'remote_completion_query_failed', message: error.message };
      }
    }
    const protocol = protocols[pending.kind];
    if (!protocol || typeof pending.actionId !== 'string' || typeof pending.runtimeEpoch !== 'string'
        || typeof pending.target?.packageName !== 'string') return { settled: false, error: 'remote_completion_proof_unavailable' };
    const identity = { actionId: pending.actionId, runtimeEpoch: pending.runtimeEpoch };
    const ctx = bridge.createBridgeContext({ ...pending.target, serial: args.serial, timeoutMs: args.timeoutMs ?? 5000 });
    try {
      // Re-discover and verify this phone/package connection. A changed runtime,
      // missing action or idle SDK alone is never proof that this action ended.
      const completion = { native: bridge.nativeCompletion, flutter: bridge.flutterCompletion, h5: bridge.h5Completion }[pending.kind];
      const reply = await completion(ctx, identity);
      if (reply?.ok !== true || reply.actionId !== identity.actionId || reply.runtimeEpoch !== identity.runtimeEpoch
          || !protocol.terminalReceipt(reply.executionResult, identity)) return {
        settled: false, error: reply?.error || `invalid_${pending.kind}_cancel_receipt`, actionId: identity.actionId,
      };
      return protocol.settlementProof(reply.executionResult, identity);
    } catch (error) { return { settled: false, error: error.code || 'remote_completion_query_failed', message: error.message }; }
  });
  // Reconciliation fsyncs each exact proof before its phone copy may be retired.
  // Even a later unresolved reservation cannot invalidate an earlier settlement.
  for (const { port, pending, result, cancelled } of installCleanup) {
    try { await (cancelled ? port.acknowledgeCancellation(pending, result) : port.acknowledge(pending, result)); }
    catch (error) { (recovered.cleanupErrors ||= []).push({ actionId: pending.actionId, error: error.code || 'install_cleanup_failed' }); }
  }
  if (recovered.error !== 'target_busy') {
    // This queue survives a Host exit even when there is no unresolved effect.
    // Retiring an older known receipt never clears a different pending action.
    const cleanup = await lease.drainAcknowledgements(args.serial, async ({ pending, proof }) => {
      const port = uiaPortFactory({ ...pending.target, timeoutMs: args.timeoutMs ?? 5000 });
      return port.acknowledge(pending, acknowledgements.completion(pending, proof));
    });
    if (!cleanup.ok) (recovered.cleanupErrors ||= []).push({ error: cleanup.error });
    else {
      recovered.pendingAcknowledgements = cleanup.remaining;
      if (cleanup.retired.length) recovered.acknowledgements = cleanup.retired;
      if (cleanup.errors.length) (recovered.cleanupErrors ||= []).push(...cleanup.errors);
    }
  }
  if (args.operation === 'cancel-install' && recovered.ok && recovered.recovered === false) {
    return { ...recovered, ok: false, error: 'install_action_not_pending', actionId: args.actionId,
      message: 'No pending installation matches this action. Nothing was cancelled; read the original installation result to determine its outcome.',
      dispatched: false, ambiguous: false };
  }
  return recovered;
}

module.exports = { deviceOwnership };
