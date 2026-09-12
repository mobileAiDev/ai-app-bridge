'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { schema, installScript } = require('../bin/shared-kernel/android-install-execution');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

function identityFor(artifact, actionId, target = { adb: 'adb', serial: 'phone' }) {
  const identity = { kind: 'android-install', schemaVersion: 'aab.android-shell-execution/v1', actionId,
    jobId: randomUUID(), runtimeEpoch: randomUUID(), deadlineUptimeMs: 123456,
    installId: randomUUID(), apkSha256: artifact.sha256, apkBytes: artifact.bytes, packageName: artifact.packageName,
    allowDowngrade: false, target };
  identity.commandSha256 = createHash('sha256').update(`exec ${['sh', '-c', installScript(identity)].map(quote).join(' ')}\n`).digest('hex');
  return identity;
}
function resultFor(identity, { code = 0, stdout = 'Success\n', stderr = '', phase = 'commit-returned', sessionId = 42,
  cancelled = false, timedOut = false } = {}) {
  const shellReceipt = Object.fromEntries(['schemaVersion', 'actionId', 'jobId', 'runtimeEpoch', 'commandSha256', 'deadlineUptimeMs'].map(k => [k, identity[k]]));
  Object.assign(shellReceipt, { ok: true, settled: code !== null, dispatched: true, ambiguous: false, exitCode: code === null ? null : 0 });
  return { shellReceipt, installResult: code === null ? null : { schemaVersion: schema, installId: identity.installId,
    apkSha256: identity.apkSha256, packageName: identity.packageName, sessionId, phase, code, stdout: Buffer.from(stdout).toString('base64'), stderr: Buffer.from(stderr).toString('base64') },
    cancelled, timedOut, startedAtMs: 10, completedAtMs: 20 };
}
module.exports = { identityFor, resultFor };
