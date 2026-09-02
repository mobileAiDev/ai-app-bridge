'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { androidAppTargetKey, createTargetLease } = require('../bin/shared-kernel/target-lease-protocol');
const { createFakeScriptDeviceAdapter } = require('../bin/script/script-device-adapter');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { handle: scriptHandle, resetScriptOperations } = require('../bin/script/script-entry');
const { createFakeIntentDeviceAdapter } = require('../bin/intent/intent-device-adapter');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createAutonomousAgentAdapter, createIntentBudget } = require('../bin/intent/intent-autonomous-adapter');
const { handle: intentHandle, resetIntentOperations } = require('../bin/intent/intent-entry');
const { createCommandRouter } = require('../bin/command-router');
const { runBatch, runBridgeChecked } = require('../bin/mcp-server');

const ROUNDS = 100;
const TARGET = { serial: 'b46093e6', packageName: 'com.example.app' };
const TREE = {
  root: {
    id: 'root',
    className: 'Button',
    text: 'Home',
    clickable: true,
    children: [{ id: 'about', className: 'Button', text: 'About', clickable: true }],
  },
};

function scriptStore() {
  return createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
}

function intentStore() {
  return createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
}

function eightStepScript() {
  return {
    name: 'g8-speed',
    target: TARGET,
    steps: [
      { id: 'o1', type: 'observe', provider: 'native' },
      { id: 'a1', type: 'action', action: 'tap', text: 'About' },
      { id: 'o2', type: 'observe', provider: 'native' },
      { id: 'a2', type: 'action', action: 'tap', text: 'About' },
      { id: 'o3', type: 'observe', provider: 'native' },
      { id: 'a3', type: 'action', action: 'tap', text: 'About' },
      { id: 's1', type: 'assert', text: 'About' },
      { id: 'k1', type: 'checkpoint' },
    ],
  };
}

function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function activeIoCount() {
  const handles = typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : 0;
  const requests = typeof process._getActiveRequests === 'function' ? process._getActiveRequests().length : 0;
  return handles + requests;
}

test('G8 isolation and no UiA2 or ADB recovery remain in Script/Intent', () => {
  const dirs = [
    path.join(__dirname, '../bin/script'),
    path.join(__dirname, '../bin/intent'),
    path.join(__dirname, '../bin/shared-kernel'),
  ];
  for (const dir of dirs) {
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.equal(/uia2|am instrument|adb reconnect|kill-server|wait-for-device/i.test(source), false, file);
    }
  }
  const scriptDir = fs.readdirSync(path.join(__dirname, '../bin/script'));
  for (const file of scriptDir.filter((name) => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(__dirname, '../bin/script', file), 'utf8');
    assert.equal(/intent\/|legacy\/|runBatch|runBridgeChecked|LegacyDispatcher/.test(source), false, file);
  }
});

test('G8 Script 100x start, cancel, and timeout; maxActive stays 1', async () => {
  resetScriptOperations();
  const lease = createTargetLease();
  const adapter = createFakeScriptDeviceAdapter({ trees: { native: TREE }, lease });
  let completed = 0;
  let cancelled = 0;
  let timedOut = 0;
  for (let i = 0; i < ROUNDS; i += 1) {
    const started = await scriptHandle({
      operation: 'start',
      operationId: `g8-script-start-${i}`,
      script: eightStepScript(),
      store: scriptStore(),
      adapter,
    });
    assert.equal(started.status, 'completed');
    assert.equal(started.ok, true);
    completed += 1;
  }
  for (let i = 0; i < ROUNDS; i += 1) {
    const operationId = `g8-script-cancel-${i}`;
    await scriptHandle({
      operation: 'start',
      operationId,
      script: eightStepScript(),
      store: scriptStore(),
      adapter,
    });
    const result = scriptHandle({ operation: 'cancel', operationId });
    assert.equal(result.status, 'cancelled');
    cancelled += 1;
  }
  for (let i = 0; i < ROUNDS; i += 1) {
    const result = await scriptHandle({
      operation: 'start',
      operationId: `g8-script-timeout-${i}`,
      timeoutMs: 0,
      script: eightStepScript(),
      store: scriptStore(),
      adapter,
    });
    assert.equal(result.error, 'timeout');
    assert.equal(result.status, 'paused_failure');
    timedOut += 1;
  }
  assert.equal(completed, ROUNDS);
  assert.equal(cancelled, ROUNDS);
  assert.equal(timedOut, ROUNDS);
  assert.equal(adapter.maxActive, 1);
  const targetKey = androidAppTargetKey(TARGET.serial, TARGET.packageName);
  assert.equal(lease.status(targetKey).maxActive, 1);
  assert.equal(lease.status(targetKey).active, 0);
});

test('G8 Intent supervised and autonomous 100x start, decide, cancel, timeout', async () => {
  resetIntentOperations();
  const adapter = createFakeIntentDeviceAdapter({ trees: { native: TREE } });
  let supervised = 0;
  let autonomous = 0;
  let cancelled = 0;
  let timedOut = 0;
  for (let i = 0; i < ROUNDS; i += 1) {
    const operationId = `g8-intent-sup-${i}`;
    const started = await intentHandle({
      operation: 'start',
      operationId,
      goal: 'home',
      target: TARGET,
      store: intentStore(),
      adapter,
    });
    assert.equal(started.status, 'waiting_for_decision');
    const decided = await intentHandle({
      operation: 'decide',
      operationId,
      decision: {
        decisionId: `g8-sup-${i}`,
        agentDecision: 'complete',
        basedOnRevision: started.revision,
      },
    });
    assert.equal(decided.status, 'completed');
    supervised += 1;
  }
  for (let i = 0; i < ROUNDS; i += 1) {
    const result = await intentHandle({
      operation: 'start',
      operationId: `g8-intent-auto-${i}`,
      mode: 'autonomous',
      goal: 'home',
      target: TARGET,
      store: intentStore(),
      adapter,
      agent: createAutonomousAgentAdapter({
        decide({ revision }) {
          return { decisionId: `g8-auto-${i}`, agentDecision: 'complete', basedOnRevision: revision };
        },
      }),
      budget: createIntentBudget({ maxSteps: 4, maxAgentCalls: 4 }),
    });
    assert.equal(result.status, 'completed');
    autonomous += 1;
  }
  for (let i = 0; i < ROUNDS; i += 1) {
    const operationId = `g8-intent-cancel-${i}`;
    await intentHandle({
      operation: 'start',
      operationId,
      goal: 'home',
      target: TARGET,
      store: intentStore(),
      adapter,
    });
    const result = intentHandle({ operation: 'cancel', operationId });
    assert.equal(result.status, 'cancelled');
    cancelled += 1;
  }
  for (let i = 0; i < ROUNDS; i += 1) {
    const result = await intentHandle({
      operation: 'start',
      operationId: `g8-intent-timeout-${i}`,
      timeoutMs: 0,
      goal: 'home',
      target: TARGET,
      store: intentStore(),
      adapter,
    });
    assert.equal(result.status, 'timeout');
    assert.equal(result.error, 'timeout');
    timedOut += 1;
  }
  assert.equal(supervised, ROUNDS);
  assert.equal(autonomous, ROUNDS);
  assert.equal(cancelled, ROUNDS);
  assert.equal(timedOut, ROUNDS);
  assert.equal(adapter.maxActive, 1);
});

test('G8 EvidenceStore fault, provider timeout, stale/duplicate decision, and MCP restart', async () => {
  resetScriptOperations();
  resetIntentOperations();
  const blocked = await scriptHandle({
    operation: 'start',
    operationId: 'g8-store-fault',
    script: eightStepScript(),
    store: createScriptEvidenceStore({
      adapter: createMemoryEvidenceAdapter({ fault: 'enospc' }),
    }),
    adapter: createFakeScriptDeviceAdapter({ trees: { native: TREE } }),
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'ENOSPC');

  const provider = await scriptHandle({
    operation: 'start',
    operationId: 'g8-provider-timeout',
    script: eightStepScript(),
    store: scriptStore(),
    adapter: {
      maxActive: 1,
      calls: [],
      async observe() {
        return { ok: false, error: 'provider_timeout' };
      },
      async action() {
        return { ok: false, error: 'should_not_dispatch' };
      },
    },
  });
  assert.equal(provider.error, 'provider_timeout');
  assert.equal(provider.status, 'paused_failure');

  const intentAdapter = createFakeIntentDeviceAdapter({ trees: { native: TREE } });
  const started = await intentHandle({
    operation: 'start',
    operationId: 'g8-stale',
    goal: 'home',
    target: TARGET,
    store: intentStore(),
    adapter: intentAdapter,
  });
  const stale = await intentHandle({
    operation: 'decide',
    operationId: 'g8-stale',
    decision: {
      decisionId: 'stale-1',
      agentDecision: 'act',
      basedOnRevision: started.revision + 9,
      action: { action: 'tap', text: 'Home' },
    },
  });
  assert.equal(stale.error, 'reobserve_required');
  const first = await intentHandle({
    operation: 'decide',
    operationId: 'g8-stale',
    decision: {
      decisionId: 'dup-1',
      agentDecision: 'act',
      basedOnRevision: started.revision,
      action: { action: 'tap', text: 'Home' },
    },
  });
  assert.equal(first.ok, true);
  const dup = await intentHandle({
    operation: 'decide',
    operationId: 'g8-stale',
    decision: {
      decisionId: 'dup-1',
      agentDecision: 'act',
      basedOnRevision: first.revision,
      action: { action: 'tap', text: 'Home' },
    },
  });
  assert.equal(dup.error, 'duplicate_decision');
  assert.equal(intentAdapter.calls.filter((item) => item.name === 'action').length, 1);
  assert.equal(dup.latestEvidenceIds.observation, first.latestEvidenceIds.observation);
  assert.equal(typeof dup.timings.summaryMs, 'number');
  assert.equal(dup.timings.totalMs >= first.timings.totalMs, true);

  await scriptHandle({
    operation: 'start',
    operationId: 'g8-before-restart',
    script: eightStepScript(),
    store: scriptStore(),
    adapter: createFakeScriptDeviceAdapter({ trees: { native: TREE } }),
  });
  resetScriptOperations();
  resetIntentOperations();
  const missing = scriptHandle({ operation: 'status', operationId: 'g8-before-restart' });
  assert.equal(missing.error, 'unknown_operation');
  const recovered = await scriptHandle({
    operation: 'start',
    operationId: 'g8-after-restart',
    script: eightStepScript(),
    store: scriptStore(),
    adapter: createFakeScriptDeviceAdapter({ trees: { native: TREE } }),
  });
  assert.equal(recovered.status, 'completed');
});

test('G8 Script continuous vs stepwise trips and leftover IO', async () => {
  resetScriptOperations();
  const beforeIo = activeIoCount();
  const continuous = [];
  const stepwise = [];
  const adapter = createFakeScriptDeviceAdapter({
    trees: { native: TREE },
    lease: createTargetLease(),
    delayMs: 2,
  });
  function elapsedMs(started) {
    return Number(process.hrtime.bigint() - started) / 1e6;
  }
  for (let i = 0; i < 12; i += 1) {
    const startedAt = process.hrtime.bigint();
    const result = await scriptHandle({
      operation: 'start',
      operationId: `g8-speed-cont-${i}`,
      script: eightStepScript(),
      store: scriptStore(),
      adapter,
    });
    const totalMs = elapsedMs(startedAt);
    assert.equal(result.status, 'completed');
    assert.equal(result.evidenceId != null, true);
    if (i >= 2) continuous.push({ trips: 1, totalMs, ok: result.ok });
  }
  const oneAgentTrip = {
    name: 'g8-stepwise-trip',
    target: TARGET,
    steps: [
      { id: 'o1', type: 'observe', provider: 'native' },
      { id: 'a1', type: 'action', action: 'tap', text: 'About' },
    ],
  };
  for (let i = 0; i < 12; i += 1) {
    const startedAt = process.hrtime.bigint();
    let trips = 0;
    for (let trip = 0; trip < 8; trip += 1) {
      trips += 1;
      const result = await scriptHandle({
        operation: 'start',
        operationId: `g8-speed-step-${i}-${trip}`,
        script: oneAgentTrip,
        store: scriptStore(),
        adapter,
      });
      assert.equal(result.status, 'completed');
    }
    const totalMs = elapsedMs(startedAt);
    if (i >= 2) stepwise.push({ trips, totalMs });
  }
  const contP50 = percentile(continuous.map((item) => item.totalMs), 50);
  const stepP50 = percentile(stepwise.map((item) => item.totalMs), 50);
  const contP95 = percentile(continuous.map((item) => item.totalMs), 95);
  const stepP95 = percentile(stepwise.map((item) => item.totalMs), 95);
  const tripDrop = 1 - (continuous[0].trips / stepwise[0].trips);
  const afterIo = activeIoCount();
  assert.equal(continuous.every((item) => item.ok === true), true);
  assert.ok(tripDrop >= 0.8, `trip drop ${tripDrop}`);
  assert.ok(contP50 <= stepP50 * 0.7, `p50 ${contP50} vs ${stepP50}`);
  assert.ok(contP95 <= stepP95 * 0.8, `p95 ${contP95} vs ${stepP95}`);
  assert.ok(afterIo - beforeIo <= 8, `io growth ${afterIo - beforeIo}`);
  assert.equal(adapter.maxActive, 1);
  const speedArtifact = path.join(
    __dirname,
    '../../../build/ai_app_bridge_artifacts/script-intent-rebuild/g8-speed.json',
  );
  fs.mkdirSync(path.dirname(speedArtifact), { recursive: true });
  fs.writeFileSync(
    speedArtifact,
    JSON.stringify({
      continuousTrips: continuous[0].trips,
      stepwiseTrips: stepwise[0].trips,
      tripDrop,
      contP50,
      stepP50,
      contP95,
      stepP95,
      evidenceComplete: 1,
    }, null, 2),
  );
});

test('G8 Script/Intent faults leave Legacy usable; Batch still rejects isolated commands', async () => {
  resetScriptOperations();
  const crashed = await scriptHandle({
    operation: 'start',
    operationId: 'g8-legacy-script',
    script: eightStepScript(),
    store: createScriptEvidenceStore({
      adapter: createMemoryEvidenceAdapter({ fault: 'throw' }),
    }),
    adapter: createFakeScriptDeviceAdapter({ trees: { native: TREE } }),
  });
  assert.equal(crashed.ok, false);
  const intentBlocked = await intentHandle({
    operation: 'start',
    operationId: 'g8-legacy-intent',
    goal: 'home',
    target: TARGET,
    store: createIntentEvidenceStore({
      adapter: createMemoryEvidenceAdapter({ fault: 'enospc' }),
    }),
    adapter: createFakeIntentDeviceAdapter({ trees: { native: TREE } }),
  });
  assert.equal(intentBlocked.status, 'blocked_evidence_store');
  const status = await runBridgeChecked('status', { serial: 'android-1' }, {
    rawRunner: async () => {
      throw new Error('status must not reach the runner without packageName or port');
    },
  });
  assert.match(status.content[0].text, /packageName or explicit port is required/);
  const batch = JSON.parse((await runBatch({ steps: [{ id: 's1', command: 'script' }] })).content[0].text);
  assert.equal(batch.error, 'unknown_batch_step_command');
});

test('G8 isolated hang returns isolated_timeout and leaves Legacy usable', async () => {
  const router = createCommandRouter({
    loadScript: () => ({
      handle() {
        return new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, command: 'script' }), 400);
        });
      },
    }),
    loadIntent: () => ({
      handle() {
        return new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, command: 'intent' }), 400);
        });
      },
    }),
    legacyDispatch: async (command) => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, command }) }],
    }),
  });
  const hung = JSON.parse((await router.route('script', { isolatedTimeoutMs: 20 })).content[0].text);
  assert.equal(hung.ok, false);
  assert.equal(hung.error, 'isolated_timeout');
  const legacy = JSON.parse((await router.route('status', { packageName: 'com.example.app' })).content[0].text);
  assert.equal(legacy.ok, true);
  assert.equal(legacy.command, 'status');
});
