'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPlatformAdapter } = require('../bin/power/platform-adapters');

function childProcess(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = signal => {
    child.signalCode = signal || 'SIGTERM';
    queueMicrotask(() => child.emit('close', null, child.signalCode));
    return true;
  };
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

const assertions = pid => [
  `pid ${pid}(caffeinate): PreventUserIdleSystemSleep`,
  `pid ${pid}(caffeinate): PreventUserIdleDisplaySleep`,
].join('\n');

test('macOS confirms a fresh OS sample after the event loop delays readiness polling', async t => {
  // The first poll precedes assertion registration. A synchronous history scan
  // delays the next poll past the observation budget while caffeinate is live.
  let clockReads = 0, probes = 0;
  t.mock.method(Date, 'now', () => ++clockReads <= 2 ? 1000 : 5000);
  const child = childProcess(4321);
  const adapter = createPlatformAdapter({ platform: 'darwin', spawnChild: () => child,
    run: async () => ({ stdout: ++probes === 1 ? '' : assertions(child.pid) }),
  });
  let handle;
  try {
    handle = await adapter({ target: { platform: 'host' }, mode: 'both', ttlMs: 60000 });
    assert.equal(probes, 2);
    assert.equal(handle.coverage.pid, child.pid);
    assert.equal(child.signalCode, null);
  } finally { if (handle) await handle.release(); }
  assert.equal(child.signalCode, 'SIGTERM');
});

test('macOS still rejects absent or foreign assertions after the final OS sample', async t => {
  let clockReads = 0, probes = 0;
  t.mock.method(Date, 'now', () => ++clockReads <= 2 ? 1000 : 5000);
  const child = childProcess(4321);
  const adapter = createPlatformAdapter({ platform: 'darwin', spawnChild: () => child,
    run: async () => { probes++; return { stdout: assertions(9876) }; },
  });
  await assert.rejects(adapter({ target: { platform: 'host' }, mode: 'both', ttlMs: 60000 }),
    { code: 'power_assertion_unconfirmed' });
  assert.equal(probes, 2);
  assert.equal(child.signalCode, 'SIGTERM');
});
