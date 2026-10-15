'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { createPowerManager } = require('../bin/power');
const { createActivityLeases } = require('../bin/power/activity-lease');
const { createWorkPower } = require('../bin/power/work-activity');
const { createPlatformAdapter } = require('../bin/power/platform-adapters');
const { IOSBridgeProvider } = require('../bin/ios-provider');
const flush = () => new Promise(resolve => setImmediate(resolve));
const target = { platform: 'ios', deviceId: 'activity-phone', bundleId: 'activity.sample' };

// Real work/manager/adapter/provider behavior, with a controlled clock and SDK
// boundary. Device discovery, HTTP and Host assertions never touch a device.
function fixture(t) {
  let time = 0, timerId = 0, descriptorReads = 0, nextRenew, releaseRenew, acquireError, renewError;
  let binding = { schemaVersion: 'aab.ios-runtime/v1', bundleId: target.bundleId,
    runtimeEpoch: 'epoch-1', processId: 100, port: 49100 };
  const timers = new Map(), remote = new Set(), calls = [];
  const provider = new IOSBridgeProvider({ httpRequest: async (_method, url, body, options) => {
    calls.push({ ...body, time, port: Number(new URL(url).port), epoch: options.headers['X-AAB-Runtime-Epoch'] });
    if (Number(new URL(url).port) !== binding.port)
      throw Object.assign(new Error('The explicit port is closed'), { code: 'ECONNREFUSED' });
    assert.equal(options.headers['X-AAB-Runtime-Epoch'], binding.runtimeEpoch);
    if (body.operation === 'renew' && nextRenew) { const pending = nextRenew; nextRenew = null; await pending; }
    const result = { ok: true, runtimeBinding: binding, coverage: { display: true, scope: 'selected-sdk-app-foreground' } };
    if (body.operation === 'acquire') {
      if (acquireError) { const error = acquireError; acquireError = null; return { ...result, ok: false, error, message: 'Acquisition rejected' }; }
      remote.add(body.leaseId);
    }
    if (body.operation === 'renew') {
      if (renewError) { const code = renewError; renewError = null; throw Object.assign(new Error('Transport unavailable'), { code }); }
      if (!remote.has(body.leaseId)) return { ...result, ok: false, error: 'power_lease_ended', message: 'The SDK lease ended' };
    }
    if (body.operation === 'release') { remote.delete(body.leaseId); result.released = true; }
    return result;
  } });
  provider.requireDevice = async () => ({ identifier: target.deviceId, udid: target.deviceId,
    developerModeStatus: 'enabled', ddiServicesAvailable: true, tunnelState: 'connected', tunnelIPAddress: '127.0.0.1' });
  provider.readRuntimePortFile = async () => { descriptorReads++; return binding; };
  const adapter = createPlatformAdapter({ iosRequest: async (selected, body) => (await provider.runtimePort(selected)).post('/v1/power', body) });
  const manager = createPowerManager({ now: () => time, wallNow: () => 100000 + time,
    schedule: (callback, delay) => { const id = ++timerId; timers.set(id, { at: time + delay, callback }); return id; },
    unschedule: id => timers.delete(id),
    acquireAdapter: options => options.target.platform === 'host'
      ? Promise.resolve({ coverage: {}, renew: async () => ({ coverage: {} }), release: async () => ({ released: true }) })
      : adapter(options) });
  const work = createWorkPower({ manager, enabled: true, now: () => time });
  t.after(async () => { await work.close(); await manager.close(); });
  return { manager, work, calls, remote,
    get descriptorReads() { return descriptorReads; },
    restart() { binding = { ...binding, runtimeEpoch: 'epoch-2', processId: 101, port: 49101 }; remote.clear(); },
    async advance(ms, fireTimers = true) {
      time += ms;
      if (fireTimers) for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.callback(); }
      await flush();
    },
    holdNextRenew() { nextRenew = new Promise(resolve => { releaseRenew = resolve; }); },
    releaseRenew() { releaseRenew(); },
    failNextAcquire(code) { acquireError = code; },
    failNextRenew(code) { renewError = code; },
    touch: () => work.beforeCommand('ios-status', target),
  };
}

test('work racing an ended-assertion refresh reuses its recovered lease without cooldown or per-action discovery', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.touch(), []);
  const original = [...f.remote][0];
  f.restart(); f.holdNextRenew(); await f.advance(15000);
  const touch = f.touch(); await flush();
  f.releaseRenew(); assert.deepEqual(await touch, []);
  assert.equal(f.remote.size, 1); assert.equal(f.remote.has(original), true);
  const recovered = f.manager.status({ leaseId: original });
  assert.equal(recovered.state, 'active'); assert.equal(recovered.recovery, 'reacquire-ended');
  assert.equal(recovered.assertionRecovery.attempts, 1); assert.equal(recovered.assertionRecovery.confirmed, true);
  const acquisitions = f.calls.filter(call => call.operation === 'acquire');
  assert.equal(acquisitions.length, 2); assert.equal(acquisitions[1].port, 49101); assert.equal(acquisitions[1].epoch, 'epoch-2');
  assert.deepEqual(f.work.status().warnings, []);
  const reads = f.descriptorReads, count = f.calls.length;
  for (let i = 0; i < 20; i++) assert.deepEqual(await f.touch(), []);
  assert.equal(f.descriptorReads, reads); assert.equal(f.calls.length, count);
});

test('an SDK terminal response during work renewal reacquires on the current runtime before that work continues', async t => {
  const f = fixture(t); await f.touch(); const original = [...f.remote][0];
  f.restart(); await f.advance(45000, false);
  assert.deepEqual(await f.touch(), []);
  assert.equal(f.remote.size, 1); assert.equal(f.remote.has(original), true);
  assert.deepEqual(f.calls.map(call => call.operation), ['acquire', 'renew', 'acquire']);
  assert.equal(f.calls.at(-1).epoch, 'epoch-2'); assert.equal(f.calls.at(-1).port, 49101);
});

test('automatic work restores its ended assertion on the existing refresh timer without another work signal', async t => {
  const f = fixture(t); await f.touch(); f.restart(); await f.advance(1000);
  assert.deepEqual(await f.touch(), []);
  assert.equal(f.remote.size, 0, 'a local active lease is not proof that the restarted SDK still holds its assertion');
  assert.equal(f.calls.length, 1, 'ordinary touches do not add device discovery or status calls');
  await f.advance(14000);
  assert.equal(f.remote.size, 1); assert.equal(f.calls.filter(call => call.operation === 'acquire').length, 2);
  const count = f.calls.length;
  assert.deepEqual(await f.touch(), []); assert.equal(f.calls.length, count);
});

test('a replacement acquisition failure is attempted once and retains the ordinary 30-second backoff', async t => {
  const f = fixture(t); await f.touch(); f.restart(); await f.advance(45000, false);
  f.failNextAcquire('power_lease_ended');
  const warnings = await f.touch();
  assert.equal(warnings.length, 1); assert.equal(warnings[0].code, 'power_lease_ended');
  assert.equal(warnings[0].retryAtMs, 75000); assert.equal(warnings[0].blocking, false);
  assert.equal(f.calls.filter(call => call.operation === 'acquire').length, 2); assert.equal(f.remote.size, 0);
  const count = f.calls.length;
  for (let i = 0; i < 20; i++) assert.deepEqual(await f.touch(), warnings);
  assert.equal(f.calls.length, count, 'a failed replacement must not loop or bypass backoff');
});

test('transport errors keep their warning and backoff instead of becoming an immediate retry', async t => {
  const f = fixture(t); await f.touch(); await f.advance(45000, false); f.failNextRenew('ECONNREFUSED');
  const warnings = await f.touch();
  assert.equal(warnings.length, 1); assert.equal(warnings[0].code, 'ECONNREFUSED'); assert.equal(warnings[0].retryAtMs, 75000);
  assert.equal(f.calls.filter(call => call.operation === 'acquire').length, 1);
  const count = f.calls.length; assert.deepEqual(await f.touch(), warnings); assert.equal(f.calls.length, count);
  await f.advance(30001, false); assert.deepEqual(await f.touch(), []);
  assert.equal(f.calls.filter(call => call.operation === 'acquire').length, 2);
});

for (const code of ['ECONNREFUSED', 'provider_timeout', 'power_ios_app_not_foreground'])
  test(`work queued behind a failed refresh retains ${code} without a replacement acquisition`, async t => {
    const f = fixture(t); await f.touch(); const original = [...f.remote][0];
    f.holdNextRenew(); f.failNextRenew(code); await f.advance(15000);
    const touch = f.touch(); await flush();
    f.releaseRenew(); const warnings = await touch;
    assert.equal(f.calls.filter(call => call.operation === 'acquire').length, 1);
    assert.equal(warnings.length, 1); assert.equal(warnings[0].code, code);
    assert.equal(warnings[0].message, 'Transport unavailable');
    assert.equal(warnings[0].lease.leaseId, original); assert.equal(warnings[0].lease.error.code, code);
    assert.equal(warnings[0].retryAtMs, 45000); assert.equal(warnings[0].blocking, false);
    const count = f.calls.length;
    assert.deepEqual(await f.touch(), warnings); assert.equal(f.calls.length, count);
  });

test('work queued behind a normal release acquires a new lease for that work signal', async t => {
  const f = fixture(t); await f.touch(); const original = [...f.remote][0];
  f.holdNextRenew(); await f.advance(15000);
  const release = f.manager.release({ leaseId: original });
  const touch = f.touch(); await flush();
  f.releaseRenew(); assert.equal((await release).state, 'released');
  assert.deepEqual(await touch, []);
  assert.equal(f.remote.size, 1); assert.equal(f.remote.has(original), false);
  assert.equal(f.calls.filter(call => call.operation === 'acquire').length, 2);
});

test('iOS workflow leases select ended-assertion recovery while Host protection remains manual', async t => {
  const f = fixture(t);
  f.work.begin({ ownerId: 'script:bounded-ios', target, timeoutMs: 90000 }); await flush();
  const leases = f.manager.status().leases;
  assert.equal(leases.find(lease => lease.target.platform === 'host').recovery, 'manual');
  const ios = leases.find(lease => lease.target.platform === 'ios');
  assert.equal(ios.recovery, 'reacquire-ended');
  f.restart(); await f.advance(15000);
  assert.equal(f.remote.has(ios.leaseId), true);
  assert.equal(f.manager.status({ leaseId: ios.leaseId }).expiresAtMs, ios.expiresAtMs);
  await f.work.end({ ownerId: 'script:bounded-ios' });
  assert.equal(f.remote.size, 0);
});

test('activity owners cannot reuse a lease acquired under a different recovery policy', async t => {
  const f = fixture(t), activity = createActivityLeases({ manager: f.manager });
  t.after(() => activity.close());
  const input = { ownerId: 'policy-choice', target, mode: 'display' };
  const manual = await activity.touch(input);
  const automatic = await activity.touch({ ...input, recovery: 'reacquire-ended' });
  assert.equal(manual.lease.recovery, 'manual'); assert.equal(automatic.lease.recovery, 'reacquire-ended');
  assert.notEqual(manual.lease.leaseId, automatic.lease.leaseId);
  assert.equal((await activity.touch({ ...input, recovery: 'manual' })).lease.leaseId, manual.lease.leaseId);
});

test('a new activity touch may replace a manual lease whose queued refresh confirmed it ended', async t => {
  const f = fixture(t), activity = createActivityLeases({ manager: f.manager });
  t.after(() => activity.close());
  const input = { ownerId: 'manual-activity', target, mode: 'display' };
  const first = await activity.touch(input);
  f.restart(); f.holdNextRenew(); await f.advance(15000);
  const touch = activity.touch(input); await flush();
  f.releaseRenew(); const replaced = await touch;
  assert.equal(replaced.ok, true); assert.notEqual(replaced.lease.leaseId, first.lease.leaseId);
  assert.equal(replaced.lease.recovery, 'manual'); assert.equal(f.remote.size, 1);
  assert.equal(f.manager.status({ leaseId: first.lease.leaseId }).error.code, 'power_lease_ended');
  assert.equal(f.calls.filter(call => call.operation === 'acquire').length, 2);
});

test('explicit leases retain terminal renewal and explicit ports remain pinned across a runtime change', async t => {
  const f = fixture(t);
  const pinned = await f.manager.acquire({ ownerId: 'manual-port', target: { ...target, iosPort: 49100 }, mode: 'display', leaseMs: 600000 });
  const discovered = await f.manager.acquire({ ownerId: 'manual-discovery', target, mode: 'display', leaseMs: 600000 });
  f.restart();
  const pinnedResult = await f.manager.renew({ leaseId: pinned.leaseId, leaseMs: 600000 });
  assert.equal(pinnedResult.state, 'failed'); assert.equal(pinnedResult.error.code, 'ECONNREFUSED');
  const ended = await f.manager.renew({ leaseId: discovered.leaseId, leaseMs: 600000 });
  assert.equal(ended.state, 'failed'); assert.equal(ended.error.code, 'power_lease_ended');
  assert.equal(f.calls.filter(call => call.operation === 'acquire').length, 2); assert.equal(f.remote.size, 0);
});
