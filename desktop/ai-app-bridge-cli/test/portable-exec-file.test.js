'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { portableExecFile } = require('../bin/shared-kernel/portable-exec-file');
const { execFileBounded } = require('../bin/shared-kernel/execution-io');

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
