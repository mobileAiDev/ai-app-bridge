'use strict';

const { acquireRuntimeLock, readEndpoint, readRuntimeOwner, archiveRuntimeRecords } = require('./runtime-directory');
const { stopHosts, processInfo, isBridgeHostCommand } = require('./shared-kernel/host-process-stop');
const { CommandError } = require('./command-errors');

async function forceStopRuntime(location, { timeoutMs = 5000, ownerPid } = {}) {
  // Elect before reading records: a free namespace stays ours while metadata
  // is inspected, so a new Host cannot publish between inspection and archive.
  let lock = acquireRuntimeLock(location);
  let endpoint, endpointError, owner, ownerError;
  try { endpoint = readEndpoint(location); }
  catch (error) { endpointError = error.code; }
  try { owner = readRuntimeOwner(location); }
  catch (error) { ownerError = error.code; }
  let ownerSource = owner ? 'owner-record' : endpoint ? 'endpoint-record' : null;
  let stoppedHostPids = [];
  if (!lock) {
    if (ownerPid !== undefined) {
      const info = processInfo(ownerPid);
      if (!info || !isBridgeHostCommand(info.command, ['execution-runtime'])) throw new CommandError('runtime_owner_mismatch',
        'The supplied ownerPid is not a live Bridge execution-runtime process. Inspect doctor --platform host and choose the intended Host PID.',
        { details: { ownerPid, lockFile: location.lockFile } });
      owner = { pid: ownerPid, processStart: info.start }; endpoint = null; ownerSource = 'explicit-pid';
    }
    if (!owner && !endpoint) throw new CommandError('runtime_owner_unidentified',
      'The OS lock is held but both owner records are missing or invalid. Inspect the lock holder, then run runtime --operation force-stop --owner-pid <PID>.',
      { details: { endpointError, ownerError, ownerFile: location.ownerFile, lockFile: location.lockFile, logFile: location.logFile,
        inspectCommand: process.platform === 'win32' ? 'Get-CimInstance Win32_Process | Where-Object CommandLine -Match "execution-runtime.js" | Select-Object ProcessId,CommandLine'
          : `lsof -nP -- '${location.lockFile.replaceAll("'", "'\\''")}'` } });
    stoppedHostPids = await stopHosts(owner, endpoint);
    const deadline = Date.now() + timeoutMs;
    while (!(lock = acquireRuntimeLock(location)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (!lock) throw new CommandError('runtime_force_stop_incomplete',
      'The recorded owner did not release the OS lock. Inspect the lock holder, then runtime --operation force-stop --owner-pid <PID> selects the intended Bridge Host explicitly.',
      { details: { stoppedHostPids, lockFile: location.lockFile } });
  }
  try {
    const archives = archiveRuntimeRecords(location, 'force-stop');
    return { ok: true, command: 'runtime', status: 'stopped', forced: true, outcome: 'unknown',
      stoppedHostPids, archivePath: archives.endpoint || archives.owner || null, archives, facts: location.facts,
      recovery: { ownerSource, ...(endpointError ? { endpointError } : {}), ...(ownerError ? { ownerError } : {}) },
      message: 'Host runtime stopped. Evidence is retained; already dispatched device work remains unknown. Use device-ownership force-stop to stop recorded device work, or start a fresh runtime explicitly.' };
  } finally { lock.close(); }
}

module.exports = { forceStopRuntime };
