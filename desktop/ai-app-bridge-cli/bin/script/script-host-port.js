'use strict';

const { createLiveCaptureQuery } = require('../shared-kernel/live-capture-query');
const { summarizeTree } = require('../shared-kernel/summary-transformer');
const { createDeviceMutationLease } = require('../shared-kernel/device-mutation-lease');
const { admitExecutionMutation } = require('../shared-kernel/execution-admission');
const { authorizeCommand } = require('./script-catalog');
const { isMutationCommand } = require('../command-registry');
const { normalizeExecutionTarget, bindCommandTarget, targetFingerprint } = require('../shared-kernel/execution-target');
const { createScriptCapturePort, isCaptureReadCommand } = require('./script-capture-port');
const { judgeAssertion, issueObservation, createObservationRegistry } = require('./script-assert');

function createScriptHostPort({
  runner,
  actions,
  query,
  mutationLease = createDeviceMutationLease(),
  target = null,
  permissions,
  executionId,
} = {}) {
  if (typeof actions !== 'function') {
    throw new TypeError('actions');
  }
  const defaultTarget = normalizeExecutionTarget(target, { nullable: true });
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
    if ((command === 'logcat' && args.clear === true) || (['webview-network', 'webview-console'].includes(command) && args.script !== undefined)) {
      return unavailableEnvelope({ command, error: 'capture_mutation_not_allowed', executionId, callId });
    }
    if (command === 'page-summary') {
      return pageSummaryResult(args, { executionId, callId });
    }
    let binding;
    try { binding = bindCommandTarget(command, args, defaultTarget, options.target); }
    catch (error) {
      return { ...unavailableEnvelope({ command, error: error.code || 'invalid_target', executionId, callId }),
        field: error.field, message: error.message, dispatched: false, ambiguous: false };
    }
    args = binding.args;
    const boundTarget = binding.target;
    const stamp = result => { result.execution.target = structuredClone(boundTarget); return result; };
    const observed = { afterActionId, mutationRevision, pendingMutation: pendingMutations > 0 };
    if (isCaptureReadCommand(command)) {
      const result = await captureResult(command, args, options, { executionId, callId, capture, target: boundTarget });
      const queryTarget = targetFingerprint(boundTarget);
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
        && ((boundTarget.packageName ?? boundTarget.bundleId) == null || (boundTarget.packageName ?? boundTarget.bundleId) === metadata.targetKey)
        && ((options.runtimeEpoch ?? args.runtimeEpoch) == null || (options.runtimeEpoch ?? args.runtimeEpoch) === metadata.runtimeEpoch)
        && result.evidence.refs.every((ref) => ref.runtimeEpoch === metadata.runtimeEpoch && ref.targetKey === metadata.targetKey);
      // A continuation page alone cannot prove a whole decision window.
      observed.captureValid = Boolean(matchesQuery && metadata.hasMore === false && args.cursor === undefined
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
      return stamp(result);
    }
    if (isMutationCommand(command, args)) {
      return stamp(await mutationResult(command, args, options, {
        actions,
        mutationLease,
        target: boundTarget,
        executionId,
        callId,
        onAction: (id) => {
          actionCalls += 1;
          afterActionId = id;
          mutationTarget = targetFingerprint(boundTarget);
          preActionWatermarks = new Map(watermarks.entries().filter(([, item]) => item.mutationRevision === mutationRevision));
          mutationRevision += 1;
          pendingMutations += 1;
        },
        onSettled: () => { pendingMutations -= 1; },
      }));
    }
    const result = await actionOnce(command, args, options, {
      actions,
      target: boundTarget,
      executionId,
      callId,
      actionId: null,
      onAction: () => { actionCalls += 1; },
    });
    result.evidence.window.afterActionId = observed.afterActionId;
    issueObservation(observations, result.evidence, observed, {
      command,
      payload: result.result,
      tree: result.ok && ['tree', 'uia-tree', 'flutter-tree', 'flutter-nodes', 'h5-dom', 'flutter-h5-dom', 'ios-tree', 'ios-uia-tree', 'ios-flutter-tree', 'ios-flutter-nodes', 'ios-h5-dom', 'web-dom'].includes(command),
    });
    return stamp(result);
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
  const window = await capture.query(command, dispatchArgs(args), {
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
    ...(window.barrier === undefined ? {} : { barrier: structuredClone(window.barrier) }),
  };
  return result;
}

async function mutationResult(command, args, options, ctx) {
  const actionId = options.dispatchActionId || mutationActionId(ctx.executionId, ctx.callId);
  const bound = dispatchArgs(args, actionId);
  try {
    return await admitExecutionMutation(ctx.target, ctx.mutationLease, async () => {
      try { return await actionOnce(command, bound, options, {
      actions: ctx.actions,
      target: ctx.target,
      executionId: ctx.executionId,
      callId: ctx.callId,
      actionId,
      onAction: ctx.onAction,
      }); } finally { ctx.onSettled(); }
    });
  } catch (error) {
    return unavailableEnvelope({ command, error: error.code || error.message, executionId: ctx.executionId, callId: ctx.callId });
  }
}

async function actionOnce(command, args, options, { actions, target, executionId, callId, actionId, onAction }) {
  onAction(actionId);
  let raw;
  try {
    raw = await actions(command, dispatchArgs(args, actionId), options);
  } catch (error) {
    return envelope({
      ok: false,
      command,
      result: null,
      error: error?.code || error?.message || String(error),
      dispatched: error?.dispatched,
      ambiguous: error?.ambiguous ?? actionId !== null,
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
      dispatched: raw.dispatched,
      executionReceipt: raw.executionReceipt ?? null,
      executionReceipts: raw.executionReceipts,
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
    dispatched: raw?.dispatched,
    executionReceipt: raw?.executionReceipt ?? null,
    executionReceipts: raw?.executionReceipts,
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
  const screenshotPath = command === 'ios-screenshot' ? raw?.outFile : raw?.path;
  if (
    (command === 'screenshot' || command === 'ios-screenshot')
    && typeof screenshotPath === 'string'
    && screenshotPath.length > 0
  ) {
    return [{ stream: 'screenshot', screenshotId: screenshotPath,
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
  dispatched = actionId !== null,
  executionReceipt = null,
  executionReceipts,
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
    dispatched,
    executionReceipt,
    ...(executionReceipts === undefined ? {} : { executionReceipts }),
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

function dispatchArgs(args, actionId) {
  return { ...args, ...(actionId == null ? {} : { requestId: actionId }) };
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

module.exports = { createScriptHostPort, unavailableEnvelope };
