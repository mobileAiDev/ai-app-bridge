'use strict';

const { summarizeTree } = require('../shared-kernel/summary-transformer');
const { intentError } = require('./intent-errors');

async function observeAndCommit(context) {
  const timings = context.timings || {};
  const observeStarted = context.now();
  const observation = await context.adapter.observe({
    ...context.target,
    provider: context.provider,
    rawTreeId: `${context.operationId}:${context.revision}`,
  });
  timings.providerAcquireMs = (timings.providerAcquireMs || 0) + (context.now() - observeStarted);
  if (!observation || observation.ok === false) {
    return intentError(observation?.error || 'provider_failed', { stage: 'provider' });
  }
  const routed = context.target.foregroundPackages !== undefined;
  if (routed && (!observation.route || !['native', 'uia', 'flutter'].includes(observation.provider))) return intentError('foreground_observation_required');
  const activeProvider = routed ? observation.provider : context.provider;
  const capture = await observeCapture(context);
  const persistStarted = context.now();
  const observationRecord = {
    operationId: context.operationId,
    revision: context.revision,
    serial: context.target.serial,
    packageName: routed ? observation.route.packageName : context.target.packageName,
    provider: activeProvider,
    capturedAtMs: context.now(),
    foregroundTarget: observation.foregroundTarget,
    rawTreeId: observation.rawTreeId,
    rawTree: observation.rawTree,
    ...(routed ? { route: observation.route, requestedTarget: context.target } : {}),
  };
  if (capture) {
    observationRecord.captureRefs = capture.refs;
    observationRecord.captureCoverage = capture.coverage;
    observationRecord.capturePages = capture.pages.map((page) => ({
      stream: page.stream,
      coverage: page.coverage,
      window: page.window,
      runtimeEpoch: page.runtimeEpoch,
      targetKey: page.targetKey,
      storeGeneration: page.storeGeneration,
      watermarkCursor: page.watermarkCursor,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      throughWatermark: page.throughWatermark,
      error: page.error || page.reason || null,
    }));
  }
  const persisted = await context.store.persist('observation', observationRecord);
  timings.evidenceCommitMs = (timings.evidenceCommitMs || 0) + (context.now() - persistStarted);
  if (!persisted.ok) {
    return intentError(persisted.error || 'evidence_not_persisted', { persisted: false });
  }
  if (capture && context.recording) {
    const saved = await context.recording.record({ kind: 'intent-capture', revision: context.revision,
      target: context.target, parentFactId: persisted.evidenceId,
      data: { rawTreeId: observation.rawTreeId, capture } });
    if (!saved.ok) return intentError(saved.error, { persisted: false });
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
    summary,
  });
  if (!summaryPersist.ok) return intentError(summaryPersist.error || 'summary_not_persisted');
  const exposed = context.store.canExposeRevision(context.operationId);
  if (!exposed.ok) return intentError(exposed.error);
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
  const require = context.captureRequirements;
  const streams = Array.isArray(require.streams)
    ? require.streams
    : require.stream
      ? [require.stream]
      : [];
  if (streams.length === 0) return null;
  const pages = [];
  context.captureWatermarks ||= new Map();
  for (const stream of streams) {
    const previous = context.captureWatermarks.get(stream);
    const page = await context.capturePort.observe({
      ...require,
      stream,
      ...(context.actionId && previous && require.view !== 'connected-history' && require.history !== true
        ? { factCursor: require.factCursor ?? previous.cursor, runtimeEpoch: require.runtimeEpoch ?? previous.epoch }
        : {}),
    }, {
      target: context.target,
      platform: context.target.platform,
      actionId: context.actionId,
      runtimeEpoch: context.runtimeEpoch,
      runtimeEpochChanged: context.runtimeEpochChanged === true,
      disconnected: context.disconnected === true,
    });
    if (page.coverage.status === 'complete' && page.watermarkCursor && page.runtimeEpoch) {
      context.captureWatermarks.set(stream, { cursor: page.watermarkCursor, epoch: page.runtimeEpoch });
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
