'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withActionGuidance } = require('../bin/shared-kernel/action-guidance');
const { validateCommandArguments } = require('../bin/command-registry');
const { createScriptHostPort } = require('../bin/script/script-host-port');

// The typed Flutter result captured after SIGKILL uses flutter-operable-tree,
// not flutter-runtime-action. Its Dart epoch differs from the Native endpoint.
function lost(kind) {
  const identity = { actionId: 'script-fault:action-5', runtimeEpoch: '1791861843361153-57289557' };
  return { ok: false, error: 'command_failed', source: kind === 'flutter' ? 'flutter-operable-tree' : 'bridge-h5',
    ...identity, request: { action: kind === 'flutter' ? 'tapTarget' : 'click', actionId: identity.actionId,
      execution: { schemaVersion: `aab.${kind}-execution/v1`, ...identity, timeoutMs: 10000 } },
    dispatched: null, ambiguous: true, settled: false, cancellation: { ok: false, error: 'ECONNRESET' } };
}

for (const [kind, command, args, observe] of [
  ['flutter', 'tap-flutter-text', { targetText: '执行原始动作' }, 'flutter-nodes'],
  ['h5', 'h5-click', { selector: { text: 'Pay', tag: 'button' }, webViewId: 'checkout' }, 'h5-dom'],
]) {
  test(`${kind} lost execution retains the original outcome and provides valid recovery choices`, () => {
    const value = lost(kind);
    const result = withActionGuidance(command, { serial: 'emulator-fixture', packageName: 'sample.app', ...args }, value);
    assert.deepEqual(result.guidance?.nextActions.map(action => [action.command, action.arguments.operation]), [
      ['device-ownership', 'status'], ['device-ownership', 'archives'], [observe, undefined],
      ['launch-app', undefined], ['device-ownership', 'force-stop'],
    ]);
    assert.deepEqual(result.guidance.nextActions[1].arguments, {
      serial: 'emulator-fixture', operation: 'archives', actionId: value.actionId,
    });
    assert.equal(result.guidance.nextActions[2].arguments.packageName, 'sample.app');
    if (kind === 'h5') assert.equal(result.guidance.nextActions[2].arguments.webViewId, 'checkout');
    for (const hint of result.guidance.nextActions) validateCommandArguments(hint.command, hint.arguments);
    const { guidance, ...unchanged } = result;
    assert.deepEqual(unchanged, value);
    assert.match(guidance.message, /unknown/);
    assert.match(guidance.message, /do not replay/);
    assert.match(guidance.message, /related Host tasks/);
  });
}

test('Script exposes managed recovery choices with the same unknown record and one dispatch', async () => {
  let calls = 0;
  const host = createScriptHostPort({ executionId: 'script-fault',
    target: { platform: 'android', serial: 'managed-guidance-script', packageName: 'sample.app' },
    actions: async (command, args) => {
      calls++;
      return withActionGuidance(command, args, lost('flutter'));
    },
  });
  const reply = await host.call('tap-flutter-text', { targetText: '执行原始动作' });
  assert(reply.guidance);
  assert.deepEqual(reply.guidance, reply.result.guidance);
  assert.equal(reply.error, 'command_failed');
  assert.equal(reply.ambiguous, true);
  assert.equal(reply.dispatched, null);
  assert.equal(reply.result.actionId, 'script-fault:action-5');
  assert.equal(calls, 1);
});

test('known completion and unrelated transport errors do not get unknown SDK recovery', () => {
  for (const value of [
    { ...lost('flutter'), settled: true, ambiguous: false, dispatched: true },
    { ok: false, error: 'command_failed', source: 'flutter-operable-tree', dispatched: false, ambiguous: false },
  ]) {
    assert.deepEqual(withActionGuidance('tap-flutter-text', {
      serial: 'emulator-fixture', packageName: 'sample.app', targetText: 'Save',
    }, value), value);
  }
});
