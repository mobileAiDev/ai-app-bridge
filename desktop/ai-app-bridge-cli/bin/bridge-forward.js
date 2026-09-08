'use strict';

async function listForwards(ctx, adb) {
  const { stdout } = await adb(ctx, ['forward', '--list']);
  return stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [serial, local, remote] = line.trim().split(/\s+/);
    return { serial, local, remote };
  });
}

function forwardMismatch(expected, actual) {
  const error = new Error(`bridge forward mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  error.aiAppBridgeForwardMismatch = true;
  return error;
}

async function createBridgeForward(ctx, devicePort, adb) {
  const serial = ctx.serial || (await adb(ctx, ['get-serialno'])).stdout.trim();
  const forwards = await listForwards(ctx, adb);
  const remote = `tcp:${devicePort}`;
  const existing = ctx.explicitPort
    ? forwards.find((entry) => entry.local === `tcp:${ctx.port}`)
    : forwards.find((entry) => entry.serial === serial && entry.remote === remote && /^tcp:\d+$/.test(entry.local));
  if (existing) {
    if (existing.serial !== serial || existing.remote !== remote) {
      throw forwardMismatch({ serial, local: `tcp:${ctx.port}`, remote }, existing);
    }
    return { serial, hostPort: Number(existing.local.slice(4)) };
  }

  // ADB owns the host port allocation. Device-local ports are not unique across phones.
  const { stdout } = await adb(ctx, ['forward', '--no-rebind', `tcp:${ctx.explicitPort ? ctx.port : 0}`, remote]);
  const hostPort = ctx.explicitPort ? ctx.port : Number(stdout.trim());
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
    throw new Error(`ADB returned an invalid allocated host port: ${stdout.trim()}`);
  }
  return { serial, hostPort };
}

async function verifyBridgeForward(ctx, connection, adb) {
  const expected = { serial: connection.serial, local: `tcp:${connection.hostPort}`, remote: `tcp:${connection.devicePort}` };
  const actual = (await listForwards(ctx, adb)).find((entry) => entry.local === expected.local);
  if (!actual || actual.serial !== expected.serial || actual.remote !== expected.remote) {
    throw forwardMismatch(expected, actual || null);
  }
}

module.exports = { createBridgeForward, verifyBridgeForward };
