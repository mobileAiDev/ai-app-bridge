'use strict';

const { restoreUnknownOperation } = require('./script-durable-restore');
const { scriptError } = require('./script-errors');
const { isRemovedScriptFormat, removedScriptFormatError } = require('./script-format-removed');
const { isCodeScript } = require('./script-spec');

function scriptInput(args) {
  return args.script || args.spec || args.yaml || args.source;
}

async function handleCodeOrRemoved(args = {}, supervisor) {
  const script = scriptInput(args);
  if ((args.operation || 'start') === 'start' && isRemovedScriptFormat(script)) {
    return removedScriptFormatError();
  }
  if (
    ((args.operation || 'start') === 'start' && isCodeScript(script))
    || args.operation === 'runtime-status'
    || (args.operationId && supervisor.knownOperation(args.operationId))
  ) {
    return supervisor.handle(args);
  }
  if (args.operationId && args.store) {
    const restored = await restoreUnknownOperation({
      ...args,
      store: args.store,
      operationId: args.operationId,
      script,
      supervisor,
      operation: args.operation || 'status',
    });
    if (restored.format === 'steps') {
      return removedScriptFormatError();
    }
    return restored;
  }
  if ((args.operation || 'start') === 'start') {
    return scriptError('invalid_script', { field: 'schemaVersion' });
  }
  return scriptError('unknown_operation', { operationId: args.operationId || null });
}

module.exports = { handleCodeOrRemoved };
