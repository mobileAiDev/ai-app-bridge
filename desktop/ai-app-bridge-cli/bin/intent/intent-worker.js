'use strict';

const { executeDecisionAction } = require('./intent-action-executor');
const { intentError } = require('./intent-errors');
const { observeAndCommit } = require('./intent-observer');
const { createIntentRuntime } = require('./intent-runtime');

function createIntentWorker({
  operationId,
  goal,
  target,
  provider = 'native',
  store,
  adapter,
  mode = 'supervised',
  agent = null,
  budget = null,
  timeoutMs = null,
  now = Date.now,
} = {}) {
  const runtime = createIntentRuntime({ operationId, now });
  runtime.state.mode = mode;
  const context = {
    operationId,
    revision: 1,
    target,
    provider,
    store,
    adapter,
    now,
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
  const startedAt = now();

  function timedOut() {
    return timeoutMs != null && now() - startedAt >= timeoutMs;
  }

  function enterTimeout() {
    runtime.state.status = 'timeout';
    runtime.state.error = 'timeout';
    runtime.emit('timeout');
    return snapshotResult(false);
  }

  async function start() {
    runtime.state.status = 'observing';
    runtime.emit('intent_started', { goal: goal || null });
    const observed = await observeAndCommit(context);
    if (!observed.ok) {
      runtime.state.status = 'blocked_evidence_store';
      runtime.state.error = observed.error;
      runtime.emit('blocked', { error: observed.error });
      return snapshotResult(false);
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
    while (runtime.state.status === 'waiting_for_decision' && !stopAutonomous) {
      if (timedOut()) return enterTimeout();
      if (!agent || typeof agent.decide !== 'function') {
        runtime.state.status = 'intervention_required';
        runtime.state.error = 'agent_adapter_unavailable';
        runtime.emit('intervention_required', { reason: 'agent_adapter_unavailable' });
        return snapshotResult(false);
      }
      const gate = budget
        ? budget.check({ steps: actionSteps, agentCalls, atMs: now() })
        : { ok: true };
      if (!gate.ok) {
        runtime.state.status = 'intervention_required';
        runtime.state.error = gate.reason;
        runtime.emit('intervention_required', { reason: gate.reason });
        return snapshotResult(false);
      }
      let decision;
      try {
        const waitStarted = now();
        decision = await agent.decide({
          goal,
          revision: runtime.state.revision,
          summary: context.latestSummary,
          evidenceId: context.latestEvidenceId,
        });
        context.timings.decisionWaitMs += now() - waitStarted;
        agentCalls += 1;
      } catch (error) {
        runtime.state.error = 'agent_adapter_failed';
        runtime.emit('agent_adapter_failed', { detail: error.message || String(error) });
        return snapshotResult(false);
      }
      if (stopAutonomous || runtime.state.status !== 'waiting_for_decision') {
        return snapshotResult(runtime.state.status === 'completed');
      }
      const action = decision.action || null;
      const actionGate = budget
        ? budget.check({ steps: actionSteps, agentCalls, action, atMs: now() })
        : { ok: true };
      if (!actionGate.ok) {
        runtime.state.status = 'intervention_required';
        runtime.state.error = actionGate.reason;
        runtime.emit('intervention_required', { reason: actionGate.reason });
        return snapshotResult(false);
      }
      const result = await decide({
        ...decision,
        basedOnRevision: decision.basedOnRevision != null ? decision.basedOnRevision : runtime.state.revision,
      });
      if (decision.agentDecision === 'act' && result.ok) actionSteps += 1;
      if (result.ok !== true && runtime.state.status !== 'waiting_for_decision') {
        return result;
      }
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
    if (!decision.decisionId) return intentError('decisionId_required', snapshotResult(false));
    if (runtime.state.seenDecisionIds.has(decision.decisionId)) {
      return intentError('duplicate_decision', { decisionId: decision.decisionId, ...snapshotResult(false) });
    }
    const agentDecision = decision.agentDecision || decision.decision;
    if (['complete', 'fail', 'inconclusive'].includes(agentDecision)) {
      const persisted = await context.store.persist('decision', {
        decisionId: decision.decisionId,
        operationId,
        revision: runtime.state.revision,
        basedOnEvidenceIds: [context.latestEvidenceId].filter(Boolean),
        actionSpecHash: 'terminal',
        agentDecision,
      });
      if (!persisted.ok) {
        return intentError(persisted.error || 'plan_or_decision_not_persisted', snapshotResult(false));
      }
      runtime.state.seenDecisionIds.add(decision.decisionId);
      runtime.state.lastDecisionId = decision.decisionId;
      runtime.state.status = agentDecision === 'complete' ? 'completed' : agentDecision === 'fail' ? 'failed' : 'inconclusive';
      context.latestEvidenceIds.decision = persisted.evidenceId;
      runtime.emit('terminal', { agentDecision, decisionId: decision.decisionId });
      return snapshotResult(agentDecision === 'complete');
    }
    if (agentDecision !== 'act') return intentError('invalid_agent_decision', { agentDecision, ...snapshotResult(false) });
    runtime.state.status = 'decision_committed';
    const acted = await executeDecisionAction(context, decision);
    if (!acted.ok) {
      if (acted.error === 'reobserve_required') {
        runtime.state.status = 'waiting_for_decision';
        runtime.emit('reobserve_required', { decisionId: decision.decisionId });
        return { ...snapshotResult(false), error: acted.error, revision: runtime.state.revision };
      }
      runtime.state.seenDecisionIds.add(decision.decisionId);
      runtime.state.lastDecisionId = decision.decisionId;
      runtime.state.status = acted.ambiguous ? 'ambiguous' : 'failed';
      runtime.state.error = acted.error;
      runtime.emit('paused', { error: acted.error, decisionId: decision.decisionId });
      return snapshotResult(false);
    }
    runtime.state.seenDecisionIds.add(decision.decisionId);
    runtime.state.lastDecisionId = decision.decisionId;
    context.revision += 1;
    runtime.state.revision = context.revision;
    runtime.state.status = 'observing';
    const observed = await observeAndCommit(context);
    if (!observed.ok) {
      runtime.state.status = 'blocked_evidence_store';
      runtime.state.error = observed.error;
      return snapshotResult(false);
    }
    runtime.state.revision = observed.revision;
    runtime.state.status = 'waiting_for_decision';
    runtime.emit('waiting_for_decision', { revision: observed.revision, decisionId: decision.decisionId });
    return snapshotResult(true);
  }

  function status() {
    return snapshotResult(
      runtime.state.status === 'waiting_for_decision'
      || runtime.state.status === 'completed'
      || runtime.state.status === 'created',
    );
  }

  function pause() {
    stopAutonomous = true;
    if (runtime.state.status === 'waiting_for_decision' || runtime.state.status === 'autonomous_deciding') {
      runtime.state.status = 'paused';
      runtime.emit('paused');
    }
    return snapshotResult(true);
  }

  function resume() {
    if (runtime.state.status === 'paused') {
      runtime.state.status = 'waiting_for_decision';
      runtime.emit('resumed');
      stopAutonomous = false;
      if (mode === 'autonomous') return runAutonomous();
    }
    return snapshotResult(true);
  }

  function cancel() {
    stopAutonomous = true;
    runtime.state.status = 'cancelled';
    runtime.emit('cancelled');
    return snapshotResult(false);
  }

  function intervene(reason = 'intervened') {
    stopAutonomous = true;
    runtime.state.status = 'intervention_required';
    runtime.state.error = reason;
    runtime.emit('intervention_required', { reason });
    return snapshotResult(false);
  }

  function snapshotResult(ok) {
    return {
      ok,
      ...runtime.snapshot(),
      summary: context.latestSummary,
      evidenceId: context.latestEvidenceId,
      latestEvidenceIds: { observation: context.latestEvidenceId || null, ...context.latestEvidenceIds },
      timings: { ...context.timings, totalMs: now() - startedAt },
      agentCalls,
      actionSteps,
    };
  }

  return { operationId, start, decide, status, pause, resume, cancel, intervene, runtime, context };
}

module.exports = { createIntentWorker };
