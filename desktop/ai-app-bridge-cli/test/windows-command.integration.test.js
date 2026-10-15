'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { execFileBounded } = require('../bin/shared-kernel/execution-io');
const { portableExecFile } = require('../bin/shared-kernel/portable-exec-file');
const { runExecution } = require('../bin/shared-kernel/execution-scope');
const windows = { skip: process.platform !== 'win32', timeout: 20000 };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-command-jobs-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function readReady(file) {
  for (let i = 0; !fs.existsSync(file) && i < 1000; i++) await delay(10);
  assert.equal(fs.existsSync(file), true, `command must report its process tree: ${file}`);
  return JSON.parse(fs.readFileSync(file));
}

function command(directory, name, timeoutMs = 10000) {
  const ready = path.join(directory, name);
  const controller = new AbortController();
  const source = `
    const fs=require('node:fs');
    const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
    fs.writeFileSync(${JSON.stringify(ready + '.tmp')},JSON.stringify({pid:process.pid,childPid:child.pid}));
    fs.renameSync(${JSON.stringify(ready + '.tmp')},${JSON.stringify(ready)});
    setInterval(()=>{},1000);
  `;
  let completion;
  const result = runExecution({ signal: controller.signal, mutation: true },
    () => execFileBounded(process.execPath, ['-e', source], { mutation: true, timeoutMs,
      execFileImpl(file, args, options, callback) {
        return portableExecFile(file, args, options, (error, stdout, stderr) => {
          // Record any native cleanup error before execFileBounded chooses the
          // enclosing cancellation reason. This does not change event order.
          completion = error ? { code: error.code, message: error.message, signal: error.signal,
            dispatched: error.dispatched, ambiguous: error.ambiguous, details: error.details } : null;
          callback(error, stdout, stderr);
        });
      } }));
  const outcome = result.then(value => ({ value }), error => ({ error }));
  return { ready, controller, outcome, completion: () => completion };
}

async function verifyCancellation(t) {
  const directory = fixture(t);
  const a = command(directory, 'first'), b = command(directory, 'second');
  t.after(async () => { a.controller.abort(); b.controller.abort(); await Promise.all([a.outcome, b.outcome]); });
  const [first, other] = await Promise.all([readReady(a.ready), readReady(b.ready)]);
  const native = require('@mobileaidev/segmented-fact-store-native');
  const processes = [{ role: 'selected-command', pid: first.pid }, { role: 'selected-descendant', pid: first.childPid },
    { role: 'other-command', pid: other.pid }, { role: 'other-descendant', pid: other.childPid }]
    .map(process => ({ ...process, start: native.windowsProcessStart(process.pid) }));
  assert.ok(processes.every(process => process.start), JSON.stringify(processes));
  // Failed diagnostic runs must also clean up their original identities.
  // The handle-bound helper refuses to terminate a reused PID.
  t.after(() => { for (const process of processes) native.windowsTerminateProcess(process.pid, process.start); });
  const started = performance.now();
  const snapshot = phase => ({ phase, elapsedMs: performance.now() - started,
    processes: processes.map(process => {
      const observedStart = native.windowsProcessStart(process.pid);
      return { ...process, observedStart, state: observedStart === null ? 'exited' : observedStart === process.start ? 'original-alive' : 'pid-reused' };
    }) });
  const before = snapshot('before-cancel');
  a.controller.abort({ code: 'cancelled' });
  const { error } = await a.outcome;
  const after = snapshot('after-callback');
  const observations = [before, after];
  // Keep the immediate assertion below. This bounded tail only diagnoses a
  // failure; it must never convert late termination into successful cleanup.
  if (after.processes.slice(0, 2).some(process => process.state === 'original-alive')) {
    for (let i = 0; i < 40; i++) {
      await delay(5);
      const current = snapshot('failure-tail');
      observations.push(current);
      if (current.processes.slice(0, 2).every(process => process.state !== 'original-alive')) break;
    }
  }
  t.diagnostic(JSON.stringify({ kind: 'windows-command-cancellation', rawCompletion: a.completion(),
    outcome: { code: error?.code, dispatched: error?.dispatched, ambiguous: error?.ambiguous }, observations }));
  assert.equal(error.code, 'cancelled');
  assert.equal(error.details?.cleanup, undefined, 'the cancellation must finish its process cleanup');
  assert.equal(error.dispatched, true); assert.equal(error.ambiguous, true);
  assert.equal(after.processes[0].observedStart, null, JSON.stringify(after.processes[0]));
  assert.equal(after.processes[1].observedStart, null, JSON.stringify(after.processes[1]));
  assert.equal(after.processes[2].observedStart, processes[2].start);
  assert.equal(after.processes[3].observedStart, processes[3].start);
}

test('Windows bounded command cancellation closes descendants without stopping another command', { ...windows, timeout: 60000 }, async t => {
  const repetitions = Number(process.env.AAB_WINDOWS_CANCEL_REPETITIONS ?? 1);
  assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 20, 'AAB_WINDOWS_CANCEL_REPETITIONS must be an integer from 1 to 20.');
  if (repetitions === 1) return verifyCancellation(t);
  for (let iteration = 1; iteration <= repetitions; iteration++) await t.test(`iteration ${iteration}`, verifyCancellation);
});

test('Windows bounded command cancellation drains more than sixteen concurrent descendants in a nested Job', { ...windows, timeout: 60000 }, async t => {
  const nativePath = require.resolve('@mobileaidev/segmented-fact-store-native'), native = require(nativePath);
  for (let iteration = 1; iteration <= 3; iteration++) await t.test(`spawn race ${iteration}`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-nested-jobs-'));
    const worker = path.join(directory, 'spawn-worker.cjs'), main = path.join(directory, 'main.cjs');
    fs.writeFileSync(worker, `
      const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process'), native=require(${JSON.stringify(nativePath)});
      function record(pid){const value={pid,start:native.windowsProcessStart(pid)}, file=path.join(__dirname,pid+'.process.json');
        fs.writeFileSync(file+'.tmp',JSON.stringify(value));fs.renameSync(file+'.tmp',file);}
      record(process.pid);
      process.send({ready:true});
      process.once('message',()=>{
        let count=0;
        const timer=setInterval(()=>{
          const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
          child.once('error',()=>{}); // Cancellation can reject a concurrent association before user code starts.
          if(child.pid)record(child.pid);
          if(++count===40)clearInterval(timer);
        },1);
      });
      setInterval(()=>{},1000);
    `);
    fs.writeFileSync(main, `
      const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),native=require(${JSON.stringify(nativePath)});
      const file=path.join(__dirname,process.pid+'.process.json');
      fs.writeFileSync(file+'.tmp',JSON.stringify({pid:process.pid,start:native.windowsProcessStart(process.pid)}));fs.renameSync(file+'.tmp',file);
      const child=cp.fork(${JSON.stringify(worker)},[],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
      child.once('message',()=>{
        global.scope=native.windowsCreateProcessScope(child.pid);
        child.send({start:true});
      });
      setInterval(()=>{},1000);
    `);
    const readProcesses = () => fs.readdirSync(directory).filter(name => name.endsWith('.process.json'))
      .map(name => JSON.parse(fs.readFileSync(path.join(directory, name))));
    const controller = new AbortController();
    const outcome = runExecution({ signal: controller.signal, mutation: true }, () =>
      execFileBounded(process.execPath, [main], { mutation: true, timeoutMs: 20000 }))
      .then(value => ({ value }), error => ({ error }));
    t.after(async () => {
      try {
        controller.abort(); await outcome;
        for (const process of readProcesses()) if (process.start) native.windowsTerminateProcess(process.pid, process.start);
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
    for (let i = 0; readProcesses().length < 22 && i < 1000; i++) await delay(5);
    const before = readProcesses();
    assert.ok(before.length >= 22, 'the running nested tree must exceed the native initial member buffer');
    assert.ok(before.every(process => process.start && native.windowsProcessStart(process.pid) === process.start), JSON.stringify(before));
    controller.abort({ code: 'cancelled' });
    const { error } = await outcome;
    const after = readProcesses().map(process => ({ ...process, observedStart: native.windowsProcessStart(process.pid) }));
    t.diagnostic(JSON.stringify({ kind: 'windows-nested-spawn-cancellation', iteration,
      outcome: { code: error?.code, details: error?.details, dispatched: error?.dispatched, ambiguous: error?.ambiguous }, before, after }));
    assert.equal(error.code, 'cancelled');
    assert.equal(error.details?.cleanup, undefined, 'every handle wait and accounting check must succeed');
    assert.equal(error.dispatched, true); assert.equal(error.ambiguous, true);
    assert.ok(after.every(process => process.observedStart === null), JSON.stringify(after));
    await delay(30);
    assert.equal(readProcesses().length, after.length, 'no descendant may continue producing effects after cancellation returns');
  });
});

test('Windows bounded command timeout waits for the complete Job to terminate', windows, async t => {
  const a = command(fixture(t), 'timeout', 3000);
  t.after(async () => { a.controller.abort(); await a.outcome; });
  const tree = await readReady(a.ready), { error } = await a.outcome;
  assert.equal(error.code, 'provider_timeout');
  assert.equal(error.dispatched, true);
  const native = require('@mobileaidev/segmented-fact-store-native');
  assert.equal(native.windowsProcessStart(tree.pid), null);
  assert.equal(native.windowsProcessStart(tree.childPid), null);
});

test('Windows cancellation before worker readiness never dispatches the command', windows, async t => {
  const directory = fixture(t), a = command(directory, 'must-not-run');
  // No event-loop turn has occurred since fork, so the ready handshake has not
  // been delivered and no requested command can have been sent to the worker.
  a.controller.abort({ code: 'cancelled' });
  const { error } = await a.outcome;
  assert.equal(error.code, 'cancelled');
  assert.equal(error.dispatched, false); assert.equal(error.ambiguous, false);
  assert.equal(fs.existsSync(a.ready), false);
});

test('Windows command callback retains complete Unicode output before closing its Job', windows, async () => {
  const text = '商品输出 🛒\n'.repeat(50000);
  const result = await execFileBounded(process.execPath, ['-e',
    `process.stdout.write(${JSON.stringify('商品输出 🛒\n')}.repeat(50000));process.stderr.write('诊断结束');`],
  { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeoutMs: 10000 });
  assert.equal(result.stdout, text);
  assert.equal(result.stderr, '诊断结束');
});

test('Windows ENOENT distinguishes a missing shell from a shell that already started', windows, async t => {
  const directory = fixture(t), missing = path.join(directory, 'absent-command.exe');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'comspec'));
  env.ComSpec = path.join(directory, 'absent-shell.exe');
  await assert.rejects(execFileBounded(missing, [], { mutation: true, env }),
    error => error.code === 'ENOENT' && error.dispatched === false && error.ambiguous === false);
  // cross-spawn reports ENOENT after cmd.exe exits for an unresolved command.
  // A created shell must remain dispatched even though the command is missing.
  await assert.rejects(execFileBounded(missing, [], { mutation: true }),
    error => error.code === 'ENOENT' && error.dispatched === true && error.ambiguous === true);
});

test('Windows ADB keeps its independently owned server across completed commands and stops only the selected port', { ...windows, timeout: 30000 }, async t => {
  const adb = process.env.AAB_TEST_ADB;
  assert.ok(adb && fs.existsSync(adb), 'Windows CI must provide its real SDK adb.exe through AAB_TEST_ADB');
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !['adb_server_socket', 'android_adb_server_port', 'adb_server_port'].includes(name.toLowerCase())));
  const run = command => execFileBounded(adb, ['-P', String(port), command], { env, timeoutMs: 10000 });
  let cleaned = false;
  t.after(async () => { if (!cleaned) await run('kill-server'); });
  await run('start-server');
  // Inspect the listener without invoking ADB: an auto-start on the next ADB
  // request must not hide a daemon that was killed by start-server cleanup.
  const listener = await execFileBounded('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique) | ConvertTo-Json -Compress`],
  { timeoutMs: 10000 });
  const pid = JSON.parse(listener.stdout), native = require('@mobileaidev/segmented-fact-store-native');
  assert.equal(Number.isInteger(pid), true, listener.stdout);
  const started = native.windowsProcessStart(pid);
  assert.ok(started);
  await run('server-status');
  assert.equal(native.windowsProcessStart(pid), started, 'the second command must reuse the original server');
  await run('kill-server'); cleaned = true;
  for (let i = 0; i < 100 && native.windowsProcessStart(pid) !== null; i++) await delay(10);
  assert.equal(native.windowsProcessStart(pid), null);
});
