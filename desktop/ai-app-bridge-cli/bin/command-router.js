'use strict';

const { isolatedCommandDefinitions } = require('./command-registry');
const { commandFailure } = require('./command-errors');

function createCommandRouter({ loadScript, loadIntent, loadEvidence, dispatchCommon } = {}) {
  if (typeof dispatchCommon !== 'function') {
    throw new TypeError('dispatchCommon is required');
  }
  const loads = { script: 0, intent: 0, evidence: 0 };
  return {
    isolatedCommandDefinitions,
    loads,
    async route(command, args = {}, dependencies) {
      if (command === 'script') {
        return invokeIsolated('script', loadScript, args, loads);
      }
      if (command === 'intent') {
        return invokeIsolated('intent', loadIntent, args, loads);
      }
      if (command === 'install-apk') {
        return invokeIsolated('intent', loadIntent, { install: args, recordingDir: args.recordingDir }, loads);
      }
      if (command === 'permission-dialog') {
        return invokeIsolated('intent', loadIntent, { permissionDialog: args, recordingDir: args.recordingDir }, loads);
      }
      if (command === 'evidence') {
        return invokeIsolated('evidence', loadEvidence, args, loads);
      }
      return dispatchCommon(command, args, dependencies);
    },
  };
}

async function invokeIsolated(name, loader, args, loads) {
  if (typeof loader !== 'function') {
    return isolatedError(name, 'not_implemented');
  }
  loads[name] += 1;
  let entry;
  try {
    entry = loader();
  } catch (error) {
    return isolatedError(name, 'isolated_module_unavailable', error.message || String(error));
  }
  if (!entry || typeof entry.handle !== 'function') {
    return isolatedError(name, 'isolated_module_unavailable', 'entry handle is missing');
  }
  let handlePromise;
  try {
    handlePromise = Promise.resolve(entry.handle(args));
  } catch (error) {
    return { value: isolatedHandleError(name, error) };
  }
  // Stateful runtimes own cancellation and draining. An outer timer must not
  // report a timeout while their work continues without supervision.
  const result = await handlePromise.catch(error => isolatedHandleError(name, error));
  return { value: result };
}

function isolatedHandleError(name, error) {
  if (error?.code === 'sfs_busy') return { ok: false, error: 'fact_store_writer_busy', command: name, detail: error.message };
  return commandFailure(error, name);
}

function isolatedError(command, error, detail) {
  return {
    value: {
        ok: false,
        error,
        command,
        ...(detail ? { detail } : {}),
    },
  };
}

module.exports = {
  createCommandRouter,
  isolatedCommandDefinitions,
};
