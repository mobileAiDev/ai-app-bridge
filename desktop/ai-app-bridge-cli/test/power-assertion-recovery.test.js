'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { createPowerManager } = require('../bin/power');
const { createPlatformAdapter } = require('../bin/power/platform-adapters');
const { IOSBridgeProvider } = require('../bin/ios-provider');
const { validateCommandArguments } = require('../bin/command-registry');
const flush = () => new Promise(resolve => setImmediate(resolve));
const target = { platform: 'ios', deviceId: 'heartbeat-phone', bundleId: 'heartbeat.app' };

// Real manager/adapter/provider with only the device transport and clock replaced.
// A restart changes all runtime binding fields and removes device assertions.
function fixture(t) {
  let time = 0, sequence = 0, renewError, acquireError, acquireResponseError, releaseError;
  let nextAcquire, releaseAcquire, nextRenew, releaseRenew;
  let binding = { schemaVersion: 'aab.ios-runtime/v1', bundleId: target.bundleId,
    runtimeEpoch: 'epoch-1', processId: 100, port: 49100 };
  const calls = [], remote = new Set(), timers = new Map();
  const provider = new IOSBridgeProvider({ httpRequest: async (_method, url, body, options) => {
    calls.push({ ...body, time, port: Number(new URL(url).port), epoch: options.headers['X-AAB-Runtime-Epoch'] });
    if (Number(new URL(url).port) !== binding.port) throw Object.assign(new Error('Pinned endpoint closed'), { code: 'ECONNREFUSED' });
    assert.equal(options.headers['X-AAB-Runtime-Epoch'], binding.runtimeEpoch);
    const result = { ok: true, runtimeBinding: binding, coverage: { display: true, scope: 'selected-sdk-app-foreground' } };
    if (body.operation === 'renew') {
      if (nextRenew) { const pending = nextRenew; nextRenew = null; await pending; }
      if (renewError) throw Object.assign(new Error('Transport unavailable'), { code: renewError });
      if (!remote.has(body.leaseId)) return { ...result, ok: false, error: 'power_lease_ended', message: 'The SDK assertion ended' };
    }
    if (body.operation === 'acquire') {
      if (acquireError) return { ...result, ok: false, error: acquireError, message: 'Acquire rejected' };
      assert.equal(remote.has(body.leaseId), false, 'never reacquire an existing assertion');
      remote.add(body.leaseId);
      if (nextAcquire) { const pending = nextAcquire; nextAcquire = null; await pending; }
      if (acquireResponseError) throw Object.assign(new Error('Acquire response lost'), { code: acquireResponseError });
    }
    if (body.operation === 'release') {
      if (releaseError) throw Object.assign(new Error('Release unavailable'), { code: releaseError });
      remote.delete(body.leaseId); result.released = true;
    }
    return result;
  } });
  provider.requireDevice = async () => ({ identifier: target.deviceId, udid: target.deviceId,
    developerModeStatus: 'enabled', ddiServicesAvailable: true, tunnelState: 'connected', tunnelIPAddress: '127.0.0.1' });
  provider.readRuntimePortFile = async () => binding;
  const manager = createPowerManager({ now: () => time, wallNow: () => 100000 + time,
    schedule: (callback, delay) => { const id = ++sequence; timers.set(id, { at: time + delay, callback }); return id; },
    unschedule: id => timers.delete(id),
    acquireAdapter: createPlatformAdapter({ iosRequest: async (selected, body) =>
      (await provider.runtimePort(selected)).post('/v1/power', body) }) });
  t.after(() => { releaseAcquire?.(); releaseRenew?.(); return manager.close(); });
  return { manager, calls, remote,
    acquire: options => manager.acquire({ ownerId: 'bounded-task', target, mode: 'display', leaseMs: 90000,
      recovery: 'reacquire-ended', ...options }),
    restart() { binding = { ...binding, runtimeEpoch: 'epoch-2', processId: 101, port: 49101 }; remote.clear(); },
    failRenew(code) { renewError = code; }, failAcquire(code) { acquireError = code; },
    loseAcquireResponse(code) { acquireResponseError = code; }, failRelease(code) { releaseError = code; },
    holdNextAcquire() { nextAcquire = new Promise(resolve => { releaseAcquire = resolve; }); },
    releaseAcquire() { releaseAcquire(); },
    holdNextRenew() { nextRenew = new Promise(resolve => { releaseRenew = resolve; }); },
    releaseRenew() { releaseRenew(); },
    async advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.callback(); }
      await flush();
    },
  };
}

test('an opted-in work lease reacquires a confirmed-ended iOS assertion on heartbeat without a new UI call', async t => {
  const f = fixture(t), first = await f.acquire();
  f.restart(); await f.advance(15000);
  const current = f.manager.status({ leaseId: first.leaseId });
  assert.equal(f.remote.has(first.leaseId), true);
  assert.equal(current.state, 'active'); assert.equal(current.expiresAtMs, first.expiresAtMs);
  assert.equal(current.recovery, 'reacquire-ended');
  assert.equal(current.assertionRecovery.attempts, 1); assert.equal(current.assertionRecovery.confirmed, true);
  assert.equal(current.assertionRecovery.reason, 'power_lease_ended');
  assert.deepEqual(f.calls.map(x => x.operation), ['acquire', 'renew', 'acquire']);
  assert.equal(f.calls.at(-1).epoch, 'epoch-2'); assert.equal(f.calls.at(-1).port, 49101);
  await f.advance(75000);
  assert.equal(f.manager.status({ leaseId: first.leaseId }).state, 'expired'); assert.equal(f.remote.size, 0);
  assert.equal(f.calls.filter(x => x.operation === 'acquire').length, 2, 'recovery cannot extend work or run after expiry');
});

test('manual policy retains the original terminal result after an App restart', async t => {
  const f = fixture(t), first = await f.acquire({ recovery: undefined }); f.restart(); await f.advance(15000);
  assert.equal(first.recovery, 'manual', 'an omitted policy defaults to manual');
  assert.equal(f.manager.status({ leaseId: first.leaseId }).state, 'failed'); assert.equal(f.remote.size, 0);
  assert.equal(f.calls.filter(x => x.operation === 'acquire').length, 1);
});

for (const code of ['ECONNREFUSED', 'power_ios_app_not_foreground', 'runtime_identity_mismatch']) {
  test(`heartbeat recovery never substitutes for ${code}`, async t => {
    const f = fixture(t), first = await f.acquire(); f.failRenew(code); await f.advance(15000);
    const current = f.manager.status({ leaseId: first.leaseId });
    assert.equal(current.state, 'failed'); assert.equal(current.error.code, code);
    assert.equal(f.calls.filter(x => x.operation === 'acquire').length, 1);
  });
}

test('a failed replacement is attempted once, reported, and does not create an endless heartbeat retry', async t => {
  const f = fixture(t), first = await f.acquire(); f.restart(); f.failAcquire('power_ios_app_not_foreground');
  await f.advance(15000); const current = f.manager.status({ leaseId: first.leaseId });
  assert.equal(current.state, 'failed'); assert.equal(current.error.code, 'power_ios_app_not_foreground');
  assert.equal(current.assertionRecovery.confirmed, false);
  await f.advance(60000); assert.equal(f.calls.filter(x => x.operation === 'acquire').length, 2);
});

test('an explicit port remains pinned even when confirmed-ended recovery was selected', async t => {
  const f = fixture(t), first = await f.acquire({ target: { ...target, iosPort: 49100 } });
  f.restart(); await f.advance(15000);
  assert.equal(f.manager.status({ leaseId: first.leaseId }).error.code, 'ECONNREFUSED');
  assert.equal(f.calls.filter(x => x.operation === 'acquire').length, 1);
});

test('releasing an opted-in work lease cancels recovery, and the choice is available in the public contract', async t => {
  const f = fixture(t), first = await f.acquire(); await f.manager.release({ leaseId: first.leaseId });
  f.restart(); await f.advance(15000); assert.equal(f.calls.filter(x => x.operation === 'acquire').length, 1);
  const args = { operation: 'acquire', ownerId: 'task', target, mode: 'display', leaseMs: 90000, recovery: 'reacquire-ended' };
  assert.deepEqual(validateCommandArguments('power', args), args);
});

test('close during the confirming renewal prevents a later replacement acquisition', async t => {
  const f = fixture(t), first = await f.acquire(); f.restart(); f.holdNextRenew();
  await f.advance(15000);
  const closing = f.manager.close();
  f.releaseRenew(); await closing;
  assert.equal(f.manager.status({ leaseId: first.leaseId }).state, 'released');
  assert.equal(f.calls.filter(call => call.operation === 'acquire').length, 1);
  await f.advance(60000); assert.equal(f.calls.filter(call => call.operation === 'acquire').length, 1);
});

for (const ending of ['close', 'release'])
  test(`${ending} while replacement is in flight drains and releases its assertion exactly once`, async t => {
    const f = fixture(t), first = await f.acquire(); f.restart(); f.holdNextAcquire();
    await f.advance(15000);
    assert.equal(f.remote.has(first.leaseId), true);
    assert.equal(f.manager.status({ leaseId: first.leaseId }).assertionRecovery.confirmed, false);
    let ended = false;
    const endingWork = (ending === 'close' ? f.manager.close() : f.manager.release({ leaseId: first.leaseId }))
      .then(result => { ended = true; return result; });
    await flush(); assert.equal(ended, false, 'the owner must drain its in-flight acquisition');
    f.releaseAcquire(); await endingWork;
    assert.equal(f.manager.status({ leaseId: first.leaseId }).state, 'released');
    assert.equal(f.remote.size, 0);
    assert.equal(f.calls.filter(call => call.operation === 'release').length, 1);
    await f.advance(60000); assert.equal(f.calls.filter(call => call.operation === 'acquire').length, 2);
  });

test('work expiring during replacement releases the resulting assertion without extending its deadline', async t => {
  const f = fixture(t), first = await f.acquire({ leaseMs: 20000 }); f.restart(); f.holdNextAcquire();
  await f.advance(15000);
  assert.equal(f.calls.at(-1).operation, 'acquire'); assert.equal(f.calls.at(-1).ttlMs, 5000);
  await f.advance(5000); f.releaseAcquire(); await flush();
  const current = f.manager.status({ leaseId: first.leaseId });
  assert.equal(current.state, 'expired'); assert.equal(current.expiresAtMs, first.expiresAtMs);
  assert.equal(f.remote.size, 0); assert.equal(f.calls.filter(call => call.operation === 'release').length, 1);
  await f.advance(60000); assert.equal(f.calls.filter(call => call.operation === 'acquire').length, 2);
});

test('a lost replacement response cannot reuse the old assertion expiry as the new assertion bound', async t => {
  const f = fixture(t), first = await f.acquire(); f.restart();
  f.loseAcquireResponse('ECONNRESET'); f.failRelease('ECONNREFUSED'); await f.advance(45000);
  const current = f.manager.status({ leaseId: first.leaseId });
  assert.equal(current.state, 'failed'); assert.equal(current.error.code, 'ECONNRESET');
  assert.equal(current.assertionRecovery.confirmed, false); assert.equal(f.remote.size, 1);
  assert.equal(f.calls.filter(call => call.operation === 'acquire').at(-1).ttlMs, 45000);
  assert.equal(current.platformExpiresAtMs, undefined, 'the replaced assertion may outlive the old confirmed expiry');
  assert.equal(current.release.released, false); assert.equal(current.release.platformExpiresAtMs, undefined);
  await f.advance(60000); assert.equal(f.calls.filter(call => call.operation === 'acquire').length, 2);
});
