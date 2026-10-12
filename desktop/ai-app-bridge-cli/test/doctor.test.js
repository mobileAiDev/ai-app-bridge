'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { doctor } = require('../bin/doctor');
const { validateCommandArguments } = require('../bin/command-registry');
const { createScriptHostPort } = require('../bin/script/script-host-port');
const { androidForegroundFixture } = require('../test-support/android-foreground-fixture');
const cli = path.resolve(__dirname, '../bin/ai-app-bridge.js');
const hostStatus = { ok: true, client: { version: '0.4.5' }, runtime: { state: 'stopped' } };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-doctor-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, env: { ...process.env, ADB: '/unused-doctor-adb', AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'facts'),
    AI_APP_BRIDGE_RUNTIME_HOME: path.join(directory, 'runtimes'), AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR: path.join(directory, 'ownership') } };
}

test('Android diagnosis keeps independent read paths available through Runtime, UIA and SDK failures', async () => {
  const calls = [];
  const result = await doctor({ serial: 'phone', packageName: 'example.app', adb: '/fixture-adb' }, {
    inspectRuntime: async () => ({ ...hostStatus, runtime: { state: 'unresponsive', error: 'runtime_connection_timeout' } }),
    lease: { status: serial => ({ ok: true, serial, active: 1, unresolved: true }), acquire: () => assert.fail('diagnosis acquired device mutation lock') },
    execFile: async (program, argv, options) => {
      assert.equal(program, '/fixture-adb'); assert.equal(options.mutation, false); calls.push(argv);
      const command = argv[0] === '-s' ? argv.slice(2).join(' ') : argv.join(' ');
      const replies = { 'devices -l': 'List of devices attached\nphone device model:Fixture\n',
        'shell getprop': '[ro.build.version.sdk]: [36]\n[ro.product.model]: [Fixture]\n[sys.boot_completed]: [1]\n',
        'forward --list': 'phone tcp:12345 localabstract:old-runtime\nother tcp:54321 localabstract:another\n',
        'shell dumpsys window -a': androidForegroundFixture('example.installer').windowDump,
        'shell pm path example.app': 'package:/data/app/example/base.apk\n', 'shell pidof example.app': '42\n' };
      assert.ok(Object.hasOwn(replies, command), command); return { stdout: replies[command], stderr: '' };
    },
    uiaStatus: async () => { throw Object.assign(new Error('Connection lost'), { code: 'uia_runtime_unreachable' }); },
    androidStatus: async () => ({ ok: false, error: 'bridge_endpoint_discovery_failed' }),
  });
  assert.equal(result.ok, true); assert.equal(result.issueCount, 3);
  const byName = name => result.checks.find(item => item.name === name);
  assert.equal(byName('android.device').facts.properties['ro.build.version.sdk'], '36');
  assert.equal(byName('android.app').facts.installed, true);
  assert.equal(byName('android.foreground').status, 'observed'); assert.match(byName('android.foreground').facts.note, /different package/);
  assert.equal(byName('android.forwards').facts.entries.length, 1); assert.equal(calls.length, 6);
  assert.ok(result.nextActions.some(action => action.command === 'uia-runtime' && action.arguments.operation === 'force-reset'));
  for (const action of result.nextActions) validateCommandArguments(action.command, action.arguments);
});

test('an unauthorized or missing device explains the transport without probing its providers', async () => {
  let calls = 0;
  const result = await doctor({ serial: 'phone' }, { inspectRuntime: async () => hostStatus,
    execFile: async (_program, args) => { calls++; assert.deepEqual(args, ['devices', '-l']); return { stdout: 'phone unauthorized\n' }; },
    lease: { status: () => ({ ok: true, active: 0, unresolved: false }) },
    uiaStatus: () => assert.fail('probed unauthorized device'), androidStatus: () => assert.fail('probed unauthorized app'),
  });
  assert.equal(result.ok, true); assert.equal(calls, 1);
  assert.match(result.checks.find(item => item.name === 'android.transport').message, /USB debugging authorization/);
});

test('device inventory does not select another phone or require a package', async () => {
  const result = await doctor({}, { inspectRuntime: async () => hostStatus,
    execFile: async () => ({ stdout: 'List of devices attached\nfirst device\nsecond offline\n' }) });
  assert.equal(result.nextActions.length, 2); assert.equal(result.checks.at(-1).status, 'not_run');
  assert.deepEqual(result.nextActions.map(action => action.arguments.serial), ['first', 'second']);
  for (const action of result.nextActions) validateCommandArguments(action.command, action.arguments);
});

test('Android diagnosis passes the default ADB executable to the explicit UIA target', async () => {
  let seen;
  const report = await doctor({ serial: 'phone' }, { inspectRuntime: async () => hostStatus,
    execFile: async (_program, argv) => ({ stdout: argv[0] === 'devices' ? 'phone device\n' : '' }),
    lease: { status: () => ({ ok: true }) },
    uiaStatus: async args => { seen = args; return { ok: true, running: false }; },
  });
  assert.equal(seen.serial, 'phone'); assert.equal(seen.adb, process.env.ADB ?? 'adb');
  assert.equal(report.checks.find(item => item.name === 'android.uia').status, 'observed');
});

test('diagnosis carries its deadline to Host inspection and preserves probe failures', async () => {
  let signal;
  const report = await doctor({ platform: 'ios', timeoutMs: 25 }, {
    inspectRuntime: options => new Promise(resolve => {
      signal = options.signal;
      signal.addEventListener('abort', () => resolve({ ok: false, error: signal.reason.code, client: {} }), { once: true });
    }),
    iosDoctor: async () => { throw Object.assign(new Error('Diagnostic deadline expired'), { code: 'deadline_exceeded' }); },
  });
  assert.equal(signal.aborted, true); assert.equal(report.ok, true); assert.equal(report.issueCount, 2);
  assert.equal(report.checks[0].facts.error, 'deadline_exceeded');
  assert.equal(report.checks[1].error, 'deadline_exceeded');
});

test('connection failures offer diagnosis for their known platform without adding a prerequisite', () => {
  assert.equal(require('../bin/command-discovery').capabilities({ command: 'doctor' }).platform, 'multi');
  const { withActionGuidance } = require('../bin/shared-kernel/action-guidance');
  for (const [command, args, error, platform] of [
    ['tap', { serial: 'd', packageName: 'a.b' }, 'bridge_connection_refused', 'android'],
    ['ios-tap', { deviceId: 'iphone', bundleId: 'a.b' }, 'ios_runtime_unavailable', 'ios'],
    ['tree', { serial: 'd', packageName: 'a.b' }, 'runtime_connection_timeout', 'host'],
  ]) {
    const result = withActionGuidance(command, args, { ok: false, error, dispatched: false });
    assert.equal(result.guidance.nextActions.length, 1);
    assert.equal(result.guidance.nextActions[0].arguments.platform, platform);
    validateCommandArguments('doctor', result.guidance.nextActions[0].arguments);
    assert.equal(result.dispatched, false);
  }
  assert.equal(withActionGuidance('tap', {}, { ok: true }).guidance, undefined);
});

test('Web and iOS diagnosis report usable paths independently and retain a changed Web identity', async () => {
  const web = await doctor({ platform: 'web', sessionId: 's', runtimeEpoch: 'old', targetId: 'old-target' }, { inspectRuntime: async () => ({ ...hostStatus,
    runtime: { state: 'running', diagnostics: { web: { ok: true, running: true }, sessions: { sessions: [{ sessionId: 's', runtimeEpoch: 'new', targetId: 'current-target', connected: true }] } } } }) });
  assert.equal(web.ok, true); assert.equal(web.checks.find(item => item.name === 'web.identity').status, 'issue');
  assert.equal(web.checks.find(item => item.name === 'web.sessions').facts.sessions[0].runtimeEpoch, 'new');
  assert.equal(web.checks.find(item => item.name === 'web.identity').expected.targetId, 'old-target');
  const ios = await doctor({ platform: 'ios', deviceId: 'd', bundleId: 'example.app' }, { inspectRuntime: async () => hostStatus,
    iosDoctor: async () => ({ ok: true, ready: false, fullControlReady: false, paths: { sdk: { available: true }, wda: { available: false } },
      checks: [{ name: 'runtime', ok: true }, { name: 'wda', ok: false, error: 'ios_wda_target_required' }],
      runtime: { ok: true, runtimeBinding: { runtimeEpoch: 'ios-epoch' } }, wda: { ok: false }, devices: [] }) });
  assert.equal(ios.checks.at(-1).facts.paths.sdk.available, true); assert.equal(ios.issueCount, 0);
  assert.equal(ios.checks.at(-1).facts.ready, undefined);
  for (const action of [...web.nextActions, ...ios.nextActions]) validateCommandArguments(action.command, action.arguments);
});

test('Script doctor uses its device-only or cross-platform target without requiring an unrelated package', async () => {
  for (const target of [{ platform: 'android', serial: 'phone' }, { platform: 'web', sessionId: 'browser', runtimeEpoch: 'epoch' }]) {
    const seen = [];
    const port = createScriptHostPort({ executionId: 'doctor-script', permissions: ['app.read'], target,
      actions: async (command, args) => { seen.push({ command, args }); validateCommandArguments(command, args); return { ok: true, checks: [] }; } });
    const result = await port.call('doctor', {});
    assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual(seen[0], { command: 'doctor', args: target });
    assert.equal(result.execution.actionId, null);
  }
});

test('a Script diagnostic for another platform does not attribute its observations to the default Android target', async () => {
  const seen = [];
  const port = createScriptHostPort({ executionId: 'doctor-cross-platform', target: { platform: 'android', serial: 'phone' },
    actions: async (_command, args) => { seen.push(args); return { ok: true }; } });
  for (const platform of ['host', 'ios']) {
    const result = await port.call('doctor', { platform });
    assert.equal(result.ok, true); assert.equal(result.execution.target, null);
    assert.deepEqual(seen.at(-1), { platform });
  }
});

test('Web diagnostic snapshots do not ping, terminate or expire a retained session', () => {
  const { WebBridgeProvider } = require('../bin/web-provider');
  const provider = new WebBridgeProvider({ store: {}, now: () => 1000000 });
  let terminated = 0;
  provider.sessions.set('old', { sessionId: 'old', runtimeEpoch: 'epoch', lastSeenAtMs: 0,
    socket: { readyState: 1, terminate: () => { terminated++; }, ping: () => assert.fail('diagnosis pinged a socket') } });
  const view = provider.listSessions({ maintainConnections: false });
  assert.equal(view.sessions.length, 1); assert.equal(terminated, 0);
  provider.listSessions(); assert.equal(terminated, 1, 'ordinary session maintenance retains its existing behavior');
});

test('CLI diagnosis reports invalid configuration and broken dependencies instead of starting a Runtime or crashing', t => {
  const f = fixture(t);
  const invalid = spawnSync(process.execPath, [cli, 'doctor', '--platform', 'host'], {
    env: { ...f.env, AI_APP_BRIDGE_FACT_CACHE_PROFILE: 'invalid' }, encoding: 'utf8' });
  assert.equal(invalid.status, 0, invalid.stderr + invalid.stdout);
  assert.equal(JSON.parse(invalid.stdout).value.checks[0].facts.error, 'invalid_fact_store_profile');
  const preload = path.join(f.directory, 'missing-dependency.cjs');
  fs.writeFileSync(preload, `const M=require('node:module'),original=M._resolveFilename;
    M._resolveFilename=function(name,...rest){if(name==='ws/package.json')throw Object.assign(new Error('missing fixture dependency'),{code:'MODULE_NOT_FOUND'});return original.call(this,name,...rest)};`);
  const dependency = spawnSync(process.execPath, ['-r', preload, cli, 'doctor', '--platform', 'host'], { env: f.env, encoding: 'utf8' });
  assert.equal(dependency.status, 0, dependency.stderr + dependency.stdout);
  const report = JSON.parse(dependency.stdout).value;
  assert.equal(report.checks[0].facts.client.error, 'client_installation_invalid');
  assert.equal(report.checks[0].facts.runtime.state, 'stopped');
  assert.equal(fs.existsSync(f.env.AI_APP_BRIDGE_FACT_STORE_DIR), false);
  assert.equal(fs.readdirSync(f.env.AI_APP_BRIDGE_RUNTIME_HOME, { recursive: true }).some(name => name.endsWith('endpoint.json')), false);
});

test('doctor inspects a mismatched authenticated Runtime through status only', async t => {
  const f = fixture(t), token = 'a'.repeat(64), runtimeId = randomUUID(), methods = [];
  const protocol = require('../bin/runtime-protocol').protocol;
  const server = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    let text = ''; for await (const chunk of request) text += chunk;
    const message = JSON.parse(text); methods.push(message.method); assert.equal(message.arguments.diagnostics, true);
    response.end(JSON.stringify({ protocol, runtimeId, reply: { kind: 'json', value: { ok: true, runtimeId,
      identity: { code: 'old-code', config: 'old-config', version: '0.4.4' }, diagnostics: { web: { running: false }, sessions: { sessions: [] } } } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const facts = require('../bin/shared-kernel/canonical-path').canonicalPath(f.env.AI_APP_BRIDGE_FACT_STORE_DIR);
  const directory = path.join(f.env.AI_APP_BRIDGE_RUNTIME_HOME, createHash('sha256').update(facts).digest('hex'));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'endpoint.json'), JSON.stringify({ protocol, runtimeId, token, facts, pid: process.pid, port: server.address().port }));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'doctor', '--platform', 'web'], { env: f.env });
  const report = JSON.parse(stdout).value;
  assert.equal(report.checks[0].facts.compatible, false); assert.equal(report.checks[0].facts.mismatch.details.outdatedSide, 'runtime');
  assert.deepEqual(methods, ['status']); assert.equal(JSON.stringify(report).includes(token), false);
  assert.ok(report.checks.some(item => item.name === 'web.provider'));
  for (const action of report.nextActions) validateCommandArguments(action.command, action.arguments);
});
