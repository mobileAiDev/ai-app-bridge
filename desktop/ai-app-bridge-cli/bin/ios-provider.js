const { execFile, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { defaultArtifactPath } = require('./artifact-paths');

const defaultRuntimePort = 18080;
const runtimePortSearchCount = 50;
const defaultHttpTimeoutMs = 5000;
const defaultProbeTimeoutMs = 700;
const defaultDeviceTimeoutSec = 30;
const defaultWdaBundleId = 'io.github.mobileaidev.aiappbridge.wda';

class IOSBridgeProvider {
  constructor(options = {}) {
    this.execFile = options.execFile || execFile;
    this.httpRequest = options.httpRequest || requestJson;
  }

  async run(command, args = {}) {
    try {
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
          return await this.runtimeGet(args, '/v1/h5/dom');
        case 'ios-h5-eval':
          return await this.runtimePost(args, '/v1/h5/eval', { script: requiredString(args.script, 'script') });
        case 'ios-flutter-tree':
          return await this.flutterTree(args);
        case 'ios-flutter-nodes':
          return await this.flutterNodes(args);
        case 'ios-flutter-action':
          return await this.runtimePost(args, '/v1/flutter/action', parsePayload(args));
        case 'ios-screenshot':
          return await this.screenshot(args);
        case 'ios-wda-status':
          return await this.wdaStatus(args);
        case 'ios-uia-tree':
          return await this.wdaSource(args);
        case 'ios-tap':
          return await this.wdaTap(args);
        case 'ios-input':
          return await this.wdaInput(args);
        case 'ios-swipe':
          return await this.wdaSwipe(args);
        default:
          return { ok: false, error: 'unknown_ios_command', command };
      }
    } catch (error) {
      return {
        ok: false,
        error: iosErrorCode(command, error),
        command,
        message: firstErrorLine(error.message || String(error)),
        details: truncateText(error.message || String(error), 4000),
      };
    }
  }

  context(args = {}) {
    return {
      devicectl: stringArg(args.devicectl, process.env.AI_APP_BRIDGE_DEVICECTL || 'xcrun'),
      xcodebuild: stringArg(args.xcodebuild, process.env.XCODEBUILD || 'xcodebuild'),
      deviceTimeoutSec: numberArg(args.deviceTimeoutSec, defaultDeviceTimeoutSec),
      httpTimeoutMs: numberArg(args.httpTimeoutMs, defaultHttpTimeoutMs),
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

    let wda = { ok: false, error: 'wda_url_required' };
    if (args.wdaUrl || process.env.AI_APP_BRIDGE_WDA_URL) {
      wda = await this.wdaStatus(args);
    }
    checks.push({ name: 'wda', ok: wda.ok === true, url: wda.url || null, error: wda.error || null });

    const developerModeReady = selected ? selected.developerModeStatus === 'enabled' : false;
    const ddiReady = selected ? selected.ddiServicesAvailable !== false : false;
    const ready = Boolean(xcode.ok && selected && developerModeReady && ddiReady && wda.ok === true);
    return {
      ok: true,
      ready,
      fullControlReady: ready,
      checks,
      devices,
      selectedDevice: selected,
      requirements: {
        xcode: xcode.ok,
        deviceConnected: Boolean(selected),
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
    if (args.bundleId) {
      const launch = await this.launchApp({ ...args, deviceId: device.identifier || device.udid });
      steps.push({ name: 'launch-app', ...launch });
      if (launch.ok === false) return { ok: false, error: 'ios_app_launch_failed', device, steps };
    }

    const runtime = args.bundleId || args.runtimeUrl || args.iosHost || args.host
      ? await this.runtimeGet(args, '/v1/status', { allowUnavailable: true, device })
      : { ok: false, error: 'bundle_id_or_runtime_endpoint_required' };
    steps.push({ name: 'runtime', ok: runtime.ok === true, endpoint: runtime.endpoint || null, error: runtime.error || null });

    let wda = await this.wdaStatus(args);
    if (wda.ok !== true && booleanArg(args.startWda)) {
      const start = await this.startWda({ ...args, deviceId: device.identifier || device.udid });
      steps.push({ name: 'start-wda', ...start });
      if (start.ok === true) {
        wda = start.status || await this.wdaStatus(args);
      }
    }
    steps.push({ name: 'wda', ok: wda.ok === true, url: wda.url || null, error: wda.error || null });

    if (wda.ok !== true) {
      return {
        ok: false,
        error: 'ios_wda_required',
        device,
        steps,
        message: 'Full iOS control requires WebDriverAgent/XCUITest to be built, signed, installed, and reachable. Pass --wda-url for an existing WDA, or pass --wda-project-path, --team-id, and --start-wda to let setup run xcodebuild.',
      };
    }
    if (runtime.ok !== true) {
      return {
        ok: false,
        error: 'ios_runtime_required',
        device,
        steps,
        message: 'WDA is reachable, but the in-app iOS runtime is not reachable. Launch a debug app that includes AiAppBridgeIOS and pass bundleId/iosHost/iosPort if auto-discovery cannot find it.',
      };
    }

    return {
      ok: true,
      ready: true,
      fullControlReady: true,
      device,
      runtimeEndpoint: runtime.endpoint,
      wdaUrl: wda.url,
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
    ]);
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
    const raw = await this.devicectlJson(ctx, launchArgs);
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
    return {
      ok: true,
      device,
      outFile,
      result: raw.result || raw,
    };
  }

  async runtimeGet(args, endpointPath, options = {}) {
    const endpoint = await this.resolveRuntimeEndpoint(args, options);
    if (!endpoint.ok) return endpoint;
    try {
      const response = await this.httpRequest('GET', `${endpoint.baseUrl}${endpointPath}`, null, {
        timeoutMs: numberArg(args.httpTimeoutMs, defaultHttpTimeoutMs),
      });
      return {
        ...(response && typeof response === 'object' ? response : { value: response }),
        ok: response?.ok === false ? false : true,
        endpoint: endpoint.baseUrl,
        device: endpoint.device || null,
      };
    } catch (error) {
      if (options.allowUnavailable) {
        return { ok: false, error: 'ios_runtime_unreachable', endpoint: endpoint.baseUrl, message: error.message };
      }
      throw error;
    }
  }

  async runtimePost(args, endpointPath, body) {
    const endpoint = await this.resolveRuntimeEndpoint(args);
    if (!endpoint.ok) return endpoint;
    const response = await this.httpRequest('POST', `${endpoint.baseUrl}${endpointPath}`, body, {
      timeoutMs: numberArg(args.httpTimeoutMs, defaultHttpTimeoutMs),
    });
    return {
      ...(response && typeof response === 'object' ? response : { value: response }),
      ok: response?.ok === false ? false : true,
      endpoint: endpoint.baseUrl,
      device: endpoint.device || null,
    };
  }

  async flutterTree(args = {}) {
    const status = await this.runtimeGet(args, '/v1/status');
    if (status.ok === false) return status;
    return {
      ok: true,
      endpoint: status.endpoint,
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
      ok: Boolean(operable),
      endpoint: tree.endpoint,
      device: tree.device || null,
      operable,
      nodes: operable?.nodes || [],
      count: operable?.count || 0,
      error: operable ? null : 'flutter_operable_tree_absent',
    };
  }

  async resolveRuntimeEndpoint(args = {}, options = {}) {
    if (args.runtimeUrl) {
      return { ok: true, baseUrl: stripTrailingSlash(String(args.runtimeUrl)), device: options.device || null };
    }
    const explicitHost = args.iosHost || args.host;
    const explicitPort = args.iosPort || args.port;
    const device = options.device || await this.optionalDevice(args);
    let port = explicitPort ? Number(explicitPort) : null;
    let portSource = explicitPort ? 'explicit' : '';
    if (!port && args.bundleId && device) {
      const copied = await this.readRuntimePortFile(args, device);
      if (copied.ok && copied.port) {
        port = copied.port;
        portSource = 'app-container-port-file';
      }
    }

    const hosts = runtimeHostCandidates(explicitHost, device);
    if (port && hosts.length) {
      return {
        ok: true,
        baseUrl: `http://${formatHostForUrl(hosts[0])}:${port}`,
        device,
        port,
        portSource,
        hostSource: explicitHost ? 'explicit' : 'device',
      };
    }

    if (hosts.length) {
      const probe = await this.probeRuntimeHosts(hosts, args, device);
      if (probe.ok) return probe;
    }

    if (!hosts.length) {
      return {
        ok: false,
        error: 'ios_tunnel_unavailable',
        device,
        message: 'No iOS runtime host is available. Pass --runtime-url or --ios-host, or enable Developer Mode/unlock the device so devicectl exposes a tunnel IP.',
      };
    }
    return {
      ok: false,
      error: 'ios_runtime_port_unavailable',
      device,
      message: 'Could not discover the AiAppBridgeIOS runtime port. Pass --ios-port or launch an app that writes ai_app_bridge_port.json through the iOS runtime.',
    };
  }

  async probeRuntimeHosts(hosts, args, device) {
    const timeoutMs = numberArg(args.probeTimeoutMs, defaultProbeTimeoutMs);
    const start = Number(args.portStart || defaultRuntimePort);
    const count = Number(args.portSearchCount || runtimePortSearchCount);
    for (const host of hosts) {
      for (let offset = 0; offset < count; offset += 1) {
        const port = start + offset;
        const baseUrl = `http://${formatHostForUrl(host)}:${port}`;
        try {
          const status = await this.httpRequest('GET', `${baseUrl}/v1/status`, null, { timeoutMs });
          if (status && status.debugBridge) {
            return { ok: true, baseUrl, device, port, portSource: 'runtime-probe', hostSource: 'probe' };
          }
        } catch (_) {
          // Probe failures are expected while scanning.
        }
      }
    }
    return { ok: false };
  }

  async readRuntimePortFile(args, device) {
    const ctx = {
      ...this.context(args),
      deviceTimeoutSec: numberArg(args.portFileTimeoutSec, 5),
    };
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-app-bridge-ios-port-'));
    try {
      await this.devicectlJson(ctx, [
        'device',
        'copy',
        'from',
        '--device',
        device.identifier || device.udid,
        '--domain-type',
        'appDataContainer',
        '--domain-identifier',
        requiredString(args.bundleId, 'bundleId'),
        '--source',
        'Documents/ai_app_bridge_port.json',
        '--destination',
        tempDir,
      ]);
      const portFile = findFileByName(tempDir, 'ai_app_bridge_port.json');
      if (!portFile) return { ok: false, error: 'ios_runtime_port_file_absent' };
      const payload = JSON.parse(await fs.promises.readFile(portFile, 'utf8'));
      const port = Number(payload.port);
      return Number.isFinite(port) ? { ok: true, port, payload } : { ok: false, error: 'invalid_ios_runtime_port_file', payload };
    } catch (error) {
      return { ok: false, error: 'ios_runtime_port_file_unavailable', message: error.message };
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }

  async wdaStatus(args = {}) {
    const url = wdaBaseUrl(args);
    try {
      const response = await this.httpRequest('GET', `${url}/status`, null, {
        timeoutMs: numberArg(args.httpTimeoutMs, defaultHttpTimeoutMs),
      });
      return {
        ok: true,
        url,
        value: response?.value || response,
      };
    } catch (error) {
      return {
        ok: false,
        error: 'ios_wda_unreachable',
        url,
        message: error.message,
      };
    }
  }

  async wdaSource(args = {}) {
    const session = await this.ensureWdaSession(args);
    if (!session.ok) return session;
    const response = await this.wdaRequest(args, 'GET', `/session/${session.sessionId}/source?format=json`);
    return { ok: true, session, source: response?.value || response };
  }

  async wdaTap(args = {}) {
    const x = requiredNumber(args.tapX ?? args.x, 'tapX');
    const y = requiredNumber(args.tapY ?? args.y, 'tapY');
    const session = await this.ensureWdaSession(args);
    if (!session.ok) return session;
    const body = { x, y };
    try {
      const response = await this.wdaRequest(args, 'POST', `/session/${session.sessionId}/wda/tap/0`, body);
      return { ok: true, transport: 'wda', action: 'tap', session, x, y, response };
    } catch (firstError) {
      const response = await this.wdaRequest(args, 'POST', `/session/${session.sessionId}/actions`, pointerAction(x, y));
      return { ok: true, transport: 'wda-actions', action: 'tap', session, x, y, firstError: firstError.message, response };
    }
  }

  async wdaInput(args = {}) {
    const text = requiredString(args.text || args.value, 'text');
    const session = await this.ensureWdaSession(args);
    if (!session.ok) return session;
    const tapped = args.tapX !== undefined && args.tapY !== undefined
      ? await this.wdaTap({ ...args, wdaSessionId: session.sessionId })
      : null;
    const body = { value: [...text], text };

    const elementTarget = await this.resolveInputElement(args, session, tapped);
    if (elementTarget.elementId) {
      const elementPath = `/session/${session.sessionId}/element/${encodeURIComponent(elementTarget.elementId)}`;
      const clickResponse = await this.wdaRequest(args, 'POST', `${elementPath}/click`, {});
      const clearResponse = booleanArg(args.clearFirst)
        ? await this.wdaRequest(args, 'POST', `${elementPath}/clear`, {})
        : null;
      const response = await this.wdaRequest(args, 'POST', `${elementPath}/value`, body);
      return {
        ok: true,
        transport: 'wda-element-value',
        action: 'input',
        session,
        textLength: text.length,
        tapped,
        element: elementTarget,
        clicked: Boolean(clickResponse),
        cleared: Boolean(clearResponse),
        response,
      };
    }

    try {
      const response = await this.wdaRequest(args, 'POST', `/session/${session.sessionId}/keys`, body);
      return { ok: true, transport: 'wda', action: 'input', session, textLength: text.length, tapped, response };
    } catch (firstError) {
      const response = await this.wdaRequest(args, 'POST', `/session/${session.sessionId}/wda/keys`, body);
      return { ok: true, transport: 'wda', action: 'input', session, textLength: text.length, tapped, firstError: firstError.message, response };
    }
  }

  async resolveInputElement(args, session, tapped) {
    if (args.elementId) {
      return { elementId: String(args.elementId), source: 'explicit-element-id' };
    }
    if (args.accessibilityId) {
      const response = await this.wdaRequest(args, 'POST', `/session/${session.sessionId}/element`, {
        using: 'accessibility id',
        value: String(args.accessibilityId),
      });
      return {
        elementId: wdaElementIdFromResponse(response),
        source: 'accessibility-id',
        accessibilityId: String(args.accessibilityId),
        response,
      };
    }
    if (tapped?.ok === true) {
      try {
        const response = await this.wdaRequest(args, 'GET', `/session/${session.sessionId}/element/active`);
        return {
          elementId: wdaElementIdFromResponse(response),
          source: 'active-element-after-tap',
          response,
        };
      } catch (_) {
        return { elementId: '', source: 'active-element-unavailable' };
      }
    }
    return { elementId: '', source: 'none' };
  }

  async wdaSwipe(args = {}) {
    const startX = requiredNumber(args.startX, 'startX');
    const startY = requiredNumber(args.startY, 'startY');
    const endX = requiredNumber(args.endX, 'endX');
    const endY = requiredNumber(args.endY, 'endY');
    const durationMs = numberArg(args.durationMs, 500);
    const session = await this.ensureWdaSession(args);
    if (!session.ok) return session;
    const actions = swipeAction(startX, startY, endX, endY, durationMs);
    try {
      const response = await this.wdaRequest(args, 'POST', `/session/${session.sessionId}/actions`, actions);
      return { ok: true, transport: 'wda-actions', action: 'swipe', session, startX, startY, endX, endY, durationMs, response };
    } catch (firstError) {
      const response = await this.wdaRequest(args, 'POST', `/session/${session.sessionId}/wda/dragfromtoforduration`, {
        fromX: startX,
        fromY: startY,
        toX: endX,
        toY: endY,
        duration: Math.max(durationMs / 1000, 0.05),
      });
      return { ok: true, transport: 'wda-drag', action: 'swipe', session, startX, startY, endX, endY, durationMs, firstError: firstError.message, response };
    }
  }

  async ensureWdaSession(args = {}) {
    if (args.wdaSessionId) {
      return { ok: true, sessionId: String(args.wdaSessionId), reused: true };
    }
    const bundleId = args.bundleId ? String(args.bundleId) : undefined;
    const body = {
      capabilities: {
        alwaysMatch: {
          platformName: 'iOS',
          automationName: 'XCUITest',
          ...(bundleId ? { bundleId } : {}),
        },
        firstMatch: [{}],
      },
      desiredCapabilities: {
        platformName: 'iOS',
        automationName: 'XCUITest',
        ...(bundleId ? { bundleId } : {}),
      },
    };
    try {
      const response = await this.wdaRequest(args, 'POST', '/session', body);
      const sessionId = wdaSessionIdFromResponse(response);
      if (!sessionId) {
        return { ok: false, error: 'ios_wda_session_missing', response };
      }
      return { ok: true, sessionId, created: true, bundleId: bundleId || null };
    } catch (error) {
      return {
        ok: false,
        error: 'ios_wda_session_failed',
        message: error.message,
        suggestion: 'Ensure WebDriverAgentRunner is installed, signed, running, and reachable; pass --wda-url if it is not on http://127.0.0.1:8100.',
      };
    }
  }

  async wdaRequest(args, method, endpointPath, body) {
    return this.httpRequest(method, `${wdaBaseUrl(args)}${endpointPath}`, body, {
      timeoutMs: numberArg(args.httpTimeoutMs, defaultHttpTimeoutMs),
    });
  }

  async startWda(args = {}) {
    const wdaProjectPath = resolveWdaProjectPath(args);
    if (!wdaProjectPath) {
      return {
        ok: false,
        error: 'ios_wda_project_required',
        message: 'Cannot start WDA because no WebDriverAgent.xcodeproj was found. Pass --wda-project-path or install a package that vendors appium-webdriveragent.',
      };
    }
    const teamId = args.teamId || process.env.DEVELOPMENT_TEAM || process.env.AI_APP_BRIDGE_IOS_TEAM_ID;
    if (!teamId) {
      return {
        ok: false,
        error: 'ios_team_id_required',
        message: 'Cannot sign WebDriverAgentRunner without a DEVELOPMENT_TEAM. Add an Apple account in Xcode and pass --team-id.',
      };
    }
    const wdaBundleId = stringArg(args.wdaBundleId, process.env.AI_APP_BRIDGE_WDA_BUNDLE_ID || defaultWdaBundleId);
    const ctx = this.context(args);
    const device = await this.requireDevice(args);
    const xcodeArgs = [
      '-project',
      wdaProjectPath,
      '-scheme',
      'WebDriverAgentRunner',
      '-destination',
      `id=${device.udid || device.identifier}`,
      'DEVELOPMENT_TEAM=' + teamId,
      'PRODUCT_BUNDLE_IDENTIFIER=' + wdaBundleId,
      '-allowProvisioningUpdates',
      'test',
    ];
    const logFile = path.join(os.tmpdir(), `ai-app-bridge-wda-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
    const out = fs.openSync(logFile, 'a');
    const child = spawn(ctx.xcodebuild, xcodeArgs, {
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    fs.closeSync(out);
    let spawnError = null;
    let exited = false;
    child.once('error', (error) => { spawnError = error; });
    child.once('exit', () => { exited = true; });
    child.unref();
    await sleep(1200);
    if (spawnError) {
      return { ok: false, error: 'ios_wda_xcodebuild_spawn_failed', message: spawnError.message, logFile };
    }
    const deadline = Date.now() + numberArg(args.wdaStartupTimeoutMs, 60000);
    while (Date.now() < deadline) {
      const status = await this.bestWdaStatus(args, device, logFile);
      if (status.ok) {
        return {
          ok: true,
          device,
          wdaProjectPath,
          wdaBundleId,
          teamId,
          pid: child.pid,
          logFile,
          status,
        };
      }
      if (exited) {
        return {
          ok: false,
          error: 'ios_wda_xcodebuild_exited',
          device,
          wdaProjectPath,
          wdaBundleId,
          teamId,
          pid: child.pid,
          logFile,
          message: 'xcodebuild exited before WebDriverAgent became reachable. Check the log file for signing or provisioning errors.',
        };
      }
      await sleep(1000);
    }
    return {
      ok: false,
      error: 'ios_wda_start_timeout',
      device,
      wdaProjectPath,
      wdaBundleId,
      teamId,
      pid: child.pid,
      logFile,
      message: 'Timed out waiting for WebDriverAgent /status. If Xcode is showing a signing, trust, or device prompt, resolve it and rerun ios-setup.',
    };
  }

  async bestWdaStatus(args, device, logFile) {
    const urls = [
      args.wdaUrl || process.env.AI_APP_BRIDGE_WDA_URL || '',
      device?.tunnelIPAddress ? `http://${formatHostForUrl(device.tunnelIPAddress)}:8100` : '',
      parseWdaServerUrlFromLog(logFile),
      'http://127.0.0.1:8100',
    ].filter(Boolean);
    const uniqueUrls = [...new Set(urls.map(stripTrailingSlash))];
    let last = null;
    for (const url of uniqueUrls) {
      const status = await this.wdaStatus({ ...args, wdaUrl: url });
      if (status.ok) return status;
      last = status;
    }
    return last || { ok: false, error: 'ios_wda_unreachable', url: 'http://127.0.0.1:8100' };
  }

  async optionalDevice(args = {}) {
    try {
      return await this.requireDevice(args);
    } catch (_) {
      return null;
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

  async devicectlJson(ctx, args) {
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
      await execFileText(this.execFile, command, allArgs, { timeoutMs: (ctx.deviceTimeoutSec * 1000) + 5000 });
      return JSON.parse(await fs.promises.readFile(jsonPath, 'utf8'));
    } finally {
      await fs.promises.rm(jsonPath, { force: true });
    }
  }
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

function runtimeHostCandidates(explicitHost, device) {
  const hosts = [];
  if (explicitHost) hosts.push(String(explicitHost));
  if (device?.tunnelIPAddress) hosts.push(device.tunnelIPAddress);
  if (Array.isArray(device?.potentialHostnames)) hosts.push(...device.potentialHostnames);
  return [...new Set(hosts.filter(Boolean))];
}

function formatHostForUrl(host) {
  const value = String(host || '').trim();
  if (value.includes(':') && !value.startsWith('[')) return `[${value}]`;
  return value;
}

function wdaBaseUrl(args = {}) {
  return stripTrailingSlash(String(args.wdaUrl || process.env.AI_APP_BRIDGE_WDA_URL || 'http://127.0.0.1:8100'));
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function wdaSessionIdFromResponse(response) {
  return response?.sessionId
    || response?.value?.sessionId
    || response?.value?.session_id
    || response?.value?.capabilities?.sessionId
    || '';
}

function wdaElementIdFromResponse(response) {
  return response?.value?.ELEMENT
    || response?.value?.['element-6066-11e4-a52e-4f735466cecf']
    || response?.ELEMENT
    || response?.['element-6066-11e4-a52e-4f735466cecf']
    || '';
}

function parseWdaServerUrlFromLog(logFile) {
  if (!logFile) return '';
  try {
    const text = fs.readFileSync(logFile, 'utf8');
    const matches = [...text.matchAll(/ServerURLHere->(http:\/\/[^<\s]+)<-ServerURLHere/g)];
    return matches.length ? matches[matches.length - 1][1] : '';
  } catch (_) {
    return '';
  }
}

function pointerAction(x, y) {
  return {
    actions: [{
      type: 'pointer',
      id: 'finger1',
      parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, origin: 'viewport', x, y },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 60 },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  };
}

function swipeAction(startX, startY, endX, endY, durationMs) {
  return {
    actions: [{
      type: 'pointer',
      id: 'finger1',
      parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, origin: 'viewport', x: startX, y: startY },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 80 },
        { type: 'pointerMove', duration: durationMs, origin: 'viewport', x: endX, y: endY },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  };
}

function parsePayload(args = {}) {
  if (args.payload && typeof args.payload === 'object') return args.payload;
  if (args.payload) return JSON.parse(String(args.payload));
  return { action: requiredString(args.action, 'action') };
}

function captureQuery(args = {}) {
  return {
    sinceId: args.sinceId,
    sinceMs: args.sinceMs,
    limit: args.limit,
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
  if (device.ddiServicesAvailable === false) return 'Unlock/trust the iPhone and let Xcode finish preparing developer services.';
  if (wda?.ok !== true) return 'Start or build WebDriverAgentRunner, then pass --wda-url if it is not on http://127.0.0.1:8100.';
  if (runtime?.ok !== true) return 'Launch a debug app that includes AiAppBridgeIOS, then pass bundleId/iosHost/iosPort if needed.';
  return 'Rerun ios-setup after resolving the failing check.';
}

function iosErrorCode(command, error) {
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

function resolveWdaProjectPath(args = {}) {
  const explicit = args.wdaProjectPath || process.env.AI_APP_BRIDGE_WDA_PROJECT;
  if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);
  const candidates = [
    path.join(process.cwd(), 'node_modules', 'appium-webdriveragent', 'WebDriverAgent.xcodeproj'),
    path.join(process.cwd(), 'node_modules', 'appium-xcuitest-driver', 'node_modules', 'appium-webdriveragent', 'WebDriverAgent.xcodeproj'),
    path.join(__dirname, '..', 'node_modules', 'appium-webdriveragent', 'WebDriverAgent.xcodeproj'),
    path.join(__dirname, '..', 'node_modules', 'appium-xcuitest-driver', 'node_modules', 'appium-webdriveragent', 'WebDriverAgent.xcodeproj'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function requestJson(method, rawUrl, body, options = {}) {
  const url = new URL(rawUrl);
  const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const request = http.request({
      method,
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port,
      path: `${url.pathname}${url.search}`,
      timeout: options.timeoutMs || defaultHttpTimeoutMs,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch (_) {
          parsed = { raw: text };
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(`HTTP ${response.statusCode}: ${text.slice(0, 500)}`);
          error.response = parsed;
          reject(error);
          return;
        }
        resolve(parsed);
      });
    });
    request.on('timeout', () => {
      request.destroy(new Error(`HTTP timeout: ${rawUrl}`));
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function execFileText(execFileImpl, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeoutMs || 30000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}${stderr ? `\n${stderr}` : ''}`;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function findFileByName(root, fileName) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) return candidate;
    if (entry.isDirectory()) {
      const found = findFileByName(candidate, fileName);
      if (found) return found;
    }
  }
  return '';
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  IOSBridgeProvider,
  formatHostForUrl,
  parseDevicectlDevices,
  selectDeviceFromList,
  shapeDevice,
  wdaSessionIdFromResponse,
};
