'use strict';

const test = require('node:test');
const { stopRuntime, killRuntime } = require('../test-support/runtime-control');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createIOSRuntimeFixture } = require('../test-support/ios-runtime-fixture');
const { executeCommand } = require('../test-support/host-client');
const { runExecution } = require('../bin/shared-kernel/execution-scope');
const { commandSchema } = require('../bin/command-registry');
const { lookupCompletion } = require('../bin/ios-execution');

const ownershipRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-ios-execution-ownership-'));
process.env.AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR = ownershipRoot;
test.after(() => fs.rmSync(ownershipRoot, { recursive: true, force: true }));

async function fixture(t, mode = 'complete') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-ios-execution-'));
  const runtimeEnv = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'runtime-facts') };
  t.after(async () => { await stopRuntime({ env: runtimeEnv }); fs.rmSync(directory, { recursive: true, force: true }); });
  const requests = [], actions = [];
  const resultPath = path.join(directory, 'completion.json');
  const effectPath = path.join(directory, 'effect.jsonl');
  let entered;
  const submitted = new Promise(resolve => { entered = resolve; });
  let originalResponse;
  const complete = (action, { cancelled = false, dispatched = true } = {}) => {
    const { timeoutMs, ...identity } = action.execution;
    const result = { ok: !cancelled, ...(cancelled ? { error: 'action_cancelled' } : {}),
      actionId: action.actionId, runtimeEpoch: identity.runtimeEpoch, settled: true, dispatched, ambiguous: false,
      execution: { ...identity, settled: true } };
    const bytes = JSON.stringify(result);
    const fd = fs.openSync(resultPath, 'w');
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return result;
  };
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    body = body ? JSON.parse(body) : null;
    const url = new URL(req.url, 'http://localhost');
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    const send = value => res.end(JSON.stringify({ ...value, runtimeBinding: device.binding }));
    if (url.pathname === '/v1/status') return send({ ok: true,
      debugBridge: { runtimeEpoch: device.binding.runtimeEpoch, h5ExecutionSchema: 'aab.h5-execution/v1', h5TargetSchema: 'aab.ios-h5-target/v1', flutterExecutionSchema: 'aab.flutter-execution/v1' },
      flutter: { layout: { operable: { runtimeEpoch: 'engine-1' } } } });
    if (['/v1/h5/action', '/v1/flutter/action'].includes(url.pathname)) {
      actions.push(body);
      originalResponse = res;
      if (mode !== 'queued') fs.appendFileSync(effectPath, JSON.stringify(body) + '\n');
      entered(body);
      if (mode === 'complete') send(complete(body));
      return;
    }
    if (url.pathname.endsWith('/cancel')) {
      const action = actions.find(action => action.actionId === body.actionId && action.execution.runtimeEpoch === body.runtimeEpoch);
      assert.ok(action, 'cancel must address the original action identity');
      if (mode === 'queued') {
        const result = complete(action, { cancelled: true, dispatched: false });
        originalResponse.end(JSON.stringify({ ...result, runtimeBinding: device.binding }));
        return send({ ok: true, ...body, executionResult: result });
      }
      return send({ ok: false, error: 'action_cancel_pending', schemaVersion: action.execution.schemaVersion,
        ...body, settled: false, dispatched: null, ambiguous: true });
    }
    if (url.pathname === '/v1/execution/status') return send({ ok: true, active: mode === 'pending' ? actions.at(-1)?.execution ?? null : null });
    if (url.pathname === '/v1/execution/result') {
      if (!fs.existsSync(resultPath)) return send({ ok: true, found: false, settled: false, hasMore: false, nextCursor: null, nextSequence: 0, throughSequence: 0 });
      const bytes = fs.readFileSync(resultPath);
      const result = JSON.parse(bytes);
      return send({ ok: true, found: true, actionId: result.actionId, runtimeEpoch: result.runtimeEpoch,
        executionResult: result, receipt: { committed: true, sequence: 1, sha256: createHash('sha256').update(bytes).digest('hex') } });
    }
    res.writeHead(404); send({ ok: false, error: 'not_found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const device = createIOSRuntimeFixture(directory, { deviceId: path.basename(directory), port: server.address().port });
  const h5Page = () => ({ schemaVersion: 'aab.ios-h5-target/v1', runtimeEpoch: device.binding.runtimeEpoch,
    bundleId: device.binding.bundleId, processId: device.binding.processId, webViewId: 'view-1', documentId: 'document-1', url: 'https://fixture.test/' });
  const run = (command, args = {}) => executeCommand(command, { ...device.args,
    ...(command === 'ios-h5-eval' ? { expectedPage: h5Page() } : {}), ...args });
  function cli(command, args = {}) {
    const flags = { ...device.args, ...(command === 'ios-h5-eval' ? { expectedPage: h5Page() } : {}), ...args };
    const argv = [path.resolve(__dirname, '../bin/ai-app-bridge.js'), command];
    for (const [name, value] of Object.entries(flags)) {
      if (value !== undefined) argv.push(`--${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    const child = spawn(process.execPath, argv, { env: { ...process.env, ...runtimeEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const exited = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    return { child, exited };
  }
  return { device, run, cli, runtimeEnv, submitted, actions, requests, effectPath, complete, setMode(value) { mode = value; },
    restartSDK() { device.binding.runtimeEpoch = 'sdk-2'; device.binding.processId = 84; device.update({ descriptor: { ...device.binding, ok: true } }); } };
}

test('iOS execution has a strict control schema and both SDK action kinds return their original completion', async t => {
  assert.deepEqual(commandSchema('ios-execution').properties.operation.enum, ['status', 'result', 'cancel', 'reconcile']);
  const h = await fixture(t);
  const h5 = await h.run('ios-h5-eval', { script: 'window.value = 1' });
  assert.equal(h5.ok, true, JSON.stringify(h5));
  assert.equal(h5.executionReceipt.kind, 'ios-h5');
  assert.equal(h5.executionReceipt.actionId, h.actions[0].actionId);
  assert.equal(h5.executionReceipt.runtimeEpoch, h.device.binding.runtimeEpoch);
  const flutter = await h.run('ios-flutter-action', { payload: { action: 'tapAt', x: 1, y: 2 } });
  assert.equal(flutter.ok, true, JSON.stringify(flutter));
  assert.equal(flutter.executionReceipt.kind, 'ios-flutter');
  assert.equal(flutter.executionReceipt.runtimeEpoch, 'engine-1', 'Flutter engine identity is distinct from the SDK HTTP process binding');
  const status = await h.run('ios-execution', { operation: 'status' });
  assert.equal(status.ownership.phase, 'idle');
});

test('queued cancellation releases ownership only with a matching settled response and never performs the effect', async t => {
  const h = await fixture(t, 'queued');
  const controller = new AbortController();
  const pending = runExecution({ signal: controller.signal }, () => h.run('ios-h5-eval', { script: 'effect()' }));
  await h.submitted;
  controller.abort({ code: 'cancelled' });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.settled, true, JSON.stringify(result));
  assert.equal(result.dispatched, false);
  assert.equal(result.ambiguous, false);
  assert.equal(result.executionReceipt.actionId, h.actions[0].actionId);
  assert.equal(fs.existsSync(h.effectPath), false);
  const status = await h.run('ios-execution', { operation: 'status' });
  assert.equal(status.ownership.phase, 'idle');
});

test('Host SIGKILL keeps the canonical iOS device blocked across Apps and a new process reconciles only the original durable completion', async t => {
  const h = await fixture(t, 'pending');
  const original = h.cli('ios-h5-eval', { script: 'originalEffect()' });
  const action = await h.submitted;
  await killRuntime({ env: h.runtimeEnv });
  const lost = await original.exited;
  assert.equal(lost.code, 1);
  assert.equal(JSON.parse(lost.stdout).value.error, 'runtime_connection_lost');
  assert.equal(JSON.parse(lost.stdout).value.dispatched, null);
  const udid = h.device.config.device.hardwareProperties.udid;
  for (const command of ['ios-launch-app', 'ios-tap', 'ios-input', 'ios-swipe', 'ios-install-app']) {
    const extra = { 'ios-tap': { tapX: 1, tapY: 1 }, 'ios-input': { text: 'x', elementId: 'editor' },
      'ios-swipe': { startX: 1, startY: 1, endX: 2, endY: 2 }, 'ios-install-app': { appPath: '/not-an-app' } }[command] || {};
    if (['ios-tap', 'ios-input', 'ios-swipe'].includes(command)) Object.assign(extra, {
      runtimeUrl: undefined, wdaRunnerBundleId: 'sample.runner.xctrunner', wdaSessionId: 'sample-session',
    });
    const denied = await h.cli(command, { ...extra, deviceId: udid, bundleId: 'another.app' }).exited;
    assert.equal(denied.code, 1, denied.stderr);
    assert.equal(JSON.parse(denied.stdout).value.error, 'device_ownership_unresolved', denied.stdout);
  }
  const absent = await h.cli('ios-execution', { operation: 'reconcile', deviceId: udid }).exited;
  assert.equal(JSON.parse(absent.stdout).value.error, 'device_ownership_unresolved');
  assert.equal(h.actions.length, 1);
  h.complete(action);
  h.restartSDK();
  const recovered = await h.cli('ios-execution', { operation: 'reconcile', deviceId: udid }).exited;
  assert.equal(recovered.code, 0, recovered.stdout || recovered.stderr);
  const result = JSON.parse(recovered.stdout).value;
  assert.equal(result.recovered, true);
  assert.equal(result.executionReceipt.actionId, action.actionId);
  assert.equal(result.executionReceipt.runtimeEpoch, 'epoch-1', 'new SDK identity cannot replace original execution epoch');
  const lookup = h.requests.filter(request => request.path === '/v1/execution/result').at(-1);
  assert.equal(lookup.query.actionId, action.actionId);
  assert.equal(lookup.query.runtimeEpoch, 'epoch-1');
  h.setMode('complete');
  const next = await h.cli('ios-h5-eval', { script: 'newEffect()', deviceId: udid }).exited;
  assert.equal(next.code, 0, next.stdout || next.stderr);
  assert.equal(h.actions.length, 2);
  assert.equal(fs.readFileSync(h.effectPath, 'utf8').trim().split('\n').length, 2, 'the original effect was not replayed');
});

test('completion pagination requires forward progress and the exact original identity', async () => {
  const identity = { actionId: 'original', runtimeEpoch: 'old' };
  let calls = 0;
  const stalled = await lookupCompletion({ get: async () => { calls++; return {
    ok: true, found: false, hasMore: true, nextSequence: 1, throughSequence: 3, nextCursor: 'fixed',
  }; } }, 'h5', identity);
  assert.equal(stalled.error, 'invalid_ios_completion_cursor');
  assert.equal(calls, 2);
  const wrong = await lookupCompletion({ get: async () => ({ ok: true, actionId: 'other', runtimeEpoch: 'old',
    executionResult: { ok: true } }) }, 'h5', identity);
  assert.equal(wrong.error, 'invalid_ios_completion_receipt');
});
