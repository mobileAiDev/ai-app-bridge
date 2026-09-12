'use strict';

const { getProcessDeviceMutationLease, runDeviceEffect } = require('../shared-kernel/device-mutation-lease');
const { executionFields } = require('../command-errors');
const { checksumOf } = require('../shared-kernel/evidence-schema');
const { intentError } = require('./intent-errors');
const { checkExecution } = require('../shared-kernel/execution-scope');
const { admitExecutionMutation } = require('../shared-kernel/execution-admission');

async function executeDecisionAction(context, decision) {
  checkExecution();
  const exposed = context.store.canExposeRevision(context.operationId);
  if (!exposed.ok) return intentError(exposed.error);
  if (decision.basedOnRevision !== exposed.revision) {
    return intentError('reobserve_required', { revision: exposed.revision });
  }
  const persistedDecision = await context.store.persist('decision', {
    decisionId: decision.decisionId,
    operationId: context.operationId,
    revision: exposed.revision,
    basedOnEvidenceIds: [context.latestEvidenceId].filter(Boolean),
    actionSpecHash: specHash(decision.action),
    agentDecision: 'act',
    mode: context.mode,
    action: decision.action,
    ...(context.latestRoute ? { foreground: context.latestRoute } : {}),
    reason: decision.reason,
    timestampMs: context.now(),
    target: context.target,
  });
  if (!persistedDecision.ok) {
    return intentError(persistedDecision.error || 'plan_or_decision_not_persisted');
  }
  context.latestEvidenceIds.decision = persistedDecision.evidenceId;
  checkExecution();
  if (context.canDispatch && !context.canDispatch()) return intentError('cancelled');
  const timings = context.timings || {};
  const startedAtMs = context.now();
  try {
    return await admitExecutionMutation(context.target, getProcessDeviceMutationLease(), async () => {
      const marker = await context.store.persist('dispatch-marker', {
        actionId: `${context.operationId}:${decision.decisionId}`,
        operationId: context.operationId,
        revision: exposed.revision,
        decisionId: decision.decisionId,
        target: context.target,
        actionSpecHash: specHash(decision.action),
        action: decision.action,
        ...(context.latestRoute ? { foreground: context.latestRoute } : {}),
        state: 'prepared',
        timestampMs: context.now(),
      });
      if (!marker.ok) return intentError(marker.error || 'dispatch_marker_not_persisted');
      context.latestEvidenceIds.marker = marker.evidenceId;
      context.actionId = `${context.operationId}:${decision.decisionId}`;
      if (!context.store.canDispatch(context.operationId).ok) {
        return intentError('dispatch_marker_not_persisted');
      }
      let result;
      try {
        checkExecution();
        result = context.canDispatch && !context.canDispatch()
          ? { ok: false, mechanicalStatus: 'failed', error: 'cancelled', ambiguous: false, dispatched: false }
          : await runDeviceEffect({ kind: 'intent-provider', actionId: context.actionId, target: context.target }, () => context.adapter.action({
          ...context.target,
          actionId: context.actionId,
          route: context.latestRoute,
          primaryProvider: context.provider,
          spec: {
            ...decision.action,
            provider: decision.action?.provider || context.latestProvider || context.provider || null,
          },
          rawTree: context.latestRawTree,
        }), result => result?.ok === true || result?.settled === true
          || result?.dispatched === false && result?.ambiguous !== true, { allowNested: true });
      } catch (error) {
        result = { ok: false, mechanicalStatus: 'failed', error: error?.code || error?.message || String(error),
          ambiguous: error?.ambiguous ?? true, dispatched: error?.dispatched ?? null, ...executionFields(error) };
      }
      if (!result || typeof result.ok !== 'boolean') {
        result = { ok: false, mechanicalStatus: 'failed', error: 'invalid_action_receipt', ambiguous: true };
      }
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
        mechanicalStatus: result.ok ? 'ok' : 'failed',
        providerResult: result || null,
        error: result?.error || null,
        ambiguous: Boolean(result?.ambiguous),
        dispatched: result.dispatched ?? (result.ok ? true : null),
        executionReceipt: result.executionReceipt ?? null,
        action: decision.action,
        ...(context.latestRoute ? { foreground: context.latestRoute } : {}),
        resolved: result?.resolved,
        matched: result?.matched,
        rawTreeId: context.latestRawTreeId,
        basedOnEvidenceIds: [context.latestEvidenceId].filter(Boolean),
        parentFactId: context.latestEvidenceId,
        revision: exposed.revision,
        target: context.target,
      });
      timings.receiptCommitMs = (timings.receiptCommitMs || 0) + (context.now() - receiptStarted);
      context.lastAction = { actionId: context.actionId, receiptId: receipt.ok ? receipt.evidenceId : null,
        error: result.error || null, ambiguous: result.ambiguous === true || !receipt.ok,
        dispatched: result.dispatched ?? (result.ok ? true : null), mechanicalStatus: result.ok ? 'ok' : 'failed' };
      if (!receipt.ok) {
        return intentError(receipt.error || 'receipt_not_persisted', { ambiguous: true });
      }
      context.latestEvidenceIds.receipt = receipt.evidenceId;
      if (result?.ambiguous) return intentError('ambiguous', { ambiguous: true });
      if (result?.ok === false) return intentError(result.error || 'action_failed');
      return { ok: true, receiptId: receipt.evidenceId, decisionId: decision.decisionId };
    });
  } catch (error) { return intentError(error.code || error.message, executionFields(error)); }
}

function specHash(action = {}) {
  return checksumOf(action);
}

module.exports = { executeDecisionAction };
