#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { collectSnapshot, PACKAGE } = require('./collector');
const { readSnapshot, compareCanonical } = require('./oracles');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const paths = { database: 'databases/NotallyDatabase', wal: 'databases/NotallyDatabase-wal', shm: 'databases/NotallyDatabase-shm',
  preferences: `shared_prefs/${PACKAGE}_preferences.xml` };

function identity(options) {
  if (!/^[A-Za-z0-9_.:-]+$/.test(options.serial || '') || !options.apk || !options.out) throw new Error('serial_apk_new_output_required');
  const out = path.resolve(options.out);
  if (fs.existsSync(out)) throw new Error('new_output_directory_required');
  return { target: { serial: options.serial, packageName: PACKAGE }, out, apkSha256: sha(fs.readFileSync(options.apk)) };
}

function commandPort({ serial, out, adb = 'adb' }, runCommand = spawnSync) {
  const transcript = [];
  return (args, { input, allowed = [0] } = {}) => {
    const startedAtMs = Date.now();
    const result = runCommand(adb, ['-s', serial, ...args], { input, timeout: 30000, maxBuffer: 256 * 1024 * 1024 });
    const stdout = Buffer.from(result.stdout || '');
    transcript.push({ argv: [adb, '-s', serial, ...args], startedAtMs, finishedAtMs: Date.now(), exitCode: result.status,
      stderr: String(result.stderr || ''), stdoutBytes: stdout.length, stdoutSha256: sha(stdout),
      ...(input ? { inputBytes: input.length, inputSha256: sha(input) } : {}) });
    write(path.join(out, 'commands.json'), transcript);
    if (result.error || !allowed.includes(result.status)) throw new Error(`adb_failed:${result.error?.message || result.stderr || result.status}`);
    return stdout;
  };
}

function installedApk(command, apkSha256) {
  const entries = command(['shell', 'pm', 'path', PACKAGE]).toString().trim().split(/\r?\n/);
  if (entries.length !== 1 || !/^package:\/data\/app\/[A-Za-z0-9_./+=~-]+\/base\.apk$/.test(entries[0])) throw new Error('single_installed_sample_base_apk_required');
  if (sha(command(['exec-out', 'cat', entries[0].slice(8)])) !== apkSha256) throw new Error('installed_apk_mismatch');
}

function checkedSnapshot(manifest, expectedTarget, apkSha256) {
  const snapshot = readSnapshot(manifest, { expectedTarget, expectedApkSha256: apkSha256, runId: manifest.runId, afterSequence: manifest.capturedAfterSequence });
  if (!snapshot.ok) throw new Error(`invalid_snapshot:${snapshot.reason}`);
  if (manifest.attachmentScope !== 'private-files-attachments' || manifest.attachments.length
    || snapshot.data.notes.some(note => note.images.length || note.files.length || note.audios.length || note.reminders.length || note.isPinnedToStatus)) {
    throw new Error('fixture_requires_private_notes_without_attachments_or_scheduled_effects');
  }
  const preferences = snapshot.data.preferences;
  if (preferences.backupOnSave === true || preferences.autoBackupPeriodDays > 0
    || (preferences.autoBackup !== undefined && preferences.autoBackup !== 'emptyPath')) throw new Error('automatic_backup_fixture_unsupported');
  return snapshot;
}

function verifyFixture(fixtureFile, expectedTarget, apkSha256) {
  const fixture = read(fixtureFile);
  if (fixture.schemaVersion !== 'aab.notallyx-fixed-fixture/v1' || fixture.target.serial !== expectedTarget.serial
    || fixture.target.packageName !== PACKAGE || fixture.apkSha256 !== apkSha256) throw new Error('fixture_target_or_apk_mismatch');
  if (sha(fs.readFileSync(fixture.snapshot.path)) !== fixture.snapshot.sha256) throw new Error('fixture_manifest_changed');
  const manifest = read(fixture.snapshot.path);
  const snapshot = checkedSnapshot(manifest, expectedTarget, apkSha256);
  const hidden = snapshot.data.preferences.labelsHiddenInNavigation;
  if (!Array.isArray(hidden)) throw new Error('explicit_navigation_preferences_required');
  if (snapshot.data.preferences.maxLabelsInNavigation !== undefined && snapshot.data.preferences.maxLabelsInNavigation !== 5) throw new Error('default_navigation_limit_required');
  const visible = snapshot.data.labels.filter(label => !hidden.includes(label.value)).sort((a, b) => b.order - a.order);
  if (!visible.slice(0, 3).some(label => label.value === fixture.assignmentLabel)) throw new Error('assignment_label_must_remain_visible_after_two_new_labels');
  // Read and validate the entire restore set before issuing any device command.
  const files = Object.entries(paths).map(([key, remote]) => {
    const file = manifest.files[key];
    if (!file) {
      if (key === 'wal' || key === 'shm') return { remote, bytes: null };
      throw new Error('database_and_preferences_required');
    }
    if (file.remotePath !== remote) throw new Error('fixture_file_path_mismatch');
    const bytes = fs.readFileSync(file.path);
    if (sha(bytes) !== file.sha256) throw new Error('fixture_file_changed');
    return { remote, bytes, sha256: file.sha256 };
  });
  return { fixture, manifest, snapshot, files, fixtureSha256: sha(fs.readFileSync(fixtureFile)) };
}

function captureFixture(options, dependencies = {}) {
  const { target, out, apkSha256 } = identity(options);
  if (!options.assignmentLabel) throw new Error('explicit_assignment_label_required');
  fs.mkdirSync(out, { recursive: true });
  const command = commandPort({ ...options, out }, dependencies.runCommand);
  installedApk(command, apkSha256);
  const runId = `fixture-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const manifest = collectSnapshot({ ...target, out: path.join(out, 'baseline'), runId, sequence: 0, apkSha256, adb: options.adb }, dependencies);
  const snapshotPath = path.join(out, 'baseline/snapshot.json');
  const fixture = { schemaVersion: 'aab.notallyx-fixed-fixture/v1', target, apkSha256, createdAtMs: Date.now(),
    assignmentLabel: options.assignmentLabel, snapshot: { path: snapshotPath, sha256: sha(fs.readFileSync(snapshotPath)) },
    scope: 'Private sample DB/WAL/SHM and preferences. Attachments, reminders and ongoing notifications are rejected. UI checks remain the regression runner responsibility.' };
  const fixtureFile = path.join(out, 'fixture.json'); write(fixtureFile, fixture);
  const verified = verifyFixture(fixtureFile, target, apkSha256);
  write(path.join(out, 'baseline/observed.json'), verified.snapshot);
  return { ok: true, fixtureFile, snapshotId: manifest.snapshotId, notes: verified.snapshot.data.notes.length };
}

function restoreFixture(options, dependencies = {}) {
  const { target, out, apkSha256 } = identity(options);
  const verified = verifyFixture(path.resolve(options.fixture), target, apkSha256);
  fs.mkdirSync(out, { recursive: true });
  const startedAtMs = Date.now(), runId = `restore-${startedAtMs}-${crypto.randomBytes(3).toString('hex')}`;
  const command = commandPort({ ...options, out }, dependencies.runCommand);
  let stage = 'identity', previous;
  try {
    installedApk(command, apkSha256);
    stage = 'save-current-state';
    previous = collectSnapshot({ ...target, out: path.join(out, 'previous'), runId, sequence: 0, apkSha256, adb: options.adb }, dependencies);
    checkedSnapshot(previous, target, apkSha256);
    stage = 'stage-complete-file-set';
    const staged = verified.files.map(file => ({ ...file, temporary: `${file.remote}.${runId}` }));
    for (const file of staged.filter(file => file.bytes !== null)) {
      command(['shell', '-T', 'run-as', PACKAGE, 'tee', file.temporary], { input: file.bytes });
      if (sha(command(['exec-out', 'run-as', PACKAGE, 'cat', file.temporary])) !== file.sha256) throw new Error('staged_file_hash_mismatch');
    }
    stage = 'install-file-set';
    const pid = command(['shell', 'pidof', PACKAGE], { allowed: [0, 1] });
    if (pid.toString().trim()) throw new Error('sample_restarted_during_restore');
    for (const file of staged) {
      if (file.bytes === null) command(['shell', 'run-as', PACKAGE, 'rm', '-f', file.remote]);
      else {
        command(['shell', 'run-as', PACKAGE, 'mv', file.temporary, file.remote]);
        if (sha(command(['exec-out', 'run-as', PACKAGE, 'cat', file.remote])) !== file.sha256) throw new Error('restored_file_hash_mismatch');
      }
    }
    stage = 'independent-readback';
    const after = collectSnapshot({ ...target, out: path.join(out, 'restored'), runId, sequence: 1, apkSha256, adb: options.adb }, dependencies);
    const restored = checkedSnapshot(after, target, apkSha256);
    write(path.join(out, 'restored/observed.json'), restored);
    const comparison = compareCanonical(verified.snapshot, restored, { id: 'fixed-fixture-exact-readback', ignoreFields: [] });
    if (!comparison.ok) throw new Error(`restored_canonical_mismatch:${JSON.stringify(comparison)}`);
    if (sha(fs.readFileSync(options.fixture)) !== verified.fixtureSha256) throw new Error('fixture_changed_during_restore');
    const result = { ok: true, target, apkSha256, fixtureSha256: verified.fixtureSha256, previousSnapshotPath: path.join(out, 'previous/snapshot.json'),
      restoredSnapshotPath: path.join(out, 'restored/snapshot.json'), comparison, startedAtMs, finishedAtMs: Date.now(), appState: 'force-stopped' };
    write(path.join(out, 'result.json'), result); return result;
  } catch (error) {
    write(path.join(out, 'result.json'), { ok: false, stage, error: error.message, target, startedAtMs, finishedAtMs: Date.now(),
      previousSnapshotPath: previous ? path.join(out, 'previous/snapshot.json') : null,
      recovery: 'No automatic retry or success claim. Preserve this directory; the app is not relaunched after a failed restore.' });
    throw error;
  }
}

async function runFixedRegression(options) {
  const suite = options.suite || 'core';
  if (!['core', 'backup', 'core-backup'].includes(suite)) throw new Error('explicit_supported_suite_required');
  if (suite !== 'core' && (!options.zip4jJar || !fs.statSync(options.zip4jJar).isFile())) throw new Error('backup_fixture_zip4j_jar_required');
  if (suite === 'backup' && !options.noteTitle) throw new Error('backup_only_controlled_note_title_required');
  const { target, out, apkSha256 } = identity(options);
  const verified = verifyFixture(path.resolve(options.fixture), target, apkSha256);
  fs.mkdirSync(out, { recursive: true });
  const startedAtMs = Date.now();
  const controllerFiles = [__filename, ...['collector.js', 'oracles.js', 'read_snapshot.py'].map(name => path.join(__dirname, name))];
  const controllerArtifacts = controllerFiles.map(file => ({ path: file, sha256: sha(fs.readFileSync(file)) }));
  const source = path.join(out, 'controller-source'); fs.mkdirSync(source);
  for (const file of controllerFiles) fs.copyFileSync(file, path.join(source, path.basename(file)));
  const result = { ok: false, target, suite, fixtureSha256: verified.fixtureSha256, controllerArtifacts, startedAtMs, stage: 'prepare' };
  try {
    restoreFixture({ ...options, out: path.join(out, 'prepare') });
    const runId = `script-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    if (suite !== 'backup') {
      result.stage = 'regression';
      const { main } = require('./run-regression');
      result.regression = await main({ serial: options.serial, apk: path.resolve(options.apk), out: path.join(out, 'regression'),
        runId, assignmentLabel: verified.fixture.assignmentLabel, adb: options.adb });
      if (!result.regression.ok) throw new Error('regression_failed_evidence_and_current_data_preserved');
    }
    if (suite !== 'core') {
      result.stage = 'backup-regression';
      result.backup = await require('./run-backup-regression').main({ serial: options.serial, apk: path.resolve(options.apk), out: path.join(out, 'backup'),
        noteTitle: suite === 'backup' ? options.noteTitle : `AAB-LIST-${runId}`, zip4jJar: options.zip4jJar, adb: options.adb });
      if (!result.backup.ok) throw new Error('backup_regression_failed_evidence_and_current_data_preserved');
    }
    result.stage = 'restore-baseline';
    restoreFixture({ ...options, out: path.join(out, 'restore') });
    const bridge = require('../../../desktop/ai-app-bridge-cli/bin/ai-app-bridge');
    result.launch = await bridge.launchApp(bridge.createBridgeContext({ ...target, adb: options.adb }));
    if (!result.launch.ok) throw new Error('restored_baseline_launch_failed');
    if (controllerArtifacts.some(file => sha(fs.readFileSync(file.path)) !== file.sha256)) throw new Error('fixture_controller_changed_during_run');
    result.ok = true; result.stage = 'completed';
  } catch (error) {
    result.error = error.message;
  }
  result.finishedAtMs = Date.now(); result.wallMs = result.finishedAtMs - startedAtMs;
  write(path.join(out, 'result.json'), result); return result;
}

function parseArguments(argv) {
  const [operation, ...args] = argv, options = {};
  if (!['capture', 'restore', 'run'].includes(operation)) throw new Error('capture_restore_or_run_required');
  for (let i = 0; i < args.length; i += 2) {
    if (!['--serial', '--apk', '--out', '--fixture', '--assignment-label', '--adb', '--suite', '--zip4j-jar', '--note-title'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('invalid_argument');
    options[args[i].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = args[i + 1];
  }
  return { operation, options };
}

if (require.main === module) {
  (async () => {
    const { operation, options } = parseArguments(process.argv.slice(2));
    const result = operation === 'capture' ? captureFixture(options) : operation === 'restore' ? restoreFixture(options) : await runFixedRegression(options);
    console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { captureFixture, restoreFixture, verifyFixture, runFixedRegression, parseArguments };
