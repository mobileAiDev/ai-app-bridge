'use strict';
const { sha256FileScript } = require('./android-sha256');

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { CommandError } = require('../command-errors');
const { execFileBounded, httpRequestBounded } = require('./execution-io');
const { createOwnershipStore, defaultDirectory } = require('./device-ownership-store');
const { checkExecution, runExecution, executionSleep } = require('./execution-scope');
const protocol = require('./uia-protocol');

const mainClass = 'io.github.mobileaidev.aiappbridge.uia.UiaRuntime';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function createUiaRuntimePort({ adb, serial, timeoutMs = 10000, root = protocol.rootDirectory,
  bundleDirectory = path.resolve(__dirname, '../../runtime/uia'), run = execFileBounded, http = httpRequestBounded,
  connectionLocks = createOwnershipStore(path.join(defaultDirectory(), 'uia-connections')) } = {}) {
  if (typeof serial !== 'string' || !serial || typeof adb !== 'string' || !adb || !protocol.validRoot(root)) {
    throw new CommandError('invalid_uia_runtime_target', 'UIA runtime requires an explicit Android serial, ADB executable and valid root.', { dispatched: false, ambiguous: false });
  }
  const invoke = (args, budgetMs = timeoutMs) => run(adb, ['-s', serial, ...args], {
    timeoutMs: budgetMs, mutation: false, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, windowsHide: true,
  });
  const shell = script => invoke(['shell', 'sh', '-c', quote(script)]).then(result => result.stdout.trim());
  const failure = (code, message, details) => new CommandError(code, message, { details });

  async function readJson(file) {
    const raw = await shell(`if [ -f ${quote(file)} ]; then cat ${quote(file)}; else printf '%s' null; fi`);
    try { return JSON.parse(raw); }
    catch { throw failure('uia_runtime_record_invalid', 'The phone did not return a valid UIA JSON record.', { file }); }
  }

  function bundle() {
    let manifest, bytes;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(bundleDirectory, 'manifest.json'), 'utf8'));
      bytes = fs.readFileSync(path.join(bundleDirectory, 'ai-app-bridge-uia.jar'));
    } catch (error) { throw failure('uia_runtime_bundle_unavailable', 'The installed CLI has no complete UIA runtime bundle.', { cause: error.code }); }
    if (manifest?.schemaVersion !== 'aab.uia.bundle.v1' || manifest.mainClass !== mainClass || manifest.minApi !== 25
      || manifest.artifact !== 'ai-app-bridge-uia.jar' || bytes.length > 2 * 1024 * 1024 || protocol.digest(bytes) !== manifest.sha256) {
      throw failure('uia_runtime_bundle_invalid', 'The UIA runtime artifact does not match its bundle manifest.');
    }
    return { manifest, file: path.join(bundleDirectory, manifest.artifact) };
  }

  function descriptor(value) {
    if (!protocol.validDescriptor(value, root)) throw failure('uia_runtime_descriptor_invalid', 'The UIA runtime descriptor has invalid identity or transport fields.');
    return value;
  }

  async function withConnectionLock(action) {
    // Reuse the OS-managed lock implementation, with a separate connection
    // namespace. Discovery, rotation and forward allocation share this lock.
    const started = Date.now();
    let held;
    while (!(held = connectionLocks.lock(`${serial}:${root}`))) {
      checkExecution();
      if (Date.now() - started >= timeoutMs) throw failure('uia_connection_busy', 'Another Host is configuring this UIA connection.');
      await executionSleep(25);
    }
    try { return await action(); } finally { held.close(); }
  }

  async function forwards() {
    const result = await invoke(['forward', '--list']);
    return result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const fields = line.trim().split(/\s+/);
      if (fields.length !== 3) throw failure('uia_forward_list_invalid', 'ADB returned an invalid forward inventory.');
      return { serial: fields[0], local: fields[1], remote: fields[2] };
    });
  }

  async function connect(peer) {
    const target = `localabstract:${peer.socketName}`;
    const existing = (await forwards()).filter(item => item.serial === serial && item.remote === target);
    if (existing.length > 1) throw failure('uia_forward_ambiguous', 'Multiple ADB forwards target this UIA runtime. Inspect the forward inventory before proceeding.');
    let local;
    if (existing.length === 1) local = existing[0].local;
    else {
      const assigned = (await invoke(['forward', 'tcp:0', target])).stdout.trim();
      local = `tcp:${assigned}`;
      const matches = (await forwards()).filter(item => item.local === local);
      if (matches.length !== 1 || matches[0].serial !== serial || matches[0].remote !== target) {
        throw failure('uia_forward_identity_mismatch', 'The allocated ADB forward does not target this exact phone and runtime.');
      }
    }
    if (!/^tcp:[1-9][0-9]{0,4}$/.test(local) || Number(local.slice(4)) > 65535) throw failure('uia_forward_invalid', 'UIA requires an assigned TCP forward port.');
    return { peer, port: Number(local.slice(4)) };
  }

  async function post(connection, payload) {
    let raw;
    try {
      raw = await runExecution({ mutation: payload.op === 'start', timeoutMs }, () => http(`http://127.0.0.1:${connection.port}/v1`, {
        method: 'POST', payload, headers: { Authorization: `Bearer ${connection.peer.token}` }, timeoutMs, maxBytes: 1048576,
      }));
    } catch (error) {
      if (error.statusCode !== undefined) {
        let response;
        try { response = JSON.parse(error.responseBody); } catch { throw failure('uia_http_response_invalid', 'The UIA HTTP error did not contain valid JSON.'); }
        if (response?.ok === false && typeof response.error === 'string' && response.error) {
          throw failure(response.error, typeof response.message === 'string' ? response.message : 'The UIA runtime rejected this protocol request.');
        }
      }
      throw error;
    }
    try { return JSON.parse(raw); }
    catch { throw failure('uia_http_response_invalid', 'The UIA runtime did not return valid JSON.'); }
  }

  async function statusOf(connection) {
    let result;
    try { result = await post(connection, { op: 'status' }); }
    catch (error) {
      if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code))
        throw failure('uia_runtime_unreachable', 'The original UIA runtime is unreachable. Use uia-runtime --operation start with this serial for an explicit phone process-lock check; unresolved actions remain retained.',
          { bootId: connection.peer.bootId, runtimeEpoch: connection.peer.runtimeEpoch, transportError: error.code });
      throw error;
    }
    const peer = connection.peer;
    if (result?.ok !== true || result.schemaVersion !== protocol.schema || result.bootId !== peer.bootId
      || result.runtimeEpoch !== peer.runtimeEpoch || result.dexSha256 !== peer.dexSha256
      || !Number.isSafeInteger(result.capacity) || result.capacity < 1
      || !Number.isSafeInteger(result.count) || result.count < 0 || result.count > result.capacity
      || !Number.isSafeInteger(result.pending) || result.pending < 0 || result.pending > result.count
      || !Number.isSafeInteger(result.acknowledged) || result.acknowledged < 0 || result.acknowledged > result.count - result.pending
      || typeof result.closing !== 'boolean') {
      throw failure('uia_runtime_identity_mismatch', 'The connected runtime did not confirm the expected boot, epoch and artifact.');
    }
    return result;
  }

  async function installAsset(asset) {
    const level = await shell('getprop ro.build.version.sdk');
    if (!/^[0-9]+$/.test(level) || Number(level) < 25) throw failure('uia_android_api_25_required', 'UIA node execution requires Android API 25 or newer.', { apiLevel: level });
    const destination = `${root}/runtime-${asset.manifest.sha256}.jar`;
    await shell(`umask 077\nmkdir -p ${quote(root)} && chmod 700 ${quote(root)}`);
    const existingHash = await shell(`if [ -f ${quote(destination)} ]; then ${sha256FileScript(destination)}; else printf '%s' null; fi`);
    if (existingHash !== 'null') {
      if (existingHash.split(/\s+/)[0] !== asset.manifest.sha256)
        throw failure('uia_runtime_artifact_mismatch', 'An existing content-addressed UIA runtime artifact has different bytes.');
      return destination;
    }
    const temporary = `${root}/runtime-${asset.manifest.sha256}.${randomUUID()}.tmp`;
    await invoke(['push', asset.file, temporary]);
    const installedHash = (await shell(sha256FileScript(temporary))).split(/\s+/)[0];
    if (installedHash !== asset.manifest.sha256) throw failure('uia_runtime_artifact_mismatch', 'The phone runtime artifact hash differs from the installed CLI bundle.');
    // Never overwrite an executable that an existing runtime may still map.
    await shell(`mv -n ${quote(temporary)} ${quote(destination)}`);
    const publishedHash = (await shell(sha256FileScript(destination))).split(/\s+/)[0];
    if (publishedHash !== asset.manifest.sha256) throw failure('uia_runtime_artifact_mismatch', 'The published UIA runtime artifact has different bytes.');
    await shell(`rm -f ${quote(temporary)}`);
    return destination;
  }

  async function startRuntime(previous, asset, destination) {
    destination ??= await installAsset(asset);
    await shell(`CLASSPATH=${quote(destination)} setsid nohup app_process /system/bin ${mainClass} ${quote(root)} ${asset.manifest.sha256} >${quote(root + '/startup.log')} 2>&1 </dev/null &`);
    const deadline = Date.now() + Math.min(timeoutMs, 7000);
    while (Date.now() < deadline) {
      checkExecution();
      const current = await readJson(`${root}/runtime.json`);
      if (current !== null && current.runtimeEpoch !== previous?.runtimeEpoch) {
        const peer = descriptor(current);
        if (!peer.running || peer.dexSha256 !== asset.manifest.sha256) throw failure('uia_runtime_identity_mismatch', 'The newly discovered runtime does not match this bundle.');
        if (previous) await removeForwards(previous);
        return peer;
      }
      await executionSleep(100);
    }
    const log = await shell(`tail -c 4096 ${quote(root + '/startup.log')}`);
    let rejection;
    try { rejection = JSON.parse(log.trim().split(/\r?\n/).at(-1)); } catch { /* Non-JSON VM startup diagnostics remain below. */ }
    if (rejection?.ok === false && typeof rejection.error === 'string' && rejection.error.startsWith('uia_'))
      throw failure(rejection.error, 'The phone runtime refused to start. Original session records were retained.', { startupLog: log });
    throw failure('uia_runtime_start_failed', 'The phone did not publish a ready UIA runtime.', { startupLog: log });
  }

  async function removeForwards(peer) {
    for (const item of await forwards()) if (item.serial === serial && item.remote === `localabstract:${peer.socketName}`)
      await invoke(['forward', '--remove', item.local]);
  }

  function publicPeer(peer) {
    return { serial, bootId: peer.bootId, runtimeEpoch: peer.runtimeEpoch, dexSha256: peer.dexSha256, apiLevel: peer.apiLevel, running: peer.running };
  }

  async function stopRuntime(connection) {
    const { peer } = connection;
    const stopped = await post(connection, { op: 'stop' });
    if (stopped?.ok !== true || stopped.runtimeEpoch !== peer.runtimeEpoch || stopped.stopping !== true)
      throw failure('uia_runtime_stop_unconfirmed', 'The original UIA runtime did not accept orderly shutdown.');
    const deadline = Date.now() + Math.min(timeoutMs, 10000);
    while (Date.now() < deadline) {
      const current = descriptor(await readJson(`${root}/runtime.json`));
      if (current.runtimeEpoch !== peer.runtimeEpoch) throw failure('uia_runtime_identity_mismatch', 'A different UIA runtime appeared during shutdown.');
      if (!current.running) {
        await removeForwards(peer);
        return { ok: true, ...publicPeer(current) };
      }
      await executionSleep(50);
    }
    throw failure('uia_runtime_stop_unconfirmed', 'The original UIA runtime has not published its stopped state.');
  }

  async function ensureLocked(rotate) {
    const asset = bundle();
    const previous = await readJson(`${root}/runtime.json`);
    let peer = previous === null ? null : descriptor(previous);
    if (peer === null || peer.running === false) peer = await startRuntime(peer, asset);
    if (peer.dexSha256 !== asset.manifest.sha256) throw failure('uia_runtime_version_mismatch', 'Stop the existing UIA runtime before starting this installed bundle.');
    let connection = await connect(peer), status = await statusOf(connection);
    if (status.closing) throw failure('uia_runtime_closing', 'The original UIA runtime is closing. Observe again after it exits.');
    // Rotation belongs to NEW observation, before binding a node. A full epoch
    // cannot admit another new action; acknowledgements are monotonic.
    if (rotate && status.count === status.capacity && status.pending === 0 && status.acknowledged === status.count) {
      await stopRuntime(connection);
      peer = await startRuntime(peer, asset);
      connection = await connect(peer); status = await statusOf(connection);
    }
    return { ...connection, status };
  }

  const ensure = () => withConnectionLock(() => ensureLocked(false));

  async function originalConnection(identity) {
    if (!protocol.validIdentity(identity) || identity.target.serial !== serial || identity.target.root !== root || identity.target.adb !== adb) {
      throw failure('invalid_uia_execution_identity', 'Recovery requires this exact UIA action and physical device identity.');
    }
    return withConnectionLock(async () => {
      const value = await readJson(`${identity.target.sessionPath}/runtime.json`);
      if (value === null) return null;
      const peer = descriptor(value);
      if (peer.bootId !== identity.bootId || peer.runtimeEpoch !== identity.runtimeEpoch || peer.dexSha256 !== identity.target.dexSha256) {
        throw failure('uia_runtime_identity_mismatch', 'The original UIA session descriptor does not match the action.');
      }
      if (!peer.running) return null;
      const connection = await connect(peer);
      await statusOf(connection);
      return connection;
    });
  }

  function actionPayload(op, identity) { return { op, requestJson: identity.requestJson, requestSha256: identity.requestSha256 }; }

  async function maintainRecord(operation, identity) {
    // One-shot maintenance must acquire the same phone OS lock as the runtime.
    // It never starts UiAutomation or replays an action.
    const asset = bundle(), destination = await installAsset(asset);
    let raw;
    try {
      raw = await shell(`CLASSPATH=${quote(destination)} app_process /system/bin ${mainClass} ${quote(root)} ${asset.manifest.sha256} ${operation} ${quote(JSON.stringify(identity))}`);
    } catch (error) {
      let rejection;
      try { rejection = JSON.parse(String(error.stderr).trim().split(/\r?\n/).at(-1)); } catch { /* Retain the transport error. */ }
      if (rejection?.ok === false && typeof rejection.error === 'string' && rejection.error.startsWith('uia_'))
        throw failure(rejection.error, 'The phone retained the original action because journal maintenance could not complete safely.');
      throw error;
    }
    try { return JSON.parse(raw); }
    catch { throw failure('uia_maintenance_response_invalid', 'The phone did not return a valid journal maintenance response.'); }
  }

  async function recover(identity, { cancel = true } = {}) {
    if (!protocol.validIdentity(identity) || identity.target.serial !== serial || identity.target.root !== root || identity.target.adb !== adb)
      throw failure('invalid_uia_execution_identity', 'An exact original UIA identity is required.');
    let liveError;
    try {
      const connection = await originalConnection(identity);
      if (connection) {
        const response = await post(connection, actionPayload(cancel ? 'cancel' : 'query', identity));
        if (protocol.originalReceipt(response, identity)) return { ...response, completionSource: 'original-runtime' };
        liveError = response?.error || 'uia_action_not_settled';
      }
    } catch (error) { liveError = error.code || 'uia_runtime_unreachable'; }
    // The second completion authority is the SAME action's durable file, not a
    // restarted runtime, a new action, an installed app state or an idle flag.
    const saved = await readJson(`${identity.target.sessionPath}/actions/${protocol.digest(identity.actionId)}.json`);
    const response = protocol.recordResponse(saved, identity);
    if (response) return { ...response, completionSource: 'original-durable-record', liveQueryError: liveError ?? null };
    // Missing records and admitted/unknown phases are never non-dispatch proof.
    // The phone re-reads and fully validates this exact record under owner.lock.
    if (cancel && ['prepared', 'queued'].includes(saved?.phase)) {
      try {
        const record = await withConnectionLock(() => maintainRecord('recover-record', protocol.recoveryIdentity(identity)));
        const recovered = protocol.recordResponse(record, identity);
        if (recovered) return { ...recovered, completionSource: 'phone-journal-maintenance', liveQueryError: liveError ?? null };
        liveError = 'uia_recovery_receipt_invalid';
      } catch (error) { liveError = error.code || 'uia_recovery_failed'; }
    }
    return { ok: false, settled: false, dispatched: null, ambiguous: true, error: liveError || 'uia_original_completion_unavailable' };
  }

  return {
    ensure, post,
    async observe() {
      const connection = await withConnectionLock(() => ensureLocked(true));
      const result = await post(connection, { op: 'observe' });
      if (result?.ok !== true || result.schemaVersion !== protocol.snapshotSchema || result.bootId !== connection.peer.bootId
        || result.runtimeEpoch !== connection.peer.runtimeEpoch || typeof result.xml !== 'string') {
        throw failure('uia_snapshot_invalid', 'UIA did not return a snapshot from the verified runtime.');
      }
      return result;
    },
    action: (connection, op, identity) => post(connection, actionPayload(op, identity)),
    recover,
    async acknowledge(identity, response) {
      const proof = protocol.acknowledgementIdentity(identity, response);
      if (identity.target.serial !== serial || identity.target.root !== root || identity.target.adb !== adb)
        throw failure('invalid_uia_execution_identity', 'Acknowledgement requires the original physical device and runtime root.');
      return withConnectionLock(async () => {
        const value = await readJson(`${root}/runtime.json`), peer = value === null ? null : descriptor(value);
        let connection, result;
        if (peer?.running) {
          try { connection = await connect(peer); await statusOf(connection); }
          catch (error) {
            if (error.code !== 'uia_runtime_unreachable') throw error;
            connection = null;
          }
        }
        if (connection) {
          if (peer.runtimeEpoch === identity.runtimeEpoch) {
            if (peer.bootId !== identity.bootId || peer.dexSha256 !== identity.target.dexSha256)
              throw failure('uia_runtime_identity_mismatch', 'The active epoch does not match the original action.');
            result = await post(connection, { ...actionPayload('acknowledge', identity), receiptSha256: response.receiptSha256 });
            if (!protocol.originalReceipt(result, identity) || result.receiptSha256 !== response.receiptSha256 || result.acknowledged !== true)
              throw failure('uia_acknowledgement_invalid', 'The runtime did not confirm this exact terminal receipt.');
            return { ok: true, disposition: 'acknowledged' };
          }
          result = await post(connection, { op: 'acknowledge-record', identity: proof });
        } else {
          result = await maintainRecord('acknowledge-record', proof);
        }
        if (!protocol.acknowledgementMatches(result, proof))
          throw failure('uia_acknowledgement_invalid', 'Maintenance did not confirm this exact original receipt identity.');
        return { ok: true, disposition: result.disposition };
      });
    },
    async control(operation) {
      if (!['status', 'start', 'stop'].includes(operation)) throw failure('invalid_uia_runtime_operation', 'UIA runtime operation must be status, start or stop.');
      return withConnectionLock(async () => {
        const value = await readJson(`${root}/runtime.json`);
        if (operation === 'start') {
          const asset = bundle(), destination = await installAsset(asset);
          const ownerRaw = await shell(`CLASSPATH=${quote(destination)} app_process /system/bin ${mainClass} ${quote(root)} ${asset.manifest.sha256} owner-status`);
          let owner;
          try { owner = JSON.parse(ownerRaw); }
          catch { throw failure('uia_runtime_owner_unverified', 'The phone did not return valid JSON for its exclusive UIA process lock.'); }
          if (owner?.ok !== true || owner.schemaVersion !== 'aab.uia.owner.v1' || owner.root !== root
            || owner.dexSha256 !== asset.manifest.sha256 || typeof owner.owned !== 'boolean')
            throw failure('uia_runtime_owner_unverified', 'The phone did not return a valid UIA process-lock observation.');
          let peer = value === null ? null : descriptor(value);
          if (owner.owned) {
            if (peer === null || !peer.running) throw failure('uia_runtime_already_running', 'The original runtime still owns its process lock. Wait for it to finish starting or stopping.');
            if (peer.dexSha256 !== asset.manifest.sha256) throw failure('uia_runtime_version_mismatch', 'Stop the existing UIA runtime before starting this installed bundle.');
          } else {
            // Explicit start may reopen a dead owner. The new process reacquires
            // the OS lock and audits every original record BEFORE UiAutomation.
            peer = await startRuntime(peer, asset, destination);
          }
          const state = await statusOf(await connect(peer));
          if (state.closing) throw failure('uia_runtime_closing', 'The original runtime is still stopping.');
          return { ...state, ...publicPeer(peer) };
        }
        if (value === null) return { ok: true, serial, running: false };
        const peer = descriptor(value);
        if (!peer.running) return { ok: true, ...publicPeer(peer) };
        const connection = await connect(peer);
        const state = await statusOf(connection);
        if (operation === 'status') return { ...state, ...publicPeer(peer) };
        return stopRuntime(connection);
      });
    },
  };
}

module.exports = { createUiaRuntimePort };
