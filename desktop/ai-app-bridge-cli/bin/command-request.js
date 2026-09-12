'use strict';

const { CommandError } = require('./command-errors');
const { validateCommandArguments } = require('./command-registry');

function validateRunRequest(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new CommandError('invalid_argument', 'run requires an object.', { field: 'arguments' });
  const extra = Object.keys(args).find(key => key !== 'command' && key !== 'arguments');
  if (extra) throw new CommandError('unsupported_argument', 'Put all command parameters in run.arguments.', { field: extra });
  const command = typeof args.command === 'string' ? args.command : '';
  return { command, arguments: validateCommandArguments(command, args.arguments === undefined ? {} : args.arguments) };
}

module.exports = { validateRunRequest };
