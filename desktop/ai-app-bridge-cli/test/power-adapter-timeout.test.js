'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createPlatformAdapter } = require('../bin/power/platform-adapters');

test('power helper upload timeout reaps a transport that ignores SIGTERM', async t => {
  let child, watchdog;
  const adapter = createPlatformAdapter({
    run(command, args, options) {
      assert.equal(command, 'controlled-adb');
      assert.equal(args[2], 'push');
      assert.equal(options.timeout, 10000);
      return new Promise((resolve, reject) => {
        child = execFile(process.execPath, ['-e',
          "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],
        { ...options, timeout: 200 }, (error, stdout) => {
          assert.equal(stdout, 'ready');
          error ? reject(error) : resolve({ stdout });
        });
      });
    },
    spawnChild() { assert.fail('an unconfirmed helper upload must not start the power worker'); },
  });
  t.after(() => { clearTimeout(watchdog); child?.kill('SIGKILL'); });
  const outcome = adapter({ leaseId: 'bounded-upload', mode: 'both', ttlMs: 1000,
    target: { platform: 'android', serial: 'controlled-device', adb: 'controlled-adb' } })
    .then(() => ({ completed: true }), error => ({ error }));
  const result = await Promise.race([outcome,
    new Promise(resolve => { watchdog = setTimeout(() => resolve({ stalled: true }), 1500); })]);
  assert.equal(result.stalled, undefined, 'transport timeout must settle even when SIGTERM is ignored');
  assert.equal(result.error.signal, 'SIGKILL');
  assert.equal(child.signalCode, 'SIGKILL');
});
