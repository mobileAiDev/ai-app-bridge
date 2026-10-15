'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { runCli } = require('../test-support/cli-client');
const { createMcpClient, payloadOf } = require('../scripts/validation/mcp-jsonrpc-client');
const windows = { skip: process.platform !== 'win32', timeout: 60000 };

test('Windows never replaces an OS-locked owner when its recorded endpoint cannot answer', windows, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-windows-owner-'));
  const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb',
    AI_APP_BRIDGE_RUNTIME_HOME: path.join(directory, 'runtimes'), ADB: path.join(directory, 'missing-adb') };
  const cli = async (command, args) => (await runCli(command, args, { cwd: directory, env })).value;
  t.after(async () => { await cli('runtime', { operation: 'force-stop' }); fs.rmSync(directory, { recursive: true, force: true }); });
  const owner = await cli('runtime', { operation: 'start' });
  assert.equal(owner.status, 'running', JSON.stringify(owner));
  const metadata = path.join(env.AI_APP_BRIDGE_RUNTIME_HOME, fs.readdirSync(env.AI_APP_BRIDGE_RUNTIME_HOME)[0], 'endpoint.json');
  const endpoint = JSON.parse(fs.readFileSync(metadata));
  const server = require('node:http').createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  fs.writeFileSync(metadata, JSON.stringify({ ...endpoint, port: server.address().port }));
  try {
    const result = await cli('script', { operation: 'start', operationId: 'must-not-execute', script: {
      schemaVersion: 'aab.code-script/v1', language: 'javascript', source: 'module.exports.main=()=>42;' } });
    assert.equal(result.error, 'runtime_unresponsive', JSON.stringify(result));
    assert.equal(result.dispatched, false);
  } finally { fs.writeFileSync(metadata, JSON.stringify(endpoint)); }
  assert.equal((await cli('runtime', { operation: 'status' })).runtimeId, owner.runtimeId);
  assert.equal((await cli('script', { operation: 'status', operationId: 'must-not-execute' })).error, 'unknown_operation');
});

test('Windows explicit work leases survive CLI return, Script completion and MCP disconnect; Runtime stop releases them', windows, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab Windows 工作 '));
  const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb',
    AI_APP_BRIDGE_RUNTIME_HOME: path.join(directory, 'runtimes'), ADB: path.join(directory, 'not-installed-adb') };
  const cli = async (command, args) => (await runCli(command, args, { cwd: directory, env })).value;
  let mcp;
  t.after(async () => {
    if (mcp) await mcp.close({ stopRuntime: false });
    const stopped = await cli('runtime', { operation: 'stop' });
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const acquired = await cli('power', { operation: 'acquire', ownerId: 'whole-work', target: { platform: 'host' }, mode: 'both', leaseMs: 55000 });
  assert.equal(acquired.ok, true, JSON.stringify(acquired));
  assert.equal(acquired.state, 'active');
  assert.equal(acquired.coverage.mechanism, 'SetThreadExecutionState');
  const workerPid = acquired.coverage.pid;
  const native = require('@mobileaidev/segmented-fact-store-native');
  const workerStart = native.windowsProcessStart(workerPid);
  assert.ok(workerStart);
  const started = await cli('script', { operation: 'start', waitMs: 5000, script: {
    schemaVersion: 'aab.code-script/v1', language: 'javascript', source: 'module.exports.main=()=>({done:true});' } });
  assert.equal(started.status, 'completed', JSON.stringify(started));
  assert.equal((await cli('power', { operation: 'status', leaseId: acquired.leaseId })).state, 'active');
  mcp = createMcpClient({ serverPath: path.resolve(__dirname, '../bin/mcp-server.js'), env, cwd: directory,
    transcriptPath: path.join(directory, 'mcp.jsonl'), stderrPath: path.join(directory, 'mcp.log') });
  await mcp.initialize();
  const mcpLease = payloadOf(await mcp.request('tools/call', { name: 'run', arguments: {
    command: 'power', extract: null, arguments: { operation: 'status', leaseId: acquired.leaseId } } }));
  assert.equal(mcpLease.state, 'active');
  await mcp.close({ stopRuntime: false, stdinEof: true }); mcp = null;
  // No client or Script remains to renew this assertion; the persistent Runtime
  // must own the 15-second refresh, independently of the completed command.
  await delay(16000);
  const after = await cli('power', { operation: 'status', leaseId: acquired.leaseId });
  assert.equal(after.state, 'active', JSON.stringify(after));
  assert.ok(after.lastRefreshAtMs > acquired.lastRefreshAtMs);
  assert.equal(native.windowsProcessStart(workerPid), workerStart);
  const other = await cli('power', { operation: 'acquire', ownerId: 'other-work', target: { platform: 'host' }, mode: 'system', leaseMs: 10000 });
  assert.equal(other.state, 'active', JSON.stringify(other));
  const released = await cli('power', { operation: 'release', leaseId: acquired.leaseId });
  assert.equal(released.ok, true, JSON.stringify(released));
  assert.equal(native.windowsProcessStart(workerPid), null);
  assert.equal((await cli('power', { operation: 'status', leaseId: other.leaseId })).state, 'active');
  assert.equal((await cli('runtime', { operation: 'stop' })).status, 'stopped');
  assert.equal(native.windowsProcessStart(other.coverage.pid), null);
});
