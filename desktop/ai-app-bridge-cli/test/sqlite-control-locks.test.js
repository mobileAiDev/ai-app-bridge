'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { acquireRuntimeLock } = require('../bin/runtime-directory');
const { packageLocation, preparePackage } = require('../bin/executors/managed-runtime');

function directory(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-control-lock-'));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

test('Runtime ownership coexists with SQLite readers but remains exclusive between owners', t => {
  const home = directory(t), location = { directory: home, lockFile: path.join(home, 'runtime.sqlite') };
  const reader = new DatabaseSync(location.lockFile);
  let owner;
  try {
    reader.exec('BEGIN; SELECT * FROM sqlite_schema');
    owner = acquireRuntimeLock(location);
    assert.ok(owner);
    assert.equal(acquireRuntimeLock(location), null);
    owner.close(); owner = undefined;
    reader.exec('ROLLBACK; BEGIN EXCLUSIVE');
    assert.equal(acquireRuntimeLock(location), null, 'previous Runtime lock mode still excludes this build');
    reader.exec('ROLLBACK');
  } finally { owner?.close(); reader.close(); }
});

test('reading a prepared browser lock does not block reuse, while an active preparer does', async t => {
  const home = directory(t), location = packageLocation('playwright', home);
  const packageDir = path.join(location.directory, 'node_modules/playwright');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: location.version }));
  const executable = path.join(location.directory, 'controlled-browser');
  fs.writeFileSync(executable, 'controlled prepared artifact');
  fs.writeFileSync(location.readyFile, JSON.stringify({ digest: location.digest, browsers: { chromium: executable } }));
  const reader = new DatabaseSync(path.join(location.directory, 'prepare.sqlite'));
  const options = { home, run: async () => assert.fail('intact preparation must not launch an installer') };
  try {
    reader.exec('BEGIN; SELECT * FROM sqlite_schema');
    assert.equal((await preparePackage('chromium', options)).reused, true);
    reader.exec('ROLLBACK; BEGIN IMMEDIATE');
    await assert.rejects(preparePackage('chromium', options), { code: 'executor_preparing' });
    reader.exec('ROLLBACK');
    assert.equal((await preparePackage('chromium', options)).available, true);
  } finally { reader.close(); }
});
