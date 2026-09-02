'use strict';

function createHistorySink({
  adapter = null,
  adapterFactory = null,
  queueLimit = 256,
  now = Date.now,
} = {}) {
  const state = {
    available: true,
    reason: null,
    queue: [],
    dropped: 0,
    lastError: null,
    flushing: false,
    adapter: null,
  };

  try {
    state.adapter = adapterFactory ? adapterFactory() : adapter;
  } catch (error) {
    return deadSink('init_failed', error);
  }
  if (!state.adapter || typeof state.adapter.record !== 'function') {
    return deadSink('init_failed', new Error('adapter with record is required'));
  }

  function offer(fact) {
    try {
      if (!state.available) {
        return { accepted: false, reason: state.reason || 'unavailable' };
      }
      if (state.queue.length >= queueLimit) {
        state.dropped += 1;
        return { accepted: false, reason: 'queue_full' };
      }
      state.queue.push({ fact, acceptedAtMs: now() });
      kick();
      return { accepted: true };
    } catch (error) {
      state.lastError = error.message || String(error);
      return { accepted: false, reason: 'offer_failed' };
    }
  }

  function status() {
    return {
      available: state.available,
      reason: state.reason,
      queueLength: state.queue.length,
      dropped: state.dropped,
      lastError: state.lastError,
      flushing: state.flushing,
    };
  }

  function kick() {
    if (state.flushing) return;
    state.flushing = true;
    setImmediate(() => {
      flush().finally(() => {
        state.flushing = false;
        if (state.queue.length > 0 && state.available) kick();
      });
    });
  }

  async function flush() {
    while (state.queue.length > 0) {
      const item = state.queue[0];
      try {
        const result = state.adapter.record(item.fact);
        if (result && typeof result.then === 'function') {
          await result;
        }
        if (result && result.ok === false) {
          state.lastError = result.error || 'persist_failed';
          if (result.error === 'ENOSPC' || result.error === 'queue_full') {
            state.available = false;
            state.reason = result.error;
            return;
          }
        }
        state.queue.shift();
      } catch (error) {
        state.lastError = error.code || error.message || String(error);
        state.queue.shift();
      }
    }
  }

  return { offer, status };
}

function deadSink(reason, error) {
  return {
    offer() {
      return { accepted: false, reason };
    },
    status() {
      return {
        available: false,
        reason,
        queueLength: 0,
        dropped: 0,
        lastError: error?.message || String(error || reason),
        flushing: false,
      };
    },
  };
}

module.exports = { createHistorySink };
