'use strict';

const { restoreUnknownOperation } = require('./script-durable-restore');
const { scriptError } = require('./script-errors');
const { isRemovedScriptFormat, removedScriptFormatError } = require('./script-format-removed');
const { isCodeScript } = require('./script-spec');
const { readScriptResult } = require('./script-result');
const restoring = new WeakMap();

function scriptInput(args) {
  return args.script;
}

async function handleCodeOrRemoved(args = {}, supervisor) {
  if (args.operation === 'recipes') return require('./recipes').read(args);
  if (['recovery', 'inventory'].includes(args.operation)) return supervisor.handle(args);
  const script = scriptInput(args);
  if (args.operation === 'result' && args.store) return readScriptResult(args);
  if ((args.operation || 'start') === 'start') {
    if (isRemovedScriptFormat(script)) return removedScriptFormatError();
    if (!isCodeScript(script)) return scriptError('invalid_script', { field: 'schemaVersion' });
    return supervisor.handle(args);
  }
  if (args.operation === 'runtime-status' || (args.operationId && supervisor.knownOperation(args.operationId)
      && (!args.store || supervisor.registry.get(args.operationId)))) {
    return supervisor.handle(args);
  }
  if (args.operationId && args.store) {
    let pending = restoring.get(supervisor);
    if (!pending) { pending = new Set(); restoring.set(supervisor, pending); }
    if (args.operation === 'resume' && pending.has(args.operationId)) return scriptError('operation_busy', { operationId: args.operationId });
    if (args.operation === 'resume') pending.add(args.operationId);
    try {
      return await restoreUnknownOperation({ ...args, script, supervisor, operation: args.operation || 'status' });
    } finally { if (args.operation === 'resume') pending.delete(args.operationId); }
  }
  return scriptError('unknown_operation', { operationId: args.operationId || null });
}

module.exports = { handleCodeOrRemoved };
