'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { createIOSRuntimeFixture } = require('../test-support/ios-runtime-fixture');
const { executeCommand } = require('../test-support/host-client');
const { runExecution } = require('../bin/shared-kernel/execution-scope');
const host = require('../bin/execution-host');

// Exercise the production Host command path, real iOS descriptor discovery,
// binding headers and HTTP transport. Only devicectl and the SDK are fixtures;
// no attached device or native Host power assertion is used.
test('iOS work assertions outlive commands, retain cancellation boundaries, and close with the Host', { timeout: 60000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-power-ios-lifecycle-'));
  const calls = [], remote = new Set();
  let device, holdReleaseFor = null, releaseReceived;
  const server = http.createServer(async (request, response) => {
    let bytes = ''; for await (const chunk of request) bytes += chunk;
    const body = JSON.parse(bytes);
    calls.push({ ...body, epoch: request.headers['x-aab-runtime-epoch'] });
    assert.equal(request.url, '/v1/power');
    assert.equal(request.headers['x-aab-runtime-epoch'], device.binding.runtimeEpoch);
    assert.equal(request.headers['x-aab-process-id'], String(device.binding.processId));
    if (body.operation === 'acquire') remote.add(body.leaseId);
    if (body.operation === 'renew') assert.ok(remote.has(body.leaseId));
    if (body.operation === 'release') {
      remote.delete(body.leaseId);
      if (body.leaseId === holdReleaseFor) { releaseReceived(); return; }
    }
    response.end(JSON.stringify({ ok: true, runtimeBinding: device.binding,
      released: body.operation === 'release', coverage: { display: true, scope: 'selected-sdk-app-foreground' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  device = createIOSRuntimeFixture(directory, { port: server.address().port, deviceId: path.basename(directory) });
  t.after(async () => {
    await host.close();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const target = { platform: 'ios', ...device.args };
  const acquire = ownerId => executeCommand('power', { operation: 'acquire', ownerId, target, mode: 'display', leaseMs: 120000 });
  const renewedCount = leaseId => calls.filter(call => call.operation === 'renew' && call.leaseId === leaseId).length;
  async function awaitRenewal(leaseId, count) {
    const deadline = Date.now() + 20000;
    while (renewedCount(leaseId) < count && Date.now() < deadline) {
      const status = await executeCommand('power', { operation: 'status', leaseId });
      assert.equal(status.state, 'active', JSON.stringify(status));
      await delay(25);
    }
    assert.ok(renewedCount(leaseId) >= count, 'the production 15-second timer must reach the bound SDK');
  }

  const first = await acquire('explicit-release-owner');
  const survivor = await acquire('surviving-work-owner');
  assert.equal(first.state, 'active'); assert.equal(survivor.state, 'active');
  await awaitRenewal(first.leaseId, 1);
  await awaitRenewal(survivor.leaseId, 1);

  // Renew re-arms a timer inside a new command scope. Settling and then aborting
  // that command must not poison the next refresh of the same work lease.
  const caller = new AbortController();
  const explicitRenewal = await runExecution({ timeoutMs: 5000, signal: caller.signal }, () =>
    executeCommand('power', { operation: 'renew', leaseId: survivor.leaseId, leaseMs: 120000 }));
  assert.equal(explicitRenewal.state, 'active');
  caller.abort({ code: 'cancelled' });
  const afterExplicitRenewal = renewedCount(survivor.leaseId);

  // An explicit release still belongs to its own live command. Cancelling its
  // HTTP response must remain an unconfirmed release, without cancelling peers.
  const releaseController = new AbortController();
  holdReleaseFor = first.leaseId;
  const received = new Promise(resolve => { releaseReceived = resolve; });
  const release = runExecution({ timeoutMs: 5000, signal: releaseController.signal }, () =>
    executeCommand('power', { operation: 'release', leaseId: first.leaseId }));
  await received; releaseController.abort({ code: 'cancelled' });
  const released = await release;
  assert.equal(released.ok, false);
  assert.equal(released.error, 'power_release_unconfirmed');
  assert.equal(released.release.error, 'cancelled');
  assert.equal(released.release.boundedByPlatformExpiry, true);
  assert.equal(remote.has(first.leaseId), false);

  await awaitRenewal(survivor.leaseId, afterExplicitRenewal + 1);
  assert.equal(remote.has(survivor.leaseId), true);
  const releaseNormally = await acquire('normal-release-owner');
  const normal = await executeCommand('power', { operation: 'release', leaseId: releaseNormally.leaseId });
  assert.equal(normal.ok, true); assert.equal(normal.release.released, true);

  // Runtime shutdown releases the assertion from its own lifecycle, even
  // though the command that originally acquired it settled long ago.
  await host.close();
  assert.equal(remote.size, 0);
  assert.equal(calls.filter(call => call.operation === 'release' && call.leaseId === survivor.leaseId).length, 1);
  const afterClose = await host.run({ command: 'power', extract: null, arguments: { operation: 'status' } });
  assert.equal(afterClose.value.value.error, 'runtime_stopping');
});
