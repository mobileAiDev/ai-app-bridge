'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { executeCommand } = require('../test-support/host-client');
const { createAdbHttpFixture } = require('../test-support/adb-http-fixture');
const { flutterNode, flutterRef } = require('../test-support/flutter-target-fixture');

test('public Flutter actions carry the Host action ID through the real HTTP boundary', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/view/tree') return res.end(JSON.stringify({ root: { visible: true, bounds: { left: 0, top: 0, right: 400, bottom: 800 } } }));
    if (['/v1/status', '/v1/flutter/snapshot'].includes(req.url)) return res.end(JSON.stringify({ flutter: { layout: { operable: {
      runtimeEpoch: 'flutter-fixture-runtime', executionSchema: 'aab.flutter-execution/v1', nodes: [
      flutterNode(), flutterNode({ id: 'e2', text: '', action: 'input' }), flutterNode({ id: 'e3', text: '', action: 'scroll' }),
    ] } } } }));
    requests.push({ path: req.url, body: JSON.parse(body) });
    const request = JSON.parse(body);
    res.end(JSON.stringify({ ok: true, dispatched: true, ambiguous: false, settled: true,
      actionId: request.actionId, runtimeEpoch: request.execution.runtimeEpoch,
      execution: { schemaVersion: request.execution.schemaVersion, actionId: request.actionId,
        runtimeEpoch: request.execution.runtimeEpoch, settled: true } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-flutter-action-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const port = server.address().port;
  const adb = createAdbHttpFixture({ directory, serial: 'flutter-wire', port, foregroundPackage: 'example.sample' });
  const options = { adb, port, serial: 'flutter-wire', packageName: 'example.sample' };
  for (const [command, args, action] of [
    ['tap-flutter', { tapX: 0, tapY: 25.5 }, 'tapAt'],
    ['tap-flutter-text', { targetText: 'Settings' }, 'tapTarget'],
    ['tap-flutter', { selector: { nodeId: 'e1' } }, 'tapTarget'],
    ['input-flutter-text', { text: 'typed' }, 'inputText'],
    ['input-flutter-text', { text: 'typed', selector: { nodeId: 'e2' } }, 'inputText'],
    ['scroll-flutter', { delta: 300 }, 'scrollBy'],
    ['scroll-flutter', { delta: 300, selector: { nodeId: 'e3' } }, 'scrollBy'],
    ['scroll-flutter', { targetText: 'About' }, 'scrollUntilText'],
    ['flutter-action', { payload: { action: 'back' } }, 'back'],
  ]) {
    const requestId = `host-owned-${requests.length}`;
    const result = await executeCommand(command, { ...options, ...args, requestId });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(requests.at(-1), { path: '/v1/flutter/action', body: {
      ...result.request, action, actionId: requestId,
    } });
    if (['tapTarget', 'inputText', 'scrollBy', 'scrollUntilText'].includes(action)) {
      const id = action === 'tapTarget' ? 'e1' : action === 'inputText' ? 'e2' : 'e3';
      assert.deepEqual(requests.at(-1).body.targetRef, flutterRef(id));
      assert.equal(Object.hasOwn(requests.at(-1).body, 'x'), false);
    }
  }
  const beforeInvalid = requests.length;
  const injected = await executeCommand('flutter-action', { ...options, payload: { action: 'back', actionId: 'untrusted-payload' } });
  assert.equal(injected.error, 'unsupported_argument'); assert.equal(injected.field, 'payload.actionId');
  const untyped = await executeCommand('flutter-action', { ...options, payload: '{"action":"back"}' });
  assert.equal(untyped.error, 'invalid_argument'); assert.equal(untyped.field, 'payload');
  assert.equal(requests.length, beforeInvalid);
  await executeCommand('flutter-action', { ...options, payload: { action: 'back' }, requestId: 'explicit-direct' });
  assert.equal(requests.at(-1).body.actionId, 'explicit-direct');
  await executeCommand('tap-flutter-text', { ...options, targetText: 'Settings' });
  assert.match(requests.at(-1).body.actionId, /^host-action-/);
  assert.equal(requests.at(-1).body.execution.actionId, requests.at(-1).body.actionId);
  assert.ok(requests.at(-1).body.execution.timeoutMs > 0);
  const { createProductionIntentDeviceAdapter } = require('../bin/intent/intent-production-adapter');
  const adapter = createProductionIntentDeviceAdapter({ adb });
  for (const spec of [
    { provider: 'flutter', action: 'tap', selector: { text: 'Settings' } },
    { provider: 'flutter', action: 'back' },
  ]) {
    const result = await adapter.action({ ...options, rawTree: { nodes: [flutterNode()] },
      actionId: 'intent:owned-action', spec });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(requests.at(-1).body.actionId, 'intent:owned-action');
    assert.equal(requests.at(-1).body.execution.actionId, 'intent:owned-action');
  }
});

test('typed Flutter tap is discoverable, permission gated, and rejects bad coordinates before dispatch', async () => {
  const { authorizeCommand } = require('../bin/script/script-catalog');
  const { runBridgeChecked } = require('../test-support/host-client');
const { capabilityPayload } = require('../bin/mcp-server');
  const capability = capabilityPayload({ command: 'tap-flutter', includeOptions: true });
  assert.equal(capability.ok, true);
  assert.deepEqual(capability.inputSchema.required, ['packageName', 'serial']);
  assert.match(capability.summary, /logical coordinates/);
  assert.equal(authorizeCommand('tap-flutter', ['app.interact']).ok, true);
  assert.equal(authorizeCommand('tap-flutter', ['app.read']).error, 'permission_not_granted');
  assert.equal(authorizeCommand('flutter-action').error, 'command_not_in_catalog');
  let dispatched = 0;
  for (const coordinates of [{}, { tapX: 1 }, { tapX: null, tapY: 1 }, { tapX: '', tapY: 1 },
    { tapX: false, tapY: 1 }, { tapX: -1, tapY: 2 }, { tapX: Infinity, tapY: 2 }]) {
    const r = await runBridgeChecked('tap-flutter', { serial: 'flutter-wire', packageName: 'pkg', ...coordinates }, {
      targetExecution: { execute() { dispatched++; } }, rawRunner: async () => { dispatched++; },
    });
    assert.match(JSON.parse(r.content[0].text).error, /^(invalid_argument|missing_argument)$/);
  }
  assert.equal(dispatched, 0);
});

test('public recovery uses the actual exported provider and HTTP receipt after a lost completion', async t => {
  const serial = 'flutter-recovery-wire', packageName = 'example.sample';
  let identity, finished = false, cancellations = 0;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/view/tree') return res.end(JSON.stringify({ root: { visible: true, bounds: { left: 0, top: 0, right: 400, bottom: 800 } } }));
    if (['/v1/status', '/v1/flutter/snapshot'].includes(req.url)) return res.end(JSON.stringify({ flutter: { layout: { operable: {
      runtimeEpoch: 'wire-runtime', executionSchema: 'aab.flutter-execution/v1', nodes: [flutterNode()],
    } } } }));
    const request = JSON.parse(body);
    if (req.url === '/v1/flutter/action') {
      identity = { actionId: request.actionId, runtimeEpoch: request.execution.runtimeEpoch };
      return res.end(JSON.stringify({ schemaVersion: 'aab.flutter-execution/v1', ...identity, ok: false,
        error: 'flutter_action_timeout', dispatched: null, ambiguous: true, settled: false }));
    }
    assert.equal(req.url, '/v1/flutter/cancel'); assert.deepEqual(request, identity); cancellations++;
    if (!finished) return res.end(JSON.stringify({ ok: false, error: 'flutter_action_cancel_pending' }));
    res.end(JSON.stringify({ ok: true, ...identity, executionResult: {
      ok: false, error: 'flutter_action_cancelled', ...identity, dispatched: true, ambiguous: false, settled: true,
      execution: { schemaVersion: 'aab.flutter-execution/v1', ...identity, settled: true },
    } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-recovery-wire-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const port = server.address().port;
  const adb = createAdbHttpFixture({ directory, serial, port, foregroundPackage: packageName });
  const first = await executeCommand('tap-flutter', { serial, packageName, adb, port, tapX: 1, tapY: 1 });
  assert.equal(first.settled, false);
  assert.equal((await executeCommand('device-ownership', { serial, operation: 'status' })).active, 1);
  assert.equal((await executeCommand('device-ownership', { serial, operation: 'reconcile' })).error, 'device_ownership_unresolved');
  finished = true;
  const recovered = await executeCommand('device-ownership', { serial, operation: 'reconcile' });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.settlement.proof.actionId, identity.actionId);
  assert.equal(cancellations, 3);
  assert.equal((await executeCommand('device-ownership', { serial, operation: 'status' })).active, 0);
});
