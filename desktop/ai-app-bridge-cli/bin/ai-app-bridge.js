#!/usr/bin/env node

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const generatedArtifactRetention = 20;

const defaults = {
  adb: process.env.ADB || 'adb',
  adbTimeoutMs: Number(process.env.AI_APP_BRIDGE_ADB_TIMEOUT_MS || 15000),
  serial: '',
  port: 18080,
  packageName: 'io.github.mobileaidev.aiappbridge.sample',
  nativeActivity: '.debugbridge.DebugBridgeNativeTestActivity',
  flutterActivity: '.MainActivity',
};

const helpText = `Usage: ai-app-bridge <command> [options]

Commands:
  status                 Read bridge status and app/device metadata.
  tree                   Read the Android View tree from the in-app bridge.
  uia-tree               Read UIAutomator XML for the current foreground window.
  screenshot             Capture an ADB screenshot.
  logs                   Read generic in-app log records.
  logcat                 Read Android logcat through ADB.
  network                Read generic in-app network records.
  state                  Read generic in-app state records.
  events                 Read generic in-app event records.

H5/WebView commands:
  h5-dom                 Read native Android WebView DOM.
  h5-eval                Execute JavaScript in the current native WebView.
  h5-click               Click a native WebView element.
  h5-input               Set text in a native WebView input.
  h5-wait                Wait for native WebView text or selector.
  h5-scroll              Scroll native WebView content.
  webview-pages          List attachable Android WebView DevTools/CDP pages.
  webview-network        Capture WebView Network events through CDP.
  webview-console        Capture WebView console/log events through CDP.

Flutter commands:
  flutter-tree           Read the latest Flutter layout snapshot.
  flutter-nodes          Read Flutter operable nodes.
  flutter-action         Dispatch a raw Flutter action payload.
  tap-flutter-text       Tap a Flutter node by text.
  input-flutter-text     Set Flutter text through the Flutter action bridge.
  scroll-flutter         Scroll Flutter content.
  flutter-h5-dom         Read DOM through a Flutter H5 adapter.
  flutter-h5-eval        Execute JavaScript through a Flutter H5 adapter.
  flutter-h5-click       Click a Flutter H5 element.
  flutter-h5-input       Set text in a Flutter H5 input.
  flutter-h5-wait        Wait for Flutter H5 text or selector.
  flutter-h5-scroll      Scroll Flutter H5 content.

Device/action commands:
  tap                    Tap device coordinates through ADB.
  tap-text               Tap a visible node by exact text or content description.
  tap-uia-text           Tap a UIAutomator node by text.
  wait-text              Wait until text appears in bridge or UIAutomator output.
  input-text             Set native Android text through the in-app bridge; ASCII can fall back to ADB.
  swipe                  Swipe device coordinates through ADB.
  keyevent               Send an Android keyevent through ADB.
  keyboard-state         Read Android soft keyboard visibility from dumpsys.
  hide-keyboard          Hide the Android soft keyboard when it is visible.

App/permission commands:
  install-apk            Install an APK and assist device-side installer screens.
  clear-app-data         Clear target app local data through the bridge runtime.
  launch-app             Launch the target package LAUNCHER Activity.
  launch-activity        Launch an explicit Android Activity component.
  launch-native-test     Launch the debug native Android bridge test Activity.
  launch-flutter         Launch the Flutter Activity.
  permission-state       Read Android runtime permission state.
  permission-grant       Grant an Android runtime permission.
  permission-revoke      Revoke an Android runtime permission.
  permission-dialog      Tap a visible Android permission dialog allow button.
  appops-set             Set an Android app-op mode.

Advanced commands:
  forward                Create the ADB port forward for the bridge.
  remove-forward         Remove the ADB port forward for the bridge.
  smoke                  Run the native sample smoke test.
  help                   Show this help.

Options:
  --package-name <name>  Target Android package; discovers its bridge port via run-as.
  --port <port>          Override bridge local/device port.
  --serial <serial>      Target a specific ADB device.
  --adb <path>           ADB executable path.
  --adb-timeout-ms <ms>  Timeout for ADB subprocesses.
  --out-file <path>      Screenshot output path.
  --artifact-dir <path>  Directory for generated screenshot/artifact defaults.
  --apk-path <path>      APK path used by install-apk.
  --activity <name>      Activity class for launch-activity or launch-app override.
  --component <pkg/act>  Explicit Android component for launch-activity.
  --action <name>        Intent action for launch-activity.
  --category <name>      Intent category for launch-activity; may be repeated.
  --data <uri>           Intent data URI for launch-activity.
  --extra <key=value>    String intent extra for launch-activity; may be repeated.
  --text <text>          Text used by Unicode-safe bridge input commands.
  --value <text>         Text value used by h5-input or flutter-h5-input.
  --selector <css>       CSS selector used by H5 commands.
  --target-text <text>   Text used by tap-text or wait-text.
  --tap-x <n>            X coordinate used by tap or Flutter input.
  --tap-y <n>            Y coordinate used by tap or Flutter input.
  --start-x <n>          Swipe start X coordinate.
  --start-y <n>          Swipe start Y coordinate.
  --end-x <n>            Swipe end X coordinate.
  --end-y <n>            Swipe end Y coordinate.
  --key-code <n>         Android key code used by keyevent.
  --require-text <text>  Extra text that must be present for wait-text.
  --absent-text <text>   Text that must be absent for wait-text.
  --require-activity <s> Activity substring that must match for wait-text.
  --timeout-sec <n>      Wait timeout for wait-text or H5 waits.
  --interval-ms <ms>     Polling interval for wait/dialog/keyboard helpers.
  --hide-keyboard        Hide the soft keyboard after input-text.
  --no-auto-hide-keyboard Disable keyboard-risk guard before lower-screen taps.
  --allow-downgrade      Pass -d to adb install.
  --install-timeout-ms <ms>  Timeout for the adb install subprocess.
  --installer-timeout-ms <ms>  Timeout for installer UI confirmation handling.
  --webview-port <port>  Local port used for WebView DevTools forwarding.
  --socket-name <name>   Explicit webview_devtools_remote socket name.
  --target-id <id>       Explicit CDP target/page id.
  --page-url-filter <s>  Prefer a WebView page whose URL contains this string.
  --duration-ms <ms>     CDP capture duration. Defaults to 3000 ms.
  --script <js>          JavaScript expression to evaluate after CDP attach.
  --include-response-body  Include response bodies when CDP exposes them.
  --keep-forward         Keep WebView DevTools ADB forward after command exits.
  --url-filter <s>       Keep network records whose URL contains this string.
  --method <s>           Keep network records with this HTTP method.
  --status-code <n>      Keep network records with this HTTP status.
  --no-bodies            Omit requestBody/responseBody from network output.
  --body-max-bytes <n>   Truncate network request/response bodies.
  --since-id <n>         Incremental capture cursor for logs/network/state/events.
  --since-ms <n>         Incremental capture timestamp for logs/network/state/events.
  --limit <n>            Limit capture records.
  --full                 Return full raw status output, including Flutter layout dumps.
  --compact              Return compact tree output for tree/uia-tree.
  --text-filter <s>      Keep compact tree nodes whose text/description contains this.
  --resource-id-filter <s> Keep compact tree nodes whose resource id/name contains this.
  --class-filter <s>     Keep compact tree nodes whose class contains this.
  --visible-only         Keep only visible/in-viewport compact tree nodes.
  --max-nodes <n>        Maximum compact tree nodes to return.
  --max-depth <n>        Maximum compact tree depth to scan.
  --payload <json>       Raw Flutter action payload for flutter-action.
  --initial-route <path> Initial route for launch-flutter.
  --delta <n>            Scroll delta for Flutter/H5 scroll helpers.
  --delta-x <n>          Horizontal scroll delta.
  --delta-y <n>          Vertical scroll delta.
  --max-swipes <n>       Maximum swipes for scroll-flutter by text.
  --permission <name>    Android permission for permission-* commands.
  --op <name>            App-op name for appops-set.
  --mode <mode>          App-op mode for appops-set.
  --pid <pid|current>    PID filter for logcat.
  --app-pid              Filter logcat by current app pid.
  --tag <tag[,tag]>      Logcat tag filter.
  --level <level>        Minimum logcat level.
  --grep <text>          Logcat substring filter.
  --lines <n>            Logcat tail line count.
  --since <time>         Passed to adb logcat -T.
  --follow               Follow live logcat for a bounded duration.
  --clear                Clear logcat before reading.
  --force                Force hide-keyboard dismiss attempts.
  --exact                Use exact text matching where supported.
  --resource-id <id>     Permission dialog resource id.
  --button-text <text>   Permission dialog button text.
  --attempts <n>         Permission dialog tap attempts.
  --streaming            Use streaming APK install.
  --skip-flutter-launch  Skip Flutter launch during smoke.
  --help                 Show this help without touching ADB or the device.`;

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (options.help || command === 'help') {
    process.stdout.write(`${helpText}\n`);
    return;
  }

  const ctx = {
    adb: options.adb || defaults.adb,
    adbTimeoutMs: Number(options.adbTimeoutMs || defaults.adbTimeoutMs),
    serial: options.serial || defaults.serial,
    port: Number(options.port || defaults.port),
    explicitPort: options.port !== undefined,
    packageName: options.packageName || defaults.packageName,
    explicitPackageName: options.packageName !== undefined,
    nativeActivity: options.nativeActivity || defaults.nativeActivity,
    flutterActivity: options.flutterActivity || defaults.flutterActivity,
  };

  const result = await runCommand(command || options.command || 'status', options, ctx);
  if (Buffer.isBuffer(result)) {
    process.stdout.write(result);
    return;
  }
  if (typeof result === 'string') {
    process.stdout.write(result);
    if (!result.endsWith('\n')) process.stdout.write('\n');
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function runCommand(command, options, ctx) {
  switch (command) {
    case 'forward':
      return ensureForward(ctx);
    case 'remove-forward':
      await adb(ctx, ['forward', '--remove', `tcp:${ctx.port}`]);
      return { ok: true, removed: `tcp:${ctx.port}` };
    case 'status':
      return bridgeStatus(ctx, options);
    case 'tree':
      return bridgeTree(ctx, options);
    case 'flutter-tree': {
      const status = await bridgeGet(ctx, '/v1/status');
      return status.flutter?.layout || null;
    }
    case 'flutter-nodes':
      return flutterNodes(ctx);
    case 'tap-flutter-text':
      return flutterAction(ctx, { action: 'tapText', text: requiredString(options.targetText, 'targetText') });
    case 'input-flutter-text': {
      const result = await flutterAction(ctx, {
        action: 'inputText',
        text: requiredString(options.text, 'text'),
        ...(options.tapX !== undefined && options.tapY !== undefined ? { x: Number(options.tapX), y: Number(options.tapY) } : {}),
      });
      if (booleanOption(options.hideKeyboard)) {
        result.keyboard = await hideKeyboard(ctx, options);
      }
      return result;
    }
    case 'scroll-flutter':
      return options.targetText
        ? flutterAction(ctx, { action: 'scrollUntilText', text: options.targetText, maxSwipes: Number(options.maxSwipes || 12) })
        : flutterAction(ctx, { action: 'scrollBy', delta: Number(options.delta || 420) });
    case 'flutter-action':
      return flutterAction(ctx, JSON.parse(requiredString(options.payload, 'payload')));
    case 'logs':
      return bridgeGet(ctx, withQuery('/v1/logs', captureQuery(options)));
    case 'network':
      return networkRecords(ctx, options);
    case 'state':
      return bridgeGet(ctx, withQuery('/v1/state', captureQuery(options)));
    case 'events':
      return bridgeGet(ctx, withQuery('/v1/events', captureQuery(options)));
    case 'h5-dom':
      return bridgeGet(ctx, '/v1/h5/dom');
    case 'h5-eval':
      return bridgePost(ctx, '/v1/h5/eval', { script: requiredString(options.script, 'script') });
    case 'h5-click':
      return h5Click(ctx, options);
    case 'h5-input':
      return h5Input(ctx, options);
    case 'h5-wait':
      return h5Wait(ctx, options);
    case 'h5-scroll':
      return h5Scroll(ctx, options);
    case 'flutter-h5-dom':
      return flutterH5Dom(ctx);
    case 'flutter-h5-eval':
      return flutterH5Eval(ctx, { script: requiredString(options.script, 'script') });
    case 'flutter-h5-click':
      return flutterH5Click(ctx, options);
    case 'flutter-h5-input':
      return flutterH5Input(ctx, options);
    case 'flutter-h5-wait':
      return flutterH5Wait(ctx, options);
    case 'flutter-h5-scroll':
      return flutterH5Scroll(ctx, options);
    case 'uia-tree':
      return uiaTreeCommand(ctx, options);
    case 'screenshot':
      return screenshot(ctx, screenshotOutputPath(options, 'ai_app_bridge_screenshot'), options);
    case 'tap':
      return tap(ctx, requiredNumber(options.tapX, 'tapX'), requiredNumber(options.tapY, 'tapY'));
    case 'tap-text':
      return tapText(ctx, requiredString(options.targetText, 'targetText'), options);
    case 'wait-text':
      return waitText(ctx, requiredString(options.targetText, 'targetText'), options);
    case 'input-text':
      return inputText(ctx, requiredString(options.text, 'text'), options);
    case 'keyboard-state':
      return keyboardState(ctx);
    case 'hide-keyboard':
      return hideKeyboard(ctx, options);
    case 'install-apk':
      return installApk(ctx, options);
    case 'clear-app-data':
      return clearAppData(ctx);
    case 'webview-pages':
      return webviewPages(ctx, options);
    case 'webview-network':
      return webviewCdpCapture(ctx, { ...options, captureNetwork: true, captureConsole: true });
    case 'webview-console':
      return webviewCdpCapture(ctx, { ...options, captureNetwork: false, captureConsole: true });
    case 'swipe':
      return swipe(
        ctx,
        requiredNumber(options.startX, 'startX'),
        requiredNumber(options.startY, 'startY'),
        requiredNumber(options.endX, 'endX'),
        requiredNumber(options.endY, 'endY'),
        Number(options.durationMs || 300),
      );
    case 'keyevent':
      return keyevent(ctx, Number(options.keyCode || 4));
    case 'logcat':
      return logcat(ctx, options);
    case 'permission-state':
      return permissionState(ctx, requiredString(options.permission, 'permission'));
    case 'permission-grant':
      return permissionGrant(ctx, requiredString(options.permission, 'permission'));
    case 'permission-revoke':
      return permissionRevoke(ctx, requiredString(options.permission, 'permission'));
    case 'appops-set':
      return appopsSet(ctx, requiredString(options.op, 'op'), requiredString(options.mode, 'mode'));
    case 'tap-uia-text':
      return tapUiaText(ctx, requiredString(options.targetText, 'targetText'), options);
    case 'permission-dialog':
      return permissionDialog(ctx, options);
    case 'launch-app':
      return launchApp(ctx, options);
    case 'launch-activity':
      return launchActivity(ctx, options);
    case 'launch-native-test':
      return launchNativeTest(ctx);
    case 'launch-flutter':
      return launchFlutter(ctx, options.initialRoute || '');
    case 'smoke':
      return smoke(ctx, options);
    default:
      throw new Error(`unknown command: ${command}`);
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
      continue;
    }
    const rawName = arg.slice(2);
    const name = rawName.replace(/-([a-z])/g, (_, value) => value.toUpperCase());
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
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
  options[name] = value;
}

async function adb(ctx, args, { binary = false } = {}) {
  const allArgs = adbArgs(ctx, args);
  return new Promise((resolve, reject) => {
    execFile(ctx.adb, allArgs, {
      encoding: binary ? 'buffer' : 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: ctx.adbTimeoutMs || defaults.adbTimeoutMs,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed || error.signal) {
          error.message = `adb timed out after ${ctx.adbTimeoutMs || defaults.adbTimeoutMs}ms: ${ctx.adb} ${allArgs.join(' ')}`;
        }
        error.message = `${error.message}\n${stderr || ''}`;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function adbBinaryToFile(ctx, args, outFile) {
  const allArgs = adbArgs(ctx, args);
  await fs.promises.mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(ctx.adb, allArgs, { windowsHide: true });
    const output = fs.createWriteStream(outFile);
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
    }, ctx.adbTimeoutMs || defaults.adbTimeoutMs);
    child.stdout.pipe(output);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timeout);
      output.close(() => {
        if (code !== 0) {
          reject(new Error(`adb failed with exit code ${code}: ${stderr}`));
          return;
        }
        resolve(path.resolve(outFile));
      });
    });
  });
}

function adbArgs(ctx, args) {
  const allArgs = [];
  if (ctx.serial) allArgs.push('-s', ctx.serial);
  allArgs.push(...args);
  return allArgs;
}

async function installApk(ctx, options) {
  const apkPath = path.resolve(requiredString(options.apkPath || options.apk, 'apkPath'));
  if (!fs.existsSync(apkPath)) {
    throw new Error(`apkPath does not exist: ${apkPath}`);
  }

  const packageBefore = await safePackageInstallState(ctx);
  const installMode = packageBefore.known
    ? (packageBefore.installed ? 'reinstall' : 'new_install')
    : 'unknown_without_package_name';
  const installArgs = ['install'];
  if (!booleanOption(options.streaming)) {
    installArgs.push('--no-streaming');
  }
  installArgs.push('-r');
  if (booleanOption(options.allowDowngrade)) {
    installArgs.push('-d');
  }
  installArgs.push(apkPath);

  const installTimeoutMs = Number(options.installTimeoutMs || 180000);
  const installerTimeoutMs = Number(options.installerTimeoutMs || 90000);
  const intervalMs = Number(options.intervalMs || 700);
  const child = spawn(ctx.adb, adbArgs(ctx, installArgs), { windowsHide: true });
  let stdout = '';
  let stderr = '';
  let processDone = false;
  let processResult = null;

  const processPromise = new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      processDone = true;
      processResult = { code: null, error: firstErrorLine(error) };
      resolve(processResult);
    });
    child.on('close', (code, signal) => {
      processDone = true;
      processResult = { code, signal, error: null };
      resolve(processResult);
    });
  });

  const installerActions = [];
  const installDeadline = Date.now() + installTimeoutMs;
  while (!processDone && Date.now() < installDeadline) {
    const action = await installerAssistOnce(ctx, { phase: 'install-pending' });
    if (action.action === 'tap') {
      installerActions.push(action);
    }
    await sleep(intervalMs);
  }

  let timedOut = false;
  if (!processDone) {
    timedOut = true;
    child.kill();
  }

  processResult = processResult || (await processPromise);
  const postInstallActions = await assistInstallerScreens(ctx, {
    phase: 'post-install',
    timeoutMs: installerTimeoutMs,
    intervalMs,
  });
  const packageAfter = await safePackageInstallState(ctx);
  const output = `${stdout}\n${stderr}`.trim();
  const adbSuccess = processResult.code === 0 && /Success/i.test(output);
  const packageVerified = !packageAfter.known || packageAfter.installed;

  return {
    ok: !timedOut && adbSuccess && packageVerified,
    action: 'install-apk',
    transport: 'adb',
    apkPath,
    packageName: ctx.explicitPackageName ? ctx.packageName : null,
    installMode,
    installedBefore: packageBefore,
    installedAfter: packageAfter,
    process: {
      ...processResult,
      timedOut,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    },
    installerActions,
    postInstallActions,
    error: timedOut ? 'install_timeout' : (adbSuccess ? null : 'adb_install_failed'),
  };
}

async function safePackageInstallState(ctx) {
  if (!ctx.explicitPackageName) {
    return { known: false, reason: 'package_name_not_provided' };
  }
  try {
    const result = await adb(ctx, ['shell', 'pm', 'path', ctx.packageName]);
    const paths = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return {
      known: true,
      installed: paths.some((line) => line.startsWith('package:')),
      paths,
    };
  } catch (error) {
    return {
      known: true,
      installed: false,
      error: firstErrorLine(error),
    };
  }
}

async function assistInstallerScreens(ctx, options) {
  const timeoutMs = Number(options.timeoutMs || 90000);
  const intervalMs = Number(options.intervalMs || 700);
  const deadline = Date.now() + timeoutMs;
  const actions = [];
  let quietPolls = 0;
  while (Date.now() < deadline) {
    const action = await installerAssistOnce(ctx, { phase: options.phase || 'installer' });
    if (action.action === 'tap') {
      actions.push(action);
      quietPolls = 0;
      await sleep(intervalMs);
      continue;
    }
    if (action.reason === 'not_installer_surface' || action.reason === 'installer_finish_surface_no_action') {
      quietPolls += 1;
      if (quietPolls >= 2) break;
    }
    await sleep(intervalMs);
  }
  return actions;
}

async function installerAssistOnce(ctx, options = {}) {
  let foreground;
  let xml;
  try {
    foreground = await foregroundWindow(ctx);
    xml = await uiaTree(ctx);
  } catch (error) {
    return {
      ok: false,
      action: 'none',
      phase: options.phase || 'installer',
      reason: 'probe_failed',
      message: firstErrorLine(error),
    };
  }

  const surface = classifyInstallerSurface(foreground, xml);
  if (!surface.installer) {
    return {
      ok: true,
      action: 'none',
      phase: options.phase || 'installer',
      reason: 'not_installer_surface',
      foreground,
      surface,
    };
  }

  if (ctx.explicitPackageName && !surface.finish) {
    const packageState = await safePackageInstallState(ctx);
    if (shouldSkipInstallerTapForInstalledPackage({
      phase: options.phase || 'installer',
      packageState,
    })) {
      return {
        ok: true,
        action: 'none',
        phase: options.phase || 'installer',
        reason: 'target_package_already_installed',
        foreground,
        surface,
        packageState,
      };
    }
  }

  const node = findUiaNodeByAny(xml, {
    texts: installerButtonTextsForSurface(surface),
    exact: true,
    requireClickable: true,
  });
  if (!node) {
    return {
      ok: surface.finish,
      action: 'none',
      phase: options.phase || 'installer',
      reason: surface.finish ? 'installer_finish_surface_no_action' : 'installer_button_not_found',
      foreground,
      surface,
    };
  }

  const x = Math.round((node.left + node.right) / 2);
  const y = Math.round((node.top + node.bottom) / 2);
  await tap(ctx, x, y);
  return {
    ok: true,
    action: 'tap',
    phase: options.phase || 'installer',
    source: 'uiautomator',
    x,
    y,
    foreground,
    surface,
    matched: node.matched,
  };
}

function isLikelyInstallerSurface(foreground, xml) {
  return classifyInstallerSurface(foreground, xml).installer;
}

function classifyInstallerSurface(foreground, xml) {
  const text = String(xml || '');
  const foregroundPackage = String(foreground?.packageName || '');
  const foregroundActivity = String(foreground?.activity || '');
  const marketPackages = [
    'com.heytap.market',
    'com.oppo.market',
    'com.android.vending',
  ];
  const knownInstallerPackages = [
    'com.android.packageinstaller',
    'com.google.android.packageinstaller',
    'com.miui.packageinstaller',
    'com.samsung.android.packageinstaller',
    'com.oplus.appdetail',
    'com.coloros.securitypermission',
    'packageinstaller',
  ];
  const hasInstallerPackage = knownInstallerPackages.some((value) => {
    return foregroundPackage.includes(value) || text.includes(`package="${value}`);
  });
  const hasMarketPackage = marketPackages.some((value) => foregroundPackage.includes(value) || text.includes(`package="${value}`));
  const finish = /finish/i.test(foregroundActivity) ||
    text.includes('安装完成') ||
    text.includes('已安装') ||
    text.includes('Install complete') ||
    text.includes('App installed');
  if (hasInstallerPackage) {
    return {
      installer: true,
      finish,
      market: false,
      source: 'installer_package',
      foregroundPackage,
      foregroundActivity,
    };
  }
  if (hasMarketPackage) {
    return {
      installer: false,
      finish: false,
      market: true,
      source: 'market_package',
      foregroundPackage,
      foregroundActivity,
    };
  }
  const hasRiskKeyword = [
    '检测结果',
    '未知来源',
    '未知应用',
    '敏感权限',
    '安全扫描',
    'Install unknown apps',
    'Package installer',
  ].some((value) => text.includes(value));
  return {
    installer: hasRiskKeyword,
    finish,
    market: false,
    source: hasRiskKeyword ? 'risk_keyword' : 'not_installer',
    foregroundPackage,
    foregroundActivity,
  };
}

function installerButtonTextsForSurface(surface) {
  if (surface?.finish) {
    return [
      '完成',
      '确定',
      'Done',
      'OK',
    ];
  }
  const base = [
    '继续安装',
    '仍然安装',
    '允许',
    '确定',
    '继续',
    '下一步',
    'Continue install',
    'Install anyway',
    'Allow',
    'OK',
    'Continue',
    'Next',
  ];
  if (!surface?.market) {
    base.push('安装', 'Install');
  }
  return base;
}

function defaultInstallerButtonTexts() {
  return installerButtonTextsForSurface({ finish: false, market: false });
}

function shouldSkipInstallerTapForInstalledPackage({ phase, packageState } = {}) {
  if (!packageState?.installed) {
    return false;
  }
  return phase !== 'install-pending';
}

async function ensureForward(ctx) {
  const resolvedPort = await resolveDevicePort(ctx);
  const devicePort = resolvedPort.port;
  const hostPort = ctx.explicitPort ? ctx.port : devicePort;
  ctx.devicePort = devicePort;
  ctx.hostPort = hostPort;
  ctx.devicePortSource = resolvedPort.source;
  ctx.devicePortState = resolvedPort.state;
  ctx.devicePortError = resolvedPort.error;
  await adb(ctx, ['forward', `tcp:${hostPort}`, `tcp:${devicePort}`]);
  return {
    ok: true,
    forward: `tcp:${hostPort} -> device tcp:${devicePort}`,
    hostPort,
    devicePort,
    devicePortSource: resolvedPort.source,
  };
}

async function resolveDevicePort(ctx) {
  if (ctx.explicitPort) return { port: ctx.port, source: 'explicit-port' };
  try {
    const result = await adb(ctx, ['shell', 'run-as', ctx.packageName, 'cat', 'files/ai_app_bridge_port.json']);
    const state = JSON.parse(result.stdout.trim());
    const discoveredPort = Number(state.port);
    if (state.ok === true && Number.isInteger(discoveredPort) && discoveredPort > 0) {
      return { port: discoveredPort, source: 'package-port-file', state };
    }
  } catch (error) {
    if (!shouldUseDefaultPortFallback(ctx)) {
      ctx.devicePortSource = 'package-port-file';
      ctx.devicePortError = firstErrorLine(error);
      error.aiAppBridgePortDiscovery = true;
      throw error;
    }
    return {
      port: ctx.port,
      source: 'default-port',
      error: firstErrorLine(error),
    };
  }
  if (!shouldUseDefaultPortFallback(ctx)) {
    const error = new Error(`bridge port discovery failed for explicit package: ${ctx.packageName}`);
    error.aiAppBridgePortDiscovery = true;
    ctx.devicePortSource = 'package-port-file';
    ctx.devicePortError = firstErrorLine(error);
    throw error;
  }
  return { port: ctx.port, source: 'default-port' };
}

function shouldUseDefaultPortFallback(ctx) {
  return !ctx.explicitPackageName;
}

async function bridgeStatus(ctx, options = {}) {
  try {
    const status = await bridgeGet(ctx, '/v1/status');
    return booleanOption(options.full) ? status : compactStatus(status);
  } catch (error) {
    return buildBridgeFailureResult(ctx, 'status', '/v1/status', error);
  }
}

function compactStatus(status) {
  if (!status || typeof status !== 'object') return status;
  const next = { ...status };
  if (status.flutter && typeof status.flutter === 'object') {
    next.flutter = compactFlutterStatus(status.flutter);
  }
  return next;
}

function compactFlutterStatus(flutterStatus) {
  const next = { ...flutterStatus };
  if (flutterStatus.layout && typeof flutterStatus.layout === 'object') {
    next.layout = compactFlutterLayout(flutterStatus.layout);
  }
  return next;
}

function compactFlutterLayout(layout) {
  return {
    updatedAtMs: layout.updatedAtMs,
    widgetInspector: layout.widgetInspector ? compactDiagnosticTreeNode(layout.widgetInspector) : undefined,
    widgetDump: compactWidgetDump(layout.widgetDump),
    semantics: layout.semantics ? compactSemantics(layout.semantics) : undefined,
    operable: layout.operable ? compactFlutterOperable(layout.operable) : undefined,
  };
}

function compactDiagnosticTreeNode(node) {
  if (!node || typeof node !== 'object') return node;
  return {
    description: shortStatusString(node.description),
    type: shortStatusString(node.type),
    hasChildren: Boolean(node.hasChildren),
    childCount: Array.isArray(node.children) ? node.children.length : undefined,
    createdByLocalProject: Boolean(node.createdByLocalProject),
  };
}

function compactWidgetDump(widgetDump) {
  if (!widgetDump || typeof widgetDump !== 'object') return widgetDump;
  return {
    ok: widgetDump.ok,
    error: widgetDump.error,
    truncated: widgetDump.truncated,
    length: widgetDump.length,
  };
}

function compactSemantics(semantics) {
  if (!semantics || typeof semantics !== 'object') return semantics;
  return {
    ok: semantics.ok,
    error: semantics.error,
    semanticsEnabled: semantics.semanticsEnabled,
    nodeCount: semantics.nodeCount,
  };
}

function compactFlutterOperable(operable) {
  if (!operable || typeof operable !== 'object') return operable;
  return {
    ok: operable.ok,
    error: operable.error,
    count: operable.count,
    visitedCount: operable.visitedCount,
    textCount: operable.textCount,
    actionCount: operable.actionCount,
    sampleWidgetTypes: Array.isArray(operable.sampleWidgetTypes)
      ? operable.sampleWidgetTypes.slice(0, 20)
      : operable.sampleWidgetTypes,
    nodes: Array.isArray(operable.nodes)
      ? operable.nodes.slice(0, 12).map(compactFlutterOperableNode)
      : operable.nodes,
    truncated: operable.truncated,
    viewport: operable.viewport,
    updatedAtMs: operable.updatedAtMs,
  };
}

function compactFlutterOperableNode(node) {
  if (!node || typeof node !== 'object') return node;
  return {
    id: node.id,
    widgetType: shortStatusString(node.widgetType),
    text: shortStatusString(node.text),
    bounds: node.bounds,
    actions: node.actions,
    depth: node.depth,
  };
}

function shortStatusString(value, maxLength = 160) {
  if (value === undefined || value === null) return value;
  const text = String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...[truncated]` : text;
}

function buildBridgeFailureResult(ctx, command, requestPath, error) {
  const normalized = normalizeBridgeError(error);
  return {
    ok: false,
    command,
    requestPath,
    error: normalized.code,
    message: normalized.message,
    packageName: ctx.packageName,
    attempted: {
      host: '127.0.0.1',
      localPort: ctx.hostPort || ctx.port,
      devicePort: ctx.devicePort || ctx.port,
      devicePortSource: ctx.devicePortSource || (ctx.explicitPort ? 'explicit-port' : 'unknown'),
      portState: ctx.devicePortState || null,
      portDiscoveryError: ctx.devicePortError || null,
      url: bridgeUrl(ctx, requestPath),
    },
    suggestion: normalized.suggestion,
  };
}

function normalizeBridgeError(error) {
  const message = firstErrorLine(error);
  const code = error?.code || '';
  const lower = message.toLowerCase();
  if (
    code === 'ECONNRESET' ||
    lower.includes('socket hang up') ||
    lower.includes('connection reset') ||
    lower.includes('http timeout')
  ) {
    return {
      code: 'bridge_not_ready',
      message,
      suggestion: 'Launch the target app, wait for the debug bridge to start, then retry status.',
    };
  }
  if (code === 'ECONNREFUSED' || lower.includes('econnrefused') || lower.includes('connection refused')) {
    return {
      code: 'bridge_connection_refused',
      message,
      suggestion: 'Confirm the target app is running and that the resolved bridge port belongs to this package.',
    };
  }
  if (lower.includes('adb timed out')) {
    return {
      code: 'adb_timeout',
      message,
      suggestion: 'Check the device state and retry; if the bridge port is known, pass --port to skip package port discovery.',
    };
  }
  if (error?.aiAppBridgePackageMismatch || lower.includes('bridge package mismatch')) {
    return {
      code: 'bridge_package_mismatch',
      message,
      suggestion: 'The resolved bridge port belongs to another package. Relaunch the target app and retry with the explicit packageName.',
    };
  }
  if (error?.aiAppBridgePortDiscovery || lower.includes('bridge port discovery failed') || lower.includes('run-as') || lower.includes('package not found')) {
    return {
      code: 'bridge_port_discovery_failed',
      message,
      suggestion: 'Install a debuggable build for the requested package or pass --port explicitly.',
    };
  }
  if (lower.includes('adb forward')) {
    return {
      code: 'bridge_forward_failed',
      message,
      suggestion: 'Remove stale adb forwards or pass a different --port for this target package.',
    };
  }
  return {
    code: 'bridge_request_failed',
    message,
    suggestion: 'Check that the device is connected, the target package is installed, and the app is foreground or recently launched.',
  };
}

function firstErrorLine(error) {
  return String(error?.message || error || 'unknown_error').split(/\r?\n/).find(Boolean) || 'unknown_error';
}

async function bridgeGet(ctx, requestPath) {
  await ensureForward(ctx);
  const body = await httpGet(bridgeUrl(ctx, requestPath));
  const payload = JSON.parse(body);
  verifyBridgeTargetPackage(ctx, payload, requestPath);
  return payload;
}

async function bridgePost(ctx, requestPath, payload) {
  await ensureForward(ctx);
  const body = await httpPost(bridgeUrl(ctx, requestPath), payload);
  const responsePayload = JSON.parse(body);
  verifyBridgeTargetPackage(ctx, responsePayload, requestPath);
  return responsePayload;
}

function bridgeUrl(ctx, requestPath) {
  return `http://127.0.0.1:${ctx.hostPort || ctx.port}${requestPath}`;
}

function verifyBridgeTargetPackage(ctx, payload, requestPath) {
  if (!ctx.explicitPackageName || !payload || typeof payload !== 'object') return;
  const responsePackageName = payload.app && typeof payload.app === 'object'
    ? payload.app.packageName
    : undefined;
  if (!responsePackageName || responsePackageName === ctx.packageName) return;
  const error = new Error(`bridge package mismatch for ${requestPath}: expected ${ctx.packageName}, got ${responsePackageName}`);
  error.aiAppBridgePackageMismatch = true;
  error.expectedPackageName = ctx.packageName;
  error.actualPackageName = responsePackageName;
  throw error;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 10000 }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}: ${data}`));
          return;
        }
        resolve(data);
      });
    });
    request.on('timeout', () => {
      request.destroy(new Error(`HTTP timeout: ${url}`));
    });
    request.on('error', (error) => {
      error.url = url;
      reject(error);
    });
  });
}

function httpPost(url, payload) {
  const body = JSON.stringify(payload || {});
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: 'POST',
      timeout: 20000,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}: ${data}`));
          return;
        }
        resolve(data);
      });
    });
    request.on('timeout', () => {
      request.destroy(new Error(`HTTP timeout: ${url}`));
    });
    request.on('error', (error) => {
      error.url = url;
      reject(error);
    });
    request.write(body);
    request.end();
  });
}

function captureQuery(options) {
  return {
    sinceId: options.sinceId,
    sinceMs: options.sinceMs,
    limit: options.limit,
  };
}

async function networkRecords(ctx, options = {}) {
  const capture = await bridgeGet(ctx, withQuery('/v1/network', captureQuery(options)));
  return shapeNetworkCapture(capture, options);
}

function shapeNetworkCapture(capture, options = {}) {
  const sourceItems = Array.isArray(capture?.items) ? capture.items : [];
  const filteredItems = sourceItems.filter((item) => networkRecordMatches(item, options));
  const compact = booleanOption(options.compact);
  const shapedItems = filteredItems.map((item) => (
    compact ? compactNetworkRecord(item) : shapeNetworkRecord(item, options)
  ));
  const result = {
    ...capture,
    count: shapedItems.length,
    items: shapedItems,
  };
  if (filteredItems.length !== sourceItems.length) {
    result.sourceCount = sourceItems.length;
  }
  const filters = networkResultOptions(options);
  if (Object.keys(filters).length > 0) {
    result.options = filters;
  }
  return result;
}

function networkRecordMatches(record, options = {}) {
  const urlFilter = options.urlFilter ? String(options.urlFilter) : '';
  if (urlFilter && !networkRecordUrl(record).includes(urlFilter)) {
    return false;
  }

  const method = options.method ? String(options.method).toUpperCase() : '';
  if (method && networkRecordMethod(record).toUpperCase() !== method) {
    return false;
  }

  if (options.statusCode !== undefined && options.statusCode !== null && options.statusCode !== '') {
    const expectedStatus = Number(options.statusCode);
    if (!Number.isFinite(expectedStatus) || Number(networkRecordStatus(record)) !== expectedStatus) {
      return false;
    }
  }

  return true;
}

function shapeNetworkRecord(record, options = {}) {
  const shaped = { ...record };
  const noBodies = booleanOption(options.noBodies);
  for (const key of ['requestBody', 'responseBody']) {
    if (!Object.prototype.hasOwnProperty.call(shaped, key)) {
      continue;
    }
    if (noBodies) {
      shaped[`${key}Omitted`] = true;
      delete shaped[key];
      continue;
    }
    const bodyMaxBytes = positiveNumber(options.bodyMaxBytes);
    if (bodyMaxBytes !== null) {
      shaped[key] = truncateString(shaped[key], bodyMaxBytes);
    }
  }
  return shaped;
}

function compactNetworkRecord(record) {
  const result = {
    id: record?.id,
    timestampMs: record?.timestampMs,
    source: record?.source,
    method: networkRecordMethod(record),
    url: networkRecordUrl(record),
    statusCode: networkRecordStatus(record),
    durationMs: record?.durationMs,
    error: record?.error || undefined,
    redacted: record?.redacted,
  };
  const contentType = networkRecordContentType(record);
  if (contentType) {
    result.contentType = contentType;
  }
  if (Object.prototype.hasOwnProperty.call(record || {}, 'requestBody')) {
    result.requestBodyBytes = bodyByteLength(record.requestBody);
  }
  if (Object.prototype.hasOwnProperty.call(record || {}, 'responseBody')) {
    result.responseBodyBytes = bodyByteLength(record.responseBody);
  }
  return pruneUndefined(result);
}

function networkResultOptions(options = {}) {
  const result = {};
  if (booleanOption(options.compact)) result.compact = true;
  if (options.urlFilter) result.urlFilter = String(options.urlFilter);
  if (options.method) result.method = String(options.method).toUpperCase();
  if (options.statusCode !== undefined && options.statusCode !== null && options.statusCode !== '') {
    result.statusCode = Number(options.statusCode);
  }
  if (booleanOption(options.noBodies)) result.noBodies = true;
  if (positiveNumber(options.bodyMaxBytes) !== null) result.bodyMaxBytes = positiveNumber(options.bodyMaxBytes);
  return result;
}

function networkRecordUrl(record) {
  return String(record?.url || record?.requestUrl || record?.responseUrl || record?.response?.url || '');
}

function networkRecordMethod(record) {
  return String(record?.method || record?.requestMethod || record?.request?.method || '');
}

function networkRecordStatus(record) {
  return record?.statusCode ?? record?.responseStatusCode ?? record?.status ?? record?.response?.statusCode;
}

function networkRecordContentType(record) {
  return headerValue(record?.responseHeaders, 'content-type') ||
    headerValue(record?.requestHeaders, 'content-type') ||
    '';
}

function headerValue(headers, key) {
  if (!headers || typeof headers !== 'object') {
    return '';
  }
  const expected = key.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (String(name).toLowerCase() === expected) {
      return String(value);
    }
  }
  return '';
}

function bodyByteLength(value) {
  if (value === undefined || value === null) {
    return 0;
  }
  return Buffer.byteLength(String(value), 'utf8');
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function pruneUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function withQuery(requestPath, query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    params.set(key, String(value));
  }
  const queryString = params.toString();
  return queryString ? `${requestPath}?${queryString}` : requestPath;
}

async function webviewPages(ctx, options) {
  const setup = await setupWebViewDevTools(ctx, options, { selectPage: false });
  const keepForward = booleanOption(options.keepForward);
  if (!keepForward) {
    await setup.cleanup();
  }
  return {
    ok: true,
    transport: 'webview-devtools-cdp',
    packageName: ctx.packageName,
    sockets: setup.sockets,
    selectedSocket: setup.socket,
    packagePids: setup.packagePids,
    forward: {
      localPort: setup.localPort,
      socketName: setup.socket.name,
      active: keepForward,
    },
    pages: setup.pages,
    pageCount: setup.pages.length,
    selectionWarning: setup.selectionWarning || null,
  };
}

async function webviewCdpCapture(ctx, options) {
  const setup = await setupWebViewDevTools(ctx, options, { selectPage: true });
  const durationMs = Math.max(0, Number(options.durationMs || 3000));
  const captureNetwork = options.captureNetwork !== false;
  const captureConsole = options.captureConsole !== false;
  const includeResponseBody = booleanOption(options.includeResponseBody);
  const maxEvents = Number(options.maxEvents || 200);
  const bodyMaxBytes = Number(options.bodyMaxBytes || 64 * 1024);
  const urlFilter = options.urlFilter || '';
  const events = [];
  const requests = new Map();
  const consoleEvents = [];
  let scriptResult = null;
  let cdp = null;

  const handleEvent = (event) => {
    if (events.length < maxEvents) {
      events.push({
        method: event.method,
        params: summarizeCdpParams(event.method, event.params),
      });
    }
    if (captureNetwork && event.method === 'Network.requestWillBeSent') {
      const request = event.params?.request || {};
      if (urlFilter && !String(request.url || '').includes(urlFilter)) return;
      const entry = requests.get(event.params.requestId) || {};
      requests.set(event.params.requestId, {
        ...entry,
        requestId: event.params.requestId,
        loaderId: event.params.loaderId,
        documentURL: event.params.documentURL,
        type: event.params.type,
        timestamp: event.params.timestamp,
        wallTime: event.params.wallTime,
        method: request.method,
        url: request.url,
        requestHeaders: request.headers || {},
        requestPostData: truncateString(request.postData || '', bodyMaxBytes),
      });
      return;
    }
    if (captureNetwork && event.method === 'Network.responseReceived') {
      const response = event.params?.response || {};
      if (urlFilter && !String(response.url || '').includes(urlFilter)) return;
      const entry = requests.get(event.params.requestId) || {};
      requests.set(event.params.requestId, {
        ...entry,
        requestId: event.params.requestId,
        type: event.params.type || entry.type,
        status: response.status,
        statusText: response.statusText,
        responseUrl: response.url,
        mimeType: response.mimeType,
        protocol: response.protocol,
        remoteIPAddress: response.remoteIPAddress,
        remotePort: response.remotePort,
        responseHeaders: response.headers || {},
      });
      return;
    }
    if (captureNetwork && event.method === 'Network.responseReceivedExtraInfo') {
      const entry = requests.get(event.params.requestId) || {};
      if (urlFilter && !String(entry.url || entry.responseUrl || '').includes(urlFilter)) return;
      requests.set(event.params.requestId, {
        ...entry,
        requestId: event.params.requestId,
        status: entry.status ?? event.params.statusCode,
        responseHeaders: {
          ...(entry.responseHeaders || {}),
          ...(event.params.headers || {}),
        },
        responseHeadersText: event.params.headersText,
        resourceIPAddressSpace: event.params.resourceIPAddressSpace,
      });
      return;
    }
    if (captureNetwork && event.method === 'Network.loadingFinished') {
      const entry = requests.get(event.params.requestId) || {};
      requests.set(event.params.requestId, {
        ...entry,
        requestId: event.params.requestId,
        encodedDataLength: event.params.encodedDataLength,
        finished: true,
      });
      return;
    }
    if (captureNetwork && event.method === 'Network.loadingFailed') {
      const entry = requests.get(event.params.requestId) || {};
      requests.set(event.params.requestId, {
        ...entry,
        requestId: event.params.requestId,
        failed: true,
        errorText: event.params.errorText,
        canceled: event.params.canceled,
        blockedReason: event.params.blockedReason,
        corsErrorStatus: event.params.corsErrorStatus,
      });
      return;
    }
    if (captureConsole && event.method === 'Runtime.consoleAPICalled') {
      consoleEvents.push({
        type: event.params?.type,
        timestamp: event.params?.timestamp,
        args: (event.params?.args || []).map(cdpRemoteValue),
        stackTrace: event.params?.stackTrace || null,
      });
      return;
    }
    if (captureConsole && event.method === 'Log.entryAdded') {
      const entry = event.params?.entry || {};
      consoleEvents.push({
        source: entry.source,
        level: entry.level,
        text: entry.text,
        url: entry.url,
        lineNumber: entry.lineNumber,
        timestamp: entry.timestamp,
      });
    }
  };

  try {
    cdp = await CdpSession.open(setup.page.webSocketDebuggerUrl);
    cdp.onEvent(handleEvent);
    if (captureNetwork) {
      await cdp.send('Network.enable');
    }
    if (captureConsole) {
      await cdp.send('Runtime.enable');
      await cdp.send('Log.enable').catch(() => null);
    }
    if (options.script) {
      scriptResult = await cdp.send('Runtime.evaluate', {
        expression: String(options.script),
        awaitPromise: true,
        returnByValue: true,
      });
    }
    await sleep(durationMs);
    if (includeResponseBody && captureNetwork) {
      for (const entry of requests.values()) {
        if (entry.status === undefined || entry.failed) continue;
        try {
          const body = await cdp.send('Network.getResponseBody', { requestId: entry.requestId }, 2500);
          entry.responseBody = truncateString(body.body || '', bodyMaxBytes);
          entry.base64Encoded = Boolean(body.base64Encoded);
        } catch (error) {
          entry.responseBodyError = firstErrorLine(error);
        }
      }
    }
  } finally {
    if (cdp) cdp.close();
    await setup.cleanup();
  }

  const requestItems = Array.from(requests.values());
  return {
    ok: true,
    transport: 'webview-devtools-cdp',
    packageName: ctx.packageName,
    socket: setup.socket,
    packagePids: setup.packagePids,
    page: setup.page,
    durationMs,
    captureNetwork,
    captureConsole,
    scriptResult: normalizeRuntimeEvaluateResult(scriptResult),
    counts: {
      events: events.length,
      requests: requestItems.length,
      console: consoleEvents.length,
    },
    requests: requestItems,
    console: consoleEvents,
    events,
    selectionWarning: setup.selectionWarning || null,
  };
}

async function setupWebViewDevTools(ctx, options, behavior = {}) {
  const packagePids = await packagePidsFor(ctx);
  const procNetUnix = (await adb(ctx, ['shell', 'cat', '/proc/net/unix'])).stdout;
  const sockets = parseWebViewDevToolsSockets(procNetUnix, packagePids);
  if (sockets.length === 0) {
    throw new Error('no WebView DevTools socket found; make sure the app is running and WebView debugging is enabled');
  }
  const choice = chooseWebViewDevToolsSocket(sockets, options, packagePids);
  if (!choice.socket) {
    throw new Error(choice.error || 'no matching WebView DevTools socket found');
  }
  const localPort = await resolveWebViewDevToolsPort(ctx, options);
  await removeAdbForwardIfPresent(ctx, localPort);
  await adb(ctx, ['forward', `tcp:${localPort}`, `localabstract:${choice.socket.name}`]);
  let pages = [];
  try {
    pages = JSON.parse(await httpGet(`http://127.0.0.1:${localPort}/json`));
    if (!Array.isArray(pages)) pages = [];
    pages = pages.map((page) => normalizeCdpPage(page, localPort));
  } catch (error) {
    await removeAdbForwardIfPresent(ctx, localPort);
    throw error;
  }
  const page = behavior.selectPage === false ? null : chooseWebViewPage(pages, options);
  if (behavior.selectPage !== false && !page) {
    await removeAdbForwardIfPresent(ctx, localPort);
    throw new Error('no attachable WebView CDP page found');
  }
  return {
    sockets,
    socket: choice.socket,
    packagePids,
    selectionWarning: choice.warning,
    localPort,
    pages,
    page,
    cleanup: () => removeAdbForwardIfPresent(ctx, localPort),
  };
}

async function packagePidsFor(ctx) {
  if (!ctx.packageName) return [];
  try {
    const result = await adb(ctx, ['shell', 'pidof', ctx.packageName]);
    return result.stdout.split(/\s+/).map((value) => value.trim()).filter((value) => /^\d+$/.test(value));
  } catch (_) {
    return [];
  }
}

function parseWebViewDevToolsSockets(procNetUnix, packagePids = []) {
  const packagePidSet = new Set(packagePids.map(String));
  const sockets = [];
  const seen = new Set();
  const lines = String(procNetUnix || '').split(/\r?\n/);
  for (const line of lines) {
    const matches = line.matchAll(/(?:^|\s|@)(webview_devtools_remote(?:_[^\s@]+)?)/g);
    for (const match of matches) {
      const name = match[1];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const pidMatch = /_(\d+)$/.exec(name);
      const pid = pidMatch ? pidMatch[1] : null;
      sockets.push({
        name,
        rawName: match[0].trim(),
        pid,
        packageMatch: Boolean(pid && packagePidSet.has(pid)),
        line: line.trim(),
      });
    }
  }
  return sockets;
}

function chooseWebViewDevToolsSocket(sockets, options = {}, packagePids = []) {
  if (options.socketName) {
    const requested = String(options.socketName).replace(/^@/, '');
    const socket = sockets.find((item) => item.name === requested);
    return socket ? { socket } : { error: `requested WebView DevTools socket not found: ${requested}` };
  }
  for (const pid of packagePids.map(String)) {
    const socket = sockets.find((item) => item.pid === pid);
    if (socket) return { socket };
  }
  const matched = sockets.filter((item) => item.packageMatch);
  if (matched.length > 0) return { socket: matched[0] };
  if (sockets.length === 1) return { socket: sockets[0] };
  return {
    socket: sockets[0],
    warning: `multiple WebView DevTools sockets found and none matched ${packagePids.join(',') || 'the target package pid'}; selected ${sockets[0].name}`,
  };
}

function chooseWebViewPage(pages, options = {}) {
  if (!Array.isArray(pages) || pages.length === 0) return null;
  if (options.targetId) {
    const targetId = String(options.targetId);
    const byId = pages.find((page) => page.id === targetId);
    if (byId) return byId;
  }
  if (options.pageUrlFilter) {
    const filter = String(options.pageUrlFilter);
    const byUrl = pages.find((page) => String(page.url || '').includes(filter));
    if (byUrl) return byUrl;
  }
  return pages.find((page) => page.webSocketDebuggerUrl && page.type === 'page') ||
    pages.find((page) => page.webSocketDebuggerUrl) ||
    null;
}

function normalizeCdpPage(page, localPort) {
  const normalized = {
    id: page.id,
    type: page.type,
    title: page.title,
    url: page.url,
    description: page.description,
    webSocketDebuggerUrl: page.webSocketDebuggerUrl,
  };
  if (normalized.webSocketDebuggerUrl) {
    normalized.webSocketDebuggerUrl = normalized.webSocketDebuggerUrl.replace(
      /^ws:\/\/(?:\[::\]|localhost|127\.0\.0\.1):\d+/,
      `ws://127.0.0.1:${localPort}`,
    );
  }
  return normalized;
}

async function resolveWebViewDevToolsPort(ctx, options) {
  const explicit = Number(options.webviewPort || options.devtoolsPort || options.cdpPort || 0);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const start = 9222;
  for (let port = start; port < start + 100; port += 1) {
    await removeAdbForwardIfPresent(ctx, port);
    if (await isLocalPortAvailable(port)) return port;
  }
  throw new Error('no available local port for WebView DevTools forwarding');
}

function isLocalPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function removeAdbForwardIfPresent(ctx, port) {
  try {
    await adb(ctx, ['forward', '--remove', `tcp:${port}`]);
  } catch (_) {
    // A missing forward is the common case.
  }
}

class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = [];
  }

  static async open(url) {
    const WebSocketCtor = webSocketConstructor();
    const socket = new WebSocketCtor(url);
    await waitForWebSocketOpen(socket, url);
    const session = new CdpSession(socket);
    addWebSocketMessageHandler(socket, (data) => {
      webSocketDataToText(data)
        .then((text) => session.handleMessage(text))
        .catch(() => null);
    });
    addWebSocketCloseHandler(socket, () => session.rejectAll(new Error('CDP WebSocket closed')));
    return session;
  }

  onEvent(handler) {
    this.eventHandlers.push(handler);
  }

  send(method, params = {}, timeoutMs = 5000) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(payload);
    });
  }

  handleMessage(text) {
    const message = JSON.parse(text);
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`CDP ${pending.method} failed: ${message.error.message || JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }
    if (message.method) {
      for (const handler of this.eventHandlers) {
        handler(message);
      }
    }
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  close() {
    try {
      this.socket.close();
    } catch (_) {
      // Ignore close races.
    }
  }
}

function webSocketConstructor() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  try {
    return require('ws');
  } catch (_) {
    throw new Error('WebView CDP capture requires Node.js with WebSocket support or the ws package');
  }
}

function waitForWebSocketOpen(socket, url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP WebSocket open timeout: ${url}`)), 10000);
    const done = (error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('open', () => done(), { once: true });
      socket.addEventListener('error', () => done(new Error(`CDP WebSocket error: ${url}`)), { once: true });
      return;
    }
    socket.once('open', () => done());
    socket.once('error', (error) => done(error));
  });
}

function addWebSocketMessageHandler(socket, handler) {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener('message', (event) => handler(event.data));
    return;
  }
  socket.on('message', handler);
}

function addWebSocketCloseHandler(socket, handler) {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener('close', handler);
    return;
  }
  socket.on('close', handler);
}

async function webSocketDataToText(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  if (data && typeof data.text === 'function') return data.text();
  return String(data);
}

function cdpRemoteValue(value) {
  if (!value || typeof value !== 'object') return value;
  if (Object.prototype.hasOwnProperty.call(value, 'value')) return value.value;
  if (Object.prototype.hasOwnProperty.call(value, 'unserializableValue')) return value.unserializableValue;
  return value.description || value.type || null;
}

function normalizeRuntimeEvaluateResult(result) {
  if (!result) return null;
  return {
    result: cdpRemoteValue(result.result),
    exceptionDetails: result.exceptionDetails || null,
  };
}

function summarizeCdpParams(method, params) {
  if (!params || typeof params !== 'object') return params;
  if (method === 'Network.requestWillBeSent') {
    return {
      requestId: params.requestId,
      type: params.type,
      documentURL: params.documentURL,
      request: {
        method: params.request?.method,
        url: params.request?.url,
      },
    };
  }
  if (method === 'Network.responseReceived') {
    return {
      requestId: params.requestId,
      type: params.type,
      response: {
        url: params.response?.url,
        status: params.response?.status,
        mimeType: params.response?.mimeType,
      },
    };
  }
  if (method === 'Network.responseReceivedExtraInfo') {
    return {
      requestId: params.requestId,
      statusCode: params.statusCode,
      resourceIPAddressSpace: params.resourceIPAddressSpace,
    };
  }
  if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    return {
      requestId: params.requestId,
      encodedDataLength: params.encodedDataLength,
      errorText: params.errorText,
      blockedReason: params.blockedReason,
    };
  }
  if (method === 'Runtime.consoleAPICalled') {
    return {
      type: params.type,
      args: (params.args || []).map(cdpRemoteValue),
    };
  }
  if (method === 'Log.entryAdded') {
    return params.entry || {};
  }
  return params;
}

function truncateString(value, maxBytes) {
  const text = String(value || '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  return `${Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')}...[truncated]`;
}

async function uiaTree(ctx) {
  const remotePath = '/sdcard/ai_app_window.xml';
  return withFileLock(uiautomatorLockPath(ctx), async () => retry(async () => {
    await adb(ctx, ['shell', 'uiautomator', 'dump', remotePath]);
    return (await adb(ctx, ['exec-out', 'cat', remotePath])).stdout;
  }, 4, 500), {
    timeoutMs: Number(process.env.AI_APP_BRIDGE_UIA_LOCK_TIMEOUT_MS || 30000),
    staleMs: Number(process.env.AI_APP_BRIDGE_UIA_LOCK_STALE_MS || 120000),
  });
}

async function bridgeTree(ctx, options = {}) {
  const tree = await bridgeGet(ctx, '/v1/view/tree');
  return wantsCompactTree(options) ? compactBridgeTree(tree, options) : tree;
}

async function uiaTreeCommand(ctx, options = {}) {
  const xml = await uiaTree(ctx);
  return wantsCompactTree(options) ? compactUiaTree(xml, options) : xml;
}

function wantsCompactTree(options = {}) {
  return Boolean(
    booleanOption(options.compact) ||
    options.textFilter ||
    options.resourceIdFilter ||
    options.classFilter ||
    options.visibleOnly ||
    options.maxNodes ||
    options.maxDepth,
  );
}

function compactTreeOptions(options = {}) {
  return {
    textFilter: normalizeFilter(options.textFilter || options.targetText),
    resourceIdFilter: normalizeFilter(options.resourceIdFilter || options.resourceFilter),
    classFilter: normalizeFilter(options.classFilter),
    visibleOnly: booleanOption(options.visibleOnly),
    maxNodes: boundedInteger(options.maxNodes, 80, 1, 1000),
    maxDepth: boundedInteger(options.maxDepth, Number.POSITIVE_INFINITY, 0, 200),
  };
}

function compactBridgeTree(tree, options = {}) {
  const compactOptions = compactTreeOptions(options);
  const result = {
    ok: true,
    source: 'bridge-tree',
    compact: true,
    activity: tree?.activity || null,
    windowCount: Array.isArray(tree?.windows) ? tree.windows.length : undefined,
    originalNodeCount: Number.isFinite(Number(tree?.nodeCount)) ? Number(tree.nodeCount) : undefined,
    options: compactTreeResultOptions(compactOptions),
    nodes: [],
    scannedNodes: 0,
    matchedNodes: 0,
    truncated: false,
    updatedAtMs: tree?.updatedAtMs || Date.now(),
  };

  const roots = [];
  if (Array.isArray(tree?.windows)) {
    tree.windows.forEach((windowInfo, index) => {
      if (windowInfo?.root) {
        roots.push({
          root: windowInfo.root,
          windowType: windowInfo.type || 'window',
          windowIndex: index,
          viewport: windowInfo.bounds || windowInfo.root.bounds || null,
        });
      }
    });
  }
  if (tree?.root) {
    roots.push({
      root: tree.root,
      windowType: 'root',
      windowIndex: null,
      viewport: tree.root.bounds || null,
    });
  }

  for (const rootInfo of roots) {
    visitBridgeTreeNode(rootInfo.root, {
      result,
      options: compactOptions,
      depth: 0,
      parentPath: '',
      rootInfo,
    });
    if (result.truncated) break;
  }

  return result;
}

function visitBridgeTreeNode(node, state) {
  if (!node || state.result.truncated) return;
  state.result.scannedNodes += 1;

  const children = Array.isArray(node.children) ? node.children : [];
  const path = state.parentPath ? `${state.parentPath}.${state.result.scannedNodes}` : String(state.result.scannedNodes);
  if (state.depth <= state.options.maxDepth && bridgeNodeMatchesCompactFilters(node, state.options, state.rootInfo.viewport)) {
    state.result.matchedNodes += 1;
    if (state.result.nodes.length >= state.options.maxNodes) {
      state.result.truncated = true;
      return;
    }
    state.result.nodes.push(compactBridgeNode(node, {
      depth: state.depth,
      path,
      childCount: children.length,
      windowType: state.rootInfo.windowType,
      windowIndex: state.rootInfo.windowIndex,
    }));
  }

  if (state.depth >= state.options.maxDepth) return;
  for (const child of children) {
    visitBridgeTreeNode(child, {
      ...state,
      depth: state.depth + 1,
      parentPath: path,
    });
    if (state.result.truncated) return;
  }
}

function bridgeNodeMatchesCompactFilters(node, options, viewport) {
  if (options.visibleOnly && nodeTapState(node, viewport).ok !== true) return false;
  const text = compactString(node.text || node.contentDescription || '');
  const resource = compactString(node.resourceName || node.id || '');
  const className = compactString(node.className || node.simpleClassName || '');
  return compactFiltersMatch({ text, resource, className }, options);
}

function compactBridgeNode(node, extra) {
  return {
    depth: extra.depth,
    path: extra.path,
    windowType: extra.windowType,
    windowIndex: extra.windowIndex,
    className: node.simpleClassName || node.className || '',
    resourceName: node.resourceName || null,
    text: node.text || null,
    contentDescription: node.contentDescription || null,
    visible: node.visible !== false && node.effectiveVisible !== false,
    enabled: node.enabled !== false,
    clickable: Boolean(node.clickable),
    focusable: Boolean(node.focusable),
    focused: Boolean(node.focused),
    selected: Boolean(node.selected),
    bounds: compactBounds(node.bounds),
    childCount: extra.childCount,
  };
}

function compactUiaTree(xml, options = {}) {
  const compactOptions = compactTreeOptions(options);
  const text = String(xml || '');
  const viewport = parseUiaViewport(text);
  const result = {
    ok: true,
    source: 'uiautomator',
    compact: true,
    rawBytes: Buffer.byteLength(text, 'utf8'),
    viewport,
    options: compactTreeResultOptions(compactOptions),
    nodes: [],
    scannedNodes: 0,
    matchedNodes: 0,
    truncated: false,
    updatedAtMs: Date.now(),
  };

  const tokenRegex = /<\/node>|<node\b[^>]*\/?>/g;
  let depth = -1;
  let token;
  while ((token = tokenRegex.exec(text)) !== null) {
    const tag = token[0];
    if (tag.startsWith('</node')) {
      depth = Math.max(-1, depth - 1);
      continue;
    }

    depth += 1;
    result.scannedNodes += 1;
    const attrs = parseXmlAttributes(tag);
    const node = compactUiaNode(attrs, depth, result.scannedNodes);
    if (depth <= compactOptions.maxDepth && uiaNodeMatchesCompactFilters(node, compactOptions, viewport)) {
      result.matchedNodes += 1;
      if (result.nodes.length >= compactOptions.maxNodes) {
        result.truncated = true;
        break;
      }
      result.nodes.push(node);
    }
    if (tag.endsWith('/>')) {
      depth = Math.max(-1, depth - 1);
    }
  }

  return result;
}

function compactUiaNode(attrs, depth, sequence) {
  return {
    depth,
    sequence,
    className: attrs.class || '',
    resourceId: attrs['resource-id'] || null,
    text: attrs.text || null,
    contentDescription: attrs['content-desc'] || null,
    packageName: attrs.package || null,
    enabled: attrs.enabled !== 'false',
    clickable: attrs.clickable === 'true',
    focusable: attrs.focusable === 'true',
    focused: attrs.focused === 'true',
    selected: attrs.selected === 'true',
    scrollable: attrs.scrollable === 'true',
    checked: attrs.checked === 'true',
    bounds: compactBounds(parseUiaBounds(attrs.bounds)),
  };
}

function uiaNodeMatchesCompactFilters(node, options, viewport) {
  if (options.visibleOnly && !boundsInViewport(node.bounds, viewport)) return false;
  return compactFiltersMatch({
    text: compactString(node.text || node.contentDescription || ''),
    resource: compactString(node.resourceId || ''),
    className: compactString(node.className || ''),
  }, options);
}

function compactFiltersMatch(values, options) {
  if (options.textFilter && !values.text.includes(options.textFilter)) return false;
  if (options.resourceIdFilter && !values.resource.includes(options.resourceIdFilter)) return false;
  if (options.classFilter && !values.className.includes(options.classFilter)) return false;
  return true;
}

function compactTreeResultOptions(options) {
  return {
    textFilter: options.textFilter || undefined,
    resourceIdFilter: options.resourceIdFilter || undefined,
    classFilter: options.classFilter || undefined,
    visibleOnly: options.visibleOnly || undefined,
    maxNodes: options.maxNodes,
    maxDepth: Number.isFinite(options.maxDepth) ? options.maxDepth : undefined,
  };
}

function parseXmlAttributes(tag) {
  const attrs = {};
  const attrRegex = /([A-Za-z0-9_:-]+)="([^"]*)"/g;
  let match;
  while ((match = attrRegex.exec(String(tag || ''))) !== null) {
    attrs[match[1]] = decodeXmlAttribute(match[2]);
  }
  return attrs;
}

function decodeXmlAttribute(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseUiaBounds(value) {
  const match = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(String(value || ''));
  if (!match) return null;
  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function boundsInViewport(bounds, viewport) {
  if (!bounds) return false;
  const width = Number(bounds.width ?? bounds.right - bounds.left);
  const height = Number(bounds.height ?? bounds.bottom - bounds.top);
  if (width <= 0 || height <= 0) return false;
  if (!viewport) return true;
  const centerX = (Number(bounds.left) + Number(bounds.right)) / 2;
  const centerY = (Number(bounds.top) + Number(bounds.bottom)) / 2;
  return centerX >= Number(viewport.left) &&
    centerX <= Number(viewport.right) &&
    centerY >= Number(viewport.top) &&
    centerY <= Number(viewport.bottom);
}

function compactBounds(bounds) {
  if (!bounds) return null;
  return {
    left: Number(bounds.left),
    top: Number(bounds.top),
    right: Number(bounds.right),
    bottom: Number(bounds.bottom),
    width: Number(bounds.width ?? bounds.right - bounds.left),
    height: Number(bounds.height ?? bounds.bottom - bounds.top),
  };
}

function normalizeFilter(value) {
  return String(value || '').trim().toLowerCase();
}

function compactString(value) {
  return String(value || '').toLowerCase();
}

function boundedInteger(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(Math.floor(number), max));
}

async function screenshot(ctx, outFile, options = {}) {
  const foreground = await foregroundWindow(ctx);
  const resolvedPath = await adbBinaryToFile(ctx, ['exec-out', 'screencap', '-p'], outFile);
  const size = pngSize(resolvedPath);
  const result = {
    ok: true,
    transport: 'adb',
    mimeType: 'image/png',
    path: resolvedPath,
    width: size.width,
    height: size.height,
    artifact: {
      path: resolvedPath,
      generatedDefault: !options.outFile,
      directory: path.dirname(resolvedPath),
    },
    foreground,
  };
  if (result.artifact.generatedDefault) {
    result.artifact.retention = await pruneGeneratedArtifacts({
      directory: result.artifact.directory,
      prefix: options.artifactPrefix || 'ai_app_bridge_screenshot',
      extension: 'png',
      currentPath: resolvedPath,
    });
  }
  if (ctx.packageName) {
    result.targetPackageName = ctx.packageName;
  }
  if (ctx.explicitPackageName && foreground.packageName) {
    result.foregroundMatchesPackage = foreground.packageName === ctx.packageName;
    if (!result.foregroundMatchesPackage) {
      result.ok = false;
      result.error = 'foreground_package_mismatch';
      result.warning = `screenshot captured foreground package ${foreground.packageName}, not requested package ${ctx.packageName}`;
    }
  }
  return result;
}

function screenshotOutputPath(options = {}, prefix = 'ai_app_bridge_screenshot') {
  if (options.outFile) return options.outFile;
  return defaultArtifactPath(prefix, 'png', { artifactDir: options.artifactDir });
}

function defaultArtifactPath(prefix, extension, options = {}) {
  const directory = path.resolve(options.artifactDir || defaultArtifactDirectory());
  const suffix = [
    artifactTimestamp(options.now || new Date()),
    String(options.pid || process.pid),
    options.randomSuffix || Math.random().toString(36).slice(2, 8),
  ].join('-');
  const name = `${sanitizeArtifactName(prefix)}-${suffix}.${sanitizeArtifactExtension(extension)}`;
  return path.join(directory, name);
}

async function pruneGeneratedArtifacts(options = {}) {
  const keep = generatedArtifactRetention;
  const result = {
    keep,
    matched: 0,
    deleted: 0,
  };
  const directory = path.resolve(options.directory || process.cwd());
  const prefix = sanitizeArtifactName(options.prefix || 'artifact');
  const extension = sanitizeArtifactExtension(options.extension || 'bin');
  const currentPath = options.currentPath ? path.resolve(options.currentPath) : '';
  const pattern = new RegExp(`^${escapeRegExp(prefix)}-\\d{8}-\\d{6}-\\d{3}-\\d+-[a-z0-9]+\\.${escapeRegExp(extension)}$`);

  let entries;
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    return {
      ...result,
      error: firstErrorLine(error),
    };
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !pattern.test(entry.name)) {
      continue;
    }
    const filePath = path.join(directory, entry.name);
    try {
      const stat = await fs.promises.stat(filePath);
      files.push({
        name: entry.name,
        path: path.resolve(filePath),
        mtimeMs: stat.mtimeMs,
      });
    } catch (_) {
      // Ignore files that disappear while pruning.
    }
  }

  result.matched = files.length;
  if (files.length <= keep) {
    return result;
  }

  files.sort((left, right) => (right.mtimeMs - left.mtimeMs) || right.name.localeCompare(left.name));
  const keepSet = new Set();
  if (currentPath) {
    keepSet.add(currentPath);
  }
  for (const file of files) {
    if (keepSet.size >= keep) {
      break;
    }
    keepSet.add(file.path);
  }

  for (const file of files) {
    if (keepSet.has(file.path)) {
      continue;
    }
    try {
      await fs.promises.rm(file.path, { force: true });
      result.deleted += 1;
    } catch (_) {
      // Pruning is best-effort and should not make screenshot capture fail.
    }
  }
  return result;
}

function artifactTimestamp(date) {
  const value = date instanceof Date ? date : new Date(date);
  const pad = (number, size = 2) => String(number).padStart(size, '0');
  return [
    value.getUTCFullYear(),
    pad(value.getUTCMonth() + 1),
    pad(value.getUTCDate()),
    '-',
    pad(value.getUTCHours()),
    pad(value.getUTCMinutes()),
    pad(value.getUTCSeconds()),
    '-',
    pad(value.getUTCMilliseconds(), 3),
  ].join('');
}

function sanitizeArtifactName(value) {
  return String(value || 'artifact').replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'artifact';
}

function sanitizeArtifactExtension(value) {
  return sanitizeArtifactName(String(value || 'bin').replace(/^\.+/, '')) || 'bin';
}

function defaultArtifactDirectory() {
  return path.join(process.cwd(), 'build', 'ai_app_bridge_artifacts');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pngSize(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length < 24) return { width: 0, height: 0 };
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

async function foregroundWindow(ctx) {
  try {
    const result = await adb(ctx, ['shell', 'dumpsys', 'window']);
    return parseForegroundWindow(result.stdout);
  } catch (error) {
    return {
      ok: false,
      error: 'foreground_probe_failed',
      message: firstErrorLine(error),
    };
  }
}

function parseForegroundWindow(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const markers = [
    'mCurrentFocus',
    'mTopResumedActivity',
    'mResumedActivity',
    'mFocusedApp',
  ];
  for (const marker of markers) {
    const line = lines.find((item) => item.includes(marker));
    if (!line) continue;
    const component = parseComponentFromWindowLine(line);
    if (!component) continue;
    return {
      ok: true,
      source: marker,
      packageName: component.packageName,
      activity: component.activity,
      component: component.component,
      raw: line.trim(),
    };
  }
  return {
    ok: false,
    error: 'foreground_not_found',
  };
}

function parseComponentFromWindowLine(line) {
  const componentRegex = /([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\/(\.?[A-Za-z0-9_.$]+(?:\.[A-Za-z0-9_.$]+)*)/g;
  let match;
  let lastMatch = null;
  while ((match = componentRegex.exec(line)) !== null) {
    lastMatch = match;
  }
  if (!lastMatch) return null;
  const packageName = lastMatch[1];
  const rawActivity = lastMatch[2];
  const activity = rawActivity.startsWith('.') ? `${packageName}${rawActivity}` : rawActivity;
  return {
    packageName,
    activity,
    component: `${packageName}/${rawActivity}`,
  };
}

async function tap(ctx, x, y) {
  await adb(ctx, ['shell', 'input', 'tap', String(x), String(y)]);
  return { ok: true, transport: 'adb', x, y };
}

async function tapText(ctx, targetText, options = {}) {
  const tree = await bridgeGet(ctx, '/v1/view/tree');
  const bridgeMatch = findTappableNodeByText(tree, targetText);
  const node = bridgeMatch.node;
  if (node?.bounds) {
    let x = Math.round((node.bounds.left + node.bounds.right) / 2);
    let y = Math.round((node.bounds.top + node.bounds.bottom) / 2);
    let keyboard = null;
    if (!booleanOption(options.noAutoHideKeyboard)) {
      keyboard = await maybeHideKeyboardForPoint(ctx, { x, y }, bridgeMatch.viewport);
      if (keyboard.decision?.dismiss && !keyboard.dismissed) {
        return {
          ok: false,
          error: 'keyboard_obscures_target',
          targetText,
          source: 'bridge-tree',
          windowType: bridgeMatch.windowType,
          x,
          y,
          keyboard,
        };
      }
      if (keyboard.dismissed) {
        const refreshedMatch = findTappableNodeByText(await bridgeGet(ctx, '/v1/view/tree'), targetText);
        if (refreshedMatch.node?.bounds) {
          x = Math.round((refreshedMatch.node.bounds.left + refreshedMatch.node.bounds.right) / 2);
          y = Math.round((refreshedMatch.node.bounds.top + refreshedMatch.node.bounds.bottom) / 2);
        }
      }
    }
    await tap(ctx, x, y);
    return {
      ok: true,
      transport: 'adb',
      targetText,
      source: 'bridge-tree',
      windowType: bridgeMatch.windowType,
      x,
      y,
      keyboard,
    };
  }

  let xml = await uiaTree(ctx);
  let uiaNode = findUiaNodeByText(xml, targetText);
  if (!uiaNode) {
    const flutterTap = await tryTapFlutterText(ctx, targetText, options);
    if (flutterTap) {
      return flutterTap;
    }
    if (bridgeMatch.rejected) {
      return {
        ok: false,
        error: 'bridge_tree_node_not_tappable',
        targetText,
        source: 'bridge-tree',
        reason: bridgeMatch.rejected.reason,
        bounds: bridgeMatch.rejected.node.bounds || null,
        viewport: bridgeMatch.rejected.viewport || null,
      };
    }
    throw new Error(`text not found in Android bridge tree, UIAutomator tree, or Flutter operable tree: ${targetText}`);
  }
  let x = Math.round((uiaNode.left + uiaNode.right) / 2);
  let y = Math.round((uiaNode.top + uiaNode.bottom) / 2);
  let keyboard = null;
  if (!booleanOption(options.noAutoHideKeyboard)) {
    keyboard = await maybeHideKeyboardForPoint(ctx, { x, y }, parseUiaViewport(xml));
    if (keyboard.decision?.dismiss && !keyboard.dismissed) {
      return {
        ok: false,
        error: 'keyboard_obscures_target',
        targetText,
        source: 'uiautomator',
        x,
        y,
        keyboard,
      };
    }
    if (keyboard.dismissed) {
      xml = await uiaTree(ctx);
      const refreshedNode = findUiaNodeByText(xml, targetText);
      if (refreshedNode) {
        uiaNode = refreshedNode;
        x = Math.round((uiaNode.left + uiaNode.right) / 2);
        y = Math.round((uiaNode.top + uiaNode.bottom) / 2);
      }
    }
  }
  await tap(ctx, x, y);
  return { ok: true, transport: 'adb', targetText, source: 'uiautomator', x, y, keyboard };
}

function findTappableNodeByText(tree, targetText) {
  const roots = [];
  const windows = Array.isArray(tree?.windows) ? tree.windows : [];
  for (const windowInfo of windows.slice().reverse()) {
    if (windowInfo?.root) {
      roots.push({
        root: windowInfo.root,
        viewport: windowInfo.bounds || windowInfo.root.bounds || null,
        windowType: windowInfo.type || 'window',
      });
    }
  }
  if (tree?.root) {
    roots.push({
      root: tree.root,
      viewport: tree.root.bounds || null,
      windowType: 'activity',
    });
  }

  let rejected = null;
  for (const rootInfo of roots) {
    const result = findNodeByText(rootInfo.root, targetText, rootInfo.viewport);
    if (result.node) {
      return {
        node: result.node,
        windowType: rootInfo.windowType,
        viewport: rootInfo.viewport,
        rejected,
      };
    }
    rejected = rejected || result.rejected;
  }
  return { node: null, rejected };
}

function findNodeByText(node, targetText, viewport = null) {
  if (!node) return { node: null, rejected: null };
  if (node.text === targetText || node.contentDescription === targetText) {
    const state = nodeTapState(node, viewport);
    if (state.ok) {
      return { node, rejected: null };
    }
    return {
      node: null,
      rejected: {
        node,
        viewport,
        reason: state.reason,
      },
    };
  }
  let rejected = null;
  for (const child of node.children || []) {
    const found = findNodeByText(child, targetText, viewport);
    if (found.node) return found;
    rejected = rejected || found.rejected;
  }
  return { node: null, rejected };
}

function nodeTapState(node, viewport) {
  const bounds = node?.bounds;
  if (!bounds) return { ok: false, reason: 'missing_bounds' };
  if (node.visible === false || node.effectiveVisible === false) {
    return { ok: false, reason: 'not_effectively_visible' };
  }
  const width = Number(bounds.width ?? bounds.right - bounds.left);
  const height = Number(bounds.height ?? bounds.bottom - bounds.top);
  if (width <= 0 || height <= 0) {
    return { ok: false, reason: 'empty_bounds' };
  }
  if (!viewport) return { ok: true };
  const centerX = (Number(bounds.left) + Number(bounds.right)) / 2;
  const centerY = (Number(bounds.top) + Number(bounds.bottom)) / 2;
  if (
    centerX < Number(viewport.left) ||
    centerX > Number(viewport.right) ||
    centerY < Number(viewport.top) ||
    centerY > Number(viewport.bottom)
  ) {
    return { ok: false, reason: 'center_outside_viewport' };
  }
  return { ok: true };
}

function findUiaNodeByText(xml, targetText) {
  const escaped = escapeRegExp(targetText);
  const nodeRegex = /<node\b[^>]*>/g;
  let match;
  while ((match = nodeRegex.exec(xml)) !== null) {
    const nodeXml = match[0];
    const textMatch = new RegExp(`\\btext="${escaped}"`).test(nodeXml);
    const descMatch = new RegExp(`\\bcontent-desc="${escaped}"`).test(nodeXml);
    if (!textMatch && !descMatch) continue;
    const boundsMatch = /\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(nodeXml);
    if (!boundsMatch) continue;
    return {
      left: Number(boundsMatch[1]),
      top: Number(boundsMatch[2]),
      right: Number(boundsMatch[3]),
      bottom: Number(boundsMatch[4]),
    };
  }
  return null;
}

function parseUiaViewport(xml) {
  const match = /<node\b[^>]*\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(String(xml || ''));
  if (!match) return null;
  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

async function tapUiaText(ctx, targetText, options = {}) {
  const node = findUiaNodeByAny(await uiaTree(ctx), {
    texts: [targetText],
    exact: booleanOption(options.exact),
  });
  if (!node) {
    throw new Error(`text not found in UIAutomator tree: ${targetText}`);
  }
  const x = Math.round((node.left + node.right) / 2);
  const y = Math.round((node.top + node.bottom) / 2);
  await tap(ctx, x, y);
  return { ok: true, transport: 'adb', source: 'uiautomator', targetText, x, y, matched: node.matched };
}

async function permissionDialog(ctx, options) {
  const texts = splitCsv(options.targetText || options.buttonText || options.allowText);
  const resourceIds = splitCsv(options.resourceId || options.resourceIds);
  const candidates = texts.length ? texts : defaultPermissionAllowTexts();
  const ids = resourceIds.length ? resourceIds : defaultPermissionAllowResourceIds();
  const attempts = Number(options.attempts || 8);
  const intervalMs = Number(options.intervalMs || 500);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const xml = await uiaTree(ctx);
    const node = findUiaNodeByAny(xml, {
      resourceIds: ids,
    }) || findUiaNodeByAny(xml, {
      texts: candidates,
      exact: booleanOption(options.exact),
      requireClickable: true,
    });
    if (node) {
      const x = Math.round((node.left + node.right) / 2);
      const y = Math.round((node.top + node.bottom) / 2);
      await tap(ctx, x, y);
      return {
        ok: true,
        transport: 'adb',
        source: 'uiautomator',
        action: 'permission-dialog',
        attempt,
        x,
        y,
        matched: node.matched,
      };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    error: 'permission_dialog_allow_button_not_found',
    texts: candidates,
    resourceIds: ids,
    attempts,
  };
}

function findUiaNodeByAny(xml, options) {
  const texts = (options.texts || []).map(String).filter(Boolean);
  const resourceIds = (options.resourceIds || []).map(String).filter(Boolean);
  const exact = Boolean(options.exact);
  const nodeRegex = /<node\b[^>]*>/g;
  let match;
  while ((match = nodeRegex.exec(xml)) !== null) {
    const nodeXml = match[0];
    const attrs = {
      text: xmlUnescape(readXmlAttribute(nodeXml, 'text')),
      contentDescription: xmlUnescape(readXmlAttribute(nodeXml, 'content-desc')),
      resourceId: xmlUnescape(readXmlAttribute(nodeXml, 'resource-id')),
      className: xmlUnescape(readXmlAttribute(nodeXml, 'class')),
      clickable: readXmlAttribute(nodeXml, 'clickable') === 'true',
      enabled: readXmlAttribute(nodeXml, 'enabled') !== 'false',
    };
    if (options.requireClickable && (!attrs.clickable || !attrs.enabled)) continue;
    const textMatch = texts.find((target) => {
      return [attrs.text, attrs.contentDescription].some((value) => {
        return exact ? value === target : value.includes(target);
      });
    });
    const resourceIdMatch = resourceIds.find((target) => {
      return exact ? attrs.resourceId === target : attrs.resourceId.includes(target);
    });
    if (!textMatch && !resourceIdMatch) continue;
    const boundsMatch = /\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(nodeXml);
    if (!boundsMatch) continue;
    return {
      left: Number(boundsMatch[1]),
      top: Number(boundsMatch[2]),
      right: Number(boundsMatch[3]),
      bottom: Number(boundsMatch[4]),
      matched: {
        text: attrs.text,
        contentDescription: attrs.contentDescription,
        resourceId: attrs.resourceId,
        className: attrs.className,
        clickable: attrs.clickable,
        target: textMatch || resourceIdMatch,
      },
    };
  }
  return null;
}

function readXmlAttribute(xml, name) {
  const match = new RegExp(`\\b${escapeRegExp(name)}="([^"]*)"`).exec(xml);
  return match ? match[1] : '';
}

function xmlUnescape(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function defaultPermissionAllowTexts() {
  return [
    'Allow',
    'While using the app',
    'Only this time',
    '仅在使用该应用时允许',
    '使用应用时允许',
    '使用时允许',
    '仅本次允许',
    '仅本次使用时允许',
    '始终允许',
  ];
}

function defaultPermissionAllowResourceIds() {
  return [
    'permission_allow_button',
    'permission_allow_foreground_only_button',
    'permission_allow_one_time_button',
    'android:id/button1',
  ];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function waitText(ctx, targetText, options = {}) {
  const timeoutSec = Number(options.timeoutSec || 10);
  const conditions = {
    requireTexts: splitCsv(options.requireText || options.requireTexts),
    absentTexts: splitCsv(options.absentText || options.absentTexts),
    requireActivity: options.requireActivity || options.activity || '',
  };
  const deadline = Date.now() + timeoutSec * 1000;
  let lastCheck = null;
  while (Date.now() < deadline) {
    const snapshot = await textSnapshot(ctx);
    lastCheck = waitTextConditionsMet(snapshot, targetText, conditions);
    if (lastCheck.ok) {
      return { ok: true, targetText, timeoutSec, conditions, matched: lastCheck };
    }
    await sleep(500);
  }
  return { ok: false, error: 'text_not_found', targetText, timeoutSec, conditions, lastCheck };
}

async function flutterNodes(ctx) {
  const status = await bridgeGet(ctx, '/v1/status');
  return status.flutter?.layout?.operable || { ok: false, error: 'no_flutter_operable_tree' };
}

async function flutterAction(ctx, payload) {
  const result = await bridgePost(ctx, '/v1/flutter/action', payload);
  return { ...result, transport: 'bridge', source: 'flutter-runtime-action', request: payload };
}

async function tryTapFlutterText(ctx, targetText, options = {}) {
  try {
    return await tapFlutterText(ctx, targetText, options);
  } catch (_) {
    return null;
  }
}

async function tapFlutterText(ctx, targetText, options = {}) {
  let operable = await flutterNodes(ctx);
  let node = findFlutterNode(operable, targetText, 'tap');
  if (!node) {
    throw new Error(`flutter tap node not found: ${targetText}`);
  }
  let point = flutterNodePoint(node.tap?.bounds || node.bounds, operable.viewport);
  let keyboard = null;
  if (!booleanOption(options.noAutoHideKeyboard)) {
    keyboard = await maybeHideKeyboardForPoint(ctx, point, flutterPhysicalViewport(operable.viewport));
    if (keyboard.decision?.dismiss && !keyboard.dismissed) {
      return {
        ok: false,
        error: 'keyboard_obscures_target',
        targetText,
        source: 'flutter-operable-tree',
        x: point.x,
        y: point.y,
        keyboard,
      };
    }
    if (keyboard.dismissed) {
      operable = await flutterNodes(ctx);
      const refreshedNode = findFlutterNode(operable, targetText, 'tap');
      if (refreshedNode) {
        node = refreshedNode;
        point = flutterNodePoint(node.tap?.bounds || node.bounds, operable.viewport);
      }
    }
  }
  await tap(ctx, point.x, point.y);
  return {
    ok: true,
    transport: 'adb',
    source: 'flutter-operable-tree',
    targetText,
    node,
    x: point.x,
    y: point.y,
    keyboard,
  };
}

async function inputFlutterText(ctx, targetText, text) {
  const operable = await flutterNodes(ctx);
  const node = findFlutterNode(operable, targetText, 'input');
  if (!node) {
    throw new Error(`flutter input node not found: ${targetText}`);
  }
  const point = flutterNodePoint(node.input?.bounds || node.bounds, operable.viewport);
  const result = await flutterAction(ctx, { action: 'inputText', text, x: point.x, y: point.y });
  return {
    ...result,
    source: 'flutter-operable-tree',
    targetText,
    text,
    node,
    x: point.x,
    y: point.y,
  };
}

async function scrollFlutter(ctx, targetText) {
  const operable = await flutterNodes(ctx);
  const node = targetText
    ? findFlutterNode(operable, targetText, 'scroll')
    : (operable.nodes || []).find((item) => (item.actions || []).includes('scroll') && item.scroll?.bounds);
  if (!node) {
    throw new Error(targetText ? `flutter scroll node not found: ${targetText}` : 'flutter scroll node not found');
  }
  const bounds = node.scroll?.bounds || node.bounds;
  const dpr = Number(operable.viewport?.devicePixelRatio || 1);
  const x = Math.round(((bounds.left + bounds.right) / 2) * dpr);
  const startY = Math.round((bounds.bottom - bounds.height * 0.2) * dpr);
  const endY = Math.round((bounds.top + bounds.height * 0.2) * dpr);
  await swipe(ctx, x, startY, x, endY, 600);
  return {
    ok: true,
    transport: 'adb',
    source: 'flutter-operable-tree',
    targetText,
    node,
    startX: x,
    startY,
    endX: x,
    endY,
  };
}

function findFlutterNode(operable, targetText, action) {
  const nodes = Array.isArray(operable?.nodes) ? operable.nodes : [];
  const candidates = nodes.filter((node) => {
    const actions = Array.isArray(node.actions) ? node.actions : [];
    return actions.includes(action) && flutterNodeMatches(node, targetText);
  });
  return candidates.find((node) => node.text === targetText || node.value === targetText) || candidates[0] || null;
}

function flutterNodeMatches(node, targetText) {
  const text = String(node.text || '');
  const value = String(node.value || '');
  return text === targetText || value === targetText || text.includes(targetText) || value.includes(targetText);
}

function flutterNodePoint(bounds, viewport) {
  if (!bounds) throw new Error('flutter node has no bounds');
  const dpr = Number(viewport?.devicePixelRatio || 1);
  return {
    x: Math.round(Number(bounds.centerX ?? ((bounds.left + bounds.right) / 2)) * dpr),
    y: Math.round(Number(bounds.centerY ?? ((bounds.top + bounds.bottom) / 2)) * dpr),
  };
}

function flutterPhysicalViewport(viewport) {
  const width = Number(viewport?.physicalWidth || viewport?.width || viewport?.logicalWidth || 0);
  const height = Number(viewport?.physicalHeight || viewport?.height || viewport?.logicalHeight || 0);
  if (!width || !height) return null;
  return {
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
  };
}

async function h5Click(ctx, options) {
  const result = await h5Operation(ctx, 'click', h5TargetOptions(options));
  assertH5OperationOk(result, 'h5_click_failed');
  return result;
}

async function h5Input(ctx, options) {
  const value = options.value ?? options.inputValue ?? options.text;
  if (value === undefined || value === null) {
    throw new Error('missing required option: value');
  }
  const result = await h5Operation(ctx, 'input', {
    ...h5TargetOptions(options),
    value: String(value),
  });
  assertH5OperationOk(result, 'h5_input_failed');
  return result;
}

async function h5Scroll(ctx, options) {
  const result = await h5Operation(ctx, 'scroll', {
    ...h5TargetOptions(options),
    deltaX: Number(options.deltaX || 0),
    deltaY: Number(options.deltaY || options.delta || 480),
  });
  assertH5OperationOk(result, 'h5_scroll_failed');
  return result;
}

async function h5Wait(ctx, options) {
  const timeoutSec = Number(options.timeoutSec || 10);
  const intervalMs = Number(options.intervalMs || 500);
  const deadline = Date.now() + timeoutSec * 1000;
  let lastResult = null;
  while (Date.now() <= deadline) {
    lastResult = await h5Operation(ctx, 'find', h5TargetOptions(options));
    if (lastResult.result?.ok) {
      return { ...lastResult, timeoutSec, intervalMs };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    error: 'h5_target_not_found',
    timeoutSec,
    intervalMs,
    lastResult,
  };
}

async function h5Operation(ctx, action, params) {
  const response = await bridgePost(ctx, '/v1/h5/eval', {
    script: h5OperationScript(action, params),
  });
  return {
    ...response,
    transport: 'bridge',
    source: 'native-webview-eval',
    action,
    request: params,
    result: normalizeH5EvalResult(response.result),
  };
}

async function flutterH5Dom(ctx) {
  const response = await flutterAction(ctx, { action: 'h5Dom' });
  return { ...response, source: 'flutter-h5-adapter' };
}

async function flutterH5Eval(ctx, params) {
  const response = await flutterAction(ctx, { action: 'h5Eval', script: params.script });
  return { ...response, source: 'flutter-h5-adapter' };
}

async function flutterH5Click(ctx, options) {
  const result = await flutterH5Operation(ctx, 'click', h5TargetOptions(options));
  assertH5OperationOk(result, 'flutter_h5_click_failed');
  return result;
}

async function flutterH5Input(ctx, options) {
  const value = options.value ?? options.inputValue ?? options.text;
  if (value === undefined || value === null) {
    throw new Error('missing required option: value');
  }
  const result = await flutterH5Operation(ctx, 'input', {
    ...h5TargetOptions(options),
    value: String(value),
  });
  assertH5OperationOk(result, 'flutter_h5_input_failed');
  return result;
}

async function flutterH5Scroll(ctx, options) {
  const result = await flutterH5Operation(ctx, 'scroll', {
    ...h5TargetOptions(options),
    deltaX: Number(options.deltaX || 0),
    deltaY: Number(options.deltaY || options.delta || 480),
  });
  assertH5OperationOk(result, 'flutter_h5_scroll_failed');
  return result;
}

async function flutterH5Wait(ctx, options) {
  const timeoutSec = Number(options.timeoutSec || 10);
  const intervalMs = Number(options.intervalMs || 500);
  const deadline = Date.now() + timeoutSec * 1000;
  let lastResult = null;
  while (Date.now() <= deadline) {
    lastResult = await flutterH5Operation(ctx, 'find', h5TargetOptions(options));
    if (lastResult.result?.ok) {
      return { ...lastResult, timeoutSec, intervalMs };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    error: 'flutter_h5_target_not_found',
    timeoutSec,
    intervalMs,
    lastResult,
  };
}

async function flutterH5Operation(ctx, action, params) {
  const response = await flutterH5Eval(ctx, {
    script: h5OperationScript(action, params),
  });
  return {
    ...response,
    source: 'flutter-h5-adapter',
    action,
    request: params,
    result: normalizeH5EvalResult(response.result),
  };
}

function h5TargetOptions(options) {
  return {
    selector: options.selector || '',
    targetText: options.targetText || options.textContains || '',
    exact: booleanOption(options.exact),
  };
}

function booleanOption(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function assertH5OperationOk(response, errorName) {
  if (!response.ok) {
    throw new Error(`${errorName}: ${response.error || 'bridge_error'}`);
  }
  if (!response.result?.ok) {
    throw new Error(`${errorName}: ${response.result?.error || 'target_not_found'}`);
  }
}

function normalizeH5EvalResult(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (_) {
      return { ok: true, value };
    }
  }
  return value || null;
}

function h5OperationScript(action, params) {
  const payload = JSON.stringify({ action, ...params });
  return `
    (function() {
      var params = ${payload};
      function text(value) {
        return value == null ? '' : String(value);
      }
      function cut(value, max) {
        var raw = text(value);
        return raw.length > max ? raw.slice(0, max) : raw;
      }
      function visible(element) {
        if (!element) return false;
        var style = window.getComputedStyle ? window.getComputedStyle(element) : null;
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
        var rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      function bounds(element) {
        var rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height
        };
      }
      function label(element) {
        return [
          element.innerText,
          element.value,
          element.title,
          element.id,
          element.name,
          element.getAttribute('aria-label'),
          element.getAttribute('placeholder'),
          element.getAttribute('role')
        ].map(text).filter(Boolean).join('\\n');
      }
      function matchesText(element, targetText) {
        if (!targetText) return true;
        var source = label(element);
        return params.exact ? source === targetText : source.indexOf(targetText) >= 0;
      }
      function describe(element) {
        if (!element) return null;
        return {
          tag: text(element.tagName).toLowerCase(),
          id: text(element.id),
          name: text(element.getAttribute('name')),
          type: text(element.getAttribute('type')),
          role: text(element.getAttribute('role')),
          ariaLabel: text(element.getAttribute('aria-label')),
          placeholder: text(element.getAttribute('placeholder')),
          text: cut(element.innerText || element.value || element.title || element.getAttribute('aria-label'), 500),
          value: cut(element.value, 500),
          disabled: !!element.disabled,
          bounds: bounds(element)
        };
      }
      function findElement() {
        var selector = text(params.selector);
        var targetText = text(params.targetText);
        var candidates = [];
        if (selector) {
          candidates = Array.prototype.slice.call(document.querySelectorAll(selector), 0, 200);
        } else if (targetText) {
          candidates = Array.prototype.slice.call(document.querySelectorAll('a,button,input,textarea,select,[role],[onclick],[aria-label],[contenteditable="true"]'), 0, 500);
          if (!candidates.length) {
            candidates = Array.prototype.slice.call(document.body ? document.body.querySelectorAll('*') : [], 0, 1000);
          }
        } else if (document.activeElement) {
          candidates = [document.activeElement];
        }
        var matched = candidates.filter(function(element) {
          return matchesText(element, targetText);
        });
        return matched.find(visible) || matched[0] || null;
      }
      function dispatch(element, name) {
        var event = new Event(name, { bubbles: true, cancelable: true });
        element.dispatchEvent(event);
      }
      function pointer(element, name) {
        try {
          element.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true, view: window }));
        } catch (_) {
          dispatch(element, name);
        }
      }
      function bodyText() {
        return cut(document.body && document.body.innerText, 2000);
      }

      var targetText = text(params.targetText);
      if (params.action === 'find' && targetText && bodyText().indexOf(targetText) >= 0) {
        return JSON.stringify({
          ok: true,
          action: params.action,
          matchSource: 'bodyText',
          bodyText: bodyText(),
          updatedAtMs: Date.now()
        });
      }

      var element = findElement();
      if (!element) {
        return JSON.stringify({
          ok: false,
          action: params.action,
          error: 'target_not_found',
          selector: text(params.selector),
          targetText: targetText,
          bodyText: bodyText(),
          updatedAtMs: Date.now()
        });
      }

      if (params.action === 'click') {
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        if (element.focus) element.focus();
        pointer(element, 'mousedown');
        pointer(element, 'mouseup');
        if (element.click) {
          element.click();
        } else {
          pointer(element, 'click');
        }
      } else if (params.action === 'input') {
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        if (element.focus) element.focus();
        if ('value' in element) {
          element.value = text(params.value);
        } else if (element.isContentEditable) {
          element.innerText = text(params.value);
        } else {
          return JSON.stringify({
            ok: false,
            action: params.action,
            error: 'target_not_editable',
            matched: describe(element),
            updatedAtMs: Date.now()
          });
        }
        dispatch(element, 'input');
        dispatch(element, 'change');
      } else if (params.action === 'scroll') {
        if (params.selector || targetText) {
          element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        } else {
          window.scrollBy(Number(params.deltaX || 0), Number(params.deltaY || 0));
        }
      }

      return JSON.stringify({
        ok: true,
        action: params.action,
        matched: describe(element),
        value: cut(element.value, 500),
        bodyText: bodyText(),
        scroll: {
          x: window.scrollX,
          y: window.scrollY
        },
        updatedAtMs: Date.now()
      });
    })()
  `;
}

async function textPresent(ctx, targetText) {
  return waitTextConditionsMet(await textSnapshot(ctx), targetText).ok;
}

async function textSnapshot(ctx) {
  const parts = [];
  let activity = '';
  for (const loader of [
    async () => {
      const status = await bridgeGet(ctx, '/v1/status');
      activity = String(status?.activity?.current || '');
      return statusSearchText(status);
    },
    async () => JSON.stringify(await bridgeGet(ctx, '/v1/view/tree')),
    async () => await uiaTree(ctx),
  ]) {
    try {
      const text = await loader();
      parts.push(text);
    } catch (_) {}
  }
  return {
    text: parts.join('\n'),
    activity,
  };
}

function statusSearchText(status) {
  if (!status || typeof status !== 'object') return '';
  const parts = [];
  parts.push(JSON.stringify({
    debugBridge: status.debugBridge,
    app: status.app,
    android: status.android,
    activity: status.activity,
    capture: status.capture,
  }));
  const flutter = status.flutter;
  if (flutter && typeof flutter === 'object') {
    parts.push(JSON.stringify({
      app: flutter.app,
      route: flutter.route,
      h5: flutter.h5 ? flutterH5SearchObject(flutter.h5) : undefined,
    }));
    const nodes = Array.isArray(flutter.layout?.operable?.nodes) ? flutter.layout.operable.nodes : [];
    for (const node of nodes) {
      parts.push(JSON.stringify({
        widgetType: node.widgetType,
        text: node.text,
        value: node.value,
        actions: node.actions,
      }));
    }
  }
  return parts.join('\n');
}

function flutterH5SearchObject(h5) {
  if (!h5 || typeof h5 !== 'object') return h5;
  return {
    active: h5.active,
    adapterId: h5.adapterId,
    source: h5.source,
    currentUrl: h5.currentUrl,
    progress: h5.progress,
    title: h5.title,
    dom: h5.dom ? {
      ok: h5.dom.ok,
      title: h5.dom.title,
      url: h5.dom.url,
      readyState: h5.dom.readyState,
      bodyText: h5.dom.bodyText,
      controls: Array.isArray(h5.dom.controls)
        ? h5.dom.controls.map((control) => ({
            tag: control.tag,
            id: control.id,
            name: control.name,
            type: control.type,
            role: control.role,
            ariaLabel: control.ariaLabel,
            placeholder: control.placeholder,
            text: control.text,
            href: control.href,
            disabled: control.disabled,
          }))
        : h5.dom.controls,
      controlCount: h5.dom.controlCount,
    } : undefined,
  };
}

function waitTextConditionsMet(snapshot, targetText, options = {}) {
  const text = String(snapshot?.text || '');
  const activity = String(snapshot?.activity || '');
  if (!text.includes(targetText)) {
    return { ok: false, reason: 'target_text_missing', targetText, activity };
  }
  const requireActivity = String(options.requireActivity || '');
  if (requireActivity && !activity.includes(requireActivity)) {
    return {
      ok: false,
      reason: 'activity_mismatch',
      targetText,
      activity,
      requireActivity,
    };
  }
  const missingTexts = (options.requireTexts || []).filter((value) => !text.includes(value));
  if (missingTexts.length) {
    return {
      ok: false,
      reason: 'required_text_missing',
      targetText,
      activity,
      missingTexts,
    };
  }
  const presentAbsentTexts = (options.absentTexts || []).filter((value) => text.includes(value));
  if (presentAbsentTexts.length) {
    return {
      ok: false,
      reason: 'absent_text_present',
      targetText,
      activity,
      presentAbsentTexts,
    };
  }
  return { ok: true, targetText, activity };
}

async function keyboardState(ctx) {
  try {
    const result = await adb(ctx, ['shell', 'dumpsys', 'input_method']);
    return parseKeyboardState(result.stdout);
  } catch (error) {
    return {
      ok: false,
      error: 'keyboard_state_probe_failed',
      message: firstErrorLine(error),
    };
  }
}

function parseKeyboardState(raw) {
  const text = String(raw || '');
  const inputShown = text.includes('mInputShown=true') || text.includes('inputShown=true');
  const windowVisible = text.includes('mWindowVisible=true');
  const inputViewShown = text.includes('mIsInputViewShown=true') || text.includes('mInputViewStarted=true');
  const imeWindowVisible = /\bmImeWindowVis=0x[13]\b/i.test(text) || /\bmImeWindowVisibility=0x[13]\b/i.test(text);
  const markers = [];
  if (inputShown) markers.push('mInputShown=true');
  if (windowVisible) markers.push('mWindowVisible=true');
  if (inputViewShown) markers.push('mIsInputViewShown=true');
  if (imeWindowVisible) markers.push('mImeWindowVis');
  const hiddenMarkers = [
    'mInputShown=false',
    'mWindowVisible=false',
    'mImeWindowVis=0',
  ].filter((marker) => text.includes(marker));
  return {
    ok: true,
    source: 'dumpsys input_method',
    visible: inputShown || imeWindowVisible || (windowVisible && inputViewShown),
    markers,
    hiddenMarkers,
  };
}

async function hideKeyboard(ctx, options = {}) {
  const before = await keyboardState(ctx);
  const force = booleanOption(options.force);
  if (!force && before.ok && !before.visible) {
    return {
      ok: true,
      action: 'hide-keyboard',
      dismissed: false,
      reason: 'keyboard_not_visible',
      before,
      after: before,
      attempts: [],
    };
  }

  const attempts = [];
  for (const keyCode of [111, 4]) {
    await keyevent(ctx, keyCode);
    await sleep(Number(options.intervalMs || 500));
    const after = await keyboardState(ctx);
    attempts.push({ keyCode, visible: after.visible, ok: after.ok });
    if (after.ok && !after.visible) {
      return {
        ok: true,
        action: 'hide-keyboard',
        dismissed: true,
        before,
        after,
        attempts,
      };
    }
  }

  const after = await keyboardState(ctx);
  return {
    ok: false,
    action: 'hide-keyboard',
    error: 'keyboard_still_visible',
    dismissed: false,
    before,
    after,
    attempts,
  };
}

async function maybeHideKeyboardForPoint(ctx, point, viewport) {
  const state = await keyboardState(ctx);
  const decision = shouldDismissKeyboardForPoint({ point, viewport, keyboardVisible: state.visible });
  if (!decision.dismiss) {
    return {
      dismissed: false,
      state,
      decision,
    };
  }
  const hide = await hideKeyboard(ctx, { reason: decision.reason });
  return {
    dismissed: hide.dismissed,
    state,
    decision,
    hide,
  };
}

function shouldDismissKeyboardForPoint({ point, viewport, keyboardVisible }) {
  if (!keyboardVisible) {
    return { dismiss: false, reason: 'keyboard_not_visible' };
  }
  if (!point || !viewport) {
    return { dismiss: false, reason: 'missing_geometry' };
  }
  const top = Number(viewport.top || 0);
  const bottom = Number(viewport.bottom);
  if (!Number.isFinite(bottom) || bottom <= top) {
    return { dismiss: false, reason: 'invalid_viewport' };
  }
  const threshold = top + (bottom - top) * 0.58;
  if (Number(point.y) >= threshold) {
    return {
      dismiss: true,
      reason: 'target_may_be_obscured_by_keyboard',
      threshold,
    };
  }
  return {
    dismiss: false,
    reason: 'target_above_keyboard_risk_area',
    threshold,
  };
}

async function inputText(ctx, text, options = {}) {
  const bridgePayload = inputTextBridgePayload(text, options);
  let bridgeAttempt = null;
  try {
    const bridgeResult = await bridgePost(ctx, '/v1/action/input-text', bridgePayload);
    if (bridgeResult?.ok) {
      const result = {
        ...bridgeResult,
        transport: 'bridge',
        source: bridgeResult.source || 'native-view',
        request: bridgePayload,
      };
      if (booleanOption(options.hideKeyboard)) {
        result.keyboard = await hideKeyboard(ctx, options);
      }
      return result;
    }
    bridgeAttempt = {
      ok: false,
      command: 'input-text',
      requestPath: '/v1/action/input-text',
      result: bridgeResult,
      error: bridgeResult?.error || 'bridge_input_failed',
      message: bridgeResult?.message || 'The app bridge did not accept native text input.',
    };
  } catch (error) {
    bridgeAttempt = buildBridgeFailureResult(ctx, 'input-text', '/v1/action/input-text', error);
  }

  if (!isAdbInputTextSafe(text)) {
    return {
      ok: false,
      error: 'unicode_text_requires_bridge_input',
      message: 'This text contains non-ASCII characters. Android adb shell input text cannot reliably enter Unicode; use an app build with AI App Bridge Android runtime 0.1.9+ and retry input-text/input_text.',
      textLength: text.length,
      bridge: bridgeAttempt,
      suggestion: 'Update the target app bridge dependency to ai-app-bridge-android 0.1.9+ and pass --package-name so the CLI can discover the app bridge port.',
    };
  }

  await adb(ctx, ['shell', 'input', 'text', text.replace(/ /g, '%s')]);
  const result = {
    ok: true,
    transport: 'adb',
    source: 'adb-input-text-fallback',
    text,
    bridge: bridgeAttempt,
  };
  if (booleanOption(options.hideKeyboard)) {
    result.keyboard = await hideKeyboard(ctx, options);
  }
  return result;
}

function inputTextBridgePayload(text, options = {}) {
  const payload = { text };
  const x = Number(options.tapX);
  const y = Number(options.tapY);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    payload.x = x;
    payload.y = y;
  }
  return payload;
}

function isAdbInputTextSafe(text) {
  return /^[\x20-\x7e]*$/.test(String(text));
}

async function swipe(ctx, startX, startY, endX, endY, durationMs) {
  await adb(ctx, ['shell', 'input', 'swipe', String(startX), String(startY), String(endX), String(endY), String(durationMs)]);
  return { ok: true, transport: 'adb', startX, startY, endX, endY, durationMs };
}

async function keyevent(ctx, keyCode) {
  await adb(ctx, ['shell', 'input', 'keyevent', String(keyCode)]);
  return { ok: true, transport: 'adb', keyCode };
}

async function logcat(ctx, options) {
  const follow = Boolean(options.follow || options.live);
  const args = ['logcat', '-v', String(options.logcatFormat || options.format || 'threadtime')];
  if (options.clear || options.clearFirst) {
    await adb(ctx, ['logcat', '-c']);
  }
  if (!follow) {
    args.push('-d');
  }
  const since = options.logcatSince || options.since;
  if (since) {
    args.push('-T', String(since));
  } else if (!follow) {
    args.push('-t', String(options.logcatLines || options.lines || 200));
  }
  if (options.logcatFilter) {
    args.push(...String(options.logcatFilter).split(',').map((value) => value.trim()).filter(Boolean));
  }
  const text = follow
    ? await adbFollow(ctx, args, Number(options.durationMs || Number(options.durationSec || 5) * 1000))
    : (await adb(ctx, args)).stdout;
  const pid = await resolveLogcatPid(ctx, options);
  return filterLogcat(text, { ...options, pid });
}

async function permissionState(ctx, permission) {
  const result = await adb(ctx, ['shell', 'dumpsys', 'package', ctx.packageName]);
  const pattern = new RegExp(`${escapeRegExp(permission)}:\\s+granted=(true|false)(?:,\\s*flags=\\[([^\\]]*)\\])?`);
  const match = pattern.exec(result.stdout);
  if (!match) {
    return {
      ok: false,
      packageName: ctx.packageName,
      permission,
      error: 'permission_not_found_in_dumpsys',
    };
  }
  return {
    ok: true,
    packageName: ctx.packageName,
    permission,
    granted: match[1] === 'true',
    flags: splitCsv(match[2] || ''),
  };
}

async function permissionGrant(ctx, permission) {
  try {
    await adb(ctx, ['shell', 'pm', 'grant', ctx.packageName, permission]);
    return {
      action: 'grant',
      ...(await permissionState(ctx, permission)),
    };
  } catch (error) {
    return {
      ok: false,
      action: 'grant',
      packageName: ctx.packageName,
      permission,
      error: error.message || String(error),
      state: await safePermissionState(ctx, permission),
    };
  }
}

async function permissionRevoke(ctx, permission) {
  try {
    await adb(ctx, ['shell', 'pm', 'revoke', ctx.packageName, permission]);
    return {
      action: 'revoke',
      ...(await permissionState(ctx, permission)),
    };
  } catch (error) {
    return {
      ok: false,
      action: 'revoke',
      packageName: ctx.packageName,
      permission,
      error: error.message || String(error),
      state: await safePermissionState(ctx, permission),
    };
  }
}

async function safePermissionState(ctx, permission) {
  try {
    return await permissionState(ctx, permission);
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

async function appopsSet(ctx, op, mode) {
  await adb(ctx, ['shell', 'appops', 'set', ctx.packageName, op, mode]);
  return {
    ok: true,
    packageName: ctx.packageName,
    op,
    mode,
  };
}

async function clearAppData(ctx) {
  if (!ctx.explicitPackageName) {
    throw new Error('packageName is required for clear-app-data');
  }
  let bridgeError = null;
  try {
    const bridgeResult = await bridgePost(ctx, '/v1/app/clear-data', {});
    return {
      ...bridgeResult,
      packageName: ctx.packageName,
      method: 'bridge-runtime',
    };
  } catch (error) {
    bridgeError = firstErrorLine(error);
  }

  let result;
  try {
    result = await adb(ctx, clearAppDataAdbArgs(ctx.packageName));
  } catch (error) {
    return {
      ok: false,
      packageName: ctx.packageName,
      action: 'clear-app-data',
      error: 'clear_app_data_failed',
      bridgeError,
      message: error.message || String(error),
    };
  }
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (!/^Success\b/im.test(output)) {
    return {
      ok: false,
      packageName: ctx.packageName,
      error: 'clear_app_data_failed',
      bridgeError,
      output,
    };
  }
  return {
    ok: true,
    packageName: ctx.packageName,
    action: 'clear-app-data',
    method: 'pm-clear',
    bridgeError,
    output,
  };
}

function clearAppDataAdbArgs(packageName) {
  return ['shell', 'pm', 'clear', packageName];
}

async function resolveLogcatPid(ctx, options) {
  if (options.pid && options.pid !== true && options.pid !== 'current') {
    return String(options.pid);
  }
  if (options.pid === 'current' || options.appPid || options.packagePid) {
    try {
      const result = await adb(ctx, ['shell', 'pidof', '-s', ctx.packageName]);
      return result.stdout.trim().split(/\s+/).filter(Boolean)[0] || '';
    } catch (_) {
      return '';
    }
  }
  return '';
}

function filterLogcat(text, options) {
  const tags = splitCsv(options.tag || options.tags);
  const grep = options.grep ? String(options.grep) : '';
  const grepCaseSensitive = Boolean(options.grepCaseSensitive);
  const minLevel = priorityValue(options.level || options.minLevel || '');
  const pid = options.pid ? String(options.pid) : '';
  const requiresAppPid = options.appPid || options.packagePid || options.pid === 'current';
  if (requiresAppPid && !pid) {
    return '';
  }
  const lines = String(text || '').split(/\r?\n/);
  const filtered = [];
  let previousIncluded = false;
  for (const line of lines) {
    if (!line) continue;
    const parsed = parseLogcatLine(line);
    if (!parsed) {
      if (previousIncluded) filtered.push(line);
      continue;
    }
    let include = true;
    if (pid && parsed.pid !== pid) include = false;
    if (tags.length && !tags.includes(parsed.tag)) include = false;
    if (minLevel >= 0 && priorityValue(parsed.priority) < minLevel) include = false;
    if (grep) {
      include = include && (
        grepCaseSensitive
          ? line.includes(grep)
          : line.toLowerCase().includes(grep.toLowerCase())
      );
    }
    previousIncluded = include;
    if (include) filtered.push(line);
  }
  const limit = Number(options.limitLines || options.outputLines || 0);
  const result = limit > 0 && filtered.length > limit ? filtered.slice(-limit) : filtered;
  return result.join('\n');
}

function parseLogcatLine(line) {
  const match = /^\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d+\s+(\d+)\s+(\d+)\s+([VDIWEAF])\s+([^:]+):\s?(.*)$/.exec(line);
  if (!match) return null;
  return {
    pid: match[1],
    tid: match[2],
    priority: match[3],
    tag: match[4].trim(),
    message: match[5],
  };
}

function priorityValue(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, A: 5 }[normalized] ?? -1;
}

function splitCsv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function adbFollow(ctx, args, durationMs) {
  const allArgs = [];
  if (ctx.serial) allArgs.push('-s', ctx.serial);
  allArgs.push(...args);
  const boundedDurationMs = Math.max(500, Math.min(durationMs || 5000, 60000));
  return new Promise((resolve, reject) => {
    const child = spawn(ctx.adb, allArgs, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
    }, boundedDurationMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null && stdout.length === 0) {
        reject(new Error(`adb logcat failed with exit code ${code}: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function launchApp(ctx, options = {}) {
  if (options.component || options.activity) {
    return launchActivity(ctx, options);
  }

  const candidates = await launcherActivityCandidates(ctx);
  if (candidates.length === 0) {
    return {
      ok: false,
      error: 'launcher_not_found',
      packageName: ctx.packageName,
      launcherCandidates: candidates,
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      error: 'launcher_ambiguous',
      packageName: ctx.packageName,
      launcherCandidates: candidates,
      suggestion: 'Pass --component or --activity to choose the intended launcher Activity.',
    };
  }

  return startActivity(ctx, candidates[0], options, {
    packageName: ctx.packageName,
    launcherCandidates: candidates,
  });
}

async function launchActivity(ctx, options = {}) {
  const component = normalizeActivityComponent(
    ctx.packageName,
    options.component || requiredString(options.activity, 'activity'),
  );
  return startActivity(ctx, component, options, { packageName: ctx.packageName });
}

async function launchNativeTest(ctx) {
  const component = normalizeActivityComponent(ctx.packageName, ctx.nativeActivity);
  return startActivity(ctx, component, {}, { packageName: ctx.packageName });
}

async function launchFlutter(ctx, initialRoute) {
  const component = normalizeActivityComponent(ctx.packageName, ctx.flutterActivity);
  const options = initialRoute ? { extra: [`ai_app_initial_route=${initialRoute}`] } : {};
  const result = await startActivity(ctx, component, options, { packageName: ctx.packageName });
  return { ...result, initialRoute };
}

async function launcherActivityCandidates(ctx) {
  const result = await adb(ctx, [
    'shell',
    'cmd',
    'package',
    'query-activities',
    '--brief',
    '-a',
    'android.intent.action.MAIN',
    '-c',
    'android.intent.category.LAUNCHER',
    ctx.packageName,
  ]);
  return parseLauncherActivityCandidates(result.stdout);
}

function parseLauncherActivityCandidates(stdout) {
  const candidates = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const candidate = line.trim();
    if (/^[A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+$/.test(candidate) && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function normalizeActivityComponent(packageName, activityOrComponent) {
  const value = requiredString(activityOrComponent, 'activity');
  if (value.includes('/')) return value;
  return `${packageName}/${value}`;
}

async function startActivity(ctx, component, options = {}, extraResult = {}) {
  const args = buildAmStartArgs(component, options);
  const result = await adb(ctx, args);
  return {
    ok: true,
    transport: 'adb',
    component,
    ...extraResult,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function buildAmStartArgs(component, options = {}) {
  const args = ['shell', 'am', 'start'];
  if (options.action) args.push('-a', options.action);
  for (const category of optionList(options.category)) {
    args.push('-c', category);
  }
  if (options.data) args.push('-d', options.data);
  for (const extra of parseStartExtras(options.extra)) {
    args.push('-e', extra.key, extra.value);
  }
  args.push('-n', component);
  return args;
}

function parseStartExtras(rawExtras) {
  return optionList(rawExtras).map((rawExtra) => {
    const value = String(rawExtra);
    const separator = value.indexOf('=');
    if (separator <= 0) {
      throw new Error('extra must use key=value');
    }
    return {
      key: value.slice(0, separator),
      value: value.slice(separator + 1),
    };
  });
}

function optionList(value) {
  if (value === undefined || value === null || value === false || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

async function smoke(ctx, options) {
  const summary = {
    packageName: ctx.packageName,
    port: ctx.port,
    native: {},
    flutter: {},
  };

  await adb(ctx, ['shell', 'am', 'force-stop', ctx.packageName]);
  await sleep(700);
  await launchNativeTest(ctx);
  await sleep(2000);

  const status = await retry(() => bridgeGet(ctx, '/v1/status'), 10, 500);
  assert(status.ok, 'bridge status is ok');
  summary.native.statusOk = true;

  const tree = await bridgeGet(ctx, '/v1/view/tree');
  assert(tree.ok, 'native tree is ok');
  assert(findNodeByText(tree.root, 'AiApp Native Bridge Test').node, 'native title is visible in SDK tree');
  assert(findNodeByText(tree.root, 'Native Increment').node, 'native increment button is visible in SDK tree');
  summary.native.sdkTreeNodeCount = tree.nodeCount;

  const uiaXml = await uiaTree(ctx);
  assert(uiaXml.includes('AiApp Native Bridge Test'), 'uiautomator tree contains native title');
  summary.native.uiaTreeOk = true;

  const h5Dom = await bridgeGet(ctx, '/v1/h5/dom');
  assert(h5Dom.ok, 'native WebView DOM endpoint is ok');
  assert(h5Dom.dom?.bodyText?.includes('H5 DOM snapshot body text'), 'native WebView DOM contains body text');
  assert((h5Dom.dom?.controlCount || 0) >= 2, 'native WebView DOM contains controls');
  summary.native.h5DomControlCount = h5Dom.dom.controlCount;

  const h5ClickResult = await h5Click(ctx, { selector: '#native-h5-button' });
  assert(h5ClickResult.ok, 'native WebView h5-click endpoint is ok');
  assert(JSON.stringify(h5ClickResult.result).includes('Native H5 clicked'), 'native WebView h5-click changed DOM');
  const h5WaitResult = await h5Wait(ctx, { targetText: 'Native H5 clicked', timeoutSec: 5 });
  assert(h5WaitResult.ok, 'native WebView h5-wait observes clicked text');
  const h5InputResult = await h5Input(ctx, { selector: '#native-h5-input', value: 'ai_app h5 input' });
  assert(h5InputResult.ok, 'native WebView h5-input endpoint is ok');
  assert(h5InputResult.result?.value === 'ai_app h5 input', 'native WebView h5-input changed input value');
  await keyevent(ctx, 111);
  await sleep(300);
  const h5ScrollResult = await h5Scroll(ctx, { selector: '#native-h5-input' });
  assert(h5ScrollResult.ok, 'native WebView h5-scroll endpoint is ok');
  const h5DomAfterClick = await bridgeGet(ctx, '/v1/h5/dom');
  assert(JSON.stringify(h5DomAfterClick.dom).includes('Native H5 clicked'), 'native WebView DOM read sees click result');
  assert(JSON.stringify(h5DomAfterClick.dom).includes('ai_app h5 input'), 'native WebView DOM read sees input result');
  summary.native.h5ClickOk = true;
  summary.native.h5InputOk = true;
  summary.native.h5WaitOk = true;
  summary.native.h5ScrollOk = true;

  const webviewProbeUrl = `http://127.0.0.1:${ctx.devicePort || ctx.port}/v1/status?from=webview-cdp-smoke`;
  const webviewCdp = await webviewCdpCapture(ctx, {
    durationMs: 3000,
    pageUrlFilter: 'native-webview',
    urlFilter: 'webview-cdp-smoke',
    includeResponseBody: true,
    script: `(() => { const url = ${JSON.stringify(webviewProbeUrl)}; console.log('ai-bridge-webview-cdp-console', url); fetch(url).then((response) => { console.log('ai-bridge-webview-cdp-response', response.status); return response.text(); }).catch((error) => console.log('ai-bridge-webview-cdp-error', error.name + ':' + error.message)); return url; })()`,
  });
  const webviewCdpText = JSON.stringify(webviewCdp);
  assert(webviewCdp.requests.some((item) => String(item.url || item.responseUrl || '').includes('webview-cdp-smoke')), 'WebView CDP captured H5 network request');
  assert(webviewCdpText.includes('ai-bridge-webview-cdp-console'), 'WebView CDP captured console output');
  summary.native.webviewCdpOk = true;
  summary.native.webviewCdpCapture = webviewCdp.counts;

  const artifactPrefix = 'ai_app_bridge_smoke_screenshot';
  const screenshotPath = screenshotOutputPath(options, artifactPrefix);
  const screenshotResult = await screenshot(ctx, screenshotPath, { ...options, artifactPrefix });
  assert(screenshotResult.width > 0 && screenshotResult.height > 0, 'adb screenshot has size');
  summary.native.screenshot = {
    width: screenshotResult.width,
    height: screenshotResult.height,
    path: screenshotResult.path,
    artifact: screenshotResult.artifact,
  };

  await tapText(ctx, 'Native Increment');
  await sleep(700);
  const treeAfterTap = await bridgeGet(ctx, '/v1/view/tree');
  assert(findNodeByText(treeAfterTap.root, 'Native counter: 1').node, 'tap changed native counter');
  summary.native.tapChangedCounter = true;

  await tapText(ctx, 'native_input');
  await keyevent(ctx, 123);
  await inputText(ctx, 'ai_appsmoke');
  await keyevent(ctx, 111);
  await sleep(700);
  const treeAfterInput = await bridgeGet(ctx, '/v1/view/tree');
  assert(JSON.stringify(treeAfterInput.root).includes('ai_appsmoke'), 'adb input changed native text field');
  summary.native.inputTextOk = true;

  const eventsBefore = await bridgeGet(ctx, withQuery('/v1/events', { limit: 1 }));
  const sinceEventId = lastItem(eventsBefore.items)?.id || 0;

  await tapText(ctx, 'Record Log');
  await sleep(300);
  await tapText(ctx, 'Record Network');
  await sleep(300);
  await tapText(ctx, 'Record State');
  await sleep(300);
  await tapText(ctx, 'Record Event');
  await sleep(300);

  const listTree = await bridgeGet(ctx, '/v1/view/tree');
  assert(JSON.stringify(listTree.root).includes('Native List Row 24'), 'native long list row is present in bridge tree');
  summary.native.longListTreeOk = true;

  await tapText(ctx, 'Open Dialog');
  const dialogWait = await waitText(ctx, 'Native Dialog Title', 8);
  assert(dialogWait.ok, 'native dialog title appeared');
  await tapText(ctx, 'DIALOG CONFIRM');
  await sleep(500);

  const logs = await bridgeGet(ctx, '/v1/logs');
  const network = await bridgeGet(ctx, '/v1/network');
  const state = await bridgeGet(ctx, '/v1/state');
  const events = await bridgeGet(ctx, '/v1/events');
  assert(JSON.stringify(logs.items).includes('NativeBridgeTest'), 'logs endpoint contains native test entries');
  assert(JSON.stringify(network.items).includes('https://debug.local/native-test'), 'network endpoint contains native test request');
  assert(JSON.stringify(state.values).includes('native_test.screen'), 'state endpoint contains native test state');
  assert(JSON.stringify(events.items).includes('dialog_confirmed'), 'events endpoint contains dialog confirmation');
  summary.native.dialogOk = true;
  summary.native.capture = { logs: logs.count, network: network.count, state: state.count, events: events.count };

  const limitedLogs = await bridgeGet(ctx, withQuery('/v1/logs', { limit: 1 }));
  const eventsSince = await bridgeGet(ctx, withQuery('/v1/events', { sinceId: sinceEventId, limit: 20 }));
  assert(limitedLogs.count <= 1 && limitedLogs.limit === 1, 'logs endpoint honors limit query');
  assert(JSON.stringify(eventsSince.items).includes('dialog_confirmed'), 'events endpoint honors sinceId query');
  summary.native.captureQueryOk = true;

  const microphonePermission = 'android.permission.RECORD_AUDIO';
  const microphoneBefore = await permissionState(ctx, microphonePermission);
  if (microphoneBefore.ok && !microphoneBefore.granted) {
    await tapText(ctx, 'Request Microphone Permission');
    const permissionResult = await permissionDialog(ctx, {
      attempts: 10,
      intervalMs: 500,
      resourceId: 'permission_allow_one_time_button,permission_allow_foreground_only_button,permission_allow_button',
    });
    assert(permissionResult.ok, 'permission dialog allow button was tapped');
    await sleep(1000);
    const grantedMicrophone = await permissionState(ctx, microphonePermission);
    assert(grantedMicrophone.ok && grantedMicrophone.granted, 'microphone permission is granted after dialog handling');
    summary.native.permissionDialogOk = true;
    summary.native.permissionState = {
      permission: microphonePermission,
      granted: grantedMicrophone.granted,
      matched: permissionResult.matched,
    };
  } else {
    summary.native.permissionDialogSkipped = microphoneBefore.ok ? 'already_granted' : microphoneBefore.error;
  }

  let scrolledUiaXml = '';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    scrolledUiaXml = await uiaTree(ctx);
    if (scrolledUiaXml.includes('Native List Row 24') || scrolledUiaXml.includes('Finish')) {
      break;
    }
    await swipe(ctx, 540, 2100, 540, 500, 700);
    await sleep(800);
  }
  if (!scrolledUiaXml.includes('Native List Row 24') && !scrolledUiaXml.includes('Finish')) {
    throw new Error('native list bottom is not visible after repeated swipes');
  }
  summary.native.scrollOk = scrolledUiaXml.includes('Native List Row 24') || scrolledUiaXml.includes('Finish');

  let backLeftNative = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await keyevent(ctx, 4);
    await sleep(700);
    try {
      const statusAfterBack = await bridgeGet(ctx, '/v1/status');
      if (!String(statusAfterBack.activity?.current || '').includes('DebugBridgeNativeTestActivity')) {
        backLeftNative = true;
        break;
      }
    } catch (_) {
      backLeftNative = true;
      break;
    }
  }
  assert(backLeftNative, 'back left native debug activity');
  summary.native.backOk = true;

  if (!options.skipFlutterLaunch) {
    await launchFlutter(ctx, '');
    const flutterStatus = await waitFlutterLayout(ctx, 20);
    const layout = flutterStatus.flutter?.layout;
    assert(layout, 'flutter snapshot has layout');
    assert(layout.widgetDump?.ok === true, 'flutter widget dump is ok');
    assert(String(layout.widgetDump?.text || '').length > 0, 'flutter widget dump has text');
    summary.flutter.widgetDumpOk = true;
    summary.flutter.widgetDumpLength = layout.widgetDump.length;

    await flutterAction(ctx, { action: 'openHarness' });
    await sleep(1000);
    const flutterLogsBefore = await bridgeGet(ctx, withQuery('/v1/logs', { limit: 1 }));
    const flutterNetworkBefore = await bridgeGet(ctx, withQuery('/v1/network', { limit: 1 }));
    const sinceFlutterLogId = lastItem(flutterLogsBefore.items)?.id || 0;
    const sinceFlutterNetworkId = lastItem(flutterNetworkBefore.items)?.id || 0;

    await flutterAction(ctx, { action: 'tapText', text: 'Record Auto Log Fixture' });
    await sleep(800);
    const flutterAutoLogs = await bridgeGet(ctx, withQuery('/v1/logs', { sinceId: sinceFlutterLogId, limit: 20 }));
    assert(JSON.stringify(flutterAutoLogs.items).includes('ai_app auto debugPrint fixture'), 'flutter debugPrint auto log is captured');
    assert(JSON.stringify(flutterAutoLogs.items).includes('ai_app auto flutter error fixture'), 'flutter FlutterError auto log is captured');
    summary.flutter.autoLogCaptureOk = true;

    await flutterAction(ctx, { action: 'tapText', text: 'Run Dart HttpClient Fixture' });
    await sleep(1200);
    const flutterAutoNetwork = await bridgeGet(ctx, withQuery('/v1/network', { sinceId: sinceFlutterNetworkId, limit: 20 }));
    const flutterAutoNetworkText = JSON.stringify(flutterAutoNetwork.items);
    assert(flutterAutoNetworkText.includes('flutter-httpclient-auto'), 'flutter HttpClient auto network source is captured');
    assert(flutterAutoNetworkText.includes('/v1/events'), 'flutter HttpClient auto network URL is captured');
    assert(flutterAutoNetworkText.includes('dart_httpclient_fixture'), 'flutter HttpClient auto request body is captured');
    summary.flutter.autoHttpClientCaptureOk = true;

    summary.flutter.h5DomTested = false;
    summary.flutter.h5DomNote = 'Flutter WebView DOM requires a generic WebView adapter or controller registry, not app-specific route code.';
  }

  summary.ok = true;
  return summary;
}

async function waitFlutterLayout(ctx, attempts) {
  for (let index = 0; index < attempts; index += 1) {
    const status = await bridgeGet(ctx, '/v1/status');
    if (status.flutter?.layout?.widgetDump?.ok === true) {
      return status;
    }
    await sleep(700);
  }
  return bridgeGet(ctx, '/v1/status');
}

async function retry(action, attempts, delayMs) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

function lastItem(items) {
  return Array.isArray(items) && items.length > 0 ? items[items.length - 1] : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uiautomatorLockPath(ctx = {}) {
  const key = sanitizeLockKey([
    ctx.serial || 'default',
    ctx.adb || defaults.adb,
  ].join('-'));
  return path.join(os.tmpdir(), `ai-app-bridge-uiautomator-${key}.lock`);
}

function sanitizeLockKey(value) {
  return String(value || 'default').replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 120) || 'default';
}

async function withFileLock(lockPath, action, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 30000);
  const staleMs = Number(options.staleMs || 120000);
  const pollMs = Number(options.pollMs || 100);
  const startMs = Date.now();
  let handle = null;

  while (handle === null) {
    try {
      handle = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }));
      } catch (writeError) {
        try {
          fs.closeSync(handle);
        } catch (_) {
          // Ignore close failure while unwinding the lock creation failure.
        }
        try {
          fs.unlinkSync(lockPath);
        } catch (_) {
          // Ignore cleanup failure while preserving the original write error.
        }
        handle = null;
        throw writeError;
      }
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        removeStaleLock(lockPath, staleMs);
        if (Date.now() - startMs >= timeoutMs) {
          const timeout = new Error(`timed out waiting for lock: ${lockPath}`);
          timeout.code = 'LOCK_TIMEOUT';
          throw timeout;
        }
        await sleep(pollMs);
        continue;
      }
      throw error;
    }
  }

  try {
    return await action();
  } finally {
    try {
      fs.closeSync(handle);
    } catch (_) {
      // Ignore close failures; unlink below is the operation that releases the lock for peers.
    }
    try {
      fs.unlinkSync(lockPath);
    } catch (_) {
      // A stale-lock cleanup racing with process shutdown should not mask the original result.
    }
  }
}

function removeStaleLock(lockPath, staleMs) {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > staleMs) {
      fs.unlinkSync(lockPath);
    }
  } catch (_) {
    // Another process may have released the lock between the exists check and stat/unlink.
  }
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requiredNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} is required`);
  return number;
}

module.exports = {
  buildBridgeFailureResult,
  clearAppDataAdbArgs,
  defaultInstallerButtonTexts,
  artifactTimestamp,
  compactBridgeTree,
  compactStatus,
  compactUiaTree,
  defaultArtifactDirectory,
  defaultArtifactPath,
  findFlutterNode,
  findTappableNodeByText,
  filterLogcat,
  firstErrorLine,
  flutterNodePoint,
  flutterPhysicalViewport,
  helpText,
  installerButtonTextsForSurface,
  isAdbInputTextSafe,
  isLikelyInstallerSurface,
  nodeTapState,
  normalizeBridgeError,
  normalizeActivityComponent,
  parseWebViewDevToolsSockets,
  parseArgs,
  parseKeyboardState,
  parseLauncherActivityCandidates,
  parseStartExtras,
  parseUiaBounds,
  parseUiaViewport,
  parseComponentFromWindowLine,
  parseForegroundWindow,
  chooseWebViewDevToolsSocket,
  chooseWebViewPage,
  shapeNetworkCapture,
  compactNetworkRecord,
  pruneGeneratedArtifacts,
  shouldSkipInstallerTapForInstalledPackage,
  shouldDismissKeyboardForPoint,
  shouldUseDefaultPortFallback,
  screenshotOutputPath,
  statusSearchText,
  uiautomatorLockPath,
  verifyBridgeTargetPackage,
  waitTextConditionsMet,
  withFileLock,
};

