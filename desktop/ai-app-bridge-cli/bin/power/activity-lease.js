'use strict';

// Real work touches this helper. Merely connecting a client does not.
// A later touch is a new work signal and can acquire after an earlier expiry.
function createActivityLeases({ manager, idleLeaseMs = 600000 }) {
  if (!Number.isSafeInteger(idleLeaseMs) || idleLeaseMs < 1 || idleLeaseMs > 86400000)
    throw new Error('idleLeaseMs must be an integer from 1 to 86400000 milliseconds.');
  const entries = new Map(); let closed = false;
  const targetKey = target => JSON.stringify(Object.entries(target).sort(([a], [b]) => a.localeCompare(b)));
  const keyOf = ({ ownerId, target, mode }) => JSON.stringify([ownerId, mode, targetKey(target)]);
  const warning = (error, entry) => ({ ok: false, warning: {
    code: error.code || 'power_activity_failed', message: error.message,
    ownerId: entry.ownerId, target: entry.target, mode: entry.mode,
    ...(error.lease ? { lease: error.lease } : {}),
  } });
  function serial(entry, operation) {
    entry.pending++;
    const result = entry.tail.then(operation); entry.tail = result.catch(() => {});
    return result.finally(() => {
      entry.pending--;
      if (!entry.pending && !entry.leaseId) entries.delete(entry.key);
    });
  }
  async function release(entry) {
    if (!entry.leaseId) return { ok: true, released: true };
    try {
      const lease = await manager.release({ leaseId: entry.leaseId }); entry.leaseId = null;
      if (lease.release.released !== true) return warning(Object.assign(new Error(lease.release.message ||
        'The platform did not confirm release; its assertion TTL still applies.'),
        { code: lease.release.error || 'power_release_unconfirmed', lease }), entry);
      return { ok: true, lease };
    } catch (error) {
      // The manager only prunes terminal leases; absence cannot own an active
      // assertion. Transport/release errors remain warnings during shutdown.
      if (error.code === 'power_lease_not_found') {
        entry.leaseId = null;
        return { ok: true, released: true, reason: 'terminal_record_pruned' };
      }
      return warning(error, entry);
    }
  }
  return {
    async touch(input) {
      if (closed) return warning(Object.assign(new Error('The activity lease helper has closed.'), { code: 'power_activity_closed' }), input);
      let entry;
      try {
        const key = keyOf(input);
        entry = entries.get(key);
        if (!entry) { entry = { ...structuredClone(input), key, leaseId: null, pending: 0, tail: Promise.resolve() }; entries.set(key, entry); }
        return await serial(entry, async () => {
          if (closed) throw Object.assign(new Error('The activity lease helper has closed.'), { code: 'power_activity_closed' });
          let current;
          if (entry.leaseId) {
            try { current = manager.status({ leaseId: entry.leaseId }); }
            catch (error) { if (error.code !== 'power_lease_not_found') throw error; } // A retained terminal record may have been pruned.
          }
          const lease = current?.state === 'active'
            ? await manager.renew({ leaseId: entry.leaseId, leaseMs: idleLeaseMs, refreshAssertion: false })
            : await manager.acquire({ ownerId: entry.ownerId, target: entry.target, mode: entry.mode, leaseMs: idleLeaseMs });
          if (lease.state !== 'active') throw Object.assign(new Error(lease.error?.message || 'The activity power lease is not active.'),
            { code: lease.error?.code || 'power_activity_inactive', lease });
          entry.leaseId = lease.leaseId;
          return { ok: true, lease };
        });
      } catch (error) { return warning(error, entry || input); }
    },
    async end({ ownerId, target } = {}) {
      if (typeof ownerId !== 'string' || !ownerId) throw new Error('An explicit activity ownerId is required.');
      return Promise.all([...entries.values()].filter(entry => entry.ownerId === ownerId &&
        (target === undefined || targetKey(target) === targetKey(entry.target))).map(entry => serial(entry, () => release(entry))));
    },
    async close() {
      closed = true;
      return Promise.all([...entries.values()].map(entry => serial(entry, () => release(entry))));
    },
  };
}

module.exports = { createActivityLeases };
