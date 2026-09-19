'use strict';

// Unit fixtures exercise the host and MCP result formatter in this process.
// Public CLI/MCP process and connection lifetime tests use the actual entries.
// Requests carry extract:null unless a test supplies its own public fields.
const host = require('../bin/execution-host');
const { toolResultForReply } = require('../bin/mcp-server');
const withExtract = args => ({ extract: null, ...args });
const runGeneric = async args => toolResultForReply(await host.run(withExtract(args)));
const runBridgeChecked = async (command, args = {}, dependencies = {}) => toolResultForReply(await host.run({ command, extract: null, arguments: args }, dependencies));
// The decoded original result of one command, as `value` of the public reply.
const executeCommand = async (command, args = {}) => decodeValue((await host.run({ command, extract: null, arguments: args }, { factRecorder: null, observationCollector: null })).value);
const decodeValue = reply => (reply.kind === 'bytes' ? Buffer.from(reply.value, 'base64') : reply.value);
// The public reply and the decoded original result of an MCP tool result.
// Discovery and unknown-tool results are not public replies and pass through.
const replyOf = result => JSON.parse(result.content[0].text);
const isPublic = reply => Boolean(reply && reply.execution && reply.delivery);
const payloadOf = result => { const reply = replyOf(result); return isPublic(reply) ? decodeValue(reply) : reply; };
module.exports = { runGeneric, runBridgeChecked, executeCommand, decodeValue, replyOf, payloadOf };
