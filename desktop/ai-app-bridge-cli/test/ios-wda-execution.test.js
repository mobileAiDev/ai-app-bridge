'use strict';

const test = require('node:test');
const { stopRuntime, killRuntime } = require('../test-support/runtime-control');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createWDAFixture } = require('../test-support/ios-wda-fixture');
const { runExecution } = require('../bin/shared-kernel/execution-scope');
const { validateCommandArguments } = require('../bin/command-registry');

const ownership = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-wda-execution-ownership-'));
process.env.AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR = ownership;
test.after(() => fs.rmSync(ownership, { recursive: true, force: true }));
const input = { bundleId: 'sample.app', wdaSessionId: 'session-1', elementId: 'editor', clearFirst: true, text: 'once' };

test('ios-execution uses a strict WDA branch without inventing another public control command', () => {
  const base = { operation: 'status', kind: 'wda', deviceId: 'd', wdaRunnerBundleId: 'runner' };
  validateCommandArguments('ios-execution', base);
  for (const extra of [{ bundleId: 'app' }, { runtimeUrl: 'http://localhost' }, { iosHost: 'localhost' }, { actionId: 'unsolicited' }])
    assert.throws(() => validateCommandArguments('ios-execution', { ...base, ...extra }));
  assert.throws(() => validateCommandArguments('ios-execution', { ...base, operation: 'result' }));
  validateCommandArguments('ios-execution', { ...base, operation: 'result', actionId: 'original', runtimeEpoch: 'old' });
  validateCommandArguments('ios-execution', { operation: 'status', deviceId: 'd', bundleId: 'app' });
});

test('queued WDA input cancellation obtains the original completion and leaves no effect', async t => {
  const h = await createWDAFixture(t, { mode: 'queued' });
  const controller = new AbortController();
  const pending = runExecution({ signal: controller.signal }, () => h.run('ios-input', input));
  const action = await h.submitted;
  controller.abort({ code: 'cancelled' });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.settled, true, JSON.stringify(result));
  assert.equal(result.dispatched, false);
  assert.equal(result.executionReceipt.actionId, action.actionId);
  assert.deepEqual(result.executionReceipt.execution.target, { bundleId: 'sample.app', processId: 501,
    sessionId: 'session-1', operation: 'input', runnerBundleId: h.args.wdaRunnerBundleId });
  assert.deepEqual(h.readEffects(), []);
  const status = await h.run('ios-execution', { operation: 'status', kind: 'wda' });
  assert.equal(status.ownership.phase, 'idle');
});

test('WDA Host SIGKILL blocks other Apps and a new process requires the original target and durable completion', async t => {
  const h = await createWDAFixture(t, { mode: 'pending' });
  const original = h.cli('ios-input', input);
  const action = await h.submitted;
  await killRuntime({ env: h.runtimeEnv });
  const lost = await original.exited;
  assert.equal(lost.code, 1);
  assert.equal(JSON.parse(lost.stdout).value.error, 'runtime_connection_lost');
  assert.equal(JSON.parse(lost.stdout).value.dispatched, null);
  const udid = h.device.config.device.hardwareProperties.udid;
  const denied = await h.cli('ios-tap', { deviceId: udid, bundleId: 'other.app', wdaSessionId: 'other', tapX: 1, tapY: 2 }).exited;
  assert.equal(JSON.parse(denied.stdout).value.error, 'device_ownership_unresolved');
  const args = { operation: 'reconcile', kind: 'wda', deviceId: udid };
  const missing = await h.cli('ios-execution', args).exited;
  assert.equal(JSON.parse(missing.stdout).value.error, 'device_ownership_unresolved');
  h.complete(action, { wrongTarget: true });
  h.restart();
  const wrong = await h.cli('ios-execution', args).exited;
  assert.equal(JSON.parse(wrong.stdout).value.error, 'device_ownership_unresolved');
  h.complete(action);
  h.state.receiptMissing = true;
  const uncommitted = await h.cli('ios-execution', args).exited;
  assert.equal(JSON.parse(uncommitted.stdout).value.error, 'device_ownership_unresolved');
  h.state.receiptMissing = false;
  const recovered = await h.cli('ios-execution', args).exited;
  assert.equal(recovered.code, 0, recovered.stdout || recovered.stderr);
  const result = JSON.parse(recovered.stdout).value;
  assert.equal(result.recovered, true);
  assert.equal(result.executionReceipt.actionId, action.actionId);
  assert.equal(result.executionReceipt.runtimeEpoch, 'epoch-1');
  assert.equal(h.readEffects().length, 1, 'recovery cannot replay the original input');
  h.state.mode = 'complete';
  const next = await h.cli('ios-tap', { deviceId: udid, bundleId: 'sample.app', wdaSessionId: 'session-1', tapX: 1, tapY: 2 }).exited;
  assert.equal(next.code, 0, next.stdout || next.stderr);
  assert.equal(h.readEffects().length, 2);
});

test('a lost WDA response can settle from its already committed original callback without replay', async t => {
  const h = await createWDAFixture(t);
  h.state.dropResponse = true; h.state.completeBeforeDrop = true;
  const result = await h.run('ios-input', input);
  assert.equal(result.ok, false);
  assert.equal(result.settled, true, JSON.stringify(result));
  assert.equal(result.dispatched, true);
  assert.equal(result.ambiguous, false);
  assert.equal(result.executionReceipt.actionId, h.state.actions[0].actionId);
  assert.equal(h.readEffects().length, 1);
  const status = await h.run('ios-execution', { operation: 'status', kind: 'wda' });
  assert.equal(status.ownership.phase, 'idle');
});
