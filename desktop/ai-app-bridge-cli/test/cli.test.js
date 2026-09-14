const { nativeBridgeStatus, nativeExecutionReceipt } = require('../test-support/native-target-fixture');
const { spawnSync } = require('node:child_process');
const assert = require('assert/strict');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const WebSocket = require('ws');
const { createAdbHttpFixture } = require('../test-support/adb-http-fixture');

const { buildBridgeFailureResult, bridgeRequest, bridgeNodeTarget, artifactTimestamp, clearAppDataAdbArgs, compactBridgeTree, compactStatus, compactUiaTree, defaultArtifactDirectory, defaultArtifactPath, findTappableNodeByText, filterLogcat, normalizeBridgeError, normalizeActivityComponent, parseWebViewDevToolsSockets, parseKeyboardState, parsePackagePidsFromPs, parseLauncherActivityCandidates, parseStartExtras, parseUiaBounds, parseUiaViewport, parseComponentFromWindowLine, parseForegroundWindow, chooseWebViewDevToolsSocket, chooseWebViewPage, shapeNetworkCapture, compactNetworkRecord, pruneGeneratedArtifacts, shouldDismissKeyboardForPoint, screenshotOutputPath, tap, startActivity, verifyBridgeTargetPackage } = require('../bin/device-provider');
const { helpText, parseArgs } = require('../bin/ai-app-bridge.js');

const cliPath = path.join(__dirname, '..', 'bin', 'ai-app-bridge.js');
const mcpPath = path.join(__dirname, '..', 'bin', 'mcp-server.js');
const { createFactStore } = require('../bin/fact-store.js');
const {
  IOSBridgeProvider,
  formatHostForUrl,
  selectDeviceFromList,
  shapeDevice,
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

test('SDK transport attempts each request once and does not replay a failed read or action', async () => {
  for (const kind of ['read', 'mutation']) {
    let prepares = 0;
    let attempts = 0;
    await assert.rejects(bridgeRequest({}, async () => {
      attempts += 1;
      throw new Error(`${kind} response lost`);
    }, { ensureForward: async () => { prepares += 1; } }), new RegExp(`${kind} response lost`));
    assert.equal(attempts, 1);
    assert.equal(prepares, 1);
  }
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
    explicitPackageName: true, httpTimeoutMs: 5000,
    packageName: 'com.example.app',
  }, 12, 34, { feedback: 'auto', runtimeActionId: 'runtime-action-1' }, {
    foregroundWindow: async () => ({ ok: true, packageName: 'com.example.app' }),
    bridgeStatus: nativeBridgeStatus,
    bridgePost: async (_ctx, requestPath, payload) => {
      bridgeCalls += 1;
      assert.equal(requestPath, '/v1/action/tap');
      assert.deepEqual({ ...payload, execution: undefined }, { x: 12, y: 34, actionId: 'runtime-action-1', execution: undefined });
      assert.equal(payload.execution.actionId, payload.actionId);
      return nativeExecutionReceipt(payload, {
        ok: true,
        target: { className: 'android.widget.Button', resourceName: 'com.example.app:id/save' },
        handledDown: true,
        handledUp: true,
      });
    },
    adb: async () => { adbCalls += 1; },
  });

  assert.equal(bridgeCalls, 1);
  assert.equal(adbCalls, 0);
  assert.equal(result.transport, 'bridge');
  assert.equal(result.target.resourceName, 'com.example.app:id/save');
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
  assert.match(output, /--package-name/);
  assert.match(output, /input-text/);
  assert.match(output, /ios-input/);
  assert.match(output, /--help <command>/);
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

test('MCP production wiring persists Legacy, Script, and Intent together, then explicitly stops the shared runtime before EOF', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-app-bridge-mcp-shutdown-'));
  const treeServer = require('node:http').createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, root: {
      id: 'fixture-home', className: 'TextView', text: 'Fixture Home', children: [],
    } }));
  });
  await new Promise((resolve) => treeServer.listen(0, '127.0.0.1', resolve));
  const adb = createAdbHttpFixture({ directory: cacheDir, serial: 'fixture-device', port: treeServer.address().port });
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
          target: { platform: 'android', serial: 'fixture-device', packageName: 'com.example.fixture', adb, port: treeServer.address().port },
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
          decision: { decisionId: 'complete-1', agentDecision: 'complete', basedOnRevision: intentPayload.revision },
        },
      },
    });
    const decisionPayload = JSON.parse(decision.result.content[0].text);
    assert.equal(decisionPayload.ok, true);
    assert.equal(decisionPayload.status, 'completed');

    const stopped = await client.request('tools/call', { name: 'run', arguments: { command: 'runtime', arguments: { operation: 'stop' } } });
    assert.equal(JSON.parse(stopped.result.content[0].text).status, 'stopped');
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


test('MCP exposes device-wide log collection through the logcat command schema', async () => {
  const responses = await mcpRequestSequence([
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'capabilities', arguments: { command: 'logcat' } } },
  ]);
  const schema = JSON.parse(responses.get(2).result.content[0].text).inputSchema;
  assert.deepEqual(schema.properties.deviceLogScope.enum, ['device']);
  assert.equal(schema.properties.deviceLogBuffers.anyOf[1].items.type, 'string');
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
  assert.match(responses.get(3).result.content[0].text, /packageName/);
  assert.doesNotMatch(responses.get(3).result.content[0].text, /sample/);
  assert.equal(responses.get(4).result.isError, true);
  assert.equal(JSON.parse(responses.get(4).result.content[0].text).error, 'unknown_tool');
  assert.equal(responses.get(5).result.isError, true);
  assert.match(responses.get(5).result.content[0].text, /packageName is required/);
  assert.equal(responses.get(6).result.isError, true);
  assert.equal(JSON.parse(responses.get(6).result.content[0].text).error, 'unknown_tool');
  assert.equal(responses.get(7).result.isError, true);
  assert.match(responses.get(7).result.content[0].text, /packageName is required/);
});

test('CLI starts Web v2; MCP reads committed captures and completes commands on the same bound session', { timeout: 20000 }, async () => {
  const { runCli } = require('../test-support/cli-client');
  const { once } = require('node:events');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-web-entry-'));
  const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'facts'), AI_APP_BRIDGE_RUNTIME_HOME: path.join(directory, 'runtimes') };
  const client = createLineJsonMcpClient({ env });
  const run = async (command, args) => JSON.parse((await client.request('tools/call', {
    name: 'run', arguments: { command, arguments: args },
  })).result.content[0].text);
  let socket;
  const received = [];
  const target = { sessionId: 'web-test-session', runtimeEpoch: 'web-document-1', targetId: 'main' };
  const protocol = 'aab.web/v2', executionSchema = 'aab.web-execution/v1', domTargetSchema = 'aab.web-dom-target/v1';
  const pageRef = { schemaVersion: domTargetSchema, ...target, navigationId: 'navigation-1', url: 'http://example.test/app' };
  const control = { elementId: 'button-1', tag: 'button', id: 'submit', name: '', type: 'button', role: '',
    ariaLabel: '', placeholder: '', href: '', text: 'Submit', visible: true, disabled: false, editable: false, checked: null };
  let pendingEffect;
  const completion = message => ({ type: 'completion', binding: message.binding, result: {
    ok: true, actionId: message.payload.actionId, runtimeEpoch: target.runtimeEpoch,
    settled: true, dispatched: true, ambiguous: false, value: 'ran:action',
    execution: { schemaVersion: executionSchema, actionId: message.payload.actionId,
      runtimeEpoch: target.runtimeEpoch, target, settled: true },
  } });
  try {
    await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'web-entry-test', version: '0' } });
    client.notify('notifications/initialized');
    const started = await runCli('web-session-start', { webPort: 0, token: 'test-web-token' }, { env });
    assert.equal(started.code, 0, JSON.stringify(started));
    const start = started.value;
    socket = new WebSocket(`${start.endpoint}?token=${encodeURIComponent(start.token)}`);
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()); received.push(message);
      if (message.type === 'read' && message.payload.name === 'captureBarrier') socket.send(JSON.stringify({
        type: 'response', requestId: message.requestId, binding: message.binding,
        result: { ok: true, schemaVersion: 'aab.web-capture/v1', stream: message.payload.args.stream,
          sequence: 1, losses: 0, pending: 0, target } }));
      if (message.type === 'read' && message.payload.name === 'domSnapshot') socket.send(JSON.stringify({ type: 'response', requestId: message.requestId, binding: message.binding,
        result: { ok: true, dom: { ok: true, targetSchema: domTargetSchema, pageRef, url: pageRef.url,
          bodyText: 'Ready Submit', controls: [control], controlCount: 1, truncated: false, bodyTextTruncated: false } } }));
      if (message.type === 'command') {
        if (message.payload.command.args.name === 'demo.delayed') pendingEffect = message;
        else socket.send(JSON.stringify(completion(message)));
      }
    });
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'hello', schemaVersion: protocol, ...target, executionSchema, domTargetSchema,
      appName: 'web-test-app', url: pageRef.url, origin: 'http://example.test', route: '/app' }));
    await waitUntilTest(() => received.some(message => message.type === 'helloAck'));
    const binding = received.find(message => message.type === 'helloAck').binding;
    const captures = { logs: { level: 'info', tag: 'test', message: 'hello web' },
      network: { method: 'GET', url: 'https://example.test/api', statusCode: 200, durationMs: 12 },
      state: { namespace: 'cart', key: 'count', value: 2 }, events: { category: 'ui', name: 'submitted' } };
    for (const [stream, item] of Object.entries(captures)) socket.send(JSON.stringify({ type: 'capture', binding,
      captureId: `original-${stream}`, stream, sequence: 1, actionId: null, item: { ...item, association: 'unattributed' } }));
    await waitUntilTest(() => received.filter(message => message.type === 'captureAck').length === 4);
    for (const ack of received.filter(message => message.type === 'captureAck')) assert.equal(ack.receipt.stored, true);
    assert.equal((await run('web-status', { sessionId: target.sessionId })).session.runtimeEpoch, target.runtimeEpoch);
    assert.equal((await run('web-dom', target)).dom.controls[0].elementId, 'button-1');
    for (const stream of Object.keys(captures)) {
      const result = await run(`web-${stream}`, target);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.source, 'host-fact-store'); assert.equal(result.count, 1);
      assert.equal(result.items[0].captureId, `original-${stream}`);
    }
    assert.equal((await run('web-state', target)).values.cart.count, 2);
    const action = await run('web-command', { ...target, name: 'action', arguments: { name: 'demo.action', arguments: {} }, feedback: 'off' });
    assert.equal(action.ok, true, JSON.stringify(action)); assert.equal(action.settled, true);

    // Disconnect a CLI while its actual provider request is in flight. The
    // runtime must accept the original completion, without cancel or replay.
    const child = spawn(process.execPath, [cliPath, 'web-command', '--session-id', target.sessionId,
      '--runtime-epoch', target.runtimeEpoch, '--name', 'action', '--arguments', JSON.stringify({ name: 'demo.delayed', arguments: {} }),
      '--feedback', 'off', '--timeout-ms', '10000'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'close');
    try { await waitUntilTest(() => pendingEffect); }
    finally { child.kill('SIGTERM'); await exited; }
    socket.send(JSON.stringify(completion(pendingEffect)));
    await waitUntilTest(() => received.some(message => message.type === 'completionAck' && message.actionId === pendingEffect.payload.actionId));
    const original = await run('web-execution', { ...target, operation: 'result', actionId: pendingEffect.payload.actionId });
    assert.equal(original.ok, true, JSON.stringify(original));
    assert.equal(original.executionResult.value, 'ran:action');
    assert.equal(received.filter(message => message.type === 'command').length, 2);
    assert.equal(received.some(message => message.type === 'cancel'), false);
  } finally {
    if (socket) socket.terminate();
    try { assert.equal((await runCli('runtime', { operation: 'stop' }, { env })).value.status, 'stopped'); }
    finally {
      const exited = once(client.child, 'close'); client.close(); await exited;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
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
  assert.equal(iosTap.targetKind, 'ios-app');
  assert.deepEqual(iosTap.inputSchema.required, ['deviceId', 'wdaRunnerBundleId', 'bundleId', 'wdaSessionId', 'tapX', 'tapY']);
  assert.equal(iosTap.inputSchema.properties.tapX.type, 'number');
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
});

test('iOS provider returns structured install signing failures', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-ios-signing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const provider = new IOSBridgeProvider({
    lease: require('../bin/shared-kernel/device-mutation-lease').createDeviceMutationLease({ directory }),
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
                deviceProperties: { name: 'iPhone', developerModeStatus: 'enabled', ddiServicesAvailable: true },
                hardwareProperties: { platform: 'iOS', udid: 'ios-artifact-udid' },
                connectionProperties: { pairingState: 'paired', tunnelState: 'connected' },
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

test('iOS doctor probes selected device details before refusing an unavailable debug runtime tunnel', async () => {
  let unexpectedDeviceCalls = 0;
  let detailCalls = 0;
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
      if (args.includes('details')) {
        assert.equal(args[args.indexOf('--device') + 1], 'device-unavailable');
        detailCalls += 1;
        callback(Object.assign(new Error('Device details unavailable'), { code: 1 }), '', '');
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
  assert.equal(detailCalls, 1);
  assert.equal(result.selectedDevice.connectionProbe.ok, false);
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
  assert.equal(JSON.parse(missingPackage.stdout).value.error, 'missing_argument');
  assert.equal(JSON.parse(missingPackage.stdout).value.field, 'packageName');

  assert.deepEqual(clearAppDataAdbArgs('com.example.app'), ['shell', 'pm', 'clear', 'com.example.app']);

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
      endpoint: { transport: 'localabstract', socketName: 'test-socket' },
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
  assert.equal(result.attempted.endpoint.socketName, 'test-socket');
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

test('explicit host port cannot bypass package endpoint discovery', async () => {

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-app-bridge-adb-mock-'));
  const logPath = path.join(tempDir, 'adb.log');
  const runtimeEnv = { ...process.env, AI_APP_BRIDGE_FACT_STORE_DIR: path.join(tempDir, 'facts'),
    AI_APP_BRIDGE_RUNTIME_HOME: path.join(tempDir, 'runtimes'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' };
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

    const processResult = spawnSync(process.execPath, [
      cliPath,
      'status',
      '--package-name',
      'com.example.noport',
      '--serial', 'endpoint-test-device',
      '--port', '41234',
    ], {
      encoding: 'utf8',
      env: {
        ...runtimeEnv,
        ADB: adbPath,
      },
    });

    assert.equal(processResult.status, 1);
    const result = JSON.parse(processResult.stdout).value;
    assert.equal(result.ok, false);
    assert.equal(result.error, 'bridge_endpoint_discovery_failed');
    assert.equal(result.packageName, 'com.example.noport');
    assert.equal(result.attempted.endpoint, null);
    assert.equal(result.attempted.localPort, null);
    assert.equal(result.attempted.requestedLocalPort, 41234);

    if (fs.existsSync(logPath)) {
      const adbLog = fs.readFileSync(logPath, 'utf8');
      assert.doesNotMatch(adbLog, /forward/);
    }
  } finally {
    await require('../test-support/runtime-control').stopRuntime({ env: runtimeEnv });
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
      visible: true, enabled: true,
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
      visible: true, enabled: true,
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
      visible: true, enabled: true,
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
