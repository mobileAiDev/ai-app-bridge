'use strict';

function createBoundedScriptRegistry({
  maxOperations = 256,
  maxEvents = 256,
  maxEventBytes = 256 * 1024,
} = {}) {
  const operations = new Map();

  function put(operationId, record) {
    const existing = operations.get(operationId);
    if (existing && !isTerminal(existing.status)) {
      return { ok: false, error: 'operation_exists' };
    }
    if (!existing && operations.size >= maxOperations) evict();
    if (!existing && operations.size >= maxOperations) {
      return { ok: false, error: 'registry_full' };
    }
    operations.set(operationId, record);
    return { ok: true, record };
  }

  function get(operationId) {
    return operations.get(operationId) || null;
  }

  function evict() {
    for (const [id, record] of operations) {
      if (operations.size < maxOperations) return;
      if (isTerminal(record.status)) operations.delete(id);
    }
  }

  function retainedBytes() {
    let total = 0;
    for (const record of operations.values()) {
      total += record.events?.bytes || 0;
    }
    return total;
  }

  return {
    put,
    get,
    evict,
    retainedBytes,
    get size() { return operations.size; },
    maxOperations,
    maxEvents,
    maxEventBytes,
  };
}

function createBoundedEventLog({ maxEvents = 256, maxEventBytes = 256 * 1024 } = {}) {
  const events = [];
  const waiters = new Set();
  let sequence = 0;
  let bytes = 0;

  function emit(type, extra = {}, now = Date.now) {
    sequence += 1;
    const event = { sequence, type, atMs: typeof now === 'function' ? now() : now, ...extra };
    const encoded = Buffer.byteLength(JSON.stringify(event), 'utf8');
    events.push({ event, encoded });
    bytes += encoded;
    while (events.length > maxEvents || bytes > maxEventBytes) {
      const removed = events.shift();
      if (!removed) break;
      bytes -= removed.encoded;
    }
    for (const waiter of waiters) waiter();
    return event;
  }

  function subscribe(waiter) {
    waiters.add(waiter);
    return () => waiters.delete(waiter);
  }

  function after(afterSequence = 0, limit = null) {
    const selected = events
      .map((item) => item.event)
      .filter((event) => event.sequence > afterSequence);
    if (limit == null) return selected;
    return selected.slice(0, Number(limit));
  }

  return {
    emit,
    after,
    subscribe,
    get sequence() { return sequence; },
    get size() { return events.length; },
    get bytes() { return bytes; },
  };
}

function isTerminal(status) {
  return status === 'completed' || status === 'cancelled' || status === 'failed';
}

module.exports = { createBoundedScriptRegistry, createBoundedEventLog };
