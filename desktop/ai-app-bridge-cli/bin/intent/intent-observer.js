'use strict';

const { summarizeTree } = require('../shared-kernel/summary-transformer');
const { intentError } = require('./intent-errors');

async function observeAndCommit(context) {
  const timings = context.timings || {};
  const observeStarted = context.now();
  const observation = await context.adapter.observe({
    serial: context.target.serial,
    packageName: context.target.packageName,
    provider: context.provider,
    rawTreeId: `${context.operationId}:${context.revision}`,
  });
  timings.providerAcquireMs = (timings.providerAcquireMs || 0) + (context.now() - observeStarted);
  if (!observation || observation.ok === false) {
    return intentError(observation?.error || 'provider_failed');
  }
  const persistStarted = context.now();
  const persisted = await context.store.persist('observation', {
    operationId: context.operationId,
    revision: context.revision,
    serial: context.target.serial,
    packageName: context.target.packageName,
    provider: context.provider,
    capturedAtMs: context.now(),
    foregroundTarget: observation.foregroundTarget,
    rawTreeId: observation.rawTreeId,
    rawTree: observation.rawTree,
  });
  timings.evidenceCommitMs = (timings.evidenceCommitMs || 0) + (context.now() - persistStarted);
  if (!persisted.ok) {
    return intentError(persisted.error || 'evidence_not_persisted', { persisted: false });
  }
  const summaryStarted = context.now();
  const summary = summarizeTree({
    provider: context.provider,
    rawTree: observation.rawTree,
    rawTreeId: observation.rawTreeId,
  });
  timings.summaryMs = (timings.summaryMs || 0) + (context.now() - summaryStarted);
  if (!summary.ok) return intentError(summary.error || 'summary_failed');
  const summaryPersist = await context.store.persist('summary', {
    operationId: context.operationId,
    revision: context.revision,
    rawTreeId: observation.rawTreeId,
    summary,
  });
  if (!summaryPersist.ok) return intentError(summaryPersist.error || 'summary_not_persisted');
  const exposed = context.store.canExposeRevision(context.operationId);
  if (!exposed.ok) return intentError(exposed.error);
  context.latestSummary = summary;
  context.latestEvidenceId = persisted.evidenceId;
  context.latestRawTree = observation.rawTree;
  context.latestEvidenceIds = {
    ...context.latestEvidenceIds,
    observation: persisted.evidenceId,
    summary: summaryPersist.evidenceId,
  };
  return {
    ok: true,
    revision: exposed.revision,
    evidenceId: persisted.evidenceId,
    summary: context.latestSummary,
  };
}

module.exports = { observeAndCommit };
