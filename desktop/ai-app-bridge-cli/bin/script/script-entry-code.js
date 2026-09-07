'use strict';

const { handleCodeOrRemoved } = require('./script-entry-route');
const { createScriptHostPort } = require('./script-host-port');
const { createScriptSupervisor } = require('./script-supervisor');
const { getProcessDeviceMutationLease } = require('../shared-kernel/device-mutation-lease');

function createProductionHost(opts = {}) {
  if (typeof opts.actions !== 'function') {
    throw new TypeError('host_actions_required');
  }
  return createScriptHostPort({
    ...opts,
    mutationLease: opts.mutationLease || getProcessDeviceMutationLease(),
  });
}

const codeSupervisor = createScriptSupervisor({ createHost: createProductionHost });

function handle(args = {}) {
  return handleCodeOrRemoved(args, args.supervisor || codeSupervisor);
}

function resetScriptOperations() {}

module.exports = { handle, resetScriptOperations, createProductionHost };
