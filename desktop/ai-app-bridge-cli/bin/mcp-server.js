#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const packageInfo = require('../package.json');
const bridgeDir = __dirname;
const cliScript = path.join(bridgeDir, 'ai-app-bridge.js');
const nodeBinary = process.env.AI_APP_BRIDGE_NODE || process.execPath;
const supportedProtocolVersions = ['2025-06-18', '2024-11-05'];
const defaultProtocolVersion = supportedProtocolVersions[0];
const mcpSurface = (process.env.AI_APP_BRIDGE_MCP_SURFACE || 'compact').toLowerCase();
const serverInstructions = [
  'AI App Bridge observes and controls Android apps for agent workflows. Prefer these tools over raw adb when inspecting UI, text, WebView, logs, network, app install, data reset, launch, and permissions.',
  'Default surface is compact: call capabilities to discover domains, then call run with a command and arguments.',
  'Always pass packageName for app-specific commands, or pass an explicit port. Do not rely on a sample/default package in MCP sessions.',
  'Use freeze-app/thaw-app only as an optional stabilization control for dynamic or transient screens: thaw before reads/actions/captures, freeze after evidence capture only when it helps reasoning, and thaw before the next operation or before finishing so the app is not left frozen.',
].join(' ');

let buffer = Buffer.alloc(0);
let responseFormat = null;

function startServer() {
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    drainMessages();
  });

  process.stdin.on('error', () => {});
}

function drainMessages() {
  while (true) {
    const parsed = readNextMessage(buffer);
    if (!parsed) {
      return;
    }
    buffer = parsed.remaining;
    setResponseFormat(parsed.format);
    handleMessage(parsed.body).catch((error) => {
      writeLog(`unhandled message error: ${error.stack || error}`);
    });
  }
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
      const args = message.params?.arguments || {};
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
  if (mcpSurface === 'full' || mcpSurface === 'legacy') {
    return fullToolDefinitions();
  }
  return compactToolDefinitions();
}

function compactToolDefinitions() {
  return [
    bridgeTool('capabilities', 'List AI App Bridge capability domains and commands. Call this first when planning Android app automation; then use run to execute the selected command.', {
      domain: { type: 'string', description: 'Optional domain filter such as core, app, action, flutter, webview, or diagnostics.' },
      command: { type: 'string', description: 'Optional command name for detailed arguments, such as install-apk, launch-app, tree, input-text, or webview-network.' },
      includeOptions: { type: 'boolean', description: 'Include per-command argument names. Defaults to false to keep output compact.' },
    }),
    bridgeTool('run', 'Run an AI App Bridge command. Use capabilities first to choose the command. Always pass packageName for app-specific commands.', {
      command: { type: 'string', description: 'Command name from capabilities, using CLI form such as status, install-apk, launch-app, freeze-app, thaw-app, input-text, tree, webview-network, or logcat.' },
      packageName: { type: 'string', description: 'Target Android package for app-specific commands. Strongly recommended.' },
      serial: { type: 'string', description: 'ADB serial when multiple devices are connected.' },
      port: { type: 'number', description: 'Explicit bridge port when packageName discovery is not available.' },
      adb: { type: 'string', description: 'ADB executable path or command.' },
      arguments: {
        type: 'object',
        description: 'Command-specific arguments from capabilities. Example: {"apkPath":"app-debug.apk","allowDowngrade":true}.',
        additionalProperties: true,
      },
    }, ['command']),
  ];
}

function fullToolDefinitions() {
  return [
    bridgeTool('status', 'Read compact bridge status, app info, capture counts, and Flutter layout summary. If default port 18080 times out, agents should retry with the target Android packageName so the CLI can discover the app bridge port.', {
      full: { type: 'boolean', description: 'Return the full raw status payload, including large Flutter widget dumps.' },
    }),
    bridgeTool('tree', 'Read the Android View tree from the in-app bridge.'),
    bridgeTool('flutter_tree', 'Read the latest Flutter widget/layout snapshot.'),
    bridgeTool('flutter_nodes', 'Read Flutter operable nodes from the Flutter action bridge.'),
    bridgeTool('tap_flutter_text', 'Tap a Flutter node by visible text through the Flutter-aware bridge path.', {
      targetText: { type: 'string', description: 'Flutter node text to tap.' },
    }, ['targetText']),
    bridgeTool('input_flutter_text', 'Set Flutter TextField text through the Flutter action bridge. Use this for Flutter Chinese/Unicode input; do not use raw adb shell input text.', {
      text: { type: 'string', description: 'Text to set.' },
      tapX: { type: 'number', description: 'Optional physical X coordinate for the Flutter input target.' },
      tapY: { type: 'number', description: 'Optional physical Y coordinate for the Flutter input target.' },
      hideKeyboard: { type: 'boolean', description: 'Hide the soft keyboard after setting text.' },
    }, ['text']),
    bridgeTool('h5_dom', 'Read native Android WebView DOM from the current Activity.'),
    bridgeTool('h5_eval', 'Execute debug JavaScript in the current native Android WebView.', {
      script: { type: 'string' },
    }, ['script']),
    bridgeTool('h5_click', 'Click a native Android WebView DOM element by CSS selector or text.', h5TargetSchema(), []),
    bridgeTool('h5_input', 'Set text in a native Android WebView input by CSS selector or text.', {
      ...h5TargetSchema(),
      value: { type: 'string', description: 'Text value to set.' },
    }, ['value']),
    bridgeTool('h5_wait', 'Wait for a native Android WebView DOM element or body text.', {
      ...h5TargetSchema(),
      timeoutSec: { type: 'number', description: 'Maximum wait time. Defaults to 10 seconds.' },
      intervalMs: { type: 'number', description: 'Polling interval. Defaults to 500 ms.' },
    }),
    bridgeTool('h5_scroll', 'Scroll a native Android WebView or scroll a DOM element into view.', {
      ...h5TargetSchema(),
      deltaX: { type: 'number', description: 'Window scroll delta X when no selector/text is supplied.' },
      deltaY: { type: 'number', description: 'Window scroll delta Y when no selector/text is supplied.' },
    }),
    bridgeTool('flutter_h5_dom', 'Read DOM through a Flutter-registered H5 adapter.'),
    bridgeTool('flutter_h5_eval', 'Execute JavaScript through a Flutter-registered H5 adapter.', {
      script: { type: 'string' },
    }, ['script']),
    bridgeTool('flutter_h5_click', 'Click a Flutter H5 DOM element by CSS selector or text.', h5TargetSchema(), []),
    bridgeTool('flutter_h5_input', 'Set text in a Flutter H5 input by CSS selector or text.', {
      ...h5TargetSchema(),
      value: { type: 'string', description: 'Text value to set.' },
    }, ['value']),
    bridgeTool('flutter_h5_wait', 'Wait for a Flutter H5 DOM element or body text.', {
      ...h5TargetSchema(),
      timeoutSec: { type: 'number', description: 'Maximum wait time. Defaults to 10 seconds.' },
      intervalMs: { type: 'number', description: 'Polling interval. Defaults to 500 ms.' },
    }),
    bridgeTool('flutter_h5_scroll', 'Scroll a Flutter H5 document or DOM element into view.', {
      ...h5TargetSchema(),
      deltaX: { type: 'number', description: 'Window scroll delta X when no selector/text is supplied.' },
      deltaY: { type: 'number', description: 'Window scroll delta Y when no selector/text is supplied.' },
    }),
    bridgeTool('logs', 'Read generic in-app log records.'),
    bridgeTool('freeze_app', 'Optionally stop target app processes with SIGSTOP when a dynamic or transient screen needs stable evidence for review.', {
      pid: { type: 'string', description: 'Optional explicit process id. Defaults to all processes named packageName or packageName:*.' },
    }, ['packageName']),
    bridgeTool('thaw_app', 'Resume target app processes with SIGCONT before reads, waits, captures, or actions, and before finishing any task that used freeze-app.', {
      pid: { type: 'string', description: 'Optional explicit process id. Defaults to all processes named packageName or packageName:*.' },
    }, ['packageName']),
    bridgeTool('logcat', 'Read Android logcat through ADB with optional pid/tag/level/grep filters.', {
      pid: { type: 'string', description: 'Use "current" for the current app pid, or pass a numeric pid.' },
      appPid: { type: 'boolean', description: 'Filter by the current package pid.' },
      tag: { type: 'string', description: 'Comma-separated exact logcat tags.' },
      level: { type: 'string', description: 'Minimum Android log level: V,D,I,W,E,F.' },
      grep: { type: 'string', description: 'Substring filter applied after pid/tag/level.' },
      lines: { type: 'number', description: 'Input logcat tail line count before filtering.' },
      since: { type: 'string', description: 'Passed to adb logcat -T.' },
      follow: { type: 'boolean', description: 'Follow live logs for durationSec seconds.' },
      durationSec: { type: 'number', description: 'Bounded live follow duration. Max 60 seconds.' },
      clear: { type: 'boolean', description: 'Clear logcat before reading/following.' },
    }),
    bridgeTool('network', 'Read generic in-app network records.', {
      compact: { type: 'boolean', description: 'Return one-line-sized network record summaries without bodies.' },
      urlFilter: { type: 'string', description: 'Only retain records whose URL contains this string.' },
      method: { type: 'string', description: 'Only retain records with this HTTP method.' },
      statusCode: { type: 'number', description: 'Only retain records with this HTTP status.' },
      noBodies: { type: 'boolean', description: 'Omit requestBody and responseBody fields from full output.' },
      bodyMaxBytes: { type: 'number', description: 'Maximum request/response body bytes retained per record.' },
    }),
    bridgeTool('webview_pages', 'List attachable Android WebView DevTools/CDP pages for the target package.', {
      webviewPort: { type: 'number', description: 'Local port used for adb forward. Defaults to the first free port at or above 9222.' },
      socketName: { type: 'string', description: 'Explicit webview_devtools_remote socket name.' },
      targetId: { type: 'string', description: 'Optional CDP target/page id.' },
      pageUrlFilter: { type: 'string', description: 'Prefer a WebView page whose URL contains this string.' },
      keepForward: { type: 'boolean', description: 'Leave the adb forward active after listing pages.' },
    }),
    bridgeTool('webview_network', 'Capture WebView fetch/XHR/resource Network events through Chrome DevTools Protocol.', {
      webviewPort: { type: 'number', description: 'Local port used for adb forward. Defaults to the first free port at or above 9222.' },
      socketName: { type: 'string', description: 'Explicit webview_devtools_remote socket name.' },
      targetId: { type: 'string', description: 'Optional CDP target/page id.' },
      pageUrlFilter: { type: 'string', description: 'Prefer a WebView page whose URL contains this string.' },
      urlFilter: { type: 'string', description: 'Only retain Network requests whose URL contains this string.' },
      durationMs: { type: 'number', description: 'Capture duration after attach. Defaults to 3000 ms.' },
      script: { type: 'string', description: 'JavaScript expression to evaluate after Network/Runtime are enabled.' },
      includeResponseBody: { type: 'boolean', description: 'Fetch response bodies with Network.getResponseBody when available.' },
      bodyMaxBytes: { type: 'number', description: 'Maximum response/request body bytes retained per event.' },
      maxEvents: { type: 'number', description: 'Maximum raw CDP events retained. Defaults to 200.' },
    }),
    bridgeTool('webview_console', 'Capture WebView console and log events through Chrome DevTools Protocol.', {
      webviewPort: { type: 'number', description: 'Local port used for adb forward. Defaults to the first free port at or above 9222.' },
      socketName: { type: 'string', description: 'Explicit webview_devtools_remote socket name.' },
      targetId: { type: 'string', description: 'Optional CDP target/page id.' },
      pageUrlFilter: { type: 'string', description: 'Prefer a WebView page whose URL contains this string.' },
      durationMs: { type: 'number', description: 'Capture duration after attach. Defaults to 3000 ms.' },
      script: { type: 'string', description: 'JavaScript expression to evaluate after Runtime is enabled.' },
      maxEvents: { type: 'number', description: 'Maximum raw CDP events retained. Defaults to 200.' },
    }),
    bridgeTool('state', 'Read generic in-app state records.'),
    bridgeTool('events', 'Read generic in-app event records.'),
    bridgeTool('uia_tree', 'Read UIAutomator XML for the current device window.'),
    bridgeTool('screenshot', 'Capture an ADB screenshot.'),
    bridgeTool('install_apk', 'Install an APK through ADB while assisting device-side package-installer confirmation screens with UIAutomator.', {
      apkPath: { type: 'string', description: 'Absolute or workspace-relative APK path.' },
      allowDowngrade: { type: 'boolean', description: 'Pass -d to adb install.' },
      streaming: { type: 'boolean', description: 'Use streaming install instead of the default --no-streaming mode.' },
      installTimeoutMs: { type: 'number', description: 'Maximum time for adb install. Defaults to 180000 ms.' },
      installerTimeoutMs: { type: 'number', description: 'Maximum time to keep assisting installer screens after adb install exits. Defaults to 90000 ms.' },
      intervalMs: { type: 'number', description: 'Installer polling interval. Defaults to 700 ms.' },
    }, ['apkPath']),
    bridgeTool('clear_app_data', 'Clear target app local data through the bridge runtime. Requires packageName so it cannot target the sample package by default.', {}, ['packageName']),
    bridgeTool('launch_app', 'Launch the target package LAUNCHER Activity. If multiple launcher Activities exist, returns launcher_ambiguous with candidates unless activity or component is explicit.', launchProperties()),
    bridgeTool('launch_activity', 'Launch an explicit Android Activity component, optionally with action/data/category/string extras.', launchProperties()),
    bridgeTool('launch_native_test', 'Launch the debug native Android bridge test Activity.'),
    bridgeTool('launch_flutter', 'Launch the Flutter Activity, optionally with an initial route.'),
    bridgeTool('tap', 'Tap device coordinates through ADB.', {
      tapX: { type: 'number' },
      tapY: { type: 'number' },
    }, ['tapX', 'tapY']),
    bridgeTool('tap_text', 'Tap the center of an Android View node by exact text or contentDescription.', {
      targetText: { type: 'string' },
      noAutoHideKeyboard: { type: 'boolean', description: 'Disable the default keyboard-risk guard before tapping lower-screen app nodes.' },
    }, ['targetText']),
    bridgeTool('wait_text', 'Wait until text appears in status, Android tree, or UIAutomator tree.', {
      targetText: { type: 'string' },
      timeoutSec: { type: 'number' },
    }, ['targetText']),
    bridgeTool('input_text', 'Set native Android text through the in-app bridge. Use this for Chinese/Unicode; always pass packageName so the tool targets the intended app.', {
      text: { type: 'string', description: 'Text to set in the focused or coordinate-matched native EditText.' },
      tapX: { type: 'number', description: 'Optional X coordinate used to choose a native EditText target.' },
      tapY: { type: 'number', description: 'Optional Y coordinate used to choose a native EditText target.' },
      hideKeyboard: { type: 'boolean', description: 'Hide the soft keyboard after setting text.' },
    }, ['text', 'packageName']),
    bridgeTool('keyboard_state', 'Read Android soft-keyboard visibility from dumpsys input_method.'),
    bridgeTool('hide_keyboard', 'Hide the Android soft keyboard when it is visible.', {
      force: { type: 'boolean', description: 'Send keyboard-dismiss keys even when the visibility probe says the keyboard is hidden.' },
      intervalMs: { type: 'number', description: 'Delay between dismiss attempts. Defaults to 500 ms.' },
    }),
    bridgeTool('swipe', 'Swipe device coordinates through ADB.', {
      startX: { type: 'number' },
      startY: { type: 'number' },
      endX: { type: 'number' },
      endY: { type: 'number' },
      durationMs: { type: 'number' },
    }, ['startX', 'startY', 'endX', 'endY']),
    bridgeTool('keyevent', 'Send an Android keyevent through ADB.', {
      keyCode: { type: 'number' },
    }, ['keyCode']),
    bridgeTool('permission_state', 'Read Android runtime permission state from dumpsys package.', {
      permission: { type: 'string' },
    }, ['permission']),
    bridgeTool('permission_grant', 'Grant an Android runtime permission with adb pm grant, then read state.', {
      permission: { type: 'string' },
    }, ['permission']),
    bridgeTool('permission_revoke', 'Revoke an Android runtime permission with adb pm revoke, then read state.', {
      permission: { type: 'string' },
    }, ['permission']),
    bridgeTool('appops_set', 'Set an Android app-op mode with adb appops set.', {
      op: { type: 'string' },
      mode: { type: 'string' },
    }, ['op', 'mode']),
    bridgeTool('tap_uia_text', 'Tap a UIAutomator node by text without relying on the in-app tree.', {
      targetText: { type: 'string' },
      exact: { type: 'boolean' },
    }, ['targetText']),
    bridgeTool('permission_dialog', 'Tap a visible Android permission dialog allow button through UIAutomator.', {
      targetText: { type: 'string', description: 'Optional custom allow-button text.' },
      buttonText: { type: 'string', description: 'Optional comma-separated allow-button texts.' },
      resourceId: { type: 'string', description: 'Optional permission button resource id.' },
      attempts: { type: 'number' },
      intervalMs: { type: 'number' },
      exact: { type: 'boolean' },
    }),
    {
      name: 'run_smoke',
      description: 'Run the full Android + Flutter bridge smoke test.',
      inputSchema: baseSchema(),
    },
  ];
}

function bridgeTool(name, description, properties = {}, required = []) {
  return {
    name,
    description,
    inputSchema: baseSchema(properties, required),
  };
}

function launchProperties() {
  return {
    activity: { type: 'string', description: 'Activity class, such as .MainActivity or com.example.MainActivity.' },
    component: { type: 'string', description: 'Explicit Android component, such as com.example/.MainActivity.' },
    action: { type: 'string', description: 'Intent action for explicit Activity launch.' },
    category: { type: 'string', description: 'Intent category.' },
    data: { type: 'string', description: 'Intent data URI.' },
    extra: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'String intent extras as an object of key/value pairs.',
    },
  };
}

function baseSchema(extraProperties = {}, extraRequired = []) {
  return {
    type: 'object',
    properties: {
      serial: { type: 'string', description: 'ADB serial. Optional when one device is connected.' },
      adb: { type: 'string', description: 'ADB executable path or command.' },
      port: { type: 'number', description: 'Raw bridge port override. Defaults to 18080; agents should prefer packageName when targeting a known app.' },
      packageName: { type: 'string', description: 'Target Android package name. Use this when default 18080 is unreachable or multiple bridge-enabled apps are installed; the CLI discovers the app bridge port from package-private state.' },
      initialRoute: { type: 'string', description: 'Flutter initial route for launch_flutter.' },
      outFile: { type: 'string', description: 'Screenshot output path for screenshot.' },
      artifactDir: { type: 'string', description: 'Directory for generated default artifacts such as screenshots.' },
      sinceId: { type: 'number', description: 'Capture query lower bound by record id.' },
      sinceMs: { type: 'number', description: 'Capture query lower bound by timestamp milliseconds.' },
      limit: { type: 'number', description: 'Maximum capture records to return.' },
      ...extraProperties,
    },
    required: extraRequired,
    additionalProperties: false,
  };
}

function h5TargetSchema() {
  return {
    selector: { type: 'string', description: 'CSS selector for the target DOM element.' },
    targetText: { type: 'string', description: 'Text, value, aria-label, placeholder, id, name, or role to match.' },
    exact: { type: 'boolean', description: 'Require exact text match instead of substring match.' },
  };
}

const commandDefinitions = [
  { command: 'status', domain: 'core', summary: 'Read bridge status, app/device metadata, capture counts, and Flutter summary.', targetApp: true, options: ['packageName', 'port', 'serial', 'full'] },
  { command: 'tree', domain: 'core', summary: 'Read Android View tree from the in-app bridge.', targetApp: true, options: ['packageName', 'port', 'serial', 'compact', 'textFilter', 'resourceIdFilter', 'classFilter', 'visibleOnly', 'maxNodes', 'maxDepth'] },
  { command: 'uia-tree', domain: 'core', summary: 'Read UIAutomator XML for the current foreground window.', options: ['serial', 'compact', 'textFilter', 'resourceIdFilter', 'classFilter', 'visibleOnly', 'maxNodes'] },
  { command: 'screenshot', domain: 'core', summary: 'Capture a screenshot, with foreground package verification when packageName is supplied.', options: ['serial', 'packageName', 'outFile', 'artifactDir'] },
  { command: 'logs', domain: 'core', summary: 'Read in-app log records from the bridge.', targetApp: true, options: ['packageName', 'port', 'serial', 'sinceId', 'sinceMs', 'limit'] },
  { command: 'network', domain: 'core', summary: 'Read in-app network records from the bridge.', targetApp: true, options: ['packageName', 'port', 'serial', 'compact', 'urlFilter', 'method', 'statusCode', 'noBodies', 'bodyMaxBytes', 'sinceId', 'sinceMs', 'limit'] },
  { command: 'state', domain: 'core', summary: 'Read in-app state records from the bridge.', targetApp: true, options: ['packageName', 'port', 'serial', 'sinceId', 'sinceMs', 'limit'] },
  { command: 'events', domain: 'core', summary: 'Read in-app event records from the bridge.', targetApp: true, options: ['packageName', 'port', 'serial', 'sinceId', 'sinceMs', 'limit'] },
  { command: 'logcat', domain: 'diagnostics', summary: 'Read Android logcat with optional app pid, tag, level, and grep filters.', options: ['serial', 'packageName', 'pid', 'appPid', 'tag', 'level', 'grep', 'lines', 'since', 'follow', 'durationSec', 'clear'] },
  { command: 'install-apk', domain: 'app', summary: 'Install an APK and assist device-side installer confirmation screens.', options: ['serial', 'packageName', 'apkPath', 'allowDowngrade', 'streaming', 'installTimeoutMs', 'installerTimeoutMs', 'intervalMs'] },
  { command: 'clear-app-data', domain: 'app', summary: 'Clear target app local data through the bridge runtime.', targetApp: true, options: ['serial', 'packageName'] },
  { command: 'freeze-app', domain: 'app', summary: 'Optionally stop target app processes with SIGSTOP when dynamic UI needs stable evidence.', targetApp: true, options: ['serial', 'packageName', 'pid'] },
  { command: 'thaw-app', domain: 'app', summary: 'Resume target app processes with SIGCONT before reads, waits, captures, actions, or final handoff.', targetApp: true, options: ['serial', 'packageName', 'pid'] },
  { command: 'launch-app', domain: 'app', summary: 'Launch the target package LAUNCHER Activity and report launcher candidates.', targetApp: true, options: ['serial', 'packageName', 'activity', 'component', 'action', 'category', 'data', 'extra'] },
  { command: 'launch-activity', domain: 'app', summary: 'Launch an explicit Android Activity component with optional string extras.', targetApp: true, options: ['serial', 'packageName', 'activity', 'component', 'action', 'category', 'data', 'extra'] },
  { command: 'launch-native-test', domain: 'app', summary: 'Launch the debug native bridge test Activity.', targetApp: true, options: ['serial', 'packageName'] },
  { command: 'launch-flutter', domain: 'app', summary: 'Launch the Flutter Activity, optionally with an initial route.', targetApp: true, options: ['serial', 'packageName', 'initialRoute'] },
  { command: 'permission-state', domain: 'app', summary: 'Read Android runtime permission state.', targetApp: true, options: ['serial', 'packageName', 'permission'] },
  { command: 'permission-grant', domain: 'app', summary: 'Grant an Android runtime permission.', targetApp: true, options: ['serial', 'packageName', 'permission'] },
  { command: 'permission-revoke', domain: 'app', summary: 'Revoke an Android runtime permission.', targetApp: true, options: ['serial', 'packageName', 'permission'] },
  { command: 'permission-dialog', domain: 'app', summary: 'Tap a visible Android permission dialog allow button.', options: ['serial', 'targetText', 'buttonText', 'resourceId', 'attempts', 'intervalMs', 'exact'] },
  { command: 'appops-set', domain: 'app', summary: 'Set an Android app-op mode.', targetApp: true, options: ['serial', 'packageName', 'op', 'mode'] },
  { command: 'tap', domain: 'action', summary: 'Tap device coordinates through ADB.', options: ['serial', 'tapX', 'tapY'] },
  { command: 'tap-text', domain: 'action', summary: 'Tap a visible Android View node by text/contentDescription through the bridge tree.', targetApp: true, options: ['serial', 'packageName', 'targetText', 'noAutoHideKeyboard'] },
  { command: 'tap-uia-text', domain: 'action', summary: 'Tap a UIAutomator node by text without relying on the in-app tree.', options: ['serial', 'targetText', 'exact'] },
  { command: 'wait-text', domain: 'action', summary: 'Wait until text appears in bridge status/tree or UIAutomator output.', targetApp: true, options: ['serial', 'packageName', 'targetText', 'timeoutSec', 'requireText', 'absentText', 'requireActivity'] },
  { command: 'input-text', domain: 'action', summary: 'Set native Android text through the in-app bridge; use this for Chinese/Unicode.', targetApp: true, options: ['serial', 'packageName', 'text', 'tapX', 'tapY', 'hideKeyboard'] },
  { command: 'keyboard-state', domain: 'action', summary: 'Read Android soft keyboard visibility.', options: ['serial'] },
  { command: 'hide-keyboard', domain: 'action', summary: 'Hide the Android soft keyboard.', options: ['serial', 'force', 'intervalMs'] },
  { command: 'swipe', domain: 'action', summary: 'Swipe device coordinates through ADB.', options: ['serial', 'startX', 'startY', 'endX', 'endY', 'durationMs'] },
  { command: 'keyevent', domain: 'action', summary: 'Send an Android keyevent through ADB.', options: ['serial', 'keyCode'] },
  { command: 'flutter-tree', domain: 'flutter', summary: 'Read the latest Flutter layout snapshot.', targetApp: true, options: ['serial', 'packageName', 'port'] },
  { command: 'flutter-nodes', domain: 'flutter', summary: 'Read Flutter operable nodes.', targetApp: true, options: ['serial', 'packageName', 'port'] },
  { command: 'flutter-action', domain: 'flutter', summary: 'Dispatch a raw Flutter action payload.', targetApp: true, options: ['serial', 'packageName', 'payload'] },
  { command: 'tap-flutter-text', domain: 'flutter', summary: 'Tap a Flutter node by visible text.', targetApp: true, options: ['serial', 'packageName', 'targetText'] },
  { command: 'input-flutter-text', domain: 'flutter', summary: 'Set Flutter TextField text through the Flutter action bridge.', targetApp: true, options: ['serial', 'packageName', 'text', 'tapX', 'tapY', 'hideKeyboard'] },
  { command: 'scroll-flutter', domain: 'flutter', summary: 'Scroll Flutter content by delta or until text is visible.', targetApp: true, options: ['serial', 'packageName', 'targetText', 'delta', 'maxSwipes'] },
  { command: 'h5-dom', domain: 'webview', summary: 'Read native Android WebView DOM.', targetApp: true, options: ['serial', 'packageName', 'port'] },
  { command: 'h5-eval', domain: 'webview', summary: 'Execute JavaScript in the current native Android WebView.', targetApp: true, options: ['serial', 'packageName', 'script'] },
  { command: 'h5-click', domain: 'webview', summary: 'Click a native WebView element by selector or text.', targetApp: true, options: ['serial', 'packageName', 'selector', 'targetText', 'exact'] },
  { command: 'h5-input', domain: 'webview', summary: 'Set text in a native WebView input.', targetApp: true, options: ['serial', 'packageName', 'selector', 'targetText', 'value', 'exact'] },
  { command: 'h5-wait', domain: 'webview', summary: 'Wait for native WebView text or selector.', targetApp: true, options: ['serial', 'packageName', 'selector', 'targetText', 'timeoutSec', 'intervalMs'] },
  { command: 'h5-scroll', domain: 'webview', summary: 'Scroll native WebView content or a DOM element into view.', targetApp: true, options: ['serial', 'packageName', 'selector', 'targetText', 'deltaX', 'deltaY'] },
  { command: 'flutter-h5-dom', domain: 'webview', summary: 'Read DOM through a Flutter H5 adapter.', targetApp: true, options: ['serial', 'packageName', 'port'] },
  { command: 'flutter-h5-eval', domain: 'webview', summary: 'Execute JavaScript through a Flutter H5 adapter.', targetApp: true, options: ['serial', 'packageName', 'script'] },
  { command: 'flutter-h5-click', domain: 'webview', summary: 'Click a Flutter H5 DOM element.', targetApp: true, options: ['serial', 'packageName', 'selector', 'targetText', 'exact'] },
  { command: 'flutter-h5-input', domain: 'webview', summary: 'Set text in a Flutter H5 input.', targetApp: true, options: ['serial', 'packageName', 'selector', 'targetText', 'value', 'exact'] },
  { command: 'flutter-h5-wait', domain: 'webview', summary: 'Wait for Flutter H5 text or selector.', targetApp: true, options: ['serial', 'packageName', 'selector', 'targetText', 'timeoutSec', 'intervalMs'] },
  { command: 'flutter-h5-scroll', domain: 'webview', summary: 'Scroll Flutter H5 content or a DOM element into view.', targetApp: true, options: ['serial', 'packageName', 'selector', 'targetText', 'deltaX', 'deltaY'] },
  { command: 'webview-pages', domain: 'webview', summary: 'List attachable Android WebView DevTools/CDP pages.', targetApp: true, options: ['serial', 'packageName', 'webviewPort', 'socketName', 'targetId', 'pageUrlFilter', 'keepForward'] },
  { command: 'webview-network', domain: 'webview', summary: 'Capture WebView Network events through CDP.', targetApp: true, options: ['serial', 'packageName', 'webviewPort', 'socketName', 'targetId', 'pageUrlFilter', 'urlFilter', 'durationMs', 'script', 'includeResponseBody', 'bodyMaxBytes', 'maxEvents'] },
  { command: 'webview-console', domain: 'webview', summary: 'Capture WebView console/log events through CDP.', targetApp: true, options: ['serial', 'packageName', 'webviewPort', 'socketName', 'targetId', 'pageUrlFilter', 'durationMs', 'script', 'maxEvents'] },
  { command: 'forward', domain: 'advanced', summary: 'Create the ADB port forward for the bridge.', targetApp: true, options: ['serial', 'packageName', 'port'] },
  { command: 'remove-forward', domain: 'advanced', summary: 'Remove the ADB port forward for the bridge.', options: ['serial', 'port'] },
  { command: 'batch', domain: 'advanced', summary: 'Run multiple AI App Bridge commands serially in one MCP call.', options: ['defaults', 'steps', 'stopOnError', 'includeRaw', 'maxRawChars'] },
  { command: 'smoke', domain: 'diagnostics', summary: 'Run the native sample smoke test.', options: ['serial', 'packageName', 'outFile', 'artifactDir', 'skipFlutterLaunch'] },
];

const commandByName = new Map(commandDefinitions.map((definition) => [definition.command, definition]));

async function callTool(name, args) {
  if (name === 'capabilities') {
    return toolJson(capabilityPayload(args));
  }
  if (name === 'run') {
    return runGeneric(args);
  }
  if (name === 'run_smoke') {
    return runSmoke(args);
  }
  const commandMap = {
    flutter_tree: 'flutter-tree',
    h5_dom: 'h5-dom',
    h5_eval: 'h5-eval',
    h5_click: 'h5-click',
    h5_input: 'h5-input',
    h5_wait: 'h5-wait',
    h5_scroll: 'h5-scroll',
    freeze_app: 'freeze-app',
    thaw_app: 'thaw-app',
    flutter_h5_dom: 'flutter-h5-dom',
    flutter_h5_eval: 'flutter-h5-eval',
    flutter_h5_click: 'flutter-h5-click',
    flutter_h5_input: 'flutter-h5-input',
    flutter_h5_wait: 'flutter-h5-wait',
    flutter_h5_scroll: 'flutter-h5-scroll',
    flutter_nodes: 'flutter-nodes',
    tap_flutter_text: 'tap-flutter-text',
    input_flutter_text: 'input-flutter-text',
    uia_tree: 'uia-tree',
    install_apk: 'install-apk',
    clear_app_data: 'clear-app-data',
    launch_app: 'launch-app',
    launch_activity: 'launch-activity',
    launch_native_test: 'launch-native-test',
    launch_flutter: 'launch-flutter',
    tap_text: 'tap-text',
    wait_text: 'wait-text',
    input_text: 'input-text',
    keyboard_state: 'keyboard-state',
    hide_keyboard: 'hide-keyboard',
    webview_pages: 'webview-pages',
    webview_network: 'webview-network',
    webview_console: 'webview-console',
    permission_state: 'permission-state',
    permission_grant: 'permission-grant',
    permission_revoke: 'permission-revoke',
    appops_set: 'appops-set',
    tap_uia_text: 'tap-uia-text',
    permission_dialog: 'permission-dialog',
  };
  const command = commandMap[name] || name;
  return runBridgeChecked(command, args);
}

function capabilityPayload(args = {}) {
  const includeOptions = Boolean(args.includeOptions);
  const requestedCommand = args.command ? normalizeCommandName(args.command) : '';
  if (requestedCommand) {
    const definition = commandByName.get(requestedCommand);
    return {
      ok: Boolean(definition),
      command: requestedCommand,
      ...(definition ? shapeCommandDefinition(definition, true) : { error: 'unknown_command' }),
    };
  }

  const requestedDomain = args.domain ? String(args.domain) : '';
  const domains = {};
  for (const definition of commandDefinitions) {
    if (requestedDomain && definition.domain !== requestedDomain) continue;
    if (!domains[definition.domain]) domains[definition.domain] = [];
    domains[definition.domain].push(shapeCommandDefinition(definition, includeOptions));
  }
  return {
    ok: true,
    surface: mcpSurface === 'full' || mcpSurface === 'legacy' ? 'full' : 'compact',
    usage: 'Use run with one of these command names. Prefer packageName for app-specific commands; install-apk, clear-app-data, launch-app, freeze/thaw, UI, WebView, logcat, network, and permission workflows are supported.',
    domains,
  };
}

function shapeCommandDefinition(definition, includeOptions) {
  return {
    command: definition.command,
    summary: definition.summary,
    targetApp: Boolean(definition.targetApp),
    ...(includeOptions ? { options: definition.options || [] } : {}),
  };
}

async function runGeneric(args = {}) {
  const command = normalizeCommandName(args.command);
  if (!commandByName.has(command)) {
    return toolText(`unknown command: ${args.command || ''}`, true);
  }
  const commandArgs = {
    ...(args.arguments && typeof args.arguments === 'object' ? args.arguments : {}),
  };
  for (const key of ['adb', 'serial', 'port', 'packageName']) {
    if (args[key] !== undefined && commandArgs[key] === undefined) {
      commandArgs[key] = args[key];
    }
  }
  if (command === 'batch') {
    return runBatch(commandArgs);
  }
  return runBridgeChecked(command, commandArgs);
}

function normalizeCommandName(value) {
  return String(value || '').trim().replace(/_/g, '-');
}

function runBridgeChecked(command, args = {}) {
  if (command === 'clear-app-data' && !args.packageName) {
    return toolText('clear-app-data: packageName is required in MCP mode so the command cannot clear a default package.', true);
  }
  if ((command === 'freeze-app' || command === 'thaw-app') && !args.packageName) {
    return toolText(`${command}: packageName is required in MCP mode so the command cannot signal a default package.`, true);
  }
  const definition = commandByName.get(command);
  if (definition?.targetApp && !args.packageName && !args.port) {
    return toolText(`${command}: packageName or explicit port is required in MCP mode so the command cannot fall back to a default package.`, true);
  }
  return runBridge(command, args);
}

async function runBatch(args = {}, runner = runBridgeChecked) {
  const startedAtMs = Date.now();
  const mode = args.mode ? String(args.mode) : 'serial';
  if (mode !== 'serial') {
    return toolJson({ ok: false, error: 'batch_mode_not_supported', mode }, true);
  }
  const steps = Array.isArray(args.steps) ? args.steps : [];
  if (steps.length === 0) {
    return toolJson({ ok: false, error: 'batch_steps_required' }, true);
  }
  const maxSteps = args.maxSteps === undefined ? 30 : Number(args.maxSteps);
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    return toolJson({ ok: false, error: 'invalid_max_steps', maxSteps: args.maxSteps }, true);
  }
  if (steps.length > maxSteps) {
    return toolJson({ ok: false, error: 'batch_too_many_steps', stepCount: steps.length, maxSteps }, true);
  }

  const defaults = args.defaults && typeof args.defaults === 'object' ? { ...args.defaults } : {};
  for (const key of ['adb', 'serial', 'port', 'packageName', 'artifactDir']) {
    if (args[key] !== undefined && defaults[key] === undefined) {
      defaults[key] = args[key];
    }
  }

  const normalizedSteps = [];
  const seenIds = new Set();
  for (let index = 0; index < steps.length; index += 1) {
    const rawStep = steps[index] && typeof steps[index] === 'object' ? steps[index] : {};
    const stepId = String(rawStep.id || `step_${index + 1}`);
    if (seenIds.has(stepId)) {
      return toolJson({ ok: false, error: 'duplicate_batch_step_id', stepId }, true);
    }
    seenIds.add(stepId);
    const command = normalizeCommandName(rawStep.command);
    if (!commandByName.has(command)) {
      return toolJson({ ok: false, error: 'unknown_batch_step_command', stepId, command: rawStep.command || '' }, true);
    }
    if (command === 'batch') {
      return toolJson({ ok: false, error: 'nested_batch_not_supported', stepId }, true);
    }
    normalizedSteps.push({ ...rawStep, id: stepId, command });
  }

  const stopOnError = args.stopOnError !== false;
  const includeRaw = Boolean(args.includeRaw);
  const maxRawChars = args.maxRawChars === undefined ? 4000 : Number(args.maxRawChars);
  if (!Number.isInteger(maxRawChars) || maxRawChars < 0) {
    return toolJson({ ok: false, error: 'invalid_max_raw_chars', maxRawChars: args.maxRawChars }, true);
  }
  const results = [];
  let stopped = false;

  for (const step of normalizedSteps) {
    if (stopped) {
      results.push({
        id: step.id,
        command: step.command,
        status: 'skipped',
        ok: false,
        skipped: true,
        reason: 'stopOnError',
      });
      continue;
    }

    const stepStartedAtMs = Date.now();
    const stepArgs = {
      ...defaults,
      ...(step.arguments && typeof step.arguments === 'object' ? step.arguments : {}),
    };
    for (const key of ['adb', 'serial', 'port', 'packageName']) {
      if (step[key] !== undefined) {
        stepArgs[key] = step[key];
      }
    }
    try {
      const toolResult = await runner(step.command, stepArgs);
      const parsed = parseToolResult(toolResult);
      const passed = !parsed.isError && parsed.payload?.ok !== false;
      const stepResult = {
        id: step.id,
        command: step.command,
        status: passed ? 'passed' : 'failed',
        ok: passed,
        packageName: stepArgs.packageName,
        port: stepArgs.port,
        durationMs: Date.now() - stepStartedAtMs,
        summary: summarizeToolPayload(parsed),
      };
      if (!passed) {
        stepResult.error = parsed.payload?.error || firstTextLine(parsed.text) || 'command_failed';
      }
      if (includeRaw) {
        stepResult.result = parsed.payload || undefined;
        stepResult.rawText = parsed.payload ? undefined : truncateText(parsed.text, maxRawChars);
      }
      results.push(stepResult);
      if (!passed && stopOnError) {
        stopped = true;
      }
    } catch (error) {
      const stepResult = {
        id: step.id,
        command: step.command,
        status: 'failed',
        ok: false,
        packageName: stepArgs.packageName,
        port: stepArgs.port,
        durationMs: Date.now() - stepStartedAtMs,
        error: error.message || String(error),
      };
      results.push(stepResult);
      if (stopOnError) {
        stopped = true;
      }
    }
  }

  const failed = results.filter((item) => item.status === 'failed').length;
  const skipped = results.filter((item) => item.status === 'skipped').length;
  const passed = results.filter((item) => item.status === 'passed').length;
  return toolJson({
    ok: failed === 0,
    batchId: args.batchId || generatedBatchId(),
    mode,
    stopOnError,
    stepCount: normalizedSteps.length,
    passed,
    failed,
    skipped,
    durationMs: Date.now() - startedAtMs,
    steps: results,
  }, failed > 0);
}

async function runBridge(command, args) {
  return runProcess(buildBridgeCliArgs(command, args));
}

function parseToolResult(toolResult) {
  const text = String(toolResult?.content?.[0]?.text || '');
  try {
    return {
      isError: Boolean(toolResult?.isError),
      text,
      payload: JSON.parse(text),
    };
  } catch (_) {
    return {
      isError: Boolean(toolResult?.isError),
      text,
      payload: null,
    };
  }
}

function summarizeToolPayload(parsed) {
  const payload = parsed.payload;
  if (!payload || typeof payload !== 'object') {
    return { text: truncateText(parsed.text, 500) };
  }
  const summary = {
    ok: payload.ok,
    error: payload.error || null,
  };
  if (payload.packageName) summary.packageName = payload.packageName;
  if (payload.app?.packageName) summary.app = payload.app.packageName;
  if (payload.activity) summary.activity = payload.activity;
  if (payload.component) summary.component = payload.component;
  if (payload.transport) summary.transport = payload.transport;
  if (payload.source) summary.source = payload.source;
  if (payload.path) summary.path = payload.path;
  if (payload.debugBridge) {
    summary.bridge = {
      version: payload.debugBridge.version,
      port: payload.debugBridge.port,
    };
  }
  if (payload.count !== undefined) summary.count = payload.count;
  if (payload.nodeCount !== undefined) summary.nodeCount = payload.nodeCount;
  if (Array.isArray(payload.items)) summary.items = payload.items.length;
  if (payload.values && typeof payload.values === 'object') {
    summary.values = Object.keys(payload.values).length;
  }
  if (payload.counts) summary.counts = payload.counts;
  if (Array.isArray(payload.requests)) summary.requests = payload.requests.length;
  if (Array.isArray(payload.console)) summary.console = payload.console.length;
  if (payload.flutter?.layout?.operable) {
    summary.flutterOperable = {
      ok: payload.flutter.layout.operable.ok,
      count: payload.flutter.layout.operable.count,
    };
  }
  if (payload.result && typeof payload.result === 'object') {
    summary.result = {
      ok: payload.result.ok,
      error: payload.result.error || null,
      value: truncateText(payload.result.value, 200),
      bodyText: truncateText(payload.result.bodyText, 200),
    };
  }
  return summary;
}

function truncateText(value, maxChars) {
  if (value === undefined || value === null) return value;
  const text = String(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

function firstTextLine(value) {
  const lines = String(value || '').split(/\r?\n/).filter((line) => line.trim());
  return lines.find((line) => {
    const text = line.trim().toLowerCase();
    return text !== 'stderr:' && text !== 'stdout:';
  }) || lines[0] || '';
}

function generatedBatchId() {
  return `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildBridgeCliArgs(command, args = {}) {
  const cliArgs = [cliScript, command];
  addCommonArgs(cliArgs, args);
  addArg(cliArgs, 'initial-route', args.initialRoute);
  addArg(cliArgs, 'activity', args.activity);
  addArg(cliArgs, 'component', args.component);
  addArg(cliArgs, 'action', args.action);
  addRepeatedArg(cliArgs, 'category', args.category);
  addArg(cliArgs, 'data', args.data);
  addExtraArgs(cliArgs, args.extra);
  addArg(cliArgs, 'out-file', args.outFile);
  addArg(cliArgs, 'artifact-dir', args.artifactDir || defaultArtifactDirFor(command, args));
  addArg(cliArgs, 'apk-path', args.apkPath);
  addArg(cliArgs, 'tap-x', args.tapX);
  addArg(cliArgs, 'tap-y', args.tapY);
  addArg(cliArgs, 'target-text', args.targetText);
  addArg(cliArgs, 'no-auto-hide-keyboard', args.noAutoHideKeyboard);
  addArg(cliArgs, 'timeout-sec', args.timeoutSec);
  addArg(cliArgs, 'text', args.text);
  addArg(cliArgs, 'hide-keyboard', args.hideKeyboard);
  addArg(cliArgs, 'force', args.force);
  addArg(cliArgs, 'start-x', args.startX);
  addArg(cliArgs, 'start-y', args.startY);
  addArg(cliArgs, 'end-x', args.endX);
  addArg(cliArgs, 'end-y', args.endY);
  addArg(cliArgs, 'duration-ms', args.durationMs);
  addArg(cliArgs, 'allow-downgrade', args.allowDowngrade);
  addArg(cliArgs, 'streaming', args.streaming);
  addArg(cliArgs, 'install-timeout-ms', args.installTimeoutMs);
  addArg(cliArgs, 'installer-timeout-ms', args.installerTimeoutMs);
  addArg(cliArgs, 'webview-port', args.webviewPort);
  addArg(cliArgs, 'socket-name', args.socketName);
  addArg(cliArgs, 'target-id', args.targetId);
  addArg(cliArgs, 'page-url-filter', args.pageUrlFilter);
  addArg(cliArgs, 'url-filter', args.urlFilter);
  addArg(cliArgs, 'method', args.method);
  addArg(cliArgs, 'status-code', args.statusCode);
  addArg(cliArgs, 'compact', args.compact);
  addArg(cliArgs, 'full', args.full);
  addArg(cliArgs, 'text-filter', args.textFilter);
  addArg(cliArgs, 'resource-id-filter', args.resourceIdFilter);
  addArg(cliArgs, 'class-filter', args.classFilter);
  addArg(cliArgs, 'visible-only', args.visibleOnly);
  addArg(cliArgs, 'max-nodes', args.maxNodes);
  addArg(cliArgs, 'max-depth', args.maxDepth);
  addArg(cliArgs, 'no-bodies', args.noBodies);
  addArg(cliArgs, 'duration-ms', args.durationMs);
  addArg(cliArgs, 'include-response-body', args.includeResponseBody);
  addArg(cliArgs, 'body-max-bytes', args.bodyMaxBytes);
  addArg(cliArgs, 'max-events', args.maxEvents);
  addArg(cliArgs, 'keep-forward', args.keepForward);
  addArg(cliArgs, 'key-code', args.keyCode);
  addArg(cliArgs, 'payload', args.payload);
  addArg(cliArgs, 'delta', args.delta);
  addArg(cliArgs, 'max-swipes', args.maxSwipes);
  addArg(cliArgs, 'permission', args.permission);
  addArg(cliArgs, 'op', args.op);
  addArg(cliArgs, 'mode', args.mode);
  addArg(cliArgs, 'script', args.script);
  addArg(cliArgs, 'selector', args.selector);
  addArg(cliArgs, 'target-text', args.targetText);
  addArg(cliArgs, 'value', args.value);
  addArg(cliArgs, 'exact', args.exact);
  addArg(cliArgs, 'button-text', args.buttonText);
  addArg(cliArgs, 'resource-id', args.resourceId);
  addArg(cliArgs, 'attempts', args.attempts);
  addArg(cliArgs, 'interval-ms', args.intervalMs);
  addArg(cliArgs, 'delta-x', args.deltaX);
  addArg(cliArgs, 'delta-y', args.deltaY);
  addArg(cliArgs, 'require-text', args.requireText);
  addArg(cliArgs, 'absent-text', args.absentText);
  addArg(cliArgs, 'require-activity', args.requireActivity);
  addArg(cliArgs, 'since-id', args.sinceId);
  addArg(cliArgs, 'since-ms', args.sinceMs);
  addArg(cliArgs, 'limit', args.limit);
  addArg(cliArgs, 'pid', args.pid);
  addArg(cliArgs, 'app-pid', args.appPid);
  addArg(cliArgs, 'tag', args.tag);
  addArg(cliArgs, 'level', args.level);
  addArg(cliArgs, 'grep', args.grep);
  addArg(cliArgs, 'lines', args.lines);
  addArg(cliArgs, 'since', args.since);
  addArg(cliArgs, 'follow', args.follow);
  addArg(cliArgs, 'duration-sec', args.durationSec);
  addArg(cliArgs, 'clear', args.clear);
  addArg(cliArgs, 'skip-flutter-launch', args.skipFlutterLaunch);
  return cliArgs;
}

async function runSmoke(args) {
  const cliArgs = [cliScript, 'smoke'];
  addCommonArgs(cliArgs, args);
  addArg(cliArgs, 'out-file', args.outFile);
  addArg(cliArgs, 'artifact-dir', args.artifactDir || defaultArtifactDirFor('smoke', args));
  addArg(cliArgs, 'skip-flutter-launch', args.skipFlutterLaunch);
  return runProcess(cliArgs);
}

function defaultArtifactDirFor(command, args) {
  if (args.outFile) return '';
  if (command !== 'screenshot' && command !== 'smoke') return '';
  return path.join(process.cwd(), 'build', 'ai_app_bridge_artifacts');
}

function addCommonArgs(cliArgs, args) {
  addArg(cliArgs, 'adb', args.adb);
  addArg(cliArgs, 'serial', args.serial);
  addArg(cliArgs, 'port', args.port);
  addArg(cliArgs, 'package-name', args.packageName);
}

function addArg(cliArgs, name, value) {
  if (value === undefined || value === null || value === '' || value === false) {
    return;
  }
  cliArgs.push(`--${name}`, String(value));
}

function addRepeatedArg(cliArgs, name, value) {
  if (Array.isArray(value)) {
    for (const item of value) addArg(cliArgs, name, item);
    return;
  }
  addArg(cliArgs, name, value);
}

function addExtraArgs(cliArgs, value) {
  if (Array.isArray(value)) {
    for (const item of value) addArg(cliArgs, 'extra', item);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, extraValue] of Object.entries(value)) {
      addArg(cliArgs, 'extra', `${key}=${extraValue}`);
    }
    return;
  }
  addArg(cliArgs, 'extra', value);
}

function runProcess(cliArgs) {
  return new Promise((resolve) => {
    const child = spawn(nodeBinary, cliArgs, {
      cwd: bridgeDir,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      resolve(toolText(`failed to start Node bridge CLI: ${error.message}`, true));
    });
    child.on('close', (code) => {
      const text = [
        stdout.trim(),
        stderr.trim() ? `stderr:\n${stderr.trim()}` : '',
        code === 0 ? '' : `exitCode: ${code}`,
        retryWithPackageNameHint(cliArgs, stdout, stderr, code),
      ].filter(Boolean).join('\n\n');
      resolve(toolText(text || emptyProcessText(cliArgs), code !== 0));
    });
  });
}

function emptyProcessText(cliArgs) {
  const command = cliArgs[1] || '';
  if (command === 'logcat' && cliArgs.includes('--app-pid')) {
    return 'logcat: no matching lines for current app pid';
  }
  if (command === 'logcat') {
    return 'logcat: no matching lines';
  }
  return 'ok';
}

function retryWithPackageNameHint(cliArgs, stdout, stderr, code) {
  if (code === 0 || cliArgs.includes('--package-name') || cliArgs.includes('--port')) {
    return '';
  }
  const output = `${stdout}\n${stderr}`;
  if (!/HTTP timeout: http:\/\/127\.0\.0\.1:18080\//.test(output)) {
    return '';
  }
  return 'agentHint: Default bridge port 18080 accepted the connection but did not answer. If you know the target app, retry this tool with packageName so the CLI can discover that app bridge port.';
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
  startServer();
}

module.exports = {
  buildBridgeCliArgs,
  readNextMessage,
  runBatch,
  startServer,
};
