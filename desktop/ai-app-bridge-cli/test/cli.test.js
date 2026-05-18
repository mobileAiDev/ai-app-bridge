const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  buildBridgeFailureResult,
  artifactTimestamp,
  compactBridgeTree,
  compactStatus,
  compactUiaTree,
  defaultArtifactDirectory,
  defaultArtifactPath,
  defaultInstallerButtonTexts,
  findFlutterNode,
  findTappableNodeByText,
  flutterNodePoint,
  flutterPhysicalViewport,
  helpText,
  installerButtonTextsForSurface,
  isAdbInputTextSafe,
  isLikelyInstallerSurface,
  normalizeBridgeError,
  parseWebViewDevToolsSockets,
  parseKeyboardState,
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
  screenshotOutputPath,
  statusSearchText,
  uiautomatorLockPath,
  waitTextConditionsMet,
  withFileLock,
} = require('../bin/ai-app-bridge.js');

const cliPath = path.join(__dirname, '..', 'bin', 'ai-app-bridge.js');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('--help prints usage without probing adb', () => {
  const output = execFileSync(process.execPath, [cliPath, '--help'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ADB: 'adb-that-should-not-run',
    },
  });

  assert.equal(output, `${helpText}\n`);
  assert.match(output, /Usage: ai-app-bridge <command>/);
  assert.match(output, /--package-name <name>/);
  assert.match(output, /--text <text>\s+Text used by Unicode-safe bridge input commands\./);
});

test('help command prints usage without probing adb', () => {
  const output = execFileSync(process.execPath, [cliPath, 'help'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ADB: 'adb-that-should-not-run',
    },
  });

  assert.equal(output, `${helpText}\n`);
});

test('help documents every implemented CLI command', () => {
  const source = fs.readFileSync(cliPath, 'utf8');
  const implementedCommands = [...source.matchAll(/case '([^']+)'/g)]
    .map((match) => match[1])
    .sort();

  for (const command of implementedCommands) {
    assert.match(helpText, new RegExp(`^\\s{2}${escapeRegExp(command)}\\s`, 'm'));
  }
  assert.match(helpText, /^\s{2}help\s/m);
});

test('ADB input fallback is limited to ASCII text', () => {
  assert.equal(isAdbInputTextSafe('hello world 123'), true);
  assert.equal(isAdbInputTextSafe('name_with-symbols.@'), true);
  assert.equal(isAdbInputTextSafe('斗破苍穹'), false);
  assert.equal(isAdbInputTextSafe('hello🙂'), false);
});

test('generated default artifact paths are unique and run-scoped', () => {
  assert.equal(
    path.relative(process.cwd(), defaultArtifactDirectory()),
    path.join('build', 'ai_app_bridge_artifacts'),
  );

  const first = defaultArtifactPath('ai app bridge screenshot', 'png', {
    artifactDir: path.join(os.tmpdir(), 'ai-app-bridge-artifact-test'),
    now: new Date('2026-05-12T10:11:12.123Z'),
    pid: 42,
    randomSuffix: 'abc123',
  });
  const second = defaultArtifactPath('ai app bridge screenshot', 'png', {
    artifactDir: path.join(os.tmpdir(), 'ai-app-bridge-artifact-test'),
    now: new Date('2026-05-12T10:11:12.123Z'),
    pid: 42,
    randomSuffix: 'def456',
  });

  assert.equal(artifactTimestamp(new Date('2026-05-12T10:11:12.123Z')), '20260512-101112-123');
  assert.equal(path.dirname(first), path.resolve(path.join(os.tmpdir(), 'ai-app-bridge-artifact-test')));
  assert.equal(path.basename(first), 'ai_app_bridge_screenshot-20260512-101112-123-42-abc123.png');
  assert.notEqual(first, second);
});

test('screenshot default output path uses generated artifacts unless explicit', () => {
  assert.equal(
    path.dirname(screenshotOutputPath()),
    path.resolve('build', 'ai_app_bridge_artifacts'),
  );
  assert.match(
    screenshotOutputPath({ artifactDir: path.join(os.tmpdir(), 'ai-app-bridge-artifact-test') }),
    /ai_app_bridge_screenshot-\d{8}-\d{6}-\d{3}-\d+-[a-z0-9]+\.png$/,
  );
  assert.match(
    screenshotOutputPath({ artifactDir: path.join(os.tmpdir(), 'ai-app-bridge-artifact-test') }, 'ai_app_bridge_smoke_screenshot'),
    /ai_app_bridge_smoke_screenshot-\d{8}-\d{6}-\d{3}-\d+-[a-z0-9]+\.png$/,
  );
  assert.equal(
    screenshotOutputPath({ outFile: path.join(os.tmpdir(), 'custom.png') }),
    path.join(os.tmpdir(), 'custom.png'),
  );
});

test('generated screenshot artifact pruning keeps the newest 20 per prefix', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-app-bridge-prune-test-'));
  try {
    const baseTime = new Date('2026-05-12T10:00:00.000Z').getTime();
    const makeFile = (name, index) => {
      const filePath = path.join(directory, name);
      fs.writeFileSync(filePath, String(index));
      const mtime = new Date(baseTime + index * 1000);
      fs.utimesSync(filePath, mtime, mtime);
      return filePath;
    };

    for (let index = 0; index < 23; index += 1) {
      makeFile(`ai_app_bridge_screenshot-20260512-1000${String(index).padStart(2, '0')}-000-42-${String(index).padStart(6, 'a')}.png`, index);
    }
    const currentPath = makeFile('ai_app_bridge_screenshot-20260512-100099-000-42-current.png', 99);
    const smokePath = makeFile('ai_app_bridge_smoke_screenshot-20260512-100000-000-42-smoke1.png', 100);
    const explicitPath = makeFile('manual.png', 101);

    const result = await pruneGeneratedArtifacts({
      directory,
      prefix: 'ai_app_bridge_screenshot',
      extension: 'png',
      currentPath,
    });

    const remaining = fs.readdirSync(directory);
    const screenshotFiles = remaining.filter((name) => name.startsWith('ai_app_bridge_screenshot-'));
    assert.equal(result.keep, 20);
    assert.equal(result.deleted, 4);
    assert.equal(screenshotFiles.length, 20);
    assert.equal(fs.existsSync(currentPath), true);
    assert.equal(fs.existsSync(smokePath), true);
    assert.equal(fs.existsSync(explicitPath), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('normalizes socket hang-up as structured not-ready status', () => {
  const error = new Error('socket hang up');
  error.code = 'ECONNRESET';

  const normalized = normalizeBridgeError(error);
  assert.equal(normalized.code, 'bridge_not_ready');

  const result = buildBridgeFailureResult(
    {
      packageName: 'com.example.reader',
      port: 18080,
      hostPort: 18083,
      devicePort: 18083,
      devicePortSource: 'package-port-file',
      explicitPort: false,
    },
    'status',
    '/v1/status',
    error,
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, 'bridge_not_ready');
  assert.equal(result.packageName, 'com.example.reader');
  assert.equal(result.attempted.localPort, 18083);
  assert.equal(result.attempted.devicePort, 18083);
});

test('normalizes status HTTP timeout as structured not-ready status', () => {
  const normalized = normalizeBridgeError(new Error('HTTP timeout: http://127.0.0.1:18080/v1/status'));
  assert.equal(normalized.code, 'bridge_not_ready');
});

test('normalizes adb timeout separately from bridge HTTP readiness', () => {
  const normalized = normalizeBridgeError(new Error('adb timed out after 15000ms: adb shell run-as app cat file'));
  assert.equal(normalized.code, 'adb_timeout');
});

test('parses foreground package and activity from window dumpsys lines', () => {
  const line = 'mCurrentFocus=Window{123 u0 com.example.reader/.ui.activity.MainActivity}';
  const component = parseComponentFromWindowLine(line);
  assert.deepEqual(component, {
    packageName: 'com.example.reader',
    activity: 'com.example.reader.ui.activity.MainActivity',
    component: 'com.example.reader/.ui.activity.MainActivity',
  });

  const foreground = parseForegroundWindow(`irrelevant\n${line}\n`);
  assert.equal(foreground.ok, true);
  assert.equal(foreground.source, 'mCurrentFocus');
  assert.equal(foreground.packageName, 'com.example.reader');
  assert.equal(foreground.activity, 'com.example.reader.ui.activity.MainActivity');
});

test('tap-text candidate selection skips offscreen bridge nodes', () => {
  const tree = {
    root: {
      bounds: { left: 0, top: 0, right: 100, bottom: 200, width: 100, height: 200 },
      children: [
        {
          text: 'Open Detail',
          visible: true,
          effectiveVisible: true,
          bounds: { left: 0, top: 240, right: 100, bottom: 280, width: 100, height: 40 },
        },
        {
          text: 'Open Detail',
          visible: true,
          effectiveVisible: true,
          bounds: { left: 0, top: 20, right: 100, bottom: 60, width: 100, height: 40 },
        },
      ],
    },
  };

  const match = findTappableNodeByText(tree, 'Open Detail');
  assert.equal(match.node.bounds.top, 20);
});

test('tap-text candidate selection reports offscreen-only bridge match', () => {
  const tree = {
    root: {
      bounds: { left: 0, top: 0, right: 100, bottom: 200, width: 100, height: 200 },
      children: [
        {
          contentDescription: 'Hidden Action',
          visible: true,
          effectiveVisible: true,
          bounds: { left: 0, top: 260, right: 100, bottom: 300, width: 100, height: 40 },
        },
      ],
    },
  };

  const match = findTappableNodeByText(tree, 'Hidden Action');
  assert.equal(match.node, null);
  assert.equal(match.rejected.reason, 'center_outside_viewport');
});

test('flutter tap fallback resolves operable text to physical coordinates', () => {
  const viewport = {
    devicePixelRatio: 3.5,
    logicalWidth: 361.14285714285717,
    logicalHeight: 794.2857142857143,
    physicalWidth: 1264,
    physicalHeight: 2780,
  };
  const operable = {
    viewport,
    nodes: [
      {
        text: 'Run AI Bridge Probe',
        actions: ['tap'],
        tap: {
          bounds: {
            left: 54,
            top: 222,
            right: 176.9781265258789,
            bottom: 242,
            centerX: 115.48906326293945,
            centerY: 232,
          },
        },
      },
    ],
  };

  const node = findFlutterNode(operable, 'Run AI Bridge Probe', 'tap');
  assert.equal(node.text, 'Run AI Bridge Probe');
  assert.deepEqual(flutterNodePoint(node.tap.bounds, viewport), { x: 404, y: 812 });
  assert.deepEqual(flutterPhysicalViewport(viewport), {
    left: 0,
    top: 0,
    right: 1264,
    bottom: 2780,
    width: 1264,
    height: 2780,
  });
});

test('parses visible Android keyboard state from dumpsys input_method markers', () => {
  const visible = parseKeyboardState('mInputShown=true\nmImeWindowVis=0x1');
  assert.equal(visible.ok, true);
  assert.equal(visible.visible, true);
  assert.deepEqual(visible.markers, ['mInputShown=true', 'mImeWindowVis']);

  const hidden = parseKeyboardState('mInputShown=false\nmImeWindowVis=0x0');
  assert.equal(hidden.visible, false);

  const staleInputView = parseKeyboardState('mImeWindowVis=0\nmInputShown=false\nmWindowVisible=false\nmIsInputViewShown=true');
  assert.equal(staleInputView.visible, false);
  assert.ok(staleInputView.hiddenMarkers.includes('mWindowVisible=false'));
});

test('keyboard guard only dismisses for lower-screen targets while IME is visible', () => {
  const viewport = { left: 0, top: 0, right: 1080, bottom: 2400 };
  assert.equal(shouldDismissKeyboardForPoint({
    point: { x: 540, y: 1800 },
    viewport,
    keyboardVisible: true,
  }).dismiss, true);
  assert.equal(shouldDismissKeyboardForPoint({
    point: { x: 540, y: 500 },
    viewport,
    keyboardVisible: true,
  }).dismiss, false);
  assert.equal(shouldDismissKeyboardForPoint({
    point: { x: 540, y: 1800 },
    viewport,
    keyboardVisible: false,
  }).dismiss, false);
});

test('parses UIAutomator root viewport for keyboard-aware fallback taps', () => {
  const viewport = parseUiaViewport(
    '<hierarchy><node index="0" bounds="[0,0][1264,2780]"><node bounds="[10,20][30,40]" /></node></hierarchy>',
  );

  assert.deepEqual(viewport, {
    left: 0,
    top: 0,
    right: 1264,
    bottom: 2780,
    width: 1264,
    height: 2780,
  });
});

test('parses UIAutomator bounds strings', () => {
  assert.deepEqual(parseUiaBounds('[10,20][30,45]'), {
    left: 10,
    top: 20,
    right: 30,
    bottom: 45,
    width: 20,
    height: 25,
  });
  assert.equal(parseUiaBounds(''), null);
});

test('compacts bridge tree by text and max nodes', () => {
  const compact = compactBridgeTree({
    activity: 'ExampleActivity',
    nodeCount: 4,
    root: {
      className: 'android.widget.FrameLayout',
      bounds: { left: 0, top: 0, right: 100, bottom: 200, width: 100, height: 200 },
      children: [
        {
          className: 'android.widget.TextView',
          resourceName: 'app:id/title',
          text: 'OpenAI result',
          visible: true,
          effectiveVisible: true,
          bounds: { left: 0, top: 20, right: 100, bottom: 60, width: 100, height: 40 },
        },
        {
          className: 'android.widget.TextView',
          text: 'Other result',
          visible: true,
          effectiveVisible: true,
          bounds: { left: 0, top: 80, right: 100, bottom: 120, width: 100, height: 40 },
        },
      ],
    },
  }, {
    textFilter: 'openai',
    maxNodes: 1,
  });

  assert.equal(compact.ok, true);
  assert.equal(compact.source, 'bridge-tree');
  assert.equal(compact.nodes.length, 1);
  assert.equal(compact.nodes[0].text, 'OpenAI result');
  assert.equal(compact.activity, 'ExampleActivity');
});

test('compacts UIAutomator tree by resource id and visible viewport', () => {
  const compact = compactUiaTree(
    [
      '<hierarchy>',
      '<node index="0" class="android.widget.FrameLayout" bounds="[0,0][100,200]">',
      '<node index="0" text="OpenAI" resource-id="app:id/title" class="android.widget.TextView" package="app" clickable="false" enabled="true" focusable="false" focused="false" selected="false" scrollable="false" checked="false" bounds="[0,20][100,60]" />',
      '<node index="1" text="Hidden" resource-id="app:id/title" class="android.widget.TextView" package="app" clickable="false" enabled="true" focusable="false" focused="false" selected="false" scrollable="false" checked="false" bounds="[-100,20][-10,60]" />',
      '</node>',
      '</hierarchy>',
    ].join(''),
    {
      resourceIdFilter: 'title',
      visibleOnly: true,
    },
  );

  assert.equal(compact.ok, true);
  assert.equal(compact.source, 'uiautomator');
  assert.equal(compact.nodes.length, 1);
  assert.equal(compact.nodes[0].text, 'OpenAI');
  assert.equal(compact.nodes[0].resourceId, 'app:id/title');
});

test('status compacts large Flutter layout dumps by default', () => {
  const status = compactStatus({
    ok: true,
    flutter: {
      app: { name: 'platform_design' },
      layout: {
        widgetInspector: {
          description: 'MyAdaptingApp',
          type: '_ElementDiagnosticableTreeNode',
          hasChildren: true,
          children: [{ description: 'MaterialApp' }],
        },
        widgetDump: {
          ok: true,
          text: 'x'.repeat(5000),
          length: 5000,
          truncated: true,
        },
        semantics: {
          ok: false,
          error: 'no_root_semantics_node',
          semanticsEnabled: true,
        },
        operable: {
          ok: true,
          count: 20,
          visitedCount: 100,
          textCount: 10,
          actionCount: 40,
          sampleWidgetTypes: Array.from({ length: 30 }, (_, index) => `Widget${index}`),
          nodes: Array.from({ length: 20 }, (_, index) => ({
            id: index,
            widgetType: 'Text',
            text: `Node ${index}`,
            bounds: { left: 0, top: index, right: 10, bottom: index + 1 },
            actions: ['tap'],
            depth: index,
            noisy: 'ignored',
          })),
        },
      },
    },
  });

  assert.equal(status.flutter.layout.widgetDump.ok, true);
  assert.equal(status.flutter.layout.widgetDump.length, 5000);
  assert.equal(Object.prototype.hasOwnProperty.call(status.flutter.layout.widgetDump, 'text'), false);
  assert.equal(status.flutter.layout.widgetInspector.childCount, 1);
  assert.equal(status.flutter.layout.operable.nodes.length, 12);
  assert.equal(status.flutter.layout.operable.sampleWidgetTypes.length, 20);
  assert.equal(Object.prototype.hasOwnProperty.call(status.flutter.layout.operable.nodes[0], 'noisy'), false);
});

test('uiautomator lock path is stable and filesystem-safe', () => {
  const lockPath = uiautomatorLockPath({
    serial: 'device:5555',
    adb: 'C:\\Android SDK\\platform-tools\\adb.exe',
  });

  assert.equal(path.dirname(lockPath), os.tmpdir());
  assert.match(path.basename(lockPath), /^ai-app-bridge-uiautomator-/);
  assert.doesNotMatch(path.basename(lockPath), /[:\\/\s]/);
});

test('file lock serializes concurrent uiautomator-style work', async () => {
  const lockPath = path.join(os.tmpdir(), `ai-app-bridge-test-${process.pid}-${Date.now()}.lock`);
  let active = 0;
  let maxActive = 0;
  const runLocked = () => withFileLock(lockPath, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 40));
    active -= 1;
  }, {
    pollMs: 5,
    timeoutMs: 1000,
    staleMs: 5000,
  });

  try {
    await Promise.all([runLocked(), runLocked(), runLocked()]);
    assert.equal(maxActive, 1);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
});

test('network output can be filtered and compacted without bodies', () => {
  const shaped = shapeNetworkCapture({
    ok: true,
    type: 'network',
    count: 3,
    items: [
      {
        id: 1,
        source: 'okhttp-auto',
        method: 'GET',
        url: 'https://example.test/api/feed',
        statusCode: 200,
        durationMs: 10,
        responseHeaders: { 'Content-Type': 'application/json' },
        responseBody: '{"ok":true}',
        redacted: true,
      },
      {
        id: 2,
        source: 'okhttp-auto',
        method: 'GET',
        url: 'https://example.test/image.png',
        statusCode: 200,
        durationMs: 15,
        responseHeaders: { 'content-type': 'image/png' },
        responseBody: '\u0000'.repeat(2000),
        redacted: true,
      },
      {
        id: 3,
        source: 'okhttp-auto',
        method: 'POST',
        url: 'https://example.test/api/feed',
        statusCode: 500,
        durationMs: 20,
        requestBody: 'request',
        responseBody: 'error',
        redacted: true,
      },
    ],
  }, {
    compact: true,
    urlFilter: '/api/',
    method: 'GET',
    statusCode: 200,
  });

  assert.equal(shaped.count, 1);
  assert.equal(shaped.sourceCount, 3);
  assert.equal(shaped.items[0].url, 'https://example.test/api/feed');
  assert.equal(shaped.items[0].contentType, 'application/json');
  assert.equal(Object.prototype.hasOwnProperty.call(shaped.items[0], 'responseBody'), false);
  assert.equal(shaped.items[0].responseBodyBytes, 11);
});

test('network output can omit or truncate request and response bodies', () => {
  const source = {
    ok: true,
    type: 'network',
    count: 1,
    items: [
      {
        id: 1,
        method: 'POST',
        url: 'https://example.test/api',
        requestBody: 'abcdef',
        responseBody: '0123456789',
      },
    ],
  };

  const truncated = shapeNetworkCapture(source, { bodyMaxBytes: 4 });
  assert.equal(truncated.items[0].requestBody, 'abcd...[truncated]');
  assert.equal(truncated.items[0].responseBody, '0123...[truncated]');

  const omitted = shapeNetworkCapture(source, { noBodies: true });
  assert.equal(Object.prototype.hasOwnProperty.call(omitted.items[0], 'requestBody'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(omitted.items[0], 'responseBody'), false);
  assert.equal(omitted.items[0].requestBodyOmitted, true);
  assert.equal(omitted.items[0].responseBodyOmitted, true);
});

test('wait-text conditions require page context, activity, and absent text', () => {
  const snapshot = {
    text: 'New Task\nBridge Todo\nSave task',
    activity: 'com.example.todo.TodoActivity',
  };

  assert.equal(waitTextConditionsMet(snapshot, 'Bridge Todo').ok, true);
  assert.equal(waitTextConditionsMet(snapshot, 'Bridge Todo', {
    requireTexts: ['All Tasks'],
  }).reason, 'required_text_missing');
  assert.equal(waitTextConditionsMet(snapshot, 'Bridge Todo', {
    absentTexts: ['New Task'],
  }).reason, 'absent_text_present');
  assert.equal(waitTextConditionsMet(snapshot, 'Bridge Todo', {
    requireActivity: 'OtherActivity',
  }).reason, 'activity_mismatch');
});

test('wait-text status search ignores raw Flutter widget dump text', () => {
  const text = statusSearchText({
    activity: { current: 'dev.flutter.platform_design.MainActivity' },
    flutter: {
      layout: {
        widgetDump: {
          ok: true,
          text: 'Offstage old route item Odd Bell',
        },
        operable: {
          nodes: [
            { widgetType: 'Text', text: 'Sad Word', actions: ['tap'] },
          ],
        },
      },
    },
  });

  assert.match(text, /Sad Word/);
  assert.doesNotMatch(text, /Odd Bell/);
  assert.equal(waitTextConditionsMet(
    { text, activity: 'dev.flutter.platform_design.MainActivity' },
    'Sad Word',
    { absentTexts: ['Odd Bell'], requireActivity: 'MainActivity' },
  ).ok, true);
});

test('installer assistant recognises ROM installer surfaces and safe positive labels', () => {
  assert.equal(isLikelyInstallerSurface(
    { packageName: 'com.oplus.appdetail' },
    '<node text="检测结果：涉及敏感权限" package="com.oplus.appdetail" />',
  ), true);
  assert.equal(isLikelyInstallerSurface(
    { packageName: 'com.example.app' },
    '<node text="安装" package="com.example.app" />',
  ), false);
  assert.equal(isLikelyInstallerSurface(
    { packageName: 'com.heytap.market' },
    '<node text="打开" resource-id="com.heytap.market:id/bt_notification_snack_bar" package="com.heytap.market" />',
  ), false);
  assert.equal(isLikelyInstallerSurface(
    {
      packageName: 'com.oplus.appdetail',
      activity: 'com.oplus.appdetail.model.finish.InstallFinishActivity',
    },
    '<node text="安装" resource-id="com.oplus.appdetail:id/btn_install" package="com.oplus.appdetail" />',
  ), true);
  assert.ok(defaultInstallerButtonTexts().includes('继续安装'));
  assert.ok(defaultInstallerButtonTexts().includes('安装'));
  assert.equal(defaultInstallerButtonTexts().includes('打开'), false);
  assert.equal(defaultInstallerButtonTexts().includes('Open'), false);
  assert.ok(installerButtonTextsForSurface({ finish: true, market: false }).includes('完成'));
  assert.equal(installerButtonTextsForSurface({ finish: true, market: false }).includes('关闭'), false);
  assert.equal(installerButtonTextsForSurface({ finish: true, market: false }).includes('安装'), false);
  assert.equal(installerButtonTextsForSurface({ finish: true, market: false }).includes('Install'), false);
  assert.equal(installerButtonTextsForSurface({ finish: true, market: false }).includes('Close'), false);
  assert.equal(installerButtonTextsForSurface({ finish: true, market: false }).includes('Open'), false);
  assert.equal(installerButtonTextsForSurface({ finish: false, market: true }).includes('Install'), false);
});

test('installer assistant can confirm reinstall while avoiding post-install ad taps', () => {
  assert.equal(shouldSkipInstallerTapForInstalledPackage({
    phase: 'install-pending',
    packageState: { installed: true },
  }), false);
  assert.equal(shouldSkipInstallerTapForInstalledPackage({
    phase: 'post-install',
    packageState: { installed: true },
  }), true);
  assert.equal(shouldSkipInstallerTapForInstalledPackage({
    phase: 'install-pending',
    packageState: { installed: false },
  }), false);
});

test('parses and selects WebView DevTools sockets by target package pid', () => {
  const procNetUnix = [
    'Num RefCount Protocol Flags Type St Inode Path',
    '0000000000000000: 00000002 00000000 00010000 0001 01 12345 @webview_devtools_remote_1111',
    '0000000000000000: 00000002 00000000 00010000 0001 01 12346 @webview_devtools_remote_2222',
  ].join('\n');

  const sockets = parseWebViewDevToolsSockets(procNetUnix, ['2222']);
  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].name, 'webview_devtools_remote_2222');
  assert.equal(sockets[1].packageMatch, true);

  const selected = chooseWebViewDevToolsSocket(sockets, {}, ['2222']);
  assert.equal(selected.socket.name, 'webview_devtools_remote_2222');

  const explicit = chooseWebViewDevToolsSocket(sockets, { socketName: '@webview_devtools_remote_1111' }, ['2222']);
  assert.equal(explicit.socket.name, 'webview_devtools_remote_1111');
});

test('selects WebView CDP page by target id, URL filter, then first page', () => {
  const pages = [
    { id: 'worker-1', type: 'service_worker', url: 'http://debug.local/worker', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/worker-1' },
    { id: 'page-1', type: 'page', url: 'http://debug.local/native-webview', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/page-1' },
    { id: 'page-2', type: 'page', url: 'http://example.test/other', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/page-2' },
  ];

  assert.equal(chooseWebViewPage(pages, { targetId: 'page-2' }).id, 'page-2');
  assert.equal(chooseWebViewPage(pages, { pageUrlFilter: 'native-webview' }).id, 'page-1');
  assert.equal(chooseWebViewPage(pages, {}).id, 'page-1');
});
