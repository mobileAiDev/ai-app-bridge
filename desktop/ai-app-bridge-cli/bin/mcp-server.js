#!/usr/bin/env node

const packageInfo = require('../package.json');
const runtimeClient = require('./runtime-client');
const discovery = require('./command-discovery');
const { publicRequestSchema } = require('./command-request');
const clientConnection = new AbortController();
const { supportedTargets, commandDomains, supportedTargetsText, commandDomainsText, discoveryText } = discovery;
const supportedProtocolVersions = ['2025-06-18', '2024-11-05'];
const defaultProtocolVersion = supportedProtocolVersions[0];
const serverInstructions = [
  "Use AI App Bridge by default for App/device work, including ADB. Intent and Script are the primary task interfaces: Intent for observation-driven decisions; Script for JavaScript/Python operations, waits, branches and assertions, including one-off tasks. Read logs, take a screenshot, query status or perform a standalone action with its Bridge command directly; no workflow wrapper is needed.",
  "Run ADB through adb-exec with argv, also available inside Script ctx.call or Intent command actions. Android UIA and ADB need no embedded App SDK; one failed SDK path does not rule out Bridge. Use external tools only for an explicit user choice or a confirmed Bridge availability/capability gap; identify that gap before switching.",
  "When arguments are unknown, query only the needed command/operation with capabilities; execute through run with all command parameters in arguments. Intent/Script are commands, not extra tools. Bind the actual target: Intent arguments.target, Script arguments.script.target. Use the selected contract for platform/provider fields.",
  "Intent supervised needs decisions tied to the current observation revision; autonomous uses a supplied agentModule. Script ctx.call returns {ok,result,error}: check ok, then read result. Keep known work in one Script; askAgent only for new judgment. waitMs is at most 60000; continue the same operationId after a wait timeout. Use a returned result directly, otherwise read resultRef.",
  "CLI/MCP share one Runtime; a stale MCP can use the Bridge CLI. Disconnecting does not cancel tasks. Diagnose failures as needed and consider active work before restarting. Read execution for outcome, control for continuation and value for data. Extraction failures use a persisted control.source.ref, not a repeated action. Preserve unknown outcomes and verify actual business results.",
].join('\n');
const mcpHelpText = `Usage: ai-app-bridge-mcp [--help]

Agent execution defaults:
  Use AI App Bridge for App/device work, including ADB through adb-exec.
  Use Intent for observation-driven decisions; Script for code-driven task execution,
  including one-off flows with observations, waits, branches and assertions.
  Read logs, capture a screenshot, query status or perform a standalone action with the corresponding command directly.
  Switch outside Bridge only for an explicit user choice or a concrete availability/capability gap.

${supportedTargetsText}

${commandDomainsText}

MCP surface:
  capabilities and run are the only tools. Per-command aliases were removed.

Discovery:
  1. Choose Intent, Script or the needed standalone command; query capabilities with command and operation.
  2. Call run with a command name from capabilities.
  3. Put command-specific options in arguments; extract is optional (auto by default, null for the command's own result shape).

Target ids:
  Android app commands require packageName; port selects only the host forwarding port.
  iOS app commands use bundleId and the deviceId required by capabilities.
  WDA App actions require deviceId, wdaRunnerBundleId and wdaSessionId; wdaUrl is transport only.
  Web Bridge commands use sessionId; add targetId for multi-target pages.

Examples:
  capabilities { "command": "intent", "operation": "start" }
  capabilities { "command": "script", "operation": "start" }
  run { "command": "script", "arguments": { "operation": "recipes" } }
  run { "command": "adb-exec", "arguments": { "serial": "DEVICE", "argv": ["shell", "getprop", "sys.boot_completed"], "readOnly": true } }
`;
let buffer = Buffer.alloc(0);
let responseFormat = null;
const activeMessages = new Set();
let stdinEnded = false;
let shutdownPromise = null;
let signalHandlersInstalled = false;

function startServer() {
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    drainMessages();
  });

  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    stdinEnded = true;
    maybeShutdownAfterMessages();
  });
  installSignalHandlers();
}

function drainMessages() {
  while (true) {
    const parsed = readNextMessage(buffer);
    if (!parsed) {
      return;
    }
    buffer = parsed.remaining;
    setResponseFormat(parsed.format);
    const active = handleMessage(parsed.body).catch((error) => {
      writeLog(`unhandled message error: ${error.stack || error}`);
    }).finally(() => {
      activeMessages.delete(active);
      maybeShutdownAfterMessages();
    });
    activeMessages.add(active);
  }
}

function maybeShutdownAfterMessages() {
  if (!stdinEnded) return;
  void shutdownSharedResources();
}

function installSignalHandlers() {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      stdinEnded = true;
      void shutdownSharedResources().finally(() => process.exit(0));
    });
  }
}

async function shutdownSharedResources() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    clientConnection.abort();
    await Promise.allSettled([...activeMessages]);
  })();
  return shutdownPromise;
}

function readNextMessage(source) {
  const text = source.toString('utf8');
  if (/^Content-Length:/i.test(text)) {
    return readContentLengthMessage(source);
  }
  return readLineJsonMessage(source);
}

function readContentLengthMessage(source) {
  const delimiter = findHeaderDelimiter(source);
  const headerEnd = delimiter.index;
  if (headerEnd < 0) {
    return null;
  }
  const header = source.subarray(0, headerEnd).toString('utf8');
  const match = /^Content-Length:\s*(\d+)$/im.exec(header);
  if (!match) {
    return {
      body: source.subarray(headerEnd + delimiter.length).toString('utf8'),
      format: 'frame',
      remaining: Buffer.alloc(0),
    };
  }
  const contentLength = Number(match[1]);
  const messageStart = headerEnd + delimiter.length;
  const messageEnd = messageStart + contentLength;
  if (source.length < messageEnd) {
    return null;
  }
  return {
    body: source.subarray(messageStart, messageEnd).toString('utf8'),
    format: 'frame',
    remaining: source.subarray(messageEnd),
  };
}

function readLineJsonMessage(source) {
  const lfIndex = source.indexOf('\n');
  if (lfIndex < 0) {
    return null;
  }
  const lineEnd = lfIndex > 0 && source[lfIndex - 1] === 13 ? lfIndex - 1 : lfIndex;
  const body = source.subarray(0, lineEnd).toString('utf8');
  return {
    body,
    format: 'line',
    remaining: source.subarray(lfIndex + 1),
  };
}

function setResponseFormat(format) {
  if (!responseFormat) {
    responseFormat = format;
  }
}

function findHeaderDelimiter(source) {
  const crlfIndex = source.indexOf('\r\n\r\n');
  const lfIndex = source.indexOf('\n\n');
  if (crlfIndex < 0) {
    return { index: lfIndex, length: 2 };
  }
  if (lfIndex < 0 || crlfIndex < lfIndex) {
    return { index: crlfIndex, length: 4 };
  }
  return { index: lfIndex, length: 2 };
}

async function handleMessage(body) {
  let message;
  try {
    message = JSON.parse(body);
  } catch (error) {
    sendError(null, -32700, `Parse error: ${error.message}`);
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
    return;
  }

  try {
    if (message.method === 'initialize') {
      sendResult(message.id, {
        protocolVersion: negotiateProtocolVersion(message.params?.protocolVersion),
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'ai-app-bridge',
          title: 'AI App Bridge',
          version: packageInfo.version,
        },
        instructions: serverInstructions,
      });
      return;
    }

    if (message.method === 'ping') {
      sendResult(message.id, {});
      return;
    }

    if (message.method === 'tools/list') {
      sendResult(message.id, { tools: toolDefinitions() });
      return;
    }

    if (message.method === 'tools/call') {
      const name = message.params?.name;
      const args = message.params?.arguments === undefined ? {} : message.params.arguments;
      const result = await callTool(name, args);
      sendResult(message.id, result);
      return;
    }

    sendError(message.id, -32601, `Method not found: ${message.method}`);
  } catch (error) {
    sendError(message.id, -32000, error.message || String(error));
  }
}

function negotiateProtocolVersion(requestedVersion) {
  if (supportedProtocolVersions.includes(requestedVersion)) {
    return requestedVersion;
  }
  return defaultProtocolVersion;
}

function toolDefinitions() {
  return [
    { name: 'capabilities', description: "Discover the needed Bridge contract by command and operation. Intent/Script are the main task interfaces: query command=intent or script, operation=start. Standalone reads/actions can query their command directly; ADB is adb-exec. Omit command for a light directory. Intent decide can narrow by platform/provider/action.",
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        domain: { type: 'string' }, command: { type: 'string' }, includeOptions: { type: 'boolean' },
        operation: { type: 'string', description: 'With command=intent, script or evidence, select one operation.' },
        platform: { enum: ['android', 'ios', 'web'], description: 'Intent decide schema scope only.' },
        provider: { enum: ['native', 'uia', 'flutter', 'h5'], description: 'Intent decide schema scope only; must be supported by the selected platform.' },
        action: { type: 'string', description: 'Intent decide schema scope only, for example tap or inputText.' },
      } } },
    { name: 'run', description: "Execute through Bridge: intent for observed decisions, script for code-driven tasks, adb-exec for ADB; standalone logs/screenshots/queries/actions can call their command directly. Put all command parameters in arguments; Script source and target belong inside arguments.script. Query capabilities by command/operation when parameters are unknown. Omit extract for auto delivery; null preserves shape. Read execution/control/value for outcome/continuation/data.",
      inputSchema: publicRequestSchema() },
  ];
}

async function callTool(name, args) {
  if (name === 'capabilities') {
    const result = capabilityPayload(args);
    return toolJson(result, result.ok === false);
  }
  if (name === 'run') return runGeneric(args);
  return toolJson({ ok: false, error: 'unknown_tool', message: `Unknown tool: ${name}. Use capabilities or run.`, dispatched: false, ambiguous: false }, true);
}

// MCP only adapts the public reply to its tool-result format: the text is the
// compact public reply, isError follows failureStage. Nothing is duplicated
// into structuredContent or _meta.
const capabilityPayload = discovery.capabilities;
async function runGeneric(args = {}) {
  return toolResultForReply(await runtimeClient.run(args, { signal: clientConnection.signal }));
}

function toolResultForReply({ value: reply }) {
  return toolJson(reply, Boolean(reply.failureStage));
}

function toolText(text, isError = false) {
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
    isError,
  };
}

// Compact JSON: indentation is context cost for the calling model, not information.
function toolJson(value, isError = false) {
  return toolText(JSON.stringify(value), isError);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
}

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (responseFormat === 'line') {
    process.stdout.write(`${body.toString('utf8')}\n`);
    return;
  }
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function writeLog(text) {
  process.stderr.write(`${text}\n`);
}

if (require.main === module) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`${mcpHelpText}\n`);
    process.exit(0);
  }
  startServer();
}

module.exports = {
  capabilityPayload,
  callTool,
  toolDefinitions,
  toolResultForReply,
  commandDomains,
  mcpHelpText,
  readNextMessage,
  runGeneric,
  startServer,
  supportedTargets,
};
