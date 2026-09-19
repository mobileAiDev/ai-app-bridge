'use strict';

const { CommandError } = require('./command-errors');
const { validateCommandArguments } = require('./command-registry');
const { validateValue } = require('./shared-kernel/argument-schema');

// The public run request shared by MCP and the CLI. Business arguments stay
// under `arguments`; `extract` and `output` never reach a device action.
const extractSchema = {
  description: 'Required. Use null for this command\'s result within the output budget, or regex/script to extract a smaller result on the Host. Execution and control facts remain separate. On overflow or extraction failure, use a returned response ref to retry extraction; do not repeat the action.',
  oneOf: [
    { type: 'null' },
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
    type: 'object', additionalProperties: false, required: ['command', 'extract'],
    properties: {
      command: { type: 'string', minLength: 1 },
      arguments: { type: 'object', additionalProperties: true },
      extract: extractSchema,
      output: outputSchema,
    },
  };
}

function validateRunRequest(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new CommandError('invalid_argument', 'run requires an object.', { field: 'arguments' });
  const extra = Object.keys(args).find(key => !['command', 'arguments', 'extract', 'output'].includes(key));
  if (extra) throw new CommandError('unsupported_argument', 'Put all command parameters in run.arguments; only command, arguments, extract and output are top-level fields.', { field: extra });
  if (!Object.hasOwn(args, 'extract')) {
    throw new CommandError('missing_argument', 'extract is required. Pass null (CLI: --extract null) to deliver this command\'s own result, or a regex/script extraction. Nothing was dispatched.', { field: 'extract' });
  }
  validateValue(args.extract, extractSchema, 'extract');
  if (Object.hasOwn(args, 'output')) validateValue(args.output, outputSchema, 'output');
  // Extraction modes and output budgets are delivered by M2c. Until then the
  // public schema is exposed and both are rejected before any dispatch.
  if (args.extract !== null) throw new CommandError('unsupported_argument', `extract mode ${args.extract.mode} is not available in this build; pass extract null. Nothing was dispatched.`, { field: 'extract.mode' });
  if (Object.hasOwn(args, 'output')) throw new CommandError('unsupported_argument', 'output budgets are not available in this build; omit output. Nothing was dispatched.', { field: 'output' });
  const command = typeof args.command === 'string' ? args.command : '';
  return { command, arguments: validateCommandArguments(command, args.arguments === undefined ? {} : args.arguments), extract: args.extract };
}

module.exports = { validateRunRequest, publicRequestSchema, extractSchema, outputSchema };
