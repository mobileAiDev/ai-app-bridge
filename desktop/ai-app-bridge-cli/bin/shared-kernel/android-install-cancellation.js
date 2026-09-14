'use strict';
const { createHash } = require('node:crypto');
const shell = require('./android-shell-execution');
const { execFileBounded } = require('./execution-io');
const { executionSleep } = require('./execution-scope');
const { checksumOf } = require('./evidence-schema');
const { CommandError } = require('../command-errors');
const root = '/data/local/tmp/ai-app-bridge-install/v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const original = identity => Object.fromEntries(['actionId', 'runtimeEpoch', 'jobId', 'installId', 'commandSha256']
  .map(key => [key, identity[key]]));
const argvFor = sessionId => ['pm', 'install-abandon', String(sessionId)];

function validMapping(mapping, identity) {
  return mapping?.schemaVersion === 'aab.android-install-cancellation/v1'
    && mapping.original && typeof mapping.original === 'object'
    && checksumOf(mapping.original) === checksumOf(original(identity))
    && Number.isSafeInteger(mapping.sessionId) && mapping.sessionId > 0
    && mapping.command?.schemaVersion === shell.schema && uuid.test(mapping.command?.jobId)
    && Number.isSafeInteger(mapping.command?.deadlineUptimeMs) && mapping.command.deadlineUptimeMs > 0
    && mapping.command?.runtimeEpoch === identity.runtimeEpoch
    && mapping.command?.actionId === `install-abandon:${identity.installId}`
    && mapping.command?.commandSha256 === createHash('sha256')
      .update(`exec ${argvFor(mapping.sessionId).map(quote).join(' ')}\n`).digest('hex');
}

function cancellationProof(result, identity) {
  const mapping = result?.mapping;
  if (!require('./android-install-execution').validIdentity(identity) || !validMapping(mapping, identity)
    || !shell.terminalReceipt(result.receipt, mapping.command) || !result.receipt.dispatched
    || result.receipt.exitCode !== 0 || result.output?.stdout?.trim() !== 'Success') return null;
  return { kind: 'android-install', ...original(identity), packageName: identity.packageName,
    apkSha256: identity.apkSha256, sessionId: mapping.sessionId, phase: 'session-abandoned',
    // Abandon prevents further work by this session. It neither uninstalls an
    // already applied APK nor supplies the missing original commit outcome.
    requestSucceeded: null, settled: true, dispatched: null, ambiguous: false,
    cancellation: structuredClone(result), responseSha256: checksumOf(result) };
}

function createInstallCancellationPort({ adb = process.env.ADB || 'adb', serial, timeoutMs = 5000,
  run = execFileBounded, shellPort = shell.createAndroidShellPort({ adb, serial, timeoutMs }) } = {}) {
  async function staging(identity, script) {
    if (!require('./android-install-execution').validIdentity(identity))
      throw new CommandError('invalid_install_execution_identity', 'Cancellation requires the original installation identity.');
    const guard = `if [ "$(cat /proc/sys/kernel/random/boot_id)" != ${quote(identity.runtimeEpoch)} ]; then printf '%s' '{"error":"shell_runtime_changed"}'; exit 0; fi\n`;
    const reply = await run(adb, ['-s', serial, 'shell', 'sh', '-c', quote(guard + `job=${quote(`${root}/${identity.installId}`)}\n` + script)],
      { timeoutMs, mutation: false, encoding: 'utf8', maxBuffer: 65536, windowsHide: true });
    let value;
    try { value = JSON.parse(reply.stdout); }
    catch { throw new CommandError('invalid_install_cancellation_response', 'The original installation cancellation record is unreadable.'); }
    if (value?.error) throw new CommandError(value.error, 'The original installation session could not be recovered.');
    return value;
  }
  async function saved(identity) {
    const value = await staging(identity, `if [ -f "$job/abandon.json" ]; then cat "$job/abandon.json"; else printf null; fi`);
    if (value && !validMapping(value, identity))
      throw new CommandError('invalid_install_cancellation_identity', 'The saved cancellation does not match this original installation and PM session.');
    return value;
  }
  async function receipt(mapping) {
    if (!mapping) return null;
    const value = await shellPort.query(mapping.command);
    return { mapping, receipt: value,
      output: shell.terminalReceipt(value, mapping.command) ? await shellPort.output(mapping.command) : null };
  }
  return {
    read: async identity => receipt(await saved(identity)),
    async cancel(identity) {
      let mapping = await saved(identity), previous;
      if (mapping) {
        const result = await receipt(mapping);
        if (shell.terminalReceipt(result.receipt, mapping.command)) {
          if (result.receipt.dispatched) return result;
          // A confirmed admission rejection did not call PM. A new explicit
          // request may replace it, retaining that proof with the new identity.
          previous = { command: mapping.command, receipt: result.receipt };
          mapping = null;
        }
      }
      if (!mapping) {
        const sessionId = await staging(identity, `session=$(cat "$job/session" 2>/dev/null)\n` +
          `case "$session" in ''|*[!0-9]*) printf '%s' '{"error":"install_session_unavailable"}';; *) printf '%s' "$session";; esac`);
        if (!Number.isSafeInteger(sessionId) || sessionId < 1)
          throw new CommandError('install_session_unavailable', 'The original worker has not retained a PM installation session yet.');
        mapping = { schemaVersion: 'aab.android-install-cancellation/v1', original: original(identity), sessionId,
          ...(previous ? { previous } : {}),
          command: await shellPort.prepare(argvFor(sessionId), `install-abandon:${identity.installId}`) };
        if (!validMapping(mapping, identity)) throw new CommandError('invalid_install_cancellation_identity', 'Cancellation preparation changed the original device boot.');
        // The physical ownership lock serializes writers. Persist the child job
        // before admission so a lost Host can query that same job, never a new PM request.
        await staging(identity, `printf '%s' ${quote(JSON.stringify(mapping))} >"$job/abandon.tmp" && mv "$job/abandon.tmp" "$job/abandon.json" || exit 1\nprintf true`);
      }
      let result = await receipt(mapping);
      if (shell.terminalReceipt(result.receipt, mapping.command)) return result;
      const submitted = await shellPort.start(mapping.command);
      if (!submitted.ok && submitted.error !== 'shell_action_id_reused')
        throw new CommandError(submitted.error || 'install_cancellation_submission_failed', 'The saved cancellation job could not be submitted.');
      const deadline = Date.now() + timeoutMs;
      do {
        result = await receipt(mapping);
        if (shell.terminalReceipt(result.receipt, mapping.command)) return result;
        await executionSleep(60);
      } while (Date.now() < deadline);
      return result;
    },
    async acknowledge(identity, result) {
      if (!cancellationProof(result, identity)) throw new CommandError('invalid_install_cancellation_receipt', 'Cleanup requires the saved session cancellation receipt.');
      // The durable abandonment proof replaces the missing OEM callback for
      // retirement. This exact PM session cannot consume the staged APK again.
      await staging(identity, `rm -rf "$job" ${quote(`/data/local/tmp/ai-app-bridge-shell/v1/${identity.jobId}`)} || exit 1\nprintf true`);
      return shellPort.acknowledge(result.mapping.command, result.receipt);
    },
  };
}

module.exports = { createInstallCancellationPort, cancellationProof };
