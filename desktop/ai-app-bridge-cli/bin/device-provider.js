'use strict';

const fs = require('fs');
const { CommandError, executionFields } = require('./command-errors');
const { createHash, randomUUID } = require('node:crypto');
const net = require('net');
const path = require('path');
const { runExecution, checkExecution, executionSleep, withoutExecution } = require('./shared-kernel/execution-scope');
const { execFileBounded, httpRequestBounded } = require('./shared-kernel/execution-io');
const { nativeWindow, nativeNodeIdentity, nativeWindowIdentity, nativeTargetRequest, selectNativeNode, revalidateNativeNode, explicitlyHidden, pointInsideBounds, validBounds } = require('./shared-kernel/native-target');
const { selectFlutterNode, flutterNodeIdentity, flutterTargetRequest, bindFlutterAction } = require('./shared-kernel/flutter-target');
const { executeFlutterAction, settlementProof: flutterSettlementProof } = require('./shared-kernel/flutter-execution');
const { executeNativeAction, settlementProof: nativeSettlementProof } = require('./shared-kernel/native-execution');
const { executeAndroidShell } = require('./shared-kernel/android-shell-execution');
const { createUiaRuntimePort } = require('./shared-kernel/uia-runtime-port');
const { executeUiaAction, observedTarget: observedUiaTarget, snapshotIdentity: uiaSnapshotIdentity,
  nodeTargetRef: uiaNodeTargetRef, bindingFromTargetRef: uiaBindingFromTargetRef } = require('./shared-kernel/uia-execution');
const { selectUiaNode } = require('./shared-kernel/uia-target');
const { schema: h5ExecutionSchema, executeH5Action, settlementProof: h5SettlementProof } = require('./shared-kernel/h5-execution');
const h5Target = require('./shared-kernel/android-h5-target');
const { isDeepStrictEqual } = require('node:util');
const { runDeviceEffect } = require('./shared-kernel/device-mutation-lease');
const { IOSBridgeProvider } = require('./ios-provider');
const { discoverAndroidSdkEndpoint } = require('./shared-kernel/android-sdk-endpoint');
const { createBridgeForward, verifyBridgeForward, removeBridgeForward } = require('./bridge-forward');
const { decodeXmlAttribute, parseXmlAttributes } = require('./shared-kernel/xml-attributes');
const {
  artifactTimestamp,
  defaultArtifactDirectory,
  defaultArtifactPath,
  pruneGeneratedArtifacts,
  sanitizeArtifactExtension,
  sanitizeArtifactName,
} = require('./artifact-paths');

const defaults = {
  adb: process.env.ADB || 'adb',
  adbTimeoutMs: Number(process.env.AI_APP_BRIDGE_ADB_TIMEOUT_MS || 15000),
  serial: '',
};

function createBridgeContext(options = {}) {
  return {
    adb: options.adb || defaults.adb,
    adbTimeoutMs: Number(options.adbTimeoutMs || defaults.adbTimeoutMs),
    httpTimeoutMs: options.timeoutMs ?? 10000,
    serial: options.serial || defaults.serial,
    port: options.port,
    explicitPort: options.port !== undefined,
    packageName: options.packageName,
    explicitPackageName: options.packageName !== undefined,
    actionId: options.runtimeActionId ?? options.requestId,
  };
}

async function executeProviderCommand(resolvedCommand, options) {
  if (isIOSCommand(resolvedCommand)) {
    return new IOSBridgeProvider().run(resolvedCommand, options);
  }

  const { isMutationCommand, executionTimeoutMs } = require('./command-registry');
  return runExecution({ timeoutMs: executionTimeoutMs(resolvedCommand, options), mutation: isMutationCommand(resolvedCommand, options) },
    () => runCommand(resolvedCommand, options, createBridgeContext(options)));
}

function isIOSCommand(command) {
  return String(command || '').startsWith('ios-');
}

async function runCommand(command, options, ctx) {
  switch (command) {
    case 'device-ownership':
      return require('./shared-kernel/device-ownership-recovery').deviceOwnership(options);
    case 'uia-runtime':
      return createUiaRuntimePort({ adb: ctx.adb, serial: ctx.serial, timeoutMs: ctx.httpTimeoutMs }).control(options.operation);
    case 'forward':
      return ensureForward(ctx);
    case 'remove-forward':
      return removeBridgeForward(ctx, adb);
    case 'status':
      return bridgeStatus(ctx, options);
    case 'ui-observation':
      return bridgeRequest(ctx, async () => {
        const path = require('./ui-observation').path(options);
        const result = JSON.parse(await httpPost(bridgeUrl(ctx, path), require('./ui-observation').request(options), ctx.httpTimeoutMs));
        verifyBridgeTargetPackage(ctx, result, path);
        return result;
      });
    case 'tree':
      return bridgeTree(ctx, options);
    case 'flutter-tree': {
      const status = await bridgeGet(ctx, '/v1/flutter/snapshot');
      if (status.ok === false) return status;
      return status.flutter?.layout || null;
    }
    case 'flutter-nodes':
      return flutterNodes(ctx);
    case 'tap-flutter':
      return flutterAction(ctx, options.selector ? { action: 'tapTarget', selector: options.selector } : flutterTapPayload(options), options);
    case 'tap-flutter-text':
      return tapText(ctx, requiredString(options.targetText, 'targetText'), { ...options, provider: 'flutter' });
    case 'input-flutter-text': {
      const result = await flutterAction(ctx, {
        action: 'inputText',
        text: requiredInputString(options.text, 'text'),
        ...(options.selector ? { selector: options.selector } : {}),
        ...(options.tapX !== undefined && options.tapY !== undefined ? { x: Number(options.tapX), y: Number(options.tapY) } : {}),
      }, options);
      if (result.ok && booleanOption(options.hideKeyboard)) {
        result.keyboard = await hideKeyboard(ctx, options);
      }
      return result;
    }
    case 'scroll-flutter':
      return options.targetText
        ? flutterAction(ctx, { action: 'scrollUntilText', text: options.targetText, maxSwipes: options.maxSwipes ?? 12, ...(options.selector ? { selector: options.selector } : {}) }, options)
        : flutterAction(ctx, { action: 'scrollBy', delta: options.delta ?? 420, ...(options.selector ? { selector: options.selector } : {}) }, options);
    case 'flutter-action':
      return flutterAction(ctx, options.payload, options);
    case 'logs':
      return bridgeGet(ctx, withQuery('/v1/logs', captureQuery(options)));
    case 'network':
      return networkRecords(ctx, options);
    case 'state':
      return bridgeGet(ctx, withQuery('/v1/state', captureQuery(options)));
    case 'events':
      return bridgeGet(ctx, withQuery('/v1/events', captureQuery(options)));
    case 'freeze-app':
      return freezeApp(ctx, options);
    case 'thaw-app':
      return thawApp(ctx, options);
    case 'h5-dom':
      return h5Dom(ctx, options);
    case 'h5-eval':
      return h5Eval(ctx, options);
    case 'h5-click':
      return h5Click(ctx, options);
    case 'h5-input':
      return h5Input(ctx, options);
    case 'h5-wait':
      return h5Wait(ctx, options);
    case 'h5-scroll':
      return h5Scroll(ctx, options);
    case 'flutter-h5-dom':
      return flutterH5Dom(ctx, options);
    case 'flutter-h5-eval':
      return flutterH5Eval(ctx, options);
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
      return tap(
        ctx,
        requiredNumber(options.tapX, 'tapX'),
        requiredNumber(options.tapY, 'tapY'),
        options,
      );
    case 'tap-text':
      return tapText(ctx, requiredString(options.targetText, 'targetText'), options);
    case 'tap-native':
      return tapNative(ctx, options);
    case 'wait-text':
      return waitText(ctx, options.targetText, options);
    case 'input-text':
      return options.selector
        ? inputNativeText(ctx, requiredInputString(options.text, 'text'), options)
        : inputText(ctx, requiredInputString(options.text, 'text'), options);
    case 'keyboard-state':
      return keyboardState(ctx);
    case 'hide-keyboard':
      return hideKeyboard(ctx, options);
    case 'clear-app-data':
      return clearAppData(ctx, options);
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
        options.durationMs ?? 300,
      );
    case 'native-gesture':
      return gestureNative(ctx, options.payload, options);
    case 'keyevent':
      return keyevent(ctx, options.keyCode ?? 4);
    case 'logcat':
      return logcat(ctx, options);
    case 'permission-state':
      return require('./android-permissions').readPermissionState(options);
    case 'permission-grant':
      return require('./android-permissions').changePermission(options, 'grant');
    case 'permission-revoke':
      return require('./android-permissions').changePermission(options, 'revoke');
    case 'appops-set':
      return appopsSet(ctx, requiredString(options.op, 'op'), requiredString(options.mode, 'mode'));
    case 'tap-uia-text':
      return tapUiaText(ctx, requiredString(options.targetText, 'targetText'), options);
    case 'tap-uia':
      return tapUia(ctx, options);
    case 'launch-app':
      return launchApp(ctx, options);
    case 'launch-activity':
      return launchActivity(ctx, options);
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

async function adb(ctx, args, { binary = false, mutation = false } = {}) {
  if (mutation && args[0] === 'shell') {
    return executeAndroidShell({ adb: ctx.adb, serial: ctx.serial, argv: args.slice(1),
      timeoutMs: ctx.adbTimeoutMs, actionId: ctx.actionId });
  }
  const allArgs = adbArgs(ctx, args);
  const execute = () => execFileBounded(ctx.adb, allArgs, {
    encoding: binary ? 'buffer' : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeoutMs: ctx.adbTimeoutMs || defaults.adbTimeoutMs,
    mutation,
    windowsHide: true,
  });
  return mutation ? runDeviceEffect({ kind: 'adb', commandSha256: createHash('sha256').update(JSON.stringify(allArgs)).digest('hex') }, execute) : execute();
}

async function adbBinaryToFile(ctx, args, outFile) {
  const { stdout } = await adb(ctx, args, { binary: true });
  checkExecution();
  await fs.promises.mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
  await fs.promises.writeFile(outFile, stdout);
  return path.resolve(outFile);
}

function adbArgs(ctx, args) {
  const allArgs = [];
  if (ctx.serial) allArgs.push('-s', ctx.serial);
  allArgs.push(...args);
  return allArgs;
}

async function ensureForward(ctx) {
  // Resolve the device before reading its App-private endpoint. Every request observes
  // the current runtime; no cached port or retry can select a previous App process.
  if (!ctx.serial) ctx.serial = (await adb(ctx, ['get-serialno'])).stdout.trim();
  ctx.endpoint = null;
  ctx.hostPort = null;
  const endpoint = await discoverAndroidSdkEndpoint(ctx, adb);
  ctx.endpoint = endpoint;
  const connection = { ...await createBridgeForward(ctx, endpoint, adb), endpoint };
  await verifyBridgeForward(ctx, connection, adb);
  ctx.hostPort = connection.hostPort;
  return {
    ok: true,
    forward: `tcp:${connection.hostPort} -> localabstract:${endpoint.socketName}`,
    hostPort: connection.hostPort,
    endpoint,
    reused: connection.reused,
  };
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
    dispatched: error.dispatched ?? false,
    ambiguous: error.ambiguous ?? false,
    packageName: ctx.packageName,
    attempted: {
      host: '127.0.0.1',
      localPort: ctx.hostPort ?? null,
      requestedLocalPort: ctx.port ?? null,
      endpoint: ctx.endpoint ?? null,
      url: ctx.hostPort ? bridgeUrl(ctx, requestPath) : null,
    },
    suggestion: normalized.suggestion,
  };
}

function normalizeBridgeError(error) {
  if (error instanceof CommandError) return { code: error.code, message: error.message };
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
      suggestion: 'Confirm the target app is running and its current SDK endpoint is ready.',
    };
  }
  if (lower.includes('adb timed out')) {
    return {
      code: 'adb_timeout',
      message,
      suggestion: 'Check the device connection. SDK endpoint discovery must finish before any HTTP request.',
    };
  }
  if (error?.aiAppBridgeForwardMismatch) {
    return {
      code: 'bridge_forward_mismatch',
      message,
      suggestion: 'The ADB mapping is missing or belongs to another target. Inspect the forwards and observe the target again before a new action.',
    };
  }
  if (error?.aiAppBridgePackageMismatch || lower.includes('bridge package mismatch')) {
    return {
      code: 'bridge_package_mismatch',
      message,
      suggestion: 'The SDK endpoint or response belongs to another package. Inspect the requested package before a new operation.',
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
  return bridgeRequest(ctx, async () => {
    const body = await httpGet(bridgeUrl(ctx, requestPath), ctx.httpTimeoutMs);
    const payload = JSON.parse(body);
    verifyBridgeTargetPackage(ctx, payload, requestPath);
    return payload;
  });
}

async function bridgePost(ctx, requestPath, payload) {
  return bridgeRequest(ctx, () => runDeviceEffect({ kind: 'sdk-http', path: requestPath,
    target: { packageName: ctx.packageName, adb: ctx.adb, ...(ctx.explicitPort ? { port: ctx.port } : {}) } }, async () => {
    const body = await httpPost(bridgeUrl(ctx, requestPath), payload, ctx.httpTimeoutMs);
    const responsePayload = JSON.parse(body);
    verifyBridgeTargetPackage(ctx, responsePayload, requestPath);
    return responsePayload;
  }));
}

async function bridgeRequest(ctx, request, { ensureForward: prepare = ensureForward } = {}) {
  checkExecution();
  try { await prepare(ctx); }
  catch (error) { error.aiAppBridgeRequestNotStarted = true; throw error; }
  checkExecution();
  return request();
}

function bridgeUrl(ctx, requestPath) {
  if (!ctx.hostPort) throw new CommandError('bridge_not_ready', 'SDK endpoint has not been connected.');
  return `http://127.0.0.1:${ctx.hostPort}${requestPath}`;
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

function httpGet(url, timeoutMs = 10000) {
  return httpRequestBounded(url, { timeoutMs });
}

function httpPost(url, payload, timeoutMs = 20000) {
  return httpRequestBounded(url, { method: 'POST', payload: payload || {}, timeoutMs });
}

function captureQuery(options) {
  return {
    sinceId: options.sinceId,
    sinceMs: options.sinceMs,
    limit: options.limit,
    view: options.view ?? (booleanOption(options.history) ? 'connected-history' : undefined),
    runtimeEpoch: options.runtimeEpoch,
    afterActionId: options.afterActionId,
    factCursor: options.factCursor,
    mobileFactId: options.mobileFactId,
    targetKey: options.targetKey,
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
    if (Array.isArray(capture.refs) && capture.refs.length === sourceItems.length) {
      const retained = new Set(filteredItems);
      result.refs = capture.refs.filter((_ref, index) => retained.has(sourceItems[index]));
    }
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
      scriptResult = await runDeviceEffect({ kind: 'android-cdp', actionId: ctx.actionId,
        target: { serial: ctx.serial, packageName: ctx.packageName, pageId: setup.page.id } }, () => cdp.send('Runtime.evaluate', {
        expression: String(options.script),
        awaitPromise: true,
        returnByValue: true,
      }));
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

async function freezeApp(ctx, options = {}) {
  return signalAppProcesses(ctx, options, 'SIGSTOP', 'freeze-app');
}

async function thawApp(ctx, options = {}) {
  return signalAppProcesses(ctx, options, 'SIGCONT', 'thaw-app');
}

async function signalAppProcesses(ctx, options, signal, action) {
  const pids = await targetAppPids(ctx, options);
  if (pids.length === 0) {
    return {
      ok: false,
      packageName: ctx.packageName,
      action,
      signal,
      error: 'app_process_not_found',
    };
  }

  const results = [];
  for (const pid of pids) {
    try {
      const result = await adb(ctx, ['shell', 'run-as', ctx.packageName, 'kill', `-${signal}`, pid], { mutation: true });
      results.push({
        pid,
        ok: true,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        ...executionFields(result),
      });
    } catch (error) {
      results.push({
        pid,
        ok: false,
        error: firstErrorLine(error),
        ...executionFields(error),
      });
      if (error.settled === false) break;
    }
  }

  const failed = results.filter((item) => !item.ok);
  return {
    ok: failed.length === 0,
    packageName: ctx.packageName,
    action,
    signal,
    pids,
    results,
    executionReceipts: results.flatMap(result => result.executionReceipt ? [result.executionReceipt] : []),
    ...(failed.length > 0 ? { error: 'signal_failed' } : {}),
  };
}

async function targetAppPids(ctx, options = {}) {
  if (options.pid && options.pid !== true && options.pid !== 'current') {
    const explicitPid = String(options.pid).trim();
    return /^\d+$/.test(explicitPid) ? [explicitPid] : [];
  }
  const psPids = await packagePidsFromPs(ctx);
  if (psPids.length > 0) return psPids;
  return packagePidsFor(ctx);
}

async function packagePidsFromPs(ctx) {
  if (!ctx.packageName) return [];
  try {
    const result = await adb(ctx, ['shell', 'ps', '-A', '-o', 'PID,NAME']);
    return parsePackagePidsFromPs(result.stdout, ctx.packageName);
  } catch (_) {
    return [];
  }
}

function parsePackagePidsFromPs(stdout, packageName) {
  const pids = [];
  const seen = new Set();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^PID\s+NAME$/i.test(trimmed)) continue;
    const match = /^(\d+)\s+(\S+)$/.exec(trimmed);
    if (!match) continue;
    const pid = match[1];
    const processName = match[2];
    if (processName !== packageName && !processName.startsWith(`${packageName}:`)) continue;
    if (seen.has(pid)) continue;
    seen.add(pid);
    pids.push(pid);
  }
  return pids;
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
    await adb(ctx, ['forward', '--remove', `tcp:${port}`], { mutation: true });
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
  return uiaTreeOnce(ctx);
}

async function uiaTreeOnce(ctx) {
  const snapshot = await createUiaRuntimePort({ adb: ctx.adb, serial: ctx.serial, timeoutMs: ctx.httpTimeoutMs }).observe();
  return snapshot.xml;
}

async function uiaTap(ctx, binding, options = {}) {
  return executeUiaAction({ adb: ctx.adb, serial: ctx.serial, binding,
    actionId: options.runtimeActionId ?? ctx.actionId, timeoutMs: ctx.httpTimeoutMs });
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
  const snapshot = uiaSnapshotIdentity(text);
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
    if (snapshot) node.targetRef = uiaNodeTargetRef(snapshot, attrs);
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
      sha256: createHash('sha256').update(fs.readFileSync(resolvedPath)).digest('hex'),
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
  if (ctx.explicitPackageName) {
    result.foregroundMatchesPackage = foreground.packageName === ctx.packageName;
    if (!foreground.ok || !result.foregroundMatchesPackage) {
      result.ok = false;
      result.error = foreground.ok ? 'foreground_package_mismatch' : (foreground.error || 'foreground_probe_failed');
      result.warning = foreground.ok
        ? `screenshot captured foreground package ${foreground.packageName}, not requested package ${ctx.packageName}`
        : 'screenshot could not verify the foreground package';
    }
  }
  return result;
}

function screenshotOutputPath(options = {}, prefix = 'ai_app_bridge_screenshot') {
  if (options.outFile) return options.outFile;
  return defaultArtifactPath(prefix, 'png', { artifactDir: options.artifactDir });
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
    if (error instanceof CommandError) throw error;
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

async function tap(ctx, x, y, options, dependencies = {}) {
  checkExecution();
  const runAdb = dependencies.adb || adb;
  const readForeground = dependencies.foregroundWindow || foregroundWindow;
  if (options?.nativeTarget && (!ctx.explicitPackageName || options.scope === 'device')) {
    return { ok: false, error: 'native_target_requires_app_scope', dispatched: false, ambiguous: false };
  }
  if (!ctx.explicitPackageName) {
    const result = await runAdb(ctx, ['shell', 'input', 'tap', String(x), String(y)], { mutation: true });
    return { ok: true, transport: 'adb', x, y, ...executionFields(result) };
  }

  const foreground = await readForeground(ctx);
  if (!foreground.ok || foreground.packageName !== ctx.packageName) {
    return {
      ok: false,
      error: foreground.ok ? 'foreground_package_mismatch' : 'foreground_probe_failed',
      message: foreground.ok ? 'The foreground app does not match the requested app. Observe the target again.' : 'The foreground app could not be verified.',
      dispatched: false,
      ambiguous: false,
      transport: null,
      x,
      y,
      target: { packageName: ctx.packageName },
      targetFeedback: {
        status: 'unavailable',
        reason: foreground.ok ? 'foreground_package_mismatch' : 'foreground_probe_failed',
        foreground,
      },
    };
  }

  if (options?.scope === 'device') {
    const result = await runAdb(ctx, ['shell', 'input', 'tap', String(x), String(y)], { mutation: true });
    return { ok: true, transport: 'adb', x, y, target: { packageName: ctx.packageName }, ...executionFields(result) };
  }

  try {
    const runtimeActionId = options?.runtimeActionId ?? options?.requestId;
    const result = await nativeAction(ctx, options?.nativeTarget ? '/v1/action/tap-target' : '/v1/action/tap', {
      ...(options?.nativeTarget || { x, y }),
      ...(runtimeActionId === undefined || runtimeActionId === null
        ? {}
        : { actionId: String(runtimeActionId) }),
    }, dependencies);
    return { ...result, transport: 'bridge' };
  } catch (error) {
    checkExecution();
    if (!bridgeTapWasDefinitelyNotDispatched(error)) throw error;
    return {
      ok: false,
      error: options?.nativeTarget ? 'native_atomic_target_unavailable' : 'app_action_unavailable',
      message: options?.nativeTarget ? 'The app SDK cannot validate this target. Update the SDK and observe again.'
        : 'The app SDK cannot accept this action. Device input requires explicit scope: device.',
      dispatched: false,
      ambiguous: false,
      transport: null,
      x,
      y,
      target: null,
      targetFeedback: {
        status: 'unavailable',
        reason: 'bridge_action_unavailable',
        error: firstErrorLine(error),
      },
    };
  }
}

function bridgeTapWasDefinitelyNotDispatched(error) {
  if (error?.aiAppBridgeRequestNotStarted === true) return true;
  if (error?.code === 'ECONNREFUSED') return true;
  return /^HTTP 404:/.test(String(error?.message || error || ''));
}

async function tapText(ctx, targetText, options = {}, dependencies = {}) {
  checkExecution();
  const readForeground = dependencies.foregroundWindow || foregroundWindow;
  const foreground = await readForeground(ctx);
  if (!foreground.ok || (ctx.explicitPackageName && foreground.packageName !== ctx.packageName)) {
    return { ok: false, error: foreground.ok ? 'foreground_package_mismatch' : 'foreground_probe_failed',
      dispatched: false, ambiguous: false, foreground };
  }
  const selectedProvider = options.provider || 'auto';
  const providers = selectedProvider === 'auto' ? ['native', 'flutter', 'uia'] : [selectedProvider];
  const observations = [];
  let nativeForeground;
  const reject = (error, message) => ({ ok: false, error, message, targetText, dispatched: false, ambiguous: false, observations });
  async function readMatch(provider) {
    checkExecution();
    if (provider === 'native') {
      const tree = await (dependencies.bridgeTree || bridgeTree)(ctx);
      if (tree?.ok === false) throw new CommandError('observation_unavailable', tree.error || 'native_tree_unavailable');
      nativeForeground = nativeWindow(tree);
      const found = findTappableNodeByText(tree, targetText);
      if (found.ambiguous) throw new CommandError('target_ambiguous', 'Several native Views match targetText. Use tap-native or Intent with a precise selector.');
      if (!found.node) return null;
      return { x: (found.node.bounds.left + found.node.bounds.right) / 2,
        y: (found.node.bounds.top + found.node.bounds.bottom) / 2, node: bridgeNodeTarget(found.node, found.windowType),
        guarded: nativeTargetRequest(found.node, found.node.text === targetText ? { text: targetText } : { contentDescription: targetText }),
        identity: { window: nativeWindowIdentity(nativeForeground), node: nativeNodeIdentity(found.node) }, coordinateSpace: 'physical-pixels' };
    }
    if (provider === 'flutter') {
      // Flutter coordinates belong to the activity. A native dialog owns input.
      if (nativeForeground === undefined || selectedProvider === 'flutter') {
        nativeForeground = nativeWindow(await (dependencies.bridgeTree || bridgeTree)(ctx));
      }
      if (nativeForeground?.type !== 'activity') throw new CommandError('native_foreground_blocks_flutter', 'Observe the foreground native window before targeting Flutter.');
      const selected = selectFlutterNode(await (dependencies.flutterNodes || flutterNodes)(ctx), { text: targetText });
      if (selected.error === 'flutter_selector_not_unique') throw new CommandError('target_ambiguous', 'Several Flutter nodes match targetText. Use Intent with a precise selector.');
      if (!selected.ok) {
        if (selected.error === 'flutter_selector_not_found') return null;
        throw new CommandError(selected.error, 'The Flutter target could not be observed.');
      }
      return { ...selected, guarded: flutterTargetRequest(selected.node, { text: targetText }), identity: flutterNodeIdentity(selected.node), coordinateSpace: 'flutter-logical-pixels' };
    }
    const xml = await (dependencies.uiaTree || uiaTree)(ctx);
    const node = findUiaNodeByAny(xml, { texts: [targetText], exact: true, requireUnique: true, packageName: foreground.packageName });
    if (!node) return null;
    const selector = node.rawNode.text === targetText ? { text: targetText } : { contentDescription: targetText };
    return { node: node.matched, binding: observedUiaTarget(xml, node.rawNode, selector, foreground.packageName) };
  }
  for (const provider of providers) {
    let match;
    try { match = await readMatch(provider); }
    catch (error) {
      checkExecution();
      observations.push({ provider, status: 'unavailable', error: error.code || error.message });
      if (error.code === 'target_ambiguous' || selectedProvider !== 'auto') return reject(error.code || 'observation_unavailable', error.message);
      continue;
    }
    observations.push({ provider, status: match ? 'matched' : 'not-found', observedAtMs: Date.now() });
    if (!match) continue;
    // A selected provider owns this attempt. Fresh selection may reject it but
    // cannot trigger an input through another provider.
    let currentMatch = match;
    try {
      if (provider === 'flutter') nativeForeground = undefined;
      if (provider !== 'uia') currentMatch = await readMatch(provider);
    } catch (error) {
      checkExecution();
      return reject(error.code || 'observation_unavailable', error.message);
    }
    if (!currentMatch || provider !== 'uia' && JSON.stringify(match.identity) !== JSON.stringify(currentMatch.identity)) return reject('reobserve_required', 'The selected target changed before dispatch.');
    match = currentMatch;
    if (['native', 'flutter'].includes(provider) && !match.guarded.ok) return { ...match.guarded, targetText, provider, observations };
    if (provider !== 'uia' && (!Number.isFinite(match.x) || !Number.isFinite(match.y) || match.x < 0 || match.y < 0)) return reject('invalid_observed_coordinates');
    const current = await readForeground(ctx);
    if (!current.ok || current.component !== foreground.component || current.packageName !== foreground.packageName) return reject('foreground_changed_during_observation');
    checkExecution();
    const revalidatedAtMs = Date.now();
    const result = provider === 'uia'
      ? await (dependencies.uiaTap || uiaTap)(ctx, match.binding, options)
      : provider === 'flutter'
      ? await (dependencies.flutterAction || flutterAction)(ctx, { action: 'tapTarget', ...match.guarded.request }, options)
      : await (dependencies.tap || tap)(ctx, Math.round(match.x), Math.round(match.y), { ...options,
        nativeTarget: match.guarded.request, scope: 'app' });
    return { ...result, targetText, provider, source: provider === 'native' ? 'bridge-tree' : provider === 'flutter' ? 'flutter-operable-tree' : 'uia-node-runtime',
      ...(provider === 'uia' ? {} : { coordinateSpace: match.coordinateSpace }), selected: match.node, revalidatedAtMs, observations };
  }
  return reject('target_not_found', 'No observed provider has a unique operable match.');
}

function bridgeNodeTarget(node, windowType) {
  return {
    className: node?.className || node?.simpleClassName || '',
    resourceName: node?.resourceName || node?.resourceId || '',
    clickable: Boolean(node?.clickable),
    enabled: node?.enabled !== false,
    windowType: windowType || 'window',
    bounds: node?.bounds || null,
  };
}

function findTappableNodeByText(tree, targetText) {
  const window = nativeWindow(tree);
  if (!window) return { node: null, rejected: { reason: 'visible_observed_window_required' } };
  const result = findNodeByText(window.root, targetText, window.bounds);
  return { ...result, windowType: window.type, viewport: window.bounds };
}

function findNodeByText(node, targetText, viewport = null) {
  const matches = [];
  let rejected = null;
  function visit(current, ancestors = []) {
    if (!current || explicitlyHidden(current)) return;
    if (current.text === targetText || current.contentDescription === targetText) {
      const state = nodeTapState(current, viewport);
      if (state.ok && ancestors.some(ancestor => ancestor.enabled === false || !validBounds(ancestor.bounds)
        || !pointInsideBounds({ x: (current.bounds.left + current.bounds.right) / 2, y: (current.bounds.top + current.bounds.bottom) / 2 }, ancestor.bounds))) {
        state.ok = false; state.reason = 'center_outside_ancestor';
      }
      if (state.ok) matches.push(current);
      else rejected ||= { node: current, viewport, reason: state.reason };
    }
    for (const child of current.children || []) visit(child, [...ancestors, current]);
  }
  visit(node);
  return { node: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1, rejected };
}

function nodeTapState(node, viewport) {
  const bounds = node?.bounds;
  if (!validBounds(bounds)) return { ok: false, reason: 'invalid_bounds' };
  if (node.visible === false || node.effectiveVisible === false || (node.visible !== true && node.effectiveVisible !== true)) {
    return { ok: false, reason: 'not_effectively_visible' };
  }
  if (node.enabled === false) {
    return { ok: false, reason: 'not_enabled' };
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
    centerX >= Number(viewport.right) ||
    centerY < Number(viewport.top) ||
    centerY >= Number(viewport.bottom)
  ) {
    return { ok: false, reason: 'center_outside_viewport' };
  }
  return { ok: true };
}

function findUiaNodeByText(xml, targetText) {
  return findUiaNodeByAny(xml, { texts: [targetText], exact: true });
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
  if (options.exact === false) throw new CommandError('invalid_argument', 'Text actions require an exact match. Use an observed Intent selector.');
  return tapText(ctx, targetText, { ...options, provider: 'uia' });
}

async function bindNativeCommandTarget(ctx, selector, editable, dependencies) {
  checkExecution();
  if (!ctx.explicitPackageName) return { ok: false, error: 'native_target_requires_app_scope', dispatched: false, ambiguous: false };
  const readForeground = dependencies.foregroundWindow || foregroundWindow;
  const foreground = await readForeground(ctx);
  if (!foreground.ok || foreground.packageName !== ctx.packageName) return {
    ok: false, error: foreground.ok ? 'foreground_package_mismatch' : 'foreground_probe_failed', dispatched: false, ambiguous: false,
  };
  const readTree = () => (dependencies.bridgeTree || bridgeTree)(ctx);
  const selected = await revalidateNativeNode(readTree, await readTree(), { selector }, editable);
  if (!selected.ok) return { ...selected, ambiguous: false };
  const binding = nativeTargetRequest(selected.node, selector);
  if (!binding.ok) return binding;
  const current = await readForeground(ctx);
  if (!current.ok || current.component !== foreground.component || current.packageName !== foreground.packageName) return {
    ok: false, error: 'foreground_changed_during_observation', dispatched: false, ambiguous: false,
  };
  checkExecution();
  return { ok: true, selected, nativeTarget: binding.request };
}

async function tapNative(ctx, options = {}, dependencies = {}) {
  const binding = await bindNativeCommandTarget(ctx, options.selector, false, dependencies);
  if (!binding.ok) return binding;
  const { selected } = binding;
  const result = await tap(ctx, selected.x, selected.y, { ...options, nativeTarget: binding.nativeTarget, scope: 'app' }, dependencies);
  return { ...result, provider: 'native', source: 'bridge-tree', selector: options.selector };
}

async function inputNativeText(ctx, text, options = {}, dependencies = {}) {
  if (Object.hasOwn(options, 'tapX') || Object.hasOwn(options, 'tapY'))
    throw new CommandError('invalid_argument', 'A Native selector and input coordinates are mutually exclusive.', { field: 'selector' });
  const binding = await bindNativeCommandTarget(ctx, options.selector, true, dependencies);
  if (!binding.ok) return binding;
  const result = await inputText(ctx, text, { ...options, nativeTarget: binding.nativeTarget }, dependencies);
  return { ...result, provider: 'native', source: 'bridge-tree', selector: options.selector };
}

async function tapUia(ctx, options = {}) {
  checkExecution();
  const foreground = await foregroundWindow(ctx);
  if (!foreground.ok || foreground.packageName !== ctx.packageName)
    return { ok: false, error: foreground.ok ? 'foreground_package_mismatch' : 'foreground_probe_failed',
      dispatched: false, ambiguous: false, foreground };
  let binding;
  if (options.targetRef) binding = uiaBindingFromTargetRef(options.targetRef, ctx.packageName);
  else {
    const xml = await uiaTree(ctx);
    const selected = selectUiaNode(xml, { selector: options.selector }, ctx.packageName);
    if (!selected.ok) return { ...selected, ambiguous: false,
      message: `UIAutomator selector did not identify one enabled visible node: ${selected.error}.`, selector: options.selector };
    binding = observedUiaTarget(xml, selected.node, options.selector, ctx.packageName);
  }
  const current = await foregroundWindow(ctx);
  if (!current.ok || current.component !== foreground.component || current.packageName !== foreground.packageName)
    return { ok: false, error: 'foreground_changed_during_observation', dispatched: false, ambiguous: false };
  checkExecution();
  const result = await uiaTap(ctx, binding, options);
  return { ...result, provider: 'uia', source: 'uia-node-runtime',
    ...(options.targetRef ? { targetRef: options.targetRef } : { selector: options.selector }) };
}

function findUiaNodeByAny(xml, options) {
  const texts = (options.texts || []).map(String).filter(Boolean);
  const resourceIds = (options.resourceIds || []).map(String).filter(Boolean);
  const exact = Boolean(options.exact);
  const nodeRegex = /<node\b[^>]*>/g;
  const matches = [];
  let match;
  while ((match = nodeRegex.exec(xml)) !== null) {
    const nodeXml = match[0];
    const rawNode = parseXmlAttributes(nodeXml);
    if (options.packageName !== undefined && rawNode.package !== options.packageName) continue;
    if (rawNode['visible-to-user'] === 'false') continue;
    const attrs = {
      text: decodeXmlAttribute(readXmlAttribute(nodeXml, 'text')),
      contentDescription: decodeXmlAttribute(readXmlAttribute(nodeXml, 'content-desc')),
      resourceId: decodeXmlAttribute(readXmlAttribute(nodeXml, 'resource-id')),
      className: decodeXmlAttribute(readXmlAttribute(nodeXml, 'class')),
      clickable: readXmlAttribute(nodeXml, 'clickable') === 'true',
      enabled: readXmlAttribute(nodeXml, 'enabled') !== 'false',
    };
    if (!attrs.enabled || (options.requireClickable && !attrs.clickable)) continue;
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
    if (Number(boundsMatch[3]) <= Number(boundsMatch[1]) || Number(boundsMatch[4]) <= Number(boundsMatch[2])) continue;
    const found = {
      rawNode,
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
    if (!options.requireUnique) return found;
    matches.push(found);
  }
  if (matches.length > 1) throw new CommandError('target_ambiguous', 'Several UIAutomator nodes match the label. Use tap-uia or Intent with an explicit text, contentDescription or resourceName selector.');
  return matches[0] || null;
}

function readXmlAttribute(xml, name) {
  const match = new RegExp(`\\b${escapeRegExp(name)}="([^"]*)"`).exec(xml);
  return match ? match[1] : '';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function waitText(ctx, targetText, options = {}, dependencies = {}) {
  return require('./shared-kernel/text-wait').waitForText({
    options: { ...options, targetText, packageName: ctx.explicitPackageName ? ctx.packageName : undefined },
    readForeground: () => (dependencies.foregroundWindow || foregroundWindow)(ctx),
    readTree: provider => provider === 'native' ? (dependencies.bridgeTree || bridgeTree)(ctx)
      : provider === 'flutter' ? (dependencies.flutterNodes || flutterNodes)(ctx) : (dependencies.uiaTreeOnce || uiaTreeOnce)(ctx),
  });
}

async function flutterNodes(ctx) {
  const status = await bridgeGet(ctx, '/v1/flutter/snapshot');
  if (status.ok === false) return status;
  return status.flutter?.layout?.operable || { ok: false, error: 'no_flutter_operable_tree' };
}

function flutterTapPayload(options) {
  const point = {};
  for (const [option, axis] of [['tapX', 'x'], ['tapY', 'y']]) {
    const value = options[option];
    if (!(typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
      || !Number.isFinite(Number(value)) || Number(value) < 0) {
      throw new Error('invalid_flutter_coordinates');
    }
    point[axis] = Number(value);
  }
  return { action: 'tapAt', ...point };
}

async function flutterAction(ctx, payload, options = {}) {
  if (!['h5Adapters', 'h5Dom'].includes(payload.action)) {
    const foreground = await foregroundWindow(ctx);
    if (!foreground.ok || foreground.packageName !== ctx.packageName) return {
      ok: false, error: foreground.ok ? 'foreground_package_mismatch' : 'foreground_probe_failed', dispatched: false, ambiguous: false,
    };
    const window = nativeWindow(await bridgeTree(ctx));
    if (!window || window.type !== 'activity') return { ok: false, error: 'native_foreground_blocks_flutter', dispatched: false, ambiguous: false };
  }
  const tree = await flutterNodes(ctx);
  if (['tapText', 'tapTarget', 'inputText', 'scrollBy', 'scrollUntilText'].includes(payload.action) && !payload.targetRef) {
    const bound = bindFlutterAction(tree, payload);
    if (!bound.ok) return bound;
    payload = bound.payload;
  }
  const actionId = options.runtimeActionId ?? options.requestId ?? ctx.actionId ?? randomUUID();
  const requestCtx = { ...ctx };
  const identity = { actionId: requiredString(actionId, 'actionId'), runtimeEpoch: tree.runtimeEpoch };
  const target = { packageName: ctx.packageName, adb: ctx.adb, ...(ctx.explicitPort ? { port: ctx.port } : {}) };
  const result = await runDeviceEffect({ kind: 'flutter', ...identity, target }, () => executeFlutterAction({ tree, payload,
    actionId: identity.actionId, timeoutMs: ctx.httpTimeoutMs,
    send: request => bridgePost(requestCtx, '/v1/flutter/action', request),
    cancel: identity => httpPost(bridgeUrl(requestCtx, '/v1/flutter/cancel'), identity, 4000).then(JSON.parse),
  }), result => flutterSettlementProof(result, identity));
  return { ...result, transport: 'bridge', source: 'flutter-runtime-action' };
}

async function flutterCompletion(ctx, identity) {
  await bridgeGet(ctx, '/v1/status');
  return bridgePost(ctx, '/v1/flutter/cancel', identity);
}

async function h5Foreground(ctx) {
  const foreground = await foregroundWindow(ctx);
  return foreground.ok && foreground.packageName === ctx.packageName ? null : {
    ok: false, error: foreground.ok ? 'foreground_package_mismatch' : 'foreground_probe_failed', dispatched: false, ambiguous: false,
  };
}

async function h5Dom(ctx, options = {}) {
  const rejected = await h5Foreground(ctx);
  if (rejected) return rejected;
  const result = await bridgeGet(ctx, withQuery('/v1/h5/dom', options.webViewId === undefined ? {} : { webViewId: options.webViewId }));
  if (result.ok !== true) return result;
  if (result.h5TargetSchema !== h5Target.schema) return { ok: false, error: 'android_h5_target_schema_required', dispatched: false, ambiguous: false };
  const changed = await h5Foreground(ctx);
  return changed || result;
}

async function h5Action(ctx, payload) {
  const rejected = await h5Foreground(ctx);
  if (rejected) return rejected;
  const status = await bridgeGet(ctx, '/v1/status');
  const runtime = { runtimeEpoch: status.debugBridge?.runtimeEpoch, executionSchema: status.debugBridge?.h5ExecutionSchema };
  if (runtime.executionSchema !== h5ExecutionSchema || status.debugBridge?.h5TargetSchema !== h5Target.schema) return {
    ok: false, error: 'h5_execution_unavailable', dispatched: false, ambiguous: false,
    message: 'The app SDK must advertise managed H5 execution and Android H5 target binding.',
  };
  if (runtime.runtimeEpoch !== payload.pageRef.runtimeEpoch) return {
    ok: false, error: 'reobserve_required', dispatched: false, ambiguous: false,
  };
  const identity = { actionId: ctx.actionId ?? randomUUID(), runtimeEpoch: runtime.runtimeEpoch };
  const target = { packageName: ctx.packageName, adb: ctx.adb, ...(ctx.explicitPort ? { port: ctx.port } : {}) };
  const requestCtx = { ...ctx };
  return runDeviceEffect({ kind: 'h5', ...identity, target }, () => executeH5Action({ runtime, payload: { payload },
    actionId: identity.actionId, timeoutMs: ctx.httpTimeoutMs,
    send: request => bridgePost(requestCtx, '/v1/h5/action', request),
    cancel: identity => httpPost(bridgeUrl(requestCtx, '/v1/h5/cancel'), identity, 4000).then(JSON.parse),
  }), result => h5SettlementProof(result, identity));
}

async function h5Completion(ctx, identity) {
  await bridgeGet(ctx, '/v1/status');
  return bridgePost(ctx, '/v1/h5/cancel', identity);
}

async function h5Eval(ctx, options) {
  return h5Action(ctx, { action: 'eval', pageRef: options.expectedPage, script: options.script });
}

async function h5Control(ctx, action, options) {
  const tree = await h5Dom(ctx, { webViewId: options.webViewId });
  if (tree.ok !== true) return tree;
  if (action === 'scroll' && options.selector === undefined) {
    if (options.expectedPage !== undefined && !isDeepStrictEqual(tree.pageRef, options.expectedPage)) return {
      ok: false, error: 'reobserve_required', dispatched: false, ambiguous: false,
    };
    return h5Action(ctx, { action: 'scrollBy', pageRef: tree.pageRef, deltaX: options.deltaX, deltaY: options.deltaY });
  }
  const selected = h5Target.selectH5Node(tree, options.selector, options.expectedTarget);
  if (!selected.ok) return selected;
  return h5Action(ctx, { action, ...selected.targetRef, ...(action === 'input' ? { text: options.text } : {}) });
}

const h5Click = (ctx, options) => h5Control(ctx, 'click', options);
const h5Input = (ctx, options) => h5Control(ctx, 'input', options);
const h5Scroll = (ctx, options) => h5Control(ctx, 'scroll', options);

async function h5Wait(ctx, options) {
  const timeoutMs = options.timeoutMs ?? 10000, intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let webViewId = options.webViewId, lastResult;
  do {
    checkExecution();
    const tree = await h5Dom({ ...ctx, httpTimeoutMs: Math.max(1, Math.min(ctx.httpTimeoutMs, deadline - Date.now())) }, { webViewId });
    if (tree.ok !== true) return tree;
    webViewId = tree.pageRef.webViewId;
    lastResult = h5Target.selectH5Node(tree, options.selector);
    if (lastResult.ok || lastResult.error !== 'android_h5_selector_not_found') return lastResult;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  } while (Date.now() < deadline);
  return { ok: false, error: 'h5_wait_timeout', timeoutMs, lastResult, dispatched: false, ambiguous: false };
}

function flutterH5Port(ctx) {
  return require('./shared-kernel/flutter-h5-port').createFlutterH5Port(
    (payload, identity) => flutterAction({ ...ctx, actionId: identity.actionId }, payload), { actionId: ctx.actionId });
}

async function flutterH5Dom(ctx, options = {}) {
  return flutterH5Port(ctx).snapshot(options.adapterId);
}

async function flutterH5Eval(ctx, options) {
  return flutterH5Port(ctx).evaluate(options);
}

async function flutterH5Click(ctx, options) {
  return flutterH5Port(ctx).control('click', options);
}

async function flutterH5Input(ctx, options) {
  return flutterH5Port(ctx).control('input', options);
}

async function flutterH5Scroll(ctx, options) {
  return flutterH5Port(ctx).control(options.selector === undefined ? 'scrollBy' : 'scroll', options);
}

async function flutterH5Wait(ctx, options) {
  return flutterH5Port(ctx).wait(options);
}

function booleanOption(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
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

async function inputText(ctx, text, options = {}, dependencies = {}) {
  const request = inputTextBridgePayload(text, options);
  let result;
  try { result = await nativeAction(ctx, options.nativeTarget ? '/v1/action/input-target' : '/v1/action/input-text', request, dependencies); }
  catch (error) {
    checkExecution();
    if (!options.nativeTarget || !bridgeTapWasDefinitelyNotDispatched(error)) throw error;
    return { ok: false, error: 'native_atomic_target_unavailable', dispatched: false, ambiguous: false,
      message: 'The app SDK cannot validate this input target. Update the SDK and observe again.' };
  }
  if (result?.ok !== true) return { ...result, ok: false, error: result?.error || 'bridge_input_failed',
    message: result?.message || 'The app SDK did not accept native text input.', transport: 'bridge', request };
  const response = { ...result, transport: 'bridge', source: result.source || 'native-view', request };
  if (options.hideKeyboard === true) response.keyboard = await hideKeyboard(ctx, options);
  return response;
}

function inputTextBridgePayload(text, options = {}) {
  const payload = { text };
  const actionId = options.runtimeActionId ?? options.requestId;
  if (actionId != null) payload.actionId = String(actionId);
  const hasX = Object.prototype.hasOwnProperty.call(options, 'tapX');
  const hasY = Object.prototype.hasOwnProperty.call(options, 'tapY');
  if (options.nativeTarget) {
    if (hasX || hasY) throw Object.assign(new Error('Native target and coordinates are mutually exclusive.'), { code: 'conflicting_input_target' });
    return { ...payload, ...options.nativeTarget };
  }
  if (!hasX && !hasY) return payload;
  if (hasX !== hasY) throw Object.assign(new Error('x_y_must_be_provided_together'), { code: 'x_y_must_be_provided_together' });
  const coordinate = (value) => {
    if ((typeof value !== 'number' && typeof value !== 'string')
      || (typeof value === 'string' && !value.trim())) return NaN;
    return Number(value);
  };
  const x = coordinate(options.tapX);
  const y = coordinate(options.tapY);
  // Android validates the coordinates after conversion to Float.
  if (!Number.isFinite(Math.fround(x)) || !Number.isFinite(Math.fround(y))) {
    throw Object.assign(new Error('invalid_input_coordinates'), { code: 'invalid_input_coordinates' });
  }
  payload.x = x;
  payload.y = y;
  return payload;
}

async function swipe(ctx, startX, startY, endX, endY, durationMs) {
  const result = await adb(ctx, ['shell', 'input', 'swipe', String(startX), String(startY), String(endX), String(endY), String(durationMs)], { mutation: true });
  return { ok: true, transport: 'adb', startX, startY, endX, endY, durationMs, ...executionFields(result) };
}

async function gestureNative(ctx, payload, options = {}, dependencies = {}) {
  const tree = await (dependencies.bridgeTree || bridgeTree)(ctx);
  const selected = selectNativeNode(tree, payload);
  if (!selected.ok) return { ...selected, ambiguous: false };
  const target = nativeTargetRequest(selected.node, payload.selector);
  if (!target.ok) return target;
  return nativeGesture(ctx, { ...payload, ...target.request, durationMs: payload.durationMs ?? 400,
    actionId: options.runtimeActionId ?? options.requestId ?? randomUUID() }, dependencies);
}

async function nativeGesture(ctx, payload, dependencies = {}) {
  checkExecution();
  if (!ctx.explicitPackageName) return { ok: false, error: 'native_target_requires_app_scope', dispatched: false, ambiguous: false };
  const foreground = await (dependencies.foregroundWindow || foregroundWindow)(ctx);
  if (!foreground.ok || foreground.packageName !== ctx.packageName) return {
    ok: false, error: foreground.ok ? 'foreground_package_mismatch' : 'foreground_probe_failed', dispatched: false, ambiguous: false,
  };
  const result = await nativeAction({ ...ctx, httpTimeoutMs: payload.durationMs + 3500 }, '/v1/action/gesture-target', payload, dependencies);
  return { ...result, transport: 'bridge' };
}

async function nativeAction(ctx, path, payload, dependencies = {}) {
  checkExecution();
  const status = await (dependencies.bridgeStatus || bridgeStatus)(ctx, { full: true });
  const runtime = { executionSchema: status?.debugBridge?.nativeExecutionSchema, runtimeEpoch: status?.debugBridge?.runtimeEpoch };
  const identity = { actionId: payload.actionId ?? randomUUID(), runtimeEpoch: runtime.runtimeEpoch };
  const target = { packageName: ctx.packageName, adb: ctx.adb, ...(ctx.explicitPort ? { port: ctx.port } : {}) };
  const requestCtx = { ...ctx };
  return runDeviceEffect({ kind: 'native', ...identity, target }, () => executeNativeAction({ runtime, payload,
    actionId: identity.actionId, timeoutMs: ctx.httpTimeoutMs,
    send: request => (dependencies.bridgePost || bridgePost)(requestCtx, path, request),
    cancel: identity => dependencies.cancelBridgePost ? dependencies.cancelBridgePost(requestCtx, identity)
      : httpPost(bridgeUrl(requestCtx, '/v1/action/cancel'), identity, 4000).then(JSON.parse),
  }), result => nativeSettlementProof(result, identity));
}

async function nativeCompletion(ctx, identity) {
  await bridgeGet(ctx, '/v1/status');
  return bridgePost(ctx, '/v1/action/cancel', identity);
}

async function keyevent(ctx, keyCode) {
  const result = await adb(ctx, ['shell', 'input', 'keyevent', String(keyCode)], { mutation: true });
  return { ok: true, transport: 'adb', keyCode, ...executionFields(result) };
}

async function logcat(ctx, options) {
  const follow = Boolean(options.follow || options.live);
  const args = ['logcat', '-v', String(options.logcatFormat || options.format || 'threadtime')];
  const cleared = options.clear || options.clearFirst
    ? await adb(ctx, ['shell', 'logcat', '-c'], { mutation: true }) : null;
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
  const output = filterLogcat(text, { ...options, pid });
  return cleared ? { ok: true, text: output, ...executionFields(cleared) } : output;
}

async function appopsSet(ctx, op, mode) {
  const result = await adb(ctx, ['shell', 'appops', 'set', ctx.packageName, op, mode], { mutation: true });
  return {
    ok: true,
    packageName: ctx.packageName,
    op,
    mode,
    ...executionFields(result),
  };
}

async function clearAppData(ctx, options = {}) {
  if (!ctx.explicitPackageName) throw new CommandError('target_required', 'clear-app-data requires packageName.', { field: 'packageName' });
  if (options.method === 'runtime') {
    const result = await bridgePost(ctx, '/v1/app/clear-data', {});
    return { ...result, packageName: ctx.packageName, method: 'runtime' };
  }
  const result = await adb(ctx, clearAppDataAdbArgs(ctx.packageName), { mutation: true });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return { ok: /^Success\b/im.test(output), packageName: ctx.packageName, action: 'clear-app-data',
    method: 'pm-clear', output, ...executionFields(result), ...(/^Success\b/im.test(output) ? {} : { error: 'clear_app_data_failed' }) };
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

async function adbFollow(ctx, args, durationMs) {
  const boundedDurationMs = Math.max(500, Math.min(durationMs || 5000, 60000));
  try {
    return (await execFileBounded(ctx.adb, adbArgs(ctx, args), {
      timeoutMs: boundedDurationMs, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    })).stdout;
  } catch (error) {
    // The collection duration is a successful end; execution cancellation and
    // provider failures are not successful partial log collections.
    if (error.code === 'provider_timeout') return error.stdout;
    throw error;
  }
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
      dispatched: false,
      ambiguous: false,
      packageName: ctx.packageName,
      launcherCandidates: candidates,
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      error: 'launcher_ambiguous',
      dispatched: false,
      ambiguous: false,
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

async function startActivity(ctx, component, options = {}, extraResult = {}, dependencies = {}) {
  const runAdb = dependencies.adb || adb;
  const readForeground = dependencies.foregroundWindow || foregroundWindow;
  const wait = dependencies.sleep || sleep;
  const args = buildAmStartArgs(component, options);
  const result = await runAdb(ctx, args, { mutation: true });
  const launched = {
    ok: true,
    transport: 'adb',
    component,
    ...extraResult,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    ...executionFields(result),
  };
  if (!ctx.packageName) return launched;
  const deadline = Date.now() + Number(options.foregroundTimeoutMs || 8000);
  let foreground = null;
  while (Date.now() < deadline) {
    foreground = await readForeground(ctx);
    if (foreground && foreground.ok && foreground.packageName === ctx.packageName) {
      return { ...launched, foreground };
    }
    await wait(200);
  }
  return {
    ...launched,
    ok: false,
    error: 'foreground_package_mismatch',
    foreground,
  };
}

function buildAmStartArgs(component, options = {}) {
  const args = ['shell', 'am', 'start', '-W'];
  if (booleanOption(options.clearTask)) args.push('--activity-clear-task');
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

function sleep(ms) {
  return executionSleep(ms);
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requiredInputString(value, name) {
  if (typeof value !== 'string') throw new Error(`${name} is required`);
  return value;
}

function requiredNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} is required`);
  return number;
}

module.exports = {
  executeProviderCommand,
  buildBridgeFailureResult,
  bridgeTree,
  createBridgeContext,
  flutterTapPayload,
  flutterAction,
  flutterCompletion,
  nativeCompletion,
  h5Completion,
  h5Eval,
  h5Dom,
  h5Control,
  nativeAction,
  flutterNodes,
  foregroundWindow,
  tapText,
  tapNative,
  waitText,
  tapUiaText,
  launchApp,
  startActivity,
  inputText,
  inputNativeText,
  inputTextBridgePayload,
  keyevent,
  nativeGesture,
  gestureNative,
  uiaTree,
  uiaTreeOnce,
  uiaTap,
  findUiaNodeByAny,
  bridgeRequest,
  bridgeNodeTarget,
  clearAppDataAdbArgs,
  artifactTimestamp,
  compactBridgeTree,
  compactStatus,
  compactUiaTree,
  defaultArtifactDirectory,
  defaultArtifactPath,
  findTappableNodeByText,
  filterLogcat,
  firstErrorLine,
  nodeTapState,
  normalizeBridgeError,
  normalizeActivityComponent,
  parseWebViewDevToolsSockets,
  parseKeyboardState,
  parsePackagePidsFromPs,
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
  requiredInputString,
  shouldDismissKeyboardForPoint,
  screenshotOutputPath,
  swipe,
  tap,
  verifyBridgeTargetPackage,
};
