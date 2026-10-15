'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createActivityLeases } = require('../bin/power/activity-lease');
const { createPowerManager } = require('../bin/power');
const input = { ownerId: 'client-work', target: { platform: 'host' }, mode: 'both' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('many work touches reuse one lease without an OS renewal per UI action; timers cover thinking pauses', async () => {
  let acquisitions = 0, renewals = 0, releases = 0;
  const manager = createPowerManager({ assertionTtlMs: 80, refreshMs: 20, acquireAdapter: async () => {
    acquisitions++; return { coverage: {}, renew: async () => { renewals++; return { coverage: {} }; },
      release: async () => { releases++; return { released: true }; } };
  } });
  const activity = createActivityLeases({ manager, idleLeaseMs: 160 });
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () => activity.touch(input)));
    assert.ok(results.every(x => x.ok)); assert.equal(new Set(results.map(x => x.lease.leaseId)).size, 1);
    assert.equal(acquisitions, 1); assert.equal(renewals, 0);
    await delay(100); assert.ok(renewals >= 2); assert.equal(releases, 0);
    const refreshed = await activity.touch(input); assert.equal(refreshed.lease.leaseId, results[0].lease.leaseId);
    await delay(100); assert.equal(manager.status({ leaseId: refreshed.lease.leaseId }).state, 'active');
    await delay(90); assert.equal(manager.status({ leaseId: refreshed.lease.leaseId }).state, 'expired'); assert.equal(releases, 1);
    const laterWork = await activity.touch(input); assert.equal(laterWork.ok, true); assert.notEqual(laterWork.lease.leaseId, refreshed.lease.leaseId);
  } finally { await activity.close(); await manager.close(); }
});

test('end during acquisition waits for its own lease and leaves parallel owners intact', async () => {
  let complete, releases = 0;
  const handle = () => ({ coverage: {}, renew: async () => ({ coverage: {} }), release: async () => { releases++; return { released: true }; } });
  const manager = createPowerManager({ acquireAdapter: ({ target }) => target.platform === 'host' ? new Promise(resolve => { complete = resolve; }) : Promise.resolve(handle()) });
  const activity = createActivityLeases({ manager });
  const pending = activity.touch(input);
  await delay(0);
  const other = await activity.touch({ ...input, ownerId: 'other', target: { platform: 'android', serial: 'test' } });
  const ending = activity.end({ ownerId: input.ownerId });
  complete(handle()); const result = await pending; await ending;
  assert.equal(manager.status({ leaseId: result.lease.leaseId }).state, 'released');
  assert.equal(manager.status({ leaseId: other.lease.leaseId }).state, 'active'); assert.equal(releases, 1);
  await activity.close(); assert.equal(releases, 2); await manager.close();
});

test('unavailable protection returns a warning and close admits no new work', async () => {
  const manager = createPowerManager({ acquireAdapter: async () => { throw Object.assign(new Error('Target disconnected'), { code: 'device_disconnected' }); } });
  const activity = createActivityLeases({ manager });
  const result = await activity.touch(input);
  assert.equal(result.ok, false); assert.equal(result.warning.code, 'device_disconnected');
  await activity.close();
  assert.equal((await activity.touch(input)).warning.code, 'power_activity_closed'); await manager.close();
});

test('a pruned terminal lease does not interrupt end or close, while release failures remain warnings', async () => {
  let releaseCode = 'power_lease_not_found';
  const manager = { acquire: async () => ({ state: 'active', leaseId: 'retained-1' }),
    release: async () => { throw Object.assign(new Error('release diagnostic'), { code: releaseCode }); } };
  const activity = createActivityLeases({ manager });
  await activity.touch(input);
  assert.deepEqual(await activity.end({ ownerId: input.ownerId }), [{ ok: true, released: true, reason: 'terminal_record_pruned' }]);
  await activity.touch(input); releaseCode = 'transport_lost';
  const results = await activity.close();
  assert.equal(results[0].ok, false); assert.equal(results[0].warning.code, 'transport_lost');
  assert.equal(results[0].warning.message, 'release diagnostic');
});
