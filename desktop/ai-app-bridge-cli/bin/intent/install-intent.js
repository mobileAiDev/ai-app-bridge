'use strict';

const { normalizeExecutionTarget } = require('../shared-kernel/execution-target');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { CommandError } = require('../command-errors');
const { getProcessDeviceMutationLease } = require('../shared-kernel/device-mutation-lease');
const { checksumOf } = require('../shared-kernel/evidence-schema');
const { createProductionIntentDeviceAdapter } = require('./intent-production-adapter');
const { createIntentWorker } = require('./intent-worker');
const { prepareInstallJob, settlementProof } = require('../shared-kernel/android-install-execution');

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function androidBuildTool(name, explicit) {
  if (explicit) return explicit;
  const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME
    || path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk');
  const root = path.join(sdk, 'build-tools');
  const suffix = process.platform === 'win32' ? (name === 'apksigner' ? '.bat' : '.exe') : '';
  const versions = fs.existsSync(root) ? fs.readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) : [];
  const found = versions.map(version => path.join(root, version, name + suffix)).find(file => fs.existsSync(file));
  if (!found) throw new CommandError('apk_inspector_unavailable', `Android SDK ${name} is required. Supply ${name}Path or configure ANDROID_SDK_ROOT.`, { field: `${name}Path` });
  return found;
}

async function inspectApk(args, run = execute) {
  const file = path.resolve(args.apkPath);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new CommandError('invalid_apk', 'apkPath must be an existing APK file.', { field: 'apkPath' });
  let badging; let signatures;
  try {
    [badging, signatures] = await Promise.all([
      run(androidBuildTool('aapt', args.aaptPath), ['dump', 'badging', file], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }),
      run(androidBuildTool('apksigner', args.apksignerPath), ['verify', '--print-certs', file], { timeout: 30000, maxBuffer: 1024 * 1024 }),
    ]);
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError('invalid_apk', 'APK manifest or signature verification failed.', { field: 'apkPath', details: { cause: error.code || null } });
  }
  const pkg = /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']*)'/m.exec(badging.stdout);
  const certificates = [...new Set([...signatures.stdout.matchAll(/^(?:Signer #\d+|V(?:[124]|3(?:\.[01])?) Signer:) certificate SHA-256 digest: ([a-fA-F0-9]{64})\r?$/gm)].map(match => match[1].toLowerCase()))];
  if (!pkg || !certificates.length) throw new CommandError('invalid_apk', 'The APK has no verified package identity.', { field: 'apkPath' });
  if (args.packageName !== undefined && args.packageName !== pkg[1]) throw new CommandError('apk_package_mismatch', 'packageName differs from the APK manifest.', { field: 'packageName', details: { requested: args.packageName, apk: pkg[1] } });
  return { path: file, sha256: await sha256(file), packageName: pkg[1], versionCode: pkg[2], versionName: pkg[3], certificates, bytes: fs.statSync(file).size };
}

async function prepareApk(args) {
  const sourcePath = path.resolve(args.apkPath);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) throw new CommandError('invalid_apk', 'apkPath must be an existing APK file.', { field: 'apkPath' });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-install-'));
  const release = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    const stagedPath = path.join(directory, 'verified.apk');
    await fs.promises.copyFile(sourcePath, stagedPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(stagedPath, 0o400);
    const artifact = await inspectApk({ ...args, apkPath: stagedPath });
    return { artifact: { ...artifact, sourcePath }, release };
  } catch (error) { release(); throw error; }
}


async function installedIdentity(args, artifact, run = execute) {
  const adb = args.adb || process.env.ADB || 'adb';
  const command = values => run(adb, ['-s', args.serial, ...values], { timeout: args.adbTimeoutMs || 15000, maxBuffer: 1024 * 1024 });
  let output;
  try { output = await command(['shell', 'pm', 'path', artifact.packageName]); }
  catch (error) {
    // Empty exit-1 is the package manager's absent-package response. Connectivity errors remain unknown.
    if (error.code === 1 && !String(error.stdout || '').trim() && !String(error.stderr || '').trim()) return { known: true, installed: false, identityMatches: false };
    return { known: false, installed: null, identityMatches: false, error: error.code || 'package_query_failed' };
  }
  const paths = output.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (!paths.length) return { known: true, installed: false, identityMatches: false };
  if (paths.length !== 1 || !paths[0].startsWith('package:/data/app/') || !paths[0].endsWith('/base.apk')) {
    return { known: true, installed: true, identityMatches: false, error: 'installed_apk_layout_unsupported' };
  }
  const devicePath = paths[0].slice('package:'.length);
  try {
    const digest = (await command(['shell', 'sha256sum', devicePath])).stdout.trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/.test(digest)) return { known: false, installed: true, identityMatches: false, error: 'installed_hash_unavailable' };
    return { known: true, installed: true, path: devicePath, sha256: digest, identityMatches: digest === artifact.sha256,
      identitySource: 'exact installed APK bytes compared with the locally verified manifest and signer' };
  } catch (error) { return { known: false, installed: true, identityMatches: false, error: error.code || 'installed_hash_unavailable' }; }
}

// This adapter only discovers the current system window. The Agent chooses an
// exact selector through the ordinary Intent decision contract. No UI label or
// coordinate is stored here, and a failed action never switches provider.
function installerDeviceAdapter(args, ports, deviceAdapter) {
  const bridge = ports || require('../device-provider');
  const base = deviceAdapter || createProductionIntentDeviceAdapter({ ports: bridge, adb: args.adb });
  return {
    async observe(request) {
      const ctx = bridge.createBridgeContext({ ...args, packageName: request.packageName });
      const foreground = await bridge.foregroundWindow(ctx);
      if (!foreground.ok || !foreground.packageName) return { ok: false, error: 'foreground_probe_failed' };
      return base.observe({ ...request, packageName: foreground.packageName, provider: 'uia', foregroundPackages: [] });
    },
    async action(request) {
      if (!request.route || request.spec?.action !== 'tap' || !request.spec?.selector) {
        return { ok: false, error: 'installer_requires_observed_exact_selector', dispatched: false, ambiguous: false };
      }
      const ctx = bridge.createBridgeContext({ ...args, packageName: request.route.packageName });
      const foreground = await bridge.foregroundWindow(ctx);
      if (!foreground.ok || foreground.component !== request.route.component) {
        return { ok: false, error: 'reobserve_required', dispatched: false, ambiguous: false };
      }
      return base.action({ ...request, primaryProvider: 'uia', foregroundPackages: [request.route.packageName],
        spec: { ...request.spec, provider: 'uia', exact: true, requireClickable: true } });
    },
  };
}

async function createInstallIntent({ args, operationId, store, recording, dependencies = {} }) {
  const prepared = await (dependencies.prepareApk || prepareApk)(args);
  const { artifact } = prepared;
  const target = normalizeExecutionTarget({ platform: 'android', serial: args.serial, packageName: artifact.packageName, foregroundPackages: [],
    ...(args.adb === undefined ? {} : { adb: args.adb }) }, { intent: true });
  let ownership;
  try { ownership = (dependencies.lease || getProcessDeviceMutationLease()).acquire(args.serial); }
  catch (error) { prepared.release(); throw error; }
  if (!ownership.ok) { prepared.release(); throw new CommandError(ownership.error, 'The device is owned by another operation.', { details: { serial: args.serial } }); }
  const release = () => { try { ownership.release(); } finally { prepared.release(); } };
  let worker; let installOwnership;
  try {
    const adapter = dependencies.adapter || installerDeviceAdapter(args);
    worker = createIntentWorker({ operationId, target, ownsOutcome: false, timeoutMs: null, provider: 'uia', store, adapter, recording,
      goal: `Install the verified APK ${artifact.packageName} ${artifact.versionName}. Inspect actual system pages and choose exact selectors. Completion requires the independent installed APK identity check.` });
  } catch (error) { release(); throw error; }
  let job; let finished; let starting; let finalizing = false; let final = false; let activeUi = null; let cancelled = false;
  let uiFailure = null;
  let installation = { kind: 'install-apk', artifact, before: null, after: null, phase: 'preparing', requestSucceeded: false, verified: false };
  const snapshot = args => {
    const status = worker.status(args);
    if (['waiting_for_observation', 'finishing', 'paused'].includes(status.status) && !status.error) status.ok = true;
    return { ...status, installation: { ...installation, ...(job && !finalizing && !final ? { process: job.status() } : {}) } };
  };
  async function persist(kind, record) {
    const receipt = await store.persist(kind, { operationId, revision: worker.runtime.state.revision, target, timestampMs: Date.now(), ...record });
    if (!receipt.ok) throw new CommandError(receipt.error || 'installation_evidence_failed', 'Installation evidence could not be committed.');
    return receipt;
  }
  async function finalize(result) {
    finalizing = true;
    await worker.quiesce();
    worker.runtime.state.status = 'finishing';
    await activeUi?.catch(() => {});
    try {
      const proof = job ? settlementProof({ shellReceipt: result.shellReceipt, installResult: result.installResult }, job.identity) : null;
      result.executionReceipt = proof;
      if (proof) installOwnership?.settle(proof);
      if (proof) {
        try { await job.acknowledge(result); }
        catch (error) { result.cleanupError = error.code || 'install_cleanup_failed'; }
      }
      installation.phase = 'verifying';
      installation.process = result;
      const receipt = await persist('action-receipt', { actionId: `${operationId}:install`, startedAtMs: result.startedAtMs,
        completedAtMs: result.completedAtMs, mechanicalStatus: proof?.requestSucceeded ? 'ok' : 'failed',
        ambiguous: job ? !proof : false, dispatched: proof?.dispatched ?? (job ? null : false),
        settled: job ? Boolean(proof) : true, executionReceipt: proof,
        action: { action: 'install-apk', sha256: artifact.sha256 }, providerResult: result });
      installation.receiptId = receipt.evidenceId;
      installation.after = await (dependencies.installedIdentity || installedIdentity)(args, artifact);
      installation.requestSucceeded = proof?.requestSucceeded === true;
      installation.verified = installation.requestSucceeded && installation.after.identityMatches === true;
      const status = cancelled ? 'cancelled' : uiFailure ? uiFailure.status : result.timedOut ? 'timeout'
        : installation.verified ? 'completed' : job && !proof || installation.after.known === false ? 'ambiguous' : 'failed';
      const error = status === 'completed' ? null : status === 'cancelled' ? 'installation_cancelled'
        : uiFailure ? uiFailure.error : status === 'timeout' ? 'installation_timeout' : job && !proof ? 'install_completion_unavailable'
          : !installation.requestSucceeded ? 'package_install_failed' : 'installed_apk_identity_mismatch';
      installation.phase = status;
      const checked = await persist('checkpoint', { stepId: 'installed-identity', payloadSummary: { status, error, installation } });
      installation.verificationEvidenceId = checked.evidenceId;
      worker.runtime.state.status = status; worker.runtime.state.error = error;
      worker.runtime.emit('installation_verified', { verified: installation.verified, status, evidenceId: checked.evidenceId });
    } catch (error) {
      installation.phase = 'blocked_evidence_store';
      worker.runtime.state.status = 'blocked_evidence_store'; worker.runtime.state.error = error.code || 'installation_evidence_failed';
    } finally { final = true; release(); }
  }
  async function submit() {
    try {
      installation.before = await (dependencies.installedIdentity || installedIdentity)(args, artifact);
      if (cancelled || uiFailure) return snapshot();
      await persist('plan', { planStepId: 'submit-install', actionSpecHash: checksumOf(artifact), action: { action: 'install-apk', artifact }, payloadSummary: { artifact, before: installation.before } });
      if (cancelled || uiFailure) return snapshot();
      job = await (dependencies.prepareJob || prepareInstallJob)(args, artifact, `${operationId}:install`);
      await persist('dispatch-marker', { planStepId: 'submit-install', actionId: `${operationId}:install`, actionSpecHash: checksumOf(artifact),
        action: { action: 'install-apk', sha256: artifact.sha256 }, executionIdentity: job.identity, state: 'prepared' });
      installOwnership = ownership.retain(job.identity);
      installation.phase = 'installing'; worker.runtime.state.status = 'waiting_for_observation';
      worker.runtime.emit('installation_submitted', { sha256: artifact.sha256 });
      finished = job.done.then(finalize);
      if (cancelled || uiFailure) job.cancel(); else job.start();
      return snapshot();
    } catch (error) {
      if (job && !finished) {
        // Failed evidence/ownership admission cannot launch installation. Obtain
        // the original not-admitted receipt before cleaning its private APK.
        const stopped = await job.cancel();
        if (settlementProof({ shellReceipt: stopped.shellReceipt, installResult: stopped.installResult }, job.identity)) {
          try { await job.acknowledge(stopped); } catch (cleanup) { error.cleanupError = cleanup.code || 'install_cleanup_failed'; }
        }
      }
      final = true; release(); throw error;
    }
  }
  function start() {
    if (starting || final || cancelled || uiFailure) return Promise.resolve({ ...snapshot(), ok: false, error: 'operation_stopped' });
    starting = submit();
    return starting;
  }
  async function stop(status, error) {
    if (final) return snapshot();
    if (status === 'cancelled') cancelled = true;
    else uiFailure = { status, error };
    const uiStopped = status === 'cancelled' ? worker.cancel() : worker.intervene(error);
    job?.cancel();
    await uiStopped;
    await starting?.catch(() => {});
    if (final) return snapshot();
    if (!job && !finished) finished = finalize({ code: null, cancelled: true, timedOut: false, dispatched: false,
      stdout: '', stderr: '', startedAtMs: Date.now(), completedAtMs: Date.now() });
    await finished;
    return snapshot();
  }
  async function ui(action) {
    if (final || finalizing) return snapshot();
    if (activeUi) return { ...snapshot(), ok: false, error: 'operation_busy' };
    activeUi = ownership.run(action);
    let result;
    try { result = await activeUi; } finally { activeUi = null; }
    if (['failed', 'ambiguous', 'blocked_evidence_store'].includes(worker.runtime.state.status)) {
      uiFailure = { status: worker.runtime.state.status, error: worker.runtime.state.error };
      installation.uiFailure = uiFailure;
      job.cancel();
    }
    if (finalizing || uiFailure) { await finished; return snapshot(); }
    return { ...snapshot(), ok: result.ok, error: result.error };
  }
  return {
    ...worker, isManagedWorkflow: true, isFinished: () => final, start, status: snapshot,
    observe: args => ui(() => worker.observe(args)),
    decide: decision => {
      if (decision?.agentDecision !== 'act') return Promise.resolve({ ...snapshot(), ok: false,
        error: 'installation_requires_package_verification', message: 'Installation completion is determined by the APK verifier. Use intent cancel to stop.' });
      return ui(() => worker.decide(decision));
    },
    cancel: () => stop('cancelled'),
    pause() { worker.pause(); return snapshot(); },
    resume() { worker.resume(); return snapshot(); },
    intervene: reason => stop('intervention_required', reason),
  };
}

module.exports = { inspectApk, prepareApk, installedIdentity, installerDeviceAdapter, createInstallIntent };
