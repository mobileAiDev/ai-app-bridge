'use strict';

const { createEvidenceStore } = require('../shared-kernel/evidence-store');
const { createExecutionLedger } = require('../shared-kernel/execution-ledger');

function createIntentEvidenceStore(options = {}) {
  const store = createEvidenceStore({ ...options, namespace: 'intent' });
  const ledger = options.ledger || createExecutionLedger();
  const persist = store.persist;

  async function persistAndRecord(kind, record) {
    const result = await persist(kind, record);
    if (result.ok && typeof record.operationId === 'string' && record.operationId.length > 0) {
      ledger.record({
        executionId: record.operationId,
        revision: record.revision,
        kind,
        target: record.target,
        timestampMs: timestampFor(kind, record),
        actionId: record.actionId,
        parentFactId: kind === 'decision' ? firstId(record.basedOnEvidenceIds) : record.parentFactId,
        payloadSummary: payloadSummaryFor(kind, record),
        evidenceRefs: [result.evidenceId],
        timings: kind === 'action-receipt' ? timingsOf(record) : record.timings,
      });
    }
    return result;
  }

  return {
    ...store,
    persist: persistAndRecord,
    commit: persistAndRecord,
    ledger,
    history(operationId, afterSequence = 0, limit) {
      const restored = createExecutionLedger();
      for (const record of store.list(operationId)) {
        const checked = store.read(record.evidenceId);
        if (!checked.ok) throw Object.assign(new Error(checked.error), { code: checked.error });
        restored.record({ executionId: operationId, revision: record.revision, kind: record.kind,
          target: record.target, timestampMs: timestampFor(record.kind, record), actionId: record.actionId,
          parentFactId: record.kind === 'decision' ? firstId(record.basedOnEvidenceIds) : record.parentFactId,
          payloadSummary: payloadSummaryFor(record.kind, record), evidenceRefs: [record.evidenceId],
          timings: record.kind === 'action-receipt' ? timingsOf(record) : record.timings });
      }
      return restored.query(operationId, afterSequence, limit);
    },
  };
}

function timestampFor(kind, record) {
  if (kind === 'observation') return record.capturedAtMs;
  if (kind === 'action-receipt') return record.completedAtMs;
  return record.timestampMs;
}

function firstId(ids) {
  return Array.isArray(ids) && ids.length > 0 ? ids[0] : undefined;
}

function timingsOf(record) {
  if (record.startedAtMs == null && record.completedAtMs == null) return undefined;
  return { startedAtMs: record.startedAtMs, completedAtMs: record.completedAtMs };
}

function payloadSummaryFor(kind, record) {
  if (kind === 'observation') {
    const summary = {
      provider: record.provider,
      observationTarget: record.observationTarget,
      rawTreeId: record.rawTreeId,
      foregroundTarget: record.foregroundTarget,
      capturedAtMs: record.capturedAtMs,
    };
    if (record.captureRefs !== undefined) summary.captureRefs = record.captureRefs;
    if (record.captureCoverage !== undefined) summary.captureCoverage = record.captureCoverage;
    if (record.capturePages !== undefined) summary.capturePages = record.capturePages;
    return summary;
  }
  if (kind === 'summary') {
    return {
      rawTreeId: record.rawTreeId,
      pageSummary: record.summary,
    };
  }
  if (kind === 'decision') {
    return {
      decisionId: record.decisionId,
      agentDecision: record.agentDecision,
      actionSpecHash: record.actionSpecHash,
      basedOnEvidenceIds: record.basedOnEvidenceIds,
      mode: record.mode,
      action: record.action,
      reason: record.reason,
    };
  }
  if (kind === 'dispatch-marker') {
    return {
      decisionId: record.decisionId,
      actionSpecHash: record.actionSpecHash,
      action: record.action,
      state: record.state,
    };
  }
  if (kind === 'action-receipt') {
    return {
      mechanicalStatus: record.mechanicalStatus,
      error: record.error,
      ambiguous: record.ambiguous === true,
      dispatched: record.dispatched,
      action: record.action,
      resolved: record.resolved,
      matched: record.matched,
      rawTreeId: record.rawTreeId,
      basedOnEvidenceIds: record.basedOnEvidenceIds,
    };
  }
  return record.payloadSummary;
}

module.exports = { createIntentEvidenceStore };
