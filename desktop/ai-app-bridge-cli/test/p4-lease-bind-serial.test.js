'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDeviceMutationLease } = require('../bin/shared-kernel/device-mutation-lease');
const { createScriptHostPort } = require('../bin/script/script-host-port');

function completePage(stream) {
  return {
    ok: true,
    coverage: { status: 'complete', gap: false, committed: true },
    refs: [{ mobileFactId: `mf1:1:1:${stream}`, stream, captureId: 1 }],
    items: [{ id: 1, stream }],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('P4 mutation lease follows the dispatched serial, not options.serial', async () => {
  const lease = createDeviceMutationLease();
  const gate = deferred();
  let starts = 0;
  const first = createScriptHostPort({
    mutationLease: lease,
    target: { platform: 'android', serial: 'phone-1', packageName: 'pkg' },
    actions: async () => {
      starts += 1;
      await gate.promise;
      return { ok: true };
    },
    runner: async () => completePage('logs'),
  });
  const second = createScriptHostPort({
    mutationLease: lease,
    target: { platform: 'android', serial: 'phone-1', packageName: 'pkg' },
    actions: async () => ({ ok: true }),
    runner: async () => completePage('logs'),
  });
  const pending = first.call('tap', { text: 'A' }, { serial: 'decoy-1' });
  await nextTurn();
  const busy = await second.call('tap', { text: 'B' }, { serial: 'decoy-2' });
  assert.equal(busy.error, 'target_busy');
  assert.equal(starts, 1);
  gate.resolve();
  assert.equal((await pending).ok, true);
});

test('P4 Host actionId is unique per execution so target idempotency cannot reuse another script tap', async () => {
  const { TargetExecution } = require('../bin/target-execution');
  const execution = new TargetExecution();
  let providerRuns = 0;
  const actions = (command, args) => execution.execute(command, args, async () => {
    providerRuns += 1;
    return { ok: true, providerRun: providerRuns };
  });
  const target = { platform: 'android', serial: 'same', packageName: 'pkg' };
  const first = createScriptHostPort({ executionId: 'script-A', target, actions });
  const second = createScriptHostPort({ executionId: 'script-B', target, actions });
  const a = await first.call('tap', {});
  const b = await second.call('tap', {});
  assert.equal(providerRuns, 2);
  assert.notEqual(a.execution.actionId, b.execution.actionId);
});

test('P4 mutation requestId is the Host actionId, not a caller requestId', async () => {
  let seen = null;
  const host = createScriptHostPort({
    executionId: 'script-force',
    target: { platform: 'android', serial: 'phone-1', packageName: 'pkg' },
    actions: async (_command, args) => {
      seen = args;
      return { ok: true };
    },
    runner: async () => completePage('logs'),
  });
  const tap = await host.call('tap', { text: 'Go', requestId: 'caller-r1' }, { requestId: 'option-r2' });
  assert.equal(tap.execution.actionId, 'script-force:action-1');
  assert.equal(seen.requestId, 'script-force:action-1');
});
