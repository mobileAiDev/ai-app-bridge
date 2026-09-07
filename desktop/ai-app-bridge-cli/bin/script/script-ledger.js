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

// Calls may explicitly target a system picker while their owning Script belongs to an App.
// Match the same optional target overrides used by dispatch and durable mutation markers.
function scriptEventTarget(record, type, extra = {}) {
  const target = record.spec && record.spec.target;
  const args = ['call_started', 'call_completed', 'call_failed'].includes(type) ? extra.args
    : type === 'action_receipt' ? extra.payloadSummary?.args : null;
  if (!args) return target;
  return { ...target, ...(args.serial != null ? { serial: args.serial } : {}),
    ...(args.packageName != null ? { packageName: args.packageName } : {}) };
}

function scriptPayload(extra) {
  return {
    command: extra.command,
    args: extra.args,
    error: extra.error,
    status: extra.status,
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
