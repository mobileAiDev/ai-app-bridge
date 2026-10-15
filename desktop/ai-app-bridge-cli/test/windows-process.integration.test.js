'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

function backgroundServiceSource(language) {
  return language === 'javascript'
    ? `module.exports.main=()=>{const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true});c.unref();return {pid:c.pid};};`
    : `import sys,subprocess\ndef main(ctx):\n    child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(300)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.DETACHED_PROCESS)\n    return {'pid':child.pid}\n`;
}

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

test('Windows Host death closes unfinished Script and command Jobs while independent processes survive', windows, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-job-owner-'));
  const commandReady = path.join(directory, 'command.json'), retained = path.join(directory, 'retained.json');
  t.after(() => {
    if (fs.existsSync(retained)) for (const { pid, start } of JSON.parse(fs.readFileSync(retained))) native().windowsTerminateProcess(pid, start);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const adapter = require.resolve('../bin/script/node-runtime-adapter'), spec = require.resolve('../bin/script/script-spec');
  const pythonAdapter = require.resolve('../bin/script/python-runtime-adapter');
  const io = require.resolve('../bin/shared-kernel/execution-io'), nativePath = require.resolve('@mobileaidev/segmented-fact-store-native');
  const scriptSource = `module.exports.main=async ctx=>{const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});await ctx.call('status',{pid:process.pid,childPid:c.pid});await new Promise(()=>{});};`;
  const commandSource = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(commandReady + '.tmp')},JSON.stringify({pid:process.pid,childPid:c.pid}));fs.renameSync(${JSON.stringify(commandReady + '.tmp')},${JSON.stringify(commandReady)});setInterval(()=>{},1000);`;
  const daemonSource = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true});c.unref();process.stdout.write(JSON.stringify({pid:c.pid}));`;
  const runtime = childProcess(t, `
    const fs=require('node:fs'), native=require(${JSON.stringify(nativePath)}), spawn=require('node:child_process').spawn;
    const makeNode=require(${JSON.stringify(adapter)}).createNodeRuntimeAdapter;
    const makePython=require(${JSON.stringify(pythonAdapter)}).createPythonRuntimeAdapter;
    const adapter=makeNode();
    const compiled=require(${JSON.stringify(spec)}).compileScriptSpec({schemaVersion:'aab.code-script/v1',language:'javascript',source:${JSON.stringify(scriptSource)}});
    const {execFileBounded}=require(${JSON.stringify(io)});
    let reportScript; const scriptReady=new Promise(resolve=>{reportScript=resolve;});
    adapter.start({spec:compiled.spec,emit(){},control:()=>({status:'running'}),host:{call(command,args){reportScript(args);return{ok:true};}}});
    execFileBounded(process.execPath,['-e',${JSON.stringify(commandSource)}],{timeoutMs:15000});
    (async()=>{
      const daemon=JSON.parse((await execFileBounded(process.execPath,['-e',${JSON.stringify(daemonSource)}])).stdout);
      const saved=[{role:'completed-command-daemon',pid:daemon.pid,start:native.windowsProcessStart(daemon.pid)}];
      fs.writeFileSync(${JSON.stringify(retained)},JSON.stringify(saved));
      for(const [language,source] of ${JSON.stringify(['javascript', 'python'].map(language => [language, backgroundServiceSource(language)]))}){
        const runtime=language==='javascript'?makeNode():makePython();
        const compiled=require(${JSON.stringify(spec)}).compileScriptSpec({schemaVersion:'aab.code-script/v1',language,source});
        const result=await runtime.start({spec:compiled.spec,emit(){},control:()=>({status:'running'}),host:{}});
        if(!result.ok)throw new Error(JSON.stringify(result));
        saved.push({role:'completed-'+language+'-daemon',pid:result.result.pid,start:native.windowsProcessStart(result.result.pid)});
        fs.writeFileSync(${JSON.stringify(retained)},JSON.stringify(saved));
      }
      const script=await scriptReady;
      while(!fs.existsSync(${JSON.stringify(commandReady)}))await new Promise(resolve=>setTimeout(resolve,10));
      const command=JSON.parse(fs.readFileSync(${JSON.stringify(commandReady)}));
      const independent=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true});
      independent.unref(); saved.push({role:'independent-process',pid:independent.pid,start:native.windowsProcessStart(independent.pid)});
      fs.writeFileSync(${JSON.stringify(retained)},JSON.stringify(saved));
      console.log(JSON.stringify({script,command,saved}));
    })();
  `);
  const running = await runtime.next();
  const snapshot = phase => ({ phase, hostPid: runtime.child.pid, processes: running.saved.map(process => ({ ...process,
    observedStart: native().windowsProcessStart(process.pid) })) });
  const before = snapshot('before-host-death');
  t.diagnostic(JSON.stringify(before));
  assert.ok(before.processes.every(process => process.start && process.observedStart === process.start), JSON.stringify(before));
  for (const tree of [running.script, running.command]) {
    assert.ok(native().windowsProcessStart(tree.pid));
    assert.ok(native().windowsProcessStart(tree.childPid));
  }
  runtime.child.kill('SIGKILL');
  await runtime.ended;
  for (const tree of [running.script, running.command]) { await assertExited(tree.pid); await assertExited(tree.childPid); }
  const after = snapshot('after-host-death');
  t.diagnostic(JSON.stringify(after));
  assert.ok(after.processes.every(process => process.observedStart === process.start), JSON.stringify(after));
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

for (const language of ['javascript', 'python']) test(`Windows completed ${language} Script preserves its explicitly started background service`, windows, async t => {
  const source = backgroundServiceSource(language);
  const compiled = compileScriptSpec({ schemaVersion: 'aab.code-script/v1', language, source });
  const runtime = language === 'javascript' ? createNodeRuntimeAdapter() : createPythonRuntimeAdapter();
  t.after(() => runtime.stop());
  const result = await runtime.start({ spec: compiled.spec, emit() {}, host: {}, control: () => ({ status: 'running' }) });
  assert.equal(result.ok, true, JSON.stringify(result));
  const start = native().windowsProcessStart(result.result.pid);
  assert.ok(start);
  t.after(() => native().windowsTerminateProcess(result.result.pid, start));
  await runtime.stop();
  assert.equal(native().windowsProcessStart(result.result.pid), start);
});
