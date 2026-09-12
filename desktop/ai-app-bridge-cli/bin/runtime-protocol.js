'use strict';

const { CommandError } = require('./command-errors');
const protocol = 'aab.runtime/v1';
const maxMessageBytes = 128 * 1024 * 1024;

// The wire distinguishes JSON, text and bytes. History never replaces a raw
// observation, and an absent provider result is not a successful command.
function encodeReply({ value, history }) {
  if (value === undefined) throw new CommandError('runtime_result_missing', 'Execution returned no result.', { dispatched: null, ambiguous: true });
  const kind = Buffer.isBuffer(value) ? 'bytes' : typeof value === 'string' ? 'text' : 'json';
  return { kind, value: kind === 'bytes' ? value.toString('base64') : value, ...(history ? { history } : {}) };
}

function decodeReply(reply) {
  if (!reply || !['json', 'text', 'bytes'].includes(reply.kind) || !Object.hasOwn(reply, 'value')
    || (reply.kind !== 'json' && typeof reply.value !== 'string')) {
    throw new CommandError('runtime_protocol_error', 'The runtime returned an invalid execution reply.', { dispatched: null, ambiguous: true });
  }
  return { value: reply.kind === 'bytes' ? Buffer.from(reply.value, 'base64') : reply.value,
    ...(reply.history ? { history: reply.history } : {}) };
}

async function readJson(stream) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > maxMessageBytes) throw new CommandError('runtime_message_too_large', 'Runtime messages are limited to 128 MiB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new CommandError('runtime_protocol_error', 'Expected one JSON runtime message.'); }
}

module.exports = { protocol, maxMessageBytes, encodeReply, decodeReply, readJson };
