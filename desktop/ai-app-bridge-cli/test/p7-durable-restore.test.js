'use strict';

const { createFakeHostPort } = require('../bin/script/fake-host-port');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFileEvidenceAdapter, createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { compileScriptSpec } = require('../bin/script/script-spec');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { loadDurableCheckpoint, planCodeRestore, codeStartCheckpoint, restoreUnknownOperation } = require('../bin/script/script-durable-restore');

const SOURCE = 'function main() { return { ok: true }; }\nmodule.exports = { main };';

function codeScript() {
  return {
    schemaVersion: 'aab.code-script/v1',
    name: 'p7-restore',
    language: 'javascript',
    source: SOURCE,
    target: { serial: 'b46093e6', packageName: 'com.example.app' },
    policy: { restartPolicy: 'checkpoint' },
  };
}

test('P7 durable restore reports unknown_operation without a checkpoint', async () => {
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const loaded = loadDurableCheckpoint(store, 'missing');
  assert.equal(loaded.ok, false);
  assert.equal(loaded.error, 'unknown_operation');
});

test('P7 durable restore treats a prepared marker without receipt as ambiguous', async () => {
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  await store.persist('checkpoint', {
    operationId: 'amb',
    revision: 1,
    stepId: 'start',
    status: 'running',
    hash: 'abc',
  });
  await store.persist('dispatch-marker', {
    operationId: 'amb',
    revision: 1,
    actionId: 'a1',
    target: { serial: 'b46093e6', packageName: 'com.example.app' },
    actionSpecHash: 'tap',
    planStepId: 'a1',
    state: 'prepared',
  });
  const loaded = loadDurableCheckpoint(store, 'amb');
  assert.equal(loaded.error, 'ambiguous');
  assert.equal(loaded.status, 'ambiguous');
});

test('P7 durable restore treats an ambiguous receipt as not replayable', async () => {
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  await store.persist('checkpoint', {
    operationId: 'amb-receipt',
    revision: 1,
    stepId: 'start',
    status: 'ambiguous',
    hash: 'abc',
  });
  await store.persist('dispatch-marker', {
    operationId: 'amb-receipt',
    revision: 1,
    actionId: 'a1',
    target: { serial: 'b46093e6', packageName: 'com.example.app' },
    actionSpecHash: 'tap',
    planStepId: 'a1',
    state: 'prepared',
  });
  await store.persist('action-receipt', {
    operationId: 'amb-receipt',
    revision: 1,
    actionId: 'a1',
    startedAtMs: 1,
    completedAtMs: 2,
    mechanicalStatus: 'ok',
    ambiguous: true,
  });
  const loaded = loadDurableCheckpoint(store, 'amb-receipt');
  assert.equal(loaded.error, 'ambiguous');
});

test('P7 durable restore keeps steps checkpoints on the dual-run format', async () => {
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  await store.persist('checkpoint', {
    operationId: 'steps',
    revision: 1,
    stepId: 'start',
    status: 'paused_manual',
    script: { name: 'old', steps: [{ id: 'o1', type: 'observe' }] },
  });
  const loaded = loadDurableCheckpoint(store, 'steps');
  const planned = planCodeRestore({ checkpoint: loaded.checkpoint });
  assert.equal(planned.ok, true);
  assert.equal(planned.format, 'steps');
});

test('P7 durable restore requires frozen source or a matching script', async () => {
  const compiled = compileScriptSpec(codeScript());
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  await store.persist('checkpoint', {
    operationId: 'code',
    revision: 1,
    stepId: 'start',
    status: 'running',
    hash: compiled.hash,
  });
  const loaded = loadDurableCheckpoint(store, 'code');
  const missing = planCodeRestore({ checkpoint: loaded.checkpoint });
  assert.equal(missing.error, 'script_source_required');
  const planned = planCodeRestore({ checkpoint: loaded.checkpoint, script: codeScript() });
  assert.equal(planned.ok, true);
  assert.equal(planned.format, 'code');
  assert.equal(planned.compiled.hash, compiled.hash);
});

test('P7 durable restore rejects a script whose hash does not match the checkpoint', async () => {
  const compiled = compileScriptSpec(codeScript());
  const planned = planCodeRestore({
    checkpoint: { hash: compiled.hash, stepId: 'start' },
    script: { ...codeScript(), source: 'function main() { return { other: true }; }\nmodule.exports = { main };' },
  });
  assert.equal(planned.error, 'script_hash_mismatch');
});

test('P7 durable restore reloads a code checkpoint from a file store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-code-restore-'));
  const compiled = compileScriptSpec(codeScript());
  const first = createScriptEvidenceStore({ adapter: createFileEvidenceAdapter({ dir }) });
  await first.persist('checkpoint', {
    operationId: 'file-code',
    revision: 1,
    stepId: 'start',
    status: 'paused_manual',
    hash: compiled.hash,
    source: SOURCE,
    language: 'javascript',
    name: 'p7-restore',
    target: { serial: 'b46093e6', packageName: 'com.example.app' },
    policy: { restartPolicy: 'checkpoint' },
  });
  const second = createScriptEvidenceStore({ adapter: createFileEvidenceAdapter({ dir }) });
  const loaded = loadDurableCheckpoint(second, 'file-code');
  const planned = planCodeRestore({ checkpoint: loaded.checkpoint });
  assert.equal(planned.ok, true);
  assert.equal(planned.format, 'code');
  assert.equal(planned.compiled.hash, compiled.hash);
  const { createTestScriptSupervisor: createScriptSupervisor } = require('./helpers/script-supervisor');
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: {
      schemaVersion: 'aab.code-script/v1',
      name: planned.compiled.spec.name,
      language: planned.compiled.spec.language,
      source: planned.compiled.spec.source,
      target: planned.compiled.spec.target,
      policy: planned.compiled.spec.policy,
    },
  });
  assert.equal(started.ok, true);
  const done = await supervisor.handle({
    operation: 'wait',
    operationId: started.operationId,
    waitMs: 3000,
    afterSequence: 0,
  });
  assert.equal(done.status === 'completed' || done.status === 'running', true);
  if (done.status !== 'completed') {
    await supervisor.handle({ operation: 'cancel', operationId: started.operationId });
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P7 codeStartCheckpoint freezes source only for checkpoint restart', () => {
  const compiled = compileScriptSpec(codeScript());
  const frozen = codeStartCheckpoint(compiled, 'op-1');
  assert.equal(frozen.hash, compiled.hash);
  assert.equal(frozen.source, SOURCE);
  assert.equal(frozen.language, 'javascript');
  const none = compileScriptSpec({ ...codeScript(), policy: { restartPolicy: 'none' } });
  const live = codeStartCheckpoint(none, 'op-2');
  assert.equal(Object.prototype.hasOwnProperty.call(live, 'source'), false);
  assert.equal(live.hash, none.hash);
});

test('P7 restoreUnknownOperation does not replay an ambiguous prepared marker', async () => {
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  await store.persist('checkpoint', {
    operationId: 'amb-restore',
    revision: 1,
    stepId: 'start',
    status: 'running',
    hash: 'abc',
    source: SOURCE,
    language: 'javascript',
  });
  await store.persist('dispatch-marker', {
    operationId: 'amb-restore',
    revision: 1,
    actionId: 'a1',
    target: { serial: 'b46093e6', packageName: 'com.example.app' },
    actionSpecHash: 'tap',
    planStepId: 'a1',
    state: 'prepared',
  });
  let starts = 0;
  const restored = await restoreUnknownOperation({
    store,
    operationId: 'amb-restore',
    supervisor: { handle() { starts += 1; return { ok: true }; } },
    operation: 'resume',
  });
  assert.equal(restored.error, 'ambiguous');
  assert.equal(starts, 0);
});

test('P7 restoreUnknownOperation status reads the checkpoint and does not start', async () => {
  const compiled = compileScriptSpec(codeScript());
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  await store.persist('checkpoint', codeStartCheckpoint(compiled, 'status-code'));
  let starts = 0;
  const restored = await restoreUnknownOperation({
    store,
    operationId: 'status-code',
    supervisor: { handle() { starts += 1; return { ok: true }; } },
    operation: 'status',
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.restored, true);
  assert.equal(restored.status, 'failed');
  assert.equal(restored.error, 'runtime_lost');
  assert.equal(restored.hash, compiled.hash);
  assert.equal(starts, 0);
});

test('P7 restoreUnknownOperation refuses restart without a committed user checkpoint', async () => {
  const compiled = compileScriptSpec(codeScript());
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  await store.persist('checkpoint', codeStartCheckpoint(compiled, 'resume-code'));
  const restored = await restoreUnknownOperation({
    store, operationId: 'resume-code',
    supervisor: { handle() { assert.fail('must not start without a user checkpoint'); } },
    operation: 'resume',
  });
  assert.equal(restored.error, 'not_resumable');
});

test('P7 durable restore injects the committed user checkpoint into a restarted supervisor', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../bin/script/templates/checkpoint-reentry.js'), 'utf8')
    + '\nmodule.exports.main = async ctx => { const result = await main(ctx); if (!result.resumed) process.exit(31); return result; };';
  const script = {
    ...codeScript(),
    name: 'p7-checkpoint-reentry',
    source,
  };
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const { createTestScriptSupervisor: createScriptSupervisor } = require('./helpers/script-supervisor');
  const firstSupervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const first = await firstSupervisor.handle({
    operation: 'start',
    operationId: 'durable-reentry',
    script,
    store,
  });
  const firstDone = await waitForTerminal(firstSupervisor, first.operationId, first.eventSequence);
  assert.equal(firstDone.status, 'failed');
  assert.equal(firstDone.error, 'child_crashed');

  const committed = store.latest(first.operationId, 'checkpoint');
  assert.equal(committed.stepId, 'after-status');
  assert.deepEqual(committed.checkpoint, { name: 'after-status', state: { step: 1 } });
  assert.equal(committed.source, source);
  assert.equal(committed.hash, compileScriptSpec(script).hash);

  const restartedSupervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const restored = await restoreUnknownOperation({
    store,
    operationId: first.operationId,
    supervisor: restartedSupervisor,
    operation: 'resume',
  });
  assert.equal(restored.ok, true);
  const restoredDone = await waitForTerminal(
    restartedSupervisor,
    first.operationId,
    restored.eventSequence,
  );
  assert.equal(restoredDone.status, 'completed');
  const completed = restoredDone.events.filter((event) => event.type === 'script_completed');
  assert.equal(completed.at(-1).result.resumed, true);
  assert.equal(completed.at(-1).result.step, 1);
});

test('P7 Node child does not proceed until its user checkpoint is durably committed', async () => {
  const backingStore = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  let releaseCommit;
  let checkpointOffered;
  const offered = new Promise((resolve) => { checkpointOffered = resolve; });
  const store = {
    persist(kind, record) {
      if (kind === 'checkpoint' && record.stepId === 'durable' && record.status === 'running') {
        checkpointOffered();
        return new Promise((resolve) => {
          releaseCommit = async () => resolve(backingStore.persist(kind, record));
        });
      }
      return backingStore.persist(kind, record);
    },
  };
  const { createTestScriptSupervisor: createScriptSupervisor } = require('./helpers/script-supervisor');
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    operationId: 'checkpoint-receipt',
    script: {
      ...codeScript(),
      name: 'p7-checkpoint-receipt',
      source: [
        'async function main(ctx) {',
        "  await ctx.checkpoint('durable', { step: 1 });",
        "  await ctx.progress({ stage: 'after-checkpoint' });",
        '  return { passed: true };',
        '}',
        'module.exports = { main };',
      ].join('\n'),
    },
    store,
  });
  await offered;
  await new Promise((resolve) => setTimeout(resolve, 30));
  const blocked = await supervisor.handle({ operation: 'status', operationId: started.operationId });
  assert.equal(blocked.events.some((event) => event.type === 'checkpoint'), false);
  assert.equal(blocked.events.some((event) => event.type === 'progress'), false);
  assert.equal(blocked.events.some((event) => event.type === 'script_completed'), false);

  await releaseCommit();
  const done = await waitForTerminal(supervisor, started.operationId, blocked.eventSequence);
  assert.equal(done.status, 'completed');
  assert.equal(done.events.some((event) => event.type === 'checkpoint'), true);
  assert.equal(done.events.some((event) => event.type === 'progress' && event.stage === 'after-checkpoint'), true);
});

test('P7 supervisor persistStart freezes source for checkpoint restart', async () => {
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const { createTestScriptSupervisor: createScriptSupervisor } = require('./helpers/script-supervisor');
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    operationId: 'persist-code',
    script: codeScript(),
    store,
  });
  assert.equal(started.ok, true);
  const checkpoint = store.latest('persist-code', 'checkpoint');
  assert.equal(checkpoint.source, SOURCE);
  assert.equal(checkpoint.hash, compileScriptSpec(codeScript()).hash);
  await supervisor.handle({ operation: 'cancel', operationId: 'persist-code' });
});

async function waitForTerminal(supervisor, operationId, afterSequence) {
  let after = afterSequence;
  for (let index = 0; index < 20; index += 1) {
    const result = await supervisor.handle({
      operation: 'wait',
      operationId,
      afterSequence: after,
      waitMs: 500,
    });
    if (result.status === 'completed' || result.status === 'failed' || result.status === 'cancelled') {
      return supervisor.handle({ operation: 'status', operationId });
    }
    after = result.eventSequence;
  }
  return supervisor.handle({ operation: 'status', operationId });
}
