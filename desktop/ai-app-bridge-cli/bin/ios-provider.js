const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { defaultArtifactPath, pruneGeneratedArtifacts } = require('./artifact-paths');
const { execFileBounded, httpRequestBounded } = require('./shared-kernel/execution-io');
const { runExecution, checkExecution, currentExecution, executionSleep, markExecutionDispatched } = require('./shared-kernel/execution-scope');
const { getProcessDeviceMutationLease, runDeviceEffect } = require('./shared-kernel/device-mutation-lease');
const { iosDeviceKey, executeIOSAction, lookupCompletion, reconcileIOS } = require('./ios-execution');
const { isMutationCommand, executionTimeoutMs } = require('./command-registry');
const { normalizeExecutionTarget } = require('./shared-kernel/execution-target');
const { descriptorBinding, bindingHeaders, assertRuntimeResponse, bindingFailure } = require('./ios-runtime-binding');
const { openWdaPort, target: wdaTarget } = require('./ios-wda-port');
const { prepareWdaProject, wdaBuildEnvironment } = require('./ios-wda-project');
const { executeWDAAction, reconcileWDA, completionPort } = require('./ios-wda-execution');
const { deviceCommandRejection } = require('./ios-device-outcome');
const { bindFlutterAction } = require('./shared-kernel/flutter-target');
const nativeTarget = require('./shared-kernel/ios-native-target');
const h5Target = require('./shared-kernel/ios-h5-target');
const h5Controls = new Map([['ios-h5-click','click'], ['ios-h5-input','input'], ['ios-h5-scroll','scroll']]);

const nativeControls = new Map([['ios-tap-native', 'native-tap'], ['ios-input-native-text', 'native-input']]);

const flutterControls = new Map([
  ['ios-tap-flutter', 'tapTarget'], ['ios-input-flutter-text', 'inputText'],
  ['ios-scroll-flutter', 'scrollBy'], ['ios-flutter-back', 'back'],
  ['ios-flutter-hide-keyboard', 'hideKeyboard'],
]);

const defaultHttpTimeoutMs = 5000;
const defaultDeviceTimeoutSec = 30;
const defaultWdaTestBundleId = 'io.github.mobileaidev.aiappbridge.wda';

class IOSBridgeProvider {
  constructor(options = {}) {
    this.execFile = options.execFile || execFile;
    this.httpRequest = options.httpRequest || requestJson;
    this.lease = options.lease;
  }

  async run(command, args = {}) {
    try {
      return await runExecution({ timeoutMs: executionTimeoutMs(command, args) ?? 30000,
        mutation: isMutationCommand(command, args) }, async () => {
        if (!isMutationCommand(command, args)) return this.dispatch(command, args);
        const device = await this.requireDevice(args);
        const key = iosDeviceKey(device);
        const lease = this.lease || getProcessDeviceMutationLease();
        return lease.run(key, async () => {
          if (command === 'ios-h5-eval' || h5Controls.has(command) || command === 'ios-flutter-action' || flutterControls.has(command) || nativeControls.has(command)
              || ['ios-wda-session', 'ios-tap', 'ios-input', 'ios-swipe', 'ios-set-orientation'].includes(command)) return this.dispatch(command, args, { device });
          return runDeviceEffect({ kind: 'ios-command', command, target: { deviceId: device.udid, bundleId: args.bundleId ?? null } }, async () => {
            let result;
            try { result = await this.dispatch(command, args, { device }); }
            catch (error) {
              if (!error.deviceOutcome) throw error;
              result = { ...error.deviceOutcome, command };
            }
            return currentExecution()?.dispatched ? result : { ...result, dispatched: false, ambiguous: false };
          });
        });
      });
    } catch (error) {
      return {
        ok: false,
        error: iosErrorCode(command, error),
        command,
        message: firstErrorLine(error.message || String(error)),
        details: truncateText(error.message || String(error), 4000),
        ...(error.field ? { field: error.field } : {}),
        dispatched: typeof error.dispatched === 'boolean' ? error.dispatched : null,
        ambiguous: error.ambiguous !== false,
        ...(error.devicectlReply ? { deviceOutcome: error.devicectlReply } : {}),
      };
    }
  }

  async dispatch(command, args, context = {}) {
      if (flutterControls.has(command)) return this.flutterControl(command, args, context);
      if (nativeControls.has(command)) return this.nativeControl(command, args, context);
      switch (command) {
        case 'ios-devices':
          return await this.devices(args);
        case 'ios-doctor':
          return await this.doctor(args);
        case 'ios-setup':
          return await this.setup(args);
        case 'ios-install-app':
          return await this.installApp(args);
        case 'ios-launch-app':
          return await this.launchApp(args);
        case 'ios-status':
          return await this.runtimeGet(args, '/v1/status');
        case 'ios-tree':
          return await this.runtimeGet(args, '/v1/view/tree');
        case 'ios-logs':
          return await this.runtimeGet(args, withQuery('/v1/logs', captureQuery(args)));
        case 'ios-network':
          return await this.runtimeGet(args, withQuery('/v1/network', captureQuery(args)));
        case 'ios-state':
          return await this.runtimeGet(args, withQuery('/v1/state', captureQuery(args)));
        case 'ios-events':
          return await this.runtimeGet(args, withQuery('/v1/events', captureQuery(args)));
        case 'ios-h5-dom':
          return await this.runtimeGet(args, withQuery('/v1/h5/dom', args.webViewId === undefined ? {} : { webViewId: args.webViewId }));
        case 'ios-h5-eval':
          return await this.runtimePost(args, '/v1/h5/action', { payload: { action: 'eval', pageRef: args.expectedPage, script: requiredString(args.script, 'script') } }, context);
        case 'ios-h5-click': case 'ios-h5-input': case 'ios-h5-scroll':
          return await this.h5Control(command, args, context);
        case 'ios-flutter-tree':
          return await this.flutterTree(args);
        case 'ios-flutter-nodes':
          return await this.flutterNodes(args);
        case 'ios-flutter-action':
          return await this.runtimePost(args, '/v1/flutter/action', parsePayload(args), context);
        case 'ios-execution':
          return await this.executionControl(args);
        case 'ios-screenshot':
          return await this.screenshot(args);
        case 'ios-wda-status':
          return await this.wdaStatus(args);
        case 'ios-wda-session':
          return await this.wdaSession(args, context);
        case 'ios-uia-tree':
          return await this.wdaSource(args);
        case 'ios-tap':
          return await this.wdaTap(args);
        case 'ios-input':
          return await this.wdaInput(args);
        case 'ios-swipe':
          return await this.wdaSwipe(args);
        case 'ios-set-orientation':
          return await this.wdaSetOrientation(args, context);
        default:
          return { ok: false, error: 'unknown_ios_command', command };
      }
  }

  context(args = {}) {
    return {
      devicectl: stringArg(args.devicectl, process.env.AI_APP_BRIDGE_DEVICECTL || 'xcrun'),
      xcodebuild: stringArg(args.xcodebuild, process.env.XCODEBUILD || 'xcodebuild'),
      deviceTimeoutSec: numberArg(args.deviceTimeoutSec, defaultDeviceTimeoutSec),
      httpTimeoutMs: numberArg(args.timeoutMs, defaultHttpTimeoutMs),
    };
  }

  async devices(args = {}) {
    const ctx = this.context(args);
    const raw = await this.devicectlJson(ctx, ['list', 'devices']);
    const devices = parseDevicectlDevices(raw).map(shapeDevice);
    return {
      ok: true,
      devices,
      count: devices.length,
      selectedDevice: selectDeviceFromList(devices, args).device || null,
      updatedAtMs: Date.now(),
    };
  }

  async doctor(args = {}) {
    const ctx = this.context(args);
    const checks = [];
    const xcode = await this.xcodeVersion(ctx);
    checks.push({ name: 'xcodebuild', ok: xcode.ok, ...xcode });

    let devices = [];
    let selected = null;
    try {
      const deviceResult = await this.devices(args);
      devices = deviceResult.devices;
      const selection = selectDeviceFromList(devices, args);
      selected = selection.device;
      checks.push({
        name: 'device',
        ok: Boolean(selection.device),
        error: selection.error || null,
        message: selection.message || null,
        device: selection.device || null,
      });
    } catch (error) {
      checks.push({ name: 'device', ok: false, error: 'devicectl_failed', message: error.message });
    }

    let runtime = { ok: false, error: 'bundle_id_or_runtime_endpoint_required' };
    if (args.bundleId || args.runtimeUrl || args.iosHost || args.host) {
      try {
        runtime = await this.runtimeGet(args, '/v1/status', { allowUnavailable: true, device: selected });
      } catch (error) {
        runtime = { ok: false, error: 'runtime_unavailable', message: error.message };
      }
    }
    checks.push({ name: 'runtime', ok: runtime.ok === true, endpoint: runtime.endpoint || null, error: runtime.error || null });

    let wda = { ok: false, error: 'ios_wda_target_required' };
    if (args.wdaRunnerBundleId) {
      wda = await this.wdaStatus(args);
    }
    checks.push({ name: 'wda', ok: wda.ok === true, url: wda.url || null, error: wda.error || null });

    const developerModeReady = selected ? selected.developerModeStatus === 'enabled' : false;
    const ddiReady = selected?.ddiServicesAvailable === true;
    const deviceConnected = selected?.tunnelState === 'connected';
    const ready = Boolean(xcode.ok && deviceConnected && developerModeReady && ddiReady && runtime.ok === true && wda.ok === true);
    return {
      ok: true,
      ready,
      fullControlReady: ready,
      checks,
      devices,
      selectedDevice: selected,
      requirements: {
        xcode: xcode.ok,
        deviceConnected,
        developerModeEnabled: developerModeReady,
        ddiServicesAvailable: ddiReady,
        runtimeReachable: runtime.ok === true,
        wdaReachable: wda.ok === true,
      },
      suggestion: ready ? null : iosSetupSuggestion(selected, runtime, wda),
      updatedAtMs: Date.now(),
    };
  }

  async setup(args = {}) {
    const ctx = this.context(args);
    const xcode = await this.xcodeVersion(ctx);
    if (!xcode.ok) {
      return { ok: false, error: 'xcode_required', xcode };
    }

    let devices;
    try {
      devices = (await this.devices(args)).devices;
    } catch (error) {
      return { ok: false, error: 'devicectl_failed', message: error.message };
    }
    const selection = selectDeviceFromList(devices, args);
    if (!selection.device) {
      return { ok: false, error: selection.error || 'ios_device_required', message: selection.message, devices };
    }
    const device = selection.device;
    if (device.developerModeStatus !== 'enabled') {
      return {
        ok: false,
        error: 'ios_developer_mode_required',
        device,
        message: 'Developer Mode is disabled on the selected iPhone. Enable it on the device, reboot if iOS asks, unlock the phone, then rerun ios-setup.',
      };
    }
    if (device.ddiServicesAvailable === false) {
      return {
        ok: false,
        error: 'ios_developer_disk_image_required',
        device,
        message: 'Xcode cannot access developer disk image services for this device. Unlock/trust the iPhone and let Xcode finish preparing it, then rerun ios-setup.',
      };
    }

    const steps = [];
    if (args.appPath) {
      const install = await this.installApp({ ...args, deviceId: device.identifier || device.udid });
      steps.push({ name: 'install-app', ...install });
      if (install.ok === false) return { ok: false, error: 'ios_app_install_failed', device, steps };
    }
    let wda = await this.wdaStatus(args);
    if (wda.ok !== true && booleanArg(args.startWda)) {
      const start = await this.startWda({ ...args, deviceId: device.identifier || device.udid });
      steps.push({ name: 'start-wda', ...start });
      if (start.ok === true) {
        wda = start.status || await this.wdaStatus(args);
      } else {
        return { ok: false, error: start.error, message: start.message, device, steps };
      }
    }
    steps.push({ name: 'wda', ok: wda.ok === true, url: wda.url || null, error: wda.error || null });

    if (wda.ok !== true) {
      return {
        ok: false,
        error: 'ios_wda_required',
        device,
        steps,
        message: 'Full iOS control requires the prepared, signed WDA Runner. Pass --wda-runner-bundle-id for an existing bound Runner, or --team-id and --start-wda to build and start it. An optional --wda-url must match the selected Runner container identity.',
      };
    }
    // Starting the XCTest Runner changes the foreground App. Launch the target
    // afterwards and verify a fresh SDK response, not its pre-WDA snapshot.
    if (args.bundleId) {
      const launch = await this.launchApp({ ...args, deviceId: device.identifier || device.udid });
      steps.push({ name: 'launch-app', ...launch });
      if (launch.ok === false) return { ok: false, error: 'ios_app_launch_failed', device, steps };
    }
    const runtime = args.bundleId || args.runtimeUrl || args.iosHost || args.host
      ? await this.runtimeGet(args, '/v1/status', { allowUnavailable: true, device })
      : { ok: false, error: 'bundle_id_or_runtime_endpoint_required' };
    steps.push({ name: 'runtime', ok: runtime.ok === true, endpoint: runtime.endpoint || null, error: runtime.error || null });
    if (runtime.ok !== true) {
      return {
        ok: false,
        error: 'ios_runtime_required',
        device,
        steps,
        message: 'The bound WDA Runner is reachable, but the App SDK is not. Launch a debug App with AiAppBridgeIOS and supply its exact deviceId and bundleId; runtimeUrl or iosHost/iosPort may specify an explicitly forwarded endpoint.',
      };
    }

    return {
      ok: true,
      ready: true,
      fullControlReady: true,
      device,
      runtimeEndpoint: runtime.endpoint,
      wdaUrl: wda.url,
      wdaRunnerBundleId: wda.runtimeBinding.bundleId,
      steps,
    };
  }

  async installApp(args = {}) {
    const ctx = this.context(args);
    const device = await this.requireDevice(args);
    const appPath = requiredString(args.appPath, 'appPath');
    const resolvedPath = path.resolve(appPath);
    const raw = await this.devicectlJson(ctx, [
      'device',
      'install',
      'app',
      '--device',
      device.identifier || device.udid,
      resolvedPath,
    ], { mutation: true });
    return {
      ok: true,
      device,
      appPath: resolvedPath,
      result: raw.result || raw,
    };
  }

  async launchApp(args = {}) {
    const ctx = this.context(args);
    const device = await this.requireDevice(args);
    const bundleId = requiredString(args.bundleId, 'bundleId');
    const launchArgs = [
      'device',
      'process',
      'launch',
      '--device',
      device.identifier || device.udid,
    ];
    if (args.terminateExisting !== false) launchArgs.push('--terminate-existing');
    launchArgs.push(bundleId);
    const raw = await this.devicectlJson(ctx, launchArgs, { mutation: true });
    return {
      ok: true,
      device,
      bundleId,
      result: raw.result || raw,
    };
  }

  async screenshot(args = {}) {
    const ctx = this.context(args);
    const device = await this.requireDevice(args);
    const generatedDefault = !args.outFile;
    const outFile = args.outFile
      ? path.resolve(args.outFile)
      : defaultArtifactPath('ios-screenshot', 'png', { artifactDir: args.artifactDir });
    await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
    const command = [
      'device',
      'capture',
      'screenshot',
      '--device',
      device.identifier || device.udid,
      '--destination',
      outFile,
    ];
    if (args.displayUniqueId) command.push('--display-unique-id', String(args.displayUniqueId));
    const raw = await this.devicectlJson(ctx, command);
    const artifact = {
      path: outFile,
      generatedDefault,
      directory: path.dirname(outFile),
      sha256: createHash('sha256').update(await fs.promises.readFile(outFile)).digest('hex'),
    };
    if (generatedDefault) {
      artifact.retention = await pruneGeneratedArtifacts({
        directory: artifact.directory,
        prefix: 'ios-screenshot',
        extension: 'png',
        currentPath: outFile,
      });
    }
    return {
      ok: true,
      device,
      outFile,
      artifact,
      result: raw.result || raw,
    };
  }

  async runtimeGet(args, endpointPath, options = {}) {
    try {
      return await this.runtimeRequest('GET', args, endpointPath, null, options);
    } catch (error) {
      if (!options.allowUnavailable) throw error;
      return { ok: false, error: iosErrorCode(null, error), message: error.message,
        dispatched: error.dispatched ?? false, ambiguous: error.ambiguous === true };
    }
  }

  async runtimePost(args, endpointPath, body, options = {}) {
    return this.runtimeRequest('POST', args, endpointPath, body, options);
  }

  async runtimePort(args, options = {}) {
    const endpoint = await this.resolveRuntimeEndpoint(args, options);
    const httpOptions = { timeoutMs: this.context(args).httpTimeoutMs, headers: bindingHeaders(endpoint.runtimeBinding) };
    const request = async (method, endpointPath, payload) => {
      let response;
      try {
        response = await this.httpRequest(method, `${endpoint.baseUrl}${endpointPath}`, payload, httpOptions);
      } catch (error) {
        if (!error.response) throw error;
        assertRuntimeResponse(error.response, endpoint.runtimeBinding);
        if (error.response.ok !== false || typeof error.response.error !== 'string' || !/^[a-z][a-z0-9_]*$/.test(error.response.error)) {
          throw bindingFailure('invalid_ios_runtime_response', 'The bound runtime HTTP error has no structured rejection reason.');
        }
        // A validated SDK rejection is still a protocol response. Preserve its
        // candidates, receipt and dispatch status instead of replacing it with
        // an exception containing only the error string.
        return error.response;
      }
      assertRuntimeResponse(response, endpoint.runtimeBinding);
      return response;
    };
    return { endpoint, get: endpointPath => request('GET', endpointPath, null), post: (endpointPath, payload) => request('POST', endpointPath, payload) };
  }

  async runtimeRequest(method, args, endpointPath, body, options = {}) {
    return runExecution({ timeoutMs: args.timeoutMs ?? 30000, mutation: method === 'POST' }, async () => {
      const port = await this.runtimePort(args, options);
      const endpoint = port.endpoint;
      let response;
      if (method === 'POST') {
        const status = await port.get('/v1/status');
        if (status.ok === false) return { ...status, dispatched: false, ambiguous: false };
        const kind = endpointPath === '/v1/h5/action' ? 'h5' : 'flutter';
        const target = { platform: 'ios', deviceId: endpoint.device.udid, bundleId: args.bundleId,
          ...Object.fromEntries(['runtimeUrl', 'iosHost', 'iosPort', 'devicectl'].filter(key => args[key] !== undefined).map(key => [key, args[key]])) };
        response = await executeIOSAction({ port, kind, payload: body, status, target, timeoutMs: args.timeoutMs ?? 30000,
          actionId: args.runtimeActionId ?? args.requestId });
      } else { response = await port.get(endpointPath); checkExecution(); }
      return { ...response, endpoint: endpoint.baseUrl, device: endpoint.device, runtimeBinding: endpoint.runtimeBinding };
    });
  }

  async executionControl(args) {
    const device = await this.requireDevice(args);
    const lease = this.lease || getProcessDeviceMutationLease();
    const key = iosDeviceKey(device);
    if (args.kind === 'wda') {
      if (args.operation === 'reconcile') return reconcileWDA({ lease, device, args,
        createPort: target => openWdaPort(this, target, device) });
      const port = await openWdaPort(this, args, device);
      if (args.operation === 'status') return { ok: true, device, ownership: lease.status(key), runtime: port.status,
        runtimeBinding: port.runtimeBinding };
      const identity = { actionId: args.actionId, runtimeEpoch: args.runtimeEpoch };
      const cancelled = args.operation === 'cancel' ? await port.request('POST', '/aab/execution/cancel', identity) : undefined;
      if (cancelled && cancelled.ok !== true) return cancelled;
      return lookupCompletion(completionPort(port), 'wda', identity, cancelled);
    }
    if (args.operation === 'reconcile') return reconcileIOS({ lease, device, args,
      createPort: target => this.runtimePort(target, { device }) });
    if (args.operation === 'status') return {
      ok: true, device, ownership: lease.status(key),
      runtime: await this.runtimeGet(args, '/v1/execution/status', { device, allowUnavailable: true }),
    };
    const port = await this.runtimePort(args, { device });
    const identity = { actionId: args.actionId, runtimeEpoch: args.runtimeEpoch };
    if (args.operation === 'cancel') {
      const response = await port.post(`/v1/${args.kind}/cancel`, identity);
      if (response.ok !== true) return response;
      return lookupCompletion(port, args.kind, identity, response);
    }
    return lookupCompletion(port, args.kind, identity);
  }

  async h5Control(command, args, context) {
    const tree = await this.runtimeGet(args, withQuery('/v1/h5/dom', args.webViewId === undefined ? {} : { webViewId: args.webViewId }), context);
    if (tree.ok !== true) return tree;
    const selected = h5Target.selectH5Node(tree, args.selector, args.expectedTarget);
    if (!selected.ok) return selected;
    return this.runtimePost(args, '/v1/h5/action', { payload: { action: h5Controls.get(command),
      ...selected.targetRef, ...(command === 'ios-h5-input' ? { text: args.text } : {}) } }, context);
  }

  async flutterTree(args = {}) {
    const status = await this.runtimeGet(args, '/v1/status');
    if (status.ok === false) return status;
    return {
      ok: true,
      endpoint: status.endpoint,
      runtimeBinding: status.runtimeBinding,
      device: status.device || null,
      flutter: status.flutter || null,
      layout: status.flutter?.layout || null,
    };
  }

  async flutterNodes(args = {}) {
    const tree = await this.flutterTree(args);
    if (tree.ok === false) return tree;
    const operable = tree.layout?.operable || null;
    return {
      ...operable,
      ok: Boolean(operable),
      endpoint: tree.endpoint,
      runtimeBinding: tree.runtimeBinding,
      device: tree.device || null,
      operable,
      nodes: operable?.nodes || [],
      count: operable?.count || 0,
      error: operable ? null : 'flutter_operable_tree_absent',
    };
  }

  async flutterControl(command, args, context = {}) {
    const port = await this.runtimePort(args, context);
    const status = await port.get('/v1/status');
    if (status.ok !== true) return { ...status, dispatched: false, ambiguous: false };
    const action = flutterControls.get(command);
    let payload = { action };
    if (!['back', 'hideKeyboard'].includes(action)) {
      const bound = bindFlutterAction(status.flutter?.layout?.operable, {
        action, selector: args.selector,
        ...(action === 'inputText' ? { text: args.text } : {}),
        ...(action === 'scrollBy' ? { delta: args.delta } : {}),
      });
      if (!bound.ok) return bound;
      payload = bound.payload;
    }
    const endpoint = port.endpoint;
    const target = { platform: 'ios', deviceId: endpoint.device.udid, bundleId: args.bundleId,
      ...Object.fromEntries(['runtimeUrl', 'iosHost', 'iosPort', 'devicectl'].filter(key => args[key] !== undefined).map(key => [key, args[key]])) };
    const result = await executeIOSAction({ port, kind: 'flutter', payload, status, target,
      timeoutMs: args.timeoutMs ?? 30000, actionId: args.runtimeActionId ?? args.requestId });
    return { ...result, endpoint: endpoint.baseUrl, device: endpoint.device, runtimeBinding: endpoint.runtimeBinding };
  }

  async resolveRuntimeEndpoint(args = {}, options = {}) {
    const target = normalizeExecutionTarget({ platform: 'ios', deviceId: args.deviceId, bundleId: args.bundleId,
      ...Object.fromEntries(['runtimeUrl', 'iosHost', 'iosPort'].filter(key => args[key] !== undefined).map(key => [key, args[key]])) });
    const device = options.device ?? await this.requireDevice(args);
    if (![device.identifier, device.udid].includes(target.deviceId)) {
      throw bindingFailure('ios_device_not_found', 'deviceId must match the selected devicectl identifier or UDID.');
    }
    if (device.developerModeStatus !== 'enabled' || device.ddiServicesAvailable !== true || device.tunnelState !== 'connected') {
      throw bindingFailure('ios_tunnel_unavailable', 'The selected iPhone must expose a connected developer tunnel. Unlock/trust the device and let Xcode prepare it.');
    }
    const runtimeBinding = await this.readRuntimePortFile(args, device);
    const host = target.iosHost ?? device.tunnelIPAddress;
    if (!target.runtimeUrl && !host) {
      throw bindingFailure('ios_tunnel_unavailable', 'The selected device has no tunnel IP. Supply runtimeUrl or iosHost for an explicitly forwarded endpoint.');
    }
    const port = target.iosPort ?? runtimeBinding.port;
    const baseUrl = target.runtimeUrl ?? `http://${formatHostForUrl(host)}:${port}`;
    // Validate the constructed URL too; a host cannot smuggle a path or query.
    let url;
    try { url = new URL(baseUrl); }
    catch { throw bindingFailure('invalid_argument', 'The iOS runtime endpoint is not a valid URL.'); }
    if (url.username || url.password || url.search || url.hash || (!target.runtimeUrl && url.pathname !== '/')) {
      throw bindingFailure('invalid_argument', 'iosHost must be a hostname or IP address. runtimeUrl must have no credentials, query or fragment.');
    }
    checkExecution();
    return { ok: true, baseUrl: stripTrailingSlash(url.href), device, runtimeBinding };
  }

  async readRuntimePortFile(args, device) {
    return descriptorBinding(await this.readContainerDescriptor(args, device, args.bundleId, 'ai_app_bridge_port.json'), args.bundleId);
  }

  async readContainerDescriptor(args, device, bundleId, filename) {
    const ctx = { ...this.context(args), deviceTimeoutSec: 5 };
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-app-bridge-ios-port-'));
    try {
      await this.devicectlJson(ctx, [
        'device', 'copy', 'from', '--device', device.identifier,
        '--domain-type', 'appDataContainer', '--domain-identifier', bundleId,
        '--source', `Documents/${filename}`, '--destination', path.join(tempDir, filename),
      ]);
      checkExecution();
      const portFile = path.join(tempDir, filename);
      let data;
      try {
        const handle = await fs.promises.open(portFile, 'r');
        try {
          const buffer = Buffer.alloc(4097);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 4096) throw bindingFailure('invalid_ios_runtime_descriptor', 'Runtime descriptor exceeds 4096 bytes.');
          data = buffer.subarray(0, bytesRead).toString('utf8');
        } finally { await handle.close(); }
      } catch (error) {
        if (error.code === 'ENOENT') throw bindingFailure('ios_runtime_descriptor_absent', `The selected App container has no ${filename}. Start the matching runtime before querying it.`);
        throw error;
      }
      let descriptor;
      try { descriptor = JSON.parse(data); }
      catch { throw bindingFailure('invalid_ios_runtime_descriptor', 'The selected App runtime descriptor is not valid JSON.'); }
      return descriptor;
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }

  async wdaStatus(args = {}) {
    try {
      const port = await openWdaPort(this, args);
      return { ok: true, url: port.baseUrl, device: port.device, runtimeBinding: port.runtimeBinding, value: port.status };
    } catch (error) {
      return { ok: false, error: iosErrorCode(null, error), message: error.message,
        dispatched: error.dispatched ?? false, ambiguous: error.ambiguous === true };
    }
  }

  async wdaSession(args, context = {}) {
    const port = await openWdaPort(this, args, context.device);
    if (args.operation === 'status') return { ok: true, runtimeBinding: port.runtimeBinding, ...(await port.session(false)) };
    if (args.operation === 'create') {
      const state = await port.session(false);
      if (state.session !== null) return { ok: false, error: 'ios_wda_session_busy', dispatched: false, ambiguous: false };
      const foreground = wdaTarget(state.foreground);
      if (foreground.bundleId !== args.bundleId) return { ok: false, error: 'ios_wda_target_changed', dispatched: false, ambiguous: false };
      const result = await executeWDAAction({ port, args, operation: 'session-create', selected: foreground });
      if (result.ok !== true) return { ...result, runtimeBinding: port.runtimeBinding };
      const selected = wdaTarget(result.value, true);
      if (selected.bundleId !== foreground.bundleId || selected.processId !== foreground.processId) {
        throw bindingFailure('ios_wda_target_changed', 'The App process changed while the WDA session was being created.');
      }
      return { ...result, session: selected, runtimeBinding: port.runtimeBinding, device: port.device };
    }
    const selected = await port.session();
    const result = await executeWDAAction({ port, args, operation: 'session-close', selected });
    return { ...result, ...(result.ok ? { closedSession: selected } : {}), runtimeBinding: port.runtimeBinding };
  }

  async wdaSource(args = {}) {
    const port = await openWdaPort(this, args);
    return this.nativeObservation(port);
  }

  async nativeObservation(port) {
    const session = await port.session();
    const source = await port.request('GET', `/session/${encodeURIComponent(session.sessionId)}/source?format=json`, null, session);
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw bindingFailure('invalid_ios_wda_tree', 'WDA must return its JSON UI tree.');
    return { ok: true, session, source, device: port.device, runtimeBinding: port.runtimeBinding,
      nativeTargetSchema: port.status.nativeTargetSchema };
  }

  async nativeControl(command, args, context = {}) {
    const port = await openWdaPort(this, args, context.device);
    if (port.status.nativeTargetSchema !== nativeTarget.schema) return {
      ok: false, error: 'ios_native_target_schema_required', dispatched: false, ambiguous: false,
    };
    const observation = await this.nativeObservation(port);
    const selected = nativeTarget.bindNativeTarget(observation, args.selector, args.expectedTarget);
    if (!selected.ok) return selected;
    const operation = nativeControls.get(command);
    const payload = { targetRef: selected.targetRef.element,
      ...(operation === 'native-input' ? { text: args.text, clearFirst: true } : {}) };
    const result = await executeWDAAction({ port, args, operation, selected: observation.session, payload });
    return { ...result, transport: 'wda-managed-native', action: operation, session: observation.session,
      resolved: selected.targetRef, matched: 1, runtimeBinding: port.runtimeBinding };
  }

  async wdaTap(args = {}) {
    const port = await openWdaPort(this, args);
    const session = await port.session();
    const x = requiredNumber(args.tapX, 'tapX'), y = requiredNumber(args.tapY, 'tapY');
    const result = await executeWDAAction({ port, args, operation: 'tap', selected: session, payload: { x, y } });
    return { ...result, transport: 'wda', action: 'tap', session, x, y, runtimeBinding: port.runtimeBinding };
  }

  async wdaInput(args = {}) {
    const port = await openWdaPort(this, args);
    const session = await port.session();
    const text = requiredInputString(args.text, 'text');
    const prefix = `/session/${encodeURIComponent(session.sessionId)}`;
    let elementId = args.elementId;
    if (args.accessibilityId !== undefined) {
      const matches = await port.request('POST', `${prefix}/elements`, { using: 'accessibility id', value: args.accessibilityId }, session, false);
      if (!Array.isArray(matches)) throw bindingFailure('invalid_ios_wda_elements', 'WDA must return an array of matching elements.');
      if (matches.length !== 1) return { ok: false, error: matches.length ? 'ios_wda_target_ambiguous' : 'ios_wda_target_not_found', dispatched: false, ambiguous: false };
      elementId = matches[0]?.['element-6066-11e4-a52e-4f735466cecf'];
    }
    if (typeof elementId !== 'string' || !elementId) throw bindingFailure('invalid_ios_wda_element', 'WDA must return the exact W3C element identity.');
    const result = await executeWDAAction({ port, args, operation: 'input', selected: session,
      payload: { elementId, text, clearFirst: args.clearFirst === true } });
    return { ...result, transport: 'wda-managed-input', action: 'input', session, elementId, textLength: text.length,
      runtimeBinding: port.runtimeBinding };
  }

  async wdaSwipe(args = {}) {
    const port = await openWdaPort(this, args);
    const session = await port.session();
    const startX = requiredNumber(args.startX, 'startX'), startY = requiredNumber(args.startY, 'startY');
    const endX = requiredNumber(args.endX, 'endX'), endY = requiredNumber(args.endY, 'endY');
    const durationMs = args.durationMs ?? 500;
    const result = await executeWDAAction({ port, args, operation: 'swipe', selected: session,
      payload: { startX, startY, endX, endY, durationMs } });
    return { ...result, transport: 'wda-actions', action: 'swipe', session, startX, startY, endX, endY, durationMs,
      runtimeBinding: port.runtimeBinding };
  }

  async wdaSetOrientation(args, context = {}) {
    if (!nativeTarget.orientationSchema.enum.includes(args.orientation)) return {
      ok: false, error: 'invalid_ios_wda_orientation', dispatched: false, ambiguous: false,
    };
    const port = await openWdaPort(this, args, context.device);
    if (port.status.orientationSchema !== 'aab.ios-orientation/v1') return {
      ok: false, error: 'ios_wda_orientation_schema_required', dispatched: false, ambiguous: false,
    };
    const session = await port.session();
    const resolved = nativeTarget.sessionRef({ session, runtimeBinding: port.runtimeBinding });
    if (args.expectedSession !== undefined && !isDeepStrictEqual(args.expectedSession, resolved)) return {
      ok: false, error: 'reobserve_required', dispatched: false, ambiguous: false,
    };
    const result = await executeWDAAction({ port, args, operation: 'set-orientation', selected: session,
      payload: { orientation: args.orientation } });
    return { ...result, transport: 'wda-managed-orientation', action: 'set-orientation', session,
      resolved, runtimeBinding: port.runtimeBinding };
  }

  async startWda(args = {}) {
    const device = await this.requireDevice(args);
    const wdaTestBundleId = args.wdaTestBundleId ?? defaultWdaTestBundleId;
    const wdaRunnerBundleId = `${wdaTestBundleId}.xctrunner`;
    if (args.wdaRunnerBundleId !== undefined && args.wdaRunnerBundleId !== wdaRunnerBundleId) {
      return { ok: false, error: 'ios_wda_runner_bundle_mismatch', message: 'Starting WDA uses the Runner application ID <wdaTestBundleId>.xctrunner.' };
    }
    const existing = await this.wdaStatus({ ...args, deviceId: device.udid, wdaRunnerBundleId });
    if (existing.ok) return { ok: true, reused: true, device, wdaTestBundleId, wdaRunnerBundleId, status: existing };
    const teamId = args.teamId || process.env.DEVELOPMENT_TEAM || process.env.AI_APP_BRIDGE_IOS_TEAM_ID;
    if (!teamId) return { ok: false, error: 'ios_team_id_required', message: 'Signing WDA requires an explicit teamId or configured DEVELOPMENT_TEAM.' };
    checkExecution();
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aab-wda-runtime-'));
    const prepared = prepareWdaProject({ destination: path.join(directory, 'source') });
    const ctx = this.context(args);
    const xcodeArgs = ['-project', prepared.projectPath, '-scheme', 'WebDriverAgentRunner', '-sdk', 'iphoneos', '-destination', `id=${device.udid}`,
      '-derivedDataPath', path.join(directory, 'build'), `DEVELOPMENT_TEAM=${teamId}`, `PRODUCT_BUNDLE_IDENTIFIER=${wdaTestBundleId}`,
      'ENABLE_DEFAULT_HEADER_SEARCH_PATHS=NO', '-allowProvisioningUpdates'];
    // Compile/sign on the Host before starting any remote test operation.
    // A local compiler failure or cancellation cannot leave a phone task unknown.
    const buildLogFile = path.join(directory, 'xcodebuild-build.log');
    const build = spawnWdaProcess(ctx.xcodebuild, [...xcodeArgs, 'build-for-testing'], buildLogFile, false);
    try {
      while (!build.terminal) { checkExecution(); await executionSleep(100); }
      if (build.spawnError || build.exitCode !== 0) return {
        ok: false, error: build.spawnError ? 'ios_wda_xcodebuild_spawn_failed' : 'ios_wda_build_failed',
        message: build.spawnError?.message ?? 'WDA compilation/signing failed before device test execution.',
        phase: 'build', exitCode: build.exitCode, logFile: buildLogFile, prepared,
      };
    } finally { await build.stop(); }
    const logFile = path.join(directory, 'xcodebuild.log');
    const runtime = spawnWdaProcess(ctx.xcodebuild, [...xcodeArgs, 'test-without-building'], logFile, true);
    const child = runtime.child;
    let ready = false;
    try {
      while (!runtime.terminal) {
        checkExecution();
        const status = await this.wdaStatus({ ...args, deviceId: device.udid, wdaRunnerBundleId });
        if (status.ok) {
          ready = true; child.unref();
          return { ok: true, device, wdaTestBundleId, wdaRunnerBundleId, pid: child.pid, logFile, buildLogFile, prepared, status };
        }
        await executionSleep(1000);
      }
      return { ok: false, error: runtime.spawnError ? 'ios_wda_xcodebuild_spawn_failed' : 'ios_wda_xcodebuild_exited',
        message: runtime.spawnError?.message ?? 'xcodebuild closed before the selected Runner published a bound endpoint.',
        phase: 'device-test', exitCode: runtime.exitCode, logFile, buildLogFile, prepared };
    } finally {
      if (!ready) await runtime.stop();
    }
  }

  async requireDevice(args = {}) {
    const devices = (await this.devices(args)).devices;
    const selection = selectDeviceFromList(devices, args);
    if (!selection.device) {
      const error = new Error(selection.message || selection.error || 'iOS device is required');
      error.code = selection.error || 'ios_device_required';
      throw error;
    }
    return selection.device;
  }

  async xcodeVersion(ctx) {
    try {
      const result = await execFileText(this.execFile, ctx.xcodebuild, ['-version'], { timeoutMs: 10000 });
      return { ok: true, version: result.stdout.trim() };
    } catch (error) {
      return { ok: false, error: 'xcodebuild_unavailable', message: error.message };
    }
  }

  async devicectlJson(ctx, args, { mutation = false } = {}) {
    const jsonPath = path.join(os.tmpdir(), `ai-app-bridge-devicectl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const allArgs = [
      ...devicectlPrefix(ctx.devicectl),
      ...args,
      '--timeout',
      String(ctx.deviceTimeoutSec),
      '--json-output',
      jsonPath,
    ];
    try {
      const command = devicectlBinary(ctx.devicectl);
      try { await execFileText(this.execFile, command, allArgs, { timeoutMs: (ctx.deviceTimeoutSec * 1000) + 5000, mutation }); }
      catch (error) {
        if (mutation) {
          let reply;
          try { reply = JSON.parse(await fs.promises.readFile(jsonPath, 'utf8')); } catch { /* No complete original reply: retain unknown ownership. */ }
          if (reply) error.devicectlReply = reply;
          const outcome = deviceCommandRejection(reply, allArgs.slice(devicectlPrefix(ctx.devicectl).length), error);
          if (outcome) error.deviceOutcome = outcome;
        }
        throw error;
      }
      return JSON.parse(await fs.promises.readFile(jsonPath, 'utf8'));
    } finally {
      await fs.promises.rm(jsonPath, { force: true });
    }
  }
}

function spawnWdaProcess(executable, args, logFile, mutation) {
  checkExecution();
  const out = fs.openSync(logFile, 'a');
  let child;
  try {
    child = spawn(executable, args, { detached: true, stdio: ['ignore', out, out], windowsHide: true, env: wdaBuildEnvironment() });
    if (mutation) child.once('spawn', () => markExecutionDispatched());
  } finally { fs.closeSync(out); }
  const state = { child, terminal: false, spawnError: null, exitCode: null };
  const closed = new Promise(resolve => {
    child.once('error', error => { state.spawnError = error; });
    child.once('close', code => { state.terminal = true; state.exitCode = code; resolve(); });
  });
  state.stop = async () => {
    if (state.terminal) return;
    const signalGroup = signal => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    signalGroup('SIGTERM');
    const escalation = setTimeout(() => signalGroup('SIGKILL'), 1500);
    try { await closed; } finally { clearTimeout(escalation); }
  };
  return state;
}

function parseDevicectlDevices(payload) {
  if (Array.isArray(payload?.result?.devices)) return payload.result.devices;
  if (Array.isArray(payload?.devices)) return payload.devices;
  return [];
}

function shapeDevice(device) {
  const state = device?.properties?.state || {};
  const hardware = device?.hardwareProperties || device?.properties?.hardware || {};
  const software = device?.deviceProperties || device?.properties?.software || {};
  const connection = device?.connectionProperties || device?.properties?.connection || {};
  return {
    identifier: device?.identifier || '',
    udid: hardware.udid || '',
    serialNumber: hardware.serialNumber || '',
    name: device?.deviceProperties?.name || state.name || '',
    platform: hardware.platform || 'iOS',
    productType: hardware.productType || '',
    marketingName: hardware.marketingName || '',
    osVersion: device?.deviceProperties?.osVersionNumber || software.osVersionNumber?.stringValue || '',
    osBuild: device?.deviceProperties?.osBuildUpdate || '',
    bootState: device?.deviceProperties?.bootState || normalizedObjectEnum(state.bootState),
    developerModeStatus: device?.deviceProperties?.developerModeStatus || normalizedObjectEnum(state.developerModeStatus),
    ddiServicesAvailable: device?.deviceProperties?.ddiServicesAvailable,
    pairingState: connection.pairingState || '',
    transportType: connection.transportType || '',
    tunnelState: connection.tunnelState || '',
    tunnelIPAddress: connection.tunnelIPAddress || connection.tunnelIPAddressString || '',
    potentialHostnames: Array.isArray(connection.potentialHostnames) ? connection.potentialHostnames : [],
  };
}

function selectDeviceFromList(devices, args = {}) {
  const target = String(args.deviceId || args.iosDeviceId || args.udid || args.serial || '').trim();
  const iosDevices = devices.filter((device) => !device.platform || String(device.platform).toLowerCase().includes('ios') || device.udid || device.identifier);
  if (target) {
    const device = iosDevices.find((item) => [item.identifier, item.udid, item.serialNumber, item.name].filter(Boolean).includes(target));
    return device
      ? { device }
      : { device: null, error: 'ios_device_not_found', message: `No connected iOS device matched ${target}.` };
  }
  if (iosDevices.length === 1) return { device: iosDevices[0] };
  if (iosDevices.length === 0) {
    return { device: null, error: 'ios_device_required', message: 'No connected iOS device was found by xcrun devicectl.' };
  }
  return {
    device: null,
    error: 'ios_device_ambiguous',
    message: 'Multiple iOS devices are connected. Pass --device-id with the devicectl identifier or UDID.',
  };
}

function devicectlBinary(value) {
  return path.basename(String(value || 'xcrun')) === 'xcrun' ? value : value;
}

function devicectlPrefix(value) {
  return path.basename(String(value || 'xcrun')) === 'xcrun' ? ['devicectl'] : [];
}

function formatHostForUrl(host) {
  const value = String(host || '').trim();
  if (value.includes(':') && !value.startsWith('[')) return `[${value}]`;
  return value;
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function parsePayload(args = {}) {
  return args.payload;
}

function captureQuery(args = {}) {
  return {
    sinceId: args.sinceId,
    sinceMs: args.sinceMs,
    limit: args.limit,
    view: args.view ?? (args.history === true || args.history === 'true' ? 'connected-history' : undefined),
    runtimeEpoch: args.runtimeEpoch,
    afterActionId: args.afterActionId,
    factCursor: args.factCursor,
    mobileFactId: args.mobileFactId,
    targetKey: args.targetKey,
  };
}

function withQuery(endpointPath, query) {
  const entries = Object.entries(query || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (entries.length === 0) return endpointPath;
  const params = new URLSearchParams();
  for (const [key, value] of entries) params.set(key, String(value));
  return `${endpointPath}?${params.toString()}`;
}

function iosSetupSuggestion(device, runtime, wda) {
  if (!device) return 'Connect one iPhone, trust this Mac on the device, then rerun ios-doctor.';
  if (device.developerModeStatus !== 'enabled') return 'Enable Developer Mode on the iPhone and rerun ios-setup.';
  if (device.ddiServicesAvailable !== true || device.tunnelState !== 'connected') return 'Unlock/trust the iPhone and let Xcode finish preparing a connected developer tunnel.';
  if (wda?.ok !== true) return 'Start the prepared Runner with ios-setup --start-wda --team-id, or supply its exact wdaRunnerBundleId. An optional wdaUrl still requires container binding.';
  if (runtime?.ok !== true) return 'Launch a debug App with AiAppBridgeIOS and supply its exact deviceId and bundleId.';
  return 'Rerun ios-setup after resolving the failing check.';
}

function iosErrorCode(command, error) {
  if (typeof error?.code === 'string' && /^[a-z][a-z0-9_]*$/.test(error.code)) return error.code;
  const stderr = String(error?.stderr || '');
  const stdout = String(error?.stdout || '');
  const message = String(error?.message || error || '');
  const text = [stderr, stdout, message]
    .filter(Boolean)
    .join('\n')
    .replace(/\s--timeout\s+\S+/g, '');
  if (/No code signature found|integrity could not be verified|ApplicationVerificationFailed/i.test(text)) {
    return 'ios_code_signing_required';
  }
  if (/profile has not been explicitly trusted|not been explicitly trusted by the user|inadequate entitlements|invalid code signature/i.test(text)) {
    return 'ios_developer_profile_trust_required';
  }
  if (/requested application .* is not installed|not installed|valid bundle identifier/i.test(text)) {
    return 'ios_app_not_installed';
  }
  if (/provisioning|development team|DEVELOPMENT_TEAM|Signing/i.test(text)) {
    return 'ios_provisioning_required';
  }
  if (/timed out|timeout/i.test(text)) {
    return 'ios_command_timeout';
  }
  if (/device.*not.*found|No connected iOS device/i.test(text)) {
    return 'ios_device_required';
  }
  return command ? `${command.replace(/-/g, '_')}_failed` : 'ios_command_failed';
}

function firstErrorLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function truncateText(value, maxChars) {
  const text = String(value || '');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

async function requestJson(method, rawUrl, body, options = {}) {
  return runExecution({ mutation: options.mutation ?? method !== 'GET' }, async () => {
    let text;
    try {
      text = await httpRequestBounded(rawUrl, { method, payload: body === null ? undefined : body,
        headers: { Accept: 'application/json', ...options.headers }, timeoutMs: options.timeoutMs ?? defaultHttpTimeoutMs,
        maxBytes: 8 * 1024 * 1024 });
    } catch (error) {
      if (error.responseBody) {
        try { error.response = JSON.parse(error.responseBody); } catch { /* preserve the transport failure */ }
      }
      throw error;
    }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw bindingFailure('invalid_ios_json_response', 'The iOS endpoint returned invalid JSON.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw bindingFailure('invalid_ios_json_response', 'The iOS endpoint must return a JSON object.');
    }
    return parsed;
  });
}

async function execFileText(execFileImpl, command, args, options = {}) {
  try {
    return await execFileBounded(command, args, { execFileImpl, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      timeoutMs: options.timeoutMs ?? 30000, mutation: options.mutation === true, windowsHide: true });
  } catch (error) {
    if (error.stderr) error.message += `\n${error.stderr}`;
    throw error;
  }
}

function normalizedObjectEnum(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return Object.keys(value)[0] || '';
  return String(value);
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

function stringArg(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function numberArg(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function booleanArg(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

module.exports = {
  IOSBridgeProvider,
  formatHostForUrl,
  parseDevicectlDevices,
  selectDeviceFromList,
  shapeDevice,
  requiredInputString,
};
