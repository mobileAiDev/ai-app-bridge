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
  assert.equal(advertised.length, 3); assert.deepEqual(advertised, catalog());
  const files = require('../package.json').files; assert.ok(files.includes('recipes'));
  for (const recipe of advertised) {
    assert.equal(fs.existsSync(recipe.sourcePath), true);
    assert.equal(recipe.start.arguments.waitMs, 60000);
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
  assert.equal(diagnose.ok, true); assert.equal(diagnose.checks[0].facts.runtime.state, 'stopped');
  const recipes = payloadOf(await client.request('tools/call', { name: 'run', arguments: { command: 'script', arguments: { operation: 'recipes', name: 'android-test-session' } } }));
  assert.equal(recipes.recipe.source, fs.readFileSync(sourcePath, 'utf8'));
  const cli = await require('../test-support/cli-client').runCli('script', { operation: 'recipes', name: 'android-test-session' }, { env });
  assert.equal(cli.code, 0); assert.deepEqual(cli.value, recipes);
  assert.equal(fs.existsSync(env.AI_APP_BRIDGE_FACT_STORE_DIR), false);
  assert.equal(fs.existsSync(env.AI_APP_BRIDGE_RUNTIME_HOME) && fs.readdirSync(env.AI_APP_BRIDGE_RUNTIME_HOME, { recursive: true }).some(name => /(?:owner|endpoint)\.json$/.test(name)), false);
});

function webPage(epoch = 'current') {
  const control = { elementId: 'e1', tag: 'input', id: 'title', name: '', type: 'text', role: 'textbox',
    ariaLabel: '', placeholder: 'Title', href: '', text: '', editable: true, checked: null,
    interaction: { status: 'ready', point: { x: 30, y: 40 } },
    context: { ancestors: [{ tag: 'article', text: 'FIRST note', truncated: false }] } };
  return { pageRef: { schemaVersion: 'aab.web-dom-target/v1', sessionId: 'web-recipe', runtimeEpoch: epoch,
    targetId: 'main', navigationId: 'navigation', url: 'https://example.test/notes' },
    dom: { url: 'https://example.test/notes', controls: [control], bodyText: '', truncated: false } };
}

test('Web recipe retains complete controls and explicitly routes actions from the chosen fresh observation', async () => {
  const { createWebSteps } = require('../recipes/web-steps');
  const { bindCommandTarget } = require('../bin/shared-kernel/execution-target');
  const page = webPage(), calls = [], receipt = { ok: true, execution: { dispatched: true, ambiguous: false }, result: { changed: true } };
  const target = { platform: 'web', sessionId: 'web-recipe', runtimeEpoch: 'old', targetId: 'main' };
  const web = createWebSteps({ call: async (command, args) => {
    const bound = bindCommandTarget(command, args, target).args;
    validateCommandArguments(command, bound); calls.push({ command, args: bound });
    assert.equal(bound.runtimeEpoch, 'current');
    return command === 'web-dom' ? { ok: true, result: page } : receipt;
  } });
  const observed = await web.read({ runtimeEpoch: 'current' });
  const control = web.one(observed, node => node.placeholder === 'Title');
  const binding = web.bind(observed, control);
  assert.equal(binding.expectedTarget.element, control);
  assert.equal(binding.expectedTarget.pageRef, observed.pageRef);
  assert.equal(await web.action('web-input', observed, control, { value: 'changed' }), receipt);
  assert.deepEqual(calls.map(c => c.command), ['web-dom', 'web-input']);
  assert.deepEqual(calls[1].args.expectedTarget.element.context, control.context);
  assert.equal(calls[1].args.expectedTarget.element.checked, null);
});

test('Web recipe waits for usable controls after URL transition and evaluates an initial observation first', async () => {
  const { createWebSteps } = require('../recipes/web-steps');
  const ready = webPage(), loading = { ...ready, dom: { ...ready.dom, controls: [] } }, calls = [];
  const web = createWebSteps({ call: async (command, args) => {
    calls.push({ command, args });
    assert.equal(command, 'web-dom');
    assert.equal(args.runtimeEpoch, 'current');
    assert(args.timeoutMs > 0 && args.timeoutMs <= 100);
    return { ok: true, result: ready };
  } });
  const usable = page => page.dom.controls.some(c => c.editable && c.interaction.status === 'ready');
  assert.equal(await web.wait(usable, { initial: ready }), ready);
  assert.equal(calls.length, 0);
  assert.equal(await web.wait(usable, { initial: loading, timeoutMs: 100, intervalMs: 1 }), ready);
  assert.equal(calls.length, 1);
  const never = createWebSteps({ call: async (command, args) => ({ ok: true, result: loading }) });
  await assert.rejects(never.wait(usable, { initial: loading, timeoutMs: 5, intervalMs: 1 }), error => {
    assert.equal(error.code, 'web_condition_timeout'); assert.equal(error.observation, loading); return true;
  });
});

test('Web recipe ambiguity and failed or unknown calls stop without refreshing or replaying', async () => {
  const { createWebSteps } = require('../recipes/web-steps');
  const page = webPage(); page.dom.controls.push({ ...page.dom.controls[0], elementId: 'e2' });
  let calls = 0;
  const web = createWebSteps({ call: async () => { calls++; } });
  assert.throws(() => web.one(page, c => c.placeholder === 'Title'), error => {
    assert.equal(error.code, 'web_element_ambiguous'); assert.deepEqual(error.candidates, page.dom.controls); return true;
  });
  assert.throws(() => web.one(page, c => c.text === 'absent'), { code: 'web_element_not_found' });
  assert.equal(calls, 0);
  for (const reply of [ { ok: false, error: 'web_target_changed', dispatched: false, ambiguous: false },
    { ok: false, error: 'action_outcome_unknown', dispatched: true, ambiguous: true, diagnostic: 'retained complete diagnostic '.repeat(5000) } ]) {
    const failed = createWebSteps({ call: async () => { calls++; return reply; } });
    const before = calls;
    await assert.rejects(failed.action('web-click', page, page.dom.controls[0]), error => {
      assert.equal(error.reply, reply); assert.match(error.message, new RegExp(reply.error));
      assert(error.message.length < 256); assert.equal(error.message.includes('retained complete diagnostic'), false); return true;
    });
    assert.equal(calls, before + 1);
    await assert.rejects(failed.wait(() => false, { timeoutMs: 10 }), error => error.reply === reply);
    assert.equal(calls, before + 2);
  }
});

test('Web recipe is discoverable and imported unchanged by the real Script child', async () => {
  const recipe = require('../bin/script/recipes').read({ name: 'web-steps' }).recipe;
  assert.ok(recipe, 'an unfamiliar Web caller can discover the editable helper through existing recipes');
  const { sourcePath: recipePath, ...template } = recipe.start.arguments.script;
  const compiled = compileScriptSpec({ ...template,
    target: { platform: 'web', sessionId: 'web-recipe', runtimeEpoch: 'current', targetId: 'main' },
    source: `const { createWebSteps } = require(${JSON.stringify(recipePath)});
      exports.main = async ctx => { const web = createWebSteps(ctx); const page = await web.read();
        await web.action('web-input', page, web.one(page, c => c.placeholder === 'Title'), {value:'changed'});
        return await web.wait(p => p.dom.bodyText === 'Saved', {initial:page,timeoutMs:1000,intervalMs:1}); };` });
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  const before = webPage(), after = { ...before, dom: { ...before.dom, bodyText: 'Saved' } }, calls = [];
  const result = await createNodeRuntimeAdapter().start({ spec: compiled.spec, control: () => ({ status: 'running' }), emit() {},
    host: { call: async (command, args) => {
      calls.push(command);
      return command === 'web-dom' ? { ok: true, result: calls.length === 1 ? before : after }
        : { ok: true, execution: { dispatched: true }, result: { changed: true } };
    } } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result, after);
  assert.deepEqual(calls, ['web-dom', 'web-input', 'web-dom']);
});
