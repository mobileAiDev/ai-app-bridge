#!/usr/bin/env node
'use strict';

const { CommandError, commandFailure } = require('./command-errors');
const { commandDefinitions, isolatedCommandDefinitions, parseCliOptions } = require('./command-registry');
const { commandInputSchema } = require('./command-discovery');
const { encodeReply } = require('./runtime-protocol');
const runtime = require('./runtime-client');

const helpText = `Usage: ai-app-bridge <command> [options]

CLI and MCP use one persistent execution runtime for Intent, Script, device
commands, Web sessions and evidence. A command starts the runtime when needed.
CLI exit and MCP disconnect leave tasks running. Use runtime --operation stop
for an orderly runtime shutdown, or intent/script --operation cancel for a task.

Commands:
${[...isolatedCommandDefinitions, ...commandDefinitions].map(d => `  ${d.command.padEnd(22)} ${d.summary}`).join('\n')}
  help                   Show this help.

Use --help <command> to inspect its JSON input schema.
For intent/script/evidence, add --operation to read only that operation.
Intent decide also accepts --platform, --provider and --action schema filters.
CLI flags use kebab-case, for example --package-name, --tap-x, --timeout-ms.
Objects, arrays, nullable objects and Script decisions use JSON flag values.
Only --category and --extra repeat as individual strings.
Results are JSON: {kind: "json"|"text"|"bytes", value, history?}.
Bytes are base64; value.ok:false exits with code 1. Help is plain text.
Relative file paths use the calling directory. Script cwd defaults to it.
Example: ai-app-bridge script --operation start --script '{"schemaVersion":"aab.code-script/v1","language":"javascript","sourcePath":"./regression.js"}'
`;

async function main() {
  let command;
  const connection = new AbortController();
  const disconnect = () => connection.abort();
  process.once('SIGINT', disconnect);
  process.once('SIGTERM', disconnect);
  try {
    const parsed = parseArgs(process.argv.slice(2));
    command = parsed.command;
    if (parsed.options.help || command === 'help') {
      const name = command === 'help' ? '' : command;
      const { help, ...filters } = parsed.options;
      if (!name && Object.keys(filters).length) throw new CommandError('invalid_argument', 'Schema filters require a command after --help.', { field: Object.keys(filters)[0] });
      process.stdout.write(name ? `${JSON.stringify(commandInputSchema(name, filters), null, 2)}\n` : `${helpText}\n`);
      return;
    }
    command ||= 'status';
    const reply = await runtime.run({ command, arguments: parseCliOptions(command, parsed.options) }, { signal: connection.signal });
    process.stdout.write(`${JSON.stringify(encodeReply(reply), null, 2)}\n`);
    if (reply.value?.ok === false) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(encodeReply({ value: commandFailure(error, command) }), null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', disconnect);
    process.removeListener('SIGTERM', disconnect);
  }
}

function parseArgs(argv) {
  const options = {};
  let command = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--') && !command) {
      command = arg;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new CommandError('unexpected_argument', `Unexpected positional argument: ${arg}. Supply values through named flags.`, { field: `argv[${index}]` });
    }
    const rawName = arg.slice(2);
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(rawName)) {
      throw new CommandError('invalid_argument', `Invalid CLI flag: ${arg}. Use --kebab-case flags followed by separate value tokens.`, { field: `argv[${index}]` });
    }
    const name = rawName.replace(/-([a-z])/g, (_, value) => value.toUpperCase());
    const next = argv[index + 1];
    if (name === 'help' || next === undefined || next.startsWith('--')) {
      appendOption(options, name, true);
      continue;
    }
    appendOption(options, name, next);
    index += 1;
  }
  return { command, options };
}

function appendOption(options, name, value) {
  if (name === 'extra' || name === 'category') {
    if (!Array.isArray(options[name])) options[name] = [];
    options[name].push(value);
    return;
  }
  if (Object.hasOwn(options, name)) {
    throw new CommandError('duplicate_argument', `CLI flag ${name} may be supplied only once. Only --category and --extra accept repeated values.`, { field: name });
  }
  options[name] = value;
}

if (require.main === module) main();
module.exports = { parseArgs, helpText };
