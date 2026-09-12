'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { executeCommand } = require('../test-support/host-client');
const { createAdbHttpFixture } = require('../test-support/adb-http-fixture');
const { nativeRuntimeStatus, nativeExecutionReceipt, withNativeTargetRefs } = require('../test-support/native-target-fixture');

async function fixture(t, handler) {
  const serial = 'native-execution-wire', packageName = 'example.native';
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url === '/v1/status') return res.end(JSON.stringify(nativeRuntimeStatus(packageName)));
    if (req.url === '/v1/view/tree') return res.end(JSON.stringify(withNativeTargetRefs({ root: {
      resourceName: 'id/button', text: 'Button', visible: true, enabled: true, clickable: true, longClickable: true, editable: true,
      bounds: { left: 0, top: 0, right: 400, bottom: 800 },
    } })));
    res.end(JSON.stringify(await handler(req.url, JSON.parse(body))));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-native-execution-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const port = server.address().port;
  const adb = createAdbHttpFixture({ directory, serial, port, foregroundPackage: packageName });
  return { serial, packageName, adb, port };
}

test('all native mutation primitives send managed identities and return compact validated completion receipts', async t => {
  const requests = [];
  const target = await fixture(t, async (endpoint, body) => {
    requests.push({ endpoint, body });
    return nativeExecutionReceipt(body, endpoint === '/v1/action/gesture-target' ? { completion: 'completed' } : {});
  });
  for (const [command, args, endpoint] of [
    ['tap', { tapX: 0, tapY: 20 }, '/v1/action/tap'],
    ['tap-text', { targetText: 'Button', provider: 'native' }, '/v1/action/tap-target'],
    ['tap-native', { selector: { resourceName: 'id/button' } }, '/v1/action/tap-target'],
    ['input-text', { text: 'input' }, '/v1/action/input-text'],
    ['input-text', { text: '', selector: { resourceName: 'id/button' } }, '/v1/action/input-target'],
    ['native-gesture', { payload: { action: 'longPress', selector: { resourceName: 'id/button' }, durationMs: 600 } }, '/v1/action/gesture-target'],
  ]) {
    const actionId = `direct-${command}-${requests.length}`;
    const result = await executeCommand(command, { ...target, ...args, requestId: actionId });
    assert.equal(result.ok, true, JSON.stringify(result));
    const request = requests.at(-1); assert.equal(request.endpoint, endpoint);
    assert.equal(request.body.execution.schemaVersion, 'aab.native-execution/v1');
    assert.equal(request.body.actionId, actionId); assert.equal(request.body.execution.actionId, actionId);
    if (command === 'native-gesture') assert.equal(result.completion, 'completed');
    assert.equal(result.executionReceipt.kind, 'native'); assert.equal(result.executionReceipt.settled, true);
    assert.equal(result.executionReceipt.actionId, actionId); assert.match(result.executionReceipt.responseSha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(requests.length, 6);
});

test('the default public native recovery port retains an unknown operation until its matching SDK completion arrives', async t => {
  let original, valid = false, cancellations = 0, dispatches = 0;
  const target = await fixture(t, async (endpoint, body) => {
    if (endpoint === '/v1/action/input-text') {
      original = body; dispatches++;
      return { schemaVersion: 'aab.native-execution/v1', actionId: body.actionId, runtimeEpoch: body.execution.runtimeEpoch,
        ok: false, error: 'native_action_timeout', dispatched: null, ambiguous: true, settled: false };
    }
    assert.equal(endpoint, '/v1/action/cancel'); cancellations++;
    assert.deepEqual(body, { actionId: original.actionId, runtimeEpoch: original.execution.runtimeEpoch });
    return { ok: true, ...body, executionResult: nativeExecutionReceipt(original, {
      actionId: valid ? body.actionId : 'wrong-action',
    }), ...(valid ? {} : { actionId: 'wrong-action' }) };
  });
  const first = await executeCommand('input-text', { ...target, text: 'one-write', requestId: 'native-original' });
  assert.equal(first.settled, false); assert.equal(first.ambiguous, true); assert.equal(first.executionReceipt, null);
  const occupied = await executeCommand('device-ownership', { serial: target.serial, operation: 'status' });
  assert.equal(occupied.active, 1); assert.equal(occupied.ownership.pending.kind, 'native');
  assert.equal((await executeCommand('keyevent', { ...target, keyCode: 4 })).error, 'device_ownership_unresolved');
  assert.equal((await executeCommand('device-ownership', { serial: target.serial, operation: 'reconcile' })).error, 'device_ownership_unresolved');
  valid = true;
  const recovered = await executeCommand('device-ownership', { serial: target.serial, operation: 'reconcile' });
  assert.equal(recovered.recovered, true); assert.equal(recovered.settlement.proof.kind, 'native');
  assert.deepEqual(recovered.executionReceipt, recovered.settlement.proof);
  assert.equal(recovered.settlement.proof.actionId, original.actionId);
  assert.equal(dispatches, 1); assert.equal(cancellations, 3);
  assert.equal((await executeCommand('device-ownership', { serial: target.serial, operation: 'status' })).active, 0);
});
