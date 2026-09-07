'use strict';

const { createFakeHostPort } = require('../bin/script/fake-host-port');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { compileScriptSpec } = require('../bin/script/script-spec');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { codeStartCheckpoint } = require('../bin/script/script-durable-restore');
const { handleCodeOrRemoved } = require('../bin/script/script-entry-route');
const { createTestScriptSupervisor: createScriptSupervisor } = require('./helpers/script-supervisor');

const SOURCE = 'function main() { return { ok: true }; }\nmodule.exports = { main };';

function codeScript() {
  return {
    schemaVersion: 'aab.code-script/v1',
    name: 'p7-route',
    language: 'javascript',
    source: SOURCE,
    target: { serial: 'b46093e6', packageName: 'com.example.app' },
    policy: { restartPolicy: 'checkpoint' },
  };
}

test('P7 post-delete route sends code scripts to the supervisor', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await handleCodeOrRemoved({
    operation: 'start',
    script: codeScript(),
  }, supervisor);
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
});

test('P7 post-delete route rejects old steps payloads', async () => {
  const blocked = { handle() { throw new Error('supervisor'); }, knownOperation() { return true; } };
  const objectStart = await handleCodeOrRemoved({
    operation: 'start',
    script: { name: 'old', steps: [{ id: 'o1', type: 'observe' }] },
  }, blocked);
  assert.equal(objectStart.error, 'script_format_removed');

  const jsonStart = await handleCodeOrRemoved({
    operation: 'start',
    operationId: 'live-code',
    script: JSON.stringify({ name: 'old', steps: [{ id: 'o1', type: 'observe' }] }),
  }, blocked);
  assert.equal(jsonStart.error, 'script_format_removed');

  const yamlStart = await handleCodeOrRemoved({
    operation: 'start',
    yaml: 'name: old\nsteps:\n  - id: o1\n    type: observe\n',
  }, blocked);
  assert.equal(yamlStart.error, 'script_format_removed');

  const sourceStart = await handleCodeOrRemoved({
    operation: 'start',
    source: 'name: old\nsteps:\n  - id: o1\n    type: observe\n',
  }, blocked);
  assert.equal(sourceStart.error, 'script_format_removed');

  const indentedStart = await handleCodeOrRemoved({
    operation: 'start',
    operationId: 'live-code',
    yaml: 'name: old\n  steps:\n    - id: o1\n      type: observe\n',
  }, blocked);
  assert.equal(indentedStart.error, 'script_format_removed');

  const taggedStart = await handleCodeOrRemoved({
    operation: 'start',
    script: {
      schemaVersion: 'aab.code-script/v1',
      name: 'old',
      steps: [{ id: 'o1', type: 'observe' }],
    },
  }, blocked);
  assert.equal(taggedStart.error, 'script_format_removed');
});

test('P7 post-delete route rejects a steps checkpoint instead of restoring the old worker', async () => {
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  await store.persist('checkpoint', {
    operationId: 'old-steps',
    revision: 1,
    stepId: 'start',
    status: 'paused_manual',
    script: { name: 'old', steps: [{ id: 'o1', type: 'observe' }] },
  });
  const result = await handleCodeOrRemoved({
    operation: 'status',
    operationId: 'old-steps',
    store,
  }, { handle() { throw new Error('supervisor'); }, knownOperation() { return false; } });
  assert.equal(result.error, 'script_format_removed');
});

test('P7 post-delete route restores a frozen code checkpoint', async () => {
  const compiled = compileScriptSpec(codeScript());
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  await store.persist('checkpoint', {
    ...codeStartCheckpoint(compiled, 'route-code'),
    checkpoint: { name: 'user-state', state: { step: 1 } },
    stepId: 'user-state',
  });
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const status = await handleCodeOrRemoved({
    operation: 'status',
    operationId: 'route-code',
    store,
  }, supervisor);
  assert.equal(status.restored, true);
  assert.equal(status.status, 'failed');
  assert.equal(status.error, 'runtime_lost');
  assert.equal(status.resumable, true);
  const resumed = await handleCodeOrRemoved({
    operation: 'resume',
    operationId: 'route-code',
    store,
  }, supervisor);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.operationId, 'route-code');
  await supervisor.handle({ operation: 'cancel', operationId: 'route-code' });
});
