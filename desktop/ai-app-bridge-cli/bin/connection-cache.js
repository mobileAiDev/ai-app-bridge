'use strict';

class ConnectionCache {
  constructor({ ttlMs = 15_000, maxEntries = 256, now = Date.now } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new TypeError('ttlMs must be a non-negative number');
    }
    if (typeof now !== 'function') {
      throw new TypeError('now must be a function');
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError('maxEntries must be a positive integer');
    }
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
    this.inflight = new Map();
    this.generations = new Map();
    this.nextGeneration = 0;
  }

  async getOrCreate(key, create, { force = false } = {}) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('key is required');
    }
    if (typeof create !== 'function') {
      throw new TypeError('create must be a function');
    }

    this.pruneEntries();
    if (!force) {
      const cached = this.entries.get(key);
      if (cached && cached.expiresAtMs >= this.now()) {
        this.entries.delete(key);
        this.entries.set(key, cached);
        return cached.value;
      }
      if (cached) this.entries.delete(key);
      if (this.inflight.has(key)) return this.inflight.get(key);
    } else {
      this.entries.delete(key);
    }

    const generation = ++this.nextGeneration;
    this.generations.set(key, generation);
    const pending = Promise.resolve()
      .then(create)
      .then((value) => {
        if (this.generations.get(key) === generation) {
          this.entries.set(key, {
            value,
            expiresAtMs: this.now() + this.ttlMs,
          });
          this.pruneEntries();
        }
        return value;
      })
      .finally(() => {
        if (this.inflight.get(key) === pending) {
          this.inflight.delete(key);
        }
        if (
          this.generations.get(key) === generation
          && !this.inflight.has(key)
          && !this.entries.has(key)
        ) {
          this.generations.delete(key);
        }
      });
    this.inflight.set(key, pending);
    return pending;
  }

  has(key) {
    this.pruneEntries();
    const cached = this.entries.get(key);
    if (!cached) return false;
    if (cached.expiresAtMs < this.now()) {
      this.entries.delete(key);
      if (!this.inflight.has(key)) this.generations.delete(key);
      return false;
    }
    return true;
  }

  pruneEntries() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs < now) {
        this.entries.delete(key);
        if (!this.inflight.has(key)) this.generations.delete(key);
      }
    }
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
      if (!this.inflight.has(oldestKey)) this.generations.delete(oldestKey);
    }
  }

  invalidate(key) {
    this.generations.set(key, ++this.nextGeneration);
    this.inflight.delete(key);
    const deleted = this.entries.delete(key);
    this.generations.delete(key);
    return deleted;
  }

  clear() {
    this.entries.clear();
    this.inflight.clear();
    this.generations.clear();
  }
}

module.exports = {
  ConnectionCache,
};
