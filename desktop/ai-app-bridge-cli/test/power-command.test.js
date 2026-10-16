'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { validateCommandArguments, commandContract, isAndroidMutation } = require('../bin/command-registry');
const { createScriptHostPort } = require('../bin/script/script-host-port');
const { handle } = require('../bin/power/command');
const { normalizeCommandResult } = require('../bin/command-errors');

test('power scope is explicit, discoverable, and separate from Android UI ownership', async () => {
  assert.equal(commandContract('power').platform, 'multi');
  const args = { operation: 'acquire', ownerId: 'work', target: { platform: 'host' }, mode: 'both', leaseMs: 600000 };
  assert.deepEqual(validateCommandArguments('power', args), args);
  assert.equal(isAndroidMutation('power', args), false);
  assert.throws(() => validateCommandArguments('power', { ...args, target: { platform: 'android' } }), { field: 'target.serial' });
  assert.throws(() => validateCommandArguments('power', { ...args, leaseMs: 0 }), { field: 'leaseMs' });
  assert.throws(() => validateCommandArguments('power', { operation: 'renew', leaseId: 'one', leaseMs: 1000, target: args.target }), { field: 'target' });
  let received;
  const host = createScriptHostPort({ target: { platform: 'android', serial: 'unrelated-phone' },
    actions: async (command, input) => { received = input; return handle(input, { acquire: async value => ({ leaseId: 'one', ...value, state: 'active' }) }); } });
  const result = await host.call('power', args);
  assert.equal(result.ok, true); assert.equal(result.result.leaseId, 'one');
  assert.deepEqual(received, args, 'Script must not inject its App or Android target into a Host power lease');
});

test('failed platform acquisition reports the bounded lease facts and leaves callers free to continue', async () => {
  const result = await handle({ operation: 'acquire' }, { acquire: async () => {
    throw Object.assign(new Error('device disconnected'), { code: 'power_worker_closed', lease: {
      leaseId: 'original', state: 'failed', release: { released: false, boundedByPlatformExpiry: true }, platformExpiresAtMs: 1234,
    } });
  } });
  assert.equal(result.ok, false); assert.equal(result.ambiguous, true);
  assert.equal(result.lease.leaseId, 'original'); assert.equal(result.lease.platformExpiresAtMs, 1234);
  const capability = await handle({ operation: 'capabilities' });
  assert.equal(capability.capabilities.ios.externalApps, false);
  assert.equal(capability.capabilities.win32.mechanism, 'SetThreadExecutionState');
});

test('unconfirmed platform release and inactive renewal cannot claim settled success', async () => {
  const release = await handle({ operation: 'release', leaseId: 'one' }, { release: async () => ({
    leaseId: 'one', state: 'released', platformExpiresAtMs: 1234,
    release: { released: false, boundedByPlatformExpiry: true },
  }) });
  assert.equal(release.ok, false); assert.equal(release.error, 'power_release_unconfirmed');
  assert.equal(release.ambiguous, true); assert.equal(release.settled, false); assert.equal(release.platformExpiresAtMs, 1234);
  const renewed = await handle({ operation: 'renew', leaseId: 'one', leaseMs: 1000 }, { renew: async () => ({
    leaseId: 'one', state: 'failed', error: { code: 'transport_lost', message: 'Connection lost' }, release: { released: true },
  }) });
  assert.equal(renewed.ok, false); assert.equal(renewed.error, 'transport_lost'); assert.equal(renewed.ambiguous, false);
  const expired = await handle({ operation: 'acquire' }, { acquire: async () => ({
    state: 'expired', release: { released: true },
  }) });
  assert.equal(expired.ok, false); assert.equal(expired.error, 'power_activity_inactive');
});

for (const operation of ['status', 'release']) test(`${operation} preserves a past lease failure without failing a successful command`, async () => {
  const leaseError = { code: 'power_assertion_unconfirmed', message: 'An earlier refresh could not confirm the assertion.' };
  const lease = { leaseId: 'one', state: 'failed', error: leaseError, release: { released: true } };
  const result = normalizeCommandResult(await handle({ operation, leaseId: 'one' }, {
    [operation]: async () => lease,
  }), 'power');
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
  assert.equal(result.state, 'failed');
  assert.deepEqual(result.leaseError, leaseError);
  assert.deepEqual(result.release, { released: true });
  assert.equal(result.settled, true);
});
