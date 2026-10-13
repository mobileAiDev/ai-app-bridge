'use strict';

const { CommandError } = require('./command-errors');
const { validateCommandArguments } = require('./command-registry');
const { validateValue } = require('./shared-kernel/argument-schema');

// The public run request shared by MCP and the CLI. Business arguments stay
// under `arguments`; `extract` and `output` never reach a device action.
const extractSchema = {
  description: 'Optional; omitted uses auto: return the complete result whenever it fits output.maxBytes (96 KiB by default). Over-budget JSON first tries a complete table representation; only results that still do not fit become partial views with complete records or text ranges and a saved response ref. Explicit null requests the original shape without automatic formatting. Delta returns a complete baseline, then lossless changes against an explicit saved base for repeated observations. Select a JSON Pointer/slice or use regex/script for precise extraction. Execution/control facts remain separate; do not repeat the action to read more.',
  oneOf: [
    { type: 'null' },
    { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'auto' } } },
    { type: 'object', additionalProperties: false, required: ['mode'], properties: {
      mode: { const: 'delta' },
      base: { ...require('./response-store').responseSchema().properties.ref,
        description: 'Optional control.source.ref of a previous delta reply. Omit for a complete baseline. Fresh observations still execute; only delivery is differenced. Missing/expired bases return a new complete baseline without failing the command.' },
    } },
    { type: 'object', additionalProperties: false, required: ['mode', 'path'], properties: {
      mode: { const: 'select' }, path: { type: 'string', description: 'JSON Pointer into the original response. Empty string selects the root.' },
      offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1 },
    } },
    {
      type: 'object', additionalProperties: false,
      required: ['mode', 'pattern', 'inputPath'],
      properties: {
        mode: { const: 'regex' },
        pattern: { type: 'string', minLength: 1, maxLength: 2048 },
        flags: { type: 'string', pattern: '^[imsu]*$', description: 'Unique JavaScript RegExp flags. The Host returns all matches; g/y are not accepted.' },
        inputPath: { type: 'string', description: 'JSON Pointer to a string in the response. Empty string selects a text response.' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 },
      },
    },
    {
      type: 'object', additionalProperties: false,
      required: ['mode', 'language'],
      properties: {
        mode: { const: 'script' },
        language: { enum: ['javascript', 'python'] },
        source: { type: 'string', minLength: 1, maxLength: 65536, description: 'main(ctx). ctx.inputs contains kind, response, execution, control. Return a JSON value.' },
        sourcePath: { type: 'string', minLength: 1, description: 'Resolve from the caller cwd and freeze source before dispatch. Exactly one of source/sourcePath.' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 },
      },
      oneOf: [{ required: ['source'] }, { required: ['sourcePath'] }],
    },
  ],
};
const outputSchema = {
  type: 'object', additionalProperties: false, required: ['maxBytes'],
  properties: { maxBytes: { type: 'integer', minimum: 16384, maximum: 262144 } },
};

function publicRequestSchema() {
  return {
    type: 'object', additionalProperties: false, required: ['command'],
    properties: {
      command: { type: 'string', minLength: 1 },
      arguments: { type: 'object', additionalProperties: true },
      extract: extractSchema,
      output: outputSchema,
    },
  };
}

// Preserve a valid caller budget even when another part of the request fails
// validation. Invalid output is still reported by validateRunRequest.
function publicOutputLimit(args) {
  if (!args || !Object.hasOwn(args, 'output')) return undefined;
  try { validateValue(args.output, outputSchema, 'output'); }
  catch { return undefined; }
  return args.output.maxBytes;
}

function validateRunRequest(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new CommandError('invalid_argument', 'run requires an object.', { field: 'arguments' });
  const extra = Object.keys(args).find(key => !['command', 'arguments', 'extract', 'output'].includes(key));
  if (extra) throw new CommandError('unsupported_argument', 'Put all command parameters in run.arguments; only command, arguments, extract and output are top-level fields.', { field: extra });
  const extract = Object.hasOwn(args, 'extract') ? args.extract : { mode: 'auto' };
  validateValue(extract, extractSchema, 'extract');
  if (Object.hasOwn(args, 'output')) validateValue(args.output, outputSchema, 'output');
  const command = typeof args.command === 'string' ? args.command : '';
  return { command, arguments: validateCommandArguments(command, args.arguments === undefined ? {} : args.arguments), extract,
    ...(args.output ? { output: args.output } : {}) };
}

module.exports = { validateRunRequest, publicRequestSchema, publicOutputLimit, extractSchema, outputSchema };
