'use strict';

const { createFakeHostPort } = require('../bin/script/fake-host-port');
const { executionSleep } = require('../bin/shared-kernel/execution-scope');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createChildRuntimeAdapter } = require('../bin/script/node-runtime-adapter');
const {
  createPythonRuntimeAdapter,
  inspectPython,
  resetPythonDetection,
} = require('../bin/script/python-runtime-adapter');
const { createTestScriptSupervisor: createScriptSupervisor } = require('./helpers/script-supervisor');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');

function spec(overrides = {}) {
  return {
    schemaVersion: 'aab.code-script/v1',
    name: 'p3',
    language: overrides.language || 'javascript',
    source: overrides.source,
    target: { platform: 'android', serial: 'serial-1', packageName: 'com.example.app' },
    inputs: overrides.inputs || { n: 3 },
    ...(overrides.permissions === undefined ? {} : { permissions: overrides.permissions }),
    ...(overrides.policy === undefined ? {} : { policy: overrides.policy }),
  };
}

const JS_SOURCE = `
async function main(ctx) {
  let total = 0;
  for (let i = 1; i <= ctx.inputs.n; i += 1) total += i;
  if (total !== 6) throw new Error('loop');
  const network = await ctx.call('network', {});
  const verdict = await ctx.assert({
    name: 'ok',
    condition: network.result.items[0].statusCode === 200,
    evidence: network.evidence,
    requireCoverage: 'complete',
  });
  return { passed: verdict.verdict === 'passed', total };
}
module.exports = { main };
`;

const PY_SOURCE = `
def main(ctx):
    total = 0
    for i in range(1, ctx.inputs["n"] + 1):
        total += i
    if total != 6:
        raise Exception("loop")
    network = ctx.call("network", {})
    verdict = ctx.assert_({
        "name": "ok",
        "condition": network["result"]["items"][0]["statusCode"] == 200,
        "evidence": network["evidence"],
        "requireCoverage": "complete",
    })
    return {"passed": verdict["verdict"] == "passed", "total": total}
`;

const JS_SYNC_SOURCE = `
function main() {
  return { passed: true, mode: 'sync' };
}
module.exports = { main };
`;

const PY_ASYNC_SOURCE = `
import asyncio

async def main(ctx):
    await asyncio.sleep(0)
    return {"passed": True, "mode": "async"}
`;

const PY_THROW_SOURCE = `
def main(ctx):
    raise Exception("boom")
`;

const JS_EMPTY_SOURCE = `
async function main() { return { ok: true }; }
module.exports = { main };
`;

const PY_EMPTY_SOURCE = `
def main(ctx):
    return {"ok": True}
`;

const JS_RPC_SOURCE = `
async function main(ctx) {
  const times = [];
  for (let i = 0; i < 20; i += 1) {
    const start = process.hrtime.bigint();
    await ctx.call('network', {});
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return { times };
}
module.exports = { main };
`;

function handlers() {
  return {
    network: async (request) => captureFixture(request, 'network', [{ statusCode: 200 }]),
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
  return supervisor.handle({ operation: 'status', operationId });
}

test('P3 JavaScript child runs branches, loops, and async main', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec({ source: JS_SOURCE }),
    handlers: handlers(),
  });
  assert.equal(started.ok, true);
  const done = await waitDone(supervisor, started.operationId);
  assert.equal(done.status, 'completed');
});

test('P3 JavaScript sync main and Python exceptions run', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const syncStarted = await supervisor.handle({
    operation: 'start',
    script: spec({ source: JS_SYNC_SOURCE }),
  });
  const syncDone = await waitDone(supervisor, syncStarted.operationId);
  assert.equal(syncDone.status, 'completed');
  const pyStarted = await supervisor.handle({
    operation: 'start',
    script: spec({ language: 'python', source: PY_THROW_SOURCE }),
  });
  const pyDone = await waitDone(supervisor, pyStarted.operationId);
  assert.equal(pyDone.status, 'failed');
  assert.equal(pyDone.error, 'boom');
});

test('P3 JavaScript child exceptions become execution failure', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec({
      source: 'async function main() { throw new Error("boom"); }\nmodule.exports = { main };',
    }),
  });
  const done = await waitDone(supervisor, started.operationId);
  assert.equal(done.status, 'failed');
  assert.equal(done.error, 'boom');
});

test('P3 Python sync and async mains run', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const syncStarted = await supervisor.handle({
    operation: 'start',
    script: spec({ language: 'python', source: PY_SOURCE }),
    handlers: handlers(),
  });
  assert.equal(syncStarted.ok, true);
  const syncDone = await waitDone(supervisor, syncStarted.operationId);
  assert.equal(syncDone.status, 'completed');
  const asyncStarted = await supervisor.handle({
    operation: 'start',
    script: spec({ language: 'python', source: PY_ASYNC_SOURCE }),
  });
  const asyncDone = await waitDone(supervisor, asyncStarted.operationId);
  assert.equal(asyncDone.status, 'completed');
});

test('P3 missing Python does not block JavaScript', async () => {
  const supervisor = createScriptSupervisor({
    createHost: createFakeHostPort,
    createRuntime(opts) {
      if (opts.language === 'python') {
        return createPythonRuntimeAdapter({ resolvePython: () => null });
      }
      return undefined;
    },
  });
  const missing = await supervisor.handle({
    operation: 'start',
    script: spec({ language: 'python', source: PY_SOURCE }),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'runtime_unavailable');
  const js = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await js.handle({
    operation: 'start',
    script: spec({ source: JS_SOURCE }),
    handlers: handlers(),
  });
  const done = await waitDone(js, started.operationId);
  assert.equal(done.status, 'completed');
});

test('P3 child crash stays off Legacy and Intent modules', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec({
      source: 'async function main() { process.exit(2); }\nmodule.exports = { main };',
    }),
  });
  const done = await waitDone(supervisor, started.operationId);
  assert.equal(done.status, 'failed');
  assert.equal(done.error, 'child_crashed');
  const thrown = createScriptSupervisor({
    createHost: createFakeHostPort,
    createRuntime: () => ({
      kind: 'javascript',
      async start() {
        throw new Error('runtime-start-rejected');
      },
    }),
  });
  const thrownStart = await thrown.handle({
    operation: 'start',
    script: spec({ source: 'module.exports = { main() {} };' }),
  });
  assert.equal(thrownStart.status, 'running');
  const thrownDone = await waitDone(thrown, thrownStart.operationId);
  assert.equal(thrownDone.status, 'failed');
  assert.equal(thrownDone.error, 'child_crashed');
  let stops = 0;
  const rejected = createScriptSupervisor({
    createHost: createFakeHostPort,
    createRuntime: () => ({
      kind: 'javascript',
      start() {
        return Promise.reject(new Error('rpc-rejected'));
      },
      stop() {
        stops += 1;
      },
    }),
  });
  const rejectedStart = await rejected.handle({
    operation: 'start',
    script: spec({ source: 'module.exports = { main() {} };' }),
  });
  const rejectedDone = await waitDone(rejected, rejectedStart.operationId);
  assert.equal(rejectedDone.status, 'failed');
  assert.equal(rejectedDone.error, 'child_crashed');
  assert.equal(stops >= 1, true);
  const handlerReject = createScriptSupervisor({ createHost: createFakeHostPort });
  const handlerStarted = await handlerReject.handle({
    operation: 'start',
    script: spec({
      source: 'async function main(ctx) { const result = await ctx.call("network", {}); if (!result.ok) throw new Error(result.error); }\nmodule.exports = { main };',
    }),
    handlers: {
      network: async () => {
        throw new Error('handler-reject');
      },
    },
  });
  const handlerDone = await waitDone(handlerReject, handlerStarted.operationId);
  assert.equal(handlerDone.status, 'failed');
  assert.equal(handlerDone.error, 'handler-reject');
  const files = [
    'node-runtime-adapter.js',
    'python-runtime-adapter.js',
    'script-session-channel.js',
    'script-sdk.js',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '../bin/script', file), 'utf8');
    assert.equal(/intent\/|legacy\/|runBatch|runBridgeChecked|mcp-server/.test(source), false, file);
  }
});

test('P3 pythonPath is not trapped by the inspect cache', async () => {
  resetPythonDetection();
  const first = inspectPython();
  assert.equal(first.available, true);
  const hook = createPythonRuntimeAdapter({ resolvePython: () => null });
  assert.equal(hook.unavailable, true);
  const missingPath = createPythonRuntimeAdapter({ pythonPath: '/definitely/missing-python' });
  assert.equal(Boolean(missingPath.unavailable), false);
  assert.equal(missingPath.kind, 'python');
  const echo = inspectPython({ pythonPath: '/bin/echo' });
  assert.equal(echo.available, true);
  assert.notEqual(echo.executable, '/bin/echo');
});

test('P3 malformed child stdout and pre-ready exit stay on the Host', async () => {
  const host = { call: async () => ({}), assert: async () => ({}) };
  const agent = { askAgent: async () => ({}) };
  const specShape = {
    source: '',
    inputs: {},
    entrypoint: 'main',
    policy: { timeoutMs: 3000, maxOutputBytes: 1024, maxProgressBytes: 1024 },
  };
  const malformed = createChildRuntimeAdapter({
    kind: 'javascript',
    executable: process.execPath,
    argsPrefix: ['-e', 'process.stdout.write("not-json\\n");'],
    sdkFile: 'script-sdk.js',
    extension: '.js',
  });
  const malformedResult = await malformed.start({
    spec: specShape,
    host,
    agent,
    emit() {},
    control: () => ({ status: 'running' }),
  });
  assert.equal(malformedResult.ok, false);
  assert.equal(malformedResult.error, 'child_crashed');
  const nullFrame = createChildRuntimeAdapter({
    kind: 'javascript',
    executable: process.execPath,
    argsPrefix: ['-e', 'process.stdout.write("null\\n");'],
    sdkFile: 'script-sdk.js',
    extension: '.js',
  });
  const nullFrameResult = await nullFrame.start({
    spec: specShape,
    host,
    agent,
    emit() {},
    control: () => ({ status: 'running' }),
  });
  assert.equal(nullFrameResult.ok, false);
  assert.equal(nullFrameResult.error, 'child_crashed');
  const exited = createChildRuntimeAdapter({
    kind: 'javascript',
    executable: process.execPath,
    argsPrefix: ['-e', 'process.exit(2)'],
    sdkFile: 'script-sdk.js',
    extension: '.js',
  });
  const exitedResult = await exited.start({
    spec: specShape,
    host,
    agent,
    emit() {},
    control: () => ({ status: 'running' }),
  });
  assert.equal(exitedResult.ok, false);
  assert.equal(exitedResult.error, 'child_crashed');
  const hungReady = createChildRuntimeAdapter({
    kind: 'javascript',
    executable: process.execPath,
    argsPrefix: ['-e', 'setInterval(() => {}, 1000);'],
    sdkFile: 'script-sdk.js',
    extension: '.js',
  });
  const hungReadyResult = await hungReady.start({
    spec: { ...specShape, policy: { timeoutMs: 200, maxOutputBytes: 1024, maxProgressBytes: 1024 } },
    host,
    agent,
    emit() {},
    control: () => ({ status: 'running' }),
  });
  assert.equal(hungReadyResult.ok, false);
  assert.equal(hungReadyResult.error, 'timeout');
  const hungRpc = createScriptSupervisor({ createHost: createFakeHostPort });
  const hungStarted = await hungRpc.handle({
    operation: 'start',
    script: spec({
      source: JS_RPC_SOURCE,
      policy: { timeoutMs: 200 },
    }),
    handlers: { network: () => executionSleep(10000) },
  });
  const hungDone = await waitDone(hungRpc, hungStarted.operationId, 2000);
  assert.equal(hungDone.status, 'failed');
  assert.equal(hungDone.error, 'timeout');
});

test('P3 handshake and empty RPC stay within the published budgets', async () => {
  const handshake = [];
  for (let i = 0; i < 8; i += 1) {
    const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
    const startedAt = Date.now();
    const started = await supervisor.handle({
      operation: 'start',
      script: spec({ source: JS_EMPTY_SOURCE }),
    });
    let afterSequence = 0;
    let childStartedAt = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && childStartedAt == null) {
      const snapshot = await supervisor.handle({
        operation: 'wait',
        operationId: started.operationId,
        waitMs: 50,
        afterSequence,
      });
      if (snapshot.events.some((event) => event.type === 'child_started')) {
        childStartedAt = Date.now();
      }
      afterSequence = snapshot.eventSequence;
    }
    assert.equal(childStartedAt != null, true);
    handshake.push(childStartedAt - startedAt);
    const done = await waitDone(supervisor, started.operationId);
    assert.equal(done.status, 'completed');
  }
  handshake.sort((a, b) => a - b);
  assert.equal(handshake[Math.ceil(handshake.length * 0.95) - 1] <= 150, true, String(handshake));
  const pythonHandshake = [];
  for (let i = 0; i < 8; i += 1) {
    const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
    const startedAt = Date.now();
    const started = await supervisor.handle({
      operation: 'start',
      script: spec({ language: 'python', source: PY_EMPTY_SOURCE }),
    });
    let afterSequence = 0;
    let childStartedAt = null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && childStartedAt == null) {
      const snapshot = await supervisor.handle({
        operation: 'wait',
        operationId: started.operationId,
        waitMs: 50,
        afterSequence,
      });
      if (snapshot.events.some((event) => event.type === 'child_started')) {
        childStartedAt = Date.now();
      }
      afterSequence = snapshot.eventSequence;
    }
    assert.equal(childStartedAt != null, true);
    pythonHandshake.push(childStartedAt - startedAt);
    const done = await waitDone(supervisor, started.operationId);
    assert.equal(done.status, 'completed');
  }
  pythonHandshake.sort((a, b) => a - b);
  assert.equal(
    pythonHandshake[Math.ceil(pythonHandshake.length * 0.95) - 1] <= 300,
    true,
    String(pythonHandshake),
  );
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const started = await supervisor.handle({
    operation: 'start',
    script: spec({ source: JS_RPC_SOURCE }),
    store,
    handlers: { network: async () => ({ ok: true }) },
  });
  const done = await waitDone(supervisor, started.operationId);
  assert.equal(done.status, 'completed');
  const snapshot = await supervisor.handle({
    operation: 'status',
    operationId: started.operationId,
    afterSequence: 0,
    eventLimit: 256,
  });
  await supervisor.registry.get(started.operationId).running;
  const completed = await supervisor.handle({ operation: 'result', operationId: started.operationId, store });
  assert.equal(completed.ok, true, JSON.stringify(completed));
  const times = [...completed.result.times].slice(5).sort((a, b) => a - b);
  assert.equal(times[Math.ceil(times.length * 0.95) - 1] <= 10, true, String(times));
});

function captureFixture(request, stream, items) {
  const runtimeEpoch = 'test-epoch';
  const targetKey = request.packageName || 'test-target';
  return {
    ok: true, items,
    coverage: { status: 'complete', gap: false, committed: true },
    refs: [{ stream, mobileFactId: 'test-fact', runtimeEpoch, targetKey }],
    runtimeEpoch, targetKey, watermarkCursor: 'test-watermark',
    window: {
      afterActionId: request.afterActionId ?? null, factCursor: request.factCursor ?? null,
      sinceId: request.sinceId ?? null, sinceMs: request.sinceMs ?? null,
      runtimeEpoch, targetKey, filterApplied: true,
    },
  };
}
