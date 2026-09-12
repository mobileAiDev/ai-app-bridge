'use strict';

// Unit fixtures exercise the host and MCP result formatter in this process.
// Public CLI/MCP process and connection lifetime tests use the actual entries.
const host = require('../bin/execution-host');
const { toolResultForReply } = require('../bin/mcp-server');
const runGeneric = async args => toolResultForReply(await host.run(args));
const runBridgeChecked = async (command, args = {}, dependencies = {}) => toolResultForReply(await host.run({ command, arguments: args }, dependencies));
const executeCommand = async (command, args = {}) => (await host.run({ command, arguments: args }, { factRecorder: null, observationCollector: null })).value;
module.exports = { runGeneric, runBridgeChecked, executeCommand };
