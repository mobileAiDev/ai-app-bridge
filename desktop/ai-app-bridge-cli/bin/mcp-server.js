#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const packageInfo = require('../package.json');
const bridgeDir = __dirname;
const cliScript = path.join(bridgeDir, 'ai-app-bridge.js');
const nodeBinary = process.env.AI_APP_BRIDGE_NODE || process.execPath;

let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drainMessages();
});

process.stdin.on('error', () => {});

function drainMessages() {
  while (true) {
    const delimiter = findHeaderDelimiter(buffer);
    const headerEnd = delimiter.index;
    if (headerEnd < 0) {
      return;
    }
    const header = buffer.subarray(0, headerEnd).toString('utf8');
    const match = /^Content-Length:\s*(\d+)$/im.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + delimiter.length);
      continue;
    }
    const contentLength = Number(match[1]);
    const messageStart = headerEnd + delimiter.length;
    const messageEnd = messageStart + contentLength;
    if (buffer.length < messageEnd) {
      return;
    }
    const body = buffer.subarray(messageStart, messageEnd).toString('utf8');
    buffer = buffer.subarray(messageEnd);
    handleMessage(body).catch((error) => {
      writeLog(`unhandled message error: ${error.stack || error}`);
    });
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
        protocolVersion: message.params?.protocolVersion || '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'ai-app-bridge',
          version: packageInfo.version,
        },
      });
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

function toolDefinitions() {
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
    bridgeTool('input_text', 'Set native Android text through the in-app bridge. Use this for Chinese/Unicode; do not use raw adb shell input text for non-ASCII text.', {
      text: { type: 'string', description: 'Text to set in the focused or coordinate-matched native EditText.' },
      tapX: { type: 'number', description: 'Optional X coordinate used to choose a native EditText target.' },
      tapY: { type: 'number', description: 'Optional Y coordinate used to choose a native EditText target.' },
      hideKeyboard: { type: 'boolean', description: 'Hide the soft keyboard after setting text.' },
    }, ['text']),
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

async function callTool(name, args) {
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
  return runBridge(command, args);
}

async function runBridge(command, args) {
  const cliArgs = [cliScript, command];
  addCommonArgs(cliArgs, args);
  addArg(cliArgs, 'initial-route', args.initialRoute);
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
  addArg(cliArgs, 'no-bodies', args.noBodies);
  addArg(cliArgs, 'duration-ms', args.durationMs);
  addArg(cliArgs, 'include-response-body', args.includeResponseBody);
  addArg(cliArgs, 'body-max-bytes', args.bodyMaxBytes);
  addArg(cliArgs, 'max-events', args.maxEvents);
  addArg(cliArgs, 'keep-forward', args.keepForward);
  addArg(cliArgs, 'key-code', args.keyCode);
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
  return runProcess(cliArgs);
}

async function runSmoke(args) {
  const cliArgs = [cliScript, 'smoke'];
  addCommonArgs(cliArgs, args);
  addArg(cliArgs, 'out-file', args.outFile);
  addArg(cliArgs, 'artifact-dir', args.artifactDir || defaultArtifactDirFor('smoke', args));
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
      resolve(toolText(text || 'ok', code !== 0));
    });
  });
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
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function writeLog(text) {
  process.stderr.write(`${text}\n`);
}

