'use strict';

const { createFakeHostPort } = require('../bin/script/fake-host-port');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestScriptSupervisor: createScriptSupervisor } = require('./helpers/script-supervisor');

function percentile(samples, p) {
  const sorted = samples.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

function spec() {
  return {
    schemaVersion: 'aab.code-script/v1',
    name: 'p8-material',
    language: 'javascript',
    source: 'function main() { return { ok: true }; }\nmodule.exports = { main };',
    target: { platform: 'android', serial: 'p8', packageName: 'com.example.app' },
  };
}

test('P8 material event to rolling summary p95 stays at or under 100 ms', async () => {
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
      const status = await supervisor.handle({
        operation: 'status',
        operationId: started.operationId,
      });
      if (callDoneAt && status.rollingSummary && status.rollingSummary.completedCalls >= 1) {
        samples.push(Number(process.hrtime.bigint() - callDoneAt) / 1e6);
        recorded = true;
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(recorded, true);
    await supervisor.handle({ operation: 'cancel', operationId: started.operationId });
  }
  const official = samples.slice(2);
  const p95 = percentile(official, 0.95);
  assert.equal(p95 <= 100, true, `material-to-summary p95 ${p95}ms`);
});
