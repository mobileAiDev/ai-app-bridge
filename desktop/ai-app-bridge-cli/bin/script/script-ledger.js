'use strict';

const { createExecutionLedger } = require('../shared-kernel/execution-ledger');

function createScriptLedger({ ledger = createExecutionLedger() } = {}) {
  function append(record, type, extra = {}, timestampMs) {
    if (!record || typeof record.operationId !== 'string' || record.operationId.length === 0) {
      throw new TypeError('operationId');
    }
    return ledger.record({
      executionId: record.operationId,
      revision: extra.revision,
      kind: type,
      target: scriptEventTarget(record, type, extra),
      timestampMs,
      actionId: extra.actionId,
      parentFactId: extra.parentFactId,
      payloadSummary: extra.payloadSummary == null ? scriptPayload(extra) : extra.payloadSummary,
      evidenceRefs: extra.evidenceRefs,
      timings: extra.timings,
      sequence: extra.sequence,
    });
  }

  return { ledger, append };
}

// Call events carry the target already bound before dispatch. Never reconstruct
// it from a subset of arguments or borrow the owning Script's connection.
function scriptEventTarget(record, type, extra = {}) {
  return ['call_started', 'call_completed', 'call_failed', 'action_receipt'].includes(type)
    ? extra.target : record.spec?.target;
}

function scriptPayload(extra) {
  return {
    command: extra.command,
    callId: extra.callId,
    args: extra.args,
    error: extra.error,
    status: extra.status,
    resultRef: extra.resultRef,
    name: extra.name,
    verdict: extra.verdict,
    scope: extra.scope,
    reason: extra.reason,
    predicateSummary: extra.predicateSummary,
    condition: extra.condition,
    requiredEvidence: extra.requiredEvidence,
    requireCoverage: extra.requireCoverage,
    refs: extra.refs,
    coverage: extra.coverage,
    observationId: extra.observationId,
    window: extra.window,
    source: extra.source,
    requestId: extra.requestId,
    decision: extra.decision,
    request: extra.request,
    stage: extra.stage,
    message: extra.message,
  };
}

module.exports = { createScriptLedger, scriptEventTarget };
