'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { IOSBridgeProvider } = require('../bin/ios-provider');
const sleeping = { identifier: 'phone', hardwareProperties: { udid: 'physical-phone', platform: 'iOS' },
  deviceProperties: { developerModeStatus: 'enabled', ddiServicesAvailable: false },
  connectionProperties: { pairingState: 'paired', transportType: 'wired', tunnelState: 'disconnected' } };
const connected = { ...sleeping, deviceProperties: { ...sleeping.deviceProperties, ddiServicesAvailable: true },
  connectionProperties: { ...sleeping.connectionProperties, tunnelState: 'connected', tunnelIPAddress: 'fd00::1' } };

test('device discovery wakes a sleeping selected tunnel through details before testing readiness', async () => {
  const provider = new IOSBridgeProvider(), calls = [];
  provider.devicectlJson = async (_ctx, args) => {
    calls.push(args);
    return args[0] === 'list' ? { result: { devices: [sleeping] } } : { result: connected };
  };
  const result = await provider.devices({ deviceId: 'physical-phone' });
  assert.equal(result.selectedDevice.tunnelState, 'connected');
  assert.equal(result.selectedDevice.ddiServicesAvailable, true);
  assert.equal(result.selectedDevice.connectionProbe.ok, true);
  assert.deepEqual(calls, [['list', 'devices'], ['device', 'info', 'details', '--device', 'phone']]);
});

test('a failed or wrong-device detail response stays unavailable and is exposed without losing inventory', async () => {
  for (const result of [null, { ...connected, identifier: 'another-phone' }, { ...connected, hardwareProperties: { udid: 'another-udid' } }]) {
    const provider = new IOSBridgeProvider();
    provider.devicectlJson = async (_ctx, args) => {
      if (args[0] === 'list') return { result: { devices: [sleeping] } };
      if (!result) throw Object.assign(new Error('Cannot query the selected device'), { code: 'device_disconnected' });
      return { result };
    };
    const device = (await provider.devices()).selectedDevice;
    assert.equal(device.udid, 'physical-phone'); assert.equal(device.tunnelState, 'disconnected');
    assert.equal(device.connectionProbe.ok, false);
  }
});

test('discovery does not wake an arbitrary phone when selection is ambiguous', async () => {
  const provider = new IOSBridgeProvider();
  provider.devicectlJson = async (_ctx, args) => {
    assert.deepEqual(args, ['list', 'devices']);
    return { result: { devices: [sleeping, { ...sleeping, identifier: 'second' }] } };
  };
  assert.equal((await provider.devices()).selectedDevice, null);
});
