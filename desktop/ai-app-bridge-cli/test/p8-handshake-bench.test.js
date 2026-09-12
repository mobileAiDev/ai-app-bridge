'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createNodeRuntimeAdapter } = require('../bin/script/node-runtime-adapter');
const { createPythonRuntimeAdapter } = require('../bin/script/python-runtime-adapter');
const { compileScriptSpec } = require('../bin/script/script-spec');

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

function host() {
  return {
    call: async () => ({
      ok: true,
      result: { root: { id: 'home', children: [] } },
      evidence: { coverage: { status: 'complete', gap: false, committed: true }, refs: [] },
    }),
    assert: async () => ({ verdict: 'passed', name: null }),
  };
}

async function handshakeMs(createRuntime, language, source) {
  const runtime = createRuntime();
  if (runtime.unavailable) return null;
  const compiled = compileScriptSpec({
    schemaVersion: 'aab.code-script/v1',
    name: 'p8-handshake',
    language,
    source,
    target: { platform: 'android', serial: 'p8', packageName: 'com.example.app' },
    policy: { timeoutMs: 15_000 },
  });
  const started = process.hrtime.bigint();
  let readyAt = null;
  const result = await runtime.start({
    spec: compiled.spec,
    host: host(),
    agent: { askAgent: async () => ({}) },
    emit: (type) => {
      if (type === 'child_started' && readyAt == null) readyAt = process.hrtime.bigint();
    },
    control: () => ({ status: 'running', pauseReason: null, checkpoint: null }),
    now: Date.now,
  });
  runtime.stop();
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    ms: Number((readyAt || process.hrtime.bigint()) - started) / 1e6,
  };
}

async function collect(createRuntime, language, source, count) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    const sample = await handshakeMs(createRuntime, language, source);
    if (sample == null) return null;
    assert.equal(sample.ok, true, sample.error);
    samples.push(sample.ms);
  }
  return samples.slice(2);
}

test('P8 JS spawn plus handshake p95 stays at or under 150 ms', async () => {
  const samples = await collect(
    createNodeRuntimeAdapter,
    'javascript',
    'function main() { return { ok: true }; }\nmodule.exports = { main };',
    22,
  );
  const summary = stats(samples);
  fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
  let previous = {};
  if (fs.existsSync(ARTIFACT)) previous = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  fs.writeFileSync(ARTIFACT, JSON.stringify({ ...previous, javascript: summary }, null, 2));
  assert.equal(summary.p95 <= 150, true, `JS handshake p95 ${summary.p95}ms`);
});

test('P8 Python spawn plus handshake p95 stays at or under 300 ms', async () => {
  const samples = await collect(
    createPythonRuntimeAdapter,
    'python',
    'def main(ctx):\n    return {"ok": True}\n',
    22,
  );
  if (samples == null) return;
  const summary = stats(samples);
  fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
  let previous = {};
  if (fs.existsSync(ARTIFACT)) previous = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  fs.writeFileSync(ARTIFACT, JSON.stringify({ ...previous, python: summary }, null, 2));
  assert.equal(summary.p95 <= 300, true, `Python handshake p95 ${summary.p95}ms`);
});

test('P8 child to Host empty RPC p95 stays at or under 10 ms', async () => {
  const runtime = createNodeRuntimeAdapter();
  const compiled = compileScriptSpec({
    schemaVersion: 'aab.code-script/v1',
    name: 'p8-rpc',
    language: 'javascript',
    source: `
async function main(ctx) {
  const samples = [];
  for (let i = 0; i < 40; i += 1) {
    const started = process.hrtime.bigint();
    await ctx.call('tree', {});
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return { samples: samples.slice(2) };
}
module.exports = { main };
`,
    target: { platform: 'android', serial: 'p8', packageName: 'com.example.app' },
    policy: { timeoutMs: 15_000 },
  });
  const result = await runtime.start({
    spec: compiled.spec,
    host: host(),
    agent: { askAgent: async () => ({}) },
    emit: () => {},
    control: () => ({ status: 'running', pauseReason: null, checkpoint: null }),
    now: Date.now,
  });
  runtime.stop();
  assert.equal(result.ok, true);
  const summary = stats(result.result.samples);
  fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
  let previous = {};
  if (fs.existsSync(ARTIFACT)) previous = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  fs.writeFileSync(ARTIFACT, JSON.stringify({ ...previous, emptyRpc: summary }, null, 2));
  assert.equal(summary.p95 <= 10, true, `empty RPC p95 ${summary.p95}ms`);
});
