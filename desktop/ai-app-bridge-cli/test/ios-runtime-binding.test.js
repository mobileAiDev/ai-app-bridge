'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { createIOSRuntimeFixture } = require('../test-support/ios-runtime-fixture');
const { executeCommand } = require('../test-support/host-client');
const { runExecution } = require('../bin/shared-kernel/execution-scope');
const { commandSchema, executionTimeoutMs } = require('../bin/command-registry');
const { bindingHeaders } = require('../bin/ios-runtime-binding');
const ownershipDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-ios-binding-ownership-'));
process.env.AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR = ownershipDirectory;
test.after(() => fs.rmSync(ownershipDirectory, { recursive: true, force: true }));

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-ios-binding-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const calls = [];
  const status = () => ({ ok: true, runtimeBinding: device.binding, items: [],
    debugBridge: { runtimeEpoch: device.binding.runtimeEpoch, h5ExecutionSchema: 'aab.h5-execution/v1', h5TargetSchema: 'aab.ios-h5-target/v1' } });
  const terminal = req => ({ ok: true, runtimeBinding: device.binding, dispatched: true, ambiguous: false,
    settled: true, actionId: req.body.actionId, runtimeEpoch: req.body.execution.runtimeEpoch,
    execution: { ...req.body.execution, settled: true } });
  let serve = (req, res) => res.end(JSON.stringify(req.method === 'POST' ? terminal(req) : status()));
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    req.body = body ? JSON.parse(body) : null;
    calls.push({ method: req.method, path: req.url, headers: req.headers });
    serve(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const device = createIOSRuntimeFixture(directory, { port: server.address().port, udid: path.basename(directory) });
  return { directory, device, calls, status, terminal, serve(handler) { serve = handler; }, run(command = 'ios-status', args = {}) {
    return executeCommand(command, { ...device.args, ...(command === 'ios-h5-eval' ? { expectedPage: {
      schemaVersion: 'aab.ios-h5-target/v1', runtimeEpoch: device.binding.runtimeEpoch, bundleId: device.binding.bundleId,
      processId: device.binding.processId, webViewId: 'view-1', documentId: 'document-1', url: 'https://fixture.test/' } } : {}), ...args });
  } };
}

test('SDK schemas require device and App identity even for explicit URLs; default budget is finite', async t => {
  const h = await fixture(t);
  for (const command of ['ios-status', 'ios-events', 'ios-h5-eval', 'ios-flutter-action']) {
    assert.ok(commandSchema(command).required.includes('deviceId'));
    assert.ok(commandSchema(command).required.includes('bundleId'));
    assert.equal(executionTimeoutMs(command), 30000);
  }
  for (const field of ['deviceId', 'bundleId']) {
    const args = { ...h.device.args };
    delete args[field];
    const rejected = await executeCommand('ios-status', args);
    assert.equal(rejected.error, 'missing_argument'); assert.equal(rejected.dispatched, false);
  }
  assert.equal(h.device.calls().length, 0);
  assert.equal(h.calls.length, 0);
});

test('public SDK query copies the exact device container and carries its identity into the real HTTP request', async t => {
  const h = await fixture(t);
  const result = await h.run('ios-events', { history: true, mobileFactId: 'mf2:events:12' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.runtimeBinding, h.device.binding);
  assert.equal(result.device.identifier, h.device.args.deviceId);
  assert.equal(h.device.calls().length, 2);
  const copy = h.device.calls()[1];
  assert.equal(copy[copy.indexOf('--device') + 1], h.device.args.deviceId);
  assert.equal(copy[copy.indexOf('--domain-identifier') + 1], 'pkg');
  assert.equal(copy[copy.indexOf('--source') + 1], 'Documents/ai_app_bridge_port.json');
  for (const [key, value] of Object.entries(bindingHeaders(h.device.binding))) assert.equal(h.calls[0].headers[key.toLowerCase()], value);
  assert.match(h.calls[0].path, /^\/v1\/events\?/);
  assert.match(h.calls[0].path, /view=connected-history/);
  assert.equal(fs.existsSync(copy[copy.indexOf('--destination') + 1]), false, 'temporary descriptor is cleaned after the call');
});

test('container-selected endpoint and UDID resolve to the canonical device without scanning', async t => {
  const h = await fixture(t);
  const args = { ...h.device.args, deviceId: h.device.config.device.hardwareProperties.udid };
  delete args.runtimeUrl;
  const result = await executeCommand('ios-status', args);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.calls.length, 1);
  assert.equal(h.device.calls()[1][4], 'iphone-wire');
});

test('explicit endpoints cannot bypass device readiness, identity, or descriptor validation', async t => {
  const cases = [
    ['unavailable', { device: { deviceProperties: { developerModeStatus: 'enabled', ddiServicesAvailable: true }, connectionProperties: { tunnelState: 'unavailable' } } }, 'ios_tunnel_unavailable'],
    ['missing descriptor', { absent: true }, 'ios_runtime_descriptor_absent'],
    ['malformed descriptor', { rawDescriptor: '{broken' }, 'invalid_ios_runtime_descriptor'],
    ['oversized descriptor', { rawDescriptor: 'x'.repeat(4097) }, 'invalid_ios_runtime_descriptor'],
    ['old descriptor', { descriptor: { ok: true, bundleId: 'pkg', port: 18080 } }, 'invalid_ios_runtime_binding'],
    ['not ready', { descriptor: { ok: false } }, 'ios_runtime_not_ready'],
    ['not bound yet', { descriptor: { ok: false, port: 0, error: 'starting' } }, 'ios_runtime_not_ready', 'starting'],
    ['failed listener', { descriptor: { ok: false, port: 0, error: 'Address already in use' } }, 'ios_runtime_not_ready', 'Address already in use'],
    ['unbound ready descriptor', { descriptor: { ok: true, port: 0 } }, 'invalid_ios_runtime_binding'],
    ['invalid unready port', { descriptor: { ok: false, port: -1 } }, 'invalid_ios_runtime_binding'],
    ['wrong App', { descriptor: { bundleId: 'other.app' } }, 'ios_runtime_binding_mismatch'],
    ['port string', { descriptor: { port: '18080' } }, 'invalid_ios_runtime_binding'],
  ];
  for (const [name, changes, error, reason] of cases) await t.test(name, async t => {
    const h = await fixture(t);
    if (changes.device) changes.device = { ...h.device.config.device, ...changes.device };
    if (changes.descriptor && name !== 'old descriptor') changes.descriptor = { ...h.device.config.descriptor, ...changes.descriptor };
    h.device.update(changes);
    const result = await h.run('ios-h5-eval', { script: 'window.effect = 1' });
    assert.equal(result.ok, false);
    assert.equal(result.error, error, JSON.stringify(result));
    if (reason) assert.ok(result.message.includes(reason), result.message);
    assert.equal(result.dispatched, false);
    assert.equal(result.ambiguous, false);
    assert.equal(h.calls.length, 0);
  });
});

test('a wrong endpoint, old SDK, or changed process fails preflight before any control POST', async t => {
  for (const [field, value] of [['bundleId', 'other.app'], ['runtimeEpoch', 'restarted'], ['processId', 99], ['port', 1], ['port', 0], ['schemaVersion', 'old']]) {
    await t.test(field, async t => {
      const h = await fixture(t);
      h.serve((_req, res) => res.end(JSON.stringify({ ok: true, runtimeBinding: { ...h.device.binding, [field]: value } })));
      const result = await h.run('ios-h5-eval', { script: 'window.effect = 1' });
      assert.equal(result.ok, false);
      assert.equal(result.dispatched, false);
      assert.equal(result.ambiguous, false);
      assert.deepEqual(h.calls.map(call => call.method), ['GET']);
    });
  }
});

test('a matching control request reuses the preflight identity; a changed response cannot become a pass', async t => {
  const h = await fixture(t);
  let effects = 0;
  h.serve((req, res) => {
    if (req.url === '/v1/h5/action') effects++;
    res.end(JSON.stringify({ ...h.status(), runtimeBinding: { ...h.device.binding, ...(effects ? { runtimeEpoch: 'other' } : {}) } }));
  });
  const result = await h.run('ios-h5-eval', { script: 'window.effect = 1' });
  assert.equal(result.error, 'ios_runtime_binding_mismatch');
  assert.equal(result.dispatched, null);
  assert.equal(result.ambiguous, true);
  assert.equal(effects, 1);
  assert.deepEqual(h.calls.map(call => call.method), ['GET', 'POST', 'POST']);
  assert.equal(h.calls[1].headers['x-aab-runtime-epoch'], h.calls[0].headers['x-aab-runtime-epoch']);
});

test('invalid or incomplete JSON is never relabelled as a successful SDK response', async t => {
  const h = await fixture(t);
  for (const body of ['', '{', 'null', '[]', '{}', JSON.stringify({ runtimeBinding: h.device.binding })]) {
    h.serve((_req, res) => res.end(body));
    const result = await h.run();
    assert.equal(result.ok, false, body);
    assert.match(result.error, /^invalid_ios_/);
  }
});

test('bound HTTP rejection retains its SDK error while an oversized response is terminated', async t => {
  const h = await fixture(t);
  h.serve((_req, res) => {
    res.writeHead(409);
    res.end(JSON.stringify({ ok: false, runtimeBinding: h.device.binding, error: 'ios_runtime_descriptor_unavailable' }));
  });
  const rejected = await h.run('ios-h5-eval', { script: '1' });
  assert.equal(rejected.error, 'ios_runtime_descriptor_unavailable');
  assert.equal(rejected.dispatched, false);
  assert.deepEqual(h.calls.map(call => call.method), ['GET']);
  h.serve((_req, res) => res.end(Buffer.alloc(8 * 1024 * 1024 + 1, 32)));
  const oversized = await h.run();
  assert.equal(oversized.error, 'provider_response_too_large');
  assert.equal(oversized.dispatched, false);
});

test('a manually forwarded port is only transport; the matching SDK native port remains bound', async t => {
  const h = await fixture(t);
  h.device.binding.port = 18080;
  h.device.update({ descriptor: { ...h.device.binding, ok: true } });
  const result = await h.run('ios-h5-eval', { script: '1' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.runtimeBinding.port, 18080);
  assert.equal(h.calls[1].headers['x-aab-runtime-port'], '18080');
});

test('total deadline includes container discovery and closes a trickling socket', async t => {
  const h = await fixture(t);
  h.device.update({ copyDelayMs: 120 });
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  h.serve((_req, res) => {
    res.writeHead(200);
    const timer = setInterval(() => res.write(' '), 5);
    res.on('close', () => { clearInterval(timer); closed(); });
  });
  const start = Date.now();
  // Include two real Node/devicectl startups before the HTTP stream. The former
  // 600 ms budget could expire before HTTP opened on a busy build host.
  const result = await h.run('ios-events', { timeoutMs: 2000 });
  assert.equal(result.error, 'deadline_exceeded', JSON.stringify(result));
  assert.equal(result.dispatched, false);
  assert.equal(h.calls.length, 1);
  await disconnected;
  assert.ok(Date.now() - start >= 1900);
  assert.ok(Date.now() - start < 3500);
});

test('cancellation terminates a resistant devicectl child before the call settles and never reaches HTTP', async t => {
  const h = await fixture(t);
  const pidFile = path.join(h.directory, 'child-pid');
  h.device.update({ hang: pidFile });
  const controller = new AbortController();
  const pending = runExecution({ signal: controller.signal }, () => h.run());
  for (let i = 0; !fs.existsSync(pidFile) && i < 300; i++) await delay(10);
  assert.ok(fs.existsSync(pidFile));
  const pid = Number(fs.readFileSync(pidFile));
  controller.abort({ code: 'cancelled' });
  const result = await pending;
  assert.equal(result.error, 'cancelled', JSON.stringify(result));
  assert.equal(result.dispatched, false);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(h.calls.length, 0);
});

test('lost control response retains ambiguity after HTTP cancellation', async t => {
  const h = await fixture(t);
  let submitted;
  const entered = new Promise(resolve => { submitted = resolve; });
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  h.serve((req, res) => {
    if (req.method === 'GET') return res.end(JSON.stringify(h.status()));
    res.on('close', closed);
    submitted();
  });
  const controller = new AbortController();
  const pending = runExecution({ signal: controller.signal }, () => h.run('ios-h5-eval', { script: 'window.effect = 1' }));
  await entered;
  controller.abort({ code: 'cancelled' });
  const result = await pending;
  assert.equal(result.error, 'cancelled');
  assert.equal(result.dispatched, null);
  assert.equal(result.ambiguous, true);
  await disconnected;
});
