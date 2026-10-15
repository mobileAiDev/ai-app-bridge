#!/usr/bin/env node
'use strict';

// Host-only installed-package acceptance. Run on Windows to produce Windows
// evidence; a run on another OS is explicitly labelled as a harness validation.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');
const { runCli } = require('../../test-support/cli-client');
const { createBuildToolDenial } = require('../../test-support/build-tool-denial');

const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const terminal = new Set(['completed', 'failed', 'cancelled']);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function hashDirectory(directory) {
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else {
        assert(entry.isFile(), 'Expected a regular evidence file: ' + file);
        files.push({ path: path.relative(directory, file), sha256: sha256(file) });
      }
    }
  }
  visit(directory);
  return files;
}

async function main(directory) {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('Usage: npm run verify:windows -- /path/to/new-evidence-directory');
  const npm = process.env.npm_execpath;
  if (!npm || !fs.statSync(npm).isFile()) throw new Error('Run through npm run verify:windows so npm_execpath identifies npm-cli.js.');
  const out = path.resolve(directory);
  fs.mkdirSync(out); // Preserve previous runs, including failures.
  const source = path.resolve(__dirname, '../..');
  const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
  const report = { ok: false, platform: process.platform, arch: process.arch, node: process.version,
    scope: process.platform === 'win32' ? 'Windows installed Host package' : 'Host harness validation; NOT Windows runtime acceptance',
    deviceOperations: false, startedAtMs: Date.now(), checks: {} };
  const env = { ...process.env, NODE_PATH: '', AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'host-facts'),
    AI_APP_BRIDGE_RUNTIME_HOME: path.join(out, 'runtimes'), AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR: path.join(out, 'ownership'),
    AI_APP_BRIDGE_EXECUTOR_HOME: path.join(out, 'executors'), AI_APP_BRIDGE_POWER_AUTO: 'off',
    ADB: path.join(out, 'no-device-adb'), AI_APP_BRIDGE_DEVICECTL: path.join(out, 'no-device-devicectl') };
  const commands = [];
  const npmRun = (name, args, cwd, commandEnv) => {
    const entry = { name, executable: process.execPath, arguments: [npm, ...args], cwd, startedAtMs: Date.now() };
    commands.push(entry);
    const log = fs.openSync(path.join(out, name + '.log'), 'wx');
    try {
      const result = execFileSync(process.execPath, entry.arguments, {
        cwd, env: commandEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', log], timeout: 300000, maxBuffer: 16 * 1024 * 1024,
      });
      fs.writeSync(log, result);
      entry.exitCode = 0;
      return result;
    } catch (error) {
      if (error.stdout) fs.writeSync(log, error.stdout);
      entry.exitCode = error.status;
      entry.error = error.message;
      throw error;
    } finally { entry.completedAtMs = Date.now(); fs.closeSync(log); write('npm-commands.json', commands); }
  };
  let installed, cli, client;
  let clientNumber = 0;
  const clients = new Set();
  const runtimePids = new Set();
  const connect = async () => {
    const number = ++clientNumber;
    const current = createMcpClient({ serverPath: path.join(installed, 'bin/mcp-server.js'), cwd: path.dirname(path.dirname(installed)), env,
      transcriptPath: path.join(out, 'mcp-' + number + '.jsonl'), stderrPath: path.join(out, 'mcp-' + number + '.stderr.log') });
    clients.add(current);
    await current.initialize();
    client = current;
  };
  const disconnect = async () => {
    await client.close({ stopRuntime: false, stdinEof: true });
    clients.delete(client);
    client = null;
  };
  const run = async (command, args) => payloadOf(await client.request('tools/call', {
    name: 'run', arguments: { command, extract: null, arguments: args },
  }));
  const settled = async (invoke, state) => {
    const deadline = Date.now() + 30000;
    while (!terminal.has(state.status) && state.status !== 'waiting_for_agent' && Date.now() < deadline) {
      state = await invoke('script', { operation: 'wait', operationId: state.operationId, afterSequence: state.eventSequence, waitMs: 1000 });
    }
    assert(terminal.has(state.status) || state.status === 'waiting_for_agent', JSON.stringify(state));
    return state;
  };
  const spec = (sourceText, extra = {}) => ({ schemaVersion: 'aab.code-script/v1', language: 'javascript',
    target: null, source: sourceText, permissions: ['app.workflow'], policy: { timeoutMs: 30000 }, ...extra });
  const resultOf = async (invoke, operationId) => {
    const value = await invoke('script', { operation: 'result', operationId });
    assert.equal(value.ok, true, JSON.stringify(value));
    assert.equal(value.status, 'completed');
    assert.equal(value.persisted, true);
    return value;
  };
  try {
    const denied = createBuildToolDenial(path.join(out, 'denied-build-tools'), env);
    const packed = JSON.parse(npmRun('pack', ['pack', '--json', '--pack-destination', out], source, env))[0];
    write('pack.json', packed);
    const tarball = path.join(out, packed.filename);
    report.package = { name: packed.name, version: packed.version, tarball, sha256: sha256(tarball), integrity: packed.integrity };
    const expectedFiles = packed.files.map(entry => ({ path: entry.path, bytes: entry.size, sha256: sha256(path.join(source, entry.path)) }));
    write('expected-files.json', expectedFiles);
    const install = path.join(out, 'installed package 中文');
    fs.mkdirSync(install);
    fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({ name: 'aab-windows-installed-validation', private: true }) + '\n');
    npmRun('install', ['install', '--foreground-scripts', '--prefer-offline', '--no-audit', '--no-fund', tarball], install, denied.env);
    installed = path.join(install, 'node_modules/@mobileaidev/ai-app-bridge');
    const installLog = fs.readFileSync(path.join(out, 'install.log'), 'utf8');
    assert.match(installLog, /@mobileaidev\/segmented-fact-store-native@[^\s]+ install/);
    assert.match(installLog, /FactStore prebuild /);
    assert.doesNotMatch(installLog, /gyp info|node-gyp rebuild/);
    assert.equal(fs.existsSync(denied.attempts), false, 'Installation tried a denied build tool');
    const actualFiles = expectedFiles.map(entry => {
      const file = path.join(installed, entry.path);
      const actual = { path: entry.path, bytes: fs.statSync(file).size, sha256: sha256(file) };
      assert.deepEqual(actual, entry, 'Installed bytes differ: ' + entry.path);
      return actual;
    });
    write('installed-files.json', actualFiles);
    const native = JSON.parse(execFileSync(process.execPath, ['-e',
      "require('@mobileaidev/segmented-fact-store-native');process.stdout.write(JSON.stringify(require('@mobileaidev/segmented-fact-store-native/binding-path').resolveBinding()))"],
    { cwd: installed, env, encoding: 'utf8' }));
    assert(native.path.startsWith(fs.realpathSync(installed) + path.sep), native.path);
    assert.equal(sha256(native.path), native.sha256);
    const sourceNative = path.join(source, 'node_modules/@mobileaidev/segmented-fact-store-native');
    const currentManifest = JSON.parse(fs.readFileSync(path.join(sourceNative, 'prebuilds/manifest.json')));
    assert.equal(native.sha256, currentManifest.artifacts[native.target].sha256);
    assert.equal(native.sha256, sha256(path.join(sourceNative, 'prebuilds', native.target, 'segmented_fact_store.node')));
    report.checks.install = { foregroundLifecycle: true, compiled: false, denialFixtureProved: true,
      verifiedFiles: actualFiles.length, native };
    cli = async (command, args, allowFailure = false) => {
      const value = await runCli(command, args, { cliPath: path.join(installed, 'bin/ai-app-bridge.js'), cwd: install, env, timeoutMs: 60000 });
      fs.appendFileSync(path.join(out, 'cli.jsonl'), JSON.stringify({ command, args, ...value }) + '\n');
      if (!allowFailure) assert.equal(value.code, 0, JSON.stringify(value));
      return value.value;
    };
    const initial = await cli('runtime', { operation: 'status' });
    assert.equal(initial.status, 'stopped');
    const owner = await cli('runtime', { operation: 'start' });
    assert.equal(owner.ok, true); assert.equal(typeof owner.runtimeId, 'string');
    runtimePids.add(owner.pid);
    await connect();
    const connected = await run('runtime', { operation: 'status' });
    assert.equal(connected.runtimeId, owner.runtimeId); assert.equal(connected.compatible, true);
    report.checks.sharedRuntime = { runtimeId: owner.runtimeId, cliPid: owner.pid, mcpPid: connected.pid };

    const concurrent = await settled(run, await run('script', { operation: 'start', waitMs: 10000,
      script: spec("module.exports.main = async ctx => { const reads = await Promise.all(Array.from({length:8}, () => ctx.call('runtime',{operation:'status'}))); if(reads.some(row=>!row.ok)) throw new Error(JSON.stringify(reads)); return reads.map(row=>row.result.runtimeId); };") }));
    assert.equal(concurrent.status, 'completed', JSON.stringify(concurrent));
    const concurrentResult = await resultOf(cli, concurrent.operationId);
    assert.deepEqual(concurrentResult.result, Array(8).fill(owner.runtimeId));
    report.checks.javascriptConcurrentStatus = { operationId: concurrent.operationId, count: 8, runtimeId: owner.runtimeId };
    const inputs = { text: '中文输入：杭州订单🍜', nested: { message: '恢复后继续' }, count: 7 };
    const python = await settled(run, await run('script', { operation: 'start', waitMs: 10000, script: spec(
      'def main(ctx):\n    return {"输入": ctx.inputs, "结果": "中文结果✅"}\n',
      { language: 'python', inputs, permissions: [] }) }));
    assert.equal(python.status, 'completed', JSON.stringify(python));
    const pythonResult = await resultOf(cli, python.operationId);
    assert.deepEqual(pythonResult.result, { 输入: inputs, 结果: '中文结果✅' });
    report.checks.pythonUnicode = { operationId: python.operationId, result: pythonResult.result };

    const gate = path.join(out, 'disconnect-gate');
    const disconnected = await run('script', { operation: 'start', script: spec([
      "const fs = require('node:fs');",
      'module.exports.main = async ctx => {',
      "  await ctx.progress({phase:'waiting-for-disconnect'});",
      '  while(!fs.existsSync(ctx.inputs.gate)) await new Promise(resolve=>setTimeout(resolve,25));',
      "  return {continued:true, value:'断开后完成'};",
      '};',
    ].join('\n'), { inputs: { gate }, permissions: [] }) });
    assert.equal(disconnected.ok, true, JSON.stringify(disconnected));
    await disconnect();
    fs.writeFileSync(gate, 'MCP is closed\n', { flag: 'wx' });
    const afterDisconnect = await settled(cli, await cli('script', { operation: 'status', operationId: disconnected.operationId }));
    assert.equal(afterDisconnect.status, 'completed');
    assert.deepEqual((await resultOf(cli, disconnected.operationId)).result, { continued: true, value: '断开后完成' });
    await connect();
    assert.equal((await run('runtime', { operation: 'status' })).runtimeId, owner.runtimeId);
    report.checks.mcpDisconnect = { operationId: disconnected.operationId, continuedAfterStdinEof: true };

    const asking = await settled(run, await run('script', { operation: 'start', waitMs: 10000,
      script: spec("module.exports.main = async ctx => ({answer:await ctx.askAgent({question:'请选择后续分支'})});", { permissions: [] }) }));
    assert.equal(asking.status, 'waiting_for_agent');
    const question = asking.pendingQuestion;
    assert(question);
    await disconnect();
    const waiting = await cli('script', { operation: 'status', operationId: asking.operationId });
    assert.equal(waiting.status, 'waiting_for_agent'); assert.deepEqual(waiting.pendingQuestion, question);
    const decision = { branch: '继续', approved: true };
    const decided = await settled(cli, await cli('script', { operation: 'decide', operationId: asking.operationId,
      requestId: question.requestId, revision: question.revision, decision, waitMs: 10000 }));
    assert.equal(decided.status, 'completed'); assert.deepEqual((await resultOf(cli, asking.operationId)).result, { answer: decision });
    await connect();
    assert.equal((await run('runtime', { operation: 'status' })).runtimeId, owner.runtimeId);
    report.checks.askAgent = { operationId: asking.operationId, sameQuestionAfterDisconnect: true, cliDecision: true };

    const recordingDir = path.join(out, 'checkpoint-recording');
    const effects = path.join(out, 'checkpoint-effects.txt');
    const checkpoint = await settled(run, await run('script', { operation: 'start', waitMs: 10000, recordingDir,
      script: spec([
        "const fs = require('node:fs');",
        'module.exports.main = async ctx => {',
        '  const state = ctx.resume();',
        '  if (!state) {',
        "    fs.appendFileSync(ctx.inputs.effects,'一次\\n');",
        "    const before = await ctx.call('runtime',{operation:'status'},{label:'before-checkpoint'});",
        '    if(!before.ok) throw new Error(JSON.stringify(before));',
        "    await ctx.checkpoint('ready',{phase:'continue',text:'保留原状态'});",
        '    process.exit(31);',
        '  }',
        "  const after = await ctx.call('runtime',{operation:'status'},{label:'after-resume'});",
        '  if(!after.ok) throw new Error(JSON.stringify(after));',
        "  return {state,effects:fs.readFileSync(ctx.inputs.effects,'utf8')};",
        '};',
      ].join('\n'), { inputs: { effects }, policy: { timeoutMs: 30000, restartPolicy: 'checkpoint' } }) }));
    assert.equal(checkpoint.status, 'failed'); assert.equal(checkpoint.error, 'child_crashed');
    const attemptsBefore = fs.readdirSync(recordingDir).filter(name => name.startsWith('attempt-'));
    assert.equal(attemptsBefore.length, 1);
    const firstAttempt = path.join(recordingDir, attemptsBefore[0]);
    const firstHashes = hashDirectory(firstAttempt);
    assert(firstHashes.length > 0);
    assert.equal((await cli('runtime', { operation: 'stop', timeoutMs: 10000 })).ok, true);
    await disconnect();
    await connect();
    const resumed = await settled(run, await run('script', { operation: 'resume', operationId: checkpoint.operationId, waitMs: 10000 }));
    assert.equal(resumed.operationId, checkpoint.operationId);
    assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
    const recovered = await resultOf(cli, checkpoint.operationId);
    assert.deepEqual(recovered.result, { state: { phase: 'continue', text: '保留原状态' }, effects: '一次\n' });
    const replacement = await run('runtime', { operation: 'status' });
    runtimePids.add(replacement.pid); assert.notEqual(replacement.runtimeId, owner.runtimeId);
    assert.equal(fs.readdirSync(recordingDir).filter(name => name.startsWith('attempt-')).length, 2);
    assert.deepEqual(hashDirectory(firstAttempt), firstHashes, 'Original recording must remain immutable');
    const rootIdentity = JSON.parse(fs.readFileSync(path.join(recordingDir, 'script-recording.json'), 'utf8'));
    assert.equal(rootIdentity.operationId, checkpoint.operationId);
    const exported = await run('evidence', { operation: 'export', namespace: 'script', operationId: checkpoint.operationId,
      outputDir: path.join(out, 'checkpoint-archive'), includeRecordedPayloads: true });
    assert.equal(exported.ok, true, JSON.stringify(exported));
    assert.equal(exported.recordedPayloads.counts.scriptCalls, 2);
    const verified = await cli('evidence', { operation: 'verify', archiveDir: exported.archiveDir, manifestSha256: exported.manifestSha256 });
    assert.equal(verified.ok, true, JSON.stringify(verified));
    assert.deepEqual((await resultOf(run, python.operationId)).resultRef, pythonResult.resultRef);
    report.checks.checkpointRecovery = { operationId: checkpoint.operationId, originalRuntimeId: owner.runtimeId,
      resumedRuntimeId: replacement.runtimeId, attempts: 2, firstAttemptImmutable: true, effects: recovered.result.effects,
      archive: exported.archiveDir, manifestSha256: exported.manifestSha256, archiveVerified: true, priorResultPreserved: true };

    const forbidden = path.join(out, 'after-cancel-should-not-exist');
    const cancellable = await settled(run, await run('script', { operation: 'start', waitMs: 10000,
      script: spec("module.exports.main=async ctx=>{await ctx.askAgent({question:'Cancellation boundary'});require('node:fs').writeFileSync(ctx.inputs.forbidden,'unexpected');return true;};",
        { inputs: { forbidden }, permissions: [] }) }));
    assert.equal(cancellable.status, 'waiting_for_agent');
    const cancelled = await settled(run, await run('script', { operation: 'cancel', operationId: cancellable.operationId }));
    assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancelled));
    assert.equal(fs.existsSync(forbidden), false);
    report.checks.cancel = { operationId: cancellable.operationId, status: cancelled.status, noPostCancelEffect: true };
    report.ok = true;
  } catch (error) {
    report.error = error.stack || String(error);
    throw error;
  } finally {
    const failures = [];
    for (const open of clients) {
      try { await open.close({ stopRuntime: false, stdinEof: true }); }
      catch (error) { failures.push(error.message); }
    }
    if (cli) {
      try {
        const stopped = await cli('runtime', { operation: 'stop', timeoutMs: 10000 });
        assert.equal(stopped.ok, true);
        let status;
        const deadline = Date.now() + 10000;
        do { status = await cli('runtime', { operation: 'status' }); if (status.status !== 'stopped') await sleep(50); }
        while (status.status !== 'stopped' && Date.now() < deadline);
        assert.equal(status.status, 'stopped', JSON.stringify(status));
        for (const pid of runtimePids) {
          let live = true;
          try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') live = false; else throw error; }
          assert.equal(live, false, 'Runtime process still alive: ' + pid);
        }
        report.checks.cleanup = { stopped: true, runtimePids: [...runtimePids], noRuntimeProcesses: true };
      } catch (error) { failures.push(error.stack || error.message); }
    }
    if (failures.length) { report.ok = false; report.cleanupErrors = failures; process.exitCode = 1; }
    report.completedAtMs = Date.now();
    write('report.json', report);
    process.stdout.write(JSON.stringify({ ok: report.ok, platform: report.platform, scope: report.scope, checks: Object.keys(report.checks), report: path.join(out, 'report.json') }) + '\n');
  }
  assert.equal(report.ok, true, JSON.stringify(report));
  return report;
}

if (require.main === module) main(process.argv[2]).catch(error => { process.stderr.write((error.stack || error) + '\n'); process.exitCode = 1; });
module.exports = { main };
