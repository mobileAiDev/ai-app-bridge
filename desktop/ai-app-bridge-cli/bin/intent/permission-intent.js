'use strict';

const { normalizeExecutionTarget } = require('../shared-kernel/execution-target');

const { CommandError, executionFields } = require('../command-errors');
const { readPermissionState, readPermissionRequest } = require('../android-permissions');
const { getProcessDeviceMutationLease } = require('../shared-kernel/device-mutation-lease');
const { checksumOf } = require('../shared-kernel/evidence-schema');
const { createIntentWorker } = require('./intent-worker');
const { createProductionIntentDeviceAdapter } = require('./intent-production-adapter');

const sameState = (a, b) => a.uid === b.uid && a.userId === b.userId && a.granted === b.granted && JSON.stringify(a.flags) === JSON.stringify(b.flags);
const sameRequest = (a, b) => a && b && ['token', 'component', 'userId', 'requesterPackage', 'requesterUid'].every(key => a[key] === b[key]);
const rejection = error => ({ ok: false, error, dispatched: false, ambiguous: false });

function permissionDeviceAdapter({ args, origin, expectedState, canDispatch, onDispatch, onFailure, readState, readRequest, ports }) {
  const bridge = ports || require('../device-provider');
  let selectedRequest = null;
  function providerResult(result, stage) {
    if (result.ok || !result.error || /^[a-z][a-z0-9_]+$/.test(result.error)) return result;
    const error = `permission_ui_${stage}_failed`;
    onFailure({ stage, error, message: String(result.error).slice(0, 2048) });
    return { ...result, error };
  }
  async function input(action) {
    let state; let request;
    try {
      state = await readState(args);
      if (!sameState(expectedState(), state)) return rejection('permission_state_changed');
      request = await readRequest(args);
      if (!sameRequest(origin(), request.request) || !sameRequest(selectedRequest, request.request)) return rejection('permission_request_changed');
    } catch (error) { return rejection(error.code || 'permission_query_failed'); }
    if (!canDispatch()) return rejection('cancelled');
    onDispatch();
    try {
      return { ...await action(), precondition: { request, state } };
    } catch (error) {
      return { ok: false, error: 'permission_input_failed', dispatched: error.code === 'ENOENT' ? false : true,
        ambiguous: error.code !== 'ENOENT', cause: error.code || null, precondition: { request, state }, ...executionFields(error) };
    }
  }
  const base = createProductionIntentDeviceAdapter({ adb: args.adb, ports: {
    ...bridge,
    uiaTap: (ctx, binding, options) => input(() => bridge.uiaTap(ctx, binding, options)),
    keyevent: ctx => input(() => bridge.keyevent(ctx, 4)),
  } });
  return {
    async observe(request) {
      try {
        const before = await readRequest(args);
        if (!sameRequest(origin(), before.request)) return rejection('permission_request_changed');
        const observed = await base.observe({ ...request, provider: 'uia', packageName: before.request.packageName, foregroundPackages: [] });
        if (!observed.ok) return providerResult(observed, 'observation');
        const after = await readRequest(args);
        if (!sameRequest(before.request, after.request) || after.request.component !== `${observed.route.packageName}/${observed.route.activity}`) return rejection('permission_request_changed');
        return { ...observed, route: { ...observed.route, permissionRequest: after.request } };
      } catch (error) { return rejection(error.code || 'permission_request_query_failed'); }
    },
    async action(request) {
      selectedRequest = request.route?.permissionRequest;
      if (!sameRequest(origin(), selectedRequest)) return rejection('permission_request_changed');
      return providerResult(await base.action({ ...request, primaryProvider: 'uia', foregroundPackages: [origin().packageName],
        spec: { ...request.spec, provider: 'uia', exact: true, requireClickable: true } }), 'action');
    },
  };
}

async function createPermissionIntent({ args, operationId, store, recording, dependencies = {} }) {
  const ownership = (dependencies.lease || getProcessDeviceMutationLease()).acquire(args.serial);
  if (!ownership.ok) throw new CommandError(ownership.error, 'The device is owned by another operation.', { details: { serial: args.serial } });
  const readState = dependencies.readState || readPermissionState;
  const readRequest = dependencies.readRequest || readPermissionRequest;
  const bound = { ...args };
  const target = normalizeExecutionTarget({ platform: 'android', serial: args.serial, packageName: args.packageName, foregroundPackages: [],
    ...(args.adb === undefined ? {} : { adb: args.adb }) }, { intent: true });
  let worker; let active = null; let finalizing = null; let final = false; let stopping = null; let timer; let deadline = Infinity;
  let expected; let origin; let dispatched = false; let ownedReceipt = null;
  const permissionDialog = { kind: 'permission-dialog', permission: args.permission, outcome: args.outcome,
    phase: 'preparing', before: null, after: null, requestBefore: null, requestAfter: null, verified: false, actionCount: 0 };
  try {
    const adapter = permissionDeviceAdapter({ args: bound, origin: () => origin, expectedState: () => expected,
      canDispatch: () => Date.now() < deadline && !stopping && !finalizing && !final && worker.context.canDispatch(),
      onDispatch: () => { dispatched = true; permissionDialog.actionCount++; }, readState, readRequest,
      onFailure: failure => { permissionDialog.providerFailure = failure; },
      ports: dependencies.ports });
    worker = createIntentWorker({ operationId, target, ownsOutcome: false, timeoutMs: null, provider: 'uia', store, recording, adapter,
      goal: `Resolve the observed runtime permission request from ${args.packageName}: ${args.outcome} ${args.permission}. Read the actual UI and select exactly one visible control. Completion requires PackageManager state and closure of this Activity instance. No recording or other App action is part of this workflow.` });
  } catch (error) { ownership.release(); throw error; }
  function snapshot() {
    return { ...worker.status(), permissionDialog: { ...permissionDialog } };
  }
  async function persist(kind, record) {
    const result = await store.persist(kind, { operationId, target, revision: worker.runtime.state.revision, timestampMs: Date.now(), ...record });
    if (!result.ok) throw new CommandError(result.error || 'permission_evidence_failed', 'Permission evidence could not be committed.');
    return result;
  }
  async function inspect() {
    permissionDialog.after = await readState(bound);
    permissionDialog.requestAfter = await readRequest(bound);
    permissionDialog.dialogClosed = !permissionDialog.requestAfter.activeRequestTokens.includes(origin.token);
    permissionDialog.pending = !permissionDialog.dialogClosed && !permissionDialog.requestAfter.request ? 'activity_closure' : null;
  }
  async function verify() {
    await inspect();
    if (permissionDialog.after.uid !== permissionDialog.before.uid) return { status: 'intervention_required', error: 'permission_target_changed' };
    const request = permissionDialog.requestAfter.request;
    if (request && !sameRequest(origin, request)) return { status: 'intervention_required', error: 'permission_request_changed' };
    if (!ownedReceipt) {
      if (permissionDialog.dialogClosed || !sameState(expected, permissionDialog.after)) return { status: 'intervention_required', error: 'permission_changed_without_owned_action' };
      return null;
    }
    expected = permissionDialog.after;
    if (!permissionDialog.dialogClosed) {
      if (permissionDialog.pending) {
        worker.runtime.state.status = 'waiting_for_observation'; worker.runtime.state.error = null;
      }
      return null;
    }
    const after = permissionDialog.after;
    const matches = args.outcome === 'allow' ? after.granted && !after.flags.includes('ONE_TIME')
      : args.outcome === 'allow-once' ? after.granted && after.flags.includes('ONE_TIME')
      : args.outcome === 'deny' ? !after.granted && after.flags.includes('USER_SET')
      : sameState(permissionDialog.before, after);
    permissionDialog.verified = matches;
    return matches ? { status: 'completed', error: null } : { status: 'failed', error: 'permission_outcome_mismatch' };
  }
  function finish(verdict) {
    if (finalizing) return finalizing;
    clearTimeout(timer);
    worker.runtime.state.status = 'finishing';
    finalizing = (async () => {
      try {
        await worker.quiesce();
        worker.runtime.state.status = 'finishing';
        if (verdict.status !== 'completed') {
          permissionDialog.verified = false;
          // Cancel stops this operation, never presses Back and never rolls back
          // an Android grant. Report the final observed state after in-flight I/O.
          try { if (origin) await inspect(); }
          catch (error) { permissionDialog.verificationError = error.code || 'permission_query_failed'; }
        }
        permissionDialog.phase = verdict.status;
        const proof = await persist('checkpoint', { stepId: 'permission-outcome', payloadSummary: { ...verdict, permissionDialog: { ...permissionDialog } } });
        permissionDialog.verificationEvidenceId = proof.evidenceId;
        worker.runtime.state.status = verdict.status; worker.runtime.state.error = verdict.error;
        worker.runtime.emit('permission_verified', { status: verdict.status, verified: permissionDialog.verified, evidenceId: proof.evidenceId });
      } catch (error) {
        permissionDialog.phase = 'blocked_evidence_store'; permissionDialog.verified = false;
        worker.runtime.state.status = 'blocked_evidence_store'; worker.runtime.state.error = error.code || 'permission_evidence_failed';
      } finally { final = true; ownership.release(); }
      return snapshot();
    })();
    return finalizing;
  }
  async function stop(status, error) {
    if (final || finalizing) { await finalizing; return snapshot(); }
    stopping ||= { status, error };
    const uiStopped = worker.cancel();
    await uiStopped;
    await active;
    return finish(stopping);
  }
  async function run(fn) {
    if (final || finalizing || stopping) return { ...snapshot(), ok: false, error: 'operation_stopped' };
    if (active) return { ...snapshot(), ok: false, error: 'operation_busy' };
    let result; let verdict;
    active = ownership.run(async () => {
      try { ({ result, verdict } = await fn()); }
      catch (error) { verdict = { status: dispatched ? 'inconclusive' : 'failed', error: error.code || 'permission_verification_failed' }; }
    });
    await active;
    active = null;
    if (Date.now() >= deadline) stopping ||= { status: 'timeout', error: 'permission_dialog_timeout' };
    if (stopping) return finish(stopping);
    if (verdict) return finish(verdict);
    permissionDialog.phase = worker.runtime.state.status;
    return { ...snapshot(), ...(result ? { ok: result.ok, error: result.error } : {}) };
  }
  function workerFailure(result) {
    return ['failed', 'ambiguous', 'blocked_evidence_store'].includes(result.status) ? { status: result.status, error: result.error } : null;
  }
  return {
    ...worker, isManagedWorkflow: true, isFinished: () => final, status: snapshot,
    start: () => run(async () => {
      deadline = Date.now() + (args.timeoutMs || 60000);
      timer = setTimeout(() => { stop('timeout', 'permission_dialog_timeout'); }, args.timeoutMs || 60000); timer.unref?.();
      permissionDialog.before = expected = await readState(bound);
      bound.userId = expected.userId;
      permissionDialog.requestBefore = await readRequest(bound);
      origin = permissionDialog.requestBefore.request;
      if (!origin) throw new CommandError('permission_dialog_not_found', 'Trigger a runtime permission request through the App before starting permission-dialog.');
      if (origin.requesterPackage !== args.packageName || origin.requesterUid !== expected.uid || origin.userId !== expected.userId) {
        throw new CommandError('permission_requester_mismatch', 'The visible runtime permission request belongs to a different App or Android user.');
      }
      const plan = await persist('plan', { planStepId: 'permission-request', actionSpecHash: checksumOf({ target, outcome: args.outcome, permission: args.permission }),
        payloadSummary: { permissionDialog: { ...permissionDialog } } });
      permissionDialog.planEvidenceId = plan.evidenceId;
      if (stopping) return {};
      const result = await worker.start();
      return { result, verdict: result.ok ? null : { status: 'inconclusive', error: result.error } };
    }),
    observe: options => run(async () => {
      const verdict = await verify();
      if (verdict || stopping) return { verdict };
      if (permissionDialog.pending) return { result: { ok: true, error: null } };
      const result = await worker.observe(options);
      return { result, verdict: workerFailure(result) };
    }),
    decide: decision => run(async () => {
      const action = decision?.action;
      const allowed = action?.action === 'tap' && action.selector && Object.keys(action).every(key => ['action', 'selector', 'provider', 'exact', 'requireClickable'].includes(key))
        || args.outcome === 'dismiss' && action?.action === 'back' && Object.keys(action).every(key => ['action', 'provider'].includes(key));
      if (decision?.agentDecision !== 'act' || !allowed || action?.exact === false || action?.provider && action.provider !== 'uia') {
        return { result: { ok: false, error: 'permission_requires_observed_decision', message: 'Use an exact observed tap; dismiss also accepts back. Completion is verified independently. Use intent cancel to stop the operation.' } };
      }
      const previous = worker.context.latestEvidenceIds.receipt;
      const result = await worker.decide(decision);
      const failure = workerFailure(result);
      if (failure || stopping) return { result, verdict: failure };
      const receiptId = worker.context.latestEvidenceIds.receipt;
      if (receiptId && receiptId !== previous) {
        const receipt = store.read(receiptId);
        if (!receipt.ok || receipt.record.mechanicalStatus !== 'ok' || receipt.record.ambiguous || !receipt.record.dispatched) {
          return { verdict: { status: 'inconclusive', error: 'permission_action_not_verified' } };
        }
        permissionDialog.actionEvidenceId = ownedReceipt = receiptId;
        const verdict = await verify();
        return { result: permissionDialog.pending ? { ok: true, error: null } : result, verdict };
      }
      return { result };
    }),
    cancel: () => stop('cancelled', 'permission_dialog_cancelled'),
    intervene: reason => stop('intervention_required', reason || 'permission_dialog_intervened'),
    pause() { if (!active && !finalizing && !stopping && !final) worker.pause(); return snapshot(); },
    resume() { if (!active && !finalizing && !stopping && !final) worker.resume(); return snapshot(); },
  };
}

module.exports = { createPermissionIntent, permissionDeviceAdapter, sameState, sameRequest };
