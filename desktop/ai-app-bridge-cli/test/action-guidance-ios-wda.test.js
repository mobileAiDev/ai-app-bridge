'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const host = require('../bin/execution-host');
const { withActionGuidance } = require('../bin/shared-kernel/action-guidance');
const { validateCommandArguments, isMutationCommand } = require('../bin/command-registry');
const { normalizeCommandResult } = require('../bin/command-errors');

const connection = { deviceId: 'ios-guidance-device', wdaRunnerBundleId: 'sample.wda.xctrunner',
  wdaUrl: 'http://[fd00::1]:8100', devicectl: '/selected/Xcode/devicectl' };
const selected = { ...connection, bundleId: 'com.apple.springboard', wdaSessionId: 'observed-session' };
test.after(() => host.close());

async function reply(command, args, result) {
  const before = structuredClone(args);
  const dispatched = [];
  const { value } = await host.run({ command, arguments: args, extract: null }, {
    rawRunner: async (name, parameters) => { dispatched.push({ name, parameters }); return result; },
    factRecorder: null, observationCollector: null,
  });
  assert.equal(dispatched.length, 1, 'guidance must not dispatch diagnostics, recovery or replay');
  assert.equal(dispatched[0].name, command);
  assert.deepEqual(args, before, 'the requested App/session binding stays unchanged');
  assert.equal(value.execution.error, normalizeCommandResult(result, command).error);
  assert.equal(value.execution.dispatched, result.dispatched);
  assert.equal(value.execution.ambiguous, result.ambiguous);
  const guidance = value.control.guidance;
  assert.ok(guidance?.nextActions?.length, 'the public error envelope must include recovery guidance');
  assert.deepEqual(guidance, value.value.guidance);
  for (const hint of guidance.nextActions) {
    validateCommandArguments(hint.command, hint.arguments);
    assert.equal(isMutationCommand(hint.command, hint.arguments), false, 'only read-only next actions');
    assert.equal(hint.arguments.deviceId, connection.deviceId);
    assert.equal(hint.arguments.wdaRunnerBundleId, connection.wdaRunnerBundleId);
    assert.equal(hint.arguments.wdaUrl, connection.wdaUrl, 'do not replace an explicit forwarded URL');
    assert.equal(hint.arguments.devicectl, connection.devicectl);
    assert.ok(!['start', 'create', 'close', 'cancel', 'reconcile'].includes(hint.arguments.operation));
    assert.notEqual(hint.command, 'ios-setup');
    assert.notEqual(hint.command, 'ios-wda-start');
  }
  return value;
}

test('captured ios-wda-session connection failure gets target-bound guidance through the public Host', async () => {
  // Real 105/109 device failure shape; only the device and network address are anonymized.
  const failure = { ok: false, error: 'ios_wda_session_failed', command: 'ios-wda-session',
    message: 'connect ECONNREFUSED fd00::1:8100', details: 'connect ECONNREFUSED fd00::1:8100',
    dispatched: false, ambiguous: false };
  const result = await reply('ios-wda-session', { ...connection, operation: 'status' }, failure);
  assert.deepEqual(result.control.guidance.nextActions.map(h => [h.command, h.arguments.operation]), [
    ['doctor', undefined], ['ios-wda-session', 'status'],
  ]);
  assert.match(result.control.guidance.message, /ready/);
  assert.match(result.control.guidance.message, /start.*running/i);
  assert.equal(result.value.details, failure.details);
});

test('changed App/session offers status without inheriting forbidden status arguments or creating a session', async () => {
  const failure = { ok: false, error: 'ios_wda_session_changed',
    message: 'The requested App/session does not match the bound WDA session.', dispatched: false, ambiguous: false };
  const result = await reply('ios-tap-native', { ...selected, selector: { label: 'Allow', type: 'Button' } }, failure);
  const status = result.control.guidance.nextActions.find(h => h.command === 'ios-wda-session');
  assert.deepEqual(status.arguments, { ...connection, operation: 'status' });
  assert.match(result.control.guidance.message, /foreground/);
  assert.match(result.control.guidance.message, /session/);
  assert.equal(result.value.message, failure.message);
});

test('raw and provider-normalized WDA connection failures retain their error and do not replay', async () => {
  for (const error of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ios_tap_native_failed', 'ios_command_timeout']) {
    const failure = { ok: false, error, message: 'connect ECONNREFUSED fd00::1:8100',
      dispatched: false, ambiguous: false };
    await reply('ios-tap-native', { ...selected, selector: { label: 'Allow', type: 'Button' } }, failure);
  }
});

test('an unknown WDA action queries the original action and epoch before session recovery', async () => {
  const identity = { actionId: 'original-script:action-4', runtimeEpoch: 'original-wda-epoch' };
  const failure = { ok: false, error: 'ECONNRESET', ...identity, dispatched: null, ambiguous: true, settled: false,
    request: { execution: { schemaVersion: 'aab.wda-execution/v1', ...identity },
      target: { bundleId: selected.bundleId, sessionId: selected.wdaSessionId, processId: 73 } },
    cancellation: { ok: false, error: 'ECONNREFUSED' }, executionReceipt: null };
  const result = await reply('ios-tap-native', { ...selected, selector: { label: 'Allow', type: 'Button' } }, failure);
  assert.deepEqual(result.control.guidance.nextActions[0], { command: 'ios-execution',
    arguments: { ...connection, operation: 'result', kind: 'wda', ...identity }, extract: null });
  assert.equal(result.value.actionId, identity.actionId);
  assert.equal(result.value.runtimeEpoch, identity.runtimeEpoch);
  assert.deepEqual(result.value.request, failure.request);
  assert.equal(result.value.executionReceipt, null);
  assert.equal(result.value.settled, false);
  assert.match(result.control.guidance.message, /unknown/);
  assert.match(result.control.guidance.message, /original/);
  assert.match(result.control.guidance.message, /before.*session/);
});

test('unknown without an original action identity offers ownership status and invents no identity', async () => {
  const result = await reply('ios-wda-session', { ...connection, operation: 'create', bundleId: selected.bundleId },
    { ok: false, error: 'ios_wda_session_failed', dispatched: null, ambiguous: true });
  assert.deepEqual(result.control.guidance.nextActions[0], { command: 'ios-execution',
    arguments: { ...connection, operation: 'status', kind: 'wda' }, extract: null });
  assert.equal(result.control.guidance.nextActions.some(h => h.arguments.operation === 'result'), false);
});

test('WDA hints neither cross providers nor invent a missing Runner binding', () => {
  const failure = { ok: false, error: 'ECONNREFUSED', dispatched: false, ambiguous: false };
  assert.equal(withActionGuidance('ios-h5-dom', { deviceId: connection.deviceId, bundleId: 'sample.app' }, failure), failure);
  assert.equal(withActionGuidance('ios-tap-native', selected, { ok: true }).guidance, undefined);
  const result = withActionGuidance('ios-wda-session', { deviceId: connection.deviceId, operation: 'status' },
    { ...failure, error: 'ios_wda_session_failed' });
  for (const hint of result.guidance?.nextActions || []) {
    validateCommandArguments(hint.command, hint.arguments);
    assert.equal(hint.arguments.wdaRunnerBundleId, undefined);
    assert.notEqual(hint.command, 'ios-wda-session');
  }
});
