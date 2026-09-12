'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { nativeRuntimeStatus, nativeExecutionReceipt } = require('../test-support/native-target-fixture');
const { createAdbHttpFixture } = require('../test-support/adb-http-fixture');
const { runBridgeChecked } = require('../test-support/host-client');
const { TargetExecution } = require('../bin/target-execution');
const { createMcpClient, payloadOf } = require('../scripts/validation/mcp-jsonrpc-client');

const invalidCoordinates = [
  { tapX: null, tapY: null },
  { tapX: '', tapY: '' },
  { tapX: ' \t', tapY: '\n ' },
  { tapX: false, tapY: false },
  { tapX: 10 },
  { tapY: 20 },
  { tapX: 'Infinity', tapY: 20 },
  { tapX: 10, tapY: 1e40 },
];


test('MCP rejects invalid input before target execution, observers or feedback can dispatch', async () => {
  let executions = 0;
  let registrations = 0;
  let calls = 0;
  const dependencies = {
    targetExecution: { execute() { executions += 1; throw new Error('unexpected execution'); } },
    observationCollector: { register() { registrations += 1; throw new Error('unexpected observation'); } },
    rawRunner: async () => { calls += 1; return { ok: true }; },
  };
  for (const coordinates of [...invalidCoordinates, { x: null, y: null }, { x: 1 }]) {
    const result = await runBridgeChecked('input-text', {
      serial: 'input-wire', packageName: 'test.input.coordinates', text: 'do not edit',
      feedback: 'full', ...coordinates,
    }, dependencies);
    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0].text).error, /^(invalid_argument|unsupported_argument)$/);
  }
  assert.equal(executions, 0);
  assert.equal(registrations, 0);
  assert.equal(calls, 0);
});

test('MCP dispatches focused input and complete numeric coordinates', async () => {
  const calls = [];
  const dependencies = {
    targetExecution: new TargetExecution(),
    rawRunner: async (_command, args) => { calls.push(args); return { ok: true }; },
  };
  for (const coordinates of [{}, { tapX: 0, tapY: 25.5 }, { tapX: 0, tapY: 25 }]) {
    const result = await runBridgeChecked('input-text', {
      serial: 'input-wire', packageName: 'test.input.coordinates', text: '', feedback: 'off', ...coordinates,
    }, dependencies);
    assert.notEqual(result.isError, true);
  }
  assert.equal(calls.length, 3);
  assert.equal(Object.hasOwn(calls[0], 'tapX'), false);
  assert.equal(calls[0].text, '');
  assert.equal(calls[1].tapX, 0);
  assert.equal(calls[1].tapY, 25.5);
  assert.equal(calls[2].tapX, 0);
  assert.equal(calls[2].tapY, 25);
});

test('real MCP JSON-RPC rejects double null, blank and false coordinates without HTTP or ADB dispatch', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-input-wire-'));
  const adbLog = path.join(directory, 'adb-calls.jsonl');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, payload: body ? JSON.parse(body) : null });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/v1/status' ? nativeRuntimeStatus('test.input.coordinates') : nativeExecutionReceipt(JSON.parse(body))));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const adbPath = createAdbHttpFixture({ directory, serial: 'input-wire', port: server.address().port, logPath: adbLog });
  const client = createMcpClient({
    serverPath: path.resolve(__dirname, '../bin/mcp-server.js'),
    transcriptPath: path.join(directory, 'mcp.jsonl'), stderrPath: path.join(directory, 'stderr.log'),
    timeoutMs: 10_000,
    env: { AI_APP_BRIDGE_FACT_CACHE: 'off' },
  });
  t.after(async () => {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await client.initialize();
  const args = {
    adb: adbPath, serial: 'input-wire', packageName: 'test.input.coordinates',
    port: server.address().port, text: 'ASCII would otherwise allow ADB fallback', feedback: 'full',
  };
  for (const coordinates of invalidCoordinates) {
    const response = await client.request('tools/call', { name: 'run', arguments: {
      command: 'input-text', arguments: { ...args, ...coordinates },
    } });
    assert.equal(response.result.isError, true, JSON.stringify(coordinates));
    assert.match(payloadOf(response).error, /^(invalid_argument|unsupported_argument)$/);
  }
  assert.deepEqual(requests, [], 'no bridge request, including feedback reads, before rejection');
  assert.equal(fs.existsSync(adbLog), false, 'no ADB forwarding or fallback before rejection');
  const valid = await client.request('tools/call', { name: 'run', arguments: {
    command: 'input-text', arguments: { ...args, text: '', feedback: 'off', tapX: 0, tapY: 25.5 },
  } });
  assert.equal(payloadOf(valid).ok, true);
  assert.equal(requests.length, 2, 'positive control verifies the runtime then reaches the real HTTP action');
  assert.equal(requests.shift().path, '/v1/status');
  assert.equal(requests[0].path, '/v1/action/input-text');
  assert.equal(requests[0].payload.text, '');
  assert.equal(requests[0].payload.x, 0);
  assert.equal(requests[0].payload.y, 25.5);
});
