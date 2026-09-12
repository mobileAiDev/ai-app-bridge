'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { prepareWdaProject, supportedVersion } = require('../bin/ios-wda-project');
const { IOSBridgeProvider } = require('../bin/ios-provider');
const { runExecution, currentExecution } = require('../bin/shared-kernel/execution-scope');
const { createIOSRuntimeFixture } = require('../test-support/ios-runtime-fixture');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-wda-project-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('prepared WDA keeps upstream untouched and includes the scheme post-build script', t => {
  const directory = temporary(t);
  const upstream = path.dirname(require.resolve('appium-webdriveragent/package.json'));
  const destination = path.join(directory, 'prepared');
  const prepared = prepareWdaProject({ destination });
  assert.equal(prepared.upstreamVersion, supportedVersion);
  for (const file of prepared.transformations) {
    const hash = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    assert.equal(hash(path.join(upstream, file.path)), file.beforeSha256, 'preparation must not patch node_modules');
    assert.equal(hash(path.join(destination, file.path)), file.afterSha256);
    assert.notEqual(file.beforeSha256, file.afterSha256);
  }
  const script = 'Scripts/embed-runner-icon.sh';
  assert.deepEqual(fs.readFileSync(path.join(destination, script)), fs.readFileSync(path.join(upstream, script)));
  assert.ok(fs.statSync(path.join(destination, script)).mode & 0o111);
  assert.ok(fs.existsSync(path.join(destination, 'WebDriverAgentRunner/Assets.xcassets')));
  assert.throws(() => prepareWdaProject({ destination }), { code: 'ios_wda_destination_not_empty' });
  const incompatible = path.join(directory, 'unsupported');
  fs.mkdirSync(incompatible);
  fs.writeFileSync(path.join(incompatible, 'package.json'), JSON.stringify({ version: '99.0.0' }));
  assert.throws(() => prepareWdaProject({ destination: path.join(directory, 'other'), packageDirectory: incompatible }),
    { code: 'ios_wda_version_unsupported' });
});

test('setup reuses only a container-bound Runner and does not require signing or start another child', async t => {
  const directory = temporary(t);
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/aab/status');
    assert.equal(req.headers['x-aab-wda-runtime-epoch'], device.binding.runtimeEpoch);
    res.end(JSON.stringify({ wdaBinding: device.binding, value: { ok: true, ready: true, executionSchema: 'aab.wda-execution/v1' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const device = createIOSRuntimeFixture(directory, { bundleId: 'test.wda.xctrunner', port: server.address().port,
    schemaVersion: 'aab.ios-wda/v1', descriptorFilename: 'ai_app_bridge_wda.json' });
  const provider = new IOSBridgeProvider();
  const result = await runExecution({ timeoutMs: 5000, mutation: true }, () => provider.startWda({
    deviceId: device.args.deviceId, devicectl: device.devicectl, wdaTestBundleId: 'test.wda',
    // This path cannot spawn: success must come from the exact existing Runner.
    xcodebuild: path.join(directory, 'does-not-exist'),
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.reused, true);
  assert.equal(result.pid, undefined);
  assert.equal(result.wdaRunnerBundleId, 'test.wda.xctrunner');
  assert.deepEqual(result.status.runtimeBinding, device.binding);
});

test('WDA setup cancellation and timeout await the owned resistant xcodebuild process closing', async t => {
  for (const mode of ['cancel', 'deadline']) await t.test(mode, async t => {
    const directory = temporary(t);
    const observed = path.join(directory, 'child.json');
    const executable = path.join(directory, 'xcodebuild-fixture');
    fs.writeFileSync(executable, [
      '#!' + process.execPath,
      "const fs = require('node:fs');",
      "if (process.argv.includes('build-for-testing')) process.exit(0);",
      "process.on('SIGTERM', () => {});",
      'fs.writeFileSync(' + JSON.stringify(observed) + ', JSON.stringify({pid:process.pid,args:process.argv.slice(2),',
      'CPATH:process.env.CPATH ?? null,SDKROOT:process.env.SDKROOT ?? null}));',
      'setInterval(() => {}, 1000);',
    ].join('\n'), { mode: 0o755 });
    const device = createIOSRuntimeFixture(directory, { port: 8100 });
    const provider = new IOSBridgeProvider();
    // Device selection still runs a real devicectl child. No Runner endpoint is
    // served in this case; only the owned xcodebuild lifetime is under test.
    provider.wdaStatus = async () => ({ ok: false, error: 'ios_runtime_descriptor_absent' });
    const controller = new AbortController();
    const pending = runExecution({ signal: controller.signal, timeoutMs: mode === 'deadline' ? 2000 : 8000, mutation: true },
      () => provider.startWda({ deviceId: device.args.deviceId, devicectl: device.devicectl,
        xcodebuild: executable, teamId: 'CONTROLLED' })).then(value => ({ value }), error => ({ error }));
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(observed) && Date.now() < deadline) await delay(10);
    assert.ok(fs.existsSync(observed), 'the child must actually have started');
    const child = JSON.parse(fs.readFileSync(observed));
    t.after(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      const project = child.args[child.args.indexOf('-project') + 1];
      fs.rmSync(path.dirname(path.dirname(project)), { recursive: true, force: true });
    });
    assert.equal(child.CPATH, null);
    assert.equal(child.SDKROOT, null);
    assert.ok(child.args.includes('ENABLE_DEFAULT_HEADER_SEARCH_PATHS=NO'));
    assert.ok(child.args.includes('PRODUCT_BUNDLE_IDENTIFIER=io.github.mobileaidev.aiappbridge.wda'));
    assert.ok(child.args.includes('test-without-building'));
    if (mode === 'cancel') controller.abort({ code: 'cancelled' });
    const result = await pending;
    assert.equal(result.error?.code, mode === 'cancel' ? 'cancelled' : 'deadline_exceeded');
    assert.equal(result.error.dispatched, true);
    assert.equal(result.error.ambiguous, true, 'local process closure is not proof of the device outcome');
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  });
});

test('WDA build failure and build cancellation release ownership before any device test starts', async t => {
  for (const mode of ['failure', 'cancel']) await t.test(mode, async t => {
    const directory = temporary(t), observed = path.join(directory, 'build.json');
    const executable = path.join(directory, 'build-fixture');
    fs.writeFileSync(executable, [
      '#!' + process.execPath, "const fs = require('node:fs');",
      "if (!process.argv.includes('build-for-testing')) process.exit(97);",
      'fs.writeFileSync(' + JSON.stringify(observed) + ',JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));',
      mode === 'failure' ? 'process.exit(65);' : "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",
    ].join('\n'), { mode: 0o755 });
    const device = createIOSRuntimeFixture(directory, { port: 8100 });
    const { createDeviceMutationLease } = require('../bin/shared-kernel/device-mutation-lease');
    const lease = createDeviceMutationLease({ directory: path.join(directory, 'ownership') });
    const provider = new IOSBridgeProvider({ lease });
    provider.xcodeVersion = async () => ({ ok: true });
    provider.wdaStatus = async () => ({ ok: false, error: 'ios_runtime_descriptor_absent' });
    const controller = new AbortController();
    const pending = runExecution({ signal: controller.signal, timeoutMs: 8000 }, () => provider.run('ios-setup', {
      deviceId: device.args.deviceId, devicectl: device.devicectl, xcodebuild: executable, startWda: true, teamId: 'CONTROLLED',
    }));
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(observed) && Date.now() < deadline) await delay(10);
    assert.ok(fs.existsSync(observed));
    const child = JSON.parse(fs.readFileSync(observed));
    t.after(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      fs.rmSync(path.dirname(path.dirname(child.args[child.args.indexOf('-project') + 1])), { recursive: true, force: true });
    });
    if (mode === 'cancel') controller.abort({ code: 'cancelled' });
    const result = await pending;
    assert.equal(result.error, mode === 'failure' ? 'ios_wda_build_failed' : 'cancelled', JSON.stringify(result));
    assert.equal(result.dispatched, false); assert.equal(result.ambiguous, false);
    assert.equal(lease.status('ios:' + device.config.device.hardwareProperties.udid).phase, 'idle');
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  });
});

test('failure to spawn WDA is reported without inventing a dispatched device operation', async t => {
  const directory = temporary(t);
  const device = createIOSRuntimeFixture(directory, { port: 8100 });
  const provider = new IOSBridgeProvider();
  provider.wdaStatus = async () => ({ ok: false, error: 'ios_runtime_descriptor_absent' });
  const result = await runExecution({ timeoutMs: 5000, mutation: true }, async () => ({
    ...await provider.startWda({ deviceId: device.args.deviceId, devicectl: device.devicectl,
      xcodebuild: path.join(directory, 'does-not-exist'), teamId: 'CONTROLLED' }),
    dispatched: currentExecution().dispatched,
  }));
  t.after(() => fs.rmSync(path.dirname(result.logFile), { recursive: true, force: true }));
  assert.equal(result.error, 'ios_wda_xcodebuild_spawn_failed');
  assert.equal(result.dispatched, false);
});

test('doctor requires a connected device, SDK, and bound WDA even when no WDA URL is supplied', async () => {
  const provider = new IOSBridgeProvider();
  const device = { identifier: 'device', udid: 'udid', developerModeStatus: 'enabled',
    ddiServicesAvailable: true, tunnelState: 'connected' };
  provider.xcodeVersion = async () => ({ ok: true });
  provider.devices = async () => ({ devices: [device] });
  let runtimeReady = true, wdaCalls = 0;
  provider.runtimeGet = async () => ({ ok: runtimeReady });
  provider.wdaStatus = async args => {
    assert.equal(args.wdaRunnerBundleId, 'test.wda.xctrunner');
    wdaCalls++;
    return { ok: true };
  };
  const args = { deviceId: 'udid', bundleId: 'sample.app', wdaRunnerBundleId: 'test.wda.xctrunner' };
  assert.equal((await provider.doctor(args)).ready, true);
  assert.equal(wdaCalls, 1);
  runtimeReady = false;
  assert.equal((await provider.doctor(args)).ready, false);
  runtimeReady = true;
  device.tunnelState = 'unavailable';
  assert.equal((await provider.doctor(args)).ready, false);
  device.tunnelState = 'connected';
  device.ddiServicesAvailable = undefined;
  assert.equal((await provider.doctor(args)).ready, false);
});
