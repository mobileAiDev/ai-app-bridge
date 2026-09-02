'use strict';

const { executeStep } = require('./script-executor');
const { createScriptRuntime } = require('./script-runtime');
const { scriptError } = require('./script-errors');

function emptyTimings() {
  return {
    workerOverheadMs: 0,
    targetLeaseWaitMs: 0,
    providerAcquireMs: 0,
    evidenceCommitMs: 0,
    summaryMs: 0,
    decisionWaitMs: 0,
    actionMs: 0,
    receiptCommitMs: 0,
    totalMs: 0,
  };
}

function createScriptWorker({
  operationId,
  compiled,
  store,
  adapter,
  timeoutMs = null,
  restore = null,
  now = Date.now,
} = {}) {
  const runtime = createScriptRuntime({ operationId, script: compiled, now });
  let pauseRequested = false;
  let cancelled = false;
  let running = null;
  let latestSummary = null;
  let latestEvidenceId = null;
  let latestRawTree = null;
  let latestProvider = null;
  const latestEvidenceIds = {};
  const timings = emptyTimings();
  const startedAt = now();
  if (restore) {
    runtime.state.status = restore.status || 'paused_manual';
    runtime.state.stepIndex = restore.stepIndex || 0;
    runtime.state.completedStepIds = Array.isArray(restore.completedStepIds) ? restore.completedStepIds.slice() : [];
    runtime.state.pauseReason = restore.pauseReason || 'pause_requested';
    if (restore.summary) latestSummary = restore.summary;
    if (restore.evidenceId) latestEvidenceId = restore.evidenceId;
    if (restore.rawTree) latestRawTree = restore.rawTree;
    if (restore.provider) latestProvider = restore.provider;
    if (restore.evidenceIds) Object.assign(latestEvidenceIds, restore.evidenceIds);
  }

  async function start() {
    runtime.state.status = 'running';
    runtime.emit('script_started');
    running = run();
    return running;
  }

  async function run() {
    const loopStarted = now();
    const context = {
      operationId,
      revision: 1,
      target: compiled.script.target,
      store,
      adapter,
      now,
      stepIndex: runtime.state.stepIndex,
      completedStepIds: runtime.state.completedStepIds,
      latestSummary,
      latestEvidenceId,
      latestRawTree,
      latestProvider,
      latestEvidenceIds,
      lastActionReceipt: null,
      timings,
      compiledScript: compiled.script,
      scriptHash: compiled.hash,
    };
    for (let index = runtime.state.stepIndex; index < compiled.script.steps.length; index += 1) {
      if (cancelled) {
        runtime.state.status = 'cancelled';
        runtime.state.pauseReason = 'cancelled';
        return snapshotResult(false);
      }
      if (timeoutMs != null && now() - startedAt >= timeoutMs) {
        runtime.state.status = 'paused_failure';
        runtime.state.pauseReason = 'execution_failure';
        runtime.state.error = 'timeout';
        runtime.state.failedStepId = compiled.script.steps[index].id;
        runtime.emit('paused', { stepId: compiled.script.steps[index].id, error: 'timeout' });
        return snapshotResult(false);
      }
      const step = compiled.script.steps[index];
      context.stepIndex = index;
      runtime.state.stepIndex = index;
      runtime.emit('step_started', { stepId: step.id, type: step.type });
      const result = await executeStep(step, context);
      latestSummary = context.latestSummary;
      latestEvidenceId = context.latestEvidenceId;
      timings.workerOverheadMs = Math.max(0, now() - loopStarted - timings.providerAcquireMs - timings.actionMs);
      timings.totalMs = now() - startedAt;
      if (result.ok !== true) {
        runtime.state.status = result.ambiguous ? 'ambiguous' : 'paused_failure';
        runtime.state.pauseReason = result.pauseReason || 'execution_failure';
        runtime.state.failedStepId = result.failedStepId || step.id;
        runtime.state.error = result.error;
        runtime.emit('paused', { stepId: step.id, error: result.error });
        return snapshotResult(false);
      }
      runtime.state.completedStepIds.push(step.id);
      runtime.state.stepIndex = index + 1;
      runtime.emit(step.type === 'checkpoint' ? 'checkpoint_committed' : 'step_completed', {
        stepId: step.id,
        adbTimings: result.adbTimings || [],
      });
      if (pauseRequested) {
        runtime.state.status = 'paused_manual';
        runtime.state.pauseReason = 'pause_requested';
        const recovered = await persistRecovery(context, step.id, index + 1, 'paused_manual');
        if (!recovered.ok) {
          runtime.state.status = 'paused_failure';
          runtime.state.error = recovered.error;
          return snapshotResult(false);
        }
        runtime.emit('paused', { stepId: step.id });
        return snapshotResult(true);
      }
    }
    timings.totalMs = now() - startedAt;
    runtime.state.status = 'completed';
    const recovered = await persistRecovery(context, 'completed', runtime.state.stepIndex, 'completed');
    if (!recovered.ok) {
      runtime.state.status = 'paused_failure';
      runtime.state.error = recovered.error;
      return snapshotResult(false);
    }
    runtime.emit('script_completed');
    return snapshotResult(true);
  }

  async function persistRecovery(context, stepId, nextIndex, status = 'paused_manual') {
    const persisted = await store.persist('checkpoint', {
      operationId,
      revision: context.revision,
      stepId,
      currentStepIndex: nextIndex,
      completedStepIds: runtime.state.completedStepIds.slice(),
      latestEvidenceRevision: context.revision,
      script: compiled.script,
      hash: compiled.hash,
      status,
    });
    if (persisted.ok) {
      latestEvidenceIds.checkpoint = persisted.evidenceId;
      return persisted;
    }
    return { ok: false, error: persisted.error || 'checkpoint_not_persisted' };
  }

  function pause() {
    pauseRequested = true;
    runtime.emit('pause_requested');
    return snapshotResult(true);
  }

  async function resume() {
    if (runtime.state.status !== 'paused_manual') {
      return scriptError('not_resumable', runtime.snapshot());
    }
    pauseRequested = false;
    runtime.state.status = 'running';
    runtime.emit('resumed');
    running = run();
    return running;
  }

  function cancel() {
    cancelled = true;
    pauseRequested = true;
    runtime.state.status = 'cancelled';
    runtime.state.pauseReason = 'cancelled';
    runtime.emit('script_cancelled');
    return snapshotResult(false);
  }

  function status(query = {}) {
    return snapshotResult(
      runtime.state.status === 'completed'
      || runtime.state.status === 'running'
      || runtime.state.status === 'created'
      || runtime.state.status === 'paused_manual',
      query,
    );
  }

  function snapshotResult(ok, query = {}) {
    timings.totalMs = now() - startedAt;
    return {
      ok,
      ...runtime.snapshot({
        afterSequence: query.afterSequence,
        eventLimit: query.eventLimit,
      }),
      summary: latestSummary,
      evidenceId: latestEvidenceId,
      latestEvidenceIds: { ...latestEvidenceIds },
      timings: { ...timings },
    };
  }

  return { operationId, start, pause, resume, cancel, status, runtime };
}

module.exports = { createScriptWorker };
