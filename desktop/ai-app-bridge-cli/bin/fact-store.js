'use strict';

const { createSegmentedFactStoreAdapter } = require('./segmented-fact-store');

/**
 * Stable FactStore Module boundary.
 *
 * Runtime callers use record for an immediate commit or offer for a bounded
 * asynchronous write, then read/status. Segment layout, recovery, quotas,
 * cursors and diagnostic adapters remain implementation details.
 */
class FactStore {
  constructor(adapter, { queueLimit = 256, schedule = setImmediate } = {}) {
    assertAdapter(adapter);
    if (!Number.isInteger(queueLimit) || queueLimit < 1) {
      throw new TypeError('queueLimit must be a positive integer');
    }
    if (typeof schedule !== 'function') throw new TypeError('schedule must be a function');
    this.adapter = adapter;
    this.queueLimit = queueLimit;
    this.schedule = schedule;
    this.queue = [];
    this.scheduled = false;
    this.flushing = false;
    this.flushPromise = null;
    this.drainWaiters = [];
    this.closed = false;
    this.writerAvailable = true;
    this.writerReason = null;
    this.writerDropped = 0;
    this.writerLastError = null;
  }

  record(facts, options = {}) {
    if (this.closed) throw new Error('FactStore is closed');
    const list = Array.isArray(facts) ? facts : [facts];
    if (list.length === 0) return { ok: true, receipts: [], count: 0 };
    const receipts = list.map((fact) => this.adapter.record(fact, options));
    if (receipts.some(isPromise)) {
      throw new TypeError('FactStore.record must complete synchronously; use offer for asynchronous writes');
    }
    return {
      ok: receipts.every((receipt) => receipt?.ok !== false),
      receipts,
      count: receipts.length,
      ...(Array.isArray(facts) ? {} : { receipt: receipts[0] }),
    };
  }

  offer(facts, options = {}) {
    if (this.closed) return rejectedOffer('closed');
    if (!this.writerAvailable) return rejectedOffer(this.writerReason || 'unavailable');
    if (this.queue.length >= this.queueLimit) {
      this.writerDropped += 1;
      return rejectedOffer('queue_full');
    }
    let resolveCompletion;
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    this.queue.push({ facts, options, resolveCompletion });
    this.kick();
    return { accepted: true, completion };
  }

  read(query = {}) {
    return this.adapter.read(query);
  }

  status() {
    return {
      ...this.adapter.status(),
      writer: {
        available: !this.closed && this.writerAvailable,
        reason: this.closed ? 'closed' : this.writerReason,
        queueLength: this.queue.length,
        dropped: this.writerDropped,
        lastError: this.writerLastError,
        flushing: this.flushing,
      },
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.queue.length > 0) {
      this.writerDropped += this.queue.length;
      this.settleQueuedFailures('closed');
    }
    this.adapter.close?.();
  }

  async drain() {
    if (this.queue.length === 0 && !this.flushing && !this.scheduled) return;
    this.kick();
    await new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  kick() {
    if (this.scheduled || this.flushing || this.queue.length === 0 || !this.writerAvailable) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      void this.flush();
    });
  }

  flush() {
    if (this.flushPromise) return this.flushPromise;
    this.flushing = true;
    this.flushPromise = (async () => {
      while (this.queue.length > 0 && this.writerAvailable) {
        const item = this.queue[0];
        const result = await recordAsync(this.adapter, item.facts, item.options);
        item.resolveCompletion(result);
        this.queue.shift();
        if (result.ok === false) {
          this.writerLastError = result.error || 'persist_failed';
          if (isTerminalWriterError(result.error)) {
            this.writerAvailable = false;
            this.writerReason = result.error;
            this.writerDropped += this.queue.length;
            this.settleQueuedFailures(result.error);
          }
        }
      }
    })().finally(() => {
      this.flushing = false;
      this.flushPromise = null;
      this.resolveDrainWaiters();
      this.kick();
    });
    return this.flushPromise;
  }

  settleQueuedFailures(error) {
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      item.resolveCompletion({ ok: false, stored: false, error });
    }
  }

  resolveDrainWaiters() {
    if (this.queue.length > 0 || this.flushing || this.scheduled) return;
    for (const resolve of this.drainWaiters.splice(0)) resolve();
  }

}

function createSegmentedFactStore(options = {}) {
  return new FactStore(createSegmentedFactStoreAdapter(options), {
    queueLimit: options.queueLimit,
    schedule: options.schedule,
  });
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

async function recordAsync(adapter, facts, options) {
  const list = Array.isArray(facts) ? facts : [facts];
  if (list.length === 0) return { ok: true, receipts: [], count: 0 };
  const receipts = [];
  try {
    for (const fact of list) {
      receipts.push(await adapter.record(fact, options));
    }
  } catch (error) {
    return {
      ok: false,
      stored: false,
      error: error.code || error.message || 'persist_failed',
      detail: error.message || String(error),
    };
  }
  return {
    ok: receipts.every((receipt) => receipt?.ok !== false),
    receipts,
    count: receipts.length,
    ...(Array.isArray(facts) ? {} : {
      receipt: receipts[0],
      stored: receipts[0]?.stored,
      error: receipts[0]?.error,
    }),
  };
}

function isPromise(value) {
  return value && typeof value.then === 'function';
}

function isTerminalWriterError(error) {
  return error === 'ENOSPC' || error === 'fact_store_disabled';
}

function rejectedOffer(reason) {
  return { accepted: false, reason };
}

module.exports = {
  FactStore,
  createFactStore,
  createSegmentedFactStore,
};
