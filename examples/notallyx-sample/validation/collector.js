'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PACKAGE = 'io.github.mobileaidev.notallyx.sample';
const COMMIT = '03ff809f058dbcabd5f0d20f114546686dfc9cb5';
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// This function operates a device only when explicitly called by the controller.
// Tests inject runCommand; loading this module never spawns adb.
function collectSnapshot({ serial, packageName, out, runId, sequence, apkSha256,
  adb = 'adb', includeAttachments = true }, { runCommand = spawnSync, now = Date.now } = {}) {
  if (packageName !== PACKAGE) throw new Error('isolated_sample_package_required');
  if (typeof serial !== 'string' || !/^[A-Za-z0-9_.:-]+$/.test(serial)) throw new Error('explicit_serial_required');
  if (typeof runId !== 'string' || !runId || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error('run_identity_required');
  if (!/^[a-f0-9]{64}$/.test(apkSha256 || '')) throw new Error('apk_sha256_required');
  if (typeof out !== 'string' || !out) throw new Error('new_output_directory_required');
  out = path.resolve(out);
  if (fs.existsSync(out) && fs.readdirSync(out).length > 0) throw new Error('output_directory_not_empty');
  fs.mkdirSync(out, { recursive: true });
  const transcriptPath = path.join(out, 'acquisition.json');
  const records = [];
  const saveTranscript = () => fs.writeFileSync(transcriptPath, `${JSON.stringify(records, null, 2)}\n`);
  const command = (args, { binary = false, allowedExitCodes = [0] } = {}) => {
    const startedAtMs = now();
    const result = runCommand(adb, ['-s', serial, ...args], {
      encoding: binary ? null : 'utf8', timeout: 30000, maxBuffer: 256 * 1024 * 1024,
    });
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
    const stderr = String(result.stderr || '');
    const record = { argv: [adb, '-s', serial, ...args], startedAtMs, finishedAtMs: now(),
      exitCode: result.status, stderr, ...(binary ? { stdoutBytes: stdout.length, stdoutSha256: sha256(stdout) } : { stdout: stdout.toString('utf8') }) };
    records.push(record); saveTranscript();
    if (result.error || !allowedExitCodes.includes(result.status)) throw new Error(`adb_failed:${JSON.stringify(args)}:${result.error?.message || stderr || result.status}`);
    return { record, stdout };
  };
  const noProcess = () => {
    const result = command(['shell', 'pidof', PACKAGE], { allowedExitCodes: [0, 1] });
    if (result.record.stdout.trim() || result.record.stderr.trim()) throw new Error('sample_process_still_running_or_pidof_error');
    return { checkedAtMs: result.record.finishedAtMs, exitCode: result.record.exitCode, stdout: result.record.stdout };
  };
  const pull = (remotePath, localPath, required = false) => {
    if (!/^[A-Za-z0-9_./-]+$/.test(remotePath) || remotePath.split('/').includes('..')) throw new Error('unsafe_remote_path');
    const exists = command(['exec-out', 'run-as', PACKAGE, 'test', '-f', remotePath], { allowedExitCodes: [0, 1] });
    if (exists.record.stderr.trim() || exists.record.stdout.trim()) throw new Error('file_probe_error');
    if (exists.record.exitCode === 1) { if (required) throw new Error(`required_remote_file_missing:${remotePath}`); return null; }
    const result = command(['exec-out', 'run-as', PACKAGE, 'cat', remotePath], { binary: true });
    const file = path.join(out, localPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, result.stdout, { flag: 'wx' });
    return { path: file, sha256: sha256(result.stdout), remotePath, bytes: result.stdout.length };
  };
  try {
    const stop = command(['shell', 'am', 'force-stop', PACKAGE]);
    const pidof = noProcess();
    const pullStartedAtMs = now();
    const files = {
      database: pull('databases/NotallyDatabase', 'NotallyDatabase', true),
      wal: pull('databases/NotallyDatabase-wal', 'NotallyDatabase-wal'),
      shm: pull('databases/NotallyDatabase-shm', 'NotallyDatabase-shm'),
      preferences: pull(`shared_prefs/${PACKAGE}_preferences.xml`, 'preferences.xml'),
    };
    const attachments = [];
    if (includeAttachments) {
      for (const kind of ['Images', 'Files', 'Audios']) {
        const root = `files/attachments/${kind}`;
        const directory = command(['exec-out', 'run-as', PACKAGE, 'test', '-d', root], { allowedExitCodes: [0, 1] });
        if (directory.record.stderr.trim() || directory.record.stdout.trim()) throw new Error('attachment_directory_probe_error');
        if (directory.record.exitCode === 1) continue;
        const listing = command(['exec-out', 'run-as', PACKAGE, 'find', root, '-type', 'f', '-print0'], { binary: true });
        for (const remote of listing.stdout.toString('utf8').split('\0').filter(Boolean).sort()) {
          if (!remote.startsWith(`${root}/`)) throw new Error('attachment_outside_declared_root');
          const name = remote.slice(root.length + 1);
          const descriptor = pull(remote, `attachments/${kind}/${name}`, true);
          attachments.push({ kind, name, ...descriptor });
        }
      }
    }
    const pullCompletedAtMs = now();
    const pidofAfter = noProcess();
    saveTranscript();
    const manifest = {
      schemaVersion: 'aab.notallyx-snapshot/v1', snapshotId: crypto.randomUUID(), runId,
      target: { serial, packageName }, identity: { upstreamCommit: COMMIT, apkSha256 }, capturedAfterSequence: sequence,
      acquisition: { method: 'run-as-force-stop', packageName, forceStopCompletedAtMs: stop.record.finishedAtMs,
        pidof, pidofAfter, pullStartedAtMs, pullCompletedAtMs,
        transcript: { path: transcriptPath, sha256: sha256(fs.readFileSync(transcriptPath)) } },
      files, attachments, attachmentScope: includeAttachments ? 'private-files-attachments' : 'not-collected',
    };
    fs.writeFileSync(path.join(out, 'snapshot.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    return manifest;
  } catch (error) {
    saveTranscript();
    fs.writeFileSync(path.join(out, 'collection-failed.json'), `${JSON.stringify({ ok: false, error: error.message, runId, sequence, target: { serial, packageName } }, null, 2)}\n`);
    throw error;
  }
}

if (require.main === module) {
  try { const result = collectSnapshot(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))); console.log(JSON.stringify({ ok: true, snapshotId: result.snapshotId, path: path.join(path.dirname(result.files.database.path), 'snapshot.json') })); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { collectSnapshot, PACKAGE, COMMIT };
