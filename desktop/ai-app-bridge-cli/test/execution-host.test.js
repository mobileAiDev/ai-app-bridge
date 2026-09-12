'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-execution-host-'));
process.env.AI_APP_BRIDGE_FACT_STORE_DIR = path.join(directory, 'facts');
process.env.AI_APP_BRIDGE_FACT_CACHE_PROFILE = '64mb';
const host = require('../bin/execution-host');
const { runGeneric } = require('../test-support/host-client');
const { FactRecorder } = require('../bin/fact-recorder');
const { createLegacyFactStoreAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { getHostFactStore } = require('../bin/shared-kernel/host-fact-store');

after(async () => {
  await host.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

const run = async (command, args) => (await host.run({ command, arguments: args })).value;
const mcp = async (command, args) => JSON.parse((await runGeneric({ command, arguments: args })).content[0].text);

test('execution host rejects invalid requests before opening storage or calling a provider', async () => {
  const reply = await host.run({ command: 'tap', arguments: { serial: 'host-phone', tapX: '1', tapY: 2 } }, {
    rawRunner: () => { throw new Error('invalid input reached a provider'); },
  });
  assert.deepEqual(Object.keys(reply), ['value']);
  assert.equal(reply.value.ok, false);
  assert.equal(reply.value.error, 'invalid_argument');
  assert.equal(reply.value.field, 'tapX');
  assert.equal(reply.value.dispatched, false);
  assert.equal(fs.existsSync(process.env.AI_APP_BRIDGE_FACT_STORE_DIR), false);
});

test('execution host preserves XML separately from its persistent history reference', async () => {
  const xml = '<hierarchy><node text="共享执行路径"/></hierarchy>';
  const recorder = new FactRecorder({ cache: createLegacyFactStoreAdapter(getHostFactStore()) });
  const reply = await host.run({ command: 'uia-tree', arguments: { serial: 'host-phone' } }, {
    rawRunner: async () => xml, factRecorder: recorder, observationCollector: null,
  });
  assert.equal(reply.value, xml);
  assert.equal(Object.hasOwn(reply, 'content'), false);
  assert.equal(reply.history.status, 'stored');
  assert.equal(reply.history.action.stored, true);
  const facts = getHostFactStore().read({ targetKey: reply.history.action.targetKey, limit: 100 });
  assert.equal(facts.ok, true);
  assert(facts.items.some(fact => fact.globalSeq === reply.history.action.globalSeq && fact.payload.kind === 'execution'));
});

test('host and MCP adapter control one real Script and export the same durable operation', { timeout: 15000 }, async () => {
  const started = await run('script', { operation: 'start', script: {
    schemaVersion: 'aab.code-script/v1', language: 'javascript', permissions: [],
    source: "module.exports.main = async ctx => ({ answer: await ctx.askAgent({ question: 'Supply a structured result' }) });",
    policy: { timeoutMs: 10000 },
  } });
  assert.equal(started.ok, true, JSON.stringify(started));
  let state = started;
  while (!['waiting_for_agent', 'completed', 'failed', 'cancelled'].includes(state.status)) {
    state = await mcp('script', { operation: 'wait', operationId: started.operationId, afterSequence: state.eventSequence, waitMs: 1000 });
  }
  assert.equal(state.status, 'waiting_for_agent', JSON.stringify(state));
  const question = state.events.find(event => event.type === 'agent_question_created');
  assert(question);
  const decision = { text: '同一任务', accepted: false, count: 0 };
  state = await mcp('script', { operation: 'decide', operationId: started.operationId,
    requestId: question.requestId, revision: question.revision, decision });
  while (!['completed', 'failed', 'cancelled'].includes(state.status)) {
    state = await run('script', { operation: 'wait', operationId: started.operationId, afterSequence: state.eventSequence, waitMs: 1000 });
  }
  state = await run('script', { operation: 'status', operationId: started.operationId });
  assert.equal(state.status, 'completed', JSON.stringify(state));
  assert.deepEqual((await run('script', { operation: 'result', operationId: started.operationId })).result, { answer: decision });
  const archive = await mcp('evidence', { operation: 'export', namespace: 'script', operationId: started.operationId,
    outputDir: path.join(directory, 'archive') });
  assert.equal(archive.ok, true, JSON.stringify(archive));
  const verified = await run('evidence', { operation: 'verify', archiveDir: path.join(directory, 'archive'),
    manifestSha256: archive.manifestSha256 });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  const records = JSON.parse(fs.readFileSync(path.join(directory, 'archive', 'records.json'), 'utf8'));
  assert(records.length > 0);
  assert(records.every(record => record.payload.operationId === started.operationId));
});

test('host shutdown rejects new work and waits for an already admitted command to settle', async () => {
  let finish, entered;
  const admitted = new Promise(resolve => { entered = resolve; });
  const provider = new Promise(resolve => { finish = resolve; });
  const pending = host.run({ command: 'uia-tree', arguments: { serial: 'host-phone' } }, {
    rawRunner: () => { entered(); return provider; }, factRecorder: null, observationCollector: null,
  });
  await admitted;
  let closed = false;
  const closing = host.close().then(() => { closed = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    assert.deepEqual((await host.run({ command: 'script', arguments: { operation: 'runtime-status' } })).value,
      { ok: false, error: 'runtime_stopping', dispatched: false, ambiguous: false });
  } finally { finish('<hierarchy/>'); }
  assert.equal((await pending).value, '<hierarchy/>');
  await closing;
  assert.equal(closed, true);
});
