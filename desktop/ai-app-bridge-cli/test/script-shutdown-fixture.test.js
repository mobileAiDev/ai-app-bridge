'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShutdownScripts } = require('../scripts/validation/verify-script-shutdown');
const execute = promisify(execFile);

test('shutdown fixture only marks the selected keyevent ready, never power setup', { timeout: 10000 }, async t => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-shutdown-fixture-'));
  let child, closed;
  t.after(async () => {
    child?.kill('SIGKILL');
    if (closed) await closed;
    fs.rmSync(out, { recursive: true, force: true });
  });
  // Stop at the external runner boundary, then exercise the generated executable.
  const generated = new Error('fixture generated');
  await assert.rejects(startShutdownScripts({ out, run: async () => { throw generated; } }), error => error === generated);
  const adb = path.join(out, 'shutdown-javascript-adb');
  const ready = path.join(out, 'shutdown-javascript-ready');
  for (const args of [
    ['-s', 'shutdown-javascript', 'push', 'power-lease.jar', '/data/local/tmp/power-lease.jar'],
    ['-s', 'shutdown-javascript', 'shell', 'CLASSPATH=power-lease.jar', 'app_process', '/system/bin', 'PowerLease'],
    ['-s', 'shutdown-javascript', 'shell', 'input', 'keyevent', '1'],
    ['-s', 'another-device', 'shell', 'input', 'keyevent', '0'],
  ]) {
    await assert.rejects(execute(adb, args, { timeout: 1000, killSignal: 'SIGKILL' }), error => {
      assert.equal(error.code, 1, 'unsupported commands must exit themselves without a timeout kill');
      assert.equal(error.signal, null);
      assert.match(error.stderr, /Unsupported shutdown fixture command/);
      return true;
    });
    assert.equal(fs.existsSync(ready), false);
  }
  child = spawn(adb, ['-s', 'shutdown-javascript', 'shell', 'input', 'keyevent', '0'], { stdio: 'ignore' });
  closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  for (let i = 0; !fs.existsSync(ready) && i < 100; i++) await delay(10);
  assert.equal(Number(fs.readFileSync(ready)), child.pid, 'ready must identify the controlled input process');
  child.kill('SIGTERM');
  await delay(50);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null, 'the selected input remains the deliberate SIGTERM-ignoring shutdown probe');
  child.kill('SIGKILL');
  assert.deepEqual(await closed, { code: null, signal: 'SIGKILL' });
});
