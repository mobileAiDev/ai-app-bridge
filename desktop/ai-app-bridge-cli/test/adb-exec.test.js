'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateRunRequest } = require('../bin/command-request');
const { dispatchProviderCommand } = require('../bin/execution-host');
const { createScriptHostPort } = require('../bin/script/script-host-port');

test('ordinary run defaults to adaptive output', () => {
  assert.deepEqual(validateRunRequest({ command: 'uia-tree', arguments: { serial: 'device' } }).extract, { mode: 'auto' });
});

test('ADB expert entry preserves argv, nonzero exits, binary files and Script device-only use', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-adb-exec-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const adb = path.join(dir, 'adb');
  fs.writeFileSync(adb, `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args.includes('binary')) process.stdout.write(Buffer.from([0, 255, 1]));\nelse process.stdout.write(JSON.stringify(args));\nif (args.includes('failure')) { process.stderr.write('remote refused'); process.exitCode = 7; }\n`, { mode: 0o700 });
  const argv = ['shell', 'printf', '%s', 'a b; $(false)'];
  const result = await dispatchProviderCommand('adb-exec', { adb, serial: 'device', argv });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.stdout), ['-s', 'device', ...argv]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.completionScope, 'adb-process');
  const failed = await dispatchProviderCommand('adb-exec', { adb, serial: 'device', argv: ['failure'] });
  assert.equal(failed.error, 'adb_exit_nonzero');
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.stderr, 'remote refused');
  assert.equal(failed.ambiguous, false);
  const outFile = path.join(dir, 'screen.png');
  const binary = await dispatchProviderCommand('adb-exec', { adb, serial: 'device', argv: ['binary'], outFile });
  assert.equal(binary.ok, true);
  assert.deepEqual(fs.readFileSync(outFile), Buffer.from([0, 255, 1]));
  const writeFailure = await dispatchProviderCommand('adb-exec', { adb, serial: 'device', argv: ['binary'], outFile: adb + '/impossible' });
  assert.equal(writeFailure.error, 'adb_output_write_failed');
  assert.equal(writeFailure.settled, true); assert.equal(writeFailure.ambiguous, false); assert.equal(writeFailure.exitCode, 0);
  await assert.rejects(require('../bin/shared-kernel/adb-exec').adbExec({ adb, serial: 'device', argv: ['-s', 'other', 'devices'] }), { code: 'adb_target_conflict' });
  const port = createScriptHostPort({ actions: dispatchProviderCommand });
  assert.equal((await port.call('adb-exec', { adb, serial: 'device', argv: ['get-state'] })).ok, true);
  assert.equal((await port.call('adb-exec', { adb, argv: ['devices', '-l'] })).ok, true);
});
