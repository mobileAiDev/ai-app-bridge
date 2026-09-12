'use strict';

const { createFakeHostPort } = require('../bin/script/fake-host-port');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestScriptSupervisor: createScriptSupervisor } = require('./helpers/script-supervisor');
const { createScriptCapturePort } = require('../bin/script/script-capture-port');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');

const ARTIFACT = path.join(
  __dirname,
  '../../../build/ai_app_bridge_artifacts/script-intent-rebuild/p8-handshake-bench.json',
);

function percentile(samples, p) {
  const sorted = samples.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

function stats(samples) {
  return {
    n: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
  };
}

function writeArtifact(key, summary) {
  fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
  let previous = {};
  if (fs.existsSync(ARTIFACT)) previous = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  fs.writeFileSync(ARTIFACT, JSON.stringify({ ...previous, [key]: summary }, null, 2));
}

function spec() {
  return {
    schemaVersion: 'aab.code-script/v1',
    name: 'p8-overhead',
    language: 'javascript',
    source: 'function main() { return { ok: true }; }\nmodule.exports = { main };',
    target: { platform: 'android', serial: 'p8', packageName: 'com.example.app' },
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

test('P8 start receipt p95 stays at or under 500 ms', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const samples = [];
  for (let i = 0; i < 22; i += 1) {
    const startedAt = process.hrtime.bigint();
    const started = await supervisor.handle({
      operation: 'start',
      script: spec(),
    });
    samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
    assert.equal(started.ok, true);
    await waitDone(supervisor, started.operationId);
  }
  const summary = stats(samples.slice(2));
  writeArtifact('startReceipt', summary);
  assert.equal(summary.p95 <= 500, true, `start receipt p95 ${summary.p95}ms`);
});

test('P8 Supervisor call overhead p95 stays at or under 25 ms', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec(),
    store,
    program: async (ctx) => {
      const samples = [];
      for (let i = 0; i < 40; i += 1) {
        const callStarted = process.hrtime.bigint();
        await ctx.call('tree', {});
        samples.push(Number(process.hrtime.bigint() - callStarted) / 1e6);
      }
      return { samples: samples.slice(2) };
    },
  });
  const done = await waitDone(supervisor, started.operationId);
  assert.equal(done.status, 'completed');
  const status = await supervisor.handle({
    operation: 'status',
    operationId: started.operationId,
    afterSequence: 0,
  });
  await supervisor.registry.get(started.operationId).running;
  const completed = await supervisor.handle({ operation: 'result', operationId: started.operationId, store });
  assert.equal(completed.ok, true, JSON.stringify(completed));
  const fromProgram = completed.result.samples;
  assert.equal(Array.isArray(fromProgram) && fromProgram.length > 0, true);
  const summary = stats(fromProgram);
  writeArtifact('supervisorCall', summary);
  assert.equal(summary.p95 <= 25, true, `supervisor call p95 ${summary.p95}ms`);
});

test('P8 material event is readable on summary within 100 ms', async () => {
  const samples = [];
  for (let i = 0; i < 22; i += 1) {
    const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
    let callDoneAt = null;
    const started = await supervisor.handle({
      operation: 'start',
      script: spec(),
      program: async (ctx) => {
        await ctx.call('tree', {});
        callDoneAt = process.hrtime.bigint();
        return { ok: true };
      },
    });
    const deadline = Date.now() + 1000;
    let recorded = false;
    while (Date.now() < deadline) {
      const status = await supervisor.handle({ operation: 'status', operationId: started.operationId });
      if (callDoneAt && status.rollingSummary && status.rollingSummary.completedCalls >= 1) {
        samples.push(Number(process.hrtime.bigint() - callDoneAt) / 1e6);
        recorded = true;
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    await waitDone(supervisor, started.operationId);
    assert.equal(recorded, true);
  }
  const summary = stats(samples.slice(2));
  assert.equal(summary.p95 <= 100, true, `material-to-summary p95 ${summary.p95}ms`);
});

test('P8 decision query p95 stays at or under 50 ms', async () => {
  const port = createScriptCapturePort({
    query: async () => ({
      ok: true,
      coverage: { status: 'complete', gap: false, committed: true },
      refs: [{ stream: 'network', mobileFactId: 'mf1:1:1:network', captureId: 1 }],
      items: [{ id: 1, statusCode: 200 }],
    }),
  });
  const samples = [];
  for (let i = 0; i < 40; i += 1) {
    const startedAt = process.hrtime.bigint();
    const window = await port.query('network', {}, { actionId: 'a1' });
    samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
    assert.equal(window.coverage.status, 'complete');
  }
  const summary = stats(samples.slice(2));
  writeArtifact('decisionQuery', summary);
  assert.equal(summary.p95 <= 50, true, `decision query p95 ${summary.p95}ms`);
});
