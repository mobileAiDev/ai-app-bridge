'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createBridgeForward, verifyBridgeForward, removeBridgeForward } = require('../bin/bridge-forward');
const { bridgeRequest, normalizeBridgeError } = require('../bin/device-provider');
const endpoint = { socketName: 'aab-sdk-1788970540000-9849cc4b-7d8b-431a-bd75-c4f5dfec5c41' };

function adbServer() {
  const mappings = new Map();
  const allocations = [];
  let nextPort = 40000;
  const adb = async (ctx, args) => {
    if (args[0] === 'get-serialno') return { stdout: 'only-device\n' };
    if (args[1] === '--list') {
      return { stdout: [...mappings].map(([local, row]) => `${row.serial} ${local} ${row.remote}`).join('\n') };
    }
    if (args[1] === '--remove') { mappings.delete(args[2]); return { stdout: '' }; }
    assert.deepEqual(args.slice(0, 2), ['forward', '--no-rebind']);
    const local = args[2] === 'tcp:0' ? `tcp:${++nextPort}` : args[2];
    assert.equal(mappings.has(local), false, 'must never replace an existing mapping');
    mappings.set(local, { serial: ctx.serial || 'only-device', remote: args[3] });
    allocations.push(local);
    return { stdout: args[2] === 'tcp:0' ? local.slice(4) + '\n' : '' };
  };
  return { adb, mappings, allocations };
}

test('SDK routes use the exact runtime local socket, including an explicit host port', async () => {
  const server = adbServer();
  const endpoint = { socketName: 'aab-sdk-1788970540000-9849cc4b-7d8b-431a-bd75-c4f5dfec5c41' };
  const ctx = { serial: 'oppo-one', explicitPort: true, port: 41234 };
  const route = await createBridgeForward(ctx, endpoint, server.adb);
  assert.deepEqual(server.mappings.get('tcp:41234'), {
    serial: 'oppo-one', remote: `localabstract:${endpoint.socketName}`,
  });
  await verifyBridgeForward(ctx, { ...route, endpoint }, server.adb);
});

test('two devices with the same socket name receive independent host routes; later discovery reuses them', async () => {
  const server = adbServer();
  const first = await createBridgeForward({ serial: 'oppo-one' }, endpoint, server.adb);
  const second = await createBridgeForward({ serial: 'oppo-two' }, endpoint, server.adb);
  assert.notEqual(first.hostPort, second.hostPort);
  assert.deepEqual(await createBridgeForward({ serial: 'oppo-one' }, endpoint, server.adb), { ...first, reused: true });
  assert.deepEqual(await createBridgeForward({ serial: 'oppo-two' }, endpoint, server.adb), { ...second, reused: true });
  assert.equal(server.allocations.length, 2, 'rediscovery must not leak new forwards');
  await verifyBridgeForward({}, { ...first, endpoint }, server.adb);
  await verifyBridgeForward({}, { ...second, endpoint }, server.adb);
});

test('an explicit port conflict is exposed without replacing another device route', async () => {
  const server = adbServer();
  const ctx = { serial: 'oppo-one', explicitPort: true, port: 18080 };
  const first = await createBridgeForward(ctx, endpoint, server.adb);
  assert.equal(first.hostPort, 18080);
  assert.deepEqual(await createBridgeForward(ctx, endpoint, server.adb), { ...first, reused: true });
  await assert.rejects(createBridgeForward({ ...ctx, serial: 'oppo-two' }, endpoint, server.adb), (error) => {
    assert.equal(normalizeBridgeError(error).code, 'bridge_forward_mismatch');
    return true;
  });
  assert.equal(server.mappings.get('tcp:18080').serial, 'oppo-one');
});

test('a route stolen by another ADB client prevents HTTP action dispatch', async () => {
  const server = adbServer();
  const ctx = { serial: 'oppo-one' };
  const forward = { ...await createBridgeForward(ctx, endpoint, server.adb), endpoint };
  server.mappings.set(`tcp:${forward.hostPort}`, { serial: 'another-device', remote: `localabstract:${endpoint.socketName}` });
  let dispatches = 0;
  await assert.rejects(bridgeRequest(ctx, async () => { dispatches += 1; }, {
    ensureForward: () => verifyBridgeForward(ctx, forward, server.adb),
  }), (error) => {
    assert.equal(error.aiAppBridgeRequestNotStarted, true);
    assert.equal(error.aiAppBridgeForwardMismatch, true);
    return true;
  });
  assert.equal(dispatches, 0);
});

test('the implicit single device is resolved and a deleted route is rejected', async () => {
  const server = adbServer();
  const forward = { ...await createBridgeForward({}, endpoint, server.adb), endpoint };
  assert.equal(forward.serial, 'only-device');
  server.mappings.clear();
  await assert.rejects(verifyBridgeForward({}, forward, server.adb), { aiAppBridgeForwardMismatch: true });
});

test('remove-forward checks the explicit serial and never removes another device route', async () => {
  const server = adbServer();
  const route = await createBridgeForward({ serial: 'oppo-one' }, endpoint, server.adb);
  await assert.rejects(removeBridgeForward({ serial: 'oppo-two', port: route.hostPort }, server.adb), { aiAppBridgeForwardMismatch: true });
  assert.equal(server.mappings.size, 1);
  const removed = await removeBridgeForward({ serial: 'oppo-one', port: route.hostPort }, server.adb);
  assert.equal(removed.remote, `localabstract:${endpoint.socketName}`);
  assert.equal(server.mappings.size, 0);
  await assert.rejects(removeBridgeForward({ serial: 'oppo-one', port: route.hostPort }, server.adb), { aiAppBridgeForwardMismatch: true });
});
