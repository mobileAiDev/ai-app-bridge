'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openChildChannel } = require('../bin/power/child-channel');
const { createPlatformAdapter } = require('../bin/power/platform-adapters');
const windows = { skip: process.platform !== 'win32', timeout: 20000 };

// These are real PowerShell/Win32 calls on a Windows runner, not proof that a
// physical display stays on or that an explicit screen lock is prevented.
for (const mode of ['system', 'display', 'both']) test(`Windows native power ${mode} renews and releases on its original thread`, windows, async () => {
  const adapter = createPlatformAdapter();
  const first = await adapter({ target: { platform: 'host' }, leaseId: `ci-${mode}`, mode, ttlMs: 3000 });
  try {
    assert.equal(first.coverage.mechanism, 'SetThreadExecutionState');
    assert.ok(first.coverage.threadId > 0);
    assert.ok(first.coverage.pid > 0);
    assert.equal(first.coverage.system, mode !== 'display');
    assert.equal(first.coverage.display, mode !== 'system');
    const renewed = await first.renew({ ttlMs: 3000 });
    assert.equal(renewed.coverage.threadId, first.coverage.threadId);
    const released = await first.release();
    assert.equal(released.released, true);
    assert.equal(released.result.type, 'released');
    assert.equal(released.result.released, true);
  } finally { await first.release(); }
});

async function worker(ttlMs) {
  return openChildChannel('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    fs.readFileSync(path.join(__dirname, '../bin/power/windows.ps1'), 'utf8')],
  { env: { ...process.env, AAB_POWER_LEASE_ID: 'ci-native-expiry', AAB_POWER_MODE: 'both', AAB_POWER_TTL_MS: String(ttlMs) } });
}

test('Windows native power deadline and EOF release without a Host heartbeat', windows, async () => {
  const expiring = await worker(150);
  assert.equal((await expiring.exit).code, 0);
  assert.equal((await expiring.release()).confirmed, true);
  const disconnected = await worker(3000);
  disconnected.child.stdin.end();
  assert.equal((await disconnected.exit).code, 0);
  assert.equal((await disconnected.release()).confirmed, true);
});

test('overlapping Windows power leases release independently and report worker death', windows, async () => {
  const first = await worker(10000), second = await worker(10000);
  try {
    await first.release();
    assert.equal((await second.request('renew', { ttlMs: 3000 })).ok, true);
    second.child.kill('SIGKILL');
    await second.exit;
    await assert.rejects(second.request('renew', { ttlMs: 3000 }), { code: 'power_worker_closed' });
    assert.equal((await second.release()).confirmed, false);
  } finally { first.child.kill(); second.child.kill(); await Promise.all([first.exit, second.exit]); }
});
