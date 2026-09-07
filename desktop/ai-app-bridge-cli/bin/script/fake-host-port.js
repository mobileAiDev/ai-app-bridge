'use strict';

const { createScriptHostPort } = require('./script-host-port');
const { isCaptureReadCommand } = require('./script-capture-port');

// Explicit test substitute; it exercises the same evidence and assertion contract.
function createFakeHostPort({ handlers = {}, permissions, executionId, query, target } = {}) {
  return createScriptHostPort({
    permissions,
    executionId,
    query: query || (Object.keys(handlers).some(isCaptureReadCommand) ? async (request) => {
      const handler = handlers[request.command || request.stream];
      return handler ? handler(request, {}) : {};
    } : undefined),
    target,
    actions: async (command, args, options) => {
      const handler = handlers[command];
      return handler ? handler(args, options) : { ok: true, items: [] };
    },
  });
}

module.exports = { createFakeHostPort };
