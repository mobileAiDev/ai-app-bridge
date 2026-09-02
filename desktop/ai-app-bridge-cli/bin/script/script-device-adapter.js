'use strict';

const { androidAppTargetKey } = require('../shared-kernel/target-lease-protocol');

function createFakeScriptDeviceAdapter({
  trees = {},
  actionResult = { ok: true, mechanicalStatus: 'ok', ambiguous: false },
  lease,
  delayMs = 0,
  hang = false,
} = {}) {
  let currentActive = 0;
  let maxActive = 0;
  const calls = [];

  async function withLease(serial, packageName, name, fn) {
    if (lease) {
      const held = lease.acquire(androidAppTargetKey(serial, packageName));
      if (!held.ok) return { ...held, serial, packageName };
      try {
        return await run(name, fn);
      } finally {
        held.release();
      }
    }
    return run(name, fn);
  }

  async function run(name, fn) {
    currentActive += 1;
    maxActive = Math.max(maxActive, currentActive);
    calls.push({ name, atMs: Date.now() });
    try {
      if (hang) return new Promise(() => {});
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return await fn();
    } finally {
      currentActive -= 1;
    }
  }

  return {
    calls,
    get maxActive() { return maxActive; },
    get callCount() { return calls.length; },
    async observe({ serial, packageName, provider, rawTreeId }) {
      return withLease(serial, packageName, 'observe', async () => ({
        ok: true,
        provider,
        rawTreeId,
        rawTree: trees[provider] || trees.default || { root: { id: 'root', text: 'Home', children: [] } },
        foregroundTarget: `${packageName}/.Main`,
      }));
    },
    async action({ serial, packageName, spec }) {
      return withLease(serial, packageName || spec.packageName, 'action', async () => ({
        ...actionResult,
        spec,
      }));
    },
    async foreground({ serial, packageName }) {
      return withLease(serial, packageName, 'foreground', async () => ({
        ok: true,
        serial,
        packageName,
        foregroundTarget: `${packageName}/.Main`,
      }));
    },
  };
}

module.exports = { createFakeScriptDeviceAdapter };
