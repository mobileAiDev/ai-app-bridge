'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { main: session } = require('../recipes/android-test-session');
const { main: launch } = require('../recipes/android-launch-and-wait');
const { createNodeRuntimeAdapter } = require('../bin/script/node-runtime-adapter');
const { compileScriptSpec } = require('../bin/script/script-spec');
const { validateCommandArguments } = require('../bin/command-registry');
const { catalog } = require('../bin/script/recipes');
const sourcePath = path.resolve(__dirname, '../recipes/android-test-session.js');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-recipe-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'restore.json'), calls = [];
  const original = { stay_on_while_plugged_in: '0', accelerometer_rotation: '1', user_rotation: '0',
    default_input_method: 'old.ime/.Keyboard', selected_input_method_subtype: '123',
    input_methods_subtype_history: 'old.ime/.Keyboard;123', show_ime_with_hard_keyboard: null };
  const settings = { ...original };
  const target = { platform: 'android', serial: 'recipe-device' };
  let failWrite = false, unknownWrite = false;
  const call = async (command, args) => {
    assert.equal(command, 'adb-exec'); validateCommandArguments(command, { ...args, serial: target.serial });
    calls.push(args);
    const argv = args.argv;
    let stdout = '';
    if (argv.join(' ') === 'shell am get-current-user') stdout = '10\n';
    else if (argv[1] === 'input') assert.deepEqual(argv.slice(2), ['keyevent', 'KEYCODE_WAKEUP']);
    else if (argv[1] === 'settings') {
      assert.equal(argv[3], '10');
      if (argv[4] === 'get') { assert.equal(args.readOnly, true); stdout = String(settings[argv[6]]) + '\n'; }
      else {
        assert.equal(args.readOnly, false);
        const saved = JSON.parse(fs.readFileSync(stateFile));
        assert.equal(saved.settings.find(item => item.key === argv[6]).attempted, true, 'original value must be durable before dispatch');
        if (!failWrite) settings[argv[6]] = argv[4] === 'delete' ? null : argv[7].startsWith("'") ? argv[7].slice(1, -1).replaceAll("'\\''", "'") : argv[7];
        if (failWrite || unknownWrite) return { ok: false, error: unknownWrite ? 'runtime_connection_lost' : 'adb_exit_nonzero',
          execution: { actionId: 'write-unknown', outcome: unknownWrite ? 'unknown' : 'failed', ambiguous: unknownWrite }, result: null };
      }
    } else if (argv[1] === 'ime') {
      assert.deepEqual(argv.slice(2, 5), ['set', '--user', '10']); settings.default_input_method = argv[5];
      settings.selected_input_method_subtype = '-1'; settings.input_methods_subtype_history = 'new.ime/.Keyboard;-1';
    } else assert.fail(JSON.stringify(argv));
    return { ok: true, execution: { actionId: args.readOnly ? null : `action-${calls.length}`, outcome: 'succeeded' }, result: { stdout } };
  };
  return { directory, stateFile, calls, settings, original, target, call, setFailure: (failed, unknown = false) => { failWrite = failed; unknownWrite = unknown; },
    ctx: inputs => ({ target, sourcePath, inputs: { stateFile, ...inputs }, call }) };
}

test('test-session prepares explicit settings and restores original nulls, rotation and keyboard on the recorded user', async t => {
  const f = fixture(t);
  const prepared = await session(f.ctx({ operation: 'prepare', stayAwake: true, rotation: 1, showImeWithHardware: true, imeId: 'new.ime/.Keyboard', wake: true }));
  assert.equal(prepared.ok, true, JSON.stringify(prepared)); assert.equal(prepared.recoveryRecordSaved, true);
  assert.equal(f.settings.user_rotation, '1'); assert.equal(f.settings.default_input_method, 'new.ime/.Keyboard');
  validateCommandArguments(prepared.restore.command, prepared.restore.arguments);
  assert.ok(f.calls.some(call => call.argv.includes('KEYCODE_WAKEUP')));
  const wakeCount = f.calls.filter(call => call.argv.includes('KEYCODE_WAKEUP')).length;
  const restored = await session(f.ctx({ operation: 'restore' }));
  assert.equal(restored.ok, true, JSON.stringify(restored)); assert.deepEqual(f.settings, f.original);
  assert.equal(f.calls.filter(call => call.argv.includes('KEYCODE_WAKEUP')).length, wakeCount);
  const mutations = f.calls.filter(call => !call.readOnly).length;
  assert.equal((await session(f.ctx({ operation: 'restore' }))).ok, true);
  assert.equal(f.calls.filter(call => !call.readOnly).length, mutations, 'restoring already restored values issues no writes');
});

test('an unknown preparation write remains visible and can be restored without replaying preparation', async t => {
  const f = fixture(t); f.setFailure(false, true);
  const prepared = await session(f.ctx({ operation: 'prepare', stayAwake: true, rotation: 1 }));
  assert.equal(prepared.ok, false); assert.equal(prepared.results[0].receipt.execution.outcome, 'unknown');
  assert.equal(f.settings.stay_on_while_plugged_in, '7'); assert.equal(f.settings.user_rotation, '0');
  assert.equal(f.calls.filter(call => !call.readOnly).length, 1);
  f.setFailure(false);
  assert.equal((await session(f.ctx({ operation: 'restore' }))).ok, true); assert.deepEqual(f.settings, f.original);
});

test('existing recovery files are preserved and bad inputs or a different device never alter settings', async t => {
  const f = fixture(t); await session(f.ctx({ operation: 'prepare' }));
  const frozen = fs.readFileSync(f.stateFile, 'utf8');
  assert.equal((await session(f.ctx({ operation: 'prepare', stayAwake: true }))).error, 'EEXIST');
  const wrongDevice = await session({ ...f.ctx({ operation: 'restore' }), target: { platform: 'android', serial: 'another-device' } });
  assert.equal(wrongDevice.ok, false); assert.equal(wrongDevice.recoveryRecordSaved, false);
  await assert.rejects(() => session(f.ctx({ operation: 'prepare', rotation: '90' })), /rotation/);
  assert.equal(f.calls.some(call => !call.readOnly), false); assert.equal(fs.readFileSync(f.stateFile, 'utf8'), frozen);
});

test('a killed Script child leaves a usable restore record before its first device write', async t => {
  const f = fixture(t), adapter = createNodeRuntimeAdapter();
  const compiled = compileScriptSpec({ schemaVersion: 'aab.code-script/v1', language: 'javascript', sourcePath, target: f.target,
    inputs: { operation: 'prepare', stateFile: f.stateFile, stayAwake: true }, policy: { timeoutMs: 5000 } });
  assert.equal(compiled.ok, true);
  const started = await adapter.start({ spec: compiled.spec, control: () => ({ status: 'running' }), emit() {},
    host: { call: async (command, args) => {
      const reply = await f.call(command, args);
      if (!args.readOnly) { setImmediate(() => adapter.stop()); return new Promise(() => {}); }
      return reply;
    } } });
  assert.equal(started.ok, false);
  assert.equal(f.settings.stay_on_while_plugged_in, '7');
  const restore = await createNodeRuntimeAdapter().start({ spec: { ...compiled.spec, inputs: { operation: 'restore', stateFile: f.stateFile } },
    control: () => ({ status: 'running' }), emit() {}, host: { call: f.call } });
  assert.equal(restore.ok, true, JSON.stringify(restore)); assert.equal(restore.result.ok, true);
  assert.equal(restore.result.restore.arguments.script.sourcePath, sourcePath);
  assert.deepEqual(f.settings, f.original);
});

test('launch-and-wait launches once and leaves condition polling to the read command', async () => {
  const calls = [], target = { platform: 'android', serial: 'phone', packageName: 'example.app' };
  const result = await launch({ target, inputs: { readyText: 'Ready' }, call: async (command, args) => {
    validateCommandArguments(command, { serial: target.serial, packageName: target.packageName, ...args }); calls.push({ command, args });
    return { ok: true, result: { matched: command === 'wait-text' } };
  } });
  assert.equal(result.ok, true); assert.deepEqual(calls.map(call => call.command), ['launch-app', 'wait-text']);
  assert.equal(calls[1].args.provider, 'uia');
  let dispatched = 0;
  const failed = await launch({ target, inputs: { readyText: 'Ready' }, call: async () => { dispatched++; return { ok: false, execution: { ambiguous: true } }; } });
  assert.equal(failed.step, 'launch'); assert.equal(dispatched, 1);
});

test('recipe discovery refers to shipped editable sources and valid Script requests', () => {
  const advertised = require('../bin/command-discovery').capabilities({ command: 'script', operation: 'start' }).catalog.recipes;
  assert.equal(advertised.length, 2); assert.deepEqual(advertised, catalog());
  const files = require('../package.json').files; assert.ok(files.includes('recipes'));
  for (const recipe of advertised) {
    assert.equal(fs.existsSync(recipe.sourcePath), true);
    validateCommandArguments(recipe.start.command, recipe.start.arguments);
    assert.equal(compileScriptSpec(recipe.start.arguments.script).ok, true);
  }
});

test('launch recipe retains outcomes and foreground identities without repeated diagnostic dumps', async () => {
  const target = { platform: 'android', serial: 'phone', packageName: 'example.app' };
  const raw = { ok: true, execution: { actionId: 'original-action' }, executionReceipt: { actionId: 'original-action', status: 'completed' },
    result: { conditions: { present: ['Ready'] }, matched: { ok: true, observedAtMs: 42 },
      foreground: { packageName: 'example.app', windowIdentity: 'original-window', evidence: { window: 'dump'.repeat(40000) } } } };
  const small = await launch({ target, inputs: { readyText: 'Ready' }, call: async () => raw });
  assert.equal(small.ready.executionReceipt.actionId, 'original-action');
  assert.equal(small.ready.result.foreground.windowIdentity, 'original-window');
  assert.equal(small.ready.result.foreground.rawEvidenceOmitted, true);
  assert.equal(small.ready.result.matched.observedAtMs, 42); assert.ok(JSON.stringify(small).length < 16384);
  const full = await launch({ target, inputs: { readyText: 'Ready', fullResult: true }, call: async () => raw });
  assert.equal(full.ready.result.foreground.evidence.window.length, 160000);
  assert.equal(raw.result.foreground.evidence.window.length, 160000, 'projection never mutates the original receipt');
});

test('Python receives the same original Script target and source path', async () => {
  const sourcePath = '/declared/script.py', target = { platform: 'android', serial: 'python-recipe-device' };
  const adapter = require('../bin/script/python-runtime-adapter').createPythonRuntimeAdapter();
  assert.equal(adapter.unavailable, undefined);
  const result = await adapter.start({ spec: { source: 'def main(ctx):\n    return {"target": ctx.target, "sourcePath": ctx.source_path}\n',
    sourcePath, target, inputs: {}, policy: { timeoutMs: 10000, maxOutputBytes: 4096, maxProgressBytes: 4096 } },
    control: () => ({ status: 'running' }), emit() {}, host: {} });
  assert.deepEqual(result, { ok: true, result: { target, sourcePath } });
});

test('CLI and MCP read doctor/recipes locally even with an invalid FactStore profile', async t => {
  const f = fixture(t);
  const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(f.directory, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: 'invalid',
    AI_APP_BRIDGE_RUNTIME_HOME: path.join(f.directory, 'runtimes') };
  const { createMcpClient, payloadOf } = require('../scripts/validation/mcp-jsonrpc-client');
  const client = createMcpClient({ serverPath: path.resolve(__dirname, '../bin/mcp-server.js'), env,
    transcriptPath: path.join(f.directory, 'mcp.jsonl'), stderrPath: path.join(f.directory, 'mcp.stderr') });
  t.after(() => client.close({ stopRuntime: false }));
  await client.initialize();
  const diagnose = payloadOf(await client.request('tools/call', { name: 'run', arguments: { command: 'doctor', arguments: { platform: 'host' } } }));
  assert.equal(diagnose.ok, true); assert.equal(diagnose.checks[0].facts.error, 'invalid_fact_store_profile');
  const recipes = payloadOf(await client.request('tools/call', { name: 'run', arguments: { command: 'script', arguments: { operation: 'recipes', name: 'android-test-session' } } }));
  assert.equal(recipes.recipe.source, fs.readFileSync(sourcePath, 'utf8'));
  const cli = await require('../test-support/cli-client').runCli('script', { operation: 'recipes', name: 'android-test-session' }, { env });
  assert.equal(cli.code, 0); assert.deepEqual(cli.value, recipes);
  assert.equal(fs.existsSync(env.AI_APP_BRIDGE_FACT_STORE_DIR), false);
  assert.equal(fs.existsSync(env.AI_APP_BRIDGE_RUNTIME_HOME), false);
});
