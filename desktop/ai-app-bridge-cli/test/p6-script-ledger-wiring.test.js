'use strict';

const { createFakeHostPort } = require('../bin/script/fake-host-port');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestScriptSupervisor: createScriptSupervisor } = require('./helpers/script-supervisor');

function spec() {
  return {
    schemaVersion: 'aab.code-script/v1',
    name: 'p6',
    language: "javascript",
    source: 'async function main() { return { passed: true }; }\nmodule.exports = { main };',
    target: { platform: 'android', serial: 's', packageName: 'com.example.app' },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('P6 Script supervisor writes Host facts into ExecutionLedger without mobile bodies', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    handlers: {
      events: async (request) => captureFixture(request, 'events', [{ name: 'tapped' }]),
    },
    program: async (ctx) => {
      const before = await ctx.call('events', {});
      const tap = await ctx.call('tap', { text: 'Go' });
      const events = await ctx.call('events', { factCursor: before.evidence.capture.watermarkCursor }, { actionId: tap.execution.actionId });
      await ctx.assert({
        name: 'tapped',
        predicateSummary: 'tap reached Go',
        requireCoverage: 'complete',
        requiredEvidence: ['events'],
        condition: true,
        evidence: events.evidence,
      });
      return { passed: true };
    },
  });
  await supervisor.registry.get(started.operationId).running;
  const status = await supervisor.handle({
    operation: 'status',
    operationId: started.operationId,
    afterSequence: 0,
  });
  const kinds = status.history.items.map((item) => item.kind);
  assert.equal(kinds.includes('script_started'), true);
  assert.equal(kinds.includes('call_started'), true);
  assert.equal(kinds.includes('call_completed'), true);
  assert.equal(kinds.includes('action_receipt'), true);
  assert.equal(kinds.includes('heartbeat'), false);
  assert.equal(status.history.items.every((item) => item.schemaVersion === 'aab.execution-fact/v1'), true);
  assert.equal(status.history.items.every((item) => Object.hasOwn(item, 'logs') === false), true);
  const receipt = status.history.items.find((item) => item.kind === 'action_receipt');
  assert.equal(receipt.payloadSummary.mechanicalStatus, 'ok');
  const callStarted = status.history.items.find((item) => item.kind === 'call_started' && item.payloadSummary.command === 'tap');
  assert.equal(callStarted.payloadSummary.command, 'tap');
  assert.equal(callStarted.payloadSummary.args.text, 'Go');
  const callCompleted = status.history.items.find((item) => item.kind === 'call_completed' && item.payloadSummary.command === 'tap');
  assert.equal(callCompleted.payloadSummary.command, 'tap');
  assert.equal(callCompleted.payloadSummary.args.text, 'Go');
  assert.equal(receipt.payloadSummary.args.text, 'Go');
  const assertion = status.history.items.find((item) => item.kind === 'assertion_passed');
  assert.equal(assertion.payloadSummary.name, 'tapped');
  assert.equal(assertion.payloadSummary.verdict, 'passed');
  assert.equal(assertion.payloadSummary.predicateSummary, 'tap reached Go');
  assert.equal(assertion.payloadSummary.condition, true);
  assert.equal(assertion.payloadSummary.requiredEvidence[0], 'events');
  assert.equal(assertion.payloadSummary.requireCoverage, 'complete');
  assert.equal(assertion.payloadSummary.coverage.status, 'complete');
  assert.equal(assertion.payloadSummary.refs[0].stream, 'events');
});

test('P6 Script history pages by event afterSequence across heartbeat gaps', async () => {
  let nowMs = 1_000;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort, now: () => nowMs });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    program: async (ctx) => {
      await gate;
      await ctx.call('tap', { text: 'Go' });
      return { passed: true };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  nowMs = 3_000;
  const idle = await supervisor.handle({
    operation: 'status',
    operationId: started.operationId,
    afterSequence: 0,
  });
  const heartbeat = idle.events.find((event) => event.type === 'heartbeat');
  assert.equal(Boolean(heartbeat), true);
  assert.equal(idle.history.items.some((item) => item.kind === 'heartbeat'), false);
  assert.equal(idle.history.items.some((item) => item.kind === 'script_started'), true);

  release();
  await delay(20);
  nowMs = 3_100;
  const after = await supervisor.handle({
    operation: 'status',
    operationId: started.operationId,
    afterSequence: heartbeat.sequence,
  });
  assert.equal(after.history.items.some((item) => item.kind === 'call_started'), true);
  assert.equal(after.history.items.every((item) => item.sequence > heartbeat.sequence), true);
});

test('P6 Script status reads ExecutionLedger after the live registry evicts a terminal operation', async () => {
  const { createBoundedScriptRegistry } = require('../bin/script/bounded-script-registry');
  const supervisor = createScriptSupervisor({
    createHost: createFakeHostPort,
    registry: createBoundedScriptRegistry({ maxOperations: 1 }),
  });
  const first = await supervisor.handle({
    operation: 'start',
    operationId: 'p6-script-evicted',
    script: spec(),
    program: async (ctx) => {
      await ctx.call('tap', { text: 'Go' });
      return { passed: true };
    },
  });
  await delay(20);
  await supervisor.handle({
    operation: 'start',
    operationId: 'p6-script-live',
    script: spec(),
    program: async () => new Promise(() => {}),
  });
  const evicted = await supervisor.handle({
    operation: 'status',
    operationId: first.operationId,
    afterSequence: 0,
  });
  assert.equal(evicted.ok, true);
  assert.equal(evicted.status, 'completed');
  assert.equal(evicted.history.items.some((item) => item.kind === 'call_started'), true);
  assert.equal(evicted.history.items.some((item) => item.kind === 'script_completed'), true);
  const missing = await supervisor.handle({
    operation: 'status',
    operationId: 'never-started',
  });
  assert.equal(missing.error, 'unknown_operation');
});

test('P6 script-entry routes evicted code-script status and wait to the ledger', async () => {
  const { handle } = require('../bin/script/script-entry');
  const { createBoundedScriptRegistry } = require('../bin/script/bounded-script-registry');
  const supervisor = createScriptSupervisor({
    createHost: createFakeHostPort,
    registry: createBoundedScriptRegistry({ maxOperations: 1 }),
  });
  const first = await handle({
    supervisor,
    operation: 'start',
    operationId: 'p6-entry-evicted',
    script: spec(),
    program: async (ctx) => {
      await ctx.call('tap', { text: 'Go' });
      return { passed: true };
    },
  });
  await delay(20);
  await handle({
    supervisor,
    operation: 'start',
    operationId: 'p6-entry-live',
    script: spec(),
    program: async () => new Promise(() => {}),
  });
  const status = await handle({
    supervisor,
    operation: 'status',
    operationId: first.operationId,
    afterSequence: 0,
  });
  assert.equal(status.ok, true);
  assert.equal(status.status, 'completed');
  assert.equal(status.history.items.some((item) => item.kind === 'action_receipt'), true);
  const waited = await handle({
    supervisor,
    operation: 'wait',
    operationId: first.operationId,
    waitMs: 0,
    afterSequence: 0,
  });
  assert.equal(waited.ok, true);
  assert.equal(waited.status, 'completed');
});

test('P6 Script status rejects a non-positive history limit', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    program: async () => ({ passed: true }),
  });
  await delay(20);
  const zero = await supervisor.handle({
    operation: 'status',
    operationId: started.operationId,
    afterSequence: 0,
    limit: 0,
  });
  assert.equal(zero.error, 'unsupported_argument');
  assert.equal(zero.field, 'limit');
});

test('P6 Script completed fact does not store returned capture items', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    handlers: {
      logs: () => ({ result: { items: [{ message: 'MOBILE_BODY' }] } }),
    },
    program: async (ctx) => (await ctx.call('logs', {})).result,
  });
  await delay(20);
  const status = await supervisor.handle({
    operation: 'status',
    operationId: started.operationId,
    afterSequence: 0,
  });
  const completed = status.history.items.find((item) => item.kind === 'script_completed');
  assert.equal(status.status, 'completed');
  assert.equal(completed != null, true);
  assert.equal(JSON.stringify(completed).includes('MOBILE_BODY'), false);
  assert.equal(Object.hasOwn(completed.payloadSummary, 'result'), false);
});

function captureFixture(request, stream, items) {
  const runtimeEpoch = 'test-epoch';
  const targetKey = request.packageName || 'test-target';
  return {
    ok: true, items,
    coverage: { status: 'complete', gap: false, committed: true },
    refs: [{ stream, mobileFactId: 'test-fact', runtimeEpoch, targetKey }],
    runtimeEpoch, targetKey, watermarkCursor: 'test-watermark', hasMore: false,
    window: {
      afterActionId: request.afterActionId ?? null, factCursor: request.factCursor ?? null,
      sinceId: request.sinceId ?? null, sinceMs: request.sinceMs ?? null,
      runtimeEpoch, targetKey, filterApplied: true,
    },
  };
}
