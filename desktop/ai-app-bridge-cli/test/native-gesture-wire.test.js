'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { nativeGesture, gestureNative, createBridgeContext } = require('../bin/device-provider');
const { validateCommandArguments, parseCliOptions, commandContract } = require('../bin/command-registry');
const { runExecution, currentExecution } = require('../bin/shared-kernel/execution-scope');
const { createAdbHttpFixture } = require('../test-support/adb-http-fixture');
const { nativeTargetRef, nativeRuntimeStatus, nativeBridgeStatus: bridgeStatus, nativeExecutionReceipt } = require('../test-support/native-target-fixture');

const context = { serial: 'gesture-test', packageName: 'example.gesture', explicitPackageName: true, httpTimeoutMs: 5000 };
const foregroundWindow = async () => ({ ok: true, packageName: context.packageName });
const payload = { selector: { text: 'Note' }, targetRef: nativeTargetRef(), action: 'longPress', actionId: 'action-1', durationMs: 600 };
const managedPayload = (source, timeoutMs) => ({ ...source, execution: { schemaVersion: 'aab.native-execution/v1', actionId: source.actionId, runtimeEpoch: 'fixture-epoch', timeoutMs } });
const cancellation = dispatched => ({ ok: true, actionId: payload.actionId, runtimeEpoch: payload.targetRef.runtimeEpoch,
  executionResult: nativeExecutionReceipt(managedPayload(payload, 4100), { ok: false, error: 'native_action_cancelled', dispatched }) });

test('the shared native-gesture command exposes the same strict gesture schema to MCP, CLI and Script', () => {
  const command = commandContract('native-gesture');
  assert.deepEqual(command.entrypoints, { mcp: true, cli: true, script: true });
  assert.equal(command.script.permission, 'app.interact'); assert.equal(command.execution.mutation, true);
  const spec = { action: 'longPress', selector: { text: 'Note' }, durationMs: 600 };
  const target = { serial: context.serial, packageName: context.packageName };
  assert.deepEqual(validateCommandArguments('native-gesture', parseCliOptions('native-gesture', { ...target, payload: JSON.stringify(spec) })), { ...target, payload: spec });
  for (const extra of [{ actionId: 'forged' }, { targetRef: payload.targetRef }, { deltaX: 10 }, { durationMs: '600' }, { durationMs: 499 }]) {
    assert.throws(() => validateCommandArguments('native-gesture', { ...target, payload: { ...spec, ...extra } }));
  }
  assert.throws(() => validateCommandArguments('native-gesture', { serial: target.serial, port: 18080, payload: spec }), { code: 'missing_argument', field: 'packageName' });
});

test('Script and direct gestures select a fresh SDK reference and preserve the caller action ID', async () => {
  const spec = { action: 'scroll', selector: { resourceName: 'id/list' }, direction: 'down' };
  const node = { resourceName: 'id/list', targetRef: payload.targetRef, visible: true, enabled: true,
    bounds: { left: 0, top: 0, right: 100, bottom: 100 } };
  let dispatched = 0;
  const deps = { foregroundWindow, bridgeStatus, bridgeTree: async () => ({ root: node }), bridgePost: async (_ctx, endpoint, body) => {
    dispatched++; assert.equal(endpoint, '/v1/action/gesture-target');
    assert.deepEqual(body, managedPayload({ ...spec, targetRef: payload.targetRef, durationMs: 400, actionId: 'script:call:1' }, 3900));
    return nativeExecutionReceipt(body);
  } };
  assert.equal((await gestureNative(context, spec, { requestId: 'script:call:1' }, deps)).ok, true);
  delete node.targetRef;
  assert.equal((await gestureNative(context, spec, {}, deps)).error, 'native_atomic_target_unavailable');
  assert.equal(dispatched, 1);
});

test('Native gestures send one bound SDK request with no Host coordinates', async () => {
  const calls = [];
  const result = await nativeGesture(context, payload, { foregroundWindow, bridgeStatus, bridgePost: async (ctx, endpoint, body) => {
    assert.equal(ctx.httpTimeoutMs, 4100); calls.push({ endpoint, body });
    return nativeExecutionReceipt(body);
  } });
  assert.equal(result.ok, true); assert.equal(result.transport, 'bridge');
  assert.deepEqual(calls, [{ endpoint: '/v1/action/gesture-target', body: managedPayload(payload, 4100) }]);
});

test('device scope, a different foreground, and pre-dispatch cancellation never send a gesture or cleanup', async () => {
  const forbidden = () => assert.fail('unexpected dispatch');
  assert.equal((await nativeGesture({ ...context, explicitPackageName: false }, payload, { foregroundWindow: forbidden })).error, 'native_target_requires_app_scope');
  assert.equal((await nativeGesture(context, payload, { foregroundWindow: async () => ({ ok: true, packageName: 'other.app' }), bridgePost: forbidden })).error, 'foreground_package_mismatch');
  const result = await nativeGesture(context, payload, { foregroundWindow, bridgeStatus, cancelBridgePost: forbidden,
    bridgePost: async () => { throw Object.assign(new Error('Stopped before POST'), { code: 'cancelled', dispatched: false, aiAppBridgeRequestNotStarted: true }); } });
  assert.equal(result.error, 'cancelled'); assert.equal(result.dispatched, false); assert.equal(result.ambiguous, false);
});

test('a typed pre-dispatch transport failure cannot cause a retry or cancellation', async () => {
  for (const error of [Object.assign(new Error('No endpoint'), { code: 'endpoint_unavailable', dispatched: false }), Object.assign(new Error('No forward'), { aiAppBridgeRequestNotStarted: true })]) {
    let calls = 0;
    const result = await nativeGesture(context, payload, { foregroundWindow, bridgeStatus, bridgePost: async () => { calls++; throw error; },
      cancelBridgePost: () => assert.fail('nothing was dispatched') });
    assert.equal(calls, 1); assert.equal(result.error, error.code || 'native_request_not_started'); assert.equal(result.dispatched, false);
  }
});

test('a rejected SDK target is returned directly and never re-executed', async () => {
  const rejected = { ok: false, error: 'native_target_replaced', dispatched: false, ambiguous: false };
  const result = await nativeGesture(context, payload, { foregroundWindow, bridgeStatus, bridgePost: async () => rejected,
    cancelBridgePost: () => assert.fail('no active gesture') });
  assert.equal(result.error, rejected.error); assert.equal(result.dispatched, false); assert.equal(result.executionReceipt.dispatched, false);
});

for (const dispatched of [false, true]) test(`HTTP abort waits for scoped SDK cancellation (DOWN delivered: ${dispatched})`, { timeout: 8000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-gesture-wire-'));
  const requests = [];
  let arrived, cancelArrived, acknowledge;
  const ready = new Promise(resolve => { arrived = resolve; });
  const cancelling = new Promise(resolve => { cancelArrived = resolve; });
  const server = http.createServer(async (request, response) => {
    if (request.url === '/v1/status') { response.end(JSON.stringify(nativeRuntimeStatus(context.packageName))); return; }
    let text = ''; for await (const part of request) text += part;
    const body = JSON.parse(text); requests.push({ path: request.url, body });
    if (request.url === '/v1/action/gesture-target') arrived();
    else if (request.url === '/v1/action/cancel') {
      acknowledge = () => response.end(JSON.stringify(cancellation(dispatched))); cancelArrived();
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const port = server.address().port;
  const adb = createAdbHttpFixture({ directory: dir, serial: context.serial, port });
  const ctx = createBridgeContext({ serial: context.serial, packageName: context.packageName, port, adb });
  const controller = new AbortController();
  let settled = false;
  const resultPromise = runExecution({ signal: controller.signal, mutation: true }, () => nativeGesture(ctx, payload, { foregroundWindow }))
    .then(result => { settled = true; return result; });
  await ready; controller.abort({ code: 'cancelled' }); await cancelling;
  await delay(30); assert.equal(settled, false, 'cleanup must settle before the command can release its ownership');
  acknowledge(); const result = await resultPromise;
  assert.equal(result.ok, false); assert.equal(result.error, 'cancelled'); assert.equal(result.dispatched, dispatched); assert.equal(result.ambiguous, false);
  assert.equal(requests[0].body.execution.actionId, payload.actionId);
  assert.ok(requests[0].body.execution.timeoutMs > 0);
  assert.deepEqual(requests, [{ path: '/v1/action/gesture-target', body: managedPayload(payload, requests[0].body.execution.timeoutMs) },
    { path: '/v1/action/cancel', body: { actionId: payload.actionId, runtimeEpoch: payload.targetRef.runtimeEpoch } }]);
});

test('lost cancellation and malformed or wrong-owner acknowledgements remain uncertain', async () => {
  const lost = async () => { throw new Error('lost acknowledgement'); };
  for (const cancel of [lost, async () => null, async () => ({ ok: true }),
    async () => ({ ...cancellation(true), actionId: 'other' }), async () => ({ ...cancellation(true), runtimeEpoch: 'other' }),
    async () => ({ ...cancellation(true), executionResult: { ...cancellation(true).executionResult, ambiguous: undefined } })]) {
    const result = await nativeGesture(context, payload, { foregroundWindow, bridgeStatus,
      bridgePost: async () => { throw Object.assign(new Error('connection lost'), { code: 'provider_disconnected' }); },
      cancelBridgePost: async (ctx, body) => {
        assert.equal(currentExecution(), undefined); assert.equal(ctx.packageName, context.packageName);
        assert.deepEqual(body, { actionId: payload.actionId, runtimeEpoch: payload.targetRef.runtimeEpoch }); return cancel();
      } });
    assert.equal(result.ok, false); assert.equal(result.error, 'provider_disconnected'); assert.equal(result.ambiguous, true);
    assert.equal(result.cancellation.ok, false);
    assert.equal(result.cancellation.error, cancel === lost ? 'lost acknowledgement' : 'invalid_native_cancel_receipt');
  }
});
