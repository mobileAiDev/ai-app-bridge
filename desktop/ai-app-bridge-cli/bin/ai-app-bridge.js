#!/usr/bin/env node
'use strict';

const { CommandError } = require('./command-errors');
const { commandDefinitions, isolatedCommandDefinitions, parseCliOptions } = require('./command-registry');
const { commandHelpSchema } = require('./command-discovery');
const { publicFailure, exitCodeFor } = require('./public-reply');
const { publicOutputLimit } = require('./command-request');
const runtime = require('./runtime-client');

const helpText = `Usage: ai-app-bridge <command> [options]

CLI and MCP use one persistent execution runtime for Intent, Script, device
commands, Web sessions and evidence. A command starts the runtime when needed.
CLI exit and MCP disconnect leave tasks running. Use runtime --operation stop
for an orderly runtime shutdown, or intent/script --operation cancel for a task.

Commands:
${[...isolatedCommandDefinitions, ...commandDefinitions].map(d => `  ${d.command.padEnd(22)} ${d.summary}`).join('\n')}
  help                   Show this help.
  --version, -V          Show the installed CLI/MCP package version.

Use --help <command> to inspect its JSON input schema.
For intent/script/evidence, add --operation to read only that operation.
Intent decide also accepts --platform, --provider and --action schema filters.
CLI flags use kebab-case, for example --package-name, --tap-x, --timeout-ms.
Objects, arrays, nullable objects and Script decisions use JSON flag values.
Only --category and --extra repeat as individual strings.
Every command requires --extract: null delivers the command's own result.
Results are one line of compact JSON: {command, execution, control, extraction,
delivery, kind: "json"|"text"|"bytes", value, failureStage?}. Bytes are base64.
Exit 0: delivered as requested. 1: rejected, failed or unknown execution.
2: the command succeeded but extraction or delivery failed. Help is plain text.
Relative file paths use the calling directory. Script cwd defaults to it.
Example: ai-app-bridge script --extract null --operation start --script '{"schemaVersion":"aab.code-script/v1","language":"javascript","sourcePath":"./regression.js","target":{"platform":"android","serial":"<serial>","packageName":"<package>"}}'
`;

async function main() {
  let command;
  let maxBytes;
  const connection = new AbortController();
  const disconnect = () => connection.abort();
  process.once('SIGINT', disconnect);
  process.once('SIGTERM', disconnect);
  try {
    const argv = process.argv.slice(2);
    if (argv.length === 1 && ['--version', '-V', 'version'].includes(argv[0])) {
      process.stdout.write(`${require('../package.json').version}\n`);
      return;
    }
    if (!argv.length) { process.stdout.write(`${helpText}\n`); return; }
    const parsed = parseArgs(argv);
    command = parsed.command;
    const envelopeOutput = publicFields({ output: parsed.options.output });
    maxBytes = publicOutputLimit(envelopeOutput);
    if (parsed.error) throw parsed.error;
    if (parsed.options.help || command === 'help') {
      const name = command === 'help' ? '' : command;
      const { help, ...filters } = parsed.options;
      if (!name && Object.keys(filters).length) throw new CommandError('invalid_argument', 'Schema filters require a command after --help.', { field: Object.keys(filters)[0] });
      const schema = name ? commandHelpSchema(name, filters) : null;
      process.stdout.write(name ? `${JSON.stringify(schema)}\n` : `${helpText}\n`);
      if (schema?.ok === false) process.exitCode = 1;
      return;
    }
    command ||= 'status';
    // The public fields leave the CLI options before the command's own parser
    // sees them; each is one JSON value and never reaches the device action.
    const { extract, output, ...options } = parsed.options;
    const request = { command, ...envelopeOutput };
    Object.assign(request, publicFields({ extract }));
    request.arguments = parseCliOptions(command, options);
    const { value: reply } = await runtime.run(request, { signal: connection.signal });
    process.stdout.write(`${JSON.stringify(reply)}\n`);
    process.exitCode = exitCodeFor(reply);
  } catch (error) {
    const reply = publicFailure({ command, stage: 'validation', error, maxBytes });
    process.stdout.write(`${JSON.stringify(reply)}\n`);
    process.exitCode = exitCodeFor(reply);
  } finally {
    process.removeListener('SIGINT', disconnect);
    process.removeListener('SIGTERM', disconnect);
  }
}

// --extract and --output carry JSON. A flag without a value is a missing value,
// not `true`; the JSON string "null" is not null.
function publicFields(fields) {
  const parsed = {};
  for (const [name, raw] of Object.entries(fields)) {
    if (raw === undefined) continue;
    if (raw === true) throw new CommandError('missing_argument', `--${name} requires one JSON value${name === 'extract' ? '; use --extract null for this command\'s own result' : ''}.`, { field: name });
    try { parsed[name] = JSON.parse(raw); }
    catch { throw new CommandError('invalid_argument', `--${name} must be one JSON value${name === 'extract' ? ', for example null' : ''}: ${raw}`, { field: name }); }
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {};
  let command = '';
  let error;
  // Finish reading named tokens after a lexical error so its reply can still
  // honor a valid output budget. The first error rejects the entire request.
  const append = (name, value) => {
    try { appendOption(options, name, value); }
    catch (cause) { error ||= cause; }
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--') && !command) {
      command = arg;
      continue;
    }
    if (!arg.startsWith('--')) {
      error ||= new CommandError('unexpected_argument', `Unexpected positional argument: ${arg}. Supply values through named flags.`, { field: `argv[${index}]` });
      continue;
    }
    const rawName = arg.slice(2);
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(rawName)) {
      error ||= new CommandError('invalid_argument', `Invalid CLI flag: ${arg}. Use --kebab-case flags followed by separate value tokens.`, { field: `argv[${index}]` });
      continue;
    }
    const name = rawName.replace(/-([a-z])/g, (_, value) => value.toUpperCase());
    const next = argv[index + 1];
    if (name === 'help' || next === undefined || next.startsWith('--')) {
      append(name, true);
      continue;
    }
    append(name, next);
    index += 1;
  }
  return { command, options, ...(error ? { error } : {}) };
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
