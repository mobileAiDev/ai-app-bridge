'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBridgeContext, executeProviderCommand, waitText } = require('../bin/device-provider');
const { readForegroundFeedback } = require('../bin/shared-kernel/android-foreground-feedback');
const { bindCommandTarget, normalizeExecutionTarget } = require('../bin/shared-kernel/execution-target');

test('ordinary Android feedback explicitly reports notCollected without calling WindowManager', async () => {
  for (const feedback of [undefined, 'auto', 'off']) {
    let reads = 0;
    const ctx = createBridgeContext({ serial: 'one', packageName: 'example.app', feedback });
    const result = await readForegroundFeedback(ctx, () => { reads++; });
    assert.equal(reads, 0);
    assert.equal(result.foregroundObservations[0].status, 'notCollected');
    assert.equal(result.foregroundObservations[0].actual, null);
    assert.equal(result.foregroundObservations[0].observedAtMs, undefined, 'omission must not fabricate an observation time');
  }
});

test('requested foreground evidence remains advisory, including mismatches and probe errors', async () => {
  const ctx = createBridgeContext({ serial: 'one', packageName: 'example.app', feedback: 'window' });
  const mismatch = await readForegroundFeedback(ctx, async () => ({ ok: true, packageName: 'other.app', ownershipVerified: false }));
  assert.equal(mismatch.foregroundObservations[0].status, 'mismatch');
  assert.equal(mismatch.warnings[0].code, 'foreground_package_mismatch');
  const failed = await readForegroundFeedback(ctx, async () => { throw Object.assign(new Error('transport broke'), { code: 'adb_diagnostic_error', stderr: 'details' }); });
  assert.equal(failed.foregroundObservations[0].status, 'unknown');
  assert.equal(failed.warnings[0].actual.cause.stderr, 'details');
});

test('explicit Activity readiness still collects the requested fact with feedback off', async () => {
  let probes = 0;
  const ctx = createBridgeContext({ serial: 'one', packageName: 'example.app', feedback: 'off' });
  const result = await waitText(ctx, 'Ready', { provider: 'native', requireActivity: 'example.ReadyActivity', feedback: 'off', timeoutMs: 500 }, {
    bridgeTree: async () => ({ root: { visible: true, text: 'Ready' }, coverage: { status: 'complete' } }),
    foregroundWindow: async () => { probes++; return { ok: true, packageName: 'example.app', activity: 'example.ReadyActivity' }; },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.matched.activity, 'example.ReadyActivity');
  assert(probes > 0);
});

test('Script target defaults carry transport and feedback while screenshot keeps explicit verification', () => {
  const target = normalizeExecutionTarget({ platform: 'android', serial: 'one', packageName: 'example.app',
    sdkTransport: 'forward', feedback: 'window', screenshotVerification: 'ownership' });
  const click = bindCommandTarget('tap-native', { selector: { text: 'Go' } }, target);
  assert.equal(click.args.sdkTransport, 'forward'); assert.equal(click.args.feedback, 'window');
  assert.equal(click.args.screenshotVerification, undefined);
  const screenshot = bindCommandTarget('screenshot', {}, target);
  assert.equal(screenshot.args.screenshotVerification, 'ownership');
});

test('SDK-only server override is not advertised for mixed-provider commands or workflow targets', () => {
  const { commandSchema } = require('../bin/command-registry');
  for (const command of ['tap', 'tap-text', 'wait-text', 'input-text']) {
    assert.equal(commandSchema(command).properties.adbServerSocket, undefined, command);
    assert(commandSchema(command).properties.sdkTransport, command);
  }
  for (const command of ['tap-native', 'status', 'h5-click', 'ui-observation']) assert(commandSchema(command).properties.adbServerSocket, command);
  assert.throws(() => normalizeExecutionTarget({ platform: 'android', serial: 'one', adbServerSocket: 'tcp:5038' }), { code: 'unsupported_argument' });
});

test('ordinary public SDK defaults retain custom wrappers and the explicit server namespace', async t => {
  const http = require('node:http');
  const { createAdbHttpFixture } = require('../test-support/adb-http-fixture');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-wrapper-policy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let reads = 0;
  const server = http.createServer((request, response) => { reads++; response.end(JSON.stringify({ ok: true, app: { packageName: 'example.app' } })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const serial = `wrapper-${path.basename(directory)}`;
  const adb = createAdbHttpFixture({ directory, serial, port: server.address().port });
  const log = path.join(directory, 'namespace.jsonl');
  const source = fs.readFileSync(adb, 'utf8').replace('const args =', `require('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.env.ADB_SERVER_SOCKET)+'\\n');\nconst args =`);
  fs.writeFileSync(adb, source);
  const options = { adb, serial, packageName: 'example.app', adbServerSocket: 'tcp:127.0.0.1:15039' };
  const result = await executeProviderCommand('status', options);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.sdkConnection.transport, 'forward');
  assert.equal(result.sdkConnection.selection, 'custom_adb_executable');
  assert.equal(result.sdkConnection.serverSocket, options.adbServerSocket);
  assert(fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).every(socket => socket === options.adbServerSocket));
  assert.equal(reads, 1);
  const rejected = await executeProviderCommand('status', { ...options, sdkTransport: 'direct' });
  assert.equal(rejected.error, 'sdk_direct_requires_native_adb');
  assert.equal(rejected.dispatched, false); assert.equal(reads, 1, 'direct incompatibility must be classified before any HTTP request');
});

test('Intent propagates caller transport/feedback into its actual provider context', async () => {
  const calls = [];
  const adapter = require('../bin/intent/intent-production-adapter').createProductionIntentDeviceAdapter({ ports: {
    createBridgeContext: args => { calls.push(args); return createBridgeContext(args); },
    bridgeTree: async () => ({ root: { visible: true } }),
    foregroundWindow: async () => ({ ok: true, packageName: 'example.app' }),
  } });
  const result = await adapter.observe({ serial: 'one', packageName: 'example.app', provider: 'native',
    sdkTransport: 'forward', feedback: 'window' });
  assert.equal(result.ok, true); assert.equal(result.foregroundTarget, 'example.app');
  assert.equal(calls[0].sdkTransport, 'forward');
});

test('real provider screenshot uses one window probe by default or full ownership on request', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-capture-policy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const adb = path.join(directory, 'adb'), log = path.join(directory, 'calls.jsonl');
  const foregroundFixture = require.resolve('../test-support/android-foreground-fixture');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=';
  fs.writeFileSync(adb, `#!${process.execPath}\nconst args=process.argv.slice(2);require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');if(args.includes('screencap'))process.stdout.write(Buffer.from(${JSON.stringify(png)},'base64'));else require(${JSON.stringify(foregroundFixture)}).handleAndroidForegroundFixture(args,'example.app');\n`, { mode: 0o755 });
  const target = { adb, serial: 'capture-one', packageName: 'example.app', outFile: path.join(directory, 'screen.png') };
  const light = await executeProviderCommand('screenshot', target);
  assert.equal(light.ok, true); assert.equal(light.source, 'adb-screencap');
  assert.equal(light.screenshotVerification, 'window'); assert.equal(light.foreground.ownershipVerified, false);
  let calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(args => args.includes('window')).length, 1); assert.equal(calls.length, 2);
  fs.writeFileSync(log, '');
  const verified = await executeProviderCommand('screenshot', { ...target, screenshotVerification: 'ownership' });
  assert.equal(verified.ok, true); assert.equal(verified.foreground.ownershipVerified, true);
  calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(args => args.includes('window')).length, 2); assert.equal(calls.length, 6);
  assert.equal(light.artifact.sha256, verified.artifact.sha256, 'only diagnostic policy changed, not pixel capture source');
});
