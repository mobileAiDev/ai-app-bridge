'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { randomUUID } = require('node:crypto');
const { executeCommand } = require('../test-support/host-client');
const { createAdbHttpFixture } = require('../test-support/adb-http-fixture');
const { schema } = require('../bin/shared-kernel/h5-execution');
const { schema: targetSchema } = require('../bin/shared-kernel/android-h5-target');
const { commandFailure } = require('../bin/command-errors');


const pageRef = { schemaVersion: targetSchema, runtimeEpoch: 'h5-epoch', packageName: 'example.h5', processId: 42,
  activity: 'example.h5.Main', windowId: 'window-1', webViewId: 'webview-1', documentId: 'document-1', url: 'https://bridge.test/' };
const control = (id, tag) => ({ elementId: id, tag, id, name: '', type: '', text: '', ariaLabel: '', href: '', visible: true,
  disabled: false, editable: tag === 'input', value: '', bounds: { left: 0, top: 0, right: 100, bottom: 40 } });
const snapshot = () => ({ ok: true, h5TargetSchema: targetSchema, pageRef,
  dom: { title: 'H5 test', readyState: 'complete', bodyText: '', truncated: false, controls: [control('one','button'), control('editor','input')] } });

const terminal = (body, changes = {}) => ({ ok: true, actionId: body.actionId, runtimeEpoch: body.execution.runtimeEpoch,
  dispatched: true, ambiguous: false, settled: true, execution: { schemaVersion: schema, actionId: body.actionId,
    runtimeEpoch: body.execution.runtimeEpoch, settled: true }, result: JSON.stringify({ ok: true }), ...changes });
async function fixture(t, handler, managed = true, observe = snapshot) {
  const serial = 'h5-' + randomUUID(), packageName = 'example.h5';
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url === '/v1/status') return res.end(JSON.stringify({ ok: true, app: { packageName },
      debugBridge: { runtimeEpoch: 'h5-epoch', h5TargetSchema: targetSchema, ...(managed ? { h5ExecutionSchema: schema } : {}) } }));
    if (req.url.startsWith('/v1/h5/dom')) return res.end(JSON.stringify(observe(req.url)));
    try { res.end(JSON.stringify(await handler(req.url, JSON.parse(body)))); }
    catch (error) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-h5-wire-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const port = server.address().port;
  return { serial, packageName, port, adb: createAdbHttpFixture({ directory, serial, port, foregroundPackage: packageName }) };
}

test('raw and typed H5 actions use the original logical identity and verified completion proof', async t => {
  const requests = [];
  const target = await fixture(t, (endpoint, body) => { requests.push({ endpoint, body }); return terminal(body); });
  for (const [command, args] of [['h5-eval', { script: '1+1', expectedPage: pageRef }], ['h5-click', { selector: { elementId: 'one' } }],
    ['h5-input', { selector: { elementId: 'editor' }, text: '' }], ['h5-scroll', { deltaX: 1, deltaY: 0 }]]) {
    const requestId = 'original-' + command;
    const result = await executeCommand(command, { ...target, ...args, requestId });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.executionReceipt.kind, 'h5');
    assert.equal(result.executionReceipt.actionId, requestId); assert.match(result.executionReceipt.responseSha256, /^[a-f0-9]{64}$/);
    assert.equal(requests.at(-1).endpoint, '/v1/h5/action'); assert.equal(requests.at(-1).body.execution.schemaVersion, schema);
    assert.equal(requests.at(-1).body.actionId, requestId);
  }
  assert.equal(requests.length, 4);
});

test('a DOM rejection retains its machine error and evaluation completion proof', async t => {
  const target = await fixture(t, (_endpoint, body) => terminal(body, { ok: false, error: 'android_h5_target_obscured', dispatched: false }));
  const result = await executeCommand('h5-click', { ...target, selector: { elementId: 'one' } }).catch(error => commandFailure(error, 'h5-click'));
  assert.equal(result.ok, false); assert.equal(result.error, 'android_h5_target_obscured');
  assert(result.settled && result.executionReceipt.settled); assert.equal(result.executionReceipt.kind, 'h5');
  assert.equal((await executeCommand('device-ownership', { serial: target.serial, operation: 'status' })).active, 0);
});

test('missing execution capability cannot send an old H5 request', async t => {
  let calls = 0; const target = await fixture(t, () => { calls++; return {}; }, false);
  const result = await executeCommand('h5-eval', { ...target, script: 'dangerous()', expectedPage: pageRef });
  assert.equal(result.error, 'h5_execution_unavailable'); assert.equal(result.dispatched, false); assert.equal(calls, 0);
  assert.equal((await executeCommand('device-ownership', { serial: target.serial, operation: 'status' })).active, 0);
});

test('unknown H5 execution stays occupied across recovery until its original terminal callback is proven', async t => {
  let original, complete = false, dispatches = 0;
  const target = await fixture(t, (endpoint, body) => {
    if (endpoint === '/v1/h5/action') { original = body; dispatches++; return { ok: false, error: 'h5_eval_timeout' }; }
    assert.equal(endpoint, '/v1/h5/cancel'); assert.deepEqual(body, { actionId: original.actionId, runtimeEpoch: original.execution.runtimeEpoch });
    return complete ? { ok: true, ...body, executionResult: terminal(original) }
      : { ok: true, ...body, executionResult: terminal(original, { actionId: 'wrong' }) };
  });
  const result = await executeCommand('h5-eval', { ...target, script: 'oneMutation()', expectedPage: pageRef, requestId: 'h5-original' });
  assert.equal(result.settled, false); assert.equal(result.dispatched, null); assert.equal(result.executionReceipt, null);
  assert.equal((await executeCommand('keyevent', { ...target, keyCode: 4 })).error, 'device_ownership_unresolved');
  assert.equal((await executeCommand('device-ownership', { serial: target.serial, operation: 'reconcile' })).error, 'device_ownership_unresolved');
  complete = true;
  const recovery = await executeCommand('device-ownership', { serial: target.serial, operation: 'reconcile' });
  assert.equal(recovery.recovered, true); assert.equal(recovery.executionReceipt.actionId, original.actionId); assert.equal(dispatches, 1);
});

test('H5 waits only observe and keep the original WebView selection', async t => {
  const reads = [];
  const target = await fixture(t, () => { throw new Error('wait must not dispatch'); }, true, url => {
    reads.push(url); const tree = snapshot();
    tree.dom.controls = reads.length < 3 ? [] : [control('late', 'button')]; return tree;
  });
  const result = await executeCommand('h5-wait', { ...target, selector: { elementId: 'late' }, timeoutMs: 5000, intervalMs: 1 });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.targetRef.pageRef.webViewId, 'webview-1');
  assert.deepEqual(reads, ['/v1/h5/dom','/v1/h5/dom?webViewId=webview-1','/v1/h5/dom?webViewId=webview-1']);
});

test('a stale expected page or element cannot dispatch even if the selector still matches', async t => {
  let writes = 0;
  const target = await fixture(t, () => { writes++; throw new Error('must not dispatch'); });
  const expectedTarget = { pageRef: { ...pageRef, documentId: 'old' },
    element: Object.fromEntries(['elementId','tag','id','name','type','text','ariaLabel','href'].map(key => [key, control('one','button')[key]])) };
  const rejected = await executeCommand('h5-click', { ...target, selector: { elementId: 'one' }, expectedTarget });
  assert.equal(rejected.error, 'reobserve_required'); assert.equal(rejected.dispatched, false); assert.equal(writes, 0);
});
