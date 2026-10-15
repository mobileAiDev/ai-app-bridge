'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');
const { compileScriptSpec } = require('../bin/script/script-spec');
const { createNodeRuntimeAdapter } = require('../bin/script/node-runtime-adapter');
const { createPythonRuntimeAdapter } = require('../bin/script/python-runtime-adapter');
const windows = { skip: process.platform !== 'win32', timeout: 20000 };
const native = () => require('@mobileaidev/segmented-fact-store-native');

function childProcess(t, source) {
  const child = spawn(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const messages = [], waiters = [];
  lines.on('line', line => { const message = JSON.parse(line); if (waiters.length) waiters.shift()(message); else messages.push(message); });
  const ended = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { child.kill('SIGKILL'); await ended; lines.close(); });
  return { child, ended, next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiters.push(resolve)) };
}

async function assertExited(pid) {
  for (let i = 0; i < 100 && native().windowsProcessStart(pid) !== null; i++) await delay(10);
  assert.equal(native().windowsProcessStart(pid), null, `process ${pid} must have exited`);
}

const ready = 'console.log(JSON.stringify({pid:process.pid}));process.stdin.resume();setInterval(()=>{},1000);';

test('Windows native termination uses creation identity and preserves an unrelated live process', windows, async t => {
  const first = childProcess(t, ready), other = childProcess(t, ready);
  await Promise.all([first.next(), other.next()]);
  const start = native().windowsProcessStart(first.child.pid), otherStart = native().windowsProcessStart(other.child.pid);
  assert.match(start, /^\d+$/);
  assert.equal(native().windowsTerminateProcess(first.child.pid, 'old-creation-time'), false);
  assert.equal(native().windowsProcessStart(first.child.pid), start);
  assert.equal(native().windowsTerminateProcess(first.child.pid, start), true);
  await first.ended;
  assert.equal(native().windowsProcessStart(other.child.pid), otherStart);
  assert.equal(native().windowsTerminateProcess(first.child.pid, start), false);
});

test('Windows Job closes only its owned child tree after gated startup', windows, async t => {
  const owned = childProcess(t, `
    console.log(JSON.stringify({ready:true}));
    process.stdin.once('data',()=>{const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
      console.log(JSON.stringify({pid:process.pid,childPid:c.pid}));});
    setInterval(()=>{},1000);
  `), other = childProcess(t, ready);
  await Promise.all([owned.next(), other.next()]);
  const scope = native().windowsCreateProcessScope(owned.child.pid);
  t.after(() => scope.close());
  owned.child.stdin.write('start\n');
  const running = await owned.next();
  const otherStart = native().windowsProcessStart(other.child.pid);
  assert.ok(native().windowsProcessStart(running.childPid));
  scope.close(); scope.close();
  await owned.ended;
  await assertExited(running.childPid);
  assert.equal(native().windowsProcessStart(other.child.pid), otherStart);
});

test('Windows Runtime Job kills descendants even when its owner is abruptly terminated', windows, async t => {
  const modulePath = require.resolve('@mobileaidev/segmented-fact-store-native');
  const runtime = childProcess(t, `
    const scope=require(${JSON.stringify(modulePath)}).windowsCreateProcessScope(process.pid);
    process.once('exit',()=>scope);
    const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
    console.log(JSON.stringify({childPid:c.pid}));setInterval(()=>{},1000);
  `);
  const running = await runtime.next();
  assert.ok(native().windowsProcessStart(running.childPid));
  runtime.child.kill('SIGKILL');
  await runtime.ended;
  await assertExited(running.childPid);
});

test('Windows native Job refuses to adopt the callers parent', windows, () => {
  const start = native().windowsProcessStart(process.ppid);
  assert.throws(() => native().windowsCreateProcessScope(process.ppid), { code: 'windows_process_failed' });
  assert.equal(native().windowsProcessStart(process.ppid), start);
});

for (const language of ['javascript', 'python']) test(`Windows ${language} Script cancellation closes its process tree and preserves another Script`, windows, async t => {
  const make = language === 'javascript' ? createNodeRuntimeAdapter : createPythonRuntimeAdapter;
  const source = language === 'javascript'
    ? `module.exports.main=async ctx=>{const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); await ctx.call('status',{pid:process.pid,childPid:c.pid});await new Promise(()=>{});};`
    : `import os,sys,subprocess,time\ndef main(ctx):\n    child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(300)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n    ctx.call('status',{'pid':os.getpid(),'childPid':child.pid})\n    time.sleep(300)\n`;
  const compiled = compileScriptSpec({ schemaVersion: 'aab.code-script/v1', language, source, policy: { timeoutMs: 15000 } });
  assert.equal(compiled.ok, true);
  function start() {
    const runtime = make();
    assert.equal(runtime.unavailable, undefined, 'Windows CI must provide a real Python installation');
    let resolve;
    const reported = new Promise(done => { resolve = done; });
    const result = runtime.start({ spec: compiled.spec, emit() {}, control: () => ({ status: 'running' }),
      host: { call(command, args) { assert.equal(command, 'status'); resolve(args); return { ok: true }; } } });
    t.after(async () => { await runtime.stop(); await result; });
    return { runtime, result, reported };
  }
  const first = start(), other = start();
  const [a, b] = await Promise.all([first.reported, other.reported]);
  const otherStart = native().windowsProcessStart(b.pid), otherChildStart = native().windowsProcessStart(b.childPid);
  assert.ok(otherStart); assert.ok(otherChildStart);
  await first.runtime.stop(); await first.result;
  await assertExited(a.pid); await assertExited(a.childPid);
  assert.equal(native().windowsProcessStart(b.pid), otherStart);
  assert.equal(native().windowsProcessStart(b.childPid), otherChildStart);
});

test('Windows completed Script does not leave detached descendants running', windows, async t => {
  const compiled = compileScriptSpec({ schemaVersion: 'aab.code-script/v1', language: 'javascript',
    source: `module.exports.main=()=>{const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true});c.unref();return {pid:c.pid};};` });
  const runtime = createNodeRuntimeAdapter();
  t.after(() => runtime.stop());
  const result = await runtime.start({ spec: compiled.spec, emit() {}, host: {}, control: () => ({ status: 'running' }) });
  assert.equal(result.ok, true, JSON.stringify(result));
  await assertExited(result.result.pid);
});
