'use strict';

const { createFakeHostPort } = require('../bin/script/fake-host-port');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestScriptSupervisor: createScriptSupervisor } = require('./helpers/script-supervisor');

function spec(source) {
  return {
    schemaVersion: 'aab.code-script/v1',
    name: 'p8-spawn',
    language: 'javascript',
    source,
    target: { serial: 'p8', packageName: 'com.example.app' },
  };
}

async function waitDone(supervisor, operationId, waitMs = 5000) {
  const deadline = Date.now() + waitMs;
  let afterSequence = 0;
  while (Date.now() < deadline) {
    const snapshot = await supervisor.handle({
      operation: 'wait',
      operationId,
      waitMs: Math.max(1, Math.min(200, deadline - Date.now())),
      afterSequence,
    });
    if (snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled') {
      return snapshot;
    }
    afterSequence = snapshot.eventSequence;
  }
  return supervisor.handle({ operation: 'status', operationId, afterSequence: 0 });
}

test('P8 JS spawn plus complete leaves a later start usable', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const samples = [];
  for (let i = 0; i < 8; i += 1) {
    const startedAt = process.hrtime.bigint();
    const started = await supervisor.handle({
      operation: 'start',
      script: spec('function main() { return { ok: true }; }\nmodule.exports = { main };'),
    });
    const done = await waitDone(supervisor, started.operationId);
    samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
    assert.equal(done.status, 'completed');
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  assert.equal(Number.isFinite(p95), true);
});

test('P8 Python complete leaves a later start usable', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: {
      schemaVersion: 'aab.code-script/v1',
      name: 'p8-py',
      language: 'python',
      source: 'def main(ctx):\n    return {"ok": True}\n',
      target: { serial: 'p8', packageName: 'com.example.app' },
    },
  });
  if (started.error === 'runtime_unavailable') {
    return;
  }
  const done = await waitDone(supervisor, started.operationId);
  assert.equal(done.status, 'completed');
  const next = await supervisor.handle({
    operation: 'start',
    script: spec('function main() { return { ok: true }; }\nmodule.exports = { main };'),
  });
  const second = await waitDone(supervisor, next.operationId);
  assert.equal(second.status, 'completed');
});

test('P8 cancelled hanging JS leaves a later start usable', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const hanging = await supervisor.handle({
    operation: 'start',
    script: spec(`
async function main() {
  await new Promise(() => {});
}
module.exports = { main };
`),
  });
  const cancelled = await supervisor.handle({
    operation: 'cancel',
    operationId: hanging.operationId,
  });
  assert.equal(cancelled.status, 'cancelled');
  const next = await supervisor.handle({
    operation: 'start',
    script: spec('function main() { return { ok: true }; }\nmodule.exports = { main };'),
  });
  const done = await waitDone(supervisor, next.operationId);
  assert.equal(done.status, 'completed');
});
