'use strict';

const { createLiveCaptureQuery } = require('../shared-kernel/live-capture-query');
const { summarizeTree } = require('../shared-kernel/summary-transformer');
const { createDeviceMutationLease } = require('../shared-kernel/device-mutation-lease');
const { authorizeCommand, PERMISSIONS } = require('./script-catalog');
const { createScriptCapturePort, isCaptureReadCommand } = require('./script-capture-port');
const { judgeAssertion, issueObservation, createObservationRegistry } = require('./script-assert');

function createScriptHostPort({
  runner,
  actions,
  query,
  mutationLease = createDeviceMutationLease(),
  target = {},
  permissions,
  executionId,
} = {}) {
  if (typeof actions !== 'function') {
    throw new TypeError('actions');
  }
  const liveQuery = query || (typeof runner === 'function' ? createLiveCaptureQuery({ runner }) : null);
  const capture = liveQuery ? createScriptCapturePort({ query: liveQuery }) : null;
  const observations = createObservationRegistry();
  const watermarks = createObservationRegistry();
  let preActionWatermarks = new Map();
  let mutationTarget = null;
  let afterActionId = null;
  let mutationRevision = 0;
  let pendingMutations = 0;
  let calls = 0;
  let assertions = 0;
  let actionCalls = 0;

  async function call(command, args = {}, options = {}) {
    calls += 1;
    const callId = `call-${calls}`;
    const gate = authorizeCommand(command, permissions);
    if (!gate.ok) {
      return unavailableEnvelope({ command, error: gate.error, executionId, callId });
    }
    if (command === 'page-summary') {
      return pageSummaryResult(args, { executionId, callId });
    }
    const observed = { afterActionId, mutationRevision, pendingMutation: pendingMutations > 0 };
    if (isCaptureReadCommand(command)) {
      const result = await captureResult(command, args, options, { executionId, callId, capture, target });
      const boundTarget = bindDispatchArgs(args, options, target);
      const queryTarget = targetIdentity(boundTarget);
      const boundaryKey = `${command}:${queryTarget}`;
      const metadata = result.evidence.capture;
      const window = result.evidence.window;
      const preAction = preActionWatermarks.get(boundaryKey);
      const matchesQuery = window.filterApplied === true
        && window.afterActionId === afterActionIdOf(args, options)
        && (window.factCursor ?? null) === (args.factCursor ?? null)
        && (window.sinceId ?? null) === (args.sinceId ?? null)
        && (window.sinceMs ?? null) === (args.sinceMs ?? null)
        && typeof metadata.runtimeEpoch === 'string' && metadata.runtimeEpoch.length > 0
        && window.runtimeEpoch === metadata.runtimeEpoch
        && typeof metadata.targetKey === 'string' && metadata.targetKey.length > 0
        && window.targetKey === metadata.targetKey
        && (boundTarget.packageName == null || boundTarget.packageName === metadata.targetKey)
        && ((options.runtimeEpoch ?? args.runtimeEpoch) == null || (options.runtimeEpoch ?? args.runtimeEpoch) === metadata.runtimeEpoch)
        && result.evidence.refs.every((ref) => ref.runtimeEpoch === metadata.runtimeEpoch && ref.targetKey === metadata.targetKey);
      observed.captureValid = Boolean(matchesQuery && metadata.hasMore === false
        && (afterActionIdOf(args, options) === null || afterActionIdOf(args, options) === observed.afterActionId)
        && (observed.mutationRevision === 0 || (
        queryTarget === mutationTarget && preAction
        && args.factCursor === preAction.cursor
        && metadata.runtimeEpoch === preAction.runtimeEpoch
        && metadata.targetKey === preAction.targetKey
      )));
      const coverage = result.evidence.coverage;
      if (matchesQuery && coverage.status === 'complete' && coverage.gap === false && coverage.committed === true
        && typeof metadata.watermarkCursor === 'string' && metadata.watermarkCursor.length > 0
        && !observed.pendingMutation && observed.mutationRevision === mutationRevision) {
        watermarks.set(boundaryKey, {
          cursor: metadata.watermarkCursor,
          runtimeEpoch: metadata.runtimeEpoch,
          targetKey: metadata.targetKey,
          mutationRevision,
        });
      }
      issueObservation(observations, result.evidence, observed, { command, payload: result.result });
      return result;
    }
    if (isMutation(command)) {
      return mutationResult(command, args, options, {
        actions,
        mutationLease,
        target,
        executionId,
        callId,
        onAction: (id) => {
          actionCalls += 1;
          afterActionId = id;
          mutationTarget = targetIdentity(bindDispatchArgs(args, options, target));
          preActionWatermarks = new Map(watermarks.entries().filter(([, item]) => item.mutationRevision === mutationRevision));
          mutationRevision += 1;
          pendingMutations += 1;
        },
        onSettled: () => { pendingMutations -= 1; },
      });
    }
    const result = await actionOnce(command, args, options, {
      actions,
      target,
      executionId,
      callId,
      actionId: null,
      onAction: () => { actionCalls += 1; },
    });
    result.evidence.window.afterActionId = observed.afterActionId;
    issueObservation(observations, result.evidence, observed, {
      command,
      payload: result.result,
      tree: result.ok && ['tree', 'uia-tree', 'flutter-tree', 'flutter-nodes', 'h5-dom', 'ios-uia-tree', 'web-dom'].includes(command),
    });
    return result;
  }

  async function assert(assertion = {}) {
    assertions += 1;
    return judgeAssertion(assertion, observations, { afterActionId, mutationRevision, pendingMutation: pendingMutations > 0 });
  }

  return {
    call,
    assert,
    get callCount() { return calls; },
    get assertionCount() { return assertions; },
    get actionCallCount() { return actionCalls; },
  };
}

function pageSummaryResult(args, ids) {
  const summary = summarizeTree({
    provider: args.provider,
    rawTree: args.rawTree,
    rawTreeId: args.rawTreeId,
    screenshotId: args.screenshotId,
  });
  return envelope({
    ok: summary.ok !== false,
    command: 'page-summary',
    result: summary,
    error: summary.error || null,
    executionId: ids.executionId,
    callId: ids.callId,
    actionId: null,
    coverage: { status: 'complete', gap: false, committed: true },
    refs: Array.isArray(args.refs) ? args.refs : [],
    timings: {},
  });
}

async function captureResult(command, args, options, { executionId, callId, capture, target }) {
  if (!capture) {
    const result = envelope({
      ok: false,
      error: 'capture_unavailable',
      command,
      result: { items: [] },
      executionId,
      callId,
      actionId: null,
      coverage: { status: 'unavailable', gap: true, committed: false },
      refs: [],
      afterActionId: afterActionIdOf(args, options),
      timings: {},
    });
    result.evidence.capture = {};
    return result;
  }
  const afterActionId = afterActionIdOf(args, options);
  const window = await capture.query(command, bindDispatchArgs(args, options, target), {
    actionId: afterActionId,
    timeoutMs: timeoutMsOf(options),
    evidenceWindow: options.evidenceWindow,
    runtimeEpoch: options.runtimeEpoch,
    runtimeEpochChanged: options.runtimeEpochChanged,
    disconnected: options.disconnected,
  });
  const result = envelope({
    ok: window.ok !== false && !window.error && window.coverage.status !== 'unavailable',
    error: window.error || window.reason || null,
    command,
    result: { items: window.items },
    executionId,
    callId,
    actionId: null,
    coverage: window.coverage,
    refs: window.refs,
    afterActionId,
    timings: {},
  });
  result.evidence.window = window.window ? structuredClone(window.window) : { afterActionId: null };
  result.evidence.capture = {
    storeGeneration: window.storeGeneration ?? null,
    throughWatermark: window.throughWatermark ?? null,
    runtimeEpoch: window.runtimeEpoch ?? null,
    targetKey: window.targetKey ?? null,
    watermarkCursor: window.watermarkCursor ?? null,
    nextCursor: window.nextCursor ?? null,
    hasMore: window.hasMore ?? null,
  };
  return result;
}

function targetIdentity(target) {
  return JSON.stringify([target.serial ?? null, target.packageName ?? null]);
}

async function mutationResult(command, args, options, ctx) {
  const actionId = options.dispatchActionId || mutationActionId(ctx.executionId, ctx.callId);
  const bound = bindDispatchArgs(args, options, ctx.target, actionId);
  const held = ctx.mutationLease.acquire(bound.serial);
  if (!held.ok) {
    return unavailableEnvelope({
      command,
      error: held.error,
      executionId: ctx.executionId,
      callId: ctx.callId,
    });
  }
  try {
    return await actionOnce(command, bound, options, {
      actions: ctx.actions,
      target: ctx.target,
      executionId: ctx.executionId,
      callId: ctx.callId,
      actionId,
      onAction: ctx.onAction,
    });
  } finally {
    ctx.onSettled();
    held.release();
  }
}

async function actionOnce(command, args, options, { actions, target, executionId, callId, actionId, onAction }) {
  onAction(actionId);
  let raw;
  try {
    raw = await actions(command, bindDispatchArgs(args, options, target, actionId), options);
  } catch (error) {
    return envelope({
      ok: false,
      command,
      result: null,
      error: (error && error.message) || String(error),
      ambiguous: actionId !== null,
      executionId,
      callId,
      actionId,
      coverage: { status: 'unavailable', gap: true, committed: false },
      refs: [],
      timings: {},
    });
  }
  if (raw && raw.ambiguous === true) {
    return envelope({
      ok: false,
      command,
      result: raw,
      error: raw.error || 'ambiguous',
      ambiguous: true,
      executionId,
      callId,
      actionId,
      coverage: { status: 'unavailable', gap: true, committed: false },
      refs: actionRefs(command, raw),
      timings: raw.timings || {},
    });
  }
  return envelope({
    ok: raw != null && raw.ok !== false && !raw.error,
    command,
    result: raw && raw.result !== undefined ? raw.result : raw,
    error: raw && raw.error ? raw.error : null,
    executionId,
    callId,
    actionId,
    coverage: raw == null || raw.ok === false || raw.error
      ? { status: 'unavailable', gap: true, committed: false }
      : { status: 'complete', gap: false, committed: true },
    refs: actionRefs(command, raw),
    timings: raw?.timings || {},
  });
}

function actionRefs(command, raw) {
  if (raw?.ok === false) return [];
  if (Array.isArray(raw?.refs)) return raw.refs;
  if (
    (command === 'screenshot' || command === 'ios-screenshot')
    && typeof raw?.path === 'string'
    && raw.path.length > 0
  ) {
    return [{ stream: 'screenshot', screenshotId: raw.path,
      ...(/^[a-f0-9]{64}$/.test(raw.artifact?.sha256 || '') ? { sha256: raw.artifact.sha256 } : {}) }];
  }
  return [];
}

function envelope({
  ok,
  command,
  result,
  error,
  ambiguous,
  executionId,
  callId,
  actionId,
  coverage,
  refs,
  afterActionId,
  timings,
}) {
  return {
    ok,
    command,
    result,
    error: error || null,
    ambiguous: ambiguous === true,
    execution: { executionId, callId, actionId },
    evidence: {
      window: { afterActionId: afterActionId === undefined ? actionId : afterActionId, closedAtMs: 0 },
      coverage,
      refs,
    },
    timings,
  };
}

function unavailableEnvelope({ command, error, executionId, callId }) {
  return envelope({
    ok: false,
    command,
    result: null,
    error,
    executionId,
    callId,
    actionId: null,
    coverage: { status: 'unavailable', gap: true, committed: false },
    refs: [],
    timings: {},
  });
}

function mutationActionId(executionId, callId) {
  const suffix = `action-${callId.slice('call-'.length)}`;
  if (executionId == null || executionId === '') return suffix;
  return `${executionId}:${suffix}`;
}

function bindDispatchArgs(args, options, target = {}, actionId) {
  const bound = { ...args };
  if (bound.serial == null && target.serial != null) {
    bound.serial = target.serial;
  }
  if (bound.packageName == null && target.packageName != null) {
    bound.packageName = target.packageName;
  }
  if (actionId != null) {
    bound.requestId = actionId;
  }
  return bound;
}

function afterActionIdOf(args, options) {
  if (options.evidenceWindow && options.evidenceWindow.afterActionId != null) {
    return options.evidenceWindow.afterActionId;
  }
  if (options.actionId != null) return options.actionId;
  if (args.afterActionId != null) return args.afterActionId;
  return null;
}

function timeoutMsOf(options) {
  if (options.evidenceWindow && options.evidenceWindow.timeoutMs != null) {
    return options.evidenceWindow.timeoutMs;
  }
  return null;
}

function isMutation(command) {
  return PERMISSIONS['app.interact'].includes(command) && !command.includes('wait');
}

module.exports = { createScriptHostPort };
