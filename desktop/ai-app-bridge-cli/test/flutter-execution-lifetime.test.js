'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { executeFlutterAction, schema } = require('../bin/shared-kernel/flutter-execution');
const { runExecution, currentExecution, executionSleep } = require('../bin/shared-kernel/execution-scope');
const { httpRequestBounded } = require('../bin/shared-kernel/execution-io');

const tree = { executionSchema: schema, runtimeEpoch: 'runtime-A' };
const identity = { actionId: 'action-A', runtimeEpoch: 'runtime-A' };
const terminal = (changes = {}) => ({ ok: false, error: 'flutter_action_cancelled', dispatched: true, ambiguous: false,
  ...identity, settled: true, execution: { schemaVersion: schema, ...identity, settled: true }, ...changes });
const cancelled = result => ({ ok: true, ...identity, executionResult: result });
function call(deps = {}) {
  return executeFlutterAction({ tree, payload: { action: 'back' }, actionId: identity.actionId, timeoutMs: 10000,
    send: async () => terminal({ ok: true }), cancel: async () => { assert.fail('unexpected cancellation'); }, ...deps });
}

test('the native timeout consumes the same Host budget after preparation', async () => {
  await runExecution({ timeoutMs: 250 }, async () => {
    await executionSleep(30);
    const remaining = currentExecution().deadlineMs - Date.now();
    const result = await call({ send: async request => {
      assert.equal(request.execution.schemaVersion, schema);
      assert.equal(request.execution.actionId, request.actionId);
      assert.ok(request.execution.timeoutMs <= remaining && request.execution.timeoutMs < 250);
      return terminal({ ok: true });
    } });
    assert.equal(result.ok, true);
  });
});

test('a missing execution capability rejects even coordinate actions before sending', async () => {
  const result = await call({ tree: { runtimeEpoch: tree.runtimeEpoch }, send: () => assert.fail('old SDK dispatched') });
  assert.equal(result.error, 'flutter_execution_unavailable');
  assert.equal(result.dispatched, false);
});

test('only a matching terminal receipt can settle a lost response', async () => {
  let sent = 0; let cleaned = 0;
  const result = await call({ send: async () => { sent++; throw Object.assign(new Error('lost'), { code: 'ECONNRESET' }); },
    cancel: async received => { cleaned++; assert.deepEqual(received, identity); return cancelled(terminal()); } });
  assert.equal(sent, 1); assert.equal(cleaned, 1);
  assert.equal(result.error, 'ECONNRESET'); assert.equal(result.settled, true);
  assert.equal(result.dispatched, true); assert.equal(result.ambiguous, false);
});

test('a queued cancellation proves no dispatch and a lost completed response preserves its effects', async () => {
  for (const receipt of [terminal({ dispatched: false }), terminal({ ok: true })]) {
    const result = await call({ send: async () => { throw new Error('lost'); }, cancel: async () => cancelled(receipt) });
    assert.equal(result.ok, false); assert.equal(result.settled, true);
    assert.equal(result.dispatched, receipt.dispatched);
    assert.equal(result.cancellation.executionResult.ok, receipt.ok);
  }
});

test('signal acknowledgement, stale runtime, and malformed receipts remain uncertain', async () => {
  for (const cancellation of [
    { ok: true, ...identity, settled: false },
    cancelled(terminal({ execution: { schemaVersion: schema, ...identity, settled: false } })),
    { ...cancelled(terminal()), runtimeEpoch: 'other' },
    cancelled(terminal({ dispatched: null })), cancelled(terminal({ ok: true, ambiguous: true })),
    { ok: false, error: 'flutter_action_cancel_pending', settled: false },
    { ok: false, error: 'flutter_action_not_active' },
  ]) {
    const result = await call({ send: async () => { throw new Error('lost'); }, cancel: async () => cancellation });
    assert.equal(result.settled, false); assert.equal(result.dispatched, null); assert.equal(result.ambiguous, true);
  }
});

test('a malformed success is cleaned up once, never replayed or accepted', async () => {
  let count = 0;
  const result = await call({ send: async () => { count++; return { ok: true }; }, cancel: async () => cancelled(terminal()) });
  assert.equal(result.error, 'invalid_flutter_execution_receipt'); assert.equal(result.settled, true); assert.equal(count, 1);
});

test('an HTTP failure before dispatch needs no remote cancellation', async () => {
  const result = await call({ send: async () => { throw Object.assign(new Error('not sent'), { code: 'deadline_exceeded', dispatched: false }); } });
  assert.equal(result.dispatched, false); assert.equal(result.ambiguous, false);
});

test('native admission rejection stays a known no-dispatch result', async () => {
  const result = await call({ send: async () => ({ ok: false, error: 'flutter_action_busy', dispatched: false, ambiguous: false }) });
  assert.equal(result.error, 'flutter_action_busy'); assert.equal(result.dispatched, false);
});

test('a valid unsettled native timeout preserves its error without claiming completion', async () => {
  const pending = { schemaVersion: schema, ...identity, ok: false, error: 'flutter_action_timeout',
    settled: false, dispatched: null, ambiguous: true };
  const result = await call({ send: async () => pending,
    cancel: async () => ({ ...pending, error: 'flutter_action_cancel_pending' }) });
  assert.equal(result.error, 'flutter_action_timeout');
  assert.equal(result.settled, false); assert.equal(result.dispatched, null); assert.equal(result.ambiguous, true);
});

test('deadline closes HTTP then cancellation uses a separate budget on the same peer', async t => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, body: JSON.parse(body) });
    if (request.url === '/action') return;
    assert.equal(request.url, '/cancel');
    response.end(JSON.stringify(cancelled(terminal())));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = await runExecution({ timeoutMs: 120, mutation: true }, () => call({
    send: async request => JSON.parse(await httpRequestBounded(`${base}/action`, { method: 'POST', payload: request, timeoutMs: 10000 })),
    cancel: async request => {
      assert.equal(currentExecution(), undefined);
      return JSON.parse(await httpRequestBounded(`${base}/cancel`, { method: 'POST', payload: request, timeoutMs: 1000 }));
    },
  }));
  assert.equal(result.error, 'deadline_exceeded'); assert.equal(result.settled, true); assert.equal(result.ambiguous, false);
  assert.deepEqual(requests.map(r => r.path), ['/action', '/cancel']);
  assert.deepEqual(requests[1].body, identity);
});
