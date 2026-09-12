'use strict';

// Synthetic protocol metadata for Host tests; these are not captured SDK facts.
function nativeTargetRef(viewId = 'fixture-view') {
  return { schemaVersion: 'aab.native-target/v1', runtimeEpoch: 'fixture-epoch',
    windowId: 'fixture-window', viewId, guard: 'a'.repeat(64) };
}

function withNativeTargetRefs(tree) {
  const copy = structuredClone(tree);
  const visit = (node, id) => {
    if (!node) return;
    node.targetRef = nativeTargetRef(id);
    for (const [index, child] of (node.children || []).entries()) visit(child, `${id}/${index}`);
  };
  visit(copy.root, 'root');
  for (const [index, window] of (copy.windows || []).entries()) visit(window.root, `window-${index}`);
  return copy;
}

function nativeRuntimeStatus(packageName) {
  return { ok: true, app: { packageName }, debugBridge: {
    nativeExecutionSchema: 'aab.native-execution/v1', runtimeEpoch: 'fixture-epoch',
  } };
}

const nativeBridgeStatus = async ctx => nativeRuntimeStatus(ctx.packageName);

function nativeExecutionReceipt(request, result = {}) {
  const { schemaVersion, actionId, runtimeEpoch } = request.execution;
  return { ok: true, dispatched: true, ambiguous: false, ...result, actionId, runtimeEpoch, settled: true,
    execution: { schemaVersion, actionId, runtimeEpoch, settled: true } };
}

module.exports = { nativeTargetRef, withNativeTargetRefs, nativeRuntimeStatus, nativeBridgeStatus, nativeExecutionReceipt };
