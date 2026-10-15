'use strict';

const { createActivityLeases } = require('./activity-lease');

// Ordinary work leaves a bounded window for the next agent turn. Workflows
// additionally own deadline-bound assertions, released at their own terminal.
// A failed assertion is information; it never rejects the requested App action.
function createWorkPower({ manager, activity = createActivityLeases({ manager }), enabled = process.env.AI_APP_BRIDGE_POWER_AUTO !== 'off', now = Date.now }) {
  const operations = new Map(), warnings = [], unavailable = new Map();
  const ownerId = 'bridge-interactive-work';
  const keyOf = target => JSON.stringify(Object.entries(target).sort(([a], [b]) => a.localeCompare(b)));
  function remember(warning) { warnings.push(warning); if (warnings.length > 20) warnings.shift(); return warning; }
  function targets(target) {
    return [{ target: { platform: 'host' }, mode: 'both' },
      ...(target?.platform === 'android' && target.serial ? [{ target: { platform: 'android', serial: target.serial,
        ...(target.adb ? { adb: target.adb } : {}) }, mode: 'both' }] : []),
      ...(target?.platform === 'ios' && target.deviceId && target.bundleId ? [{ target: { platform: 'ios', ...target },
        mode: 'display', recovery: 'reacquire-ended' }] : [])];
  }
  function note(error, target) { return remember({ code: error.code || 'power_activity_failed', blocking: false,
    message: error.message, target, ...(error.lease ? { lease: error.lease } : {}) }); }
  function failedProtection(warning) {
    const value = remember({ ...warning, blocking: false, retryAtMs: now() + 30000,
      nextAction: 'Automatic protection retries after 30 seconds. Use power acquire for an immediate explicit attempt.' });
    unavailable.set(keyOf(warning.target), value); return value;
  }
  function retryWarning(target) {
    const key = keyOf(target), warning = unavailable.get(key);
    if (warning && warning.retryAtMs > now()) return warning;
    unavailable.delete(key); return null;
  }
  function activityWarnings(results) { return results.filter(result => !result.ok).map(result => note(result.warning, result.warning.target)); }
  async function release(pending) {
    return Promise.all((await pending).map(async lease => {
      try {
        const result = await manager.release({ leaseId: lease.leaseId });
        if (result.release?.released !== true) note({ code: result.release?.error || 'power_release_unconfirmed',
          message: 'Platform release is unconfirmed; the assertion TTL still bounds it.', lease: result }, lease.target);
        return result;
      } catch (error) { if (error.code !== 'power_lease_not_found') return note(error, lease.target); }
    }));
  }
  return {
    status: () => ({ enabled, idleWindowMs: 600000, activeOperations: [...operations.keys()], warnings: structuredClone(warnings) }),
    async configure(value) {
      enabled = value;
      unavailable.clear();
      if (!enabled) {
        activityWarnings(await activity.end({ ownerId }));
        const pending = [...operations.values()]; operations.clear();
        await Promise.all(pending.map(release));
      }
      return this.status();
    },
    async beforeCommand(command, args) {
      if (!enabled || ['power', 'runtime', 'response', 'evidence', 'doctor', 'device-ownership', 'script', 'intent'].includes(command) || args.history === true) return [];
      const contract = require('../command-registry').commandContract(command);
      let target = null;
      if (contract.platform === 'android' && args.serial) target = { platform: 'android', serial: args.serial, ...(args.adb ? { adb: args.adb } : {}) };
      if (require('../ios-runtime-binding').sdkCommands.has(command) && args.deviceId && args.bundleId) {
        target = Object.fromEntries(['deviceId', 'bundleId', 'runtimeUrl', 'iosHost', 'iosPort', 'devicectl'].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
        target.platform = 'ios';
      }
      if (!target && !['web', 'android', 'ios'].includes(contract.platform)) return [];
      const results = await Promise.all(targets(target).map(async item => {
        const previous = retryWarning(item.target);
        if (previous) return previous;
        const result = await activity.touch({ ownerId, ...item });
        return result.ok ? null : failedProtection(result.warning);
      }));
      return results.filter(Boolean);
    },
    begin({ ownerId, target, timeoutMs }) {
      if (!enabled || operations.has(ownerId)) return;
      const leaseMs = Math.min(timeoutMs ?? 600000, 86400000);
      const pending = Promise.all(targets(target).map(async item => {
        if (retryWarning(item.target)) return null;
        try {
          const lease = await manager.acquire({ ownerId, ...item, leaseMs });
          if (lease.state === 'active') return lease;
          failedProtection({ code: lease.error?.code || 'power_activity_inactive',
            message: lease.error?.message || 'The work power lease did not become active.', target: item.target, lease });
        } catch (error) { failedProtection({ code: error.code || 'power_activity_failed', message: error.message,
          target: item.target, ...(error.lease ? { lease: error.lease } : {}) }); }
        return null;
      })).then(values => values.filter(Boolean));
      operations.set(ownerId, pending);
    },
    async end({ ownerId }) {
      const pending = operations.get(ownerId);
      if (!pending) return;
      operations.delete(ownerId); await release(pending);
    },
    async close() {
      enabled = false;
      const pending = [...operations.values()]; operations.clear();
      await Promise.all([activity.close().then(activityWarnings), ...pending.map(release)]);
    },
  };
}

module.exports = { createWorkPower };
