'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFactStore } = require('../bin/fact-store');
const { createSegmentedEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { createScriptSupervisor } = require('../bin/script/script-supervisor');
const { handle } = require('../bin/script/script-entry');
const { compileScriptSpec } = require('../bin/script/script-spec');
const { codeRuntimeCheckpoint } = require('../bin/script/script-durable-restore');
const { validateCommandArguments, parseCliOptions } = require('../bin/command-registry');
const { sanitizePersistentValue } = require('../bin/fact-codec');
const { runCli } = require('../test-support/cli-client');
const actions = async () => assert.fail('Recovery must not issue a device command');
const source = `module.exports.main = async ctx => {
  if (ctx.resume()) return { inputs: ctx.inputs, state: ctx.resume() };
  await ctx.checkpoint('ready', { baseUrl: ctx.inputs.baseUrl });
  process.exit(31);
};`;

function fixture(t, program = source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-original-spec-'));
  const sourcePath = path.join(root, 'entry.js');
  fs.writeFileSync(sourcePath, program);
  const stores = [], supervisors = [];
  t.after(async () => {
    for (const supervisor of supervisors) await supervisor.cancelAll();
    for (const store of stores) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const script = { schemaVersion: 'aab.code-script/v1', language: 'javascript', sourcePath, cwd: root,
    target: { platform: 'android', serial: 'no-device-io', packageName: 'example.recovery' }, permissions: [],
    inputs: { baseUrl: 'http://10.0.2.2:18199', redirectUri: 'HTTPS://EXAMPLE.test:443/a?view=a%20b' },
    policy: { restartPolicy: 'checkpoint', timeoutMs: 10000 } };
  return { root, sourcePath, script, open() {
    const facts = createFactStore({ directory: path.join(root, 'facts'), profile: '64mb' });
    const supervisor = createScriptSupervisor();
    stores.push(facts); supervisors.push(supervisor);
    return { facts, supervisor, store: createScriptEvidenceStore({ adapter: createSegmentedEvidenceAdapter(facts) }), actions };
  } };
}

async function rejectChangedSpecs(context, operationId, script) {
  for (const [changed, error] of [
    [{ ...script, inputs: { ...script.inputs, baseUrl: 'http://different.test' } }, 'script_hash_mismatch'],
    [{ ...script, target: { ...script.target, packageName: 'example.other' } }, 'script_target_mismatch'],
    [{ ...script, permissions: ['app.read'] }, 'script_permissions_mismatch'],
    [{ ...script, sourcePath: undefined, source: 'module.exports.main=()=>"different program";' }, 'script_hash_mismatch'],
  ]) {
    const candidate = { ...changed };
    if (candidate.sourcePath === undefined) delete candidate.sourcePath;
    const args = { operation: 'resume', operationId, script: candidate };
    validateCommandArguments('script', args);
    const reply = await handle({ ...context, ...args });
    assert.equal(reply.error, error, JSON.stringify(reply));
    if (error === 'script_hash_mismatch') assert.match(reply.message, /exact original specification/);
  }
}

function retained(store, operationId, before) {
  const current = new Map(store.list(operationId).map(row => [row.evidenceId, row]));
  for (const row of before) assert.deepEqual(current.get(row.evidenceId), row);
}

test('real durable checkpoint preserves safe URL inputs and restores frozen source under its original hash', async t => {
  const f = fixture(t), live = f.open();
  const started = await handle({ ...live, operation: 'start', script: f.script, waitMs: 2000 });
  assert.equal(started.error, 'child_crashed');
  const operationId = started.operationId, before = live.store.list(operationId);
  const checkpoint = live.store.latest(operationId, 'checkpoint');
  assert.equal(checkpoint.source, source);
  assert.equal(checkpoint.sourcePath, f.sourcePath);
  assert.deepEqual(checkpoint.inputs, f.script.inputs);
  assert.equal(checkpoint.hash, started.hash);
  live.facts.close();
  fs.renameSync(f.sourcePath, path.join(f.root, 'original-entry-retained.js'));
  const cold = f.open();
  const resumed = await handle({ ...cold, operation: 'resume', operationId, waitMs: 2000 });
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.deepEqual(resumed.result, { inputs: f.script.inputs, state: { baseUrl: f.script.inputs.baseUrl } });
  assert.equal(cold.store.latest(operationId, 'checkpoint').hash, started.hash);
  retained(cold.store, operationId, before);
});

test('an old normalized checkpoint requires explicit original spec without changing old evidence or hash', async t => {
  const f = fixture(t), initial = f.open(), compiled = compileScriptSpec(f.script), operationId = 'old-normalized';
  assert.equal(compiled.ok, true);
  const old = codeRuntimeCheckpoint({ spec: compiled.spec, hash: compiled.hash, operationId, actionSequence: 0 },
    { name: 'ready', state: { phase: 'continue' } }, 2);
  // Exact old-code representation: baseUrl changed after the program hash was computed.
  old.inputs = { ...old.inputs, baseUrl: old.inputs.baseUrl + '/' };
  assert.equal((await initial.store.persist('checkpoint', old)).ok, true);
  const before = initial.store.list(operationId);
  initial.facts.close();
  const cold = f.open();
  assert.equal((await handle({ ...cold, operation: 'resume', operationId })).error, 'script_hash_mismatch');
  await rejectChangedSpecs(cold, operationId, f.script);
  assert.equal(cold.supervisor.registry.get(operationId), null, 'rejected specs start no child');
  const args = { operation: 'resume', operationId, script: f.script, waitMs: 2000 };
  validateCommandArguments('script', args);
  const resumed = await handle({ ...cold, ...args });
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.deepEqual(resumed.result.inputs, f.script.inputs);
  assert.equal(cold.store.latest(operationId, 'checkpoint').hash, compiled.hash);
  retained(cold.store, operationId, before);
});

test('registered finished operations validate explicit original specs before restarting', async t => {
  const f = fixture(t), context = f.open();
  const started = await handle({ ...context, operation: 'start', script: f.script, waitMs: 2000 });
  assert.equal(started.error, 'child_crashed');
  const record = context.supervisor.registry.get(started.operationId);
  await rejectChangedSpecs(context, started.operationId, f.script);
  assert.equal(record.finished, true);
  assert.equal(record.spec.source, source);
  const resumed = await handle({ ...context, operation: 'resume', operationId: started.operationId, script: f.script, waitMs: 2000 });
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.deepEqual(resumed.result.inputs, f.script.inputs);
});

test('registered live operations validate explicit specs without replacing the running program', async t => {
  const liveSource = 'module.exports.main=async ctx=>{await ctx.askAgent({question:"pause"});return true;};';
  const f = fixture(t, liveSource), context = f.open();
  const started = await handle({ ...context, operation: 'start', script: f.script, waitMs: 2000 });
  assert.equal(started.status, 'waiting_for_agent');
  const record = context.supervisor.registry.get(started.operationId), runtime = record.runtime;
  await rejectChangedSpecs(context, started.operationId, f.script);
  const resumed = await handle({ ...context, operation: 'resume', operationId: started.operationId, script: f.script });
  assert.equal(resumed.status, 'waiting_for_agent');
  assert.equal(record.runtime, runtime);
  assert.equal(record.spec.source, liveSource);
  assert.equal(resumed.pendingQuestion.requestId, started.pendingQuestion.requestId);
});

test('safe URL inputs and captured JSON retain exact bytes while URL credentials still redact', () => {
  for (const url of ['http://10.0.2.2:18199', 'HTTP://Example.test:80',
    'https://EXAMPLE.test:443/a/../b?view=a%20b&safe=%7e#%41', '  https://example.test  ']) {
    const value = { inputs: { baseUrl: url }, checkpoint: { state: { redirectUri: url } } };
    assert.deepEqual(sanitizePersistentValue(value), value);
    const receiptJson = ' { "url" : ' + JSON.stringify(url) + ' }\n';
    assert.equal(sanitizePersistentValue({ receiptJson }).receiptJson, receiptJson);
  }
  for (const url of ['https://user:private-secret@example.test',
    'https://example.test?tok%65n=private-secret&view=summary',
    'https://example.test?token=private-secret&token=second-secret',
    'https://example.test/tokenpluginfile.php/private-secret/view']) {
    const projected = sanitizePersistentValue({ url });
    assert.doesNotMatch(projected.url, /private-secret|second-secret/);
    assert.match(projected.url, /REDACTED/i);
    assert.deepEqual(sanitizePersistentValue(projected), projected);
  }
});

test('resume optionally accepts the original Script with the complete start spec schema', () => {
  const script = { schemaVersion: 'aab.code-script/v1', language: 'javascript',
    source: 'module.exports.main=()=>true;', inputs: { baseUrl: 'http://10.0.2.2:18199' } };
  const args = { operation: 'resume', operationId: 'retained', script };
  assert.deepEqual(validateCommandArguments('script', args), args);
  assert.deepEqual(parseCliOptions('script', { operation: 'resume', operationId: 'retained', script: JSON.stringify(script) }), args);
  assert.throws(() => validateCommandArguments('script', { ...args, script: { ...script, unexpected: true } }), { code: 'unsupported_argument' });
  const missingSource = { ...script }; delete missingSource.source;
  assert.throws(() => validateCommandArguments('script', { ...args, script: missingSource }));
});

for (const state of ['cold', 'registered']) test(`the original hash accepts an iOS URL before old persistence normalization (${state})`, async t => {
  const f = fixture(t);
  f.script.target = { platform: 'ios', deviceId: 'no-device-io', runtimeUrl: 'http://127.0.0.1:8100' };
  const initial = f.open(), compiled = compileScriptSpec(f.script);
  assert.equal(compiled.ok, true);
  let operationId, context;
  if (state === 'cold') {
    operationId = 'old-ios-url';
    const old = codeRuntimeCheckpoint({ spec: compiled.spec, hash: compiled.hash, operationId, actionSequence: 0 },
      { name: 'ready', state: { phase: 'continue' } }, 2);
    old.target = { ...old.target, runtimeUrl: old.target.runtimeUrl + '/' };
    assert.equal((await initial.store.persist('checkpoint', old)).ok, true);
    initial.facts.close();
    context = f.open();
    assert.equal((await handle({ ...context, operation: 'resume', operationId })).error, 'script_hash_mismatch');
  } else {
    const started = await handle({ ...initial, operation: 'start', script: f.script, waitMs: 2000 });
    assert.equal(started.error, 'child_crashed');
    operationId = started.operationId;
    context = initial;
  }
  const before = context.store.list(operationId);
  const changed = { ...f.script, target: { ...f.script.target, runtimeUrl: 'http://127.0.0.1:8200' } };
  const rejected = await handle({ ...context, operation: 'resume', operationId, script: changed });
  assert.equal(rejected.error, 'script_target_mismatch');
  const resumed = await handle({ ...context, operation: 'resume', operationId, script: f.script, waitMs: 2000 });
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.equal(context.store.latest(operationId, 'checkpoint').hash, compiled.hash);
  retained(context.store, operationId, before);
});

for (const relative of ['sourcePath', 'target.adb']) test(`public CLI cold resume resolves ${relative} in the caller directory`, { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-resume-cwd-'));
  const hostDir = path.join(root, 'host'), callerDir = path.join(root, 'caller'), workDir = path.join(callerDir, 'work');
  fs.mkdirSync(hostDir); fs.mkdirSync(callerDir); fs.mkdirSync(workDir);
  const effectsFile = path.join(root, 'effects.txt'), sourcePath = path.join(callerDir, 'flow.cjs');
  const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(root, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb',
    AI_APP_BRIDGE_RUNTIME_HOME: path.join(root, 'runtimes'), ADB: path.join(root, 'not-installed-adb') };
  const cli = async (command, args, cwd = callerDir) => (await runCli(command, args, { cwd, env })).value;
  t.after(async () => {
    assert.equal((await cli('runtime', { operation: 'stop' }, hostDir)).ok, true);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const program = `module.exports.main=async ctx=>{
    const fs=require('node:fs');
    if(ctx.resume()){
      fs.appendFileSync(ctx.inputs.effectsFile,'continued\\n');
      return {cwd:process.cwd(),target:ctx.target,inputs:ctx.inputs};
    }
    fs.appendFileSync(ctx.inputs.effectsFile,'started\\n');
    await ctx.checkpoint('saved',{continue:true});
    process.exit(31);
  };`;
  fs.writeFileSync(sourcePath, program);
  const target = { platform: 'android', serial: 'no-device-io', packageName: 'example.recovery',
    adb: relative === 'target.adb' ? './wrapper' : path.join(callerDir, 'wrapper') };
  const script = { schemaVersion: 'aab.code-script/v1', language: 'javascript',
    sourcePath: relative === 'sourcePath' ? './flow.cjs' : sourcePath, cwd: './work', target, permissions: [],
    inputs: { baseUrl: 'http://10.0.2.2:18199', effectsFile }, policy: { restartPolicy: 'checkpoint', timeoutMs: 10000 } };
  const initialRuntime = await cli('runtime', { operation: 'start' }, hostDir);
  assert.equal(initialRuntime.ok, true);
  const started = await cli('script', { operation: 'start', script, waitMs: 2000 });
  assert.equal(started.error, 'child_crashed', JSON.stringify(started));
  assert.equal(fs.readFileSync(effectsFile, 'utf8'), 'started\n');
  assert.equal((await cli('runtime', { operation: 'stop' }, hostDir)).ok, true);
  const restoredRuntime = await cli('runtime', { operation: 'start' }, hostDir);
  assert.notEqual(restoredRuntime.runtimeId, initialRuntime.runtimeId);
  const operationId = started.operationId;
  for (const [changed, expected] of [
    [{ ...script, inputs: { ...script.inputs, baseUrl: 'http://other.test' } }, 'script_hash_mismatch'],
    [{ ...script, target: { ...target, packageName: 'example.other' } }, 'script_target_mismatch'],
    [{ ...script, sourcePath: sourcePath + '.different' }, 'script_hash_mismatch'],
  ]) {
    if (changed.sourcePath !== script.sourcePath) fs.writeFileSync(changed.sourcePath, program + '\n// changed');
    const rejected = await cli('script', { operation: 'resume', operationId, script: changed });
    assert.equal(rejected.error, expected, JSON.stringify(rejected));
    assert.equal(fs.readFileSync(effectsFile, 'utf8'), 'started\n', 'rejected resume must not start a child');
  }
  const resumed = await cli('script', { operation: 'resume', operationId, script, waitMs: 2000 });
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.deepEqual(resumed.result, { cwd: fs.realpathSync(workDir),
    target: { ...target, adb: relative === 'target.adb' ? path.join(fs.realpathSync(callerDir), 'wrapper') : target.adb },
    inputs: script.inputs });
  assert.equal(fs.readFileSync(effectsFile, 'utf8'), 'started\ncontinued\n');
  assert.equal((await cli('script', { operation: 'status', operationId })).hash, started.hash);
});
