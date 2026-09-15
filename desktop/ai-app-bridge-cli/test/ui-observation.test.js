const assert = require('node:assert/strict');
const test = require('node:test');
const { validateCommandArguments, commandContract } = require('../bin/command-registry');
const { commandInputSchema } = require('../bin/command-discovery');
const { runWithFeedbackProbe } = require('../bin/feedback-probe');
const { IOSBridgeProvider } = require('../bin/ios-provider');

test('iOS observation posts to its control endpoint without invoking a Flutter action', async () => {
  const provider = new IOSBridgeProvider();
  const calls = [];
  provider.runtimePort = async () => ({ endpoint: { baseUrl: 'http://bound-runtime', device: { udid: 'phone' }, runtimeBinding: {} },
    post: async (path, body) => { calls.push([path, body]); return { ok: true, active: true, leaseId: 'owner' }; } });
  provider.runtimeRequest = async () => { throw new Error('Must not enter action execution'); };
  const reply = await provider.dispatch('ios-ui-observation', { operation: 'start', provider: 'flutter', durationMs: 1000 });
  assert.equal(reply.leaseId, 'owner');
  assert.deepEqual(calls, [['/v1/flutter/observation', { operation: 'start', durationMs: 1000 }]]);
});

for (const [command, target] of [
  ['ui-observation', { packageName: 'sample.app', serial: 'phone' }],
  ['ios-ui-observation', { deviceId: 'phone', bundleId: 'sample.app' }],
  ['web-ui-observation', { sessionId: 'page', runtimeEpoch: 'epoch' }],
]) test(`${command} exposes bounded observation to Script and rejects unowned stops`, () => {
  assert.equal(commandContract(command).script.permission, 'capture.read');
  for (const request of [{ operation: 'start', durationMs: 1000 }, { operation: 'status' }, { operation: 'stop', leaseId: 'owner' }])
    assert.doesNotThrow(() => validateCommandArguments(command, { ...target, ...request }));
  for (const request of [{ operation: 'start' }, { operation: 'start', durationMs: 0 },
    { operation: 'start', durationMs: 5001 }, { operation: 'stop' }, { operation: 'status', durationMs: 1000 }])
    assert.throws(() => validateCommandArguments(command, { ...target, ...request }));
  assert.equal(commandInputSchema(command, { operation: 'start' }).properties.operation.const, 'start');
});

test('full feedback establishes a baseline before mutation and releases even on failure', async () => {
  const calls = [];
  await assert.rejects(() => runWithFeedbackProbe({ command: 'tap', args: { feedback: 'full', serial: 'phone', packageName: 'sample.app' },
    runner: async (command, args) => {
      calls.push([command, args.operation]);
      if (command === 'ui-observation') return { ok: true, active: args.operation === 'start', leaseId: 'owned' };
      if (command === 'events') return { items: [] };
      throw new Error('action failure');
    } }), /action failure/);
  assert.deepEqual(calls, [['ui-observation', 'start'], ['events', undefined], ['tap', undefined], ['ui-observation', 'stop']]);
});

test('unsupported observation fails before executing an action with full feedback', async () => {
  const calls = [];
  const output = await runWithFeedbackProbe({ command: 'tap', args: { feedback: 'full' },
    runner: async command => { calls.push(command); return { ok: false, error: 'not_found' }; } });
  assert.deepEqual(calls, ['ui-observation']);
  assert.equal(output.result.dispatched, false);
  assert.equal(output.result.error, 'ui_observation_unavailable');
});
