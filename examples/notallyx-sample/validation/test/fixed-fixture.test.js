'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { captureFixture, restoreFixture } = require('../fixed-fixture');
const { readSnapshot } = require('../oracles');
const { PACKAGE } = require('../collector');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-fixed-fixture-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'database');
  const schema = path.resolve(__dirname, '../../app/schemas/com.philkes.notallyx.data.NotallyDatabase/11.json');
  const create = spawnSync('python3', ['-c', `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]);s=json.load(open(sys.argv[2]))['database']
for e in s['entities']: c.execute(e['createSql'].replace(chr(36)+'{TABLE_NAME}',e['tableName']))
for q in s['setupQueries']: c.execute(q)
c.execute('PRAGMA user_version=11')
c.execute('INSERT INTO Label(value,"order") VALUES (?,?)',('Common',0));c.commit();c.close()`, db, schema], { encoding: 'utf8' });
  assert.equal(create.status, 0, create.stderr);
  const apk = path.join(dir, 'sample.apk'); fs.writeFileSync(apk, 'isolated-sample-apk');
  const remote = new Map([['databases/NotallyDatabase', fs.readFileSync(db)], [`shared_prefs/${PACKAGE}_preferences.xml`, Buffer.from('<map><set name="labelsHiddenInNavigation"/></map>')]]);
  const calls = []; let failStage = false;
  const runCommand = (_program, argv, options) => {
    calls.push(argv); const a = argv.slice(2);
    const ok = stdout => ({ status: 0, stdout: stdout || '', stderr: '' });
    if (a[0] === 'shell' && a[1] === 'pm') return ok('package:/data/app/~~one/sample-123/base.apk\n');
    if (a[0] === 'exec-out' && a[1] === 'cat') return ok(fs.readFileSync(apk));
    if (a[0] === 'shell' && a[1] === 'pidof') return { status: 1, stdout: '', stderr: '' };
    if (a[0] === 'shell' && a[1] === 'am') return ok();
    if (a[0] === 'exec-out' && a[1] === 'run-as') {
      if (a[3] === 'test') return { status: remote.has(a[5]) ? 0 : 1, stdout: '', stderr: '' };
      if (a[3] === 'cat') { assert(remote.has(a[4]), a[4]); return ok(remote.get(a[4])); }
    }
    if (a[0] === 'shell' && a[1] === '-T' && a[4] === 'tee') {
      if (failStage && a[5].includes('shared_prefs')) return { status: 1, stdout: '', stderr: 'injected staging failure' };
      remote.set(a[5], Buffer.from(options.input)); return ok(options.input);
    }
    if (a[0] === 'shell' && a[1] === 'run-as') {
      if (a[3] === 'mv') { remote.set(a[5], remote.get(a[4])); remote.delete(a[4]); return ok(); }
      if (a[3] === 'rm') { remote.delete(a[5]); return ok(); }
    }
    throw new Error(`unexpected test adb command: ${JSON.stringify(a)}`);
  };
  const options = { serial: 'fixture-device', apk, out: path.join(dir, 'fixture'), assignmentLabel: 'Common' };
  const captured = captureFixture(options, { runCommand });
  return { dir, apk, remote, calls, runCommand, fixture: captured.fixtureFile,
    failStage: () => { failStage = true; }, restoreOptions: { serial: options.serial, apk, fixture: captured.fixtureFile, out: path.join(dir, 'restore') } };
}

test('fixture restore independently reads the original SQLite and preferences and retains the overwritten state', t => {
  const h = setup(t);
  const remotePrefs = `shared_prefs/${PACKAGE}_preferences.xml`;
  const original = Buffer.from(h.remote.get(remotePrefs));
  h.remote.set(remotePrefs, Buffer.from('<map><set name="labelsHiddenInNavigation"/><string name="theme">DARK</string></map>'));
  const result = restoreFixture(h.restoreOptions, { runCommand: h.runCommand });
  assert.equal(result.ok, true); assert.equal(result.comparison.ok, true);
  assert.deepEqual(h.remote.get(remotePrefs), original);
  const previous = JSON.parse(fs.readFileSync(result.previousSnapshotPath));
  const snapshot = readSnapshot(previous, { expectedTarget: previous.target, runId: previous.runId, afterSequence: previous.capturedAfterSequence });
  assert.equal(snapshot.ok, true); assert.equal(snapshot.data.preferences.theme, 'DARK');
  assert.equal(h.remote.has('databases/NotallyDatabase-wal'), false);
  assert.equal(h.calls.filter(argv => argv.includes('mv')).length, 2);
});

test('a staging failure never replaces the live database or preferences', t => {
  const h = setup(t); h.failStage();
  const before = new Map(h.remote); const callStart = h.calls.length;
  assert.throws(() => restoreFixture(h.restoreOptions, { runCommand: h.runCommand }), /injected staging failure/);
  for (const [name, bytes] of before) assert.deepEqual(h.remote.get(name), bytes, name);
  assert.equal(h.calls.slice(callStart).some(argv => argv.includes('mv') || argv.includes('rm')), false);
  const result = JSON.parse(fs.readFileSync(path.join(h.restoreOptions.out, 'result.json')));
  assert.equal(result.ok, false); assert.equal(result.stage, 'stage-complete-file-set');
  assert.equal(fs.existsSync(result.previousSnapshotPath), true);
});

test('wrong device, APK or altered fixture fails before any device command', t => {
  const h = setup(t); const count = h.calls.length;
  assert.throws(() => restoreFixture({ ...h.restoreOptions, serial: 'another-device' }, { runCommand: h.runCommand }), /fixture_target_or_apk_mismatch/);
  const badApk = path.join(h.dir, 'different.apk'); fs.writeFileSync(badApk, 'different-apk');
  assert.throws(() => restoreFixture({ ...h.restoreOptions, apk: badApk }, { runCommand: h.runCommand }), /fixture_target_or_apk_mismatch/);
  const fixture = JSON.parse(fs.readFileSync(h.fixture)); fs.appendFileSync(fixture.snapshot.path, '\n');
  assert.throws(() => restoreFixture(h.restoreOptions, { runCommand: h.runCommand }), /fixture_manifest_changed/);
  assert.equal(h.calls.length, count);
});
