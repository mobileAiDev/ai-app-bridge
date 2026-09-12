'use strict';

const { randomUUID, createHash } = require('node:crypto');
const shell = require('./android-shell-execution');
const { execFileBounded } = require('./execution-io');
const { runExecution, withoutExecution, checkExecution, executionSleep } = require('./execution-scope');
const { CommandError } = require('../command-errors');
const { checksumOf } = require('./evidence-schema');

const schema = 'aab.android-install-execution/v1';
const root = '/data/local/tmp/ai-app-bridge-install/v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// This is the PackageManager CLI protocol, never an installer UI recognizer.
// A shell process exit alone cannot settle a Binder install. Only the original
// commit response, or proof that this worker never invoked commit, can do so.
function installScript(identity) {
  const directory = `${root}/${identity.installId}`;
  return `job=${quote(directory)}\nsession=null\n` +
    `emit() {\n` +
    `  printf '%s' ${quote(JSON.stringify({ schemaVersion: schema, installId: identity.installId,
      apkSha256: identity.apkSha256, packageName: identity.packageName }).slice(0, -1))}\n` +
    `  printf ',"sessionId":%s,"phase":"%s","code":%s,"stdout":"' "$session" "$1" "$2"\n` +
    `  base64 "$job/result.out" | tr -d '\\n'\n` +
    `  printf '","stderr":"'; base64 "$job/result.err" | tr -d '\\n'; printf '"}'\n}\n` +
    `: >"$job/result.out"; : >"$job/result.err"\n` +
    `actual=$(sha256sum "$job/base.apk"); actual=\${actual%% *}\n` +
    `if [ "$actual" != ${quote(identity.apkSha256)} ]; then emit artifact-mismatch 1; exit 0; fi\n` +
    `pm install-create -r ${identity.allowDowngrade ? '-d ' : ''}-S ${identity.apkBytes} >"$job/result.out" 2>"$job/result.err"\ncode=$?\n` +
    `if [ "$code" -ne 0 ]; then emit create-failed "$code"; exit 0; fi\n` +
    `created=$(cat "$job/result.out")\nsession=$(printf '%s' "$created" | sed -n 's/^Success: created install session \\[\\([0-9][0-9]*\\)\\]$/\\1/p')\n` +
    `case "$session" in ''|*[!0-9]*) session=null; emit create-invalid 1; exit 0;; esac\n` +
    `printf '%s' "$session" >"$job/session.tmp" && mv "$job/session.tmp" "$job/session" || exit 1\n` +
    `pm install-write -S ${identity.apkBytes} "$session" base.apk "$job/base.apk" >"$job/result.out" 2>"$job/result.err"\ncode=$?\n` +
    `if [ "$code" -ne 0 ]; then emit write-failed "$code"; exit 0; fi\n` +
    `pm install-commit "$session" >"$job/result.out" 2>"$job/result.err"\ncode=$?\n` +
    `emit commit-returned "$code"\n`;
}

function validIdentity(identity) {
  return identity?.kind === 'android-install' && uuid.test(identity.installId)
    && identity.schemaVersion === shell.schema && uuid.test(identity.jobId) && uuid.test(identity.runtimeEpoch)
    && typeof identity.actionId === 'string' && identity.actionId.length > 0 && identity.actionId.length <= 1024
    && Number.isSafeInteger(identity.deadlineUptimeMs) && identity.deadlineUptimeMs > 0
    && /^[a-f0-9]{64}$/.test(identity.apkSha256) && Number.isSafeInteger(identity.apkBytes) && identity.apkBytes > 0
    && typeof identity.allowDowngrade === 'boolean' && typeof identity.packageName === 'string'
    && identity.commandSha256 === hash(`exec ${['sh', '-c', installScript(identity)].map(quote).join(' ')}\n`);
}

function settlementProof(result, identity) {
  if (!validIdentity(identity) || !shell.terminalReceipt(result?.shellReceipt, identity)) return null;
  const receipt = result.shellReceipt;
  let phase = 'not-admitted', sessionId = null, requestSucceeded = false;
  if (receipt.dispatched) {
    const commit = result.installResult;
    if (receipt.exitCode !== 0 || commit?.schemaVersion !== schema || commit.installId !== identity.installId
      || commit.apkSha256 !== identity.apkSha256 || commit.packageName !== identity.packageName || !Number.isInteger(commit.code) || commit.code < 0 || commit.code > 255
      || typeof commit.stdout !== 'string' || typeof commit.stderr !== 'string'
      || Buffer.from(commit.stdout, 'base64').toString('base64') !== commit.stdout
      || Buffer.from(commit.stderr, 'base64').toString('base64') !== commit.stderr) return null;
    phase = commit.phase; sessionId = commit.sessionId;
    if (phase === 'commit-returned') {
      if (!Number.isSafeInteger(sessionId) || sessionId < 1) return null;
      const output = Buffer.from(commit.stdout, 'base64').toString('utf8').trim();
      requestSucceeded = commit.code === 0 && output === 'Success';
      // Pending-user-action (including Failure [null]), warnings and unknown ROM
      // output stay unresolved. These names are final legacy PM failure codes.
      const failed = commit.code === 1 && /^Failure \[(?:INSTALL_FAILED_|INSTALL_PARSE_FAILED_)[A-Z_]+(?:: [\s\S]*)?\]$/.test(output);
      if (!requestSucceeded && !failed) return null;
    } else if (!['artifact-mismatch', 'create-failed', 'create-invalid', 'write-failed'].includes(phase)
      || commit.code === 0 || (phase === 'write-failed' ? !Number.isSafeInteger(sessionId) || sessionId < 1 : sessionId !== null)) return null;
  }
  return { kind: 'android-install', actionId: identity.actionId, runtimeEpoch: identity.runtimeEpoch,
    jobId: identity.jobId, installId: identity.installId, commandSha256: identity.commandSha256,
    deadlineUptimeMs: identity.deadlineUptimeMs, packageName: identity.packageName, apkSha256: identity.apkSha256,
    sessionId, phase, requestSucceeded, settled: true, dispatched: phase === 'commit-returned', ambiguous: false,
    execution: structuredClone({ shellReceipt: receipt, installResult: result.installResult }),
    shellReceiptSha256: checksumOf(receipt),
    responseSha256: checksumOf({ shellReceipt: receipt, installResult: result.installResult }) };
}

function createAndroidInstallPort({ adb = process.env.ADB || 'adb', serial, timeoutMs = 180000,
  run = execFileBounded, shellPort = shell.createAndroidShellPort({ adb, serial, timeoutMs }) } = {}) {
  const command = args => run(adb, ['-s', serial, ...args], { timeoutMs: Math.min(timeoutMs, 30000), mutation: false,
    encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true });
  const staging = script => command(['shell', 'sh', '-c', quote(script)]);
  return {
    async prepare(artifact, actionId, allowDowngrade = false) {
      const installId = randomUUID(), directory = `${root}/${installId}`;
      const identity = { kind: 'android-install', installId, packageName: artifact.packageName,
        apkSha256: artifact.sha256, apkBytes: artifact.bytes, allowDowngrade };
      const staged = await staging(`umask 077\nmkdir -p ${quote(root)} || exit 1\nexec 0>${quote(root + '/prepare.lock')} || exit 1\nflock -x 0 || exit 1\n` +
        `count=0; for p in ${quote(root)}/*; do [ ! -d "$p" ] || count=$((count + 1)); done\n` +
        `if [ "$count" -ge 64 ]; then printf '%s' '{"ok":false,"error":"install_execution_store_full"}'; exit 0; fi\n` +
        `mkdir ${quote(directory)} || exit 1\nprintf '%s' '{"ok":true}'`);
      let allocation;
      try { allocation = JSON.parse(staged.stdout); }
      catch (_) { throw new CommandError('invalid_install_staging_response', 'The phone did not confirm a private installation staging directory.'); }
      if (allocation.ok !== true) throw new CommandError(allocation.error || 'install_staging_failed', 'The phone cannot retain another installation. Resolve existing retained jobs before retrying.');
      try {
        await command(['push', artifact.path, `${directory}/base.apk`]);
        return { ...identity, ...await shellPort.prepare(['sh', '-c', installScript(identity)], actionId), target: { adb, serial } };
      } catch (error) {
        // No worker has been launched. The private APK is safe to remove; a
        // prepared but undispatched shell job expires at its admission deadline.
        try { await withoutExecution(() => staging(`rm -rf ${quote(directory)}`)); }
        catch (cleanup) { error.cleanupError = cleanup.code || 'install_staging_cleanup_failed'; }
        throw error;
      }
    },
    start: identity => shellPort.start(identity),
    async read(identity, cancel = false) {
      if (!validIdentity(identity)) throw new CommandError('invalid_install_execution_identity', 'The original installation identity is invalid.');
      const shellReceipt = await (cancel ? shellPort.cancel(identity) : shellPort.query(identity));
      const result = { shellReceipt, installResult: null };
      if (shell.terminalReceipt(shellReceipt, identity) && shellReceipt.dispatched && shellReceipt.exitCode === 0) {
        const output = await shellPort.output(identity);
        try { result.installResult = JSON.parse(output.stdout); }
        catch (_) { throw new CommandError('invalid_install_execution_response', 'The original installer response is missing or incomplete.'); }
      }
      return result;
    },
    async acknowledge(identity, result) {
      const proof = settlementProof(result, identity);
      if (!proof) throw new CommandError('invalid_install_execution_receipt', 'Installation cleanup requires the original completion receipt.');
      if (proof.phase === 'write-failed') {
        const abandoned = await command(['shell', 'pm', 'install-abandon', String(proof.sessionId)]);
        if (abandoned.stdout.trim() !== 'Success') throw new CommandError('install_session_cleanup_failed', 'The uncommitted install session could not be abandoned.');
      }
      await staging(`rm -rf ${quote(`${root}/${identity.installId}`)}`);
      const ack = await shellPort.acknowledge(identity, result.shellReceipt);
      if (ack.ok !== true || ack.acknowledged !== true) throw new CommandError(ack.error || 'install_receipt_acknowledgement_failed', 'The installation shell receipt could not be acknowledged.');
      return { ok: true, acknowledged: true };
    },
  };
}

async function prepareInstallJob(args, artifact, actionId, port = createAndroidInstallPort(args)) {
  const timeoutMs = args.timeoutMs ?? 180000, startedAtMs = Date.now(), controller = new AbortController();
  const identity = await runExecution({ timeoutMs }, () => port.prepare(artifact, actionId, args.allowDowngrade === true));
  let started = false, cancelled = false, resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  async function execute() {
    let value, failure;
    try {
      value = await withoutExecution(() => runExecution({ deadlineMs: startedAtMs + timeoutMs, signal: controller.signal }, async () => {
        checkExecution();
        const submitted = await port.start(identity);
        if (submitted.ok !== true || submitted.submitted !== true) throw new CommandError(submitted.error || 'install_submission_failed', 'The original install worker was not admitted.');
        for (;;) {
          checkExecution(); const reply = await port.read(identity);
          if (reply.shellReceipt?.settled === true) return reply;
          if (reply.shellReceipt?.ok !== true) throw new CommandError(reply.shellReceipt?.error || 'install_query_failed', 'The original installation could not be queried.');
          await executionSleep(100);
        }
      }));
    } catch (error) {
      failure = error.code || 'install_response_lost';
      try { value = await withoutExecution(() => port.read(identity, true)); }
      catch (recovery) { failure = recovery.code || 'install_completion_unavailable'; }
    }
    const proof = settlementProof(value, identity);
    resolveDone({ identity, ...value, executionReceipt: proof, settled: Boolean(proof), dispatched: proof?.dispatched ?? null,
      ambiguous: !proof, requestSucceeded: proof?.requestSucceeded === true, cancelled,
      timedOut: Date.now() >= startedAtMs + timeoutMs, error: proof ? (failure ?? null) : (failure || 'install_completion_unavailable'),
      startedAtMs, completedAtMs: Date.now() });
  }
  const start = () => { if (!started) { started = true; void execute(); } return done; };
  return { identity, done, start, cancel() { cancelled = true; controller.abort({ code: 'installation_cancelled' }); return start(); },
    status: () => ({ identity, startedAtMs, cancelled }),
    acknowledge: result => port.acknowledge(identity, { shellReceipt: result.shellReceipt, installResult: result.installResult }) };
}

module.exports = { schema, installScript, validIdentity, settlementProof, createAndroidInstallPort, prepareInstallJob };
