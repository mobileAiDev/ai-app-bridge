'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { executeCommand } = require('../bin/ai-app-bridge');
const { createScriptHostPort } = require('../bin/script/script-host-port');

test('screenshot hashes actual captured bytes and Host refs retain that digest', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-screenshot-hash-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7G8AAAAASUVORK5CYII=', 'base64');
  const fakeAdb = path.join(directory, 'fake-adb');
  fs.writeFileSync(fakeAdb, `#!${process.execPath}\nconst args=process.argv.slice(2);if(args.includes('screencap'))process.stdout.write(Buffer.from('${png.toString('base64')}','base64'));else if(args.includes('dumpsys'))process.stdout.write('mCurrentFocus=Window{1 u0 sample.test/sample.test.MainActivity}');else process.exit(9);\n`, { mode: 0o755 });
  const host = createScriptHostPort({ executionId: 'screenshot-test', target: { serial: 'simulated-device', packageName: 'sample.test' },
    actions: (command, args) => executeCommand(command, { ...args, adb: fakeAdb }) });
  const result = await host.call('screenshot', { outFile: path.join(directory, 'captured.png') });
  assert.equal(result.ok, true);
  const hash = createHash('sha256').update(png).digest('hex');
  assert.deepEqual(fs.readFileSync(result.result.path), png);
  assert.equal(result.result.artifact.sha256, hash);
  assert.equal(result.evidence.refs[0].sha256, hash);
  assert.equal((await host.assert({ scope: 'device', condition: true, requiredEvidence: ['screenshot'], evidence: result.evidence })).verdict, 'passed');
  const forged = structuredClone(result.evidence); forged.refs[0].sha256 = 'a'.repeat(64);
  assert.equal((await host.assert({ scope: 'device', condition: true, requiredEvidence: ['screenshot'], evidence: forged })).verdict, 'inconclusive');
});
