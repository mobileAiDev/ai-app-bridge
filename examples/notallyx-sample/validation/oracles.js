'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const COMMIT = '03ff809f058dbcabd5f0d20f114546686dfc9cb5';
const verified = new WeakSet();
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const hashFile = (file) => sha256(fs.readFileSync(file));
const fail = (reason, details) => ({ verdict: 'inconclusive', ok: false, reason, ...(details ? { details } : {}) });
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

function verifyFile(file) {
  requireThat(file && typeof file.path === 'string' && path.isAbsolute(file.path), 'absolute_evidence_path_required');
  requireThat(/^[a-f0-9]{64}$/.test(file.sha256 || ''), 'evidence_sha256_required');
  requireThat(fs.statSync(file.path).isFile(), 'evidence_file_required');
  requireThat(hashFile(file.path) === file.sha256, 'evidence_hash_mismatch');
  return file.path;
}

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

function validateData(data) {
  for (const note of data.notes) {
    requireThat(Number.isSafeInteger(note.id) && Number.isSafeInteger(note.timestamp) && Number.isSafeInteger(note.modifiedTimestamp), 'unsafe_note_integer');
    requireThat(['NOTE', 'LIST'].includes(note.type) && ['NOTES', 'ARCHIVED', 'DELETED'].includes(note.folder), 'invalid_note_enum');
    requireThat(['EDIT', 'READ_ONLY'].includes(note.viewMode), 'invalid_note_viewmode');
    requireThat(typeof note.title === 'string' && typeof note.body === 'string' && typeof note.color === 'string', 'invalid_note_text');
    requireThat(note.labels.every((label) => typeof label === 'string'), 'invalid_note_labels');
    for (const item of note.items) requireThat(typeof item.body === 'string' && typeof item.checked === 'boolean' && typeof item.isChild === 'boolean', 'invalid_list_item');
    for (const field of ['images', 'files']) for (const item of note[field]) requireThat(['localName', 'originalName', 'mimeType'].every((key) => typeof item[key] === 'string'), 'invalid_attachment_ref');
    for (const item of note.audios) requireThat(typeof item.name === 'string' && Number.isSafeInteger(item.timestamp), 'invalid_audio_ref');
    for (const item of note.reminders) requireThat(Number.isSafeInteger(item.id) && Number.isSafeInteger(item.dateTime) && typeof item.isNotificationVisible === 'boolean', 'invalid_reminder');
  }
}

function readSnapshot(manifest, options = {}) {
  try {
    requireThat(manifest?.schemaVersion === 'aab.notallyx-snapshot/v1', 'snapshot_schema_required');
    requireThat(typeof options.runId === 'string' && Number.isSafeInteger(options.afterSequence) && options.expectedTarget, 'validation_context_required');
    requireThat(manifest.runId === options.runId, 'snapshot_wrong_run');
    requireThat(isDeepStrictEqual(manifest.target, options.expectedTarget), 'snapshot_wrong_target');
    requireThat(typeof manifest.snapshotId === 'string' && manifest.snapshotId.length > 0, 'snapshot_identity_required');
    requireThat(Number.isSafeInteger(manifest.capturedAfterSequence) && manifest.capturedAfterSequence >= options.afterSequence, 'snapshot_before_action');
    requireThat(manifest.identity?.upstreamCommit === COMMIT && /^[a-f0-9]{64}$/.test(manifest.identity.apkSha256 || ''), 'snapshot_app_identity_required');
    if (options.expectedApkSha256) requireThat(manifest.identity.apkSha256 === options.expectedApkSha256, 'snapshot_wrong_apk');
    const acquisition = manifest.acquisition;
    requireThat(acquisition?.method === 'run-as-force-stop' && acquisition.packageName === manifest.target.packageName, 'quiesced_run_as_required');
    const clock = [acquisition.forceStopCompletedAtMs, acquisition.pidof?.checkedAtMs, acquisition.pullStartedAtMs, acquisition.pullCompletedAtMs, acquisition.pidofAfter?.checkedAtMs];
    requireThat(clock.every(Number.isFinite) && clock.every((value, index) => index === 0 || value >= clock[index - 1]), 'invalid_acquisition_window');
    for (const result of [acquisition.pidof, acquisition.pidofAfter]) requireThat([0, 1].includes(result?.exitCode) && typeof result.stdout === 'string' && result.stdout.trim() === '', 'writer_not_quiesced');
    if (options.minCapturedAtMs != null) requireThat(acquisition.pullStartedAtMs >= options.minCapturedAtMs, 'snapshot_time_before_action');
    const transcriptPath = verifyFile(acquisition.transcript);
    const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
    requireThat(Array.isArray(transcript) && transcript.length >= 3, 'acquisition_transcript_missing');
    const matches = (row, suffix) => Array.isArray(row.argv) && row.argv[1] === '-s' && row.argv[2] === manifest.target.serial && isDeepStrictEqual(row.argv.slice(3), suffix);
    requireThat(transcript.some((row) => matches(row, ['shell', 'am', 'force-stop', manifest.target.packageName]) && row.exitCode === 0 && row.finishedAtMs === acquisition.forceStopCompletedAtMs), 'force_stop_transcript_missing');
    for (const result of [acquisition.pidof, acquisition.pidofAfter]) requireThat(transcript.some((row) => matches(row, ['shell', 'pidof', manifest.target.packageName]) && row.exitCode === result.exitCode && row.stdout === result.stdout && row.finishedAtMs === result.checkedAtMs), 'pidof_transcript_missing');
    for (const key of ['database', 'wal', 'shm', 'preferences']) requireThat(Object.hasOwn(manifest.files || {}, key), `explicit_file_presence_required:${key}`);
    requireThat(manifest.files.database !== null, 'database_missing');
    const remotePaths = { database: 'databases/NotallyDatabase', wal: 'databases/NotallyDatabase-wal', shm: 'databases/NotallyDatabase-shm', preferences: `shared_prefs/${manifest.target.packageName}_preferences.xml` };
    for (const [key, remotePath] of Object.entries(remotePaths)) {
      const file = manifest.files[key];
      if (file === null) requireThat(transcript.some((row) => matches(row, ['exec-out', 'run-as', manifest.target.packageName, 'test', '-f', remotePath]) && row.exitCode === 1 && row.startedAtMs >= acquisition.pullStartedAtMs && row.finishedAtMs <= acquisition.pullCompletedAtMs), `file_absence_not_observed:${key}`);
      else requireThat(file.remotePath === remotePath && transcript.some((row) => matches(row, ['exec-out', 'run-as', manifest.target.packageName, 'cat', remotePath]) && row.exitCode === 0 && row.stdoutSha256 === file.sha256 && row.startedAtMs >= acquisition.pullStartedAtMs && row.finishedAtMs <= acquisition.pullCompletedAtMs), `file_not_bound_to_acquisition:${key}`);
    }
    const files = {};
    for (const [key, value] of Object.entries(manifest.files)) if (value !== null) files[key] = verifyFile(value);
    requireThat(fs.readFileSync(files.database).subarray(0, 16).equals(Buffer.from('SQLite format 3\0')), 'encrypted_or_non_sqlite_database_unsupported');
    const attachments = (manifest.attachments || []).map((file) => {
      requireThat(['Images', 'Files', 'Audios'].includes(file.kind) && typeof file.name === 'string' && file.name, 'invalid_attachment_descriptor');
      requireThat(file.remotePath === `files/attachments/${file.kind}/${file.name}` && transcript.some((row) => matches(row, ['exec-out', 'run-as', manifest.target.packageName, 'cat', file.remotePath]) && row.exitCode === 0 && row.stdoutSha256 === file.sha256 && row.startedAtMs >= acquisition.pullStartedAtMs && row.finishedAtMs <= acquisition.pullCompletedAtMs), 'attachment_not_bound_to_acquisition');
      verifyFile(file); return { kind: file.kind, name: file.name, sha256: file.sha256, bytes: fs.statSync(file.path).size };
    });
    requireThat(new Set(attachments.map((item) => `${item.kind}/${item.name}`)).size === attachments.length, 'duplicate_attachment_evidence');
    const result = spawnSync(options.python || 'python3', [path.join(__dirname, 'read_snapshot.py')], { input: JSON.stringify(files), encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
    requireThat(result.status === 0, `sqlite_read_failed:${result.stderr || result.error?.message || result.status}`);
    const data = JSON.parse(result.stdout); validateData(data);
    requireThat(data.preferences.dataOnExternalStorage !== true, 'external_storage_snapshot_unsupported');
    for (const file of [acquisition.transcript, ...Object.values(manifest.files).filter(Boolean), ...(manifest.attachments || [])]) verifyFile(file);
    const snapshot = { ok: true, verdict: 'observed', snapshotId: manifest.snapshotId, runId: manifest.runId,
      target: structuredClone(manifest.target), identity: structuredClone(manifest.identity), capturedAfterSequence: manifest.capturedAfterSequence,
      capturedAtMs: acquisition.pullCompletedAtMs, files: structuredClone(manifest.files), data,
      attachments: attachments.sort((a, b) => `${a.kind}/${a.name}`.localeCompare(`${b.kind}/${b.name}`)),
      provenance: 'Host collector transcript and hashes; not a cryptographic device attestation' };
    deepFreeze(snapshot); verified.add(snapshot); return snapshot;
  } catch (error) { return fail(error.message); }
}

function references(note) {
  return [...note.images.map((item) => ({ kind: 'Images', name: item.localName })),
    ...note.files.map((item) => ({ kind: 'Files', name: item.localName })),
    ...note.audios.map((item) => ({ kind: 'Audios', name: item.name }))];
}

function checkSnapshot(snapshot, expected) {
  if (!verified.has(snapshot)) return fail('unverified_snapshot');
  try {
    requireThat(expected && typeof expected.id === 'string' && expected.id, 'oracle_id_required');
    const checks = [];
    const equal = (field, actual, wanted) => checks.push({ field, verdict: isDeepStrictEqual(actual, wanted) ? 'passed' : 'failed', expected: wanted, actual });
    if (Object.hasOwn(expected, 'noteCount')) equal('noteCount', snapshot.data.notes.length, expected.noteCount);
    for (const [index, test] of (expected.notes || []).entries()) {
      requireThat(test.where && Object.keys(test.where).length > 0 && Object.keys(test.where).every((key) => ['id', 'title'].includes(key)), 'unique_note_selector_required');
      const selected = snapshot.data.notes.filter((note) => Object.entries(test.where).every(([key, value]) => isDeepStrictEqual(note[key], value)));
      const label = `notes[${index}]`;
      equal(`${label}.count`, selected.length, test.absent === true ? 0 : 1);
      if (test.absent === true || selected.length !== 1) continue;
      requireThat(test.fields && Object.keys(test.fields).length > 0, 'note_business_fields_required');
      for (const [field, value] of Object.entries(test.fields)) {
        requireThat(Object.hasOwn(selected[0], field), `unknown_note_field:${field}`);
        equal(`${label}.${field}`, selected[0][field], value);
      }
      if (test.attachmentFiles === true) for (const ref of references(selected[0])) {
        const found = snapshot.attachments.filter((file) => file.kind === ref.kind && file.name === ref.name);
        if (found.length !== 1) checks.push({ field: `${label}.attachment:${ref.kind}/${ref.name}`, verdict: 'inconclusive', reason: 'attachment_file_evidence_missing' });
      }
    }
    if (Object.hasOwn(expected, 'labels')) equal('labels', snapshot.data.labels, [...expected.labels].sort((a, b) => a.value.localeCompare(b.value)));
    for (const [key, value] of Object.entries(expected.preferences || {})) {
      if (!Object.hasOwn(snapshot.data.preferences, key)) checks.push({ field: `preferences.${key}`, verdict: 'failed', reason: 'preference_key_absent', expected: value });
      else equal(`preferences.${key}`, snapshot.data.preferences[key], value);
    }
    for (const key of expected.preferencesAbsent || []) equal(`preferences.${key}.absent`, !Object.hasOwn(snapshot.data.preferences, key), true);
    requireThat(checks.length > 0, 'empty_business_oracle');
    const verdict = checks.some((item) => item.verdict === 'failed') ? 'failed' : checks.some((item) => item.verdict === 'inconclusive') ? 'inconclusive' : 'passed';
    return { id: expected.id, verdict, ok: verdict === 'passed', snapshotId: snapshot.snapshotId, runId: snapshot.runId, source: 'independent-host-business-oracle', checks };
  } catch (error) { return { id: expected?.id, ...fail(error.message) }; }
}

const ALLOWED_IGNORES = new Set(['notes.modifiedTimestamp', 'notes.items.checkedTimestamp', 'notes.reminders.isNotificationVisible', 'preferences.periodicBackupLastExecution']);
function canonical(snapshot, ignoreFields = []) {
  requireThat(verified.has(snapshot), 'unverified_snapshot');
  requireThat(ignoreFields.every((field) => ALLOWED_IGNORES.has(field)), 'business_field_cannot_be_ignored');
  const result = structuredClone(snapshot.data);
  result.attachments = structuredClone(snapshot.attachments);
  for (const field of ignoreFields) {
    if (field === 'notes.modifiedTimestamp') result.notes.forEach((note) => delete note.modifiedTimestamp);
    if (field === 'notes.items.checkedTimestamp') result.notes.forEach((note) => note.items.forEach((item) => delete item.checkedTimestamp));
    if (field === 'notes.reminders.isNotificationVisible') result.notes.forEach((note) => note.reminders.forEach((item) => delete item.isNotificationVisible));
    if (field === 'preferences.periodicBackupLastExecution') delete result.preferences.periodicBackupLastExecution;
  }
  return result;
}

function compareCanonical(before, after, { id = 'upgrade-preserves-business-data', ignoreFields = [] } = {}) {
  try {
    requireThat(verified.has(before) && verified.has(after), 'unverified_snapshot');
    requireThat(before.snapshotId !== after.snapshotId && after.capturedAtMs > before.capturedAtMs, 'fresh_after_snapshot_required');
    requireThat(isDeepStrictEqual(before.target, after.target), 'comparison_target_mismatch');
    for (const snapshot of [before, after]) for (const note of snapshot.data.notes) for (const ref of references(note)) {
      requireThat(snapshot.attachments.some((file) => file.kind === ref.kind && file.name === ref.name), 'comparison_attachment_evidence_missing');
    }
    const a = canonical(before, ignoreFields); const b = canonical(after, ignoreFields);
    const differences = [];
    for (const key of Object.keys(a)) if (!isDeepStrictEqual(a[key], b[key])) differences.push({ field: key, before: a[key], after: b[key] });
    const verdict = differences.length ? 'failed' : 'passed';
    return { id, verdict, ok: verdict === 'passed', source: 'independent-host-business-oracle',
      before: { snapshotId: before.snapshotId, runId: before.runId, identity: before.identity },
      after: { snapshotId: after.snapshotId, runId: after.runId, identity: after.identity }, ignoreFields: [...ignoreFields], differences };
  } catch (error) { return { id, ...fail(error.message) }; }
}

module.exports = { readSnapshot, checkSnapshot, compareCanonical, canonical, hashFile, verifyFile, COMMIT };
