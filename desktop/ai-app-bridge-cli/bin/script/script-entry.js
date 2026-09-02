'use strict';

const { createMemoryEvidenceAdapter } = require('../shared-kernel/evidence-adapters');
const { compileScript } = require('./script-compiler');
const { createFakeScriptDeviceAdapter } = require('./script-device-adapter');
const { scriptError } = require('./script-errors');
const { createScriptEvidenceStore } = require('./script-evidence-store');
const { createScriptWorker } = require('./script-worker');

const operations = new Map();
let sequence = 0;

function handle(args = {}) {
  const operation = args.operation || 'start';
  if (operation === 'start') return start(args);
  if (operation === 'status' || operation === 'progress') return existingOrRestore(args, (worker) => worker.status(args));
  if (operation === 'pause') return existingOrRestore(args, (worker) => worker.pause());
  if (operation === 'resume') return resumeOp(args);
  if (operation === 'cancel') return existingOrRestore(args, (worker) => worker.cancel());
  if (operation === 'intervene') return existingOrRestore(args, (worker) => worker.pause());
  return scriptError('invalid_operation', { operation });
}

function existingOrRestore(args, fn) {
  const existing = operations.get(args.operationId);
  if (existing) return fn(existing);
  if (!args.store) return scriptError('unknown_operation', { operationId: args.operationId || null });
  return read(args, fn);
}

async function start(args) {
  const compiled = compileScript(args.script || args.yaml || args.source);
  if (!compiled.ok) return compiled;
  sequence += 1;
  const operationId = args.operationId || `script-${Date.now()}-${sequence}`;
  const store = args.store || createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const adapter = resolveAdapter(args);
  const worker = createScriptWorker({
    operationId,
    compiled,
    store,
    adapter,
    timeoutMs: args.timeoutMs,
    now: args.now || Date.now,
  });
  operations.set(operationId, worker);
  const started = await store.persist('checkpoint', {
    operationId,
    revision: 1,
    stepId: 'start',
    currentStepIndex: 0,
    completedStepIds: [],
    latestEvidenceRevision: 1,
    script: compiled.script,
    hash: compiled.hash,
    status: 'running',
  });
  if (!started.ok) return scriptError(started.error || 'checkpoint_not_persisted', { operationId });
  return worker.start();
}

async function resumeOp(args) {
  const worker = await loadWorker(args);
  if (!worker || worker.ok === false) return worker || scriptError('unknown_operation', { operationId: args.operationId || null });
  return worker.resume();
}

async function read(args, fn) {
  const worker = await loadWorker(args);
  if (!worker || worker.ok === false) return worker || scriptError('unknown_operation', { operationId: args.operationId || null });
  return fn(worker);
}

async function loadWorker(args) {
  const existing = operations.get(args.operationId);
  if (existing) return existing;
  const restored = await restoreWorker(args);
  if (!restored || restored.ok === false) return restored;
  operations.set(args.operationId, restored);
  return restored;
}

async function restoreWorker(args) {
  const store = args.store;
  if (!store || typeof store.latest !== 'function' || !args.operationId) return null;
  const checkpoint = store.latest(args.operationId, 'checkpoint');
  if (!checkpoint) return null;
  if (unmatchedPreparedAction(store, args.operationId)) {
    return scriptError('ambiguous', {
      operationId: args.operationId,
      status: 'ambiguous',
      pauseReason: 'ambiguous',
    });
  }
  const script = checkpoint.script || args.script;
  if (!script || !Array.isArray(script.steps)) return null;
  const adapter = resolveAdapter(args);
  if (typeof adapter.foreground === 'function') {
    const foreground = await adapter.foreground({
      serial: script.target?.serial,
      packageName: script.target?.packageName,
    });
    if (foreground && foreground.ok === false) {
      return scriptError(foreground.error || 'target_mismatch', { operationId: args.operationId });
    }
  }
  const exposed = store.canExposeRevision(args.operationId);
  if (checkpoint.status === 'paused_manual' && !exposed.ok) {
    return scriptError(exposed.error || 'reobserve_required', { operationId: args.operationId });
  }
  return createScriptWorker({
    operationId: args.operationId,
    compiled: { ok: true, script, hash: checkpoint.hash },
    store,
    adapter,
    timeoutMs: args.timeoutMs,
    now: args.now || Date.now,
    restore: {
      status: checkpoint.status === 'completed' ? 'completed' : 'paused_manual',
      stepIndex: checkpoint.currentStepIndex || 0,
      completedStepIds: checkpoint.completedStepIds || [],
      pauseReason: checkpoint.status === 'paused_manual' ? 'pause_requested' : null,
      summary: store.latest(args.operationId, 'summary')?.summary || null,
      evidenceId: store.latest(args.operationId, 'observation')?.evidenceId || null,
      rawTree: store.latest(args.operationId, 'observation')?.rawTree || null,
      provider: store.latest(args.operationId, 'observation')?.provider || null,
      evidenceIds: {
        observation: store.latest(args.operationId, 'observation')?.evidenceId,
        summary: store.latest(args.operationId, 'summary')?.evidenceId,
        plan: store.latest(args.operationId, 'plan')?.evidenceId,
        marker: store.latest(args.operationId, 'dispatch-marker')?.evidenceId,
        receipt: store.latest(args.operationId, 'action-receipt')?.evidenceId,
        checkpoint: checkpoint.evidenceId,
      },
    },
  });
}

function unmatchedPreparedAction(store, operationId) {
  const records = store.list(operationId);
  const markers = records.filter((item) => item.kind === 'dispatch-marker');
  const marker = markers.length === 0 ? null : markers[markers.length - 1];
  if (!marker || marker.state !== 'prepared') return false;
  const receipt = records.find((item) => item.kind === 'action-receipt' && item.actionId === marker.actionId);
  return !receipt || receipt.ambiguous === true;
}

function resolveAdapter(args) {
  if (args.adapter && typeof args.adapter.observe === 'function') return args.adapter;
  if (args.adapter === 'production') {
    const { createProductionScriptDeviceAdapter } = require('./script-production-adapter');
    return createProductionScriptDeviceAdapter();
  }
  return createFakeScriptDeviceAdapter();
}

function resetScriptOperations() {
  operations.clear();
  sequence = 0;
}

module.exports = { handle, resetScriptOperations };
