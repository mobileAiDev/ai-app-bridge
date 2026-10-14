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
  const { adbServerSocket, parseAdbServer } = require('./android-adb-route');
  const defaultAdb = descriptor?.adb || executablePath(process.env.ADB || 'adb');
  const records = pending.map(item => ({ target: item.target || {}, packages: [item.target?.packageName || item.packageName], source: 'pending' }));
  if (descriptor) records.push({ target: descriptor, packages: [descriptor.packageName, descriptor.instrumentation?.split('/')[0]], source: 'automation' });
  if (!records.length) records.push({ target: {}, packages: [], source: 'request' });
  const groups = new Map();
  for (const record of records) {
    const original = record.target.originalSdkRoute;
    if (original && (original.serial !== serial || typeof original.server?.socket !== 'string' || typeof original.executable?.path !== 'string'))
      throw new CommandError('force_stop_route_invalid', 'The recorded SDK route is incomplete or identifies another serial. Inspect the ownership archive before resetting it.', { details: { serial } });
    const adb = original?.executable.path || record.target.adb || defaultAdb;
    if (typeof adb !== 'string' || !adb) throw new CommandError('force_stop_adb_unavailable', 'The recorded ADB executable is unavailable. Install or restore adb, then repeat force-stop.');
    const serverSocket = parseAdbServer(original?.server.socket ?? record.target.adbServerSocket ?? adbServerSocket()).socket;
    const source = original ? 'recorded_sdk_route' : record.target.adbServerSocket ? 'recorded_server'
      : record.source === 'request' ? 'current_request' : 'legacy_environment';
    const key = JSON.stringify([adb, serial, serverSocket]);
    if (!groups.has(key)) groups.set(key, { adb, serial, serverSocket, sources: new Set(), packages: new Set() });
    const group = groups.get(key); group.sources.add(source);
    for (const packageName of record.packages.filter(Boolean)) {
      if (!/^[a-zA-Z0-9_.]+$/.test(packageName)) throw new CommandError('invalid_force_stop_package', 'The recorded Android package is invalid.');
      group.packages.add(packageName);
    }
  }
  const { createUiaRuntimePort } = require('./uia-runtime-port');
  const { execFileBounded } = require('./execution-io');
  const routes = [];
  for (const group of groups.values()) {
    const { adb, serverSocket } = group;
    const facts = { adb, serial, serverSocket, sources: [...group.sources], stoppedPackages: [],
      ...(group.sources.has('legacy_environment') ? { warnings: [{ code: 'original_adb_namespace_unrecorded',
        message: 'This older record did not save an ADB server namespace. The reset used the current Host environment shown in serverSocket.' }] } : {}) };
    // Capture one namespace for both UIA maintenance and every package stop.
    // A concurrent reset or caller environment change cannot redirect this group.
    const env = { ...process.env, ADB_SERVER_SOCKET: serverSocket };
    const run = (file, args, options) => execFileBounded(file, args, { ...options, env });
    try {
      const uia = await createUiaRuntimePort({ adb, serial, timeoutMs, run }).forceStop();
      for (const packageName of group.packages) {
        await run(adb, ['-s', serial, 'shell', 'am', 'force-stop', packageName], { timeoutMs, mutation: false, encoding: 'utf8' });
        facts.stoppedPackages.push(packageName);
      }
      routes.push({ ...uia, ...facts });
    } catch (error) {
      routes.push({ ...facts, ok: false, error: typeof error.code === 'string' ? error.code : 'force_stop_route_failed',
        message: error.message, ...(error.details ? { details: error.details } : {}),
        ...(error.stderr ? { stderr: String(error.stderr).slice(0, 2048) } : {}) });
    }
  }
  const ok = routes.every(route => route.ok === true);
  return { ...(routes.length === 1 ? routes[0] : {}), ok, stopped: ok, routes,
    stoppedPackages: [...new Set(routes.flatMap(route => route.stoppedPackages))],
    ...(!ok ? { error: 'force_stop_device_incomplete' } : {}) };
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
    const covered = previous?.lastReset?.phone?.ok ? previous.lastReset.archivedOwnershipPaths || [] : [];
    const archives = store.archives(args.serial).filter(item => !covered.includes(item.archivePath));
    const pending = [...new Map([previous, ...archives.map(item => item.state)].filter(Boolean)
      .flatMap(state => [...(state.resetPending || []), state.pending, ...(state.reservations || [])]).filter(Boolean)
      .map(item => [item.id, item])).values()];
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
      require('./ownership-archives').recordForceStoppedArchive(store.directory, resetId, args.serial);
    }
    const state = { schemaVersion, serial: args.serial, phase: 'idle', owner: null, pending: null, reservations: [],
      pendingAcknowledgements: [], lastSettlement: previous?.lastSettlement ?? null, resetRequired: true, resetPending: pending,
      lastReset: { resetId, resetAtMs, disposition: 'force_stopped', outcome: 'unknown', abandoned, archivePath,
        archiveId: archivePath ? `force-stopped:${resetId}` : null, stoppedHostPids,
        archivedOwnershipPaths: [...covered, ...archives.map(item => item.archivePath)],
        unreadableArchives: archives.filter(item => item.error).map(({ archivePath, error }) => ({ archivePath, error })),
        ...(journalError ? { journalError } : {}) } };
    store.write(args.serial, state);
    const automationStore = require('../executors/automation-owner');
    let phone;
    try {
      const automation = automationStore.owner(args.serial, store.directory);
      phone = await remoteStop(args.serial, pending, args.timeoutMs ?? 10000, automation);
      if (phone?.ok !== true) throw new CommandError(phone?.error || 'force_stop_device_failed', 'The phone did not confirm every recorded route was reset.', { details: phone });
      if (automation) state.lastReset.automationArchivePath = automationStore.archive(args.serial, resetId, store.directory);
    } catch (error) {
      const code = typeof error.code === 'string' && /^[a-z][a-z0-9_]*$/.test(error.code) ? error.code : 'force_stop_device_failed';
      state.lastReset.phone = phone ?? { ok: false, error: code };
      store.write(args.serial, state);
      return { ok: false, error: code, phase: 'idle', serial: args.serial,
        ownershipReleased: true, remoteResetPending: true, ...state.lastReset,
        remoteError: { code, message: error.message, ...(error.details ? { details: error.details } : {}) },
        message: 'Local occupancy was reset; the remote reset is incomplete. Reconnect and repeat device-ownership force-stop to stop the recorded old work. New explicit actions can proceed with a warning.' };
    }
    state.resetRequired = false; delete state.resetPending; state.lastReset.phone = phone; store.write(args.serial, state);
    return { ok: true, serial: args.serial, phase: 'idle', ownershipReleased: true, remoteResetPending: false,
      ...state.lastReset, phone, message: 'Forced reset completed for the recorded targets. Original action outcomes remain unknown; unreadable archives cannot identify additional targets.' };
  } finally { lock?.close(); control.close(); }
}

module.exports = { forceStopDevice };
