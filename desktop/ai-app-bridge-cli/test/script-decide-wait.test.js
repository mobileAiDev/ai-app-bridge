'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-decide-wait-'));
process.env.AI_APP_BRIDGE_FACT_STORE_DIR = path.join(directory, 'facts');
process.env.AI_APP_BRIDGE_FACT_CACHE_PROFILE = '64mb';
const host = require('../bin/execution-host');
test.after(async () => {
  await host.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
const run = async arguments_ => (await host.run({ command: 'script', extract: null, arguments: arguments_ })).value;
const start = source => run({ operation: 'start', waitMs: 5000, script: {
  schemaVersion: 'aab.code-script/v1', language: 'javascript', source, permissions: [],
  policy: { timeoutMs: 10000 },
} });
const answer = (reply, decision, waitMs = 5000) => ({ operation: 'decide', operationId: reply.control.operationId,
  requestId: reply.control.pendingQuestion.requestId, revision: reply.control.pendingQuestion.revision, decision, waitMs });

test('public decide waits for the next question and final result, without resubmitting the answer', async () => {
  const first = await start(`module.exports.main = async ctx => {
    const first = await ctx.askAgent({ question: 'First answer' });
    const second = await ctx.askAgent({ question: 'Second answer', first });
    return { first, second };
  };`);
  assert.equal(first.control.status, 'waiting_for_agent');
  const firstDecision = answer(first, false);
  const next = await run(firstDecision);
  assert.equal(next.execution.ok, true);
  assert.equal(next.control.status, 'waiting_for_agent');
  assert.equal(next.control.pendingQuestion.request.first, false);
  assert.notEqual(next.control.pendingQuestion.requestId, first.control.pendingQuestion.requestId);
  const duplicate = await run(firstDecision);
  assert.deepEqual(duplicate.control.pendingQuestion, next.control.pendingQuestion, 'an identical decision does not answer the next question');
  const lastDecision = answer(next, 0);
  const completed = await run(lastDecision);
  assert.equal(completed.control.status, 'completed');
  assert.equal(completed.control.persisted, true);
  assert.deepEqual(completed.value.result, { first: false, second: 0 });
  assert.deepEqual((await run(lastDecision)).value.result, completed.value.result, 'lost-response retry reads the same completed result');
  const conflict = await run({ ...lastDecision, decision: 1 });
  assert.equal(conflict.execution.ok, false);
  assert.equal(conflict.execution.error, 'invalid_argument');
});

test('invalid wait/revision does not consume a question; wait timeout leaves one answered execution running', async () => {
  const first = await start(`module.exports.main = async ctx => {
    const answer = await ctx.askAgent({ question: 'Continue once' });
    await new Promise(resolve => setTimeout(resolve, 400));
    return { answer };
  };`);
  const decision = answer(first, { accepted: true });
  for (const waitMs of [-1, 60001, '50']) {
    const invalid = await run({ ...decision, waitMs });
    assert.equal(invalid.execution.ok, false);
    assert.equal(invalid.failureStage, 'validation');
  }
  const stale = await run({ ...decision, revision: decision.revision + 1 });
  assert.equal(stale.execution.error, 'stale_decide');
  const timedOut = await run({ ...decision, waitMs: 1 });
  assert.equal(timedOut.control.status, 'running');
  assert.equal(timedOut.control.timedOut, true);
  assert.equal(Object.hasOwn(timedOut.control, 'pendingQuestion'), false);
  const completed = await run({ operation: 'wait', operationId: first.control.operationId,
    afterSequence: timedOut.control.eventSequence, waitMs: 5000 });
  assert.equal(completed.control.status, 'completed');
  assert.deepEqual(completed.value.result, { answer: { accepted: true } });
});

test('decide without waiting remains asynchronous and a waiting decide returns execution failure', async () => {
  const first = await start(`module.exports.main = async ctx => {
    await ctx.askAgent({ question: 'First' });
    await ctx.askAgent({ question: 'Fail next' });
    throw new Error('intentional_fixture_failure');
  };`);
  const decision = answer(first, true);
  delete decision.waitMs;
  const accepted = await run(decision);
  assert.equal(accepted.control.status, 'running');
  const next = await run({ operation: 'wait', operationId: first.control.operationId,
    afterSequence: accepted.control.eventSequence, waitMs: 5000 });
  assert.equal(next.control.status, 'waiting_for_agent');
  const failed = await run(answer(next, true));
  assert.equal(failed.control.status, 'failed');
  assert.equal(failed.value.error, 'intentional_fixture_failure');
});
