#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

const options = {};
for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
assert.ok(options.serial && options.output, 'Usage: node run-instrumentation-regression.cjs --serial DEVICE --output NEW_DIRECTORY [--cli CLI_FILE]');
const target = { serial: options.serial, packageName: 'io.github.mobileaidev.aiappbridge.sample' };
const directory = path.resolve(options.output);
fs.mkdirSync(directory, { recursive: false });
const cli = path.resolve(options.cli || path.join(__dirname, '../../../desktop/ai-app-bridge-cli/bin/ai-app-bridge.js'));
const env = { ...process.env, AI_APP_BRIDGE_RUNTIME_HOME: path.join(directory, 'runtime'), AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'facts'), AI_APP_BRIDGE_EXECUTOR_HOME: path.join(directory, 'executors') };
const report = { startedAt: new Date().toISOString(), target, cli, chapters: [], setup: [], cleanup: [] };
const fullChapters = ['native', 'h5', 'windows', 'permissions', 'login-success', 'login-invalid', 'login-network', 'login-timeout', 'login-otp', 'login-home', 'compose'];
const requestedChapters = options.chapters ? options.chapters.split(',') : fullChapters;
assert.ok(requestedChapters.length > 0 && requestedChapters.every(name => fullChapters.includes(name)));
report.scope = options.chapters ? 'diagnostic-subset' : 'full';
report.requestedChapters = requestedChapters;
let sdkPort;
const persist = () => fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
let sequence = 0;
async function run(command, args) {
  const argv = [cli, command];
  for (const [key, value] of Object.entries(args)) argv.push('--' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), typeof value === 'string' ? value : JSON.stringify(value));
  let output;
  try { output = await execFile(process.execPath, argv, { env, maxBuffer: 32 * 1024 * 1024 }); }
  catch (error) { if (!error.stdout) throw error; output = error; }
  const result = JSON.parse(output.stdout).value;
  fs.writeFileSync(path.join(directory, String(++sequence).padStart(3, '0') + '-' + command + '.json'), JSON.stringify(result, null, 2));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
async function script(chapter, identity, extra = {}) {
  const chapterStartedAt = Date.now();
  const python = chapter === 'compose';
  const start = await run('script', { operation: 'start', recordingDir: path.join(directory, 'recording-' + chapter),
    script: { schemaVersion: 'aab.code-script/v1', name: 'sample-full-regression-' + chapter,
      language: python ? 'python' : 'javascript', target: { platform: 'android', ...target, ...(python ? {} : { port: sdkPort }) },
      sourcePath: path.join(__dirname, python ? 'instrumentation-compose.py' : 'instrumentation-regression.js'),
      inputs: { chapter, identity, sdkPort, outputDirectory: directory, ...extra },
      permissions: ['app.test', 'app.read', 'capture.read', 'app.interact'], policy: { timeoutMs: 120000, restartPolicy: 'none' } } });
  let status = start;
  while (!['completed', 'failed', 'cancelled'].includes(status.status)) status = await run('script', { operation: 'wait', operationId: start.operationId, afterSequence: status.eventSequence ?? 0, waitMs: 1000 });
  const result = await run('script', { operation: 'result', operationId: start.operationId });
  assert.equal(result.persisted, true);
  assert.equal(status.status, 'completed', JSON.stringify(result));
  const entry = { chapter, operationId: start.operationId, startedAtMs: chapterStartedAt, completedAtMs: Date.now(), ...result.result };
  if (entry.windowExpected) {
    const output = await execFile('adb', ['-s', target.serial, 'shell', 'run-as', target.packageName, 'cat', 'files/window-contract-fixture.json']);
    const oracle = JSON.parse(output.stdout);
    entry.checks.push({ name: 'App 私有文件独立核对窗口结果', passed: ['backgroundClicks', 'dialogClicks', 'confirmClicks', 'popupClicks', 'childReturns', 'savedInput'].every(key => oracle[key] === entry.windowExpected[key]), actual: oracle });
    entry.ok = entry.ok && entry.checks.every(c => c.passed);
  }
  report.chapters.push(entry);
  persist();
  console.log(JSON.stringify({ chapter, ok: entry.ok, elapsedMs: entry.elapsedMs, checks: entry.checks?.length, failed: entry.checks?.filter(c => !c.passed), error: entry.error }));
  return entry;
}
async function session(chapters, compose = false) {
  const started = performance.now();
  const opened = await run('android-executor', { operation: 'open', ...target,
    instrumentation: target.packageName + '.test/androidx.test.runner.AndroidJUnitRunner',
    testClass: target.packageName + (compose ? '.ComposeBridgeSessionTest' : '.BridgeSessionTest'),
    activity: target.packageName + '.debugbridge.' + (compose ? 'ComposeExecutorFixtureActivity' : 'DebugBridgeNativeTestActivity'), leaseMs: 600000 });
  const identity = { sessionId: opened.sessionId, runtimeEpoch: opened.runtimeEpoch };
  report.setup.push({ kind: 'instrumentation', identity, elapsedMs: performance.now() - started, capabilities: opened.capabilities });
  persist();
  try {
    const probe = require('node:net').createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    sdkPort = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    if (!compose) {
      const deadline = performance.now() + 15000;
      let status;
      do {
        status = await run('status', { ...target, port: sdkPort });
        assert.equal(status.app.packageName, target.packageName);
        if (status.capturePersistence.lifecycleState !== 'OPENING') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (performance.now() < deadline);
      assert.equal(status.capturePersistence.lifecycleState, 'OPEN', JSON.stringify(status.capturePersistence));
      assert.equal(status.capturePersistence.persistent, true, JSON.stringify(status.capturePersistence));
    }
    for (const [chapter, extra] of chapters) {
      const result = await script(chapter, identity, extra);
      if (result.error) break;
    }
  } finally {
    report.cleanup.push(await run('android-executor', { operation: 'close', ...target, ...identity }));
    persist();
  }
}
async function main() {
  const start = performance.now();
  let microphone;
  try {
    report.ownershipBefore = await run('device-ownership', { operation: 'status', serial: target.serial });
    assert.equal(report.ownershipBefore.active, 0);
    const camera = await run('permission-state', { ...target, permission: 'android.permission.CAMERA' });
    microphone = await run('permission-state', { ...target, permission: 'android.permission.RECORD_AUDIO' });
    report.permissionBefore = { camera, microphone };
    const chapters = [['native', {}], ['h5', {}], ['windows', {}]];
    if (camera.granted && !microphone.granted && !microphone.flags.includes('USER_FIXED')) chapters.push(['permissions', {}]);
    else if (requestedChapters.includes('permissions')) report.chapters.push({ chapter: 'permissions', ok: false, checks: [], error: 'Fixture requires camera granted and microphone requestable/denied. Current permission state was not changed.' });
    chapters.push(...['success', 'invalid', 'network', 'timeout', 'otp', 'home'].map(loginMode => ['login-' + loginMode, { loginMode }]));
    const selected = chapters.filter(([chapter]) => requestedChapters.includes(chapter));
    if (selected.length) await session(selected);
    if (requestedChapters.includes('compose')) await session([['compose', {}]], true);
    report.missingChapters = requestedChapters.filter(name => !report.chapters.some(c => c.chapter === name));
    report.ok = report.missingChapters.length === 0 && report.chapters.every(c => c.ok);
  } catch (error) {
    report.ok = false; report.error = error.stack; process.exitCode = 1;
  } finally {
    const before = report.permissionBefore;
    if (before) for (const original of [before.camera, before.microphone]) {
      const current = await run('permission-state', { ...target, permission: original.permission });
      report.cleanup.push({ kind: 'permission-readback', permission: original.permission, originalGranted: original.granted, currentGranted: current.granted, flags: current.flags });
      if (current.granted !== original.granted) report.ok = false;
    }
    report.ownershipAfter = await run('device-ownership', { operation: 'status', serial: target.serial });
    report.cleanup.push(await run('runtime', { operation: 'stop' }));
    report.elapsedMs = performance.now() - start;
    report.completedAt = new Date().toISOString();
    report.checks = { passed: report.chapters.flatMap(c => c.checks || []).filter(c => c.passed).length, failed: report.chapters.flatMap(c => c.checks || []).filter(c => !c.passed).length };
    persist();
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks, elapsedMs: report.elapsedMs, output: directory, error: report.error }));
    if (!report.ok) process.exitCode = 1;
  }
}
main().catch(error => { report.ok = false; report.error = error.stack; persist(); console.error(error); process.exitCode = 1; });
