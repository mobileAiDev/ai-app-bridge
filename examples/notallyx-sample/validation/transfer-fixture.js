'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { verifyFixture, captureFixture } = require('./fixed-fixture');
const { collectSnapshot, PACKAGE } = require('./collector');
const { readSnapshot } = require('./oracles');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const validSerial = serial => typeof serial === 'string' && /^[A-Za-z0-9_.:-]+$/.test(serial);

function safeSnapshot(manifest, target, apkSha256) {
  const snapshot = readSnapshot(manifest, { expectedTarget: target, expectedApkSha256: apkSha256,
    runId: manifest.runId, afterSequence: manifest.capturedAfterSequence });
  assert.equal(snapshot.ok, true, 'invalid_snapshot:' + snapshot.reason);
  assert.equal(manifest.attachmentScope, 'private-files-attachments');
  assert.equal(manifest.attachments.length, 0, 'attachments_or_scheduled_effects_unsupported');
  assert(!snapshot.data.notes.some(note => note.images.length || note.files.length || note.audios.length
    || note.reminders.length || note.isPinnedToStatus), 'attachments_or_scheduled_effects_unsupported');
  const preferences = snapshot.data.preferences;
  assert(preferences.backupOnSave !== true && !(preferences.autoBackupPeriodDays > 0)
    && (preferences.autoBackup === undefined || preferences.autoBackup === 'emptyPath'), 'automatic_backup_unsupported');
  return snapshot;
}

// Explicitly invoked only; importing this module never starts adb or selects a device.
function transferFixture(options = {}, { runCommand = spawnSync, now = Date.now } = {}) {
  for (const key of ['fromFixture', 'apk', 'out']) {
    assert(typeof options[key] === 'string' && options[key].length > 0, 'explicit_argument_required:' + key);
  }
  assert(options.fromTarget && validSerial(options.fromTarget.serial)
    && options.fromTarget.packageName === PACKAGE, 'explicit_source_target_required');
  assert(validSerial(options.toSerial), 'explicit_destination_serial_required');
  assert.notEqual(options.toSerial, options.fromTarget.serial, 'distinct_destination_required');
  const fromTarget = structuredClone(options.fromTarget), target = { serial: options.toSerial, packageName: PACKAGE };
  const out = path.resolve(options.out), fromFixture = path.resolve(options.fromFixture), apk = path.resolve(options.apk);
  assert(!fs.existsSync(out), 'new_output_directory_required');
  fs.mkdirSync(out, { recursive: true });
  const adb = options.adb || 'adb', startedAtMs = now();
  const runId = 'transfer-' + startedAtMs + '-' + crypto.randomBytes(4).toString('hex');
  const report = { ok: false, stage: 'verify-source', fromTarget, target, fromFixture, apk,
    runId, startedAtMs, installedFiles: [], recovery: 'No automatic rollback, retry or relaunch. Preserve this directory and the destination state after any failure.' };
  const transcript = [];
  const save = () => write(path.join(out, 'result.json'), report);
  save(); write(path.join(out, 'commands.json'), transcript);
  const loggedRun = (program, argv, commandOptions) => {
    assert.equal(program, adb, 'unexpected_adb_program');
    assert.deepEqual(argv.slice(0, 2), ['-s', target.serial], 'unexpected_device_route');
    const started = now(), input = Buffer.from(commandOptions?.input || '');
    let result, thrown;
    try { result = runCommand(program, argv, commandOptions); return result; }
    catch (error) { thrown = error; throw error; }
    finally {
      const stdout = Buffer.from(result?.stdout || ''), stderr = Buffer.from(result?.stderr || '');
      transcript.push({ sequence: transcript.length + 1, stage: report.stage, argv: [program, ...argv],
        startedAtMs: started, finishedAtMs: now(), exitCode: result?.status ?? null, signal: result?.signal ?? null,
        inputProvided: commandOptions?.input !== undefined, inputBytes: input.length, inputSha256: sha(input),
        stdoutBytes: stdout.length, stdoutSha256: sha(stdout), stderrBytes: stderr.length, stderrSha256: sha(stderr),
        ...(thrown || result?.error ? { error: (thrown || result.error).message } : {}) });
      write(path.join(out, 'commands.json'), transcript);
    }
  };
  const dependencies = { runCommand: loggedRun, now };
  const command = (args, { input, allowed = [0], rejectStderr = false } = {}) => {
    const result = loggedRun(adb, ['-s', target.serial, ...args], { input, timeout: 30000, maxBuffer: 256 * 1024 * 1024 });
    if (result.error || !allowed.includes(result.status)) throw new Error('adb_failed:' + (result.error?.message || result.stderr || result.status));
    assert(!rejectStderr || !String(result.stderr || '').trim(), 'destination_process_probe_failed');
    return Buffer.from(result.stdout || '');
  };
  const stopped = () => {
    const result = command(['shell', 'pidof', PACKAGE], { allowed: [0, 1], rejectStderr: true });
    assert.equal(result.toString().trim(), '', 'destination_process_restarted');
  };
  const capture = (name, sequence) => collectSnapshot({ ...target, out: path.join(out, name),
    runId, sequence, apkSha256: report.apkSha256, adb }, dependencies);
  try {
    report.apkSha256 = sha(fs.readFileSync(apk));
    const source = verifyFixture(fromFixture, fromTarget, report.apkSha256);
    report.source = { fixtureSha256: source.fixtureSha256, snapshotId: source.snapshot.snapshotId,
      snapshotPath: source.fixture.snapshot.path, snapshotSha256: source.fixture.snapshot.sha256, target: source.snapshot.target };
    const sourceFiles = [fromFixture, source.fixture.snapshot.path, source.manifest.acquisition.transcript.path,
      ...Object.values(source.manifest.files).filter(Boolean).map(file => file.path)];
    const sourceHashes = sourceFiles.map(file => ({ path: file, sha256: sha(fs.readFileSync(file)) }));
    report.source.files = sourceHashes;
    const sourceUnchanged = () => {
      for (const file of sourceHashes) assert.equal(sha(fs.readFileSync(file.path)), file.sha256, 'source_evidence_changed:' + file.path);
      assert.equal(sha(fs.readFileSync(apk)), report.apkSha256, 'apk_file_changed');
    };
    report.stage = 'verify-destination-apk'; save();
    const entries = command(['shell', 'pm', 'path', PACKAGE]).toString().trim().split(/\r?\n/);
    assert(entries.length === 1 && /^package:\/data\/app\/[A-Za-z0-9_./+=~-]+\/base\.apk$/.test(entries[0]), 'single_installed_sample_base_apk_required');
    assert.equal(sha(command(['exec-out', 'cat', entries[0].slice(8)])), report.apkSha256, 'installed_apk_mismatch');

    report.stage = 'preserve-destination-state'; save();
    const previous = capture('previous', 0);
    report.previousSnapshotPath = path.join(out, 'previous/snapshot.json'); save();
    const before = safeSnapshot(previous, target, report.apkSha256);
    write(path.join(out, 'previous/observed.json'), before);

    report.stage = 'stage-file-set'; save(); stopped(); sourceUnchanged();
    command(['shell', 'run-as', PACKAGE, 'mkdir', '-p', 'databases', 'shared_prefs']);
    const staged = source.files.map(file => ({ ...file, temporary: file.remote + '.' + runId }));
    for (const file of staged.filter(file => file.bytes !== null)) {
      stopped();
      command(['shell', '-T', 'run-as', PACKAGE, 'tee', file.temporary], { input: file.bytes });
      assert.equal(sha(command(['exec-out', 'run-as', PACKAGE, 'cat', file.temporary])), file.sha256, 'staged_file_hash_mismatch');
    }
    report.stage = 'install-file-set'; save(); sourceUnchanged();
    for (const file of staged) {
      stopped();
      if (file.bytes === null) command(['shell', 'run-as', PACKAGE, 'rm', '-f', file.remote]);
      else command(['shell', 'run-as', PACKAGE, 'mv', file.temporary, file.remote]);
      report.installedFiles.push({ remote: file.remote, present: file.bytes !== null }); save();
      if (file.bytes !== null) assert.equal(sha(command(['exec-out', 'run-as', PACKAGE, 'cat', file.remote])), file.sha256, 'installed_file_hash_mismatch');
    }

    report.stage = 'independent-destination-readback'; save();
    const transferred = capture('transferred', 1);
    report.transferredSnapshotPath = path.join(out, 'transferred/snapshot.json'); save();
    const after = safeSnapshot(transferred, target, report.apkSha256);
    write(path.join(out, 'transferred/observed.json'), after);
    for (const [key, file] of Object.entries(source.manifest.files)) {
      assert.equal(transferred.files[key]?.sha256 ?? null, file?.sha256 ?? null, 'transferred_file_set_mismatch:' + key);
    }
    // Targets intentionally differ. Compare business content without rewriting either identity.
    assert.deepEqual(after.data, source.snapshot.data, 'transferred_business_state_mismatch');
    assert.deepEqual(after.attachments, source.snapshot.attachments, 'transferred_attachments_mismatch');
    report.comparison = { ok: true, source: 'independent-cross-device-content-comparison',
      from: { target: source.snapshot.target, snapshotId: source.snapshot.snapshotId },
      to: { target: after.target, snapshotId: after.snapshotId }, fields: ['data', 'attachments'], ignoredFields: [] };

    report.stage = 'capture-destination-fixture'; save(); sourceUnchanged();
    const captured = captureFixture({ serial: target.serial, apk, out: path.join(out, 'fixture'),
      assignmentLabel: source.fixture.assignmentLabel, adb }, dependencies);
    report.fixtureFile = captured.fixtureFile;
    const final = verifyFixture(captured.fixtureFile, target, report.apkSha256);
    assert.deepEqual(final.snapshot.data, source.snapshot.data, 'destination_fixture_business_state_mismatch');
    assert.deepEqual(final.snapshot.attachments, source.snapshot.attachments, 'destination_fixture_attachments_mismatch');
    sourceUnchanged();
    report.destinationFixtureSha256 = final.fixtureSha256;
    report.destinationSnapshotId = final.snapshot.snapshotId;
    report.appState = 'force-stopped'; report.stage = 'completed'; report.ok = true;
    return report;
  } catch (error) { report.error = error.message; throw error; }
  finally { report.finishedAtMs = now(); save(); }
}

module.exports = { transferFixture };
