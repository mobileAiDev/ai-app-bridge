'use strict';

const { createMemoryEvidenceAdapter } = require('../shared-kernel/evidence-adapters');
const { createAutonomousAgentAdapter, createIntentBudget } = require('./intent-autonomous-adapter');
const { createFakeIntentDeviceAdapter } = require('./intent-device-adapter');
const { intentError } = require('./intent-errors');
const { createIntentEvidenceStore } = require('./intent-evidence-store');
const { createIntentWorker } = require('./intent-worker');

const operations = new Map();
let sequence = 0;

function handle(args = {}) {
  const operation = args.operation || 'start';
  if (operation === 'start') return start(args);
  if (operation === 'decide') return read(args, (worker) => worker.decide(args.decision || args));
  if (operation === 'status') return read(args, (worker) => worker.status());
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
  const worker = createIntentWorker({
    operationId,
    goal: args.goal || args.intent || null,
    target: args.target || { serial: args.serial || null, packageName: args.packageName || null },
    provider: args.provider || 'native',
    store: args.store || createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() }),
    adapter: resolveAdapter(args),
    mode: args.mode || 'supervised',
    agent: resolveAgent(args),
    budget: resolveBudget(args),
    timeoutMs: args.timeoutMs,
    now: args.now || Date.now,
  });
  operations.set(operationId, worker);
  return worker.start();
}

function read(args, fn) {
  const worker = operations.get(args.operationId);
  if (!worker) return intentError('unknown_operation', { operationId: args.operationId || null });
  return fn(worker);
}

function resolveAdapter(args) {
  if (args.adapter && typeof args.adapter.observe === 'function') return args.adapter;
  if (args.adapter === 'production') {
    const { createProductionIntentDeviceAdapter } = require('./intent-production-adapter');
    return createProductionIntentDeviceAdapter();
  }
  return createFakeIntentDeviceAdapter();
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

function resetIntentOperations() {
  operations.clear();
  sequence = 0;
}

module.exports = { handle, resetIntentOperations };
