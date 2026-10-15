'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { fork } = require('node:child_process');
const { createRequire } = require('node:module');
const { portableExecFile } = require('../bin/shared-kernel/portable-exec-file');
const { execFileBounded } = require('../bin/shared-kernel/execution-io');
const { runExecution, currentExecution } = require('../bin/shared-kernel/execution-scope');

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => portableExecFile(file, args, options, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr })); else resolve({ stdout, stderr });
  }));
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-command-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// Exercise the actual Windows event ordering on every host. This fixture does
// not claim Win32 Job behavior; the integration suite runs those APIs on Windows.
function windowsCommand(closeScope = () => {}) {
  const child = new EventEmitter();
  child.pid = 42; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; return true; };
  child.send = () => {};
  const filename = path.resolve(__dirname, '../bin/shared-kernel/portable-exec-file.js');
  const realRequire = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process: { platform: 'win32' }, Buffer, __dirname: path.dirname(filename),
    require(name) {
      if (name === 'node:child_process') return { fork: () => child };
      if (name === './windows-process') return { createProcessScope: () => ({ close: closeScope }) };
      return realRequire(name);
    },
  }, { filename });
  return { child, execute: module.exports.portableExecFile };
}

for (const trigger of ['result', 'cancel']) test(`Windows ${trigger} retains repeated cleanup failures without escaping or skipping the callback`, () => {
  let cleanupCalls = 0, callbackCalls = 0, failure;
  const first = Object.assign(new Error('first Job cleanup failed'), { code: 'windows_process_failed' });
  const { child, execute } = windowsCommand(() => { throw ++cleanupCalls === 1 ? first : new Error('second Job cleanup failed'); });
  execute('command', [], {}, error => { callbackCalls++; failure = error; });
  child.emit('message', { event: 'ready' });
  if (trigger === 'result') child.emit('message', { event: 'result', code: 0, signal: null, spawned: true });
  else child.kill('SIGTERM');
  assert.doesNotThrow(() => child.emit('close', 1, null));
  assert.equal(cleanupCalls, 2);
  assert.equal(callbackCalls, 1);
  assert.equal(failure, first);
  assert.equal(child.killed, true);
});

for (const spawned of [false, true, undefined]) test(`Windows ENOENT with spawned=${spawned} retains the proven dispatch state`, async () => {
  const { child, execute } = windowsCommand();
  await runExecution({ mutation: true }, async () => {
    const result = execFileBounded('command', [], { mutation: true, execFileImpl: execute });
    child.emit('message', { event: 'ready' });
    child.emit('message', { event: 'result', code: -2, signal: null, spawned,
      failure: { code: 'ENOENT', message: 'spawn command ENOENT' } });
    child.emit('close', 1, null);
    await assert.rejects(result, error => error.code === 'ENOENT' && error.dispatched === (spawned !== false) && error.ambiguous === (spawned !== false));
    assert.equal(currentExecution().dispatched, true, 'a command receipt must not reset the enclosing execution history');
  });
});

test('Windows worker loss after dispatch remains unknown without a result receipt', async () => {
  const { child, execute } = windowsCommand();
  const result = runExecution({ mutation: true }, async () => {
    const pending = execFileBounded('command', [], { mutation: true, execFileImpl: execute });
    child.emit('message', { event: 'ready' });
    child.emit('close', 1, null);
    return pending;
  });
  await assert.rejects(result, error => error.dispatched === true && error.ambiguous === true);
});

test('Windows cancellation preserves an explicit no-child receipt without clearing execution history', async () => {
  const { child, execute } = windowsCommand(), controller = new AbortController();
  await runExecution({ mutation: true, signal: controller.signal }, async () => {
    const result = execFileBounded('command', [], { mutation: true, execFileImpl: execute });
    child.emit('message', { event: 'ready' });
    controller.abort({ code: 'cancelled' });
    child.emit('message', { event: 'result', code: -2, signal: null, spawned: false,
      failure: { code: 'ENOENT', message: 'spawn command ENOENT' } });
    child.emit('close', 1, null);
    await assert.rejects(result, error => error.code === 'cancelled' && error.dispatched === false && error.ambiguous === false);
    assert.equal(currentExecution().dispatched, true);
  });
});

test('command worker reports actual subprocess creation for spawn failure and child exit failure', { timeout: 15000 }, async t => {
  const directory = fixture(t);
  for (const spawned of [false, true]) {
    const child = fork(path.resolve(__dirname, '../bin/shared-kernel/windows-command-worker.js'), [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: [], windowsHide: true,
    });
    child.stdout.resume(); child.stderr.resume();
    const closed = once(child, 'close');
    t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await closed; });
    const [ready] = await once(child, 'message');
    assert.equal(ready.event, 'ready');
    const result = once(child, 'message');
    child.send({ file: process.execPath, args: ['-e', 'process.exit(17)'],
      options: spawned ? {} : { cwd: path.join(directory, 'absent-directory') } });
    const [receipt] = await result;
    assert.equal(receipt.event, 'result');
    assert.equal(receipt.spawned, spawned);
    if (spawned) { assert.equal(receipt.code, 17); assert.equal(receipt.failure, undefined); }
    else assert.equal(receipt.failure.code, 'ENOENT');
    child.kill('SIGKILL');
    await closed;
  }
});

test('portable subprocess preserves Unicode argv, environment, cwd, exit code and complete output', { timeout: 15000 }, async t => {
  const directory = fixture(t);
  const args = ['中文 输入', 'quotes" and \\paths', '%PATH%', '!NAME!', '& echo not-a-command', '(parentheses)', ''];
  const result = await run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),value:process.env.AAB_TEST_VALUE}));process.stderr.write("错误详情");', ...args],
    { cwd: directory, env: { ...process.env, AAB_TEST_VALUE: '本次任务' } });
  assert.deepEqual(JSON.parse(result.stdout), { args, cwd: fs.realpathSync(directory), value: '本次任务' });
  assert.equal(result.stderr, '错误详情');
  await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write("before failure");process.stderr.write("cause");process.exit(17);']),
    error => error.code === 17 && error.stdout === 'before failure' && error.stderr === 'cause');
});

test('both output streams drain before successful completion and binary output remains bytes', { timeout: 15000 }, async () => {
  const result = await run(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(70000,65));process.stderr.write(Buffer.alloc(80000,66));'], { encoding: null });
  assert.deepEqual(result.stdout, Buffer.alloc(70000, 65));
  assert.deepEqual(result.stderr, Buffer.alloc(80000, 66));
});

test('buffer overflow and missing program remain explicit failures', { timeout: 15000 }, async t => {
  const directory = fixture(t);
  await assert.rejects(run(path.join(directory, 'nonexistent-command.exe'), []), { code: 'ENOENT' });
  await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(200000));setInterval(()=>{},1000);'], { maxBuffer: 1000 }),
    error => error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && Buffer.byteLength(error.stdout) === 1000);
});

test('bounded portable command times out only after its worker closes', { timeout: 15000 }, async () => {
  await assert.rejects(execFileBounded(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    { timeoutMs: 500, execFileImpl: portableExecFile }), { code: 'provider_timeout' });
});

test('Windows batch wrapper and PATH shim receive literal arguments without shell injection', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const directory = fixture(t), wrapperDirectory = path.join(directory, '中文 app & wrapper');
  fs.mkdirSync(wrapperDirectory);
  const writer = path.join(wrapperDirectory, 'argv.cjs');
  fs.writeFileSync(writer, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const wrapper = path.join(wrapperDirectory, 'gradlew.bat');
  fs.writeFileSync(wrapper, '@echo off\r\n"%AAB_TEST_NODE%" "%~dp0argv.cjs" %*\r\n');
  const args = ['--init-script', path.join(wrapperDirectory, 'init.gradle'), '-Daab.prepare.config=' + path.join(wrapperDirectory, 'config.json'),
    ':app:aiAppBridgePrepareExecutor', '%PATH%', '!NAME!', '& echo not-a-command', 'a"b', ''];
  assert.deepEqual(JSON.parse((await run(wrapper, args, { env: { ...process.env, AAB_TEST_NODE: process.execPath } })).stdout), args);
  fs.copyFileSync(wrapper, path.join(wrapperDirectory, 'aab-test.cmd'));
  assert.deepEqual(JSON.parse((await run('aab-test', args, { cwd: wrapperDirectory, env: { ...process.env,
    PATH: `${wrapperDirectory}${path.delimiter}${process.env.PATH}`, PATHEXT: '.COM;.EXE;.BAT;.CMD', AAB_TEST_NODE: process.execPath } })).stdout), args);
});
