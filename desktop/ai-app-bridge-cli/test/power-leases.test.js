'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPowerManager } = require('../bin/power');
const { createPlatformAdapter } = require('../bin/power/platform-adapters');

function fixture() {
  let time = 0, next = 0;
  const timers = new Map(), calls = [];
  const manager = createPowerManager({ assertionTtlMs: 10000, refreshMs: 2000,
    now: () => time, wallNow: () => 100000 + time,
    schedule: (callback, delay) => { const id = ++next; timers.set(id, { at: time + delay, callback }); return id; },
    unschedule: id => timers.delete(id),
    acquireAdapter: async options => {
      calls.push({ operation: 'acquire', ...options });
      return { coverage: { scope: 'test', mode: options.mode },
        async renew(input) { calls.push({ operation: 'renew', leaseId: options.leaseId, ...input }); return { coverage: { scope: 'test', mode: options.mode } }; },
        async release() { calls.push({ operation: 'release', leaseId: options.leaseId }); return { released: true }; } };
    } });
  return { manager, calls, async advance(milliseconds) {
    time += milliseconds;
    for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.callback(); }
    await new Promise(resolve => setImmediate(resolve));
  } };
}
const work = leaseMs => ({ ownerId: 'work-1', target: { platform: 'host' }, mode: 'both', leaseMs });

test('platform renewal continues without Bridge calls, while the work deadline remains fixed', async () => {
  const { manager, calls, advance } = fixture();
  const lease = await manager.acquire(work(12000));
  assert.equal(calls[0].ttlMs, 10000);
  await advance(2000);
  assert.equal(calls[1].operation, 'renew');
  assert.equal(calls[1].ttlMs, 10000);
  assert.equal(manager.status({ leaseId: lease.leaseId }).expiresAtMs, 112000);
  await advance(7000);
  assert.equal(calls[2].ttlMs, 3000);
  await advance(3000);
  assert.equal(manager.status({ leaseId: lease.leaseId }).state, 'expired');
  assert.equal(calls.at(-1).operation, 'release');
  await assert.rejects(manager.renew({ leaseId: lease.leaseId, leaseMs: 10000 }), { code: 'power_lease_ended' });
});

test('explicit renewal extends work; cancel and parallel leases release only their own assertions', async () => {
  const { manager, calls, advance } = fixture();
  const first = await manager.acquire(work(4000));
  const second = await manager.acquire({ ...work(8000), ownerId: 'work-2' });
  await advance(3000);
  await manager.renew({ leaseId: first.leaseId, leaseMs: 7000 });
  assert.equal(manager.status({ leaseId: first.leaseId }).expiresAtMs, 110000);
  await manager.release({ leaseId: second.leaseId });
  assert.deepEqual(calls.filter(x => x.operation === 'release').map(x => x.leaseId), [second.leaseId]);
  await manager.release({ leaseId: second.leaseId });
  assert.equal(calls.filter(x => x.operation === 'release').length, 1);
  await advance(5000);
  assert.equal(manager.status({ leaseId: first.leaseId }).state, 'active');
  await manager.close();
  assert.equal(manager.status({ leaseId: first.leaseId }).state, 'released');
  assert.equal(calls.filter(x => x.operation === 'release').length, 2);
  await assert.rejects(manager.acquire(work(5000)), { code: 'power_manager_closed' });
});

test('close during an in-flight acquire releases the resulting assertion once', async () => {
  let resolve, releases = 0;
  const manager = createPowerManager({ acquireAdapter: () => new Promise(done => { resolve = done; }) });
  const acquisition = manager.acquire(work(10000));
  await new Promise(done => setImmediate(done));
  const closure = manager.close();
  resolve({ coverage: {}, renew: async () => ({ coverage: {} }), release: async () => { releases++; return { released: true }; } });
  assert.equal((await acquisition).state, 'released');
  await closure; assert.equal(releases, 1);
});

test('platform failure is explicit and bounded release is reported without claiming success', async () => {
  const manager = createPowerManager({ acquireAdapter: async () => ({ coverage: {},
    renew: async () => { throw Object.assign(new Error('USB disconnected'), { code: 'device_disconnected' }); },
    release: async () => { throw new Error('Transport unavailable'); } }) });
  const lease = await manager.acquire(work(10000));
  const result = await manager.renew({ leaseId: lease.leaseId, leaseMs: 12000 });
  assert.equal(result.state, 'failed');
  assert.equal(result.error.code, 'device_disconnected');
  assert.equal(result.release.released, false);
  assert.equal(result.release.boundedByPlatformExpiry, true);
  assert.equal(result.remainingMs, 0);
  await manager.close();
});

test('iOS requires explicit SDK target and display mode, retaining the bound transport identity', async () => {
  const calls = [];
  const adapter = createPlatformAdapter({ iosRequest: async (target, body) => {
    calls.push({ target, body }); return { ok: true, coverage: { scope: 'selected-sdk-app-foreground', externalApps: false } };
  } });
  const target = { platform: 'ios', deviceId: 'phone-1', bundleId: 'sample.app' };
  await assert.rejects(adapter({ target, mode: 'both', ttlMs: 5000, leaseId: 'id' }), { code: 'power_mode_unsupported' });
  assert.equal(calls.length, 0);
  const handle = await adapter({ target, mode: 'display', ttlMs: 5000, leaseId: 'id' });
  await handle.renew({ ttlMs: 7000 }); await handle.release();
  assert.deepEqual(calls.map(x => x.body.operation), ['acquire', 'renew', 'release']);
  assert.ok(calls.every(x => x.target === target && x.body.leaseId === 'id'));
  assert.equal(handle.coverage.externalApps, false);
});

test('a lost acquire response is not proof that a remote assertion was never created', async () => {
  const manager = createPowerManager({ acquireAdapter: async () => { throw Object.assign(new Error('Acquire reply lost'), { code: 'transport_lost' }); } });
  await assert.rejects(manager.acquire(work(10000)), error => {
    assert.equal(error.lease.state, 'failed');
    assert.equal(error.lease.release.released, false);
    assert.equal(error.lease.release.reason, 'acquisition_not_confirmed');
    assert.equal(error.lease.platformExpiresAtMs, undefined);
    return true;
  });
  await manager.close();
});
