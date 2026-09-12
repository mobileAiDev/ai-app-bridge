'use strict';

const { restoreUnknownOperation } = require('./script-durable-restore');
const { scriptError } = require('./script-errors');
const { isRemovedScriptFormat, removedScriptFormatError } = require('./script-format-removed');
const { isCodeScript } = require('./script-spec');
const { readScriptResult } = require('./script-result');

function scriptInput(args) {
  return args.script;
}

async function handleCodeOrRemoved(args = {}, supervisor) {
  const script = scriptInput(args);
  if (args.operation === 'result' && args.store) return readScriptResult(args);
  if ((args.operation || 'start') === 'start') {
    if (isRemovedScriptFormat(script)) return removedScriptFormatError();
    if (!isCodeScript(script)) return scriptError('invalid_script', { field: 'schemaVersion' });
    return supervisor.handle(args);
  }
  if (args.operation === 'runtime-status' || (args.operationId && supervisor.knownOperation(args.operationId))) {
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
    return restored;
  }
  return scriptError('unknown_operation', { operationId: args.operationId || null });
}

module.exports = { handleCodeOrRemoved };
