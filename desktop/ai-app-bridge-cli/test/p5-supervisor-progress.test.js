'use strict';

const { createFakeHostPort } = require('../bin/script/fake-host-port');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestScriptSupervisor: createScriptSupervisor } = require('./helpers/script-supervisor');
const { main: checkpointReentry } = require('../bin/script/templates/checkpoint-reentry');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');

function spec(overrides = {}) {
  return {
    schemaVersion: 'aab.code-script/v1',
    name: 'p5',
    language: "javascript",
    source: 'async function main() { return { passed: true }; }\nmodule.exports = { main };',
    target: { platform: 'android', serial: 's', packageName: 'com.example.app' },
    ...(overrides.policy === undefined ? {} : { policy: overrides.policy }),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('P5 supervisor records call-level progress without a script progress event', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    program: async (ctx) => {
      await ctx.call('status', {});
      return { passed: true };
    },
  });
  await supervisor.registry.get(started.operationId).running;
  const status = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  assert.equal(status.rollingSummary.completedCalls, 1);
  assert.equal(status.rollingSummary.stage, null);
  assert.equal(status.events.some((event) => event.type === 'call_started'), true);
  assert.equal(status.events.some((event) => event.type === 'call_completed'), true);
});

test('P5 in-flight mutation pause waits for a receipt before paused_live', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    handlers: {
      tap: async () => {
        await gate;
        return { ok: true };
      },
    },
    program: async (ctx) => {
      await ctx.call('tap', { text: 'Go' });
      await new Promise(() => {}); // Keep the fake child live while the pause state is inspected.
    },
  });
  await delay(10);
  const requested = await supervisor.handle({ operation: 'pause', operationId: started.operationId });
  assert.equal(requested.status, 'pause_requested');
  release();
  await delay(20);
  const paused = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  assert.equal(paused.status, 'paused_live');
  assert.equal(paused.events.some((event) => event.type === 'action_receipt'), true);
});

test('P5 thrown host.call emits call_failed', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    handlers: {
      tap: async () => {
        throw new Error('tap-broke');
      },
    },
    program: async (ctx) => {
      try {
        await ctx.call('tap', { text: 'Go' });
      } catch (_error) {
        return { passed: false };
      }
      return { passed: true };
    },
  });
  await delay(20);
  const status = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  assert.equal(status.events.some((event) => event.type === 'call_failed'), true);
  assert.equal(status.rollingSummary.completedCalls, 1);
});

test('P5 heartbeat is generated within two seconds without a status poll', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    program: async () => {
      await gate;
      return { passed: true };
    },
  });
  const waited = await supervisor.handle({
    operation: 'wait',
    operationId: started.operationId,
    afterSequence: started.eventSequence,
    waitMs: 2500,
  });
  const heartbeat = waited.events.find((event) => event.type === 'heartbeat');
  assert.equal(heartbeat != null, true);
  assert.equal(heartbeat.atMs - started.events[0].atMs <= 2100, true);
  release();
  await delay(20);
});

test('P5 concurrent thrown and successful mutations stay paused_ambiguous', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  let releaseThrow;
  let releaseOk;
  const thrownGate = new Promise((resolve) => { releaseThrow = resolve; });
  const okGate = new Promise((resolve) => { releaseOk = resolve; });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    handlers: {
      tap: async () => {
        await thrownGate;
        throw new Error('lost');
      },
      'tap-text': async () => {
        await okGate;
        return { ok: true };
      },
    },
    program: async (ctx) => {
      const first = ctx.call('tap', { text: 'A' });
      const second = ctx.call('tap-text', { text: 'B' });
      await Promise.allSettled([first, second]);
      await new Promise(() => {}); // Keep the fake child live while the pause state is inspected.
    },
  });
  await delay(10);
  const requested = await supervisor.handle({ operation: 'pause', operationId: started.operationId });
  assert.equal(requested.status, 'pause_requested');
  releaseThrow();
  releaseOk();
  await delay(20);
  const paused = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  assert.equal(paused.status, 'paused_ambiguous');
});

test('P5 stale decide is rejected and duplicate decide is idempotent', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    program: async (ctx) => {
      await ctx.askAgent({ question: 'continue?' });
      return { passed: true };
    },
  });
  await delay(10);
  const stale = await supervisor.handle({
    operation: 'decide',
    operationId: started.operationId,
    requestId: 'ask-1',
    revision: 9,
    decision: 'yes',
  });
  assert.equal(stale.error, 'stale_decide');
  const first = await supervisor.handle({
    operation: 'decide',
    operationId: started.operationId,
    requestId: 'ask-1',
    revision: 1,
    decision: 'yes',
  });
  assert.equal(first.ok, true);
  const again = await supervisor.handle({
    operation: 'decide',
    operationId: started.operationId,
    requestId: 'ask-1',
    revision: 1,
    decision: 'yes',
  });
  assert.equal(again.ok, true);
  const omitted = await supervisor.handle({
    operation: 'decide',
    operationId: started.operationId,
    requestId: 'ask-1',
    decision: 'yes',
  });
  assert.equal(omitted.error, 'stale_decide');
  const conflict = await supervisor.handle({
    operation: 'decide',
    operationId: started.operationId,
    requestId: 'ask-1',
    revision: 1,
    decision: 'no',
  });
  assert.equal(conflict.error, 'invalid_argument');
  const before = (await supervisor.handle({ operation: 'status', operationId: started.operationId }))
    .events.filter((event) => event.type === 'agent_decision').length;
  const same = await supervisor.handle({
    operation: 'decide',
    operationId: started.operationId,
    requestId: 'ask-1',
    revision: 1,
    decision: 'yes',
  });
  assert.equal(same.ok, true);
  const after = (await supervisor.handle({ operation: 'status', operationId: started.operationId }))
    .events.filter((event) => event.type === 'agent_decision').length;
  assert.equal(after, before);
  const question = (await supervisor.handle({ operation: 'status', operationId: started.operationId }))
    .events.find((event) => event.type === 'agent_question_created');
  assert.equal(question.requestId, 'ask-1');
});

test('P5 thrown null still emits call_failed and ends paused_ambiguous', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    handlers: {
      tap: async () => {
        await gate;
        throw null;
      },
    },
    program: async (ctx) => {
      try {
        await ctx.call('tap', { text: 'Go' });
      } catch (_error) {
        return { passed: false };
      }
      await new Promise(() => {}); // Keep the fake child live while the pause state is inspected.
    },
  });
  await delay(10);
  const requested = await supervisor.handle({ operation: 'pause', operationId: started.operationId });
  assert.equal(requested.status, 'pause_requested');
  release();
  await delay(20);
  const paused = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  assert.equal(paused.status, 'paused_ambiguous');
  assert.equal(paused.events.some((event) => event.type === 'call_failed'), true);
});

test('P5 decide rejects a previous requestId at the current revision', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    program: async (ctx) => {
      await ctx.askAgent({ question: 'q1' });
      await ctx.askAgent({ question: 'q2' });
      return { passed: true };
    },
  });
  await delay(10);
  const first = await supervisor.handle({
    operation: 'decide',
    operationId: started.operationId,
    requestId: 'ask-1',
    revision: 1,
    decision: 'yes',
  });
  assert.equal(first.ok, true);
  await delay(10);
  const stolen = await supervisor.handle({
    operation: 'decide',
    operationId: started.operationId,
    requestId: 'ask-1',
    revision: 2,
    decision: 'yes',
  });
  assert.equal(stolen.error, 'stale_decide');
  const second = await supervisor.handle({
    operation: 'decide',
    operationId: started.operationId,
    requestId: 'ask-2',
    revision: 2,
    decision: 'yes',
  });
  assert.equal(second.ok, true);
});

test('P5 concurrent askAgent keeps each requestId decidable at its own revision', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    program: async (ctx) => {
      const first = ctx.askAgent({ question: 'q1' });
      const second = ctx.askAgent({ question: 'q2' });
      await Promise.all([first, second]);
      return { passed: true };
    },
  });
  await delay(10);
  const first = await supervisor.handle({
    operation: 'decide',
    operationId: started.operationId,
    requestId: 'ask-1',
    revision: 1,
    decision: 'yes',
  });
  assert.equal(first.ok, true);
  const second = await supervisor.handle({
    operation: 'decide',
    operationId: started.operationId,
    requestId: 'ask-2',
    revision: 2,
    decision: 'no',
  });
  assert.equal(second.ok, true);
});

test('P5 pause_requested and paused_ambiguous reject new host.call', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let allowSecond = null;
  const secondGate = new Promise((resolve) => { allowSecond = resolve; });
  let secondResult = null;
  let secondHandlerCalls = 0;
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    handlers: {
      tap: async () => {
        await firstGate;
        return { ok: true };
      },
      'tap-text': async () => {
        secondHandlerCalls += 1;
        return { ok: true };
      },
    },
    program: async (ctx) => {
      const first = ctx.call('tap', { text: 'A' });
      await secondGate;
      secondResult = await ctx.call('tap-text', { text: 'B' });
      await first;
      await new Promise(() => {}); // Keep the fake child live while the pause state is inspected.
    },
  });
  await delay(10);
  const requested = await supervisor.handle({ operation: 'pause', operationId: started.operationId });
  assert.equal(requested.status, 'pause_requested');
  allowSecond();
  await delay(20);
  assert.equal(secondResult.error, 'paused');
  assert.equal(secondHandlerCalls, 0);
  releaseFirst();
  await delay(20);
  const paused = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  assert.equal(paused.status, 'paused_live');
});

test('P5 paused_ambiguous rejects new host.call', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  let releaseThrow;
  let releaseOk;
  const thrownGate = new Promise((resolve) => { releaseThrow = resolve; });
  const okGate = new Promise((resolve) => { releaseOk = resolve; });
  let thirdResult = null;
  let thirdHandlerCalls = 0;
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    handlers: {
      tap: async () => {
        await thrownGate;
        throw new Error('lost');
      },
      'tap-text': async () => {
        await okGate;
        return { ok: true };
      },
      network: async () => {
        thirdHandlerCalls += 1;
        return { ok: true };
      },
    },
    program: async (ctx) => {
      const first = ctx.call('tap', { text: 'A' });
      const second = ctx.call('tap-text', { text: 'B' });
      await Promise.allSettled([first, second]);
      thirdResult = await ctx.call('network', {});
      await new Promise(() => {}); // Keep the fake child live while the pause state is inspected.
    },
  });
  await delay(10);
  const requested = await supervisor.handle({ operation: 'pause', operationId: started.operationId });
  assert.equal(requested.status, 'pause_requested');
  releaseThrow();
  releaseOk();
  await delay(20);
  const paused = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  assert.equal(paused.status, 'paused_ambiguous');
  assert.equal(thirdResult.error, 'paused');
  assert.equal(thirdHandlerCalls, 0);
});

test('P5 restartPolicy none cannot resume after child crash', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    runtime: {
      start: async () => {
        throw new Error('boom');
      },
      stop() {},
    },
  });
  await delay(10);
  const status = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  assert.equal(status.status, 'failed');
  const resumed = await supervisor.handle({ operation: 'resume', operationId: started.operationId });
  assert.equal(resumed.error, 'not_resumable');
});

test('P5 supervisor merges business progress and does not pause on checkpoint', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    program: async (ctx) => {
      await ctx.progress({ stage: 'search', message: 'waiting for results' });
      await ctx.checkpoint('search-complete', { step: 1 });
      return { passed: true };
    },
  });
  await delay(20);
  const status = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  assert.equal(status.rollingSummary.stage, 'search');
  assert.equal(status.rollingSummary.message, 'waiting for results');
  assert.equal(status.rollingSummary.lastCheckpoint, 'search-complete');
  assert.notEqual(status.status, 'paused_manual');
});

test('P5 official checkpoint template resumes from committed state', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const started = await supervisor.handle({
    operation: 'start',
    store,
    script: spec({ policy: { restartPolicy: 'checkpoint' } }),
    program: async (ctx) => {
      const result = await checkpointReentry(ctx);
      if (!result.resumed) throw new Error('child_crashed');
      return result;
    },
  });
  await delay(20);
  const first = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  assert.equal(first.status, 'failed');
  assert.equal(first.rollingSummary.lastCheckpoint, 'after-status');
  const resumed = await supervisor.handle({ operation: 'resume', operationId: started.operationId });
  assert.equal(resumed.ok, true);
  await delay(20);
  const second = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  assert.equal(second.status, 'completed');
  const completed = second.events.filter((event) => event.type === 'script_completed');
  assert.equal(completed.length, 1);
  await supervisor.registry.get(started.operationId).running;
  const output = await supervisor.handle({ operation: 'result', operationId: started.operationId, store });
  assert.equal(output.ok, true, JSON.stringify(output));
  assert.equal(output.result.resumed, true);
  assert.equal(output.result.step, 1);
});

test('P5 official JS template restarts as a Node child from checkpoint', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const source = fs.readFileSync(path.join(__dirname, '../bin/script/templates/checkpoint-reentry.js'), 'utf8')
    + '\nmodule.exports.main = async ctx => { const result = await main(ctx); if (!result.resumed) process.exit(31); return result; };';
  const started = await supervisor.handle({
    operation: 'start',
    store,
    script: {
      schemaVersion: 'aab.code-script/v1',
      name: 'p5-node-checkpoint',
      language: 'javascript',
      source,
      target: { platform: 'android', serial: 's', packageName: 'com.example.app' },
      policy: { restartPolicy: 'checkpoint', timeoutMs: 15_000 },
    },
  });
  const firstWait = await waitTerminal(supervisor, started.operationId, started.eventSequence);
  assert.equal(firstWait.status, 'failed');
  const first = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  assert.equal(first.rollingSummary.lastCheckpoint, 'after-status');
  const resumed = await supervisor.handle({ operation: 'resume', operationId: started.operationId });
  assert.equal(resumed.ok, true);
  const secondWait = await waitTerminal(supervisor, started.operationId, resumed.eventSequence);
  assert.equal(secondWait.status, 'completed');
  const second = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  const completed = second.events.filter((event) => event.type === 'script_completed');
  assert.equal(completed.length, 1);
  await supervisor.registry.get(started.operationId).running;
  const output = await supervisor.handle({ operation: 'result', operationId: started.operationId, store });
  assert.equal(output.ok, true, JSON.stringify(output));
  assert.equal(output.result.resumed, true);
  assert.equal(output.result.step, 1);
});

test('P5 live Node pause holds at the next progress boundary', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: {
      schemaVersion: 'aab.code-script/v1',
      name: 'p5-node-live-pause',
      language: 'javascript',
      source: [
        'async function main(ctx) {',
        "  await ctx.progress({ stage: 'before-pause' });",
        '  await new Promise((resolve) => setTimeout(resolve, 250));',
        "  await ctx.progress({ stage: 'after-pause' });",
        '  return { passed: true };',
        '}',
        'module.exports = { main };',
      ].join('\n'),
      target: { platform: 'android', serial: 's', packageName: 'com.example.app' },
      policy: { timeoutMs: 15_000 },
    },
  });
  await waitForEvent(supervisor, started.operationId, (event) => (
    event.type === 'progress' && event.stage === 'before-pause'
  ));
  const requested = await supervisor.handle({ operation: 'pause', operationId: started.operationId });
  assert.equal(requested.status, 'paused_manual');
  await delay(400);
  const paused = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  assert.equal(paused.status, 'paused_manual');
  assert.equal(paused.events.some((event) => event.type === 'progress' && event.stage === 'after-pause'), false);
  const resumed = await supervisor.handle({ operation: 'resume', operationId: started.operationId });
  assert.equal(resumed.status, 'running');
  const done = await waitTerminal(supervisor, started.operationId, resumed.eventSequence);
  assert.equal(done.status, 'completed');
  const finished = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  assert.equal(finished.events.some((event) => event.type === 'progress' && event.stage === 'after-pause'), true);
});

test('P5 live Node pause holds at the next ctx.call boundary', async () => {
  await assertLiveCallPause({
    language: 'javascript',
    name: 'p5-node-live-call-pause',
    source: [
      'async function main(ctx) {',
      "  await ctx.progress({ stage: 'before-pause' });",
      '  await new Promise((resolve) => setTimeout(resolve, 250));',
      "  await ctx.call('status', {});",
      '  return { passed: true };',
      '}',
      'module.exports = { main };',
    ].join('\n'),
  });
});

test('P5 live Python pause holds at the next ctx.call boundary', async () => {
  await assertLiveCallPause({
    language: 'python',
    name: 'p5-python-live-call-pause',
    source: [
      'import time',
      '',
      'def main(ctx):',
      "    ctx.progress({'stage': 'before-pause'})",
      '    time.sleep(0.25)',
      "    ctx.call('status', {})",
      "    return {'passed': True}",
    ].join('\n'),
  });
});

async function assertLiveCallPause({ language, name, source }) {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: {
      schemaVersion: 'aab.code-script/v1',
      name,
      language,
      source,
      target: { platform: 'android', serial: 's', packageName: 'com.example.app' },
      policy: { timeoutMs: 15_000 },
    },
    handlers: {
      status: async () => ({ ok: true }),
    },
  });
  await waitForEvent(supervisor, started.operationId, (event) => (
    event.type === 'progress' && event.stage === 'before-pause'
  ));
  const requested = await supervisor.handle({ operation: 'pause', operationId: started.operationId });
  assert.equal(requested.status, 'paused_manual');
  await delay(400);
  const paused = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  assert.equal(paused.status, 'paused_manual');
  assert.equal(paused.events.some((event) => event.type === 'call_started'), false);
  assert.equal(paused.events.some((event) => event.type === 'script_completed'), false);
  const resumed = await supervisor.handle({ operation: 'resume', operationId: started.operationId });
  assert.equal(resumed.status, 'running');
  const done = await waitTerminal(supervisor, started.operationId, resumed.eventSequence);
  assert.equal(done.status, 'completed');
  const finished = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  assert.equal(finished.events.some((event) => event.type === 'call_started'), true);
  assert.equal(finished.events.some((event) => event.type === 'call_completed'), true);
}

async function waitForEvent(supervisor, operationId, match) {
  let after = 0;
  for (let i = 0; i < 40; i += 1) {
    const status = await supervisor.handle({ operation: 'status', operationId, afterSequence: after });
    if ((status.events || []).some(match)) return status;
    const waited = await supervisor.handle({
      operation: 'wait',
      operationId,
      afterSequence: after,
      waitMs: 100,
    });
    if ((waited.events || []).some(match)) return waited;
    after = waited.eventSequence || status.eventSequence;
  }
  throw new Error('event_not_observed');
}

async function waitTerminal(supervisor, operationId, afterSequence) {
  let after = afterSequence;
  for (let i = 0; i < 20; i += 1) {
    const result = await supervisor.handle({
      operation: 'wait',
      operationId,
      afterSequence: after,
      waitMs: 2000,
    });
    if (result.status === 'completed' || result.status === 'failed' || result.status === 'cancelled') {
      return result;
    }
    after = result.eventSequence;
  }
  return supervisor.handle({ operation: 'status', operationId });
}
