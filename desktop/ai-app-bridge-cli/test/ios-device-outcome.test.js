'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { deviceCommandRejection, originalDeviceOutcome } = require('../bin/ios-device-outcome');
const { IOSBridgeProvider } = require('../bin/ios-provider');
const { createDeviceMutationLease } = require('../bin/shared-kernel/device-mutation-lease');

function rejected(args, code = 3) {
  return { info: { arguments: ['devicectl', ...args], commandType: 'devicectl.device.process.launch', jsonVersion: 4, outcome: 'failed' },
    error: { code: 10002, domain: 'com.apple.dt.CoreDeviceError', userInfo: { NSUnderlyingError: { error: {
      code: 1, domain: 'FBSOpenApplicationServiceErrorDomain', userInfo: { NSUnderlyingError: { error: {
        code, domain: 'FBSOpenApplicationErrorDomain', userInfo: { NSLocalizedDescription: { string: 'Device rejected this launch' } },
      } } },
    } } } } };
}
function notInstalled(args) {
  return { info: { arguments: ['devicectl', ...args], commandType: 'devicectl.device.process.launch', jsonVersion: 4, outcome: 'failed' },
    error: { code: 10002, domain: 'com.apple.dt.CoreDeviceError', userInfo: { NSUnderlyingError: { error: {
      code: -10814, domain: 'NSOSStatusErrorDomain', userInfo: { BundleIdentifier: { string: 'sample.app' } },
    } } } } };
}
const args = ['device', 'process', 'launch', '--device', 'phone', '--terminate-existing', 'sample.app', '--timeout', '30', '--json-output', '/original.json'];
function usageAssertionRejected(args) {
  return { info: { arguments: ['devicectl', ...args], commandType: 'devicectl.device.process.launch', outcome: 'failed' },
    error: { code: 4016, domain: 'com.apple.dt.CoreDeviceError', userInfo: {
      CurrentlyAssertableStates: { array: [] },
      RequestedDeviceStates: { array: [
        { string: 'com.apple.coredevice.remoteServiceDiscoveryTrustedConnectivityAvailable' },
        { string: 'com.apple.coredevice.coreDeviceServicesLoaded' },
        { string: 'com.apple.coredevice.powerAssertionTaken' },
      ] },
    } } };
}
test('original launch usage assertion rejection settles before dispatch; transport loss remains unknown', () => {
  const reply = usageAssertionRejected(args);
  const outcome = deviceCommandRejection(reply, args, { code: 1 });
  assert.equal(outcome?.error, 'ios_device_unavailable');
  assert.equal(outcome.settled, true); assert.equal(outcome.dispatched, false); assert.equal(outcome.ambiguous, false);
  assert.deepEqual(originalDeviceOutcome(reply, args), outcome);
  for (const edit of [
    value => { value.error.code = 4017; },
    value => { value.error.domain = 'unrelated'; },
    value => { delete value.error.userInfo.CurrentlyAssertableStates; },
    value => { value.error.userInfo.RequestedDeviceStates.array = []; },
    value => { value.error.userInfo.CurrentlyAssertableStates.array = [{ string: 'com.apple.coredevice.powerAssertionTaken' }]; },
    value => { value.result = { process: { processIdentifier: 100 } }; },
  ]) {
    const unrelated = structuredClone(reply); edit(unrelated);
    assert.equal(originalDeviceOutcome(unrelated, args), null);
  }
  assert.equal(originalDeviceOutcome(reply, [...args, 'another.app']), null);
  assert.equal(deviceCommandRejection(reply, args, { code: 'provider_timeout' }), null);
  assert.equal(deviceCommandRejection(reply, args, { code: 1, killed: true }), null);
});
function installLimit(args) {
  return { info: { arguments: ['devicectl', ...args], commandType: 'devicectl.device.install.app', jsonVersion: 4, outcome: 'failed' },
    error: { code: 3002, domain: 'com.apple.dt.CoreDeviceError', userInfo: { NSUnderlyingError: { error: {
      code: 14, domain: 'IXUserPresentableErrorDomain', userInfo: { NSUnderlyingError: { error: {
        code: 13, domain: 'MIInstallerErrorDomain', userInfo: {
          LegacyErrorString: { string: 'ApplicationVerificationFailed' },
          NSLocalizedDescription: { string: 'This device has reached the maximum number of installed apps using a free developer profile: {("TEAM.sample.app")}' },
        },
      } } },
    } } } } };
}
test('original free-profile installation limit settles without treating other signature failures as known', () => {
  const installArgs = ['device', 'install', 'app', '--device', 'phone', '/sample.app', '--json-output', '/install.json'];
  const reply = installLimit(installArgs), exit = { code: 1, signal: null, killed: false };
  const result = deviceCommandRejection(reply, installArgs, exit);
  assert.equal(result.error, 'ios_free_profile_app_limit'); assert.equal(result.settled, true); assert.equal(result.ambiguous, false);
  assert.equal(deviceCommandRejection(reply, [...installArgs.slice(0, -1), '/another.json'], exit), null);
  assert.equal(deviceCommandRejection(reply, installArgs, { code: 'provider_timeout' }), null);
  const unrelated = structuredClone(reply);
  unrelated.error.userInfo.NSUnderlyingError.error.userInfo.NSUnderlyingError.error.userInfo.NSLocalizedDescription.string = 'Another verification failure';
  assert.equal(deviceCommandRejection(unrelated, installArgs, exit), null);
});
test('public install returns the specific free-profile error and releases only its completed rejection', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-ios-install-limit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lease = createDeviceMutationLease({ directory });
  const app = path.join(directory, 'Sample.app'); fs.mkdirSync(app);
  const provider = new IOSBridgeProvider({ lease, execFile(file, argv, options, callback) {
    const report = argv[argv.indexOf('--json-output') + 1];
    setImmediate(() => {
      if (argv.includes('list')) {
        fs.writeFileSync(report, JSON.stringify({ result: { devices: [{ identifier: 'phone', hardwareProperties: { udid: 'udid' },
          deviceProperties: { developerModeStatus: 'enabled', ddiServicesAvailable: true }, connectionProperties: { tunnelState: 'connected' } }] } }));
        callback(null, '', ''); return;
      }
      fs.writeFileSync(report, JSON.stringify(installLimit(argv.slice(1))));
      callback(Object.assign(new Error('install rejected'), { code: 1, signal: null, killed: false }), '', '');
    });
    return { pid: 987654, kill() {} };
  } });
  const result = await provider.run('ios-install-app', { deviceId: 'phone', appPath: app });
  assert.equal(result.error, 'ios_free_profile_app_limit'); assert.equal(result.settled, true);
  assert.equal(lease.status('ios:udid').phase, 'idle');
});
test('original structured Security and Locked launch rejections are settled failures', () => {
  for (const code of [3, 7]) {
    const result = deviceCommandRejection(rejected(args, code), args, { code: 1, signal: null, killed: false });
    assert.equal(result.ok, false); assert.equal(result.settled, true);
    assert.equal(result.dispatched, true); assert.equal(result.ambiguous, false);
    assert.equal(result.error, code === 7 ? 'ios_device_locked' : 'ios_app_launch_rejected');
  }
});
test('original app-not-installed launch rejection settles without depending on the JSON format version number', () => {
  for (const version of [3, 4, 5]) {
    const reply = notInstalled(args); reply.info.jsonVersion = version;
    const result = deviceCommandRejection(reply, args, { code: 1, signal: null, killed: false });
    assert.equal(result?.error, 'ios_app_not_installed');
    assert.equal(result.settled, true); assert.equal(result.ambiguous, false);
  }
  assert.equal(deviceCommandRejection(notInstalled(args), [...args, 'another.app'], { code: 1 }), null);
});
test('missing, unrelated, timed out or interrupted responses never settle a launch', () => {
  const reply = rejected(args);
  const variants = [null, {...reply,info:{...reply.info,commandType:'unrelated.command'}},
    {...reply,info:{...reply.info,outcome:'success'}}, rejected([...args.slice(0,-1),'/different.json']),
    rejected(args, 99), {...reply,error:{code:3,domain:'FBSOpenApplicationErrorDomain'}}];
  for (const candidate of variants) assert.equal(deviceCommandRejection(candidate,args,{code:1}),null);
  for (const error of [{code:'provider_timeout'}, {code:1,killed:true}, {code:1,signal:'SIGTERM'}, {code:0}])
    assert.equal(deviceCommandRejection(reply,args,error),null);
  assert.equal(deviceCommandRejection(rejected(['device','install','app']),['device','install','app'],{code:1}),null);
});
test('public provider releases known rejected launches and retains genuinely unknown outcomes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-ios-device-outcome-'));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const lease = createDeviceMutationLease({directory});
  let mode = 'security', launches = 0;
  const provider = new IOSBridgeProvider({lease, execFile(file, argv, options, callback) {
    const report = argv[argv.indexOf('--json-output')+1];
    const child = {pid:987654,kill(){}};
    setImmediate(() => {
      if (argv.includes('list')) {
        fs.writeFileSync(report,JSON.stringify({result:{devices:[{identifier:'phone',hardwareProperties:{udid:'udid'},
          deviceProperties:{developerModeStatus:'enabled',ddiServicesAvailable:true},connectionProperties:{tunnelState:'connected'}}]}}));
        callback(null,'',''); return;
      }
      launches++;
      if (mode !== 'unknown') fs.writeFileSync(report,JSON.stringify(mode === 'missing' ? notInstalled(argv.slice(1)) : rejected(argv.slice(1),mode==='locked'?7:3)));
      const error=Object.assign(new Error('original command failed'),{code:mode==='unknown'?'provider_timeout':1,signal:null,killed:false});
      callback(error,'','');
    });
    return child;
  }});
  for (mode of ['security','locked','missing']) {
    const result = await provider.run('ios-launch-app',{deviceId:'phone',bundleId:'sample.app'});
    assert.equal(result.settled,true,JSON.stringify(result)); assert.equal(result.ambiguous,false);
    assert.equal(lease.status('ios:udid').phase,'idle');
  }
  mode='unknown';
  const missing=await provider.run('ios-launch-app',{deviceId:'phone',bundleId:'sample.app'});
  assert.equal(missing.ambiguous,true); assert.equal(lease.status('ios:udid').phase,'unresolved');
  const blocked=await provider.run('ios-launch-app',{deviceId:'phone',bundleId:'another.app'});
  assert.equal(blocked.error,'device_ownership_unresolved'); assert.equal(launches,4);
});

for (const [name, response, expectedError] of [
  ['app not installed', notInstalled, 'ios_app_not_installed'],
  ['usage assertion unavailable', usageAssertionRejected, 'ios_device_unavailable'],
]) test(`a fresh provider reconciles original ${name} without SDK access or replay`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-ios-command-recovery-'));
  let originalPath, originalArgs, launches = 0;
  t.after(() => { if (originalPath) fs.rmSync(originalPath, { force: true }); fs.rmSync(directory, { recursive: true, force: true }); });
  const execute = (file, argv, options, callback) => {
    const report = argv[argv.indexOf('--json-output') + 1];
    setImmediate(() => {
      if (argv.includes('list')) {
        fs.writeFileSync(report, JSON.stringify({ result: { devices: [{ identifier: 'phone', hardwareProperties: { udid: 'udid' }, deviceProperties: { ddiServicesAvailable: true }, connectionProperties: { tunnelState: 'connected' } }] } }));
        callback(null, '', ''); return;
      }
      launches++; originalPath = report; originalArgs = argv.slice(1);
      callback(Object.assign(new Error('Lost devicectl response'), { code: 'provider_timeout' }), '', '');
    });
    return { pid: 987654, kill() {} };
  };
  const provider = new IOSBridgeProvider({ lease: createDeviceMutationLease({ directory }), execFile: execute });
  const failed = await provider.run('ios-launch-app', { deviceId: 'phone', bundleId: 'sample.app' });
  assert.equal(failed.ambiguous, true);
  const fresh = new IOSBridgeProvider({ lease: createDeviceMutationLease({ directory }), execFile: execute });
  const recover = () => fresh.run('ios-execution', { operation: 'reconcile', deviceId: 'phone' });
  assert.equal((await recover()).error, 'device_ownership_unresolved');
  fs.writeFileSync(originalPath, JSON.stringify(response([...originalArgs, 'another-invocation'])));
  assert.equal((await recover()).error, 'device_ownership_unresolved');
  fs.writeFileSync(originalPath, JSON.stringify(response(originalArgs)));
  const recovered = await recover();
  assert.equal(recovered.recovered, true, JSON.stringify(recovered));
  assert.equal(recovered.executionReceipt.outcome.error, expectedError);
  assert.equal(launches, 1, 'Reconciliation must only read the original response');
  assert.equal(fresh.lease.status('ios:udid').phase, 'idle');
});

test('setup verifies the target SDK after the Runner has taken the foreground', async () => {
  const provider = new IOSBridgeProvider();
  const device={identifier:'phone',udid:'udid',developerModeStatus:'enabled',ddiServicesAvailable:true};
  let foreground='sample.app', wdaRunning=false, runtimeReads=0;
  const wda={ok:true,url:'http://wda.test',runtimeBinding:{bundleId:'runner.xctrunner'}};
  provider.xcodeVersion=async()=>({ok:true});
  provider.devices=async()=>({devices:[device]});
  provider.wdaStatus=async()=>wdaRunning?wda:{ok:false,error:'not_running'};
  provider.startWda=async()=>{foreground='runner.xctrunner';wdaRunning=true;return {ok:true,status:wda};};
  provider.launchApp=async args=>{foreground=args.bundleId;return {ok:true};};
  provider.runtimeGet=async()=>{runtimeReads++;return {ok:foreground==='sample.app',endpoint:'http://sample.test'};};
  const result=await provider.setup({deviceId:'phone',bundleId:'sample.app',startWda:true});
  assert.equal(result.ready,true); assert.equal(result.runtimeEndpoint,'http://sample.test');
  assert.equal(foreground,'sample.app'); assert.equal(runtimeReads,1);
  foreground='runner.xctrunner';
  const reused=await provider.setup({deviceId:'phone',bundleId:'sample.app'});
  assert.equal(reused.ready,true); assert.equal(foreground,'sample.app'); assert.equal(runtimeReads,2);
});
