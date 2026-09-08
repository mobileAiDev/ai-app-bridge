'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createBridgeForward, verifyBridgeForward } = require('../bin/bridge-forward');
const { bridgeRequestWithCachedForward, normalizeBridgeError } = require('../bin/ai-app-bridge');

function adbServer() {
  const mappings = new Map();
  const allocations = [];
  let nextPort = 40000;
  const adb = async (ctx, args) => {
    if (args[0] === 'get-serialno') return { stdout: 'only-device\n' };
    if (args[1] === '--list') {
      return { stdout: [...mappings].map(([local, row]) => `${row.serial} ${local} ${row.remote}`).join('\n') };
    }
    assert.deepEqual(args.slice(0, 2), ['forward', '--no-rebind']);
    const local = args[2] === 'tcp:0' ? `tcp:${++nextPort}` : args[2];
    assert.equal(mappings.has(local), false, 'must never replace an existing mapping');
    mappings.set(local, { serial: ctx.serial || 'only-device', remote: args[3] });
    allocations.push(local);
    return { stdout: args[2] === 'tcp:0' ? local.slice(4) + '\n' : '' };
  };
  return { adb, mappings, allocations };
}

test('two devices with the same device port receive independent host routes; refresh reuses them', async () => {
  const server = adbServer();
  const first = await createBridgeForward({ serial: 'oppo-one' }, 18080, server.adb);
  const second = await createBridgeForward({ serial: 'oppo-two' }, 18080, server.adb);
  assert.notEqual(first.hostPort, second.hostPort);
  assert.deepEqual(await createBridgeForward({ serial: 'oppo-one' }, 18080, server.adb), first);
  assert.deepEqual(await createBridgeForward({ serial: 'oppo-two' }, 18080, server.adb), second);
  assert.equal(server.allocations.length, 2, 'cache expiry must not leak new forwards');
  await verifyBridgeForward({}, { ...first, devicePort: 18080 }, server.adb);
  await verifyBridgeForward({}, { ...second, devicePort: 18080 }, server.adb);
});

test('an explicit port conflict is exposed without replacing another device route', async () => {
  const server = adbServer();
  const ctx = { serial: 'oppo-one', explicitPort: true, port: 18080 };
  const first = await createBridgeForward(ctx, 18080, server.adb);
  assert.equal(first.hostPort, 18080);
  assert.deepEqual(await createBridgeForward(ctx, 18080, server.adb), first);
  await assert.rejects(createBridgeForward({ ...ctx, serial: 'oppo-two' }, 18080, server.adb), (error) => {
    assert.equal(normalizeBridgeError(error).code, 'bridge_forward_mismatch');
    return true;
  });
  assert.equal(server.mappings.get('tcp:18080').serial, 'oppo-one');
});

test('a cached route stolen by another ADB client prevents HTTP action dispatch', async () => {
  const server = adbServer();
  const ctx = { serial: 'oppo-one', forwardReused: true, forwardCacheKey: 'one' };
  const forward = { ...await createBridgeForward(ctx, 18080, server.adb), devicePort: 18080 };
  server.mappings.set(`tcp:${forward.hostPort}`, { serial: 'another-device', remote: 'tcp:18080' });
  let dispatches = 0;
  await assert.rejects(bridgeRequestWithCachedForward(ctx, async () => { dispatches += 1; }, {
    replaySafe: false,
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
  const forward = { ...await createBridgeForward({}, 18080, server.adb), devicePort: 18080 };
  assert.equal(forward.serial, 'only-device');
  server.mappings.clear();
  await assert.rejects(verifyBridgeForward({}, forward, server.adb), { aiAppBridgeForwardMismatch: true });
});
