const assert = require('assert/strict');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const WebSocket = require('ws');

const {
  buildBridgeFailureResult,
  bridgeRequestWithCachedForward,
  bridgeNodeTarget,
  artifactTimestamp,
  clearAppDataAdbArgs,
  compactBridgeTree,
  compactStatus,
  compactUiaTree,
  defaultArtifactDirectory,
  defaultArtifactPath,
  defaultInstallerButtonTexts,
  findFlutterNode,
  findTappableNodeByText,
  filterLogcat,
  flutterNodePoint,
  flutterPhysicalViewport,
  helpText,
  installerButtonTextsForSurface,
  isAdbInputTextSafe,
  isLikelyInstallerSurface,
  normalizeBridgeError,
  normalizeActivityComponent,
  parseWebViewDevToolsSockets,
  parseArgs,
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
  shouldSkipInstallerTapForInstalledPackage,
  shouldDismissKeyboardForPoint,
  shouldUseDefaultPortFallback,
  screenshotOutputPath,
  statusSearchText,
  tap,
  startActivity,
  uiautomatorLockPath,
  verifyBridgeTargetPackage,
  waitTextConditionsMet,
  withFileLock,
} = require('../bin/ai-app-bridge.js');

const cliPath = path.join(__dirname, '..', 'bin', 'ai-app-bridge.js');
const mcpPath = path.join(__dirname, '..', 'bin', 'mcp-server.js');
const { buildBridgeCliArgs, defaultArtifactDirFor, runBatch } = require('../bin/mcp-server.js');
const { createFactStore } = require('../bin/fact-store.js');
const {
  IOSBridgeProvider,
  formatHostForUrl,
  selectDeviceFromList,
  shapeDevice,
  wdaSessionIdFromResponse,
} = require('../bin/ios-provider.js');

function encodeMcpMessage(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function readMcpMessages(buffer) {
  const messages = [];
  let remaining = buffer;
  while (true) {
    const marker = remaining.indexOf('\r\n\r\n');
    if (marker < 0) break;
    const header = remaining.subarray(0, marker).toString('utf8');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) throw new Error(`bad MCP header: ${header}`);
    const start = marker + 4;
    const end = start + Number(match[1]);
    if (remaining.length < end) break;
    messages.push(JSON.parse(remaining.subarray(start, end).toString('utf8')));
    remaining = remaining.subarray(end);
  }
  return { messages, remaining };
}

function encodeLineJsonMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

function makeGitRepo(files = {}, gitignore = '') {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-app-bridge-git-artifacts-')));
  execFileSync('git', ['init'], { cwd: directory, stdio: 'ignore' });
  if (gitignore) {
    fs.writeFileSync(path.join(directory, '.gitignore'), gitignore);
  }
  for (const [fileName, contents] of Object.entries(files)) {
    const filePath = path.join(directory, fileName);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
  return directory;
}

function withCwd(directory, fn) {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

test('cached-forward recovery never replays a mutating bridge request', async () => {
  const invalidated = [];
  const ensures = [];
  const dependencies = {
    ensureForward: async (_ctx, options = {}) => ensures.push(Boolean(options.force)),
    invalidateForward: (key) => invalidated.push(key),
  };
  const postContext = { forwardReused: true, forwardCacheKey: 'post-cache-key' };
  let postAttempts = 0;

  await assert.rejects(
    bridgeRequestWithCachedForward(postContext, async () => {
      postAttempts += 1;
      throw new Error('ambiguous response loss');
    }, { replaySafe: false, ...dependencies }),
    /ambiguous response loss/,
  );

  assert.equal(postAttempts, 1);
  assert.deepEqual(ensures, [false]);
  assert.deepEqual(invalidated, ['post-cache-key']);

  const getContext = { forwardReused: true, forwardCacheKey: 'get-cache-key' };
  let getAttempts = 0;
  const recovered = await bridgeRequestWithCachedForward(getContext, async () => {
    getAttempts += 1;
    if (getAttempts === 1) throw new Error('stale forward');
    return { ok: true };
  }, { replaySafe: true, ...dependencies });

  assert.deepEqual(recovered, { ok: true });
  assert.equal(getAttempts, 2);
  assert.deepEqual(ensures, [false, false, true]);
  assert.deepEqual(invalidated, ['post-cache-key', 'get-cache-key']);
});

test('launch-app waits until the launched package is the foreground window', async () => {
  const seen = [];
  let startArgs = null;
  const result = await startActivity(
    { packageName: 'org.videolan.vlc' },
    'org.videolan.vlc/.StartActivity',
    { foregroundTimeoutMs: 1000 },
    {},
    {
      adb: async (_ctx, args) => {
        startArgs = args;
        return { stdout: 'Starting: Intent { cmp=org.videolan.vlc/.StartActivity }\n', stderr: '' };
      },
      foregroundWindow: async () => {
        seen.push(seen.length);
        if (seen.length < 2) {
          return { ok: true, packageName: 'org.wikipedia.dev' };
        }
        return { ok: true, packageName: 'org.videolan.vlc' };
      },
      sleep: async () => {},
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.foreground.packageName, 'org.videolan.vlc');
  assert.equal(seen.length, 2);
  assert.deepEqual(startArgs.slice(0, 4), ['shell', 'am', 'start', '-W']);
});

test('launch-app clearTask adds activity-clear-task before the component', async () => {
  let startArgs = null;
  await startActivity(
    { packageName: 'org.wikipedia.dev' },
    'org.wikipedia.dev/org.wikipedia.DefaultIcon',
    { clearTask: true, foregroundTimeoutMs: 1000 },
    {},
    {
      adb: async (_ctx, args) => {
        startArgs = args;
        return { stdout: 'Starting: Intent { cmp=org.wikipedia.dev/org.wikipedia.DefaultIcon }\n', stderr: '' };
      },
      foregroundWindow: async () => ({ ok: true, packageName: 'org.wikipedia.dev' }),
      sleep: async () => {},
    },
  );
  assert.deepEqual(startArgs.slice(0, 5), ['shell', 'am', 'start', '-W', '--activity-clear-task']);
});

test('launch-app fails when the launched package never becomes foreground', async () => {
  const result = await startActivity(
    { packageName: 'org.videolan.vlc' },
    'org.videolan.vlc/.StartActivity',
    { foregroundTimeoutMs: 1 },
    {},
    {
      adb: async () => ({ stdout: 'Starting: Intent { cmp=org.videolan.vlc/.StartActivity }\n', stderr: '' }),
      foregroundWindow: async () => ({ ok: true, packageName: 'org.wikipedia.dev' }),
      sleep: async () => {},
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'foreground_package_mismatch');
  assert.equal(result.foreground.packageName, 'org.wikipedia.dev');
});

test('coordinate tap uses one app-local bridge action to return the actual component', async () => {
  let bridgeCalls = 0;
  let adbCalls = 0;
  const result = await tap({
    explicitPackageName: true,
    packageName: 'com.example.app',
  }, 12, 34, { feedback: 'auto', runtimeActionId: 'runtime-action-1' }, {
    foregroundWindow: async () => ({ ok: true, packageName: 'com.example.app' }),
    bridgePost: async (_ctx, requestPath, payload) => {
      bridgeCalls += 1;
      assert.equal(requestPath, '/v1/action/tap');
      assert.deepEqual(payload, { x: 12, y: 34, actionId: 'runtime-action-1' });
      return {
        ok: true,
        target: { className: 'android.widget.Button', resourceName: 'com.example.app:id/save' },
        handledDown: true,
        handledUp: true,
      };
    },
    adb: async () => { adbCalls += 1; },
  });

  assert.equal(bridgeCalls, 1);
  assert.equal(adbCalls, 0);
  assert.equal(result.transport, 'bridge');
  assert.equal(result.target.resourceName, 'com.example.app:id/save');
});

test('coordinate tap keeps feedback-off and non-app foreground paths on one ADB action', async () => {
  let bridgeCalls = 0;
  let foregroundCalls = 0;
  let adbCalls = 0;
  const dependencies = {
    foregroundWindow: async () => {
      foregroundCalls += 1;
      return { ok: true, packageName: 'com.android.permissioncontroller' };
    },
    bridgePost: async () => {
      bridgeCalls += 1;
      return { ok: true };
    },
    adb: async () => { adbCalls += 1; },
  };
  const context = { explicitPackageName: true, packageName: 'com.example.app' };

  const fast = await tap(context, 1, 2, { feedback: 'off' }, dependencies);
  const systemUi = await tap(context, 3, 4, { feedback: 'auto' }, dependencies);

  assert.equal(fast.transport, 'adb');
  assert.equal(systemUi.transport, 'adb');
  assert.equal(systemUi.targetFeedback.reason, 'foreground_package_mismatch');
  assert.equal(foregroundCalls, 1);
  assert.equal(bridgeCalls, 0);
  assert.equal(adbCalls, 2);
});

test('coordinate tap falls back only before bridge dispatch and never after ambiguous response loss', async () => {
  let adbCalls = 0;
  const context = { explicitPackageName: true, packageName: 'com.example.app' };
  const foregroundWindow = async () => ({ ok: true, packageName: 'com.example.app' });
  const unavailable = new Error('bridge endpoint unavailable');
  unavailable.aiAppBridgeRequestNotStarted = true;

  const fallback = await tap(context, 7, 8, { feedback: 'auto' }, {
    foregroundWindow,
    bridgePost: async () => { throw unavailable; },
    adb: async () => { adbCalls += 1; },
  });
  assert.equal(fallback.transport, 'adb');
  assert.equal(fallback.targetFeedback.reason, 'bridge_action_unavailable');
  assert.equal(adbCalls, 1);

  await assert.rejects(
    tap(context, 9, 10, { feedback: 'auto' }, {
      foregroundWindow,
      bridgePost: async () => { throw new Error('socket closed after request'); },
      adb: async () => { adbCalls += 1; },
    }),
    /socket closed after request/,
  );
  assert.equal(adbCalls, 1);
});

function readLineJsonMessages(buffer) {
  const messages = [];
  let remaining = buffer;
  while (true) {
    const marker = remaining.indexOf('\n');
    if (marker < 0) break;
    const end = marker > 0 && remaining[marker - 1] === 13 ? marker - 1 : marker;
    const line = remaining.subarray(0, end).toString('utf8');
    if (line.trim()) messages.push(JSON.parse(line));
    remaining = remaining.subarray(marker + 1);
  }
  return { messages, remaining };
}

function mcpRequestSequence(requests, options = {}) {
  const expectedIds = new Set([1, ...requests.filter((request) => request.id !== undefined).map((request) => request.id)]);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mcpPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(options.env || {}),
      },
    });
    const responses = new Map();
    let stdoutBuffer = Buffer.alloc(0);
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP probe timed out. stderr=${stderr}`));
    }, 8000);

    function finishIfReady() {
      if ([...expectedIds].every((id) => responses.has(id))) {
        clearTimeout(timer);
        child.kill();
        resolve(responses);
      }
    }

    child.stdout.on('data', (chunk) => {
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
      const parsed = readMcpMessages(stdoutBuffer);
      stdoutBuffer = parsed.remaining;
      for (const message of parsed.messages) {
        responses.set(message.id, message);
        if (message.id === 1) {
          child.stdin.write(encodeMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }));
          for (const request of requests) child.stdin.write(encodeMcpMessage(request));
        }
      }
      finishIfReady();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.stdin.write(encodeMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: options.protocolVersion || '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0' },
      },
    }));
  });
}

function lineJsonMcpRequestSequence(requests, options = {}) {
  const expectedIds = new Set([1, ...requests.filter((request) => request.id !== undefined).map((request) => request.id)]);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mcpPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(options.env || {}),
      },
    });
    const responses = new Map();
    let stdoutBuffer = Buffer.alloc(0);
    let stderr = '';
    let sawFramedOutput = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`line JSON MCP probe timed out. stderr=${stderr}`));
    }, 8000);

    function finishIfReady() {
      if ([...expectedIds].every((id) => responses.has(id))) {
        clearTimeout(timer);
        child.kill();
        resolve({ responses, sawFramedOutput });
      }
    }

    child.stdout.on('data', (chunk) => {
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
      sawFramedOutput = sawFramedOutput || stdoutBuffer.includes(Buffer.from('Content-Length:'));
      const parsed = readLineJsonMessages(stdoutBuffer);
      stdoutBuffer = parsed.remaining;
      for (const message of parsed.messages) {
        responses.set(message.id, message);
        if (message.id === 1) {
          child.stdin.write(encodeLineJsonMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }));
          for (const request of requests) child.stdin.write(encodeLineJsonMessage(request));
        }
      }
      finishIfReady();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.stdin.write(encodeLineJsonMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: options.protocolVersion || '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'line-json-test-client', version: '0' },
      },
    }));
  });
}

function createLineJsonMcpClient(options = {}) {
  const child = spawn(process.execPath, [mcpPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(options.env || {}),
    },
  });
  let stdoutBuffer = Buffer.alloc(0);
  let stderr = '';
  let nextId = 1;
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    const parsed = readLineJsonMessages(stdoutBuffer);
    stdoutBuffer = parsed.remaining;
    for (const message of parsed.messages) {
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('error', (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  });

  function request(method, params = {}, timeoutMs = 8000) {
    const id = nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}. stderr=${stderr}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
    child.stdin.write(encodeLineJsonMessage(message));
    return promise;
  }

  function notify(method, params = {}) {
    child.stdin.write(encodeLineJsonMessage({ jsonrpc: '2.0', method, params }));
  }

  function close() {
    child.kill();
  }

  return { child, request, notify, close };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function waitUntilTest(predicate, timeoutMs = 3000, intervalMs = 50) {
  const startedAtMs = Date.now();
  let lastError;
  while (Date.now() - startedAtMs < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError || new Error('waitUntilTest timed out');
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
  assert.match(output, /--bundle-id <id>/);
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

test('MCP compact surface negotiates protocol and exposes a small capability index', async () => {
  const responses = await mcpRequestSequence([
    { jsonrpc: '2.0', id: 2, method: 'ping' },
    { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
  ], {
    env: { AI_APP_BRIDGE_MCP_SURFACE: '' },
  });

  assert.equal(responses.get(1).result.protocolVersion, '2025-06-18');
  assert.match(responses.get(1).result.instructions, /capabilities/);
  assert.deepEqual(responses.get(2).result, {});
  const tools = responses.get(3).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ['capabilities', 'run']);
  assert.doesNotMatch(JSON.stringify(tools), /oneOf/);
});

test('MCP accepts single-line JSON and responds with single-line JSON', async () => {
  const { responses, sawFramedOutput } = await lineJsonMcpRequestSequence([
    { jsonrpc: '2.0', id: 2, method: 'ping' },
    { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
  ], {
    env: { AI_APP_BRIDGE_MCP_SURFACE: '' },
  });

  assert.equal(responses.get(1).result.protocolVersion, '2025-06-18');
  assert.deepEqual(responses.get(2).result, {});
  assert.deepEqual(responses.get(3).result.tools.map((tool) => tool.name), ['capabilities', 'run']);
  assert.equal(sawFramedOutput, false);
});

test('MCP production wiring persists Legacy, Script, and Intent together, then closes on EOF', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-app-bridge-mcp-shutdown-'));
  const treeServer = require('node:http').createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, root: {
      id: 'fixture-home', className: 'TextView', text: 'Fixture Home', children: [],
    } }));
  });
  await new Promise((resolve) => treeServer.listen(0, '127.0.0.1', resolve));
  const client = createLineJsonMcpClient({
    env: {
      AI_APP_BRIDGE_FACT_CACHE_PATH: path.join(cacheDir, 'facts.sqlite'),
      AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb',
    },
  });
  try {
    const initialized = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'shutdown-test-client', version: '0' },
    });
    assert.equal(initialized.result.protocolVersion, '2025-06-18');
    client.notify('notifications/initialized');

    const status = await client.request('tools/call', {
      name: 'run',
      arguments: {
        command: 'web-status',
        arguments: { sessionId: 'shutdown-test-session' },
      },
    });
    assert.equal(status.result.isError, true);

    const script = await client.request('tools/call', {
      name: 'run',
      arguments: {
        command: 'script',
        arguments: {
          operation: 'start',
          operationId: 'cli-unified-script',
          script: {
            schemaVersion: 'aab.code-script/v1',
            name: 'persistence-only',
            language: 'javascript',
            source: 'function main() { return { persisted: true }; }\nmodule.exports = { main };',
          },
        },
      },
    });
    const startedPayload = JSON.parse(script.result.content[0].text);
    assert.equal(startedPayload.ok, true);
    let scriptPayload = startedPayload;
    const deadline = Date.now() + 5000;
    let afterSequence = startedPayload.eventSequence || 0;
    while (
      scriptPayload.status !== 'completed'
      && scriptPayload.status !== 'failed'
      && scriptPayload.status !== 'cancelled'
      && Date.now() < deadline
    ) {
      const waited = await client.request('tools/call', {
        name: 'run',
        arguments: {
          command: 'script',
          arguments: {
            operation: 'wait',
            operationId: 'cli-unified-script',
            waitMs: Math.max(1, Math.min(200, deadline - Date.now())),
            afterSequence,
          },
        },
      });
      scriptPayload = JSON.parse(waited.result.content[0].text);
      afterSequence = scriptPayload.eventSequence || afterSequence;
    }
    assert.equal(scriptPayload.ok, true);
    assert.equal(scriptPayload.status, 'completed');

    const intent = await client.request('tools/call', {
      name: 'run',
      arguments: {
        command: 'intent',
        arguments: {
          operation: 'start',
          operationId: 'cli-unified-intent',
          goal: 'confirm persistence without a device',
          target: { serial: 'fixture-device', packageName: 'com.example.fixture', adb: '/usr/bin/true', port: treeServer.address().port },
        },
      },
    });
    const intentPayload = JSON.parse(intent.result.content[0].text);
    assert.equal(intentPayload.ok, true, JSON.stringify(intentPayload));
    assert.equal(intentPayload.status, 'waiting_for_decision');

    const decision = await client.request('tools/call', {
      name: 'run',
      arguments: {
        command: 'intent',
        arguments: {
          operation: 'decide',
          operationId: 'cli-unified-intent',
          decision: { decisionId: 'complete-1', agentDecision: 'complete' },
        },
      },
    });
    const decisionPayload = JSON.parse(decision.result.content[0].text);
    assert.equal(decisionPayload.ok, true);
    assert.equal(decisionPayload.status, 'completed');

    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.child.kill();
        reject(new Error('MCP did not exit after stdin EOF'));
      }, 3_000);
      client.child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    client.child.stdin.end();
    assert.deepEqual(await closed, { code: 0, signal: null });

    const store = createFactStore({
      directory: path.join(cacheDir, 'fact-store-v1'),
      profile: '64mb',
    });
    const page = store.read({ limit: 1_000 });
    store.close();
    assert.equal(page.items.some((item) => item.payload?.namespace === 'script'), true);
    assert.equal(page.items.some((item) => item.payload?.namespace === 'intent'), true);
    assert.equal(page.items.some((item) => (
      item.payload?.kind === 'execution' && item.payload?.command === 'web-status'
    )), true);
  } finally {
    if (client.child.exitCode === null && client.child.signalCode === null) client.close();
    await new Promise((resolve) => treeServer.close(resolve));
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('MCP full surface remains available for legacy direct tools without oneOf schemas', async () => {
  const responses = await mcpRequestSequence([
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ], {
    env: { AI_APP_BRIDGE_MCP_SURFACE: 'full' },
    protocolVersion: '2024-11-05',
  });

  assert.equal(responses.get(1).result.protocolVersion, '2024-11-05');
  const tools = responses.get(2).result.tools;
  const names = tools.map((tool) => tool.name);
  assert(names.includes('status'));
  assert(names.includes('install_apk'));
  assert(names.includes('launch_activity'));
  assert.doesNotMatch(JSON.stringify(tools.find((tool) => tool.name === 'launch_activity')), /oneOf/);
});

test('MCP exposes device-wide log collection only as an explicit additive opt-in', async () => {
  const compactResponses = await mcpRequestSequence([
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);
  const compactRun = compactResponses.get(2).result.tools.find((tool) => tool.name === 'run');
  assert.deepEqual(compactRun.inputSchema.properties.deviceLogScope.enum, ['device']);
  assert.equal(compactRun.inputSchema.properties.deviceLogBuffers.type, 'array');

  const fullResponses = await mcpRequestSequence([
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ], { env: { AI_APP_BRIDGE_MCP_SURFACE: 'full' } });
  const tap = fullResponses.get(2).result.tools.find((tool) => tool.name === 'tap');
  assert.deepEqual(tap.inputSchema.properties.deviceLogScope.enum, ['device']);
  assert.equal(tap.inputSchema.properties.deviceLogBuffers.items.type, 'string');
});

test('MCP capabilities advertise install, freeze/thaw, data clear, and app control while target commands reject sample fallback', async () => {
  const responses = await mcpRequestSequence([
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'capabilities', arguments: { domain: 'app', includeOptions: true } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run', arguments: { command: 'status' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'status', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'run', arguments: { command: 'clear-app-data' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'clear_app_data', arguments: {} } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'run', arguments: { command: 'freeze-app' } } },
  ]);

  const capabilitiesText = responses.get(2).result.content[0].text;
  assert.match(capabilitiesText, /install-apk/);
  assert.match(capabilitiesText, /freeze-app/);
  assert.match(capabilitiesText, /thaw-app/);
  assert.match(capabilitiesText, /clear-app-data/);
  assert.match(capabilitiesText, /launch-app/);
  assert.equal(responses.get(3).result.isError, true);
  assert.match(responses.get(3).result.content[0].text, /packageName or explicit port is required/);
  assert.doesNotMatch(responses.get(3).result.content[0].text, /sample/);
  assert.equal(responses.get(4).result.isError, true);
  assert.match(responses.get(4).result.content[0].text, /packageName or explicit port is required/);
  assert.equal(responses.get(5).result.isError, true);
  assert.match(responses.get(5).result.content[0].text, /packageName is required/);
  assert.equal(responses.get(6).result.isError, true);
  assert.match(responses.get(6).result.content[0].text, /packageName is required/);
  assert.equal(responses.get(7).result.isError, true);
  assert.match(responses.get(7).result.content[0].text, /packageName is required/);
});

test('MCP web provider accepts SDK session captures and commands', async () => {
  const client = createLineJsonMcpClient();
  let socket;
  try {
    await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'web-provider-test', version: '0' },
    });
    client.notify('notifications/initialized');

    const capabilities = await client.request('tools/call', {
      name: 'capabilities',
      arguments: { domain: 'web', includeOptions: true },
    });
    const capabilityPayload = JSON.parse(capabilities.result.content[0].text);
    assert.equal(capabilityPayload.ok, true);
    assert.match(JSON.stringify(capabilityPayload.domains.web), /web-session-start/);
    assert.match(JSON.stringify(capabilityPayload.domains.web), /web-command/);

    const start = await client.request('tools/call', {
      name: 'run',
      arguments: {
        command: 'web-session-start',
        arguments: {
          webPort: 0,
          token: 'test-web-token',
        },
      },
    });
    const startPayload = JSON.parse(start.result.content[0].text);
    assert.equal(startPayload.ok, true);
    assert.match(startPayload.endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/ai-app-bridge-web$/);

    const received = [];
    socket = new WebSocket(`${startPayload.endpoint}?token=${encodeURIComponent(startPayload.token)}`);
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      received.push(message);
      if (message.type !== 'command') return;
      if (message.command?.name === 'domSnapshot') {
        socket.send(JSON.stringify({
          type: 'commandResult',
          commandId: message.commandId,
          ok: true,
          result: {
            ok: true,
            dom: {
              ok: true,
              title: 'Web Bridge Test',
              bodyText: 'Ready Submit',
              controls: [{ tag: 'button', text: 'Submit' }],
              controlCount: 1,
            },
          },
        }));
        return;
      }
      socket.send(JSON.stringify({
        type: 'commandResult',
        commandId: message.commandId,
        ok: true,
        result: { ok: true, value: `ran:${message.command?.name || ''}` },
      }));
    });

    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({
      type: 'hello',
      sessionId: 'web-test-session',
      appName: 'web-test-app',
      url: 'http://example.test/app',
      origin: 'http://example.test',
      route: '/app',
      capabilities: { logs: true, network: true, state: true, events: true, dom: true, command: true },
    }));
    await waitUntilTest(() => received.some((message) => message.type === 'helloAck'));

    socket.send(JSON.stringify({
      type: 'capture',
      stream: 'logs',
      item: { level: 'info', tag: 'test', message: 'hello web' },
    }));
    socket.send(JSON.stringify({
      type: 'capture',
      stream: 'network',
      item: { method: 'GET', url: 'https://example.test/api', statusCode: 200, durationMs: 12 },
    }));
    socket.send(JSON.stringify({
      type: 'capture',
      stream: 'state',
      item: { namespace: 'cart', key: 'count', value: 2 },
    }));
    socket.send(JSON.stringify({
      type: 'capture',
      stream: 'events',
      item: { category: 'ui', name: 'submitted' },
    }));
    await waitUntilTest(async () => {
      const logs = JSON.parse((await client.request('tools/call', {
        name: 'run',
        arguments: { command: 'web-logs', arguments: { sessionId: 'web-test-session' } },
      })).result.content[0].text);
      return logs.count === 1;
    });

    const batch = await client.request('tools/call', {
      name: 'run',
      arguments: {
        command: 'batch',
        arguments: {
          defaults: { sessionId: 'web-test-session' },
          steps: [
            { id: 'status', command: 'web-status' },
            { id: 'dom', command: 'web-dom' },
            { id: 'logs', command: 'web-logs' },
            { id: 'network', command: 'web-network' },
            { id: 'state', command: 'web-state' },
            { id: 'events', command: 'web-events' },
            { id: 'command', command: 'web-command', arguments: { name: 'demo.action' } },
          ],
          stopOnError: true,
        },
      },
    }, 12000);
    const batchPayload = JSON.parse(batch.result.content[0].text);
    assert.equal(batch.result.isError, false);
    assert.equal(batchPayload.ok, true);
    assert.equal(batchPayload.passed, 7);
    assert.deepEqual(batchPayload.steps.map((step) => step.status), [
      'passed',
      'passed',
      'passed',
      'passed',
      'passed',
      'passed',
      'passed',
    ]);

    const state = JSON.parse((await client.request('tools/call', {
      name: 'run',
      arguments: { command: 'web-state', arguments: { sessionId: 'web-test-session' } },
    })).result.content[0].text);
    assert.equal(state.values['cart.count'], 2);
  } finally {
    if (socket) socket.close();
    client.close();
  }
});

test('MCP capabilities advertise batch as a run command without adding another compact tool', async () => {
  const responses = await mcpRequestSequence([
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'capabilities', arguments: { command: 'batch', includeOptions: true } } },
  ]);

  assert.deepEqual(responses.get(2).result.tools.map((tool) => tool.name), ['capabilities', 'run']);
  const batchCapability = JSON.parse(responses.get(3).result.content[0].text);
  assert.equal(batchCapability.ok, true);
  assert.equal(batchCapability.command, 'batch');
  assert.equal(batchCapability.domain, undefined);
  assert.match(JSON.stringify(batchCapability.options), /steps/);
  assert.match(JSON.stringify(batchCapability.options), /stopOnError/);
});

test('MCP capabilities advertise iOS full-control commands through compact run', async () => {
  const responses = await mcpRequestSequence([
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'capabilities', arguments: { domain: 'ios', includeOptions: true } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'capabilities', arguments: { command: 'ios-tap', includeOptions: true } } },
  ]);

  assert.deepEqual(responses.get(2).result.tools.map((tool) => tool.name), ['capabilities', 'run']);
  const iosCapabilities = JSON.parse(responses.get(3).result.content[0].text);
  assert.equal(iosCapabilities.ok, true);
  assert.match(JSON.stringify(iosCapabilities.domains.ios), /ios-setup/);
  assert.match(JSON.stringify(iosCapabilities.domains.ios), /ios-tap/);
  assert.match(JSON.stringify(iosCapabilities.domains.ios), /ios-flutter-action/);
  const iosTap = JSON.parse(responses.get(4).result.content[0].text);
  assert.equal(iosTap.ok, true);
  assert.equal(iosTap.targetKind, 'ios-device');
  assert.deepEqual(iosTap.options, ['bundleId', 'wdaUrl', 'wdaSessionId', 'tapX', 'tapY']);
});

test('MCP run dispatches batch through command arguments', async () => {
  const responses = await mcpRequestSequence([
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'run',
        arguments: {
          command: 'batch',
          arguments: {
            steps: [
              { id: 'same', command: 'status', arguments: { port: 18080 } },
              { id: 'same', command: 'logs', arguments: { port: 18080 } },
            ],
          },
        },
      },
    },
  ]);

  const payload = JSON.parse(responses.get(2).result.content[0].text);
  assert.equal(responses.get(2).result.isError, true);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'duplicate_batch_step_id');
  assert.equal(payload.stepId, 'same');
});

test('MCP batch runs steps serially with stable step ids and skips after failure', async () => {
  const calls = [];
  const result = await runBatch({
    batchId: 'batch-test',
    defaults: { serial: 'device-1', packageName: 'com.example.app' },
    steps: [
      { id: 'launch', command: 'launch-app' },
      { id: 'tap', command: 'tap-text', arguments: { targetText: 'Missing' } },
      { id: 'screenshot', command: 'screenshot' },
    ],
  }, async (command, args) => {
    calls.push({ command, args });
    if (command === 'tap-text') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'text_not_found', targetText: args.targetText }) }],
        isError: false,
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, command, packageName: args.packageName }) }],
      isError: false,
    };
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.batchId, 'batch-test');
  assert.equal(payload.passed, 1);
  assert.equal(payload.failed, 1);
  assert.equal(payload.skipped, 1);
  assert.deepEqual(payload.steps.map((step) => step.id), ['launch', 'tap', 'screenshot']);
  assert.deepEqual(payload.steps.map((step) => step.status), ['passed', 'failed', 'skipped']);
  assert.deepEqual(calls.map((call) => call.command), ['launch-app', 'tap-text']);
  assert.equal(calls[0].args.serial, 'device-1');
  assert.equal(calls[1].args.packageName, 'com.example.app');
  assert.equal(calls[1].args.targetText, 'Missing');
});

test('MCP batch can continue after failure when stopOnError is false', async () => {
  const result = await runBatch({
    defaults: { port: 18080 },
    stopOnError: false,
    steps: [
      { command: 'status' },
      { command: 'logs' },
    ],
  }, async (command) => ({
    content: [{ type: 'text', text: JSON.stringify({ ok: command !== 'status', error: command === 'status' ? 'bridge_not_ready' : undefined }) }],
    isError: false,
  }));

  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.failed, 1);
  assert.equal(payload.skipped, 0);
  assert.deepEqual(payload.steps.map((step) => step.status), ['failed', 'passed']);
  assert.deepEqual(payload.steps.map((step) => step.id), ['step_1', 'step_2']);
});

test('MCP batch rejects duplicate step ids before execution', async () => {
  const result = await runBatch({
    steps: [
      { id: 'same', command: 'status', port: 18080 },
      { id: 'same', command: 'logs', port: 18080 },
    ],
  }, async () => {
    throw new Error('runner should not be called');
  });

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'duplicate_batch_step_id');
  assert.equal(payload.stepId, 'same');
});

test('MCP run forwards advertised compact options to the CLI argument list', () => {
  const args = buildBridgeCliArgs('flutter-action', {
    packageName: 'com.example.app',
    payload: '{"action":"openHarness"}',
    textFilter: 'Runtime',
    resourceIdFilter: 'button',
    classFilter: 'TextView',
    visibleOnly: true,
    maxNodes: 10,
    maxDepth: 4,
    delta: 123,
    maxSwipes: 3,
    requireText: 'Ready',
    absentText: 'Loading',
    requireActivity: '.MainActivity',
    skipFlutterLaunch: true,
  });

  assert.deepEqual(args.slice(0, 2), [cliPath, 'flutter-action']);
  for (const [flag, value] of [
    ['--package-name', 'com.example.app'],
    ['--payload', '{"action":"openHarness"}'],
    ['--text-filter', 'Runtime'],
    ['--resource-id-filter', 'button'],
    ['--class-filter', 'TextView'],
    ['--visible-only', 'true'],
    ['--max-nodes', '10'],
    ['--max-depth', '4'],
    ['--delta', '123'],
    ['--max-swipes', '3'],
    ['--require-text', 'Ready'],
    ['--absent-text', 'Loading'],
    ['--require-activity', '.MainActivity'],
    ['--skip-flutter-launch', 'true'],
  ]) {
    const index = args.indexOf(flag);
    assert.notEqual(index, -1, `${flag} is forwarded`);
    assert.equal(args[index + 1], value);
  }
});

test('MCP run forwards freeze/thaw commands and explicit pid to the CLI argument list', () => {
  const freezeArgs = buildBridgeCliArgs('freeze-app', {
    packageName: 'com.example.app',
    serial: 'device-1',
    pid: '1234',
  });
  assert.deepEqual(freezeArgs.slice(0, 2), [cliPath, 'freeze-app']);
  assert.equal(freezeArgs[freezeArgs.indexOf('--package-name') + 1], 'com.example.app');
  assert.equal(freezeArgs[freezeArgs.indexOf('--serial') + 1], 'device-1');
  assert.equal(freezeArgs[freezeArgs.indexOf('--pid') + 1], '1234');

  const thawArgs = buildBridgeCliArgs('thaw-app', { packageName: 'com.example.app' });
  assert.deepEqual(thawArgs.slice(0, 2), [cliPath, 'thaw-app']);
});

test('MCP run forwards iOS command arguments to the CLI argument list', () => {
  const args = buildBridgeCliArgs('ios-setup', {
    deviceId: 'device-1',
    bundleId: 'com.example.ios',
    appPath: '/tmp/App.app',
    iosHost: 'fd00::1',
    iosPort: 18091,
    runtimeUrl: 'http://127.0.0.1:18091',
    wdaUrl: 'http://127.0.0.1:8100',
    wdaSessionId: 'wda-session',
    wdaProjectPath: '/tmp/WebDriverAgent.xcodeproj',
    wdaBundleId: 'io.example.wda',
    accessibilityId: 'sample_text_field',
    elementId: 'element-1',
    clearFirst: true,
    teamId: 'TEAM123456',
    startWda: true,
  });

  assert.deepEqual(args.slice(0, 2), [cliPath, 'ios-setup']);
  for (const [flag, value] of [
    ['--device-id', 'device-1'],
    ['--bundle-id', 'com.example.ios'],
    ['--app-path', '/tmp/App.app'],
    ['--ios-host', 'fd00::1'],
    ['--ios-port', '18091'],
    ['--runtime-url', 'http://127.0.0.1:18091'],
    ['--wda-url', 'http://127.0.0.1:8100'],
    ['--wda-session-id', 'wda-session'],
    ['--wda-project-path', '/tmp/WebDriverAgent.xcodeproj'],
    ['--wda-bundle-id', 'io.example.wda'],
    ['--accessibility-id', 'sample_text_field'],
    ['--element-id', 'element-1'],
    ['--clear-first', 'true'],
    ['--team-id', 'TEAM123456'],
    ['--start-wda', 'true'],
  ]) {
    const index = args.indexOf(flag);
    assert.notEqual(index, -1, `${flag} is forwarded`);
    assert.equal(args[index + 1], value);
  }
});

test('parseArgs keeps repeated launch categories and extras', () => {
  const parsed = parseArgs([
    'launch-activity',
    '--activity',
    '.MainActivity',
    '--category',
    'android.intent.category.DEFAULT',
    '--category',
    'com.example.CUSTOM',
    '--extra',
    'first=1',
    '--extra',
    'second=two=kept',
  ]);

  assert.equal(parsed.command, 'launch-activity');
  assert.equal(parsed.options.activity, '.MainActivity');
  assert.deepEqual(parsed.options.category, ['android.intent.category.DEFAULT', 'com.example.CUSTOM']);
  assert.deepEqual(parsed.options.extra, ['first=1', 'second=two=kept']);
});

test('iOS provider shapes devicectl devices and WDA responses', () => {
  const device = shapeDevice({
    identifier: 'CORE-DEVICE-ID',
    connectionProperties: {
      pairingState: 'paired',
      transportType: 'wired',
      tunnelIPAddress: 'fd00::1234',
      potentialHostnames: ['iPhone.coredevice.local'],
    },
    deviceProperties: {
      bootState: 'booted',
      developerModeStatus: 'enabled',
      ddiServicesAvailable: true,
      name: 'iPhone',
      osVersionNumber: '27.0',
    },
    hardwareProperties: {
      marketingName: 'iPhone 17 Pro Max',
      platform: 'iOS',
      productType: 'iPhone18,2',
      serialNumber: 'SERIAL',
      udid: 'UDID',
    },
  });

  assert.equal(device.identifier, 'CORE-DEVICE-ID');
  assert.equal(device.udid, 'UDID');
  assert.equal(device.developerModeStatus, 'enabled');
  assert.equal(device.tunnelIPAddress, 'fd00::1234');
  assert.equal(formatHostForUrl(device.tunnelIPAddress), '[fd00::1234]');
  assert.equal(selectDeviceFromList([device], { deviceId: 'UDID' }).device.identifier, 'CORE-DEVICE-ID');
  assert.equal(wdaSessionIdFromResponse({ value: { sessionId: 'wda-1' } }), 'wda-1');
});

test('iOS provider returns structured install signing failures', async () => {
  const provider = new IOSBridgeProvider({
    execFile(command, args, options, callback) {
      if (args.includes('list') && args.includes('devices')) {
        const jsonPath = args[args.indexOf('--json-output') + 1];
        fs.writeFileSync(jsonPath, JSON.stringify({
          result: {
            devices: [{
              identifier: 'device-1',
              deviceProperties: {
                name: 'iPhone',
                developerModeStatus: 'enabled',
                ddiServicesAvailable: true,
              },
              hardwareProperties: {
                platform: 'iOS',
                udid: 'udid-1',
              },
              connectionProperties: {
                pairingState: 'paired',
              },
            }],
          },
        }));
        callback(null, '', '');
        return;
      }
      const error = new Error('Command failed: No code signature found.');
      error.stderr = 'No code signature found.';
      callback(error, '', 'No code signature found.');
    },
  });

  const result = await provider.run('ios-install-app', {
    deviceId: 'device-1',
    appPath: '/tmp/AiAppBridgeIOSSample.app',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'ios_code_signing_required');
  assert.equal(result.command, 'ios-install-app');
  assert.match(result.message, /No code signature found/);
});

test('iOS default screenshots use the shared bounded artifact lifecycle', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-app-bridge-ios-artifacts-'));
  try {
    const nowMs = Date.now();
    for (let index = 0; index < 21; index += 1) {
      const filePath = path.join(
        directory,
        `ios-screenshot-20260830-0101${String(index).padStart(2, '0')}-000-42-old${String(index).padStart(2, '0')}.png`,
      );
      fs.writeFileSync(filePath, 'old');
      const mtime = new Date(nowMs - (index + 1) * 1_000);
      fs.utimesSync(filePath, mtime, mtime);
    }
    const expiredPath = path.join(directory, 'ios-screenshot-20260828-010100-000-42-expired.png');
    fs.writeFileSync(expiredPath, 'expired');
    const expiredTime = new Date(nowMs - (25 * 60 * 60 * 1000));
    fs.utimesSync(expiredPath, expiredTime, expiredTime);

    const provider = new IOSBridgeProvider({
      execFile(_command, args, _options, callback) {
        const jsonPath = args[args.indexOf('--json-output') + 1];
        if (args.includes('list') && args.includes('devices')) {
          fs.writeFileSync(jsonPath, JSON.stringify({
            result: {
              devices: [{
                identifier: 'ios-artifact-device',
                deviceProperties: { name: 'iPhone', developerModeStatus: 'enabled' },
                hardwareProperties: { platform: 'iOS', udid: 'ios-artifact-udid' },
                connectionProperties: { pairingState: 'paired' },
              }],
            },
          }));
        } else {
          const destination = args[args.indexOf('--destination') + 1];
          fs.writeFileSync(destination, 'new screenshot');
          fs.writeFileSync(jsonPath, JSON.stringify({ result: { captured: true } }));
        }
        callback(null, '', '');
      },
    });

    const result = await provider.run('ios-screenshot', {
      deviceId: 'ios-artifact-device',
      artifactDir: directory,
    });

    assert.equal(result.ok, true);
    assert.equal(result.artifact.path, result.outFile);
    assert.equal(result.artifact.generatedDefault, true);
    assert.equal(result.artifact.retention.keep, 20);
    assert.equal(result.artifact.retention.maxAgeMs, 24 * 60 * 60 * 1000);
    assert.equal(result.artifact.retention.maxBytes, 64 * 1024 * 1024);
    assert.equal(fs.existsSync(expiredPath), false);
    assert.equal(fs.readdirSync(directory).filter((name) => name.startsWith('ios-screenshot-')).length, 20);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('iOS doctor fails fast when the selected device cannot expose a debug runtime tunnel', async () => {
  let unexpectedDeviceCalls = 0;
  let httpCalls = 0;
  const provider = new IOSBridgeProvider({
    execFile(command, args, options, callback) {
      if (command === 'xcodebuild') {
        callback(null, 'Xcode 27.0\nBuild version 18A123\n', '');
        return;
      }
      if (args.includes('list') && args.includes('devices')) {
        const jsonPath = args[args.indexOf('--json-output') + 1];
        fs.writeFileSync(jsonPath, JSON.stringify({
          result: {
            devices: [{
              identifier: 'device-unavailable',
              deviceProperties: {
                name: 'iPhone',
                developerModeStatus: 'disabled',
                ddiServicesAvailable: false,
              },
              hardwareProperties: {
                platform: 'iOS',
                udid: 'udid-unavailable',
              },
              connectionProperties: {
                pairingState: 'paired',
                tunnelState: 'unavailable',
                potentialHostnames: ['iPhone.coredevice.local'],
              },
            }],
          },
        }));
        callback(null, '', '');
        return;
      }
      unexpectedDeviceCalls += 1;
      callback(new Error('unexpected devicectl call'), '', '');
    },
    httpRequest: async () => {
      httpCalls += 1;
      throw new Error('must not probe an unavailable tunnel');
    },
  });

  const result = await provider.run('ios-doctor', {
    deviceId: 'udid-unavailable',
    bundleId: 'com.example.ios',
  });

  assert.equal(result.ok, true);
  assert.equal(result.ready, false);
  assert.equal(result.checks.find((check) => check.name === 'runtime').error, 'ios_tunnel_unavailable');
  assert.equal(unexpectedDeviceCalls, 0);
  assert.equal(httpCalls, 0);
});

test('clear-app-data requires an explicit package and builds adb pm clear args', () => {
  let missingPackage;
  try {
    execFileSync(process.execPath, [
      cliPath,
      'clear-app-data',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ADB: 'adb-that-should-not-run',
      },
      stdio: 'pipe',
    });
  } catch (error) {
    missingPackage = error;
  }
  assert(missingPackage);
  assert.match(String(missingPackage.stderr), /packageName is required for clear-app-data/);

  assert.deepEqual(clearAppDataAdbArgs('com.example.app'), ['shell', 'pm', 'clear', 'com.example.app']);
  const args = buildBridgeCliArgs('clear-app-data', { packageName: 'com.example.app' });
  assert.deepEqual(args.slice(0, 2), [cliPath, 'clear-app-data']);
  const packageIndex = args.indexOf('--package-name');
  assert.notEqual(packageIndex, -1);
  assert.equal(args[packageIndex + 1], 'com.example.app');
});

test('launch helpers parse and normalize Android Activity components', () => {
  assert.equal(
    normalizeActivityComponent('com.example.app', '.MainActivity'),
    'com.example.app/.MainActivity',
  );
  assert.equal(
    normalizeActivityComponent('com.example.app', 'com.example.app.MainActivity'),
    'com.example.app/com.example.app.MainActivity',
  );
  assert.equal(
    normalizeActivityComponent('com.example.app', 'com.other/.EntryActivity'),
    'com.other/.EntryActivity',
  );

  assert.deepEqual(parseStartExtras(['route=/home', 'token=a=b']), [
    { key: 'route', value: '/home' },
    { key: 'token', value: 'a=b' },
  ]);
  assert.throws(() => parseStartExtras(['broken']), /extra must use key=value/);
});

test('launcher query output reports concrete Activity candidates', () => {
  const output = [
    '2 activities found:',
    '  Activity #0:',
    '    priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false',
    '    com.example/.LeakLauncherActivity',
    '  Activity #1:',
    '    priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false',
    '    com.example/.ui.SplashActivity',
    '',
  ].join('\n');

  assert.deepEqual(parseLauncherActivityCandidates(output), [
    'com.example/.LeakLauncherActivity',
    'com.example/.ui.SplashActivity',
  ]);
});

test('logcat app-pid filtering does not fall back to unfiltered logs when pid is missing', () => {
  const rawLogcat = [
    '05-20 16:40:46.266  2225  2225 D SensorFeature: unrelated system line',
    '05-20 16:40:47.100  3333  3333 E AndroidRuntime: crash line',
  ].join('\n');

  assert.equal(filterLogcat(rawLogcat, { appPid: true, pid: '' }), '');
  assert.match(filterLogcat(rawLogcat, {}), /SensorFeature/);
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
    defaultArtifactDirectory(),
    path.join(fs.realpathSync(path.join(__dirname, '..')), 'node_modules', '.cache', 'ai_app_bridge_artifacts'),
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

test('generated default artifact directory uses ignored Gradle build directory', () => {
  const repo = makeGitRepo(
    { 'settings.gradle.kts': 'pluginManagement {}\n' },
    'build/\n',
  );

  assert.equal(
    defaultArtifactDirectory({ cwd: repo }),
    path.join(repo, 'build', 'ai_app_bridge_artifacts'),
  );
});

test('generated default artifact directory uses ignored Node cache when build is not ignored', () => {
  const repo = makeGitRepo(
    { 'package.json': '{"name":"node-only"}\n' },
    'node_modules/\n',
  );

  assert.equal(
    defaultArtifactDirectory({ cwd: repo }),
    path.join(repo, 'node_modules', '.cache', 'ai_app_bridge_artifacts'),
  );
});

test('generated default artifact directory prefers the nearest ignored project directory in a monorepo', () => {
  const repo = makeGitRepo(
    {
      'settings.gradle.kts': 'rootProject.name = "root"\n',
      'examples/android-native-sample/settings.gradle.kts': 'rootProject.name = "sample"\n',
    },
    'build/\n',
  );
  const sample = path.join(repo, 'examples', 'android-native-sample');

  assert.equal(
    defaultArtifactDirectory({ cwd: sample }),
    path.join(sample, 'build', 'ai_app_bridge_artifacts'),
  );
});

test('generated default artifact directory falls back inside git metadata when no candidate is ignored', () => {
  const repo = makeGitRepo({ 'package.json': '{"name":"tracked-build"}\n' });

  assert.equal(
    defaultArtifactDirectory({ cwd: repo }),
    path.join(repo, '.git', 'ai_app_bridge_artifacts'),
  );
});

test('screenshot default output path uses generated artifacts unless explicit', () => {
  assert.equal(
    path.dirname(screenshotOutputPath()),
    path.join(fs.realpathSync(path.join(__dirname, '..')), 'node_modules', '.cache', 'ai_app_bridge_artifacts'),
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

test('MCP generated artifact directory follows the caller git ignore rules', () => {
  const repo = makeGitRepo(
    {
      'settings.gradle': 'pluginManagement {}\n',
      'examples/android-native-sample/settings.gradle.kts': 'rootProject.name = "sample"\n',
    },
    'build/\n',
  );
  const sample = path.join(repo, 'examples', 'android-native-sample');

  withCwd(sample, () => {
    const args = buildBridgeCliArgs('screenshot', {});
    const artifactDirIndex = args.indexOf('--artifact-dir');
    assert.notEqual(artifactDirIndex, -1);
    assert.equal(args[artifactDirIndex + 1], path.join(sample, 'build', 'ai_app_bridge_artifacts'));
    assert.equal(defaultArtifactDirFor('screenshot', {}), path.join(sample, 'build', 'ai_app_bridge_artifacts'));
  });
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
      nowMs: baseTime + 100_000,
    });

    const remaining = fs.readdirSync(directory);
    const screenshotFiles = remaining.filter((name) => name.startsWith('ai_app_bridge_screenshot-'));
    assert.equal(result.keep, 20);
    assert.equal(result.maxAgeMs, 24 * 60 * 60 * 1000);
    assert.equal(result.maxBytes, 64 * 1024 * 1024);
    assert.equal(result.deleted, 4);
    assert.equal(result.bytesAfter <= result.maxBytes, true);
    assert.equal(screenshotFiles.length, 20);
    assert.equal(fs.existsSync(currentPath), true);
    assert.equal(fs.existsSync(smokePath), true);
    assert.equal(fs.existsSync(explicitPath), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('generated screenshot artifact pruning enforces TTL and total-byte limits', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-app-bridge-prune-bounds-'));
  try {
    const nowMs = new Date('2026-05-12T10:00:00.000Z').getTime();
    const makeFile = (name, contents, mtimeMs) => {
      const filePath = path.join(directory, name);
      fs.writeFileSync(filePath, contents);
      const mtime = new Date(mtimeMs);
      fs.utimesSync(filePath, mtime, mtime);
      return filePath;
    };
    const expiredPath = makeFile(
      'ai_app_bridge_screenshot-20260512-090000-000-42-expired.png',
      'expired',
      nowMs - 2_000,
    );
    const currentPath = makeFile(
      'ai_app_bridge_screenshot-20260512-100000-000-42-current.png',
      '123456',
      nowMs,
    );
    const recentPath = makeFile(
      'ai_app_bridge_screenshot-20260512-095959-990-42-recent1.png',
      'abcdef',
      nowMs - 10,
    );
    const olderPath = makeFile(
      'ai_app_bridge_screenshot-20260512-095959-980-42-recent2.png',
      'uvwxyz',
      nowMs - 20,
    );
    const unrelatedPath = makeFile('manual.png', 'manual', nowMs - 100_000);

    const result = await pruneGeneratedArtifacts({
      directory,
      prefix: 'ai_app_bridge_screenshot',
      extension: 'png',
      currentPath,
      keep: 20,
      maxAgeMs: 1_000,
      maxBytes: 10,
      nowMs,
    });

    assert.equal(result.deletedExpired, 1);
    assert.equal(result.deletedForBytes, 2);
    assert.equal(result.bytesBefore, 25);
    assert.equal(result.bytesAfter, 6);
    assert.equal(fs.existsSync(expiredPath), false);
    assert.equal(fs.existsSync(recentPath), false);
    assert.equal(fs.existsSync(olderPath), false);
    assert.equal(fs.existsSync(currentPath), true);
    assert.equal(fs.existsSync(unrelatedPath), true);
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

test('explicit package bridge status rejects a response from another package', () => {
  assert.doesNotThrow(() => verifyBridgeTargetPackage(
    { explicitPackageName: true, packageName: 'com.example.target' },
    { app: { packageName: 'com.example.target' } },
    '/v1/status',
  ));

  assert.throws(
    () => verifyBridgeTargetPackage(
      { explicitPackageName: true, packageName: 'com.example.target' },
      { app: { packageName: 'com.example.other' } },
      '/v1/status',
    ),
    (error) => {
      assert.equal(error.aiAppBridgePackageMismatch, true);
      assert.equal(normalizeBridgeError(error).code, 'bridge_package_mismatch');
      return true;
    },
  );
});

test('explicit package port discovery failure does not fall back to default sample port', () => {
  assert.equal(shouldUseDefaultPortFallback({ explicitPackageName: true }), false);
  assert.equal(shouldUseDefaultPortFallback({ explicitPackageName: false }), true);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-app-bridge-adb-mock-'));
  const logPath = path.join(tempDir, 'adb.log');
  const isWindows = process.platform === 'win32';
  const adbPath = path.join(tempDir, isWindows ? 'adb.cmd' : 'adb');
  const script = isWindows
    ? [
      '@echo off',
      `echo %*>>"${logPath}"`,
      'echo %* | findstr /C:"shell run-as" >nul',
      'if %errorlevel%==0 (',
      '  echo run-as failed 1>&2',
      '  exit /b 1',
      ')',
      'echo unexpected adb call %* 1>&2',
      'exit /b 1',
      '',
    ].join('\r\n')
    : [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${logPath}'`,
      'case "$*" in',
      '  *"shell run-as"*) echo "run-as failed" >&2; exit 1 ;;',
      '  *) echo "unexpected adb call $*" >&2; exit 1 ;;',
      'esac',
      '',
    ].join('\n');

  try {
    fs.writeFileSync(adbPath, script);
    if (!isWindows) fs.chmodSync(adbPath, 0o755);

    const output = execFileSync(process.execPath, [
      cliPath,
      'status',
      '--package-name',
      'com.example.noport',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ADB: adbPath,
      },
    });

    const result = JSON.parse(output);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'bridge_port_discovery_failed');
    assert.equal(result.packageName, 'com.example.noport');
    assert.equal(result.attempted.devicePortSource, 'package-port-file');

    if (fs.existsSync(logPath)) {
      const adbLog = fs.readFileSync(logPath, 'utf8');
      assert.doesNotMatch(adbLog, /forward/);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
  assert.deepEqual(
    bridgeNodeTarget({
      className: 'android.widget.Button',
      resourceName: 'com.example:id/open_detail',
      clickable: true,
      enabled: true,
      bounds: match.node.bounds,
    }, 'dialog'),
    {
      className: 'android.widget.Button',
      resourceName: 'com.example:id/open_detail',
      clickable: true,
      enabled: true,
      windowType: 'dialog',
      bounds: match.node.bounds,
    },
  );
});

test('tap-text candidate selection skips disabled bridge nodes', () => {
  const tree = {
    root: {
      bounds: { left: 0, top: 0, right: 100, bottom: 200, width: 100, height: 200 },
      children: [
        {
          text: 'Language',
          enabled: false,
          visible: true,
          effectiveVisible: true,
          bounds: { left: 0, top: 20, right: 100, bottom: 60, width: 100, height: 40 },
        },
      ],
    },
  };

  const match = findTappableNodeByText(tree, 'Language');
  assert.equal(match.node, null);
  assert.equal(match.rejected.reason, 'not_enabled');
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

test('parses package main and remote process pids from Android ps output', () => {
  const pids = parsePackagePidsFromPs([
    'PID NAME',
    '123 com.example.app',
    '124 com.example.app:remote',
    '125 com.example.app.debug',
    '126 other.process',
  ].join('\n'), 'com.example.app');

  assert.deepEqual(pids, ['123', '124']);
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
