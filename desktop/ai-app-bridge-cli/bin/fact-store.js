'use strict';

const { createSegmentedFactStoreAdapter } = require('./segmented-fact-store');

/**
 * Stable FactStore Module boundary.
 *
 * Runtime callers use only record/read/status. Segment layout, recovery,
 * quotas, cursors and diagnostic adapters remain implementation details.
 */
class FactStore {
  constructor(adapter) {
    assertAdapter(adapter);
    this.adapter = adapter;
  }

  record(facts, options = {}) {
    const list = Array.isArray(facts) ? facts : [facts];
    if (list.length === 0) return { ok: true, receipts: [], count: 0 };
    const receipts = list.map((fact) => this.adapter.record(fact, options));
    return {
      ok: receipts.every((receipt) => receipt?.ok !== false),
      receipts,
      count: receipts.length,
      ...(Array.isArray(facts) ? {} : { receipt: receipts[0] }),
    };
  }

  read(query = {}) {
    return this.adapter.read(query);
  }

  status() {
    return this.adapter.status();
  }

  close() {
    this.adapter.close?.();
  }

}

function createSegmentedFactStore(options = {}) {
  return new FactStore(createSegmentedFactStoreAdapter(options));
}

/**
 * Production factory. Segmented mmap is the only authoritative fact-payload
 * implementation. SQLite belongs exclusively to the rebuildable query
 * projection inside SegmentedFactStore; it is never a second payload backend
 * and native-load failures are never hidden by switching storage engines.
 */
function createFactStore(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'backend')) {
    throw new TypeError('FactStore backend selection is not supported; segmented mmap is authoritative');
  }
  return createSegmentedFactStore(options);
}

function assertAdapter(adapter) {
  if (
    !adapter
    || typeof adapter.record !== 'function'
    || typeof adapter.read !== 'function'
    || typeof adapter.status !== 'function'
  ) {
    throw new TypeError('FactStore adapter must implement record/read/status');
  }
}

module.exports = {
  FactStore,
  createFactStore,
  createSegmentedFactStore,
};
