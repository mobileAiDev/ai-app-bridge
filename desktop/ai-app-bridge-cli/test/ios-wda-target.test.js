'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateCommandArguments, commandSchema, isMutationCommand } = require('../bin/command-registry');
const { createWDAFixture: fixture } = require('../test-support/ios-wda-fixture');

const ownership = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-wda-ownership-'));
process.env.AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR = ownership;
test.after(() => fs.rmSync(ownership, { recursive: true, force: true }));

test('WDA schemas require explicit Runner identity and session, and reject the old implicit input routes', () => {
  for (const command of ['ios-wda-status', 'ios-wda-session', 'ios-uia-tree', 'ios-tap', 'ios-input', 'ios-swipe']) {
    assert.ok(commandSchema(command).required.includes('deviceId'));
    assert.ok(commandSchema(command).required.includes('wdaRunnerBundleId'));
  }
  const base = { deviceId: 'd', wdaRunnerBundleId: 'runner', bundleId: 'sample.app', wdaSessionId: 's', text: 'value' };
  for (const extra of [{}, { tapX: 1, tapY: 2 }, { elementId: 'e', accessibilityId: 'editor' }]) {
    assert.throws(() => validateCommandArguments('ios-input', { ...base, ...extra }));
  }
  validateCommandArguments('ios-input', { ...base, accessibilityId: 'editor', clearFirst: true });
  assert.equal(isMutationCommand('ios-wda-session', { operation: 'create' }), true);
  assert.equal(isMutationCommand('ios-wda-session', { operation: 'status' }), false);
});

test('an explicit WDA URL cannot bypass the selected Runner container, and old WDA gets no mutation', async t => {
  const h = await fixture(t);
  h.state.old = true;
  const result = await h.run('ios-tap', { bundleId: 'sample.app', wdaSessionId: 'session-1', tapX: 10, tapY: 20 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_ios_wda_binding');
  assert.equal(result.dispatched, false);
  assert.deepEqual(h.state.calls.map(c => c.method), ['GET']);
  const copied = h.device.calls().find(c => c.includes('--source'));
  assert.equal(copied[copied.indexOf('--source') + 1], 'Documents/ai_app_bridge_wda.json');
  assert.deepEqual(h.readEffects(), []);
});

test('tree reads never create a session; explicit create cannot replace one and close works after an App switch', async t => {
  const h = await fixture(t, { session: null });
  const absent = await h.run('ios-uia-tree', { bundleId: 'sample.app', wdaSessionId: 'missing' });
  assert.equal(absent.error, 'ios_wda_session_required');
  assert.ok(h.state.calls.every(c => c.method === 'GET'));
  const created = await h.run('ios-wda-session', { operation: 'create', bundleId: 'sample.app' });
  assert.equal(created.session.sessionId, 'created-session');
  const busy = await h.run('ios-wda-session', { operation: 'create', bundleId: 'sample.app' });
  assert.equal(busy.error, 'ios_wda_session_busy');
  assert.equal(h.readEffects().length, 1);
  h.state.foreground = { bundleId: 'other.app', processId: 600 };
  const closed = await h.run('ios-wda-session', { operation: 'close', bundleId: 'sample.app', wdaSessionId: 'created-session' });
  assert.equal(closed.ok, true);
  assert.equal(h.state.session, null);
});

test('App restart between Host observation and WDA dispatch rejects the action without a side effect', async t => {
  const h = await fixture(t);
  h.state.beforeWrite = () => { h.state.foreground.processId = 502; };
  const result = await h.run('ios-tap', { bundleId: 'sample.app', wdaSessionId: 'session-1', tapX: 10, tapY: 20 });
  assert.equal(result.error, 'ios_wda_target_changed');
  assert.equal(result.dispatched, false);
  assert.equal(result.ambiguous, false);
  assert.deepEqual(h.readEffects(), []);
});

test('tap, input and swipe use the bound session exactly once and preserve strict W3C failures even on HTTP 200', async t => {
  for (const [command, extra, count] of [
    ['ios-tap', { tapX: 10, tapY: 20 }, 1],
    ['ios-input', { accessibilityId: 'editor', text: '', clearFirst: true }, 1],
    ['ios-swipe', { startX: 10, startY: 20, endX: 10, endY: 100, durationMs: 50 }, 1],
  ]) await t.test(command, async t => {
    const h = await fixture(t);
    const args = { bundleId: 'sample.app', wdaSessionId: 'session-1', ...extra };
    const result = await h.run(command, args);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(h.readEffects().length, count);
    assert.ok(h.state.calls.every(c => c.route !== '/session'));
    h.state.error = 'invalid element state';
    const failure = await h.run(command, args);
    assert.equal(failure.ok, false);
    assert.equal(failure.error, 'ios_wda_command_failed');
    assert.equal(h.readEffects().length, count, 'an error never selects another route');
  });
});

test('an ambiguous accessibility ID never falls through to global keyboard input', async t => {
  const h = await fixture(t);
  h.state.matches = 2;
  const result = await h.run('ios-input', { bundleId: 'sample.app', wdaSessionId: 'session-1', accessibilityId: 'editor', text: 'wrong' });
  assert.equal(result.error, 'ios_wda_target_ambiguous');
  assert.equal(result.dispatched, false);
  assert.deepEqual(h.readEffects(), []);
  assert.ok(h.state.calls.every(c => !c.route.includes('/wda/keys')));
});

test('WDA response loss dispatches only once and retains unknown physical ownership', async t => {
  for (const [command, extra] of [
    ['ios-tap', { tapX: 10, tapY: 20 }], ['ios-input', { elementId: 'editor', text: 'value', clearFirst: true }],
    ['ios-swipe', { startX: 10, startY: 20, endX: 10, endY: 100 }],
  ]) await t.test(command, async t => {
    const h = await fixture(t);
    h.state.dropResponse = true;
    const result = await h.run(command, { bundleId: 'sample.app', wdaSessionId: 'session-1', ...extra });
    assert.equal(result.ok, false);
    assert.equal(result.dispatched, null);
    assert.equal(result.ambiguous, true);
    assert.equal(h.readEffects().length, 1);
    const blocked = await h.run('ios-tap', { bundleId: 'other.app', wdaSessionId: 'other', tapX: 1, tapY: 2 });
    assert.equal(blocked.error, 'device_ownership_unresolved');
    assert.equal(h.readEffects().length, 1);
  });
});
