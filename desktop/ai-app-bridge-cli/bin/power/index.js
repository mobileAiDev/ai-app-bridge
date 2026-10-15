'use strict';

const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createPlatformAdapter } = require('./platform-adapters');
const { withoutExecution } = require('../shared-kernel/execution-scope');

const modes = ['system', 'display', 'both'];
const fail = (code, message, details) => Object.assign(new Error(message), { code, details });
const duration = (value, field, maximum) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw fail('invalid_power_lease', `${field} must be an integer from 1 to ${maximum} milliseconds.`);
  return value;
};

// A logical work lease is separate from its short-lived platform assertion.
// Refresh never extends work. The caller extends work, or binds it to an
// operation deadline; platform refreshes continue during ordinary agent pauses.
function createPowerManager({ acquireAdapter = createPlatformAdapter(), assertionTtlMs = 60000, refreshMs = 15000,
  now = () => performance.now(), wallNow = Date.now, schedule = setTimeout, unschedule = clearTimeout } = {}) {
  duration(assertionTtlMs, 'assertionTtlMs', 300000); duration(refreshMs, 'refreshMs', assertionTtlMs - 1);
  const leases = new Map(); let closed = false;
  const terminal = lease => ['released', 'expired', 'failed'].includes(lease.state);
  const view = lease => ({ leaseId: lease.id, ownerId: lease.ownerId, target: lease.target, mode: lease.mode,
    recovery: lease.recovery, ...(lease.assertionRecovery ? { assertionRecovery: { ...lease.assertionRecovery } } : {}),
    state: lease.state, createdAtMs: lease.createdAtMs,
    expiresAtMs: lease.expiresAtMs, remainingMs: terminal(lease) ? 0 : Math.max(0, Math.ceil(lease.deadline - now())),
    assertionTtlMs, refreshMs, coverage: lease.coverage,
    lastRefreshAtMs: lease.lastRefreshAtMs, platformExpiresAtMs: lease.platformExpiresAtMs,
    ...(lease.error ? { error: lease.error } : {}), ...(lease.release ? { release: lease.release } : {}) });
  const get = id => {
    const lease = leases.get(id);
    if (!lease) throw fail('power_lease_not_found', 'No retained work lease matches this leaseId.');
    return lease;
  };
  const serial = (lease, operation) => {
    const result = lease.tail.then(operation); lease.tail = result.catch(() => {}); return result;
  };
  function bindHandle(lease, handle) {
    lease.handle = handle;
    if (!handle.ended) return;
    // Close notifications share the lease queue with renew/release. A normal
    // finish or a late exit from a replaced handle cannot fail its successor.
    void handle.ended.then(error => withoutExecution(() => serial(lease, async () => {
      if (terminal(lease) || lease.handle !== handle) return;
      lease.error = { code: error.code || 'power_assertion_lost', message: error.message, details: error.details };
      await finish(lease, 'failed');
    }))).catch(() => {});
  }
  function stopTimer(lease) { if (lease.timer) unschedule(lease.timer); lease.timer = null; }
  function confirmed(lease, coverage, ttlMs) {
    lease.coverage = coverage; lease.lastRefreshAtMs = wallNow(); lease.platformDeadline = now() + ttlMs;
    // This is an upper bound: macOS native -t rounds to whole seconds.
    const roundingMs = coverage.expiryResolutionMs === undefined ? 0 : coverage.expiryResolutionMs - 1;
    lease.platformExpiresAtMs = lease.lastRefreshAtMs + ttlMs + roundingMs;
  }
  async function finish(lease, state) {
    stopTimer(lease);
    if (terminal(lease)) return view(lease);
    lease.state = state;
    try { lease.release = lease.handle ? await lease.handle.release() : {
      released: false, reason: 'acquisition_not_confirmed', boundedByPlatformExpiry: true,
    }; }
    catch (error) { lease.release = { released: false, error: error.code || 'power_release_failed', message: error.message,
      boundedByPlatformExpiry: true, platformExpiresAtMs: lease.platformExpiresAtMs }; }
    return view(lease);
  }
  function arm(lease) {
    stopTimer(lease);
    if (lease.state !== 'active') return;
    // Platform refresh belongs to the work lease, not to the command that
    // acquired or renewed it. Explicit calls retain their own execution scope.
    lease.timer = withoutExecution(() => schedule(() => {
      lease.timer = null;
      void serial(lease, () => refresh(lease)).catch(() => {});
    }, Math.max(1, Math.min(refreshMs, lease.deadline - now()))));
    lease.timer.unref?.();
  }
  async function refresh(lease) {
    if (lease.state !== 'active') return view(lease);
    if (now() >= lease.deadline) return finish(lease, 'expired');
    const ttlMs = Math.max(1, Math.min(assertionTtlMs, Math.ceil(lease.deadline - now())));
    try {
      let result, refreshedTtlMs = ttlMs;
      try { result = await lease.handle.renew({ ttlMs }); }
      catch (error) {
        // The logical work is still live, but this selected SDK has confirmed
        // its assertion no longer exists. Recovery is an explicit policy;
        // transport errors, foreground loss and identity mismatches stay errors.
        if (lease.recovery !== 'reacquire-ended' || error.code !== 'power_lease_ended') throw error;
        if (closed) return finish(lease, 'released');
        if (now() >= lease.deadline) return finish(lease, 'expired');
        refreshedTtlMs = Math.max(1, Math.min(assertionTtlMs, Math.ceil(lease.deadline - now())));
        lease.assertionRecovery = { attempts: (lease.assertionRecovery?.attempts || 0) + 1,
          reason: error.code, startedAtMs: wallNow(), confirmed: false };
        // The old assertion ended. Its confirmed expiry cannot bound a new
        // acquisition whose response may be lost.
        lease.platformDeadline = undefined; lease.platformExpiresAtMs = undefined;
        bindHandle(lease, await acquireAdapter({ leaseId: lease.id, target: lease.target, mode: lease.mode, ttlMs: refreshedTtlMs }));
        lease.assertionRecovery.confirmed = true;
        lease.assertionRecovery.completedAtMs = wallNow();
        result = { coverage: lease.handle.coverage };
      }
      confirmed(lease, result.coverage, refreshedTtlMs);
      if (closed) return finish(lease, 'released');
      if (now() >= lease.deadline) return finish(lease, 'expired');
      arm(lease); return view(lease);
    } catch (error) {
      lease.error = { code: error.code || 'power_refresh_failed', message: error.message, details: error.details };
      await finish(lease, 'failed'); return view(lease);
    }
  }
  return {
    async acquire({ ownerId, target, mode, leaseMs, recovery = 'manual' }) {
      if (closed) throw fail('power_manager_closed', 'The work power manager has closed.');
      if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 256 || !target || typeof target !== 'object' || Array.isArray(target) || !modes.includes(mode))
        throw fail('invalid_power_lease', 'Supply ownerId, an explicit target and mode system, display or both.');
      duration(leaseMs, 'leaseMs', 86400000);
      if (!['manual', 'reacquire-ended'].includes(recovery) || (recovery === 'reacquire-ended' && target.platform !== 'ios'))
        throw fail('invalid_power_recovery', 'Use manual recovery, or reacquire-ended for a selected iOS SDK App.');
      if ([...leases.values()].filter(lease => !terminal(lease)).length >= 64)
        throw fail('power_lease_capacity', 'Release an active work lease before acquiring another.');
      if (leases.size >= 256) for (const [id, lease] of leases) if (terminal(lease)) { leases.delete(id); break; }
      const createdAtMs = wallNow();
      const lease = { id: randomUUID(), ownerId, target: structuredClone(target), mode, recovery, state: 'acquiring',
        createdAtMs, expiresAtMs: createdAtMs + leaseMs, deadline: now() + leaseMs, tail: Promise.resolve() };
      leases.set(lease.id, lease);
      return serial(lease, async () => {
        const ttlMs = Math.min(assertionTtlMs, leaseMs);
        try {
          bindHandle(lease, await acquireAdapter({ leaseId: lease.id, target: lease.target, mode, ttlMs }));
          confirmed(lease, lease.handle.coverage, ttlMs); lease.state = 'active';
          if (closed) return finish(lease, 'released');
          if (now() >= lease.deadline) return finish(lease, 'expired');
          arm(lease); return view(lease);
        } catch (error) {
          lease.error = { code: error.code || 'power_acquire_failed', message: error.message, details: error.details };
          await finish(lease, 'failed'); throw Object.assign(error, { lease: view(lease) });
        }
      });
    },
    renew({ leaseId, leaseMs, refreshAssertion = true }) {
      duration(leaseMs, 'leaseMs', 86400000); const lease = get(leaseId);
      if (typeof refreshAssertion !== 'boolean') throw fail('invalid_power_lease', 'refreshAssertion must be a boolean.');
      return serial(lease, async () => {
        if (closed || terminal(lease) || now() >= lease.deadline) {
          if (!terminal(lease)) await finish(lease, 'expired');
          throw fail('power_lease_ended', 'This work lease has ended. Acquire a new explicit work lease.', view(lease));
        }
        lease.deadline = now() + leaseMs; lease.expiresAtMs = wallNow() + leaseMs;
        // Activity calls extend work without an OS call per UI action. The
        // existing timer remains armed; near-expiry assertions renew now.
        if (!refreshAssertion && lease.platformDeadline - now() > refreshMs) return view(lease);
        return refresh(lease);
      });
    },
    release({ leaseId }) { const lease = get(leaseId); return serial(lease, () => finish(lease, 'released')); },
    status({ leaseId } = {}) { return leaseId ? view(get(leaseId)) : { closed, leases: [...leases.values()].map(view) }; },
    async close() {
      closed = true;
      return Promise.all([...leases.values()].map(lease => serial(lease, () => finish(lease, 'released'))));
    },
  };
}

module.exports = { createPowerManager, modes };
