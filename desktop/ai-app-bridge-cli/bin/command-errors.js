'use strict';

// `error` is a stable machine-readable code; `message` is for the caller.
// Unknown dispatch state stays null. Only the rejecting/dispatching layer can
// claim that an action was not sent.
class CommandError extends Error {
  constructor(code, message, { field, details, dispatched = false, ambiguous = false, settled, executionReceipt, executionReceipts, exitCode } = {}) {
    super(message);
    this.code = code;
    this.field = field;
    this.details = details;
    this.dispatched = dispatched;
    this.ambiguous = ambiguous;
    for (const [name, value] of Object.entries({ settled, executionReceipt, executionReceipts, exitCode })) {
      if (value !== undefined) this[name] = value;
    }
  }
}

function commandFailure(error, command) {
  const known = error instanceof CommandError;
  const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]*$/.test(error.code)
    ? error.code : 'command_failed';
  return {
    ok: false,
    error: code,
    message: error?.message || String(error),
    ...(command ? { command } : {}),
    ...(error?.field !== undefined ? { field: error.field } : {}),
    ...(error?.details !== undefined ? { details: error.details } : {}),
    dispatched: typeof error?.dispatched === 'boolean' ? error.dispatched : null,
    ambiguous: known ? error.ambiguous : error?.ambiguous !== false,
    ...executionFields(error),
    ...(error?._feedback ? { _feedback: error._feedback } : {}),
  };
}

function executionFields(value) {
  return Object.fromEntries(['settled', 'dispatched', 'ambiguous', 'executionReceipt', 'executionReceipts', 'exitCode']
    .filter(name => value?.[name] !== undefined).map(name => [name, value[name]]));
}

function normalizeCommandResult(result, command) {
  if (!result || typeof result !== 'object' || Buffer.isBuffer(result) || Array.isArray(result)) return result;
  if (result.ok !== false && result.error == null) return result;
  const original = typeof result.error === 'object' ? result.error?.code : result.error;
  const code = typeof original === 'string' && /^[a-z][a-z0-9_]*$/.test(original)
    ? original : 'command_failed';
  return {
    ...result,
    ok: false,
    error: code,
    message: result.message || result.error?.message || (typeof original === 'string' ? original : 'Command failed without an error reason.'),
    ...(command ? { command } : {}),
    dispatched: typeof result.dispatched === 'boolean' ? result.dispatched : null,
    ambiguous: typeof result.ambiguous === 'boolean' ? result.ambiguous : result.dispatched !== false,
  };
}

module.exports = { CommandError, commandFailure, normalizeCommandResult, executionFields };
