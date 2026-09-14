'use strict';

const { createMemoryEvidenceAdapter } = require('../shared-kernel/evidence-adapters');
const { createAutonomousAgentAdapter, createIntentBudget } = require('./intent-autonomous-adapter');
const { createProductionIntentDeviceAdapter } = require('./intent-production-adapter');
const { createIOSIntentDeviceAdapter } = require('./ios-intent-adapter');
const { createWebIntentDeviceAdapter } = require('./web-intent-adapter');
const { intentError } = require('./intent-errors');
const { intentProviderError } = require('./intent-provider');
const { createIntentEvidenceStore } = require('./intent-evidence-store');
const { createIntentWorker } = require('./intent-worker');
const { createEvidenceRecording } = require('../shared-kernel/evidence-recording');
const { normalizeIntentTarget, normalizeObservationTarget } = require('./intent-observation-target');

const operations = new Map();
const ledgers = new Map();
const pendingStarts = new Set();
const reservedIds = new Set();
let closing = false;
const MAX_OPERATIONS = 256;
let sequence = 0;

function handle(args = {}) {
  const operation = args.operation || 'start';
  if (operation === 'start') {
    if (closing) return intentError('runtime_stopping');
    const task = start(args);
    pendingStarts.add(task);
    task.then(() => pendingStarts.delete(task), () => pendingStarts.delete(task));
    return task;
  }
  if (operation === 'decide') return read(args, (worker) => worker.decide(args.decision || args));
  if (operation === 'status') return status(args);
  if (operation === 'observe') return read(args, (worker) => {
    if (worker.isManagedWorkflow && args.observationTarget !== undefined) return intentError('managed_intent_observation_target_fixed', {
      operationId: args.operationId, field: 'observationTarget', dispatched: false, ambiguous: false,
      message: 'Installation and permission workflows use their managed UIAutomator target.',
    });
    if (worker.isManagedWorkflow && args.provider !== undefined && args.provider !== 'uia') return intentError('managed_intent_provider_fixed', {
      operationId: args.operationId, field: 'provider', provider: 'uia', dispatched: false, ambiguous: false,
      message: 'Installation and permission workflows require UIAutomator observations.',
    });
    return worker.observe(args);
  });
  if (operation === 'pause') return read(args, (worker) => worker.pause());
  if (operation === 'resume') return read(args, (worker) => worker.resume());
  if (operation === 'cancel') return read(args, (worker) => worker.cancel());
  if (operation === 'intervene') return read(args, (worker) => worker.intervene(args.reason || 'intervened'));
  return intentError('invalid_operation', { operation });
}

async function start(args) {
  if (!args.goal && !args.install && !args.permissionDialog) {
    return intentError('invalid_intent');
  }
  let target = null, observationTarget = null;
  if (!args.install && !args.permissionDialog) {
    try {
      target = normalizeIntentTarget(args.target);
      observationTarget = normalizeObservationTarget(target, args.provider ?? 'native', args.observationTarget ?? null);
    }
    catch (error) { return intentError(error.code, { field: error.field, message: error.message, dispatched: false, ambiguous: false }); }
    const providerError = intentProviderError(target, args.provider ?? 'native');
    if (providerError) return intentError(providerError.error, { ...providerError, dispatched: false, ambiguous: false });
  }
  sequence += 1;
  const operationId = args.operationId || `intent-${Date.now()}-${sequence}`;
  evictTerminalWorkers();
  evictStaleLedgers();
  if (operations.has(operationId) || reservedIds.has(operationId)) {
    return intentError('operation_exists', { operationId });
  }
  if (operations.size + reservedIds.size >= MAX_OPERATIONS || ledgers.size + reservedIds.size >= MAX_OPERATIONS) {
    return intentError('registry_full', { operationId });
  }
  const store = args.store || createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  if (store.list(operationId).length) return intentError('operation_exists', { operationId });
  let recording = null;
  if (args.recordingDir !== undefined) {
    try {
      recording = createEvidenceRecording({ directory: args.recordingDir, namespace: 'intent', operationId, store,
        now: args.now || Date.now });
    } catch (error) { return intentError(error.code || 'recording_failed', {
      field: 'recordingDir', message: error.detail || error.message, dispatched: false, ambiguous: false,
    }); }
  }
  reservedIds.add(operationId);
  let worker;
  try { worker = args.install
    ? await require('./install-intent').createInstallIntent({ args: args.install, operationId, store, recording })
    : args.permissionDialog
    ? await require('./permission-intent').createPermissionIntent({ args: args.permissionDialog, operationId, store, recording })
    : createIntentWorker({
    operationId,
    goal: args.goal || null,
    target,
    provider: args.provider || 'native',
    observationTarget,
    store,
    adapter: resolveAdapter(args),
    mode: args.mode || 'supervised',
    agent: resolveAgent(args),
    budget: resolveBudget(args),
    timeoutMs: args.timeoutMs,
    now: args.now || Date.now,
    capturePort: args.capturePort || null,
    captureRequirements: args.require || null,
    recording,
  }); } finally { reservedIds.delete(operationId); }
  operations.set(operationId, worker);
  ledgers.set(operationId, { store, status: 'created' });
  return closing ? worker.cancel() : worker.start();
}

function status(args) {
  if (typeof args.operationId !== 'string' || args.operationId.length === 0) return intentError('operationId_required', { field: 'operationId' });
  const worker = operations.get(args.operationId);
  if (worker) return worker.status(args);
  const store = args.store || ledgers.get(args.operationId)?.store;
  if (!store) return intentError('unknown_operation', { operationId: args.operationId || null });
  const records = store.list(args.operationId);
  if (!records.length) return intentError('unknown_operation', { operationId: args.operationId || null });
  for (const record of records) {
    const checked = store.read(record.evidenceId);
    if (!checked.ok) return intentError(checked.error, { operationId: args.operationId });
  }
  const checkpoint = records.findLast(record => record.kind === 'checkpoint');
  const saved = checkpoint?.payloadSummary;
  const history = store.history(args.operationId, args.afterSequence ?? 0, args.limit);
  if (saved && isIntentTerminal(saved.status)) return {
    ...saved, command: 'intent', operationId: args.operationId, ok: saved.status === 'completed',
    live: false, recovered: true, restartPolicy: 'none', terminalEvidenceId: checkpoint.evidenceId, history,
  };
  const unmatched = records.filter(record => record.kind === 'dispatch-marker')
    .filter(marker => !records.some(record => record.kind === 'action-receipt' && record.actionId === marker.actionId));
  return { ok: false, command: 'intent', operationId: args.operationId, status: 'interrupted', error: 'runtime_restarted',
    live: false, recovered: true, restartPolicy: 'none', revision: records.at(-1).revision,
    ambiguous: unmatched.length > 0 || records.some(record => record.kind === 'action-receipt' && record.ambiguous),
    unmatchedActionIds: unmatched.map(marker => marker.actionId), history };
}

function read(args, fn) {
  const worker = operations.get(args.operationId);
  if (!worker) return intentError('unknown_operation', { operationId: args.operationId || null });
  return fn(worker);
}

function resolveAdapter(args) {
  if (args.adapter && typeof args.adapter.observe === 'function') return args.adapter;
  if (args.adapter != null && args.adapter !== 'production') throw new TypeError('invalid_adapter');
  if (args.target?.platform === 'ios') return createIOSIntentDeviceAdapter({ provider: args.ports?.ios });
  if (args.target?.platform === 'web') return createWebIntentDeviceAdapter({ provider: args.ports?.web });
  return createProductionIntentDeviceAdapter({ ports: args.ports, adb: args.adb });
}

function resolveAgent(args) {
  if (args.agent) return args.agent;
  if (args.decide) return createAutonomousAgentAdapter({ decide: args.decide });
  if (args.agentModule) {
    const loaded = require(args.agentModule);
    const decide = typeof loaded.decide === 'function' ? loaded.decide.bind(loaded) : loaded;
    return createAutonomousAgentAdapter({ decide });
  }
  return null;
}

function resolveBudget(args) {
  if (args.budget && typeof args.budget.check === 'function') return args.budget;
  if (args.mode !== 'autonomous' && !args.budget) return null;
  return createIntentBudget(args.budget || {
    maxSteps: args.maxSteps,
    maxDurationMs: args.maxDurationMs,
    maxAgentCalls: args.maxAgentCalls,
    allowlist: args.allowlist,
    now: args.now,
  });
}

function evictTerminalWorkers() {
  for (const [id, worker] of operations) {
    if (!worker.isFinished()) continue;
    const snapshot = worker.status();
    if (!isIntentTerminal(snapshot.status)) continue;
    const entry = ledgers.get(id);
    if (entry) entry.status = snapshot.status;
    operations.delete(id);
  }
}

function evictStaleLedgers() {
  if (ledgers.size < MAX_OPERATIONS) return;
  for (const id of ledgers.keys()) {
    if (operations.has(id)) continue;
    ledgers.delete(id);
    if (ledgers.size < MAX_OPERATIONS) return;
  }
}

function isIntentTerminal(status) {
  return status === 'completed'
    || status === 'failed'
    || status === 'inconclusive'
    || status === 'cancelled'
    || status === 'timeout'
    || status === 'ambiguous'
    || status === 'blocked_evidence_store'
    || status === 'intervention_required';
}

function resetIntentOperations() {
  const settling = Promise.allSettled([...operations.values()].filter(worker => !worker.isFinished()).map(worker => worker.cancel()));
  operations.clear();
  ledgers.clear();
  closing = false;
  sequence = 0;
  return settling;
}

async function cancelActiveIntents() {
  closing = true;
  const cancelKnown = () => Promise.allSettled([...operations.values()]
    .filter(worker => !worker.isFinished()).map(worker => worker.cancel()));
  await cancelKnown();
  await Promise.allSettled([...pendingStarts]);
  await cancelKnown();
}

module.exports = { handle, resetIntentOperations, cancelActiveIntents };
