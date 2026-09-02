'use strict';

const { summarizeTree } = require('../shared-kernel/summary-transformer');
const { scriptError } = require('./script-errors');

async function executeStep(step, context) {
  if (step.type === 'observe') return observeStep(step, context);
  if (step.type === 'action') return actionStep(step, context);
  if (step.type === 'assert') return assertStep(step, context);
  if (step.type === 'checkpoint') return checkpointStep(step, context);
  return scriptError('invalid_step', { stepId: step.id });
}

async function observeStep(step, context) {
  const timings = context.timings;
  const observeStarted = context.now();
  const observation = await context.adapter.observe({
    serial: context.target.serial,
    packageName: context.target.packageName,
    provider: step.provider,
    rawTreeId: `${context.operationId}:${step.id}:${context.revision}`,
  });
  timings.providerAcquireMs += context.now() - observeStarted;
  if (!observation || observation.ok === false) {
    return fail(context, step, observation?.error || 'provider_failed');
  }
  const persistStarted = context.now();
  const persisted = await context.store.persist('observation', {
    operationId: context.operationId,
    revision: context.revision,
    serial: context.target.serial,
    packageName: context.target.packageName,
    provider: step.provider,
    capturedAtMs: context.now(),
    foregroundTarget: observation.foregroundTarget,
    rawTreeId: observation.rawTreeId,
    rawTree: observation.rawTree,
  });
  timings.evidenceCommitMs += context.now() - persistStarted;
  if (!persisted.ok) return fail(context, step, persisted.error || 'evidence_not_persisted');
  const summaryStarted = context.now();
  const summary = summarizeTree({
    provider: step.provider,
    rawTree: observation.rawTree,
    rawTreeId: observation.rawTreeId,
  });
  timings.summaryMs += context.now() - summaryStarted;
  if (!summary.ok) return fail(context, step, summary.error || 'summary_failed');
  const summaryPersist = await context.store.persist('summary', {
    operationId: context.operationId,
    revision: context.revision,
    rawTreeId: observation.rawTreeId,
    summary,
  });
  if (!summaryPersist.ok) return fail(context, step, summaryPersist.error || 'summary_not_persisted');
  context.latestSummary = summary;
  context.latestEvidenceId = persisted.evidenceId;
  context.latestRawTreeId = observation.rawTreeId;
  context.latestRawTree = observation.rawTree;
  context.latestProvider = step.provider;
  context.latestEvidenceIds.observation = persisted.evidenceId;
  context.latestEvidenceIds.summary = summaryPersist.evidenceId;
  return {
    ok: true,
    stepId: step.id,
    type: step.type,
    evidenceId: persisted.evidenceId,
    adbTimings: observation.adbTimings || [],
  };
}

async function actionStep(step, context) {
  const ready = context.store.canExposeRevision(context.operationId);
  if (!ready.ok) return fail(context, step, ready.error);
  const plan = await context.store.persist('plan', {
    operationId: context.operationId,
    revision: context.revision,
    planStepId: step.id,
    actionSpecHash: specHash(step),
  });
  if (!plan.ok) return fail(context, step, plan.error || 'plan_or_decision_not_persisted');
  context.latestEvidenceIds.plan = plan.evidenceId;
  const marker = await context.store.persist('dispatch-marker', {
    actionId: `${context.operationId}:${step.id}`,
    operationId: context.operationId,
    revision: context.revision,
    planStepId: step.id,
    target: context.target,
    actionSpecHash: specHash(step),
    state: 'prepared',
  });
  if (!marker.ok) return fail(context, step, marker.error || 'dispatch_marker_not_persisted');
  context.latestEvidenceIds.marker = marker.evidenceId;
  if (!context.store.canDispatch(context.operationId).ok) {
    return fail(context, step, 'dispatch_marker_not_persisted');
  }
  const startedAtMs = context.now();
  const result = await context.adapter.action({
    serial: context.target.serial,
    packageName: context.target.packageName,
    spec: { ...step, provider: step.provider || context.latestProvider || null },
    rawTree: context.latestRawTree,
  });
  if (result?.targetLeaseWaitMs != null) {
    context.timings.targetLeaseWaitMs += result.targetLeaseWaitMs;
  }
  const completedAtMs = context.now();
  context.timings.actionMs += completedAtMs - startedAtMs;
  const ambiguous = Boolean(result?.ambiguous);
  const receiptStarted = context.now();
  const receipt = await context.store.persist('action-receipt', {
    actionId: `${context.operationId}:${step.id}`,
    operationId: context.operationId,
    startedAtMs,
    completedAtMs,
    mechanicalStatus: result?.mechanicalStatus || (result?.ok === false ? 'failed' : 'ok'),
    providerResult: result || null,
    error: result?.error || null,
    ambiguous,
  });
  context.timings.receiptCommitMs += context.now() - receiptStarted;
  if (!receipt.ok) {
    return fail(context, step, receipt.error || 'receipt_not_persisted', { ambiguous: true });
  }
  context.lastActionReceipt = receipt;
  context.latestEvidenceIds.receipt = receipt.evidenceId;
  if (ambiguous) return fail(context, step, 'ambiguous', { ambiguous: true });
  if (result?.ok === false) return fail(context, step, result.error || 'action_failed');
  return {
    ok: true,
    stepId: step.id,
    type: step.type,
    receiptId: receipt.evidenceId,
    adbTimings: result.adbTimings || [],
  };
}

async function assertStep(step, context) {
  const exposed = context.store.canExposeRevision(context.operationId);
  if (!exposed.ok) return fail(context, step, exposed.error);
  const texts = (context.latestSummary?.nodes || []).flatMap((node) => [node.text, node.label]).filter(Boolean);
  if (step.text && !texts.includes(step.text)) {
    return fail(context, step, 'assert_failed', { expected: step.text });
  }
  return { ok: true, stepId: step.id, type: step.type };
}

async function checkpointStep(step, context) {
  const persisted = await context.store.persist('checkpoint', {
    operationId: context.operationId,
    revision: context.revision,
    stepId: step.id,
    currentStepIndex: context.stepIndex,
    completedStepIds: context.completedStepIds.slice(),
    latestEvidenceRevision: context.revision,
    script: context.compiledScript || null,
    hash: context.scriptHash || null,
  });
  if (!persisted.ok) return fail(context, step, persisted.error || 'checkpoint_failed');
  context.latestCheckpointId = persisted.evidenceId;
  context.latestEvidenceIds.checkpoint = persisted.evidenceId;
  return { ok: true, stepId: step.id, type: step.type, checkpointId: persisted.evidenceId, continue: true };
}

function fail(context, step, error, extra = {}) {
  return scriptError(error, {
    stepId: step.id,
    failedStepId: step.id,
    pauseReason: extra.ambiguous ? 'ambiguous' : 'execution_failure',
    ...extra,
  });
}

function specHash(step) {
  return `${step.action}:${step.text || ''}:${step.nodeId || ''}`;
}

module.exports = { executeStep };
