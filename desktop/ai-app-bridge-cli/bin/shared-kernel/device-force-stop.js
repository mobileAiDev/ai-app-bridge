'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { CommandError } = require('../command-errors');
const { createOwnershipStore, schemaVersion } = require('./device-ownership-store');
const { stopHosts } = require('./host-process-stop');

async function stopDevice(serial, pending, timeoutMs, automation) {
  const { readJson } = require('../executors/managed-runtime');
  const descriptor = automation ? readJson(automation.descriptorFile) : null;
  if (descriptor && (descriptor.serial !== serial || descriptor.sessionId !== automation.sessionId))
    throw new CommandError('executor_descriptor_mismatch', 'The recorded test session does not match this device.');
  const { executablePath } = require('./executable-path');
  const adb = pending.find(item => item.target?.adb)?.target.adb || descriptor?.adb || executablePath(process.env.ADB || 'adb');
  const { createUiaRuntimePort } = require('./uia-runtime-port');
  const uia = await createUiaRuntimePort({ adb, serial, timeoutMs }).forceStop();
  const packages = [...new Set([...pending.map(item => item.target?.packageName || item.packageName),
    descriptor?.packageName, descriptor?.instrumentation?.split('/')[0]].filter(Boolean))];
  const { execFileBounded } = require('./execution-io');
  for (const packageName of packages) {
    if (!/^[a-zA-Z0-9_.]+$/.test(packageName)) throw new CommandError('invalid_force_stop_package', 'The recorded Android package is invalid.');
    await execFileBounded(adb, ['-s', serial, 'shell', 'am', 'force-stop', packageName], { timeoutMs, mutation: false, encoding: 'utf8' });
  }
  return { ...uia, stoppedPackages: packages };
}

// This control runs in the CLI/MCP client, before contacting the shared runtime.
// A hung runtime, its queues, and version mismatch cannot intercept the reset.
async function forceStopDevice(args, { directory, stopHost = stopHosts, stopDevice: remoteStop = stopDevice,
  runtimeEndpoint } = {}) {
  const store = createOwnershipStore(directory);
  const control = store.controlLock(args.serial);
  if (!control) throw new CommandError('device_reset_in_progress', 'Another force-stop is resetting this device. Retry after it finishes.');
  let lock;
  let journalError = null;
  const readForReset = () => {
    try { return store.read(args.serial); }
    catch (error) {
      if (error.code !== 'device_ownership_corrupt') throw error;
      // Forced reset archives corrupt bytes instead of requiring the damaged
      // task record to prove completion. Normal admission remains strict.
      journalError = error.code; return null;
    }
  };
  try {
    let previous = readForReset();
    if (runtimeEndpoint === undefined) {
      const { runtimeLocation, readEndpoint } = require('../runtime-directory');
      runtimeEndpoint = readEndpoint(runtimeLocation());
    }
    const stoppedHostPids = await stopHost(previous?.owner, runtimeEndpoint);
    const deadline = Date.now() + (args.timeoutMs ?? 10000);
    while (!(lock = store.lock(args.serial))) {
      if (Date.now() >= deadline) throw new CommandError('force_stop_host_still_owned', 'The terminated Host has not released its OS lock.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const resetId = randomUUID(), resetAtMs = Date.now();
    previous = readForReset();
    const pending = previous?.resetPending || [previous?.pending, ...(previous?.reservations || [])].filter(Boolean);
    const abandoned = pending.map(item => ({ kind: item.kind, actionId: item.actionId ?? null, runtimeEpoch: item.runtimeEpoch ?? null }));
    const archiveDir = path.join(store.directory, 'force-stopped');
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    const archivePath = fs.existsSync(store.paths(args.serial).journal) ? path.join(archiveDir, `${resetId}.json`) : null;
    if (archivePath) {
      const file = fs.openSync(archivePath, 'wx', 0o600);
      try { fs.writeFileSync(file, fs.readFileSync(store.paths(args.serial).journal)); fs.fsyncSync(file); }
      finally { fs.closeSync(file); }
      const parent = fs.openSync(archiveDir, 'r');
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    }
    const state = { schemaVersion, serial: args.serial, phase: 'idle', owner: null, pending: null, reservations: [],
      pendingAcknowledgements: [], lastSettlement: previous?.lastSettlement ?? null, resetRequired: true, resetPending: pending,
      lastReset: { resetId, resetAtMs, disposition: 'force_stopped', outcome: 'unknown', abandoned, archivePath, stoppedHostPids,
        ...(journalError ? { journalError } : {}) } };
    store.write(args.serial, state);
    const automationStore = require('../executors/automation-owner');
    let phone;
    try {
      const automation = automationStore.owner(args.serial, store.directory);
      phone = await remoteStop(args.serial, pending, args.timeoutMs ?? 10000, automation);
      if (phone?.ok !== true) throw new CommandError(phone?.error || 'force_stop_device_failed', 'The phone did not confirm the forced reset.');
      if (automation) state.lastReset.automationArchivePath = automationStore.archive(args.serial, resetId, store.directory);
    } catch (error) {
      const code = typeof error.code === 'string' && /^[a-z][a-z0-9_]*$/.test(error.code) ? error.code : 'force_stop_device_failed';
      return { ok: false, error: code, phase: 'idle', serial: args.serial,
        ownershipReleased: true, remoteResetPending: true, ...state.lastReset,
        remoteError: { code, message: error.message },
        message: 'Local occupancy was reset. Reconnect the device and repeat device-ownership force-stop before new actions.' };
    }
    state.resetRequired = false; delete state.resetPending; state.lastReset.phone = phone; store.write(args.serial, state);
    return { ok: true, serial: args.serial, phase: 'idle', ownershipReleased: true, remoteResetPending: false,
      ...state.lastReset, phone, message: 'Forced reset completed. Old tasks were stopped; agents can start new operations.' };
  } finally { lock?.close(); control.close(); }
}

module.exports = { forceStopDevice };
