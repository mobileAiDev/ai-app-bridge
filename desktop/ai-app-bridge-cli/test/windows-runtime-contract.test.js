'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { compileScriptSpec } = require('../bin/script/script-spec');
const { createChildRuntimeAdapter } = require('../bin/script/node-runtime-adapter');
const { isBridgeHostCommand } = require('../bin/shared-kernel/host-process-stop');

function windowsStopModule({ execute, start = () => '123456789', terminate = () => true } = {}) {
  const filename = path.resolve(__dirname, '../bin/shared-kernel/host-process-stop.js');
  const realRequire = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
    process: { platform: 'win32', pid: 999 }, require(name) {
      if (name === 'node:child_process') return { execFileSync: execute };
      if (name === '@mobileaidev/segmented-fact-store-native') return { windowsProcessStart: start, windowsTerminateProcess: terminate };
      return realRequire(name);
    } }, { filename });
  return module.exports;
}

test('Windows process inspection errors are not reported as an absent process', () => {
  const error = Object.assign(new Error('CIM access denied'), { status: 1 });
  const actual = windowsStopModule({ execute() { throw error; } });
  assert.throws(() => actual.processInfo(42), value => value === error);
});

test('Windows PID replacement during command-line inspection cannot become a stop target', async () => {
  let reads = 0, stops = 0;
  const actual = windowsStopModule({ execute: () => JSON.stringify({ command: 'node C:\\tool\\bin\\execution-runtime.js' }),
    start: () => ++reads === 1 ? 'old' : 'replacement', terminate: () => { stops++; return true; } });
  assert.deepEqual(Array.from(await actual.stopHosts({ pid: 42, processStart: 'old' })), []);
  assert.equal(stops, 0);
});

test('Windows force-stop passes the inspected creation time to one handle-bound termination', async () => {
  const calls = [];
  const actual = windowsStopModule({ execute: () => JSON.stringify({ command: 'node "C:\\Tool With Spaces\\bin\\execution-runtime.js"' }),
    terminate: (...args) => { calls.push(args); return false; } });
  assert.deepEqual(Array.from(await actual.stopHosts({ pid: 42, processStart: '123456789' })), []);
  assert.deepEqual(calls, [[42, '123456789']]);
});

test('quoted Windows Runtime paths are recognized without accepting a filename suffix', () => {
  assert.equal(isBridgeHostCommand('"C:\\Program Files\\node.exe" "C:\\工具 App\\bin\\execution-runtime.js"', ['execution-runtime']), true);
  assert.equal(isBridgeHostCommand('node "C:\\工具 App\\bin\\execution-runtime.js" --arg', ['execution-runtime']), true);
  assert.equal(isBridgeHostCommand('node C:\\tool\\bin\\execution-runtime.js-other', ['execution-runtime']), false);
  assert.equal(isBridgeHostCommand('node C:\\tool\\bin\\mcp-server.js', ['execution-runtime']), false);
});

test('a failed process scope never starts the user Script', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-process-scope-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const marker = path.join(directory, 'must-not-run');
  const compiled = compileScriptSpec({ schemaVersion: 'aab.code-script/v1', language: 'javascript',
    source: `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); module.exports.main=()=>42;` });
  assert.equal(compiled.ok, true);
  let calls = 0;
  const runtime = createChildRuntimeAdapter({ kind: 'javascript', executable: process.execPath, sdkFile: 'script-sdk.js', extension: '.js',
    createProcessScope(pid) { calls++; assert.ok(pid > 0); throw new Error('AssignProcessToJobObject denied'); } });
  t.after(() => runtime.stop());
  const result = await runtime.start({ spec: compiled.spec, host: {}, emit() {}, control: () => ({ status: 'running' }) });
  assert.equal(result.error, 'script_process_scope_failed');
  assert.match(result.diagnostics.message, /AssignProcessToJobObject denied/);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(marker), false);
});

for (const returns of [true, false]) test(`Script ${returns ? 'natural return releases' : 'failure terminates'} its execution scope`, async t => {
  const methods = [];
  const runtime = createChildRuntimeAdapter({ kind: 'javascript', executable: process.execPath, sdkFile: 'script-sdk.js', extension: '.js',
    createProcessScope: () => ({ release() { methods.push('release'); }, close() { methods.push('terminate'); } }) });
  t.after(() => runtime.stop());
  const compiled = compileScriptSpec({ schemaVersion: 'aab.code-script/v1', language: 'javascript',
    source: returns ? 'module.exports.main=()=>42;' : 'module.exports.main=()=>{throw new Error("failed");};' });
  const result = await runtime.start({ spec: compiled.spec, host: {}, emit() {}, control: () => ({ status: 'running' }) });
  assert.equal(result.ok, returns);
  assert.deepEqual(methods, [returns ? 'release' : 'terminate']);
});

test('a failed Job release keeps its native diagnostic, cleans up and never replays the returned Script', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-scope-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const marker = path.join(directory, 'executions'), methods = [], events = [];
  const failure = Object.assign(new Error('SetInformationJobObject for release failed (Win32 error 5).'), { code: 'windows_process_failed' });
  const runtime = createChildRuntimeAdapter({ kind: 'javascript', executable: process.execPath, sdkFile: 'script-sdk.js', extension: '.js',
    createProcessScope: () => ({ release() { methods.push('release'); throw failure; }, close() { methods.push('terminate'); } }) });
  t.after(() => runtime.stop());
  const compiled = compileScriptSpec({ schemaVersion: 'aab.code-script/v1', language: 'javascript',
    source: `module.exports.main=()=>{require('node:fs').appendFileSync(${JSON.stringify(marker)},'once\\n');return 42;};` });
  const result = await runtime.start({ spec: compiled.spec, host: {}, emit: (type, value) => events.push({ type, value }),
    control: () => ({ status: 'running' }) });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'script_process_scope_failed');
  assert.deepEqual(result.diagnostics, { stage: 'release', code: failure.code, message: failure.message });
  assert.deepEqual(events.filter(event => event.type === 'script_failed').map(event => event.value),
    [{ error: 'script_process_scope_failed', diagnostics: result.diagnostics }]);
  assert.equal(events.some(event => event.type === 'script_completed'), false);
  assert.deepEqual(methods, ['release', 'terminate']);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'once\n');
});
