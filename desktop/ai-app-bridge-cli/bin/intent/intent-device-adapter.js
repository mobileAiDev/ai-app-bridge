'use strict';

function createFakeIntentDeviceAdapter({
  trees = {},
  actionResult = { ok: true, mechanicalStatus: 'ok', ambiguous: false },
  delayMs = 0,
  hang = false,
} = {}) {
  let currentActive = 0;
  let maxActive = 0;
  const calls = [];

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
    async observe({ provider, rawTreeId, packageName }) {
      return run('observe', async () => ({
        ok: true,
        provider,
        rawTreeId,
        rawTree: trees[provider] || trees.default || {
          root: { id: 'home', className: 'Button', text: 'Home', clickable: true, children: [] },
        },
        foregroundTarget: packageName,
      }));
    },
    async action({ spec }) {
      return run('action', async () => ({ ...actionResult, spec }));
    },
  };
}

module.exports = { createFakeIntentDeviceAdapter };
