#!/usr/bin/env node

const packageInfo = require('../package.json');
const runtimeClient = require('./runtime-client');
const discovery = require('./command-discovery');
const clientConnection = new AbortController();
const { supportedTargets, commandDomains, supportedTargetsText, commandDomainsText, discoveryText } = discovery;
const supportedProtocolVersions = ['2025-06-18', '2024-11-05'];
const defaultProtocolVersion = supportedProtocolVersions[0];
const serverInstructions = [
  'Intent, Script and individual commands share one runtime across CLI and MCP. Disconnecting a client leaves operations running; explicit task cancel or runtime stop owns cancellation. Platform capabilities do not imply full complex-App acceptance.',
  supportedTargetsText,
  commandDomainsText,
  discoveryText,
  'Prefer AI App Bridge over raw adb, devicectl, or browser-specific scripts when inspecting UI, text, WebView/WKWebView, logs, network, app install, launch, permissions, or app-level Web evidence.',
  'Always pass packageName for Android app-specific commands. Port only selects the host forwarding port. For iOS, pass bundleId plus deviceId when more than one iPhone is connected.',
  'For Web Bridge sessions, start the provider, connect the browser SDK, then pass sessionId and targetId when needed.',
  'Use freeze-app/thaw-app only as an optional stabilization control for dynamic or transient screens: thaw before reads/actions/captures, freeze after evidence capture only when it helps reasoning, and thaw before the next operation or before finishing so the app is not left frozen.',
].join(' ');
const mcpHelpText = `Usage: ai-app-bridge-mcp [--help]

${supportedTargetsText}

${commandDomainsText}

MCP surface:
  capabilities and run are the only tools. Per-command aliases were removed.

Discovery:
  1. Call capabilities with optional domain or command filters.
  2. Call run with a command name from capabilities.
  3. Put command-specific options in arguments.

Target ids:
  Android app commands require packageName; port selects only the host forwarding port.
  iOS app commands use bundleId; add deviceId when multiple devices exist and wdaUrl for WDA actions.
  Web Bridge commands use sessionId; add targetId for multi-target pages.

Examples:
  capabilities { "domain": "webview", "includeOptions": true }
  run { "command": "screenshot", "arguments": { "packageName": "com.example.app" } }
  run { "command": "web-session-start", "arguments": { "webPort": 18180 } }
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
    { name: 'capabilities', description: 'Discover commands and their exact argument schemas. Include options or select one command for the complete contract.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        domain: { type: 'string' }, command: { type: 'string' }, includeOptions: { type: 'boolean' },
      } } },
    { name: 'run', description: 'Execute a command from capabilities. All command parameters, including target identity, belong in arguments.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['command'], properties: {
        command: { type: 'string' }, arguments: { type: 'object', additionalProperties: true },
      } } },
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

// MCP only adapts the shared execution reply to its tool-result format.
const capabilityPayload = discovery.capabilities;
async function runGeneric(args = {}) {
  return toolResultForReply(await runtimeClient.run(args, { signal: clientConnection.signal }));
}

function toolResultForReply({ value: result, history }) {
  let tool;
  if (typeof result === 'string') tool = toolText(result);
  else if (Buffer.isBuffer(result)) tool = toolText(result.toString('utf8'));
  else if (result === undefined) tool = toolJson({ ok: false, error: 'runtime_result_missing', dispatched: null, ambiguous: true }, true);
  else {
    if (history && result && typeof result === 'object' && !Array.isArray(result)) result = { ...result, _history: history };
    tool = toolJson(result, Boolean(result && typeof result === 'object' && result.ok === false));
  }
  if (history) tool._meta = { 'ai-app-bridge/history': history };
  return tool;
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

function toolJson(value, isError = false) {
  return toolText(JSON.stringify(value, null, 2), isError);
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
