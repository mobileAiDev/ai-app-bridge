'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { execFileBounded } = require('../bin/shared-kernel/execution-io');
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
  const result = runExecution({ signal: controller.signal, mutation: true },
    () => execFileBounded(process.execPath, ['-e', source], { mutation: true, timeoutMs }));
  const outcome = result.then(value => ({ value }), error => ({ error }));
  return { ready, controller, outcome };
}

test('Windows bounded command cancellation closes descendants without stopping another command', windows, async t => {
  const directory = fixture(t);
  const a = command(directory, 'first'), b = command(directory, 'second');
  t.after(async () => { a.controller.abort(); b.controller.abort(); await Promise.all([a.outcome, b.outcome]); });
  const [first, other] = await Promise.all([readReady(a.ready), readReady(b.ready)]);
  const native = require('@mobileaidev/segmented-fact-store-native');
  const otherStart = native.windowsProcessStart(other.pid), otherChildStart = native.windowsProcessStart(other.childPid);
  assert.ok(otherStart); assert.ok(otherChildStart);
  a.controller.abort({ code: 'cancelled' });
  const { error } = await a.outcome;
  assert.equal(error.code, 'cancelled');
  assert.equal(error.dispatched, true); assert.equal(error.ambiguous, true);
  assert.equal(native.windowsProcessStart(first.pid), null);
  assert.equal(native.windowsProcessStart(first.childPid), null);
  assert.equal(native.windowsProcessStart(other.pid), otherStart);
  assert.equal(native.windowsProcessStart(other.childPid), otherChildStart);
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
