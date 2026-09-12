'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createAutonomousAgentAdapter, createIntentBudget } = require('../bin/intent/intent-autonomous-adapter');
const { createFakeIntentDeviceAdapter } = require('../bin/intent/intent-device-adapter');
const { handle } = require('./helpers/intent-entry');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { handle: scriptHandle } = require('../bin/script/script-entry');
const { runBridgeChecked } = require('../test-support/host-client');

const tree = {
  root: { id: 'home', className: 'Button', text: 'Home', clickable: true, children: [] },
};

function store() {
  return createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
}

function tapDecision(decisionId, revision) {
  return {
    decisionId,
    agentDecision: 'act',
    basedOnRevision: revision,
    action: { action: 'tap', selector: { text: 'Home' } },
  };
}

function threeActThenCompleteAgent() {
  let n = 0;
  return createAutonomousAgentAdapter({
    decide({ revision }) {
      n += 1;
      if (n <= 3) return tapDecision(`auto-${n}`, revision);
      return { decisionId: 'auto-done', agentDecision: 'complete', basedOnRevision: revision };
    },
  });
}

async function waitUntil(predicate) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out waiting for agent decide');
}

test('G6 Intent autonomous files do not import Script or Legacy', () => {
  for (const file of [
    'intent-entry.js',
    'intent-worker.js',
    'intent-runtime.js',
    'intent-autonomous-adapter.js',
    'intent-production-adapter.js',
    'intent-observer.js',
    'intent-action-executor.js',
    'intent-device-adapter.js',
    'intent-errors.js',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '../bin/intent', file), 'utf8');
    assert.equal(/script\/|legacy\/|runBatch|runBridgeChecked|LegacyDispatcher|mcp-server/.test(source), false, file);
  }
});

test('G6 business terminal states come only from the Agent', async () => {
  const adapter = createFakeIntentDeviceAdapter({ trees: { native: tree } });
  const completed = await handle({
    operation: 'start',
    operationId: 'g6-terminal',
    mode: 'autonomous',
    goal: 'finish',
    target: { platform: 'android', serial: 'b46093e6', packageName: 'com.example.app' },
    store: store(),
    adapter,
    agent: createAutonomousAgentAdapter({
      decide({ revision }) {
        return { decisionId: 'term-1', agentDecision: 'complete', basedOnRevision: revision };
      },
    }),
    budget: createIntentBudget({ maxSteps: 8, maxAgentCalls: 8 }),
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.ok, true);
  assert.equal(adapter.calls.filter((item) => item.name === 'action').length, 0);

  const budgeted = await handle({
    operation: 'start',
    operationId: 'g6-no-invent-terminal',
    mode: 'autonomous',
    goal: 'never complete',
    target: { platform: 'android', serial: 'b46093e6', packageName: 'com.example.app' },
    store: store(),
    adapter: createFakeIntentDeviceAdapter({ trees: { native: tree } }),
    agent: createAutonomousAgentAdapter({
      decide({ revision }) {
        return tapDecision(`loop-${revision}`, revision);
      },
    }),
    budget: createIntentBudget({ maxSteps: 1, maxAgentCalls: 8 }),
  });
  assert.equal(budgeted.status, 'intervention_required');
  assert.equal(budgeted.error, 'max_steps');
  assert.notEqual(budgeted.status, 'completed');
  assert.notEqual(budgeted.status, 'failed');
  assert.notEqual(budgeted.status, 'inconclusive');
});

test('G6 risk and budget gates enter intervention_required', async () => {
  const overCalls = await handle({
    operation: 'start',
    operationId: 'g6-budget-calls',
    mode: 'autonomous',
    goal: 'budget',
    target: { platform: 'android', serial: 'b46093e6', packageName: 'com.example.app' },
    store: store(),
    adapter: createFakeIntentDeviceAdapter({ trees: { native: tree } }),
    agent: createAutonomousAgentAdapter({
      decide({ revision }) {
        return tapDecision(`call-${revision}`, revision);
      },
    }),
    budget: createIntentBudget({ maxSteps: 30, maxAgentCalls: 2 }),
  });
  assert.equal(overCalls.status, 'intervention_required');
  assert.equal(overCalls.error, 'max_agent_calls');
  assert.equal(overCalls.agentCalls, 2);

  const blockedAction = await handle({
    operation: 'start',
    operationId: 'g6-allowlist',
    mode: 'autonomous',
    goal: 'swipe blocked',
    target: { platform: 'android', serial: 'b46093e6', packageName: 'com.example.app' },
    store: store(),
    adapter: createFakeIntentDeviceAdapter({ trees: { native: tree } }),
    agent: createAutonomousAgentAdapter({
      decide({ revision }) {
        return {
          decisionId: 'swipe-1',
          agentDecision: 'act',
          basedOnRevision: revision,
          action: { action: 'swipe', selector: { text: 'Home' }, deltaX: 0, deltaY: -50, durationMs: 300 },
        };
      },
    }),
    budget: createIntentBudget({ allowlist: ['tap'] }),
  });
  assert.equal(blockedAction.status, 'intervention_required');
  assert.equal(blockedAction.error, 'action_not_allowed');
});

test('G6 autonomous mode can be paused, cancelled, and intervened by the Agent', async () => {
  let enteredPause = false;
  let releasePause;
  const pauseWait = new Promise((resolve) => { releasePause = resolve; });
  const pauseStarted = handle({
    operation: 'start',
    operationId: 'g6-pause',
    mode: 'autonomous',
    goal: 'pause me',
    target: { platform: 'android', serial: 'b46093e6', packageName: 'com.example.app' },
    store: store(),
    adapter: createFakeIntentDeviceAdapter({ trees: { native: tree } }),
    agent: createAutonomousAgentAdapter({
      async decide() {
        enteredPause = true;
        await pauseWait;
        return tapDecision('after-pause', 1);
      },
    }),
    budget: createIntentBudget({ maxSteps: 8, maxAgentCalls: 8 }),
  });
  await waitUntil(() => enteredPause);
  const paused = handle({ operation: 'pause', operationId: 'g6-pause' });
  assert.equal(paused.status, 'paused');
  releasePause();
  const pauseDone = await pauseStarted;
  assert.equal(pauseDone.status, 'paused');

  let enteredCancel = false;
  let releaseCancel;
  const cancelWait = new Promise((resolve) => { releaseCancel = resolve; });
  const cancelStarted = handle({
    operation: 'start',
    operationId: 'g6-cancel',
    mode: 'autonomous',
    goal: 'cancel me',
    target: { platform: 'android', serial: 'b46093e6', packageName: 'com.example.app' },
    store: store(),
    adapter: createFakeIntentDeviceAdapter({ trees: { native: tree } }),
    agent: createAutonomousAgentAdapter({
      async decide() {
        enteredCancel = true;
        await cancelWait;
        return tapDecision('after-cancel', 1);
      },
    }),
    budget: createIntentBudget({ maxSteps: 8, maxAgentCalls: 8 }),
  });
  await waitUntil(() => enteredCancel);
  const cancelled = await handle({ operation: 'cancel', operationId: 'g6-cancel' });
  assert.equal(cancelled.status, 'cancelled');
  releaseCancel();
  assert.equal((await cancelStarted).status, 'cancelled');

  let enteredIntervene = false;
  let releaseIntervene;
  const interveneWait = new Promise((resolve) => { releaseIntervene = resolve; });
  const interveneStarted = handle({
    operation: 'start',
    operationId: 'g6-intervene',
    mode: 'autonomous',
    goal: 'intervene me',
    target: { platform: 'android', serial: 'b46093e6', packageName: 'com.example.app' },
    store: store(),
    adapter: createFakeIntentDeviceAdapter({ trees: { native: tree } }),
    agent: createAutonomousAgentAdapter({
      async decide() {
        enteredIntervene = true;
        await interveneWait;
        return tapDecision('after-intervene', 1);
      },
    }),
    budget: createIntentBudget({ maxSteps: 8, maxAgentCalls: 8 }),
  });
  await waitUntil(() => enteredIntervene);
  const intervened = await handle({ operation: 'intervene', operationId: 'g6-intervene', reason: 'agent_stop' });
  assert.equal(intervened.status, 'intervention_required');
  assert.equal(intervened.error, 'agent_stop');
  releaseIntervene();
  assert.equal((await interveneStarted).status, 'intervention_required');
});

test('G6 Agent adapter crash does not corrupt Intent, Script, or Legacy', async () => {
  const adapter = createFakeIntentDeviceAdapter({ trees: { native: tree } });
  const crashed = await handle({
    operation: 'start',
    operationId: 'g6-crash',
    mode: 'autonomous',
    goal: 'crash',
    target: { platform: 'android', serial: 'b46093e6', packageName: 'com.example.app' },
    store: store(),
    adapter,
    agent: createAutonomousAgentAdapter({
      decide() {
        throw new Error('agent boom');
      },
    }),
    budget: createIntentBudget({ maxSteps: 8, maxAgentCalls: 8 }),
  });
  assert.equal(crashed.status, 'waiting_for_decision');
  assert.equal(crashed.error, 'agent_adapter_failed');
  assert.equal(adapter.calls.filter((item) => item.name === 'action').length, 0);

  const status = handle({ operation: 'status', operationId: 'g6-crash' });
  assert.equal(status.status, 'waiting_for_decision');
  assert.equal(status.revision, crashed.revision);

  const script = await scriptHandle({
    operation: 'start',
    actions: async () => { throw new Error('unexpected_device_call'); },
    script: {
      schemaVersion: 'aab.code-script/v1',
      name: 'g6-reg',
      language: 'javascript',
      source: 'function main() { return { ok: true }; }\nmodule.exports = { main };',
      target: { platform: 'android', serial: 'android-1', packageName: 'com.example.app' },
    },
  });
  const deadline = Date.now() + 5000;
  let snapshot = script;
  let afterSequence = script.eventSequence || 0;
  while (
    snapshot.status !== 'completed'
    && snapshot.status !== 'failed'
    && snapshot.status !== 'cancelled'
    && Date.now() < deadline
  ) {
    snapshot = await scriptHandle({
      operation: 'wait',
      operationId: script.operationId,
      waitMs: Math.max(1, Math.min(200, deadline - Date.now())),
      afterSequence,
    });
    afterSequence = snapshot.eventSequence || afterSequence;
  }
  assert.equal(snapshot.status, 'completed');
  const legacy = await runBridgeChecked('status', { serial: 'android-1' }, {
    rawRunner: async () => { throw new Error('no runner'); },
  });
  assert.match(legacy.content[0].text, /packageName/);
  const batch = JSON.parse((await runBridgeChecked('batch', {})).content[0].text);
  assert.equal(batch.error, 'unknown_command');
});

test('G6 same flow in supervised and autonomous modes with segmented comparison', async () => {
  const supervisedAdapter = createFakeIntentDeviceAdapter({ trees: { native: tree } });
  const supervisedStartedAt = Date.now();
  let supervised = await handle({
    operation: 'start',
    operationId: 'g6-supervised-flow',
    mode: 'supervised',
    goal: 'three taps',
    target: { platform: 'android', serial: 'b46093e6', packageName: 'com.example.app' },
    store: store(),
    adapter: supervisedAdapter,
  });
  let supervisedRoundTrips = 1;
  for (let i = 1; i <= 3; i += 1) {
    supervised = await handle({
      operation: 'decide',
      operationId: 'g6-supervised-flow',
      decision: tapDecision(`sup-${i}`, supervised.revision),
    });
    supervisedRoundTrips += 1;
    assert.equal(supervised.status, 'waiting_for_decision');
  }
  supervised = await handle({
    operation: 'decide',
    operationId: 'g6-supervised-flow',
    decision: { decisionId: 'sup-done', agentDecision: 'complete', basedOnRevision: supervised.revision },
  });
  supervisedRoundTrips += 1;
  const supervisedMs = Date.now() - supervisedStartedAt;
  assert.equal(supervised.status, 'completed');

  const autonomousAdapter = createFakeIntentDeviceAdapter({ trees: { native: tree } });
  const autonomousStartedAt = Date.now();
  const autonomous = await handle({
    operation: 'start',
    operationId: 'g6-autonomous-flow',
    mode: 'autonomous',
    goal: 'three taps',
    target: { platform: 'android', serial: 'b46093e6', packageName: 'com.example.app' },
    store: store(),
    adapter: autonomousAdapter,
    agent: threeActThenCompleteAgent(),
    budget: createIntentBudget({ maxSteps: 8, maxAgentCalls: 8 }),
  });
  const autonomousMs = Date.now() - autonomousStartedAt;
  const autonomousRoundTrips = 1;
  assert.equal(autonomous.status, 'completed');
  assert.equal(autonomous.actionSteps, 3);
  assert.equal(autonomous.agentCalls, 4);

  const supervisedObserves = supervisedAdapter.calls.filter((item) => item.name === 'observe').length;
  const autonomousObserves = autonomousAdapter.calls.filter((item) => item.name === 'observe').length;
  const supervisedActions = supervisedAdapter.calls.filter((item) => item.name === 'action').length;
  const autonomousActions = autonomousAdapter.calls.filter((item) => item.name === 'action').length;
  assert.equal(supervisedObserves, 4);
  assert.equal(autonomousObserves, 4);
  assert.equal(supervisedActions, 3);
  assert.equal(autonomousActions, 3);
  assert.equal(supervisedRoundTrips, 5);
  assert.equal(autonomousRoundTrips, 1);
  const idleDrop = (supervisedRoundTrips - autonomousRoundTrips) / supervisedRoundTrips;
  assert.ok(idleDrop >= 0.5, `idle round-trip drop ${idleDrop}`);

  const comparison = {
    supervised: {
      handleRoundTrips: supervisedRoundTrips,
      observeCount: supervisedObserves,
      actionCount: supervisedActions,
      totalMs: supervisedMs,
      status: supervised.status,
    },
    autonomous: {
      handleRoundTrips: autonomousRoundTrips,
      observeCount: autonomousObserves,
      actionCount: autonomousActions,
      agentCalls: autonomous.agentCalls,
      totalMs: autonomousMs,
      status: autonomous.status,
    },
    idleRoundTripDrop: idleDrop,
  };
  assert.equal(comparison.supervised.status, comparison.autonomous.status);
  assert.equal(comparison.supervised.observeCount, comparison.autonomous.observeCount);
  assert.equal(comparison.supervised.actionCount, comparison.autonomous.actionCount);
});
