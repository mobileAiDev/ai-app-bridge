'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERIAL = 'b46093e6';
const PACKAGE = 'org.localsend.localsend_app.debug';
const TARGET = { serial: SERIAL, packageName: PACKAGE };
const ART = path.resolve(__dirname, '../../../build/ai_app_bridge_artifacts/script-intent-rebuild');
const OUT = path.join(ART, 'g8-speed-device.json');
const MCP_SERVER = path.join(__dirname, '../bin/mcp-server.js');
const WARMUP = 2;
const OFFICIAL = 10;
const MCP_TIMEOUT_MS = 120_000;

const CONTINUOUS_SOURCE = fs.readFileSync(
  path.join(__dirname, '../test/fixtures/p7-g8-localsend.js'),
  'utf8',
);

function codeScript(name, source) {
  return {
    schemaVersion: 'aab.code-script/v1',
    name,
    language: 'javascript',
    source,
    target: TARGET,
  };
}

function stepwiseSources() {
  return [
    'async function main(ctx) { await ctx.call("flutter-tree", {}); return { ok: true }; }\nmodule.exports = { main };',
    'async function main(ctx) { await ctx.call("flutter-tree", {}); await ctx.call("tap-flutter-text", { text: "设置" }); return { ok: true }; }\nmodule.exports = { main };',
    'async function main(ctx) { await ctx.call("flutter-tree", {}); return { ok: true }; }\nmodule.exports = { main };',
    'async function main(ctx) { await ctx.call("flutter-tree", {}); await ctx.call("tap-flutter-text", { text: "发送" }); return { ok: true }; }\nmodule.exports = { main };',
    'async function main(ctx) { await ctx.call("flutter-tree", {}); return { ok: true }; }\nmodule.exports = { main };',
    'async function main(ctx) { await ctx.call("flutter-tree", {}); await ctx.call("tap-flutter-text", { text: "接收" }); return { ok: true }; }\nmodule.exports = { main };',
    'async function main(ctx) { const after = await ctx.call("flutter-tree", {}); await ctx.assert({ name: "settings-visible", predicateSummary: "设置 is on the tree", condition: JSON.stringify(after.result).includes("设置"), requiredEvidence: [], requireCoverage: "complete", evidence: after.evidence }); return { ok: true }; }\nmodule.exports = { main };',
    'async function main(ctx) { await ctx.call("flutter-tree", {}); await ctx.checkpoint("g8-step", { done: true }); return { ok: true }; }\nmodule.exports = { main };',
  ];
}

function probeAdb() {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn('adb', ['-s', SERIAL, 'shell', 'true'], { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, error: 'transport_timeout', ms: 2000 });
    }, 2000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        error: error.message || String(error),
        ms: Number(process.hrtime.bigint() - started) / 1e6,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (code !== 0) {
        resolve({ ok: false, error: 'adb_probe_failed', ms });
        return;
      }
      if (ms > 500) {
        resolve({ ok: false, error: 'adb_slow', ms });
        return;
      }
      resolve({ ok: true, ms });
    });
  });
}

function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function evidenceComplete(result) {
  const items = result?.history?.items || [];
  return items.some((item) => item.kind === 'checkpoint')
    && items.some((item) => String(item.kind).startsWith('assertion_'));
}

async function mcpRun(mcp, command, args) {
  const response = await mcp.request('tools/call', {
    name: 'run',
    arguments: { command, arguments: args },
  });
  return payloadOf(response);
}

async function waitForHome(mcp) {
  const deadline = Date.now() + 15_000;
  let lastError = 'home_not_ready';
  while (Date.now() < deadline) {
    const tree = await mcpRun(mcp, 'flutter-tree', TARGET);
    const text = JSON.stringify(tree);
    if (text.includes('设置')) return;
    lastError = tree.error || 'settings_tab_missing';
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`home not ready: ${lastError}`);
}

function createMcpClient() {
  const child = spawn(process.execPath, [MCP_SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AI_APP_BRIDGE_MCP_SURFACE: 'compact' },
  });
  let stdoutBuffer = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    while (true) {
      const marker = stdoutBuffer.indexOf('\n');
      if (marker < 0) break;
      const end = marker > 0 && stdoutBuffer[marker - 1] === 13 ? marker - 1 : marker;
      const line = stdoutBuffer.subarray(0, end).toString('utf8');
      stdoutBuffer = stdoutBuffer.subarray(marker + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  child.on('error', (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  });

  function request(method, params, timeoutMs = MCP_TIMEOUT_MS) {
    const id = nextId;
    nextId += 1;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP timeout ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  }

  return {
    request,
    close() {
      child.kill();
    },
  };
}

function payloadOf(mcpResponse) {
  const text = mcpResponse?.result?.content?.[0]?.text;
  if (!text) throw new Error('MCP script response missing text');
  return JSON.parse(text);
}

async function waitScript(mcp, operationId) {
  const deadline = Date.now() + MCP_TIMEOUT_MS;
  let afterSequence = 0;
  while (Date.now() < deadline) {
    const response = await mcp.request('tools/call', {
      name: 'run',
      arguments: {
        command: 'script',
        arguments: {
          operation: 'wait',
          operationId,
          waitMs: Math.max(1, Math.min(1000, deadline - Date.now())),
          afterSequence,
        },
      },
    });
    const payload = payloadOf(response);
    if (payload.status === 'completed' || payload.status === 'failed' || payload.status === 'cancelled') {
      const status = await mcp.request('tools/call', {
        name: 'run',
        arguments: {
          command: 'script',
          arguments: {
            operation: 'status',
            operationId,
            afterSequence: 0,
          },
        },
      });
      return payloadOf(status);
    }
    afterSequence = payload.eventSequence || afterSequence;
  }
  throw new Error(`script wait timed out ${operationId}`);
}

async function runScript(mcp, operationId, source) {
  const response = await mcp.request('tools/call', {
    name: 'run',
    arguments: {
      command: 'script',
      arguments: {
        operation: 'start',
        operationId,
        script: codeScript(operationId, source),
      },
    },
  });
  const started = payloadOf(response);
  if (started.ok === false) {
    throw new Error(started.error || 'script_start_failed');
  }
  return waitScript(mcp, operationId);
}

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  const probe = await probeAdb();
  if (!probe.ok) {
    const failed = { ok: false, error: probe.error, probeMs: probe.ms, serial: SERIAL };
    fs.writeFileSync(OUT, JSON.stringify(failed, null, 2));
    console.error(JSON.stringify(failed));
    process.exit(1);
  }

  const mcp = createMcpClient();
  await mcp.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'g8-device-speed', version: '0' },
  });
  const continuous = [];
  const stepwise = [];
  const total = WARMUP + OFFICIAL;

  try {
    const launched = await mcpRun(mcp, 'launch-app', {
      ...TARGET,
      activity: 'org.localsend.localsend_app.MainActivity',
    });
    if (launched.ok === false) {
      throw new Error(launched.error || 'launch_app_failed');
    }
    await waitForHome(mcp);
    for (let i = 0; i < total; i += 1) {
      const before = await probeAdb();
      if (!before.ok) throw new Error(`adb ${before.error} ${before.ms}ms before continuous ${i}`);
      const startedAt = process.hrtime.bigint();
      const result = await runScript(mcp, `g8-cont-${i}`, CONTINUOUS_SOURCE);
      const totalMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (result.status !== 'completed') {
        throw new Error(`continuous ${i} ${result.status} ${result.error} ${result.failedStepId}`);
      }
      if (i >= WARMUP) {
        continuous.push({
          trips: 1,
          totalMs,
          ok: result.ok,
          evidenceComplete: evidenceComplete(result),
          timings: result.timings,
          probeMs: before.ms,
        });
      }
      process.stdout.write(`continuous ${i} ${Math.round(totalMs)}ms\n`);
    }

    for (let i = 0; i < total; i += 1) {
      const before = await probeAdb();
      if (!before.ok) throw new Error(`adb ${before.error} ${before.ms}ms before stepwise ${i}`);
      const startedAt = process.hrtime.bigint();
      let trips = 0;
      const tripTimings = [];
      for (const source of stepwiseSources()) {
        trips += 1;
        const result = await runScript(mcp, `g8-step-${i}-${trips}`, source);
        if (result.status !== 'completed') {
          throw new Error(`stepwise ${i}/${trips} ${result.status} ${result.error}`);
        }
        tripTimings.push(result.history || null);
        const kinds = (result.history?.items || []).map((item) => item.kind);
        if (trips === 7 && !kinds.some((kind) => String(kind).startsWith('assertion_'))) {
          throw new Error(`stepwise ${i}/${trips} missing assertion`);
        }
        if (trips === 8 && !kinds.includes('checkpoint')) {
          throw new Error(`stepwise ${i}/${trips} missing checkpoint`);
        }
      }
      const totalMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (i >= WARMUP) {
        stepwise.push({ trips, totalMs, probeMs: before.ms, tripTimings });
      }
      process.stdout.write(`stepwise ${i} ${Math.round(totalMs)}ms trips=${trips}\n`);
    }
  } finally {
    mcp.close();
  }

  const after = await probeAdb();
  const contP50 = percentile(continuous.map((item) => item.totalMs), 50);
  const stepP50 = percentile(stepwise.map((item) => item.totalMs), 50);
  const contP95 = percentile(continuous.map((item) => item.totalMs), 95);
  const stepP95 = percentile(stepwise.map((item) => item.totalMs), 95);
  const tripDrop = 1 - (continuous[0].trips / stepwise[0].trips);
  const report = {
    ok: true,
    protocol: 'mcp-run',
    serial: SERIAL,
    packageName: PACKAGE,
    warmup: WARMUP,
    official: OFFICIAL,
    continuousTrips: continuous[0].trips,
    stepwiseTrips: stepwise[0].trips,
    tripDrop,
    contP50,
    stepP50,
    contP95,
    stepP95,
    p50Drop: 1 - (contP50 / stepP50),
    p95Drop: 1 - (contP95 / stepP95),
    evidenceComplete: continuous.every((item) => item.evidenceComplete) ? 1 : 0,
    successRate: {
      continuous: continuous.filter((item) => item.ok).length / continuous.length,
      stepwise: stepwise.length / OFFICIAL,
    },
    continuousTimings: continuous.map((item) => item.timings),
    probeAfter: after,
    gates: {
      tripDrop: tripDrop >= 0.8,
      p50: contP50 <= stepP50 * 0.7,
      p95: contP95 <= stepP95 * 0.8,
      evidence: continuous.every((item) => item.evidenceComplete),
      probe: after.ok === true,
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!Object.values(report.gates).every(Boolean)) process.exit(1);
}

main().catch((error) => {
  fs.writeFileSync(OUT, JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
  console.error(error);
  process.exit(1);
});
