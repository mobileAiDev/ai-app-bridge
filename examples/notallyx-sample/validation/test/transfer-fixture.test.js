'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { transferFixture } = require('../transfer-fixture');
const { captureFixture, verifyFixture } = require('../fixed-fixture');
const { readSnapshot } = require('../oracles');
const { PACKAGE } = require('../collector');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const prefsPath = `shared_prefs/${PACKAGE}_preferences.xml`;
const preferences = extra => Buffer.from('<map><set name="labelsHiddenInNavigation"/>' + (extra || '') + '</map>');
const read = file => JSON.parse(fs.readFileSync(file));

function database(directory, name, { title = name, label = 'Common', wal = false, reminder = false, pinned = false } = {}) {
  const db = path.join(directory, name), schema = path.resolve(__dirname, '../../app/schemas/com.philkes.notallyx.data.NotallyDatabase/11.json');
  const script = `import json,sqlite3,sys,shutil,pathlib
db,schema,config=sys.argv[1:]; p=json.loads(config); c=sqlite3.connect(db)
s=json.load(open(schema))['database']
for e in s['entities']: c.execute(e['createSql'].replace(chr(36)+'{TABLE_NAME}',e['tableName']))
for q in s['setupQueries']: c.execute(q)
c.execute('PRAGMA user_version=11')
c.execute('INSERT INTO Label(value,"order") VALUES (?,?)',(p['label'],0))
n=dict(id=1,type='NOTE',folder='NOTES',color='DEFAULT',title=p['title'],pinned=0,timestamp=1,modifiedTimestamp=1,labels='[]',body='body',spans='[]',items='[]',images='[]',files='[]',audios='[]',reminders=json.dumps([dict(id=1,dateTime=9999999999999,isNotificationVisible=False)] if p['reminder'] else []),viewMode='EDIT',isPinnedToStatus=int(p['pinned']))
c.execute('INSERT INTO BaseNote ('+','.join(n)+') VALUES ('+','.join('?' for _ in n)+')',list(n.values()));c.commit()
if p['wal']:
 c.execute('PRAGMA journal_mode=WAL');c.execute('PRAGMA wal_autocheckpoint=0')
 c.execute('INSERT INTO Label(value,"order") VALUES (?,?)',('WAL-label',1));c.commit()
for suffix in ('','-wal','-shm'):
 f=pathlib.Path(db+suffix)
 if f.exists(): shutil.copyfile(f,db+suffix+'.captured')
c.close()`;
  const result = spawnSync('python3', ['-c', script, db, schema, JSON.stringify({ title, label, wal, reminder, pinned })], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const files = new Map();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = db + suffix + '.captured';
    if (fs.existsSync(file)) files.set('databases/NotallyDatabase' + suffix, fs.readFileSync(file));
  }
  return files;
}

function setup(t, { sourceWal = false, destinationWal = false, destinationPrefs, destinationNote } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-transfer-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = database(dir, 'source-db', { title: 'Source note', wal: sourceWal });
  source.set(prefsPath, preferences('<string name="theme">LIGHT</string>'));
  const destination = database(dir, 'destination-db', { title: 'Destination original', label: 'Old', wal: destinationWal, ...destinationNote });
  destination.set(prefsPath, destinationPrefs || preferences('<string name="theme">DARK</string>'));
  const original = new Map([...destination].map(([key, bytes]) => [key, Buffer.from(bytes)]));
  const apk = path.join(dir, 'sample.apk'), apkBytes = Buffer.from('identical-sample-apk'); fs.writeFileSync(apk, apkBytes);
  const fromTarget = { serial: 'source-device', packageName: PACKAGE }, toSerial = 'destination-device';
  const calls = [], controls = {}; let stops = 0, tees = 0, moves = 0, pidChecks = 0;
  const runCommand = (program, argv, options = {}) => {
    assert.equal(program, 'adb'); assert.equal(argv[0], '-s');
    assert([fromTarget.serial, toSerial].includes(argv[1]), 'test_never_selects_an_unknown_device');
    const isDestination = argv[1] === toSerial, remote = isDestination ? destination : source;
    const a = argv.slice(2), call = { argv: [program, ...argv], input: Buffer.from(options.input || '') }; calls.push(call);
    const done = (stdout = '', status = 0, stderr = '') => {
      Object.assign(call, { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), status });
      return { stdout, status, stderr };
    };
    if (a[0] === 'shell' && a[1] === 'pm') return done('package:/data/app/~~one/sample-123/base.apk\n');
    if (a[0] === 'exec-out' && a[1] === 'cat') return done(isDestination && controls.wrongApk ? 'wrong-apk' : apkBytes);
    if (a[0] === 'shell' && a[1] === 'am') {
      assert.deepEqual(a, ['shell', 'am', 'force-stop', PACKAGE]);
      if (isDestination) { stops += 1; if (controls.onStop) controls.onStop(stops); }
      return done();
    }
    if (a[0] === 'shell' && a[1] === 'pidof') {
      if (isDestination) {
        pidChecks += 1;
        if (controls.pidError && pidChecks > 2) return done('', 1, 'pidof permission denied');
        if (controls.restartAfterStaging && tees >= (sourceWal ? 4 : 2)) return done('1234\n');
      }
      return done('', 1);
    }
    if (a[0] === 'exec-out' && a[1] === 'run-as') {
      assert.equal(a[2], PACKAGE);
      if (a[3] === 'test' && a[4] === '-f') return done('', remote.has(a[5]) ? 0 : 1);
      if (a[3] === 'test' && a[4] === '-d') return done('', [...remote.keys()].some(key => key.startsWith(a[5] + '/')) ? 0 : 1);
      if (a[3] === 'find') return done([...remote.keys()].filter(key => key.startsWith(a[4] + '/')).join('\0') + '\0');
      if (a[3] === 'cat') {
        assert(remote.has(a[4]), a[4]); return done(remote.get(a[4]));
      }
    }
    if (a[0] === 'shell' && a[1] === '-T' && a[4] === 'tee') {
      assert(isDestination); tees += 1;
      if (controls.failStage && a[5].startsWith('shared_prefs/')) return done('', 1, 'injected staging failure');
      remote.set(a[5], Buffer.from(options.input));
      if (controls.onStage) controls.onStage(tees);
      return done(options.input);
    }
    if (a[0] === 'shell' && a[1] === 'run-as') {
      assert(isDestination); assert.equal(a[2], PACKAGE);
      if (a[3] === 'mkdir') return done();
      if (a[3] === 'mv') {
        moves += 1;
        if (controls.failSecondMove && moves === 2) return done('', 1, 'injected install failure');
        remote.set(a[5], remote.get(a[4])); remote.delete(a[4]); return done();
      }
      if (a[3] === 'rm') { remote.delete(a[5]); return done(); }
    }
    throw new Error('unexpected mock command: ' + JSON.stringify(argv));
  };
  const captured = captureFixture({ serial: fromTarget.serial, apk, out: path.join(dir, 'source-fixture'), assignmentLabel: 'Common' }, { runCommand });
  const verified = verifyFixture(captured.fixtureFile, fromTarget, sha(apkBytes));
  const sourceEvidence = [captured.fixtureFile, verified.fixture.snapshot.path, verified.manifest.acquisition.transcript.path,
    ...Object.values(verified.manifest.files).filter(Boolean).map(file => file.path)].map(file => ({ file, bytes: fs.readFileSync(file) }));
  calls.length = 0;
  return { dir, source, destination, original, calls, controls, runCommand, verified, sourceEvidence,
    options: { fromFixture: captured.fixtureFile, fromTarget, toSerial, apk, out: path.join(dir, 'transfer') } };
}
const run = h => transferFixture(h.options, { runCommand: h.runCommand });
const noInstall = h => assert.equal(h.calls.some(call => call.argv.includes('mv') || call.argv.includes('rm')), false);

test('copies an explicit source to a real destination baseline and preserves both provenance and the previous state', t => {
  const h = setup(t, { destinationWal: true }), result = run(h);
  assert.equal(result.ok, true); assert.equal(result.appState, 'force-stopped');
  assert(h.calls.every(call => call.argv[1] === '-s' && call.argv[2] === h.options.toSerial));
  for (const { file, bytes } of h.sourceEvidence) assert.deepEqual(fs.readFileSync(file), bytes, file);
  const previous = read(result.previousSnapshotPath);
  const before = readSnapshot(previous, { expectedTarget: result.target, expectedApkSha256: result.apkSha256,
    runId: previous.runId, afterSequence: previous.capturedAfterSequence });
  assert.equal(before.ok, true); assert.equal(before.data.notes[0].title, 'Destination original');
  assert.equal(before.data.preferences.theme, 'DARK'); assert(previous.files.wal && previous.files.shm);
  const baseline = verifyFixture(result.fixtureFile, result.target, result.apkSha256);
  assert.deepEqual(baseline.snapshot.data, h.verified.snapshot.data);
  assert.deepEqual(baseline.snapshot.attachments, h.verified.snapshot.attachments);
  assert.equal(baseline.fixture.target.serial, h.options.toSerial);
  assert.equal(read(h.options.fromFixture).target.serial, h.options.fromTarget.serial);
  assert.equal(h.destination.has('databases/NotallyDatabase-wal'), false);
  assert.equal(h.destination.has('databases/NotallyDatabase-shm'), false);
  const commands = read(path.join(h.options.out, 'commands.json'));
  assert.equal(commands.length, h.calls.length);
  commands.forEach((command, index) => {
    const call = h.calls[index]; assert.deepEqual(command.argv, call.argv);
    assert.equal(command.inputSha256, sha(call.input)); assert.equal(command.stdoutSha256, sha(call.stdout));
    assert.equal(command.stderrSha256, sha(call.stderr));
  });
  assert.equal(h.calls.filter(call => call.argv.includes('force-stop')).length, 3);
});

test('copies all four database, WAL, SHM and preference files when present', t => {
  const h = setup(t, { sourceWal: true }), result = run(h);
  assert.equal(result.ok, true);
  assert.equal(result.installedFiles.filter(file => file.present).length, 4);
  for (const [remote, bytes] of h.source) assert.deepEqual(h.destination.get(remote), bytes, remote);
  assert(verifyFixture(result.fixtureFile, result.target, result.apkSha256).snapshot.data.labels.some(label => label.value === 'WAL-label'));
});

test('requires all explicit routing inputs and refuses a forged source serial before any adb command', t => {
  const h = setup(t);
  for (const key of ['fromFixture', 'fromTarget', 'toSerial', 'apk', 'out']) {
    const options = { ...h.options }; delete options[key];
    assert.throws(() => transferFixture(options, { runCommand: h.runCommand }), /explicit_/);
  }
  assert.throws(() => transferFixture({ ...h.options, fromTarget: { ...h.options.fromTarget, serial: 'invented-source' } },
    { runCommand: h.runCommand }), /fixture_target_or_apk_mismatch/);
  assert.equal(h.calls.length, 0);
  assert.equal(read(path.join(h.options.out, 'result.json')).stage, 'verify-source');
});

test('rejects a destination APK mismatch before stopping or modifying the destination', t => {
  const h = setup(t); h.controls.wrongApk = true;
  assert.throws(() => run(h), /installed_apk_mismatch/); noInstall(h);
  assert.equal(h.calls.length, 2);
  assert.equal(read(path.join(h.options.out, 'result.json')).stage, 'verify-destination-apk');
});

test('preserves attachment bytes before refusing an unsafe destination', t => {
  const h = setup(t); h.destination.set('files/attachments/Images/original.png', Buffer.from('original-attachment'));
  assert.throws(() => run(h), /attachments_or_scheduled_effects_unsupported/); noInstall(h);
  const report = read(path.join(h.options.out, 'result.json')), previous = read(report.previousSnapshotPath);
  assert.equal(report.stage, 'preserve-destination-state'); assert.equal(previous.attachments.length, 1);
  assert.equal(fs.readFileSync(previous.attachments[0].path, 'utf8'), 'original-attachment');
  assert.equal(h.calls.some(call => call.argv.includes('tee')), false);
});

for (const [name, options, error] of [
  ['reminders', { destinationNote: { reminder: true } }, /attachments_or_scheduled_effects_unsupported/],
  ['ongoing notifications', { destinationNote: { pinned: true } }, /attachments_or_scheduled_effects_unsupported/],
  ['periodic backup', { destinationPrefs: preferences('<int name="autoBackupPeriodDays" value="1"/>') }, /automatic_backup_unsupported/],
  ['backup on save', { destinationPrefs: preferences('<boolean name="backupOnSave" value="true"/>') }, /automatic_backup_unsupported/],
]) {
  test('refuses destination ' + name + ' after preserving its complete snapshot', t => {
    const h = setup(t, options); assert.throws(() => run(h), error); noInstall(h);
    assert(fs.existsSync(read(path.join(h.options.out, 'result.json')).previousSnapshotPath));
    assert.equal(h.calls.some(call => call.argv.includes('tee')), false);
  });
}

test('a staging failure preserves the old file set and never retries or rolls back', t => {
  const h = setup(t); h.controls.failStage = true;
  assert.throws(() => run(h), /injected staging failure/); noInstall(h);
  for (const [remote, bytes] of h.original) assert.deepEqual(h.destination.get(remote), bytes);
  const report = read(path.join(h.options.out, 'result.json'));
  assert.equal(report.stage, 'stage-file-set'); assert(fs.existsSync(report.previousSnapshotPath));
  assert.equal(h.calls.filter(call => call.argv.includes('tee')).length, 2);
});

test('an installation failure retains the partially copied state and its original snapshot', t => {
  const h = setup(t); h.controls.failSecondMove = true;
  assert.throws(() => run(h), /injected install failure/);
  assert.deepEqual(h.destination.get('databases/NotallyDatabase'), h.source.get('databases/NotallyDatabase'));
  assert.deepEqual(h.destination.get(prefsPath), h.original.get(prefsPath));
  const report = read(path.join(h.options.out, 'result.json'));
  assert.equal(report.stage, 'install-file-set'); assert(fs.existsSync(report.previousSnapshotPath));
  assert.equal(report.installedFiles[0].remote, 'databases/NotallyDatabase');
  assert.equal(h.calls.filter(call => call.argv.includes('mv')).length, 2);
  assert(h.calls.at(-1).argv.includes('mv')); assert.equal(fs.existsSync(path.join(h.options.out, 'fixture')), false);
});

test('independent destination readback rejects a changed copy despite successful write commands', t => {
  const h = setup(t);
  h.controls.onStop = count => { if (count === 2) h.destination.set('databases/NotallyDatabase', h.original.get('databases/NotallyDatabase')); };
  assert.throws(() => run(h), /transferred_file_set_mismatch:database/);
  const report = read(path.join(h.options.out, 'result.json'));
  assert.equal(report.stage, 'independent-destination-readback'); assert(fs.existsSync(report.transferredSnapshotPath));
  assert.equal(fs.existsSync(path.join(h.options.out, 'fixture')), false);
});

test('a changed source evidence file stops transfer before live replacement', t => {
  const h = setup(t);
  h.controls.onStage = count => { if (count === 1) fs.appendFileSync(h.verified.fixture.snapshot.path, '\n'); };
  assert.throws(() => run(h), /source_evidence_changed/); noInstall(h);
  assert.equal(read(path.join(h.options.out, 'result.json')).stage, 'install-file-set');
});

test('a destination process restart prevents replacement of its live file set', t => {
  const h = setup(t); h.controls.restartAfterStaging = true;
  assert.throws(() => run(h), /destination_process_restarted/); noInstall(h);
  for (const [remote, bytes] of h.original) assert.deepEqual(h.destination.get(remote), bytes);
});

test('a pidof error is not interpreted as a stopped process', t => {
  const h = setup(t); h.controls.pidError = true;
  assert.throws(() => run(h), /destination_process_probe_failed/); noInstall(h);
  assert.equal(h.calls.some(call => call.argv.includes('tee')), false);
});

test('the final fixture is independently rechecked after the first successful readback', t => {
  const h = setup(t), changed = database(h.dir, 'late-change', { title: 'Late change' });
  h.controls.onStop = count => { if (count === 3) h.destination.set('databases/NotallyDatabase', changed.get('databases/NotallyDatabase')); };
  assert.throws(() => run(h), /destination_fixture_business_state_mismatch/);
  const report = read(path.join(h.options.out, 'result.json'));
  assert.equal(report.ok, false); assert.equal(report.stage, 'capture-destination-fixture');
  assert.equal(report.comparison.ok, true); assert(fs.existsSync(report.fixtureFile));
});
