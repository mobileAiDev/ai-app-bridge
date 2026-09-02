'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const { runBatch, runBridgeChecked } = require('../bin/mcp-server');
const snapshot = require('./fixtures/legacy-surface-g0.json');

const MCP_SERVER = path.join(__dirname, '..', 'bin', 'mcp-server.js');
const FORBIDDEN_COMMANDS = [
  'script',
  'intent',
  'page-summary',
  'page_summary',
  'execution',
  'configureObservation',
  'configure-observation',
];

function payloadOf(result) {
  return JSON.parse(result.content[0].text);
}

function sourceSnapshot() {
  const source = fs.readFileSync(MCP_SERVER, 'utf8');
  const start = source.indexOf('const commandDefinitions = [');
  const end = source.indexOf('const commandByName =');
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = source.slice(start, end);
  const commands = [...block.matchAll(/command:\s*'([^']+)'/g)].map((match) => match[1]);
  const compactStart = source.indexOf('function compactToolDefinitions()');
  const compactEnd = source.indexOf('function fullToolDefinitions()');
  const compactBlock = source.slice(compactStart, compactEnd);
  const compactTools = [...compactBlock.matchAll(/bridgeTool\('([^']+)'/g)].map((match) => match[1]);
  const fullStart = source.indexOf('function fullToolDefinitions()');
  const fullEnd = source.indexOf('function bridgeTool(');
  const fullBlock = source.slice(fullStart, fullEnd);
  const fullTools = [
    ...fullBlock.matchAll(/bridgeTool\('([^']+)'/g),
    ...fullBlock.matchAll(/name:\s*'([^']+)'/g),
  ].map((match) => match[1]);
  return { commands, compactTools, fullTools };
}

test('G0 freezes legacy command names, compact tools, and full tools', () => {
  const live = sourceSnapshot();
  assert.deepEqual(live.commands, snapshot.commands);
  assert.deepEqual(live.compactTools, snapshot.compactTools);
  assert.deepEqual(live.fullTools, snapshot.fullTools);
  for (const name of FORBIDDEN_COMMANDS) {
    assert.equal(live.commands.includes(name), false, name);
    assert.equal(live.compactTools.includes(name), false, name);
    assert.equal(live.fullTools.includes(name.replace(/-/g, '_')), false, name);
  }
});

test('G0 compact MCP tools/list exposes only capabilities and run', async () => {
  const listed = await listCompactTools();
  assert.deepEqual(listed.map((tool) => tool.name), ['capabilities', 'run']);
});

test('G0 target-app commands still require packageName or port', async () => {
  const result = await runBridgeChecked('status', { serial: 'android-1' }, {
    rawRunner: async () => {
      throw new Error('status must not reach the runner without packageName or port');
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /status: packageName or explicit port is required in MCP mode/);
});

test('G0 batch rejects unknown, nested, and non-serial steps with current error codes', async () => {
  const unknown = payloadOf(await runBatch({
    steps: [{ id: 's1', command: 'script' }],
  }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'unknown_batch_step_command');
  assert.equal(unknown.command, 'script');

  const nested = payloadOf(await runBatch({
    steps: [{ id: 's1', command: 'batch' }],
  }));
  assert.equal(nested.ok, false);
  assert.equal(nested.error, 'nested_batch_not_supported');

  const mode = payloadOf(await runBatch({
    mode: 'parallel',
    steps: [{ id: 's1', command: 'status' }],
  }));
  assert.equal(mode.ok, false);
  assert.equal(mode.error, 'batch_mode_not_supported');
});

test('G0 batch stays serial, stops on error, and skips the remainder', async () => {
  const calls = [];
  const result = payloadOf(await runBatch({
    stopOnError: true,
    defaults: { serial: 'android-1', packageName: 'com.example.app' },
    steps: [
      { id: 'one', command: 'status' },
      { id: 'two', command: 'tree' },
      { id: 'three', command: 'screenshot' },
    ],
  }, async (command) => {
    calls.push(command);
    if (command === 'tree') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'forced_failure' }) }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, command }) }],
    };
  }));

  assert.equal(result.ok, false);
  assert.equal(result.mode, 'serial');
  assert.equal(result.stopOnError, true);
  assert.deepEqual(calls, ['status', 'tree']);
  assert.deepEqual(result.steps.map((step) => step.status), ['passed', 'failed', 'skipped']);
  assert.equal(result.steps[2].reason, 'stopOnError');
});

test('G0 batch accepts hyphen and underscore aliases for the same legacy command', async () => {
  const calls = [];
  const result = payloadOf(await runBatch({
    steps: [
      { id: 'hyphen', command: 'tap-text', packageName: 'com.example.app' },
      { id: 'underscore', command: 'tap_text', packageName: 'com.example.app' },
    ],
  }, async (command, args) => {
    calls.push({ command, packageName: args.packageName });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((item) => item.command), ['tap-text', 'tap-text']);
});

async function listCompactTools() {
  const child = spawn(process.execPath, [MCP_SERVER], {
    env: { ...process.env, AI_APP_BRIDGE_MCP_SURFACE: 'compact' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames = [];
  let buffer = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const text = buffer.toString('utf8');
      const match = /^Content-Length:\s*(\d+)\r\n\r\n/i.exec(text);
      if (!match) break;
      const headerSize = match[0].length;
      const length = Number(match[1]);
      if (buffer.length < headerSize + length) break;
      frames.push(JSON.parse(buffer.subarray(headerSize, headerSize + length).toString('utf8')));
      buffer = buffer.subarray(headerSize + length);
    }
  });
  const send = (message) => {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  };
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'g0-surface', version: '0' },
    },
  });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listed = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('tools/list timeout')), 4000);
    const check = () => {
      const frame = frames.find((item) => item.id === 2);
      if (!frame) return;
      clearTimeout(timer);
      resolve(frame.result.tools);
    };
    child.stdout.on('data', check);
    child.on('error', reject);
  });
  child.kill('SIGTERM');
  return listed;
}
