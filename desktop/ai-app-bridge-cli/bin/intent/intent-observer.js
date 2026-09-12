'use strict';

const { summarizeTree } = require('../shared-kernel/summary-transformer');
const { intentError } = require('./intent-errors');
const { checkExecution } = require('../shared-kernel/execution-scope');
const { capturePageMetadata } = require('../shared-kernel/live-capture-query');

async function observeAndCommit(context, provider = context.provider, observationTarget = context.observationTarget) {
  const timings = context.timings || {};
  const observeStarted = context.now();
  const observation = await context.adapter.observe({
    ...context.target,
    provider,
    observationTarget,
    rawTreeId: `${context.operationId}:${context.revision}`,
  });
  checkExecution();
  timings.providerAcquireMs = (timings.providerAcquireMs || 0) + (context.now() - observeStarted);
  if (!observation || observation.ok === false) {
    const failure = { provider, observationTarget, revision: context.revision, response: observation };
    const persisted = await context.store.persist('checkpoint', { operationId: context.operationId,
      revision: context.revision, target: context.target, stepId: 'observation-failed', timestampMs: context.now(),
      payloadSummary: { observationFailure: failure } });
    if (!persisted.ok) return intentError(persisted.error || 'evidence_not_persisted', { persisted: false });
    checkExecution();
    context.observationFailure = { ...failure, evidenceId: persisted.evidenceId };
    context.latestEvidenceIds = { ...context.latestEvidenceIds, observationFailure: persisted.evidenceId };
    return intentError(observation?.error || 'provider_failed', { stage: 'provider' });
  }
  const routed = context.target.foregroundPackages !== undefined;
  if (routed && (!observation.route || !['native', 'uia', 'flutter', 'h5'].includes(observation.provider))) return intentError('foreground_observation_required');
  const activeProvider = routed ? observation.provider : provider;
  const capture = await observeCapture(context);
  checkExecution();
  const persistStarted = context.now();
  const observationRecord = {
    operationId: context.operationId,
    revision: context.revision,
    target: context.target,
    observedTarget: routed ? { ...context.target, packageName: observation.route.packageName } : context.target,
    provider: activeProvider,
    observationTarget,
    capturedAtMs: context.now(),
    foregroundTarget: observation.foregroundTarget,
    rawTreeId: observation.rawTreeId,
    rawTree: observation.rawTree,
    ...(routed ? { route: observation.route, requestedTarget: context.target } : {}),
  };
  if (capture) {
    observationRecord.captureRefs = capture.refs;
    observationRecord.captureCoverage = capture.coverage;
    observationRecord.capturePages = capture.pages.map(capturePageMetadata);
  }
  const persisted = await context.store.persist('observation', observationRecord);
  timings.evidenceCommitMs = (timings.evidenceCommitMs || 0) + (context.now() - persistStarted);
  if (!persisted.ok) {
    return intentError(persisted.error || 'evidence_not_persisted', { persisted: false });
  }
  checkExecution();
  if (capture && context.recording) {
    const saved = await context.recording.record({ kind: 'intent-capture', revision: context.revision,
      target: context.target, parentFactId: persisted.evidenceId,
      data: { rawTreeId: observation.rawTreeId, capture } });
    if (!saved.ok) return intentError(saved.error, { persisted: false });
    checkExecution();
  }
  const summaryStarted = context.now();
  const summary = summarizeTree({
    provider: activeProvider,
    rawTree: observation.rawTree,
    rawTreeId: observation.rawTreeId,
    ...(routed ? { maxBytes: 64 * 1024 - Buffer.byteLength(JSON.stringify(observation.route), 'utf8') - 32 } : {}),
  });
  timings.summaryMs = (timings.summaryMs || 0) + (context.now() - summaryStarted);
  if (!summary.ok) return intentError(summary.error || 'summary_failed');
  if (routed) summary.foreground = observation.route;
  const summaryPersist = await context.store.persist('summary', {
    operationId: context.operationId,
    revision: context.revision,
    rawTreeId: observation.rawTreeId,
    target: context.target,
    timestampMs: context.now(),
    observationTarget,
    summary,
  });
  if (!summaryPersist.ok) return intentError(summaryPersist.error || 'summary_not_persisted');
  checkExecution();
  const exposed = context.store.canExposeRevision(context.operationId);
  if (!exposed.ok) return intentError(exposed.error);
  context.provider = provider;
  context.observationTarget = observationTarget;
  context.observationFailure = null;
  delete context.latestEvidenceIds.observationFailure;
  context.latestSummary = summary;
  context.latestProvider = activeProvider;
  context.latestRoute = observation.route;
  context.latestEvidenceId = persisted.evidenceId;
  context.latestCapture = capture;
  context.latestRawTree = observation.rawTree;
  context.latestRawTreeId = observation.rawTreeId;
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

async function observeCapture(context) {
  if (!context.capturePort || !context.captureRequirements) return null;
  const { streams, ...requirements } = context.captureRequirements;
  if (streams.length === 0) return null;
  const pages = [];
  context.captureWatermarks ||= new Map();
  for (const stream of streams) {
    const previous = context.captureWatermarks.get(stream);
    const actionCursor = previous && previous.actionId === context.actionId ? previous.actionCursor : previous?.cursor;
    const page = await context.capturePort.observe({
      ...requirements,
      stream,
      ...(context.actionId && previous && requirements.view !== 'connected-history' && requirements.history !== true
        ? { factCursor: requirements.factCursor ?? actionCursor, runtimeEpoch: requirements.runtimeEpoch ?? previous.epoch }
        : {}),
    }, {
      target: context.target,
      platform: context.target.platform,
      actionId: context.actionId,
      runtimeEpoch: context.runtimeEpoch,
      runtimeEpochChanged: context.runtimeEpochChanged === true,
      disconnected: context.disconnected === true,
    });
    // An issued watermark bounds the next action even if earlier retained data
    // has a known gap. The current observation keeps that partial coverage.
    if (page.committed === true && ['complete', 'partial'].includes(page.coverage.status)
      && page.watermarkCursor && page.runtimeEpoch) {
      context.captureWatermarks.set(stream, { cursor: page.watermarkCursor, epoch: page.runtimeEpoch,
        actionId: context.actionId, actionCursor: context.actionId ? requirements.factCursor ?? actionCursor : null });
    }
    pages.push({ stream, ...page });
  }
  return mergeCapturePages(pages);
}

function mergeCapturePages(pages) {
  const refs = [];
  const items = [];
  let gap = false;
  let committed = true;
  let status = null;
  for (const page of pages) {
    refs.push(...page.refs);
    items.push(...page.items);
    if (page.gap) gap = true;
    if (page.committed !== true) committed = false;
    const pageStatus = page.coverage && page.coverage.status;
    if (
      pageStatus !== 'complete'
      && pageStatus !== 'partial'
      && pageStatus !== 'unavailable'
    ) {
      status = 'unavailable';
    } else if (pageStatus === 'unavailable' || status === 'unavailable') {
      status = 'unavailable';
    } else if (pageStatus === 'partial' || status === 'partial') {
      status = 'partial';
    } else {
      status = 'complete';
    }
  }
  if (status == null) {
    return {
      coverage: { status: 'unavailable', gap: true, committed: false },
      gap: true,
      committed: false,
      refs: [],
      items: [],
    };
  }
  return {
    coverage: { status, gap, committed },
    gap,
    committed,
    refs,
    items,
    pages,
  };
}

module.exports = { observeAndCommit };
