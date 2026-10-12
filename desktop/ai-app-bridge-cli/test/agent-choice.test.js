'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createDeviceMutationLease, runDeviceEffect } = require('../bin/shared-kernel/device-mutation-lease');
const { createScriptHostPort } = require('../bin/script/script-host-port');
const { createIntentBudget } = require('../bin/intent/intent-autonomous-adapter');
const { selectUiaNode } = require('../bin/shared-kernel/uia-target');
const { uiaXml } = require('../test-support/uia-target-fixture');

test('unknown prior effect stays recorded while a new explicit action can run', async () => {
  const lease = createDeviceMutationLease();
  await lease.run('agent-choice', () => runDeviceEffect({ kind: 'test', actionId: 'old' },
    async () => ({ ok: false, dispatched: null, ambiguous: true })));
  let calls = 0;
  const next = await lease.run('agent-choice', () => runDeviceEffect({ kind: 'test', actionId: 'new' },
    async () => { calls++; return { ok: true, dispatched: true }; }));
  assert.equal(next.ok, true);
  assert.equal(calls, 1);
  const warning = next.warnings.find(w => w.code === 'previous_execution_unknown');
  assert.equal(warning.blocking, false);
  const previous = JSON.parse(fs.readFileSync(warning.archivePath));
  assert.equal(previous.pending.actionId, 'old');
  assert.equal(previous.phase, 'unresolved');
  assert.equal(lease.status('agent-choice').phase, 'idle');
  assert.equal(lease.status('agent-choice').ownership.lastSettlement.proof.actionId, 'new');
});

test('Script defaults execute supported expert commands and respect caller restrictions', async () => {
  const calls = [];
  const options = { target: { platform: 'web', sessionId: 's', runtimeEpoch: 'r', targetId: 't' },
    actions: async (command, args) => { calls.push({ command, args }); return { ok: true, dispatched: true }; } };
  assert.equal((await createScriptHostPort(options).call('web-command', { name: 'action', arguments: { name: 'seed' } })).ok, true);
  const denied = await createScriptHostPort({ ...options, permissions: ['app.read'] }).call('web-command', { name: 'action' });
  assert.equal(denied.error, 'permission_not_granted');
  assert.match(denied.message, /explicit permissions/);
  assert.equal(calls.length, 1);
  assert.equal(createIntentBudget().check({ action: { action: 'scroll' } }).ok, true);
  assert.equal(createIntentBudget({ allowlist: ['tap'] }).check({ action: { action: 'scroll' } }).reason, 'action_not_allowed');
});

test('Agree button is distinct from prose, and duplicate labels return selectable candidates', () => {
  const button = (top, text) => `<node package="app.test" class="android.widget.Button" text="${text}" enabled="true" clickable="true" bounds="[0,${top}][100,${top + 30}]"/>`;
  const raw = uiaXml(`<hierarchy>${button(0, '请阅读并同意用户协议')}${button(100, '同意')}${button(200, '同意')}</hierarchy>`);
  const result = selectUiaNode(raw, { selector: { text: '同意' } }, 'app.test');
  assert.equal(result.dispatched, false);
  assert.equal(result.matched, 2);
  assert.equal(result.candidates.length, 2);
  const selected = selectUiaNode(raw, { selector: result.candidates[1].selector }, 'app.test');
  assert.equal(selected.ok, true);
  assert.equal(selected.node.bounds, '[0,200][100,230]');
});

test('force-stop includes archived unknown targets after a new action', async () => {
  const lease = createDeviceMutationLease();
  await lease.run('archive-stop', () => runDeviceEffect({ kind: 'native', actionId: 'old', target: { packageName: 'old.app' } }, async () => ({ ok: false, ambiguous: true })));
  await lease.run('archive-stop', async () => ({ ok: true }));
  let pending;
  const reset = await require('../bin/shared-kernel/device-force-stop').forceStopDevice({ serial: 'archive-stop' }, {
    directory: lease.directory, stopHost: async () => [], runtimeEndpoint: null,
    stopDevice: async (_serial, items) => { pending = items; return { ok: true }; },
  });
  assert.equal(reset.ok, true); assert.equal(reset.outcome, 'unknown');
  assert.equal(pending[0].target.packageName, 'old.app');
  assert.equal(reset.archivedOwnershipPaths.length, 1);
});

test('Web accepts and acknowledges an authentic late completion from archived ownership', async () => {
  const lease = createDeviceMutationLease();
  const target = { sessionId: 'late', runtimeEpoch: 'epoch', targetId: 'main' };
  const key = 'web:["late"]';
  await lease.run(key, () => runDeviceEffect({ kind: 'web-sdk', actionId: 'old', runtimeEpoch: 'epoch', target }, async () => ({ ok: false, ambiguous: true })));
  await lease.run(key, () => runDeviceEffect({ kind: 'web-sdk', actionId: 'new', runtimeEpoch: 'epoch', target }, async () => ({ ok: false, ambiguous: true })));
  const stored = [], sent = [];
  const { WebBridgeProvider } = require('../bin/web-provider');
  const provider = new WebBridgeProvider({ lease, store: { completion: () => ({ ok: false }), saveCompletion: (...args) => stored.push(args) } });
  provider.send = (_socket, message) => sent.push(message);
  const receipt = { ok: true, actionId: 'old', runtimeEpoch: 'epoch', settled: true, dispatched: true, ambiguous: false,
    execution: { schemaVersion: 'aab.web-execution/v1', actionId: 'old', runtimeEpoch: 'epoch', settled: true, target } };
  provider.acceptCompletion({ ...target, socket: { binding: {} } }, { result: receipt });
  assert.equal(stored.length, 1); assert.equal(sent[0].stored, true);
  assert.equal(lease.status(key).ownership.pending.actionId, 'new');
});

test('explicit Script target conflicts reject while defaults can be overridden', () => {
  const { bindCommandTarget } = require('../bin/shared-kernel/execution-target');
  const target = { platform: 'android', serial: 'A' };
  for (const command of ['adb-exec', 'uia-runtime']) {
    assert.throws(() => bindCommandTarget(command, { serial: 'B' }, null, target), { code: 'target_argument_conflict' });
    assert.equal(bindCommandTarget(command, { serial: 'B' }, target).args.serial, 'B');
  }
});
