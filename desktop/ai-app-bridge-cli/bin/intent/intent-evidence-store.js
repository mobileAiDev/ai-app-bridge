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
        target: record.target || targetOf(record),
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
  };
}

function timestampFor(kind, record) {
  if (kind === 'observation') return record.capturedAtMs;
  if (kind === 'action-receipt') return record.completedAtMs;
  return record.timestampMs;
}

function targetOf(record) {
  if (record.serial == null && record.packageName == null) return undefined;
  return { serial: record.serial, packageName: record.packageName };
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
