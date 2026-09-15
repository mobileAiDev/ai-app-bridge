'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { commandDefinitions, isolatedCommandDefinitions, commandSchema, validateCommandArguments } = require('../bin/command-registry');
const { runBridgeChecked, runGeneric } = require('../test-support/host-client');
const { callTool, toolDefinitions, capabilityPayload } = require('../bin/mcp-server');
const { tap } = require('../bin/device-provider');
const { TargetExecution } = require('../bin/target-execution');
const { getProcessDeviceMutationLease } = require('../bin/shared-kernel/device-mutation-lease');
const { createProductionHost } = require('../bin/script/script-entry');
const { flutterNode, flutterRef } = require('../test-support/flutter-target-fixture');

const payload = result => JSON.parse(result.content[0].text);
const target = { platform: 'android', serial: 'contract-device', packageName: 'contract.app' };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('one discoverable registry supplies all live command schemas and only two MCP tools', () => {
  const definitions = [...commandDefinitions, ...isolatedCommandDefinitions];
  assert.equal(definitions.length, 122);
  assert.equal(new Set(definitions.map(d => d.command)).size, definitions.length);
  for (const definition of definitions) {
    const schema = commandSchema(definition.command);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(capabilityPayload({ command: definition.command }).inputSchema, schema);
    assert.equal(capabilityPayload({ command: definition.command }).entrypoints.cli, true);
  }
  for (const command of ['smoke', 'launch-native-test', 'launch-flutter', 'batch', 'tap_text']) {
    assert.equal(capabilityPayload({ command }).ok, false);
  }
  assert.deepEqual(toolDefinitions().map(tool => tool.name), ['capabilities', 'run']);
});

test('invalid inputs are rejected before execution, observers, HTTP or ADB', async () => {
  let touched = 0;
  const dependencies = {
    rawRunner: async () => { touched++; return { ok: true }; },
    targetExecution: { execute() { touched++; throw new Error('must not execute'); } },
    observationCollector: { register() { touched++; } },
  };
  const cases = [
    ['tap', { tapX: null, tapY: true }], ['tap', { tapX: '1', tapY: 2 }],
    ['tap', { tapX: -1, tapY: 2 }], ['tap', { tapX: Infinity, tapY: 2 }],
    ['tap', { x: 1, y: 2 }], ['tap', { tapX: 1, tapY: 2, typo: true }],
    ['swipe', { startX: 1, startY: 2, endX: 3, endY: 4, durationMs: -1 }],
    ['keyevent', { keyCode: true }], ['keyevent', { keyCode: null }],
    ['input-text', { text: 'x', tapX: 1 }], ['input-text', { text: null }],
    ['tap-text', { text: 'old alias' }], ['tap', { tapX: 1, tapY: 2, history: true }],
    ['h5-click', { selector: '#one', targetText: 'two' }],
  ];
  for (const [command, args] of cases) {
    const response = await runBridgeChecked(command, { ...target, ...args }, dependencies);
    const result = payload(response);
    assert.equal(response.isError, true, JSON.stringify([command, args]));
    assert.equal(result.ok, false);
    assert.equal(result.dispatched, false);
    assert.equal(result.ambiguous, false);
    assert.equal(typeof result.field, 'string');
    assert.equal(typeof result.message, 'string');
  }
  assert.equal(touched, 0);
});

test('run has one parameter location and removed tools return structured errors', async () => {
  for (const args of [null, { command: 'tap', serial: 'old' }, { command: 'tap', arguments: [] }, { command: 'tap_text' }]) {
    const result = payload(await runGeneric(args));
    assert.equal(result.ok, false);
    assert.equal(result.dispatched, false);
  }
  assert.equal(payload(await callTool('tap', {})).error, 'unknown_tool');
  assert.equal(payload(await runBridgeChecked('unknown', {})).error, 'unknown_command');
});

test('CLI alone converts textual numbers and preserves keyCode zero', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-cli-contract-'));
  const env = { ...process.env, AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'facts') };
  t.after(async () => {
    const { runCli } = require('../test-support/cli-client');
    assert.equal((await runCli('runtime', { operation: 'stop' }, { env })).value.ok, true);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const executable = path.join(directory, 'adb');
  const log = path.join(directory, 'calls.json');
  fs.writeFileSync(executable, `#!${process.execPath}\nconst call=require(${JSON.stringify(require.resolve('../test-support/android-shell-fixture'))}).handleAndroidShellFixture(process.argv.slice(2));\nif(call.handled)process.exit(0);\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(call.args));\n`);
  fs.chmodSync(executable, 0o755);
  const cli = path.resolve(__dirname, '../bin/ai-app-bridge.js');
  const valid = spawnSync(process.execPath, [cli, 'keyevent', '--serial', 'contract-cli', '--adb', executable, '--key-code', '0'], { encoding: 'utf8', env });
  assert.equal(valid.status, 0, valid.stderr || valid.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(log)), ['-s', 'contract-cli', 'shell', 'input', 'keyevent', '0']);
  fs.unlinkSync(log);
  const invalid = spawnSync(process.execPath, [cli, 'tap', '--serial', 'contract-cli', '--adb', executable, '--tap-x', '--tap-y', '2'], { encoding: 'utf8', env });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).value.dispatched, false);
  assert.equal(fs.existsSync(log), false);
});

test('app-scoped and package-bound device taps refuse a mismatched or unknown foreground', async () => {
  const ctx = { explicitPackageName: true, packageName: 'contract.expected' };
  for (const foreground of [{ ok: true, packageName: 'contract.other' }, { ok: false, error: 'unreadable' }]) {
    for (const options of [{ feedback: 'off', appLocalAction: true }, { scope: 'device' }]) {
      const calls = [];
      const result = await tap(ctx, 10, 20, options, {
        foregroundWindow: async () => foreground,
        adb: async () => calls.push('adb'), bridgePost: async () => calls.push('sdk'),
      });
      assert.equal(result.ok, false);
      assert.equal(result.dispatched, false);
      assert.deepEqual(calls, []);
    }
  }
});

test('SDK unavailable does not switch transport; explicit device scope has one dispatch', async () => {
  const ctx = { explicitPackageName: true, packageName: 'contract.expected' };
  const calls = [];
  const dependencies = {
    foregroundWindow: async () => ({ ok: true, packageName: ctx.packageName }),
    bridgeStatus: async () => { calls.push('status'); return { ok: false, error: 'ECONNREFUSED' }; },
    adb: async () => calls.push('adb'),
    bridgePost: async () => { calls.push('sdk'); throw Object.assign(new Error('not connected'), { code: 'ECONNREFUSED' }); },
  };
  const unavailable = await tap(ctx, 10, 20, {}, dependencies);
  assert.equal(unavailable.error, 'native_execution_unavailable');
  assert.equal(unavailable.dispatched, false);
  assert.deepEqual(calls, ['status']);
  calls.length = 0;
  assert.equal((await tap(ctx, 10, 20, { scope: 'device' }, dependencies)).ok, true);
  assert.deepEqual(calls, ['adb']);
});

test('requestId detects command/content conflicts and ignores object-key order', async () => {
  const execution = new TargetExecution();
  let calls = 0;
  const runner = async () => { calls++; return { ok: true }; };
  const args = { ...target, requestId: 'content-id', tapX: 0, tapY: 1, feedback: 'off' };
  const first = await execution.execute('tap', args, runner);
  assert.deepEqual(await execution.execute('tap', Object.fromEntries(Object.entries(args).reverse()), runner), first);
  assert.throws(() => execution.execute('input-text', { ...args, text: 'different' }, runner), { code: 'idempotency_conflict' });
  assert.throws(() => execution.execute('tap', { ...args, tapX: 2 }, runner), { code: 'idempotency_conflict' });
  assert.equal(calls, 1);
});

test('old command path cannot dispatch while Intent or Script owns the physical device', async () => {
  const held = getProcessDeviceMutationLease().acquire('contract-held');
  let calls = 0;
  try {
    const result = payload(await runBridgeChecked('tap', { serial: 'contract-held', packageName: 'other.app', tapX: 1, tapY: 2 }, {
      rawRunner: async () => { calls++; return { ok: true }; },
    }));
    assert.equal(result.error, 'target_busy');
    assert.equal(result.dispatched, false);
    assert.equal(calls, 0);
  } finally { held.release(); }
});

test('a Script-owned action can cross the shared executor without reacquiring or bypassing its lease', async () => {
  const serial = 'contract-owned';
  const lease = getProcessDeviceMutationLease();
  let calls = 0;
  const host = createProductionHost({ target: { platform: 'android', serial, packageName: 'pkg' }, actions: async (command, args) => {
    const result = payload(await runBridgeChecked(command, args, { rawRunner: async () => {
      assert.equal(lease.status(serial).active, 1); calls++; return { ok: true };
    } }));
    return result;
  } });
  const result = await host.call('tap', { tapX: 1, tapY: 2 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls, 1);
  assert.equal(lease.status(serial).active, 0);
});

test('same-phone different-app actions serialize; separate phones remain concurrent', async () => {
  const execution = new TargetExecution();
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const starts = [];
  const first = execution.execute('tap', { serial: 'contract-queue', packageName: 'a' }, async () => { starts.push('a'); await gate; return { ok: true }; });
  const second = execution.execute('tap', { serial: 'contract-queue', packageName: 'b' }, async () => { starts.push('b'); return { ok: true }; });
  const other = execution.execute('tap', { serial: 'contract-other', packageName: 'c' }, async () => { starts.push('c'); return { ok: true }; });
  await tick();
  assert.deepEqual(starts, ['a', 'c']);
  finish();
  await Promise.all([first, second, other]);
  assert.deepEqual(starts, ['a', 'c', 'b']);
});

test('provider errors without ok:false still become MCP errors', async () => {
  const { platform, ...args } = target;
  const response = await runBridgeChecked('status', args, { rawRunner: async () => ({ error: 'provider_failed' }) });
  assert.equal(response.isError, true);
  assert.equal(payload(response).ok, false);
  assert.equal(payload(response).error, 'provider_failed');
});

test('automatic text routing discovers providers before one action and never retries an uncertain dispatch', async () => {
  const { tapText } = require('../bin/device-provider');
  const calls = [];
  const ctx = { explicitPackageName: true, packageName: 'contract.app' };
  const foreground = { ok: true, packageName: 'contract.app', component: 'contract.app/.Main' };
  const deps = {
    foregroundWindow: async () => foreground,
    bridgeTree: async () => { calls.push('observe-native'); return { ok: true, root: { visible: true, enabled: true, bounds: { left: 0, top: 0, right: 400, bottom: 800 }, children: [] } }; },
    flutterNodes: async () => { calls.push('observe-flutter'); return { nodes: [flutterNode({ text: '设置', bounds: { left: 10, top: 20, right: 30, bottom: 40 } })], viewport: { devicePixelRatio: 3 } }; },
    uiaTree: async () => { calls.push('observe-uia'); throw new Error('should not reach uia'); },
    flutterAction: async (_ctx, action) => { calls.push(action); return { ok: false, error: 'action_result_unknown', ambiguous: true }; },
    tap: async () => { calls.push('wrong-dispatch'); return { ok: true }; },
  };
  const result = await tapText(ctx, '设置', {}, deps);
  assert.equal(result.provider, 'flutter');
  assert.equal(result.ambiguous, true);
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ['observe-native', 'observe-flutter', 'observe-native', 'observe-flutter', { action: 'tapTarget', selector: { text: '设置' }, targetRef: flutterRef('e1') }]);
  assert.deepEqual(result.observations.map(item => item.status), ['not-found', 'matched']);
  calls.length = 0;
  const nativeOnly = await tapText(ctx, '设置', { provider: 'native' }, deps);
  assert.equal(nativeOnly.error, 'target_not_found');
  assert.deepEqual(calls, ['observe-native']);
});

test('automatic text routing permits read-only discovery failure but refuses ambiguous or changed targets', async () => {
  const { tapText } = require('../bin/device-provider');
  const ctx = { explicitPackageName: true, packageName: 'contract.app' };
  const foreground = { ok: true, packageName: 'contract.app', component: 'contract.app/.Main' };
  const xml = require('../test-support/uia-target-fixture').uiaXml('<hierarchy><node package="contract.app" text="设置" bounds="[10,20][30,40]" enabled="true" /></hierarchy>');
  let dispatches = 0;
  const deps = {
    foregroundWindow: async () => foreground,
    bridgeTree: async () => { throw new Error('SDK unavailable'); },
    flutterNodes: async () => ({ ok: false, error: 'no_flutter_tree' }),
    uiaTree: async () => xml,
    tap: async () => { throw new Error('UIA text must not dispatch coordinates'); },
    uiaTap: async (_ctx, binding) => {
      dispatches++; assert.equal(binding.target.selector.value, '设置');
      assert.equal(binding.target.selector.packageName, 'contract.app'); assert.ok(binding.target.ref);
      return { ok: true };
    },
  };
  const result = await tapText(ctx, '设置', {}, deps);
  assert.equal(result.ok, true); assert.equal(result.provider, 'uia'); assert.equal(dispatches, 1);
  const duplicate = await tapText(ctx, '设置', {}, { ...deps, uiaTree: async () => xml + xml });
  assert.equal(duplicate.error, 'target_ambiguous'); assert.equal(duplicate.dispatched, false); assert.equal(dispatches, 1);
  let reads = 0;
  const changed = await tapText(ctx, '设置', { provider: 'uia' }, { ...deps,
    foregroundWindow: async () => (++reads === 1 ? foreground : { ...foreground, component: 'contract.app/.Other' }),
  });
  assert.equal(changed.error, 'foreground_changed_during_observation'); assert.equal(dispatches, 1);
});

test('Script discovery is first-class, and fixture permissions are opt-in with the same mutation lease', async () => {
  const { createScriptHostPort } = require('../bin/script/script-host-port');
  const { createDeviceMutationLease } = require('../bin/shared-kernel/device-mutation-lease');
  const { authorizeCommand, catalogPayload } = require('../bin/script/script-catalog');
  assert.deepEqual(Object.keys(capabilityPayload().domains).slice(0, 2), ['execution', 'evidence']);
  for (const command of ['script', 'intent']) assert.equal(capabilityPayload({ command }).role, 'execution');
  assert.equal(authorizeCommand('clear-app-data').ok, false);
  assert.equal(authorizeCommand('clear-app-data', ['app.lifecycle']).ok, true);
  assert.equal(authorizeCommand('permission-revoke', ['app.permissions']).ok, true);
  assert.equal(authorizeCommand('ios-tap').ok, true);
  assert.deepEqual(catalogPayload().executablePlatforms, ['android', 'ios', 'web']);
  assert.equal(capabilityPayload({ command: 'ios-tap' }).entrypoints.script, true);
  const lease = createDeviceMutationLease(); let actions = 0;
  const host = createScriptHostPort({ target, permissions: ['app.lifecycle'], mutationLease: lease,
    actions: async () => { actions++; return { ok: true }; }, executionId: 'setup' });
  const held = lease.acquire(target.serial);
  assert.equal((await host.call('clear-app-data')).error, 'target_busy');
  held.release();
  const cleared = await host.call('clear-app-data');
  assert.equal(cleared.ok, true); assert.equal(actions, 1); assert.match(cleared.execution.actionId, /^setup:/);
  const capture = createScriptHostPort({ target, permissions: ['capture.read'], actions: async () => { actions++; } });
  assert.equal((await capture.call('webview-network', { script: 'doSomething()' })).error, 'capture_mutation_not_allowed');
  assert.equal(actions, 1);
});

test('Script requires platform-discriminated targets and hashes target and permissions for restore', () => {
  const { compileScriptSpec } = require('../bin/script/script-spec');
  const script = { schemaVersion: 'aab.code-script/v1', language: 'javascript', source: 'module.exports.main = async () => 1;', target };
  assert.equal(compileScriptSpec({ ...script, target: { deviceId: 'iphone', bundleId: 'app' } }).error, 'invalid_argument');
  const original = compileScriptSpec(script);
  assert.notEqual(original.hash, compileScriptSpec({ ...script, target: { ...target, serial: 'different-phone' } }).hash);
  assert.notEqual(original.hash, compileScriptSpec({ ...script, permissions: ['app.lifecycle'] }).hash);
});

test('unknown capability filters fail explicitly and Script is available through the common entry', async () => {
  assert.equal(payload(await callTool('capabilities', { includeOptions: 'true' })).error, 'invalid_argument');
  assert.equal(payload(await callTool('capabilities', { domain: 'missing' })).error, 'unknown_domain');
  assert.equal((await callTool('capabilities', { command: 'batch' })).isError, true);
  const { executeCommand } = require('../test-support/host-client');
  assert.equal((await executeCommand('script', { operation: 'runtime-status' })).ok, true);
});
