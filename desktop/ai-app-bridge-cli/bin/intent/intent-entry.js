'use strict';

const { createMemoryEvidenceAdapter } = require('../shared-kernel/evidence-adapters');
const { createAutonomousAgentAdapter, createIntentBudget } = require('./intent-autonomous-adapter');
const { createProductionIntentDeviceAdapter } = require('./intent-production-adapter');
const { intentError } = require('./intent-errors');
const { createIntentEvidenceStore } = require('./intent-evidence-store');
const { createIntentWorker } = require('./intent-worker');
const { createEvidenceRecording } = require('../shared-kernel/evidence-recording');

const operations = new Map();
const ledgers = new Map();
const MAX_OPERATIONS = 256;
let sequence = 0;

function handle(args = {}) {
  const operation = args.operation || 'start';
  if (operation === 'start') return start(args);
  if (operation === 'decide') return read(args, (worker) => worker.decide(args.decision || args));
  if (operation === 'status') return status(args);
  if (operation === 'observe' || operation === 'reobserve') return read(args, (worker) => worker.observe(args));
  if (operation === 'pause') return read(args, (worker) => worker.pause());
  if (operation === 'resume') return read(args, (worker) => worker.resume());
  if (operation === 'cancel') return read(args, (worker) => worker.cancel());
  if (operation === 'intervene') return read(args, (worker) => worker.intervene(args.reason || 'intervened'));
  return intentError('invalid_operation', { operation });
}

async function start(args) {
  if (!args.goal && !args.intent) {
    return intentError('invalid_intent');
  }
  sequence += 1;
  const operationId = args.operationId || `intent-${Date.now()}-${sequence}`;
  evictTerminalWorkers();
  evictStaleLedgers();
  if (operations.has(operationId)) {
    return intentError('operation_exists', { operationId });
  }
  if (operations.size >= MAX_OPERATIONS || ledgers.size >= MAX_OPERATIONS) {
    return intentError('registry_full', { operationId });
  }
  const store = args.store || createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  let recording = null;
  if (args.recordingDir !== undefined) {
    try {
      recording = createEvidenceRecording({ directory: args.recordingDir, namespace: 'intent', operationId, store,
        now: args.now || Date.now });
    } catch (error) { return intentError(error.code || 'recording_failed', { operationId }); }
  }
  const worker = createIntentWorker({
    operationId,
    goal: args.goal || args.intent || null,
    target: args.target || { serial: args.serial || null, packageName: args.packageName || null },
    provider: args.provider || 'native',
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
  });
  operations.set(operationId, worker);
  ledgers.set(operationId, { ledger: store.ledger, status: 'created' });
  return worker.start();
}

function status(args) {
  const worker = operations.get(args.operationId);
  if (worker) return worker.status(args);
  const entry = ledgers.get(args.operationId);
  if (!entry) return intentError('unknown_operation', { operationId: args.operationId || null });
  const snap = entry.ledger.snapshot(args.operationId);
  if (!snap.lastFact) return intentError('unknown_operation', { operationId: args.operationId || null });
  return {
    ok: true,
    command: 'intent',
    operationId: args.operationId,
    status: entry.status,
    history: entry.ledger.query(
      args.operationId,
      args.afterSequence == null ? 0 : args.afterSequence,
      args.limit,
    ),
  };
}

function read(args, fn) {
  const worker = operations.get(args.operationId);
  if (!worker) return intentError('unknown_operation', { operationId: args.operationId || null });
  return fn(worker);
}

function resolveAdapter(args) {
  if (args.adapter && typeof args.adapter.observe === 'function') return args.adapter;
  if (args.adapter != null && args.adapter !== 'production') throw new TypeError('invalid_adapter');
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
  operations.clear();
  ledgers.clear();
  sequence = 0;
}

module.exports = { handle, resetIntentOperations };
