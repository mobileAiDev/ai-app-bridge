'use strict';

const { executeDecisionAction } = require('./intent-action-executor');
const { intentError } = require('./intent-errors');
const { intentProviderError } = require('./intent-provider');
const { observeAndCommit } = require('./intent-observer');
const { createIntentRuntime } = require('./intent-runtime');
const { createIntentLifetime, awaitAgentReply } = require('./intent-lifetime');
const { checkExecution } = require('../shared-kernel/execution-scope');
const { validateValue } = require('../shared-kernel/argument-schema');
const { intentDecisionSchema } = require('../shared-kernel/execution-contracts');
const { CommandError } = require('../command-errors');
const { normalizeIntentTarget, normalizeObservationTarget } = require('./intent-observation-target');

function createIntentWorker({
  operationId,
  goal,
  target: requestedTarget,
  provider = 'native',
  observationTarget = null,
  store,
  adapter,
  mode = 'supervised',
  agent = null,
  budget = null,
  timeoutMs = 300000,
  ownsOutcome = true,
  now = Date.now,
  capturePort = null,
  captureRequirements = null,
  recording = null,
} = {}) {
  const target = normalizeIntentTarget(requestedTarget);
  const runtime = createIntentRuntime({ operationId, now });
  runtime.state.mode = mode;
  const context = {
    operationId,
    revision: 1,
    target,
    provider,
    observationTarget: normalizeObservationTarget(target, provider, observationTarget),
    observationFailure: null,
    store,
    adapter,
    mode,
    now,
    capturePort,
    captureRequirements,
    recording,
    canDispatch: () => !stopping && !timedOut() && runtime.state.status === 'decision_committed',
    latestSummary: null,
    latestEvidenceId: null,
    latestEvidenceIds: {},
    timings: {
      workerOverheadMs: 0,
      targetLeaseWaitMs: 0,
      providerAcquireMs: 0,
      evidenceCommitMs: 0,
      summaryMs: 0,
      decisionWaitMs: 0,
      actionMs: 0,
      receiptCommitMs: 0,
      totalMs: 0,
    },
  };
  let stopAutonomous = false;
  let actionSteps = 0;
  let agentCalls = 0;
  let startedAt = now();
  let stopping = null;
  let finalizing = null;
  let finished = false;
  let agentController = null;
  let terminalEvidenceId = null;
  const effectiveTimeoutMs = timeoutMs === null ? null : Math.min(timeoutMs, budget?.maxDurationMs ?? Infinity);
  const lifetime = createIntentLifetime({ timeoutMs: effectiveTimeoutMs, onDeadline: () => {
    requestStop('timeout', 'deadline_exceeded'); void finish();
  } });

  function requestStop(status, error = null) {
    if (stopping || finished) return;
    stopping = { status, error };
    stopAutonomous = true;
    runtime.state.status = status === 'cancelled' ? 'cancelling' : 'finishing';
    runtime.state.error = error;
    const code = status === 'timeout' ? 'deadline_exceeded' : status === 'cancelled' ? 'cancelled' : 'runtime_stopped';
    lifetime.stop(code);
    agentController?.abort({ code });
    runtime.emit('stop_requested', { requestedStatus: status, error });
  }

  function finish() {
    if (finalizing) return finalizing;
    if (!stopping) return Promise.resolve(snapshotResult(false));
    finalizing = (async () => {
      await lifetime.drain();
      try {
        if (ownsOutcome) {
          const payloadSummary = { lifecycle: 'aab.intent-lifecycle/v1', ...stopping, goal, target, provider: context.provider,
            observationTarget: context.observationTarget, observationFailure: context.observationFailure,
            mode: context.mode, revision: runtime.state.revision, lastDecisionId: runtime.state.lastDecisionId,
            startedAtMs: startedAt, deadlineMs: lifetime.deadlineMs, latestEvidenceIds: { ...context.latestEvidenceIds },
            lastAction: context.lastAction || null, agentCalls, actionSteps, timings: { ...context.timings, totalMs: now() - startedAt } };
          const persisted = await context.store.persist('checkpoint', { operationId, revision: runtime.state.revision,
            stepId: 'intent-terminal', target, timestampMs: now(), payloadSummary });
          if (!persisted.ok) throw Object.assign(new Error(persisted.error), { code: persisted.error || 'terminal_not_persisted' });
          terminalEvidenceId = persisted.evidenceId;
          context.latestEvidenceIds.checkpoint = persisted.evidenceId;
        }
        runtime.state.status = stopping.status;
        runtime.state.error = stopping.error;
        runtime.emit('terminal', { evidenceId: terminalEvidenceId, status: stopping.status });
      } catch (error) {
        runtime.state.status = 'blocked_evidence_store';
        runtime.state.error = error.code || 'terminal_not_persisted';
        runtime.emit('terminal_persistence_failed', { error: runtime.state.error, requestedStatus: stopping.status });
      }
      finished = true;
      return snapshotResult(runtime.state.status === 'completed');
    })();
    return finalizing;
  }

  async function controlled(action, mutation = false) {
    if (stopping || finished) return intentError('operation_stopped', snapshotResult(false));
    let result;
    try { result = await lifetime.run(action, mutation); }
    catch (error) {
      if (!stopping) requestStop(error.code === 'deadline_exceeded' ? 'timeout' : 'failed', error.code || 'intent_execution_failed');
    }
    if (stopping) return finish();
    return result;
  }

  function timedOut() {
    return effectiveTimeoutMs != null && (now() - startedAt >= effectiveTimeoutMs || lifetime.deadlineMs !== null && Date.now() >= lifetime.deadlineMs);
  }

  function enterTimeout() {
    requestStop('timeout', 'deadline_exceeded');
    return snapshotResult(false);
  }

  function observationFailure(observed) {
    if (observed.stage === 'provider') { runtime.state.status = 'waiting_for_observation'; runtime.state.error = observed.error; }
    else requestStop('blocked_evidence_store', observed.error);
    runtime.emit('blocked', { error: observed.error });
    return snapshotResult(false);
  }

  async function start() {
    if (runtime.state.status !== 'created') return intentError('operation_already_started', snapshotResult(false));
    startedAt = now(); lifetime.start();
    runtime.state.status = 'observing';
    if (ownsOutcome) {
      const opened = await context.store.persist('checkpoint', { operationId, revision: 1, stepId: 'intent-started', target,
        timestampMs: now(), payloadSummary: { lifecycle: 'aab.intent-lifecycle/v1', status: 'observing', goal, target,
          provider, observationTarget: context.observationTarget, mode, startedAtMs: startedAt, deadlineMs: lifetime.deadlineMs, restartPolicy: 'none' } });
      if (!opened.ok) { requestStop('blocked_evidence_store', opened.error || 'start_not_persisted'); return snapshotResult(false); }
      context.latestEvidenceIds.checkpoint = opened.evidenceId;
      checkExecution();
    }
    runtime.emit('intent_started', { goal: goal || null });
    const observed = await observeAndCommit(context);
    if (stopping) return snapshotResult(false);
    checkExecution();
    if (!observed.ok) {
      return observationFailure(observed);
    }
    runtime.state.revision = observed.revision;
    runtime.state.status = 'waiting_for_decision';
    runtime.emit('waiting_for_decision', { revision: observed.revision, evidenceId: observed.evidenceId });
    if (timedOut()) return enterTimeout();
    if (mode === 'autonomous') {
      return runAutonomous();
    }
    return snapshotResult(true);
  }

  async function runAutonomous() {
    runtime.state.mode = 'autonomous';
    context.mode = 'autonomous';
    while (runtime.state.status === 'waiting_for_decision' && !stopAutonomous) {
      if (timedOut()) return enterTimeout();
      if (!agent || typeof agent.decide !== 'function') {
        requestStop('intervention_required', 'agent_adapter_unavailable');
        runtime.emit('intervention_required', { reason: 'agent_adapter_unavailable' });
        return snapshotResult(false);
      }
      const gate = budget
        ? budget.check({ steps: actionSteps, agentCalls, atMs: now() })
        : { ok: true };
      if (!gate.ok) {
        requestStop('intervention_required', gate.reason);
        runtime.emit('intervention_required', { reason: gate.reason });
        return snapshotResult(false);
      }
      let decision;
      try {
        const waitStarted = now();
        runtime.state.status = 'autonomous_deciding';
        agentController = new AbortController();
        decision = await awaitAgentReply(agent, {
          goal,
          revision: runtime.state.revision,
          summary: context.latestSummary,
          evidenceId: context.latestEvidenceId,
          ...(context.latestCapture ? { capture: context.latestCapture } : {}),
        }, agentController.signal);
        context.timings.decisionWaitMs += now() - waitStarted;
        agentCalls += 1;
      } catch (error) {
        if (stopping || runtime.state.status === 'paused') return snapshotResult(false);
        runtime.state.status = 'waiting_for_decision';
        runtime.state.error = 'agent_adapter_failed';
        runtime.emit('agent_adapter_failed', { detail: error.message || String(error) });
        return snapshotResult(false);
      }
      agentController = null;
      if (runtime.state.status === 'autonomous_deciding') runtime.state.status = 'waiting_for_decision';
      if (stopAutonomous || runtime.state.status !== 'waiting_for_decision') {
        return snapshotResult(runtime.state.status === 'completed');
      }
      const result = await decide(decision);
      if (result.ok && decision.agentDecision === 'act') actionSteps += 1;
      if (result.ok !== true) return result;
      if (['completed', 'failed', 'inconclusive', 'cancelled', 'ambiguous', 'intervention_required'].includes(runtime.state.status)) {
        return result;
      }
    }
    return snapshotResult(runtime.state.status === 'completed' || runtime.state.status === 'waiting_for_decision');
  }

  async function decide(decision = {}) {
    if (timedOut()) return enterTimeout();
    if (runtime.state.status !== 'waiting_for_decision') {
      return intentError('not_waiting_for_decision', snapshotResult(false));
    }
    if (Number.isInteger(decision?.basedOnRevision) && decision.basedOnRevision > 0 && decision.basedOnRevision !== runtime.state.revision) {
      return intentError('reobserve_required', { ...snapshotResult(false), dispatched: false, ambiguous: false });
    }
    try { validateValue(decision, intentDecisionSchema(context.latestProvider, context.target.platform), 'decision'); }
    catch (error) {
      if (!(error instanceof CommandError)) throw error;
      return intentError(error.code, { ...snapshotResult(false), field: error.field, message: error.message,
        ...(error.details ? { details: error.details } : {}), dispatched: false, ambiguous: false });
    }
    decision = structuredClone(decision);
    if (mode === 'autonomous' && budget) {
      const gate = budget.check({ steps: actionSteps, agentCalls, action: decision.action, atMs: now(), phase: 'decision' });
      if (!gate.ok) {
        requestStop('intervention_required', gate.reason);
        runtime.emit('intervention_required', { reason: gate.reason });
        return snapshotResult(false);
      }
    }
    if (runtime.state.seenDecisionIds.has(decision.decisionId)) {
      return intentError('duplicate_decision', { decisionId: decision.decisionId, ...snapshotResult(false) });
    }
    const agentDecision = decision.agentDecision;
    if (['complete', 'fail', 'inconclusive'].includes(agentDecision)) {
      if (decision.basedOnRevision !== runtime.state.revision) return intentError('reobserve_required', snapshotResult(false));
      runtime.state.status = 'decision_committed';
      const persisted = await context.store.persist('decision', {
        decisionId: decision.decisionId,
        operationId,
        revision: runtime.state.revision,
        basedOnEvidenceIds: [context.latestEvidenceId].filter(Boolean),
        actionSpecHash: 'terminal',
        agentDecision,
        mode: context.mode,
        reason: decision.reason,
        timestampMs: context.now(),
        target: context.target,
      });
      if (stopping) return snapshotResult(false);
      checkExecution();
      if (!persisted.ok) {
        runtime.state.status = 'waiting_for_decision';
        return intentError(persisted.error || 'plan_or_decision_not_persisted', snapshotResult(false));
      }
      runtime.state.seenDecisionIds.add(decision.decisionId);
      runtime.state.lastDecisionId = decision.decisionId;
      requestStop(agentDecision === 'complete' ? 'completed' : agentDecision === 'fail' ? 'failed' : 'inconclusive',
        agentDecision === 'complete' ? null : agentDecision === 'fail' ? 'agent_declared_failure' : 'agent_declared_inconclusive');
      context.latestEvidenceIds.decision = persisted.evidenceId;
      runtime.emit('terminal_decision', { agentDecision, decisionId: decision.decisionId });
      return snapshotResult(agentDecision === 'complete');
    }
    runtime.state.status = 'decision_committed';
    const acted = await executeDecisionAction(context, decision);
    if (stopping) return snapshotResult(false);
    checkExecution();
    if (!acted.ok) {
      if (acted.error === 'reobserve_required') {
        runtime.state.status = 'waiting_for_decision';
        runtime.emit('reobserve_required', { decisionId: decision.decisionId });
        return { ...snapshotResult(false), error: acted.error, revision: runtime.state.revision };
      }
      runtime.state.seenDecisionIds.add(decision.decisionId);
      runtime.state.lastDecisionId = decision.decisionId;
      requestStop(acted.ambiguous ? 'ambiguous' : 'failed', acted.error);
      runtime.emit('paused', { error: acted.error, decisionId: decision.decisionId });
      return snapshotResult(false);
    }
    runtime.state.seenDecisionIds.add(decision.decisionId);
    runtime.state.lastDecisionId = decision.decisionId;
    context.revision += 1;
    runtime.state.revision = context.revision;
    runtime.state.status = 'observing';
    const observed = await observeAndCommit(context);
    if (stopping) return snapshotResult(false);
    checkExecution();
    if (!observed.ok) {
      return observationFailure(observed);
    }
    runtime.state.revision = observed.revision;
    runtime.state.status = 'waiting_for_decision';
    runtime.emit('waiting_for_decision', { revision: observed.revision, decisionId: decision.decisionId });
    return snapshotResult(true);
  }

  function status(args = {}) {
    const result = snapshotResult(
      runtime.state.status === 'waiting_for_decision'
      || runtime.state.status === 'completed'
      || runtime.state.status === 'created',
    );
    if (context.store.ledger) {
      const afterSequence = args.afterSequence == null ? 0 : args.afterSequence;
      result.history = context.store.ledger.query(context.operationId, afterSequence, args.limit);
    }
    return result;
  }

  async function observe(args = {}) {
    if (!['waiting_for_decision', 'waiting_for_observation'].includes(runtime.state.status)) return intentError('not_waiting_for_decision', snapshotResult(false));
    if (args.basedOnRevision !== undefined && args.basedOnRevision !== runtime.state.revision) return intentError('reobserve_required', snapshotResult(false));
    if (timedOut()) return enterTimeout();
    const selectedProvider = args.provider ?? context.provider;
    const providerError = intentProviderError(context.target, selectedProvider);
    if (providerError) return intentError(providerError.error, { ...snapshotResult(false), ...providerError, dispatched: false, ambiguous: false });
    let selectedObservationTarget;
    try {
      selectedObservationTarget = normalizeObservationTarget(context.target, selectedProvider,
        args.observationTarget !== undefined ? args.observationTarget : selectedProvider === context.provider ? context.observationTarget : null);
    } catch (error) {
      return intentError(error.code, { ...snapshotResult(false), field: error.field, message: error.message, dispatched: false, ambiguous: false });
    }
    runtime.state.status = 'observing';
    context.revision += 1;
    runtime.emit('observing', { revision: context.revision, provider: selectedProvider, observationTarget: selectedObservationTarget, reason: 'explicit_reobserve' });
    const observed = await observeAndCommit(context, selectedProvider, selectedObservationTarget);
    if (runtime.state.status !== 'observing') return snapshotResult(false);
    if (!observed.ok) {
      return observationFailure(observed);
    }
    runtime.state.revision = observed.revision;
    runtime.state.status = 'waiting_for_decision';
    runtime.state.error = null;
    runtime.emit('waiting_for_decision', { revision: observed.revision, evidenceId: observed.evidenceId, reason: 'explicit_reobserve' });
    return snapshotResult(true);
  }

  function pause() {
    if (runtime.state.status === 'waiting_for_decision' || runtime.state.status === 'autonomous_deciding') {
      stopAutonomous = true;
      runtime.state.status = 'paused';
      agentController?.abort({ code: 'paused' });
      runtime.emit('paused');
      return snapshotResult(true);
    }
    return intentError('operation_busy', snapshotResult(false));
  }

  function resume() {
    if (lifetime.pendingCount > 1) return intentError('operation_busy', snapshotResult(false));
    if (runtime.state.status === 'paused') {
      runtime.state.status = 'waiting_for_decision';
      runtime.emit('resumed');
      stopAutonomous = false;
      if (mode === 'autonomous') return runAutonomous();
    }
    return snapshotResult(true);
  }

  function cancel() {
    if (finished) return Promise.resolve(snapshotResult(runtime.state.status === 'completed'));
    requestStop('cancelled', 'cancelled');
    return finish();
  }

  function intervene(reason = 'intervened') {
    requestStop('intervention_required', reason);
    return finish();
  }

  function quiesce() {
    if (ownsOutcome) throw new Error('Only an external workflow owner can quiesce the decision worker.');
    requestStop('finishing');
    return finish();
  }

  function snapshotResult(ok) {
    const result = {
      ok,
      ...runtime.snapshot(),
      provider: context.provider,
      observationTarget: context.observationTarget,
      observationFailure: context.observationFailure,
      summary: context.latestSummary,
      evidenceId: context.latestEvidenceId,
      latestEvidenceIds: { observation: context.latestEvidenceId || null, ...context.latestEvidenceIds },
      timings: { ...context.timings, totalMs: now() - startedAt },
      agentCalls,
      actionSteps,
      deadlineMs: lifetime.deadlineMs,
      pendingOperations: lifetime.pendingCount,
      terminalEvidenceId,
      lastAction: context.lastAction || null,
    };
    if (context.latestCapture) result.capture = context.latestCapture;
    if (context.recording) result.recording = context.recording.info();
    return result;
  }

  return { operationId, start: () => { lifetime.start(); return controlled(start); }, decide: decision => controlled(() => decide(decision), true),
    observe: args => controlled(() => observe(args)), status, pause, resume: () => controlled(resume), cancel, intervene,
    quiesce, isFinished: () => finished, runtime, context };
}

module.exports = { createIntentWorker };
