'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAdbHttpFixture } = require('../test-support/adb-http-fixture');
const { executeCommand } = require('../bin/ai-app-bridge');
const { createLiveCaptureQuery } = require('../bin/shared-kernel/live-capture-query');
const { createScriptCapturePort } = require('../bin/script/script-capture-port');
const { createIntentCapturePort } = require('../bin/intent/intent-capture-port');

async function endpoint(t, serial = 'wire-test') {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const query = Object.fromEntries(url.searchParams);
    requests.push({ path: url.pathname, query });
    const stream = url.pathname.split('/').pop();
    const items = [{ id: 12, statusCode: 200, url: '/wanted' }, { id: 13, statusCode: 500, url: '/unrelated' }];
    // Exercise the real CLI HTTP path. Old SDK JSON cannot satisfy the new query.
    const payload = { ok: true, items };
    if (query.view) Object.assign(payload, {
      coverage: { status: 'complete', gap: false, committed: true },
      refs: items.map((item) => ({ mobileFactId: `mf2:${stream}:${item.id}`, stream, captureId: item.id, runtimeEpoch: 'epoch-1', targetKey: 'pkg' })),
      runtimeEpoch: 'epoch-1', targetKey: 'pkg', storeGeneration: 4,
      hasMore: false, nextCursor: null, watermarkCursor: 'cf2:end', throughWatermark: 13,
      window: { ...query, runtimeEpoch: 'epoch-1', filterApplied: true },
    });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-capture-wire-'));
  const adb = createAdbHttpFixture({ directory, serial, port });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { requests, port, adb };
}

test('Script -> live query -> Android CLI -> HTTP preserves the actual durable window', async (t) => {
  const { requests, port, adb } = await endpoint(t);
  const capture = createScriptCapturePort({ query: createLiveCaptureQuery({ runner: executeCommand }) });
  const result = await capture.query('network', {
    adb, serial: 'wire-test', packageName: 'pkg', port,
    runtimeEpoch: 'epoch-1', sinceId: 11, sinceMs: 123, factCursor: 'cf2:start',
    targetKey: 'pkg', afterActionId: 'action-7', limit: 17, urlFilter: '/wanted',
  });
  assert.equal(result.coverage.status, 'complete');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { path: '/v1/network', query: {
    sinceId: '11', sinceMs: '123', limit: '17', view: 'decision-window',
    runtimeEpoch: 'epoch-1', afterActionId: 'action-7', factCursor: 'cf2:start', targetKey: 'pkg',
  } });
  assert.equal(result.window.filterApplied, true);
  assert.equal(result.window.factCursor, 'cf2:start');
  assert.equal(result.watermarkCursor, 'cf2:end');
  assert.equal(result.storeGeneration, 4);
  assert.equal(result.items.length, 1);
  assert.equal(result.refs.length, 1);
  assert.equal(result.refs[0].captureId, result.items[0].id);
});

test('Script iOS capture stays on iOS HTTP and keeps ref lookup metadata', async (t) => {
  const { requests, port } = await endpoint(t);
  const capture = createScriptCapturePort({ query: createLiveCaptureQuery({ runner: executeCommand }) });
  const result = await capture.query('ios-events', {
    runtimeUrl: `http://127.0.0.1:${port}`, bundleId: 'pkg', deviceId: 'iphone-wire',
    history: true, mobileFactId: 'mf2:events:12', limit: 1,
  });
  assert.equal(result.coverage.status, 'complete');
  assert.equal(requests[0].path, '/v1/events');
  assert.equal(requests[0].query.view, 'connected-history');
  assert.equal(requests[0].query.mobileFactId, 'mf2:events:12');
  assert.equal(result.runtimeEpoch, 'epoch-1');
});

test('Intent capture retains target and connected-history cursors through HTTP', async (t) => {
  const { requests, port, adb } = await endpoint(t, 'intent-wire');
  const capture = createIntentCapturePort({ query: createLiveCaptureQuery({ runner: executeCommand }) });
  const result = await capture.observe({ stream: 'state', view: 'connected-history', factCursor: 'cf2:start' }, {
    target: { adb, port, serial: 'intent-wire', packageName: 'pkg' },
  });
  assert.equal(result.coverage.status, 'complete');
  assert.equal(requests[0].path, '/v1/state');
  assert.equal(requests[0].query.factCursor, 'cf2:start');
  assert.equal(result.watermarkCursor, 'cf2:end');
});

test('live capture preserves failure reason and rejects a stale epoch response', async () => {
  const query = createLiveCaptureQuery({ runner: async () => {
    throw Object.assign(new Error('device gone'), { code: 'target_disconnected' });
  } });
  const disconnected = await query({ stream: 'events', view: 'decision-window' });
  assert.equal(disconnected.coverage.status, 'unavailable');
  assert.equal(disconnected.error, 'target_disconnected');
  const stale = await createLiveCaptureQuery({ runner: async () => ({
    ok: true, coverage: { status: 'complete', gap: false, committed: true },
    runtimeEpoch: 'old', refs: [], items: [],
  }) })({ stream: 'events', view: 'decision-window', runtimeEpoch: 'new' });
  assert.equal(stale.coverage.status, 'unavailable');
  assert.equal(stale.error, 'runtime_epoch_changed');
});

test('normal MCP Intent entry injects live capture and carries its watermark into the next observation', async (t) => {
  const { requests, port, adb } = await endpoint(t, 'mcp-wire');
  const previousCaptureSetting = process.env.AI_APP_BRIDGE_FACT_CACHE;
  process.env.AI_APP_BRIDGE_FACT_CACHE = 'off';
  t.after(() => {
    if (previousCaptureSetting === undefined) delete process.env.AI_APP_BRIDGE_FACT_CACHE;
    else process.env.AI_APP_BRIDGE_FACT_CACHE = previousCaptureSetting;
  });
  const { runGeneric } = require('../bin/mcp-server');
  const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
  const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
  const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const adapter = {
    observe: async () => ({ ok: true, rawTreeId: 'wire-tree', rawTree: {
      root: { id: 'home', className: 'Button', text: 'Home', clickable: true, children: [] },
    } }),
    action: async () => ({ ok: true, mechanicalStatus: 'ok' }),
  };
  const start = JSON.parse((await runGeneric({ command: 'intent', arguments: {
    operation: 'start', operationId: 'capture-mcp-wire', goal: 'inspect capture',
    target: { adb, serial: 'mcp-wire', packageName: 'pkg', port },
    adapter, store,
    require: { stream: 'network' },
  } })).content[0].text);
  assert.equal(start.status, 'waiting_for_decision', JSON.stringify(start));
  assert.equal(start.capture.coverage.status, 'complete');
  assert.equal(start.capture.pages[0].watermarkCursor, 'cf2:end');
  const after = JSON.parse((await runGeneric({ command: 'intent', arguments: {
    operation: 'decide', operationId: start.operationId, store,
    decision: { decisionId: 'click', agentDecision: 'act', basedOnRevision: start.revision, action: { action: 'tap', text: 'Home' } },
  } })).content[0].text);
  assert.equal(after.status, 'waiting_for_decision');
  assert.equal(requests[1].query.factCursor, 'cf2:end');
  assert.equal(requests[1].query.runtimeEpoch, 'epoch-1');
  assert.equal(after.capture.pages[0].window.filterApplied, true);
  const status = JSON.parse((await runGeneric({ command: 'intent', arguments: {
    operation: 'status', operationId: start.operationId, store,
  } })).content[0].text);
  const record = status.history.items.filter((item) => item.kind === 'observation').at(-1);
  assert.equal(record.payloadSummary.capturePages[0].window.factCursor, 'cf2:end');
  assert.equal(Object.hasOwn(record.payloadSummary.capturePages[0], 'items'), false);
});

test('capture requirements cannot replace an Intent target or dispatch an action through a read port', async () => {
  let calls = 0;
  const capture = createIntentCapturePort({ query: createLiveCaptureQuery({ runner: async () => { calls += 1; } }) });
  const replaced = await capture.observe({ stream: 'network', serial: 'other', packageName: 'other.pkg' }, {
    target: { serial: 'locked', packageName: 'locked.pkg' },
  });
  assert.equal(replaced.error, 'capture_target_mismatch');
  const mutation = await capture.observe({ stream: 'network', command: 'tap' }, {
    target: { serial: 'locked', packageName: 'locked.pkg' },
  });
  assert.equal(mutation.error, 'unsupported_capture_stream');
  assert.equal(calls, 0);
  const mismatch = await createLiveCaptureQuery({ runner: async () => ({
    ok: true, targetKey: 'other.pkg', refs: [], items: [],
    coverage: { status: 'complete', gap: false, committed: true },
  }) })({ stream: 'network', packageName: 'locked.pkg' });
  assert.equal(mismatch.error, 'capture_target_mismatch');
});
