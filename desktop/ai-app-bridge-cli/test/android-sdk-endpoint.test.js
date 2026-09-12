'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { schema, endpointPath, parseAndroidSdkEndpoint, discoverAndroidSdkEndpoint } = require('../bin/shared-kernel/android-sdk-endpoint');
const { validateCommandArguments } = require('../bin/command-registry');

const packageName = 'example.sdk';
const runtimeEpoch = '1788970540000-9849cc4b-7d8b-431a-bd75-c4f5dfec5c41';
const ready = { schema, packageName, runtimeEpoch, socketName: `aab-sdk-${runtimeEpoch}`,
  transport: 'localabstract', ok: true, version: '0.3.0-rc.1', updatedAtMs: 1788970540000 };

test('endpoint binds the requested package and exact runtime socket', () => {
  assert.deepEqual(parseAndroidSdkEndpoint(JSON.stringify(ready), packageName), ready);
  assert.throws(() => parseAndroidSdkEndpoint(JSON.stringify(ready), 'other.app'), { code: 'bridge_package_mismatch' });
  for (const change of [
    { schema: 'legacy' }, { transport: 'tcp', port: 18080 }, { runtimeEpoch: 'unknown' },
    { socketName: `${ready.socketName}-other` }, { socketName: 'tcp:18080' },
    { updatedAtMs: '1788970540000' }, { version: null }, { ok: 'true' },
  ]) {
    assert.throws(() => parseAndroidSdkEndpoint(JSON.stringify({ ...ready, ...change }), packageName),
      { code: 'bridge_endpoint_invalid' }, JSON.stringify(change));
  }
  for (const text of ['null', '[]', '{}', '{']) assert.throws(() => parseAndroidSdkEndpoint(text, packageName), { code: 'bridge_endpoint_invalid' });
  assert.throws(() => parseAndroidSdkEndpoint(JSON.stringify({ ...ready, ok: false, error: 'starting' }), packageName),
    { code: 'bridge_not_ready' });
});

test('explicit host port still discovers the endpoint on the requested device and App', async () => {
  const ctx = { serial: 'phone-a', packageName, explicitPort: true, port: 41234 };
  const calls = [];
  assert.deepEqual(await discoverAndroidSdkEndpoint(ctx, async (actual, args) => {
    assert.equal(actual, ctx); calls.push(args); return { stdout: JSON.stringify(ready) };
  }), ready);
  assert.deepEqual(calls, [['shell', 'run-as', packageName, 'cat', endpointPath]]);
  let attempts = 0;
  await assert.rejects(discoverAndroidSdkEndpoint(ctx, async () => { attempts++; throw new Error('no endpoint'); }),
    { code: 'bridge_endpoint_discovery_failed' });
  assert.equal(attempts, 1, 'no old port discovery or alternate route');
});

test('SDK command schemas reject a host port without the App target before provider execution', () => {
  for (const command of ['status', 'tree', 'logs', 'network', 'state', 'events', 'forward', 'flutter-tree', 'h5-dom']) {
    assert.throws(() => validateCommandArguments(command, { serial: 'phone-a', port: 41234 }),
      { code: 'missing_argument', field: 'packageName' }, command);
  }
  assert.doesNotThrow(() => validateCommandArguments('screenshot', { serial: 'phone-a' }));
  assert.doesNotThrow(() => validateCommandArguments('keyevent', { serial: 'phone-a', keyCode: 3 }));
  assert.throws(() => validateCommandArguments('remove-forward', { serial: 'phone-a' }), { code: 'missing_argument', field: 'port' });
  assert.throws(() => validateCommandArguments('remove-forward', { port: 41234 }), { code: 'missing_argument', field: 'serial' });
});
