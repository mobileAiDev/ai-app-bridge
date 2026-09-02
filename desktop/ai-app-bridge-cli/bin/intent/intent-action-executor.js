'use strict';

const { intentError } = require('./intent-errors');

async function executeDecisionAction(context, decision) {
  const exposed = context.store.canExposeRevision(context.operationId);
  if (!exposed.ok) return intentError(exposed.error);
  if (Number(decision.basedOnRevision) !== Number(exposed.revision)) {
    return intentError('reobserve_required', { revision: exposed.revision });
  }
  const persistedDecision = await context.store.persist('decision', {
    decisionId: decision.decisionId,
    operationId: context.operationId,
    revision: exposed.revision,
    basedOnEvidenceIds: [context.latestEvidenceId].filter(Boolean),
    actionSpecHash: specHash(decision.action),
    agentDecision: 'act',
  });
  if (!persistedDecision.ok) {
    return intentError(persistedDecision.error || 'plan_or_decision_not_persisted');
  }
  context.latestEvidenceIds.decision = persistedDecision.evidenceId;
  const marker = await context.store.persist('dispatch-marker', {
    actionId: `${context.operationId}:${decision.decisionId}`,
    operationId: context.operationId,
    revision: exposed.revision,
    decisionId: decision.decisionId,
    target: context.target,
    actionSpecHash: specHash(decision.action),
    state: 'prepared',
  });
  if (!marker.ok) return intentError(marker.error || 'dispatch_marker_not_persisted');
  context.latestEvidenceIds.marker = marker.evidenceId;
  if (!context.store.canDispatch(context.operationId).ok) {
    return intentError('dispatch_marker_not_persisted');
  }
  const timings = context.timings || {};
  const startedAtMs = context.now();
  const result = await context.adapter.action({
    serial: context.target.serial,
    packageName: context.target.packageName,
    spec: {
      ...decision.action,
      provider: decision.action?.provider || context.provider || null,
    },
    rawTree: context.latestRawTree,
  });
  if (result?.targetLeaseWaitMs != null) {
    timings.targetLeaseWaitMs = (timings.targetLeaseWaitMs || 0) + result.targetLeaseWaitMs;
  }
  const completedAtMs = context.now();
  timings.actionMs = (timings.actionMs || 0) + (completedAtMs - startedAtMs);
  const receiptStarted = context.now();
  const receipt = await context.store.persist('action-receipt', {
    actionId: `${context.operationId}:${decision.decisionId}`,
    operationId: context.operationId,
    startedAtMs,
    completedAtMs,
    mechanicalStatus: result?.mechanicalStatus || (result?.ok === false ? 'failed' : 'ok'),
    providerResult: result || null,
    error: result?.error || null,
    ambiguous: Boolean(result?.ambiguous),
  });
  timings.receiptCommitMs = (timings.receiptCommitMs || 0) + (context.now() - receiptStarted);
  if (!receipt.ok) {
    return intentError(receipt.error || 'receipt_not_persisted', { ambiguous: true });
  }
  context.latestEvidenceIds.receipt = receipt.evidenceId;
  if (result?.ambiguous) return intentError('ambiguous', { ambiguous: true });
  if (result?.ok === false) return intentError(result.error || 'action_failed');
  return { ok: true, receiptId: receipt.evidenceId, decisionId: decision.decisionId };
}

function specHash(action = {}) {
  return `${action.action || action.name || 'tap'}:${action.text || ''}:${action.nodeId || ''}`;
}

module.exports = { executeDecisionAction };
