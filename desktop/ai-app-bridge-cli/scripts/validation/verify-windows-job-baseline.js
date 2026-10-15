#!/usr/bin/env node
'use strict';

// Maintenance-only negative control. Run serially before the candidate suite:
// temporarily use the two old JS boundaries, then restore the original bytes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const baseline = 'c5777d5df12539d42810b13b6a27d8e5cbe141a2';
const source = path.resolve(__dirname, '../..');
const repository = path.resolve(source, '../..');
const files = ['bin/script/node-runtime-adapter.js', 'bin/shared-kernel/portable-exec-file.js'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function main(directory) {
  assert.equal(process.platform, 'win32', 'This negative control requires real Windows Job Objects.');
  assert.ok(directory, 'Usage: node scripts/validation/verify-windows-job-baseline.js existing-evidence-directory');
  const output = path.resolve(directory);
  assert.ok(fs.statSync(output).isDirectory());
  const versions = files.map(file => ({ file, path: path.join(source, file), original: fs.readFileSync(path.join(source, file)),
    baseline: execFileSync('git', ['show', `${baseline}:desktop/ai-app-bridge-cli/${file}`], { cwd: repository }) }));
  const report = { ok: false, baseline, platform: process.platform, node: process.version, libuv: process.versions.uv,
    files: versions.map(version => ({ file: version.file, originalSha256: sha256(version.original), baselineSha256: sha256(version.baseline) })) };
  const logPath = path.join(output, 'job-baseline.log');
  try {
    for (const version of versions) fs.writeFileSync(version.path, version.baseline);
    const logFd = fs.openSync(logPath, 'wx');
    let result;
    try {
      result = spawnSync(process.execPath, ['--test', '--test-reporter=tap',
        '--test-name-pattern=^Windows Host death closes unfinished Script and command Jobs while independent processes survive$',
        'test/windows-process.integration.test.js'], { cwd: source, stdio: ['ignore', logFd, logFd], timeout: 60000, windowsHide: true });
    } finally { fs.closeSync(logFd); }
    report.test = { status: result.status, signal: result.signal, error: result.error?.message };
    const log = fs.readFileSync(logPath, 'utf8');
    const snapshots = [...log.matchAll(/^# (\{"phase":.+\})\r?$/gm)].map(match => JSON.parse(match[1]));
    report.snapshots = snapshots;
    assert.equal(result.error, undefined, 'The baseline must finish normally, not time out or fail to launch.');
    assert.equal(result.signal, null);
    assert.equal(result.status, 1, 'The known lifetime regression must fail the unchanged survival assertion.');
    assert.match(log, /^# fail 1\r?$/m);
    assert.equal(snapshots.length, 2, 'Both phases must finish, including unfinished-tree cleanup.');
    const [before, after] = snapshots;
    assert.equal(before.phase, 'before-host-death');
    assert.equal(after.phase, 'after-host-death');
    const roles = ['completed-command-daemon', 'completed-javascript-daemon', 'completed-python-daemon', 'independent-process'];
    assert.deepEqual(before.processes.map(process => process.role), roles);
    assert.deepEqual(after.processes.map(process => process.role), roles);
    assert.ok(before.processes.every(process => process.start && process.start === process.observedStart), 'Every saved process must be alive before Host death.');
    assert.equal(after.processes[0].observedStart, null, 'The completed command daemon must reproduce the reported unintended termination.');
    assert.equal(after.processes[3].observedStart, after.processes[3].start, 'The independent process must remain alive.');
    assert.ok(after.processes.slice(0, 3).every(process => process.observedStart === null || process.observedStart === process.start), 'PID replacement is not the known lifetime regression.');
    report.ok = true;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    for (const version of versions) fs.writeFileSync(version.path, version.original);
    report.restored = versions.map(version => ({ file: version.file, sha256: sha256(fs.readFileSync(version.path)),
      exactBytes: fs.readFileSync(version.path).equals(version.original) }));
    fs.writeFileSync(path.join(output, 'job-baseline.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    assert.ok(report.restored.every(file => file.exactBytes), 'Candidate source must be restored byte-for-byte before validation continues.');
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

if (require.main === module) main(process.argv[2]);
