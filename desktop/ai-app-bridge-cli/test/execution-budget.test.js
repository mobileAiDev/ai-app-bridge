'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { runExecution, withoutExecution, checkExecution, executionSleep } = require('../bin/shared-kernel/execution-scope');
const { execFileBounded, httpRequestBounded } = require('../bin/shared-kernel/execution-io');
const { TargetExecution } = require('../bin/target-execution');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-execution-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('settled work cannot create a fresh budget; an explicitly independent collector owns its later calls', async () => {
  const later = () => new Promise((resolve, reject) => setTimeout(() => {
    runExecution({ timeoutMs: 1000 }, () => 'observed').then(resolve, reject);
  }, 30));
  let owned;
  let collector;
  await runExecution({ timeoutMs: 20 }, async () => {
    owned = assert.rejects(later(), { code: 'runtime_stopped', dispatched: false });
    collector = withoutExecution(later);
  });
  await owned;
  assert.equal(await collector, 'observed');
});

test('nested deadlines include earlier work and stop a late timer before dispatch', async () => {
  await assert.rejects(runExecution({ timeoutMs: 20 }, async () => {
    const busyUntil = Date.now() + 30;
    while (Date.now() < busyUntil) {}
    checkExecution();
    assert.fail('work after deadline');
  }), { code: 'deadline_exceeded', dispatched: false, ambiguous: false });
  const start = Date.now();
  await assert.rejects(runExecution({ timeoutMs: 80 }, async () => {
    await executionSleep(40);
    await runExecution({ timeoutMs: 5000 }, () => executionSleep(5000));
  }), { code: 'deadline_exceeded' });
  assert.ok(Date.now() - start < 2000, 'nested scope must not restart the budget');
});

test('subprocess cancellation waits for close, force-kills a SIGTERM-resistant child, and preserves dispatch ambiguity', async (t) => {
  const dir = fixture(t);
  const ready = path.join(dir, 'ready');
  const effect = path.join(dir, 'effect');
  const controller = new AbortController();
  const pending = runExecution({ signal: controller.signal, mutation: true }, () => execFileBounded(process.execPath, ['-e', `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    fs.writeFileSync(${JSON.stringify(ready + '.tmp')}, String(process.pid));
    fs.renameSync(${JSON.stringify(ready + '.tmp')}, ${JSON.stringify(ready)});
    setTimeout(() => fs.writeFileSync(${JSON.stringify(effect)}, 'late'), 1000);
    setInterval(() => {}, 1000);
  `], { mutation: true, timeoutMs: 5000 }));
  const rejected = assert.rejects(pending, { code: 'cancelled', dispatched: true, ambiguous: true });
  for (let i = 0; !fs.existsSync(ready) && i < 500; i++) await delay(10);
  assert.ok(fs.existsSync(ready));
  const pid = Number(fs.readFileSync(ready));
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'ready must contain the actual child PID');
  controller.abort({ code: 'cancelled' });
  await rejected;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(fs.existsSync(effect), false);
});

test('an HTTP trickle cannot extend the total deadline and its socket is closed', async (t) => {
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const server = http.createServer((_request, response) => {
    response.writeHead(200);
    const timer = setInterval(() => response.write('x'), 5);
    response.on('close', () => { clearInterval(timer); closed(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(runExecution({ timeoutMs: 100 }, () => httpRequestBounded(`http://127.0.0.1:${server.address().port}`, { timeoutMs: 5000 })),
    { code: 'deadline_exceeded', dispatched: false, ambiguous: false });
  await disconnected;
});

test('a cancelled queued call never dispatches and does not remove the preceding queue barrier', async () => {
  const execution = new TargetExecution();
  const calls = [];
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const runner = async (_command, args) => {
    calls.push(args.keyCode);
    if (args.keyCode === 1) { entered(); await new Promise(resolve => { release = resolve; }); }
    return { ok: true };
  };
  const args = { serial: 'budget-device', packageName: 'example.app' };
  const first = execution.execute('keyevent', { ...args, keyCode: 1 }, runner);
  await ready;
  await assert.rejects(execution.execute('keyevent', { ...args, keyCode: 2, timeoutMs: 20 }, runner), { code: 'deadline_exceeded', dispatched: false });
  const third = execution.execute('keyevent', { ...args, keyCode: 3 }, runner);
  await delay(20);
  assert.deepEqual(calls, [1]);
  release();
  await Promise.all([first, third]);
  assert.deepEqual(calls, [1, 3]);
  assert.equal(execution.targetTails.size, 0);
});
