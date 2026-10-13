'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScriptSupervisor } = require('../bin/script/script-supervisor');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { createMemoryEvidenceAdapter, createFileEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { handle } = require('../bin/script/script-entry');

const sources = {
  javascript: `module.exports.main = async ctx => {
    const first = await ctx.askAgent({ question: 'First decision' });
    await ctx.progress({ stage: 'continued' });
    const second = await ctx.askAgent({ question: 'Second decision' });
    return { first, second };
  };`,
  python: `def main(ctx):
    first = ctx.askAgent({"question": "First decision"})
    ctx.progress({"stage": "continued"})
    second = ctx.askAgent({"question": "Second decision"})
    return {"first": first, "second": second}
`,
};

const programs = [
  ...Object.entries(sources).map(([language, source]) => ({ name: language, language, source })),
  { name: 'javascript Promise.all', language: 'javascript', source: `module.exports.main = async ctx =>
    await Promise.all([ctx.askAgent({question:'First decision'}), ctx.askAgent({question:'Second decision'})]);` },
];
for (const { name, language, source } of programs) {
  test(`real ${name} askAgent waits remain cumulative after decisions and completion`, async t => {
    let now = 1000;
    const supervisor = createScriptSupervisor({ now: () => now });
    const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
    const context = { supervisor, store, actions: async () => assert.fail('No device commands are needed') };
    t.after(() => supervisor.cancelAll());
    const first = await handle({ ...context, operation: 'start', waitMs: 5000,
      script: { schemaVersion: 'aab.code-script/v1', language, source } });
    assert.equal(first.status, 'waiting_for_agent', JSON.stringify(first));
    now = 1300;
    const waiting = await handle({ ...context, operation: 'status', operationId: first.operationId });
    assert.equal(waiting.rollingSummary.decisionWaitMs, 300);
    assert.equal(waiting.rollingSummary.activeMs, 0, 'Agent wait is not active Script time');

    now = 1400;
    const continued = await handle({ ...context, operation: 'decide', operationId: first.operationId,
      requestId: first.pendingQuestion.requestId, revision: first.pendingQuestion.revision, decision: 'one' });
    assert.equal(continued.rollingSummary.decisionWaitMs, 400);
    const second = await handle({ ...context, operation: 'wait', operationId: first.operationId,
      afterSequence: continued.eventSequence, waitMs: 5000 });
    assert.equal(second.status, 'waiting_for_agent');
    assert.notEqual(second.pendingQuestion.requestId, first.pendingQuestion.requestId);
    now = 1900;
    const waitingAgain = await handle({ ...context, operation: 'status', operationId: first.operationId });
    assert.equal(waitingAgain.rollingSummary.decisionWaitMs, 900);

    now = 2000;
    await handle({ ...context, operation: 'decide', operationId: first.operationId,
      requestId: second.pendingQuestion.requestId, revision: second.pendingQuestion.revision, decision: 'two' });
    await supervisor.registry.get(first.operationId).running;
    const terminal = await handle({ ...context, operation: 'status', operationId: first.operationId });
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.rollingSummary.elapsedMs, 1000);
    assert.equal(terminal.rollingSummary.activeMs, 0);
    assert.equal(terminal.rollingSummary.decisionWaitMs, 1000);
    now = 9000;
    const later = await handle({ ...context, operation: 'status', operationId: first.operationId });
    assert.deepEqual(later.rollingSummary, terminal.rollingSummary, 'terminal accounting is frozen');
  });
}

for (const freshHost of [false, true]) {
  test(`${freshHost ? 'durable' : 'same Host'} checkpoint reentry counts new Agent waits in its declared window`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-script-timing-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const reopen = () => createScriptEvidenceStore({ adapter: createFileEvidenceAdapter({ dir }) });
    let now = 1000;
    const firstHost = createScriptSupervisor({ now: () => now });
    t.after(() => firstHost.cancelAll());
    const actions = async () => assert.fail('No device commands are needed');
    const firstContext = { supervisor: firstHost, store: reopen(), actions };
    const started = await handle({ ...firstContext, operation: 'start', waitMs: 5000,
      script: { schemaVersion: 'aab.code-script/v1', language: 'javascript',
        policy: { restartPolicy: 'checkpoint' }, source: `module.exports.main = async ctx => {
          if (!ctx.resume()) {
            await ctx.askAgent({ question: 'Before checkpoint' });
            await ctx.checkpoint('continue', { ready: true });
            process.exit(31);
          }
          return await ctx.askAgent({ question: 'After checkpoint' });
        };` } });
    assert.equal(started.status, 'waiting_for_agent');
    now = 1200;
    await handle({ ...firstContext, operation: 'decide', operationId: started.operationId,
      requestId: started.pendingQuestion.requestId, revision: started.pendingQuestion.revision, decision: 'continue' });
    await firstHost.registry.get(started.operationId).running;
    const failed = await handle({ ...firstContext, operation: 'status', operationId: started.operationId });
    assert.equal(failed.error, 'child_crashed');

    now = 2000;
    const supervisor = freshHost ? createScriptSupervisor({ now: () => now }) : firstHost;
    t.after(() => supervisor.cancelAll());
    const context = { supervisor, store: reopen(), actions };
    const resumed = await handle({ ...context, operation: 'resume', operationId: started.operationId, waitMs: 5000 });
    assert.equal(resumed.status, 'waiting_for_agent', JSON.stringify(resumed));
    assert.equal(resumed.rollingSummary.startedAtMs, freshHost ? 2000 : 1000);
    now = 2300;
    await handle({ ...context, operation: 'decide', operationId: started.operationId,
      requestId: resumed.pendingQuestion.requestId, revision: resumed.pendingQuestion.revision, decision: 'done' });
    await supervisor.registry.get(started.operationId).running;
    const terminal = await handle({ ...context, operation: 'status', operationId: started.operationId });
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.rollingSummary.elapsedMs, freshHost ? 300 : 1300);
    assert.equal(terminal.rollingSummary.decisionWaitMs, freshHost ? 300 : 500);
    assert.equal(terminal.rollingSummary.activeMs, 0);
    now = 9000;
    const later = await handle({ ...context, operation: 'status', operationId: started.operationId });
    assert.deepEqual(later.rollingSummary, terminal.rollingSummary);
    if (freshHost) {
      const cold = await handle({ supervisor: createScriptSupervisor(), store: reopen(), operation: 'status', operationId: started.operationId });
      assert.equal(cold.status, 'completed');
      assert.equal(Object.hasOwn(cold, 'rollingSummary'), false, 'persisted status does not invent lost timing history');
    }
  });
}
