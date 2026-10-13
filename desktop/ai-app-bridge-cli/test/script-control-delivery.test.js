'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createScriptSupervisor } = require('../bin/script/script-supervisor');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { handle } = require('../bin/script/script-entry');
const spec = source => ({ schemaVersion: 'aab.code-script/v1', language: 'javascript', source,
  policy: { timeoutMs: 10000, restartPolicy: 'checkpoint' } });
const fixture = () => ({ supervisor: createScriptSupervisor(), store: createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() }), actions: async () => ({ ok: true }) });

test('default control replies bound history after many commands; explicit history remains available', async () => {
  const f = fixture();
  const start = await handle({ ...f, operation: 'start', script: spec(`module.exports.main=async ctx=>{
    for(let i=0;i<80;i++) await ctx.progress({stage:'step',message:'payload'.repeat(100),index:i});
    return {done:80};
  }`) });
  assert(start.ok, JSON.stringify(start));
  await f.supervisor.registry.get(start.operationId).running;
  const brief = await handle({ ...f, operation: 'status', operationId: start.operationId });
  assert.equal(brief.status, 'completed');
  assert(brief.events.length <= 1); assert(brief.history.items.length <= 1);
  assert.equal(brief.history.window, 'latest'); assert(brief.history.omittedBefore);
  assert.equal(brief.events[0].type, 'script_completed');
  const all = await handle({ ...f, operation: 'status', operationId: start.operationId, limit: 1000, eventLimit: 1000 });
  assert(all.events.length >= 80); assert(all.history.items.length >= 80);
  const history = [], events = [];
  let cursor = 0;
  for (;;) {
    const page = await handle({ ...f, operation: 'status', operationId: start.operationId, afterSequence: cursor, limit: 2 });
    history.push(...page.history.items);
    if (!page.history.hasMore) break;
    assert(page.history.lastSequence > cursor);
    cursor = page.history.lastSequence;
  }
  cursor = 0;
  while (cursor < all.eventSequence) {
    const page = await handle({ ...f, operation: 'status', operationId: start.operationId, afterSequence: cursor, eventLimit: 3 });
    assert(page.events.length > 0);
    events.push(...page.events);
    cursor = page.events.at(-1).sequence;
  }
  assert.deepEqual(history, all.history.items, 'bounded audit pages preserve every ledger fact');
  assert.deepEqual(events, all.events, 'live watermark is not used to skip undelivered events');
  const waited = await handle({ ...f, operation: 'wait', operationId: start.operationId, waitMs: 0, afterSequence: start.eventSequence });
  assert.deepEqual(waited.result, { done: 80 });
  assert(waited.events.length <= 1); assert(waited.history.items.length <= 1);
});

test('resume can wait and return the result in one call without replaying the completed checkpoint', async () => {
  const f = fixture();
  const script = spec(`module.exports.main=async ctx=>{
    if(!ctx.resume()){await ctx.checkpoint('done',{count:1});process.exit(31);}
    return {resumed:true,count:ctx.resume().count};
  }`);
  const first = await handle({ ...f, operation: 'start', waitMs: 5000, script });
  assert.equal(first.status, 'failed'); assert.equal(first.error, 'child_crashed');
  const resumed = await handle({ ...f, operation: 'resume', operationId: first.operationId, waitMs: 5000 });
  assert.equal(resumed.operationId, first.operationId);
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(resumed.result, { resumed: true, count: 1 });
});

test('repeated status reads do not flood heartbeats while a Script waits for its Agent', async () => {
  let now = 1000;
  const f = { ...fixture(), supervisor: createScriptSupervisor({ now: () => now }) };
  const waiting = await handle({ ...f, operation: 'start', waitMs: 1000,
    script: spec('module.exports.main=async ctx=>await ctx.askAgent({question:"Pause here"});') });
  assert.equal(waiting.status, 'waiting_for_agent');
  now = 4000;
  const before = await handle({ ...f, operation: 'status', operationId: waiting.operationId });
  assert.equal(before.history.items[0].kind, 'agent_question_created', 'latest ledger fact survives heartbeat-only event gaps');
  for (let i = 0; i < 100; i++) {
    const current = await handle({ ...f, operation: 'status', operationId: waiting.operationId });
    assert.equal(current.eventSequence, before.eventSequence);
    assert.deepEqual(current.pendingQuestion, waiting.pendingQuestion);
  }
  now = 6000;
  const next = await handle({ ...f, operation: 'status', operationId: waiting.operationId });
  assert.equal(next.eventSequence, before.eventSequence + 1);
  await handle({ ...f, operation: 'cancel', operationId: waiting.operationId });
});
