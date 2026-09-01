'use strict';

const PARTITION_ALL = 0xffff_ffff;

/**
 * Bounded-memory correctness projection over the authoritative mmap engine.
 *
 * When `base` is present it remains a sealed SQLite prefix and only records
 * after `baseHighWater` are scanned from mmap. Without a base, every query is
 * served directly from live mmap records. No fact payload is copied into a
 * long-lived JavaScript collection.
 */
class MmapScanIndex {
  constructor({
    engine,
    decodeFact,
    base = null,
    baseHighWater = 0,
    reason = null,
    budgetBytes = 1024 * 1024 * 1024,
  }) {
    if (!engine || typeof engine.scan !== 'function' || typeof engine.status !== 'function') {
      throw new TypeError('MmapScanIndex requires an mmap engine');
    }
    if (typeof decodeFact !== 'function') throw new TypeError('MmapScanIndex requires decodeFact');
    this.engine = engine;
    this.decodeFact = decodeFact;
    this.base = base;
    this.baseHighWater = nonNegativeInteger(baseHighWater, 'baseHighWater');
    this.reason = reason;
    this.budgetBytes = positiveInteger(budgetBytes, 'budgetBytes');
    this.metadataValues = new Map();
    this.closed = false;
  }

  insert(fact, location) {
    this.assertOpen();
    return indexedLocation(fact, location);
  }

  insertBatch(records) {
    this.assertOpen();
    if (!Array.isArray(records)) throw new TypeError('records must be an array');
  }

  query(query = {}) {
    this.assertOpen();
    const normalized = normalizeQuery(query);
    const baseResult = this.base
      ? this.base.query(indexQuery(normalized))
      : { items: [], hasMore: false };
    const tail = this.scanMatching({
      ...normalized,
      afterSequence: Math.max(normalized.afterSequence, this.baseHighWater),
    });
    const merged = new Map();
    for (const item of [...baseResult.items, ...tail.items]) merged.set(item.sequence, item);
    const ordered = [...merged.values()].sort((left, right) => left.sequence - right.sequence);
    return {
      items: ordered.slice(0, normalized.limit),
      hasMore: baseResult.hasMore || tail.hasMore || ordered.length > normalized.limit,
    };
  }

  findDedupe(dedupeKey) {
    this.assertOpen();
    if (dedupeKey === undefined || dedupeKey === null) return null;
    const normalized = String(dedupeKey);
    const fromBase = this.base?.findDedupe(normalized);
    if (fromBase) return fromBase;
    let cursor = { partitionId: PARTITION_ALL, afterSequence: this.baseHighWater };
    while (true) {
      const scanned = this.engine.scan(cursor);
      cursor = scanned.cursor;
      if (scanned.done) return null;
      const fact = this.decodeFact(scanned.payload, scanned.record.sequence);
      if (!fact) continue;
      if (fact.dedupeKey === normalized) return locationFrom(fact, scanned.record);
    }
  }

  locationForSequence(sequence) {
    this.assertOpen();
    const normalized = positiveInteger(sequence, 'sequence');
    if (this.base && normalized <= this.baseHighWater) {
      const fromBase = this.base.locationForSequence(normalized);
      if (fromBase) return fromBase;
    }
    let cursor = { partitionId: PARTITION_ALL, afterSequence: normalized - 1 };
    while (true) {
      const scanned = this.engine.scan(cursor);
      cursor = scanned.cursor;
      if (scanned.done || scanned.record.sequence > normalized) return null;
      if (scanned.record.sequence === normalized) {
        const fact = this.decodeFact(scanned.payload, scanned.record.sequence);
        return fact ? locationFrom(fact, scanned.record) : null;
      }
    }
  }

  maxSequence() {
    this.assertOpen();
    return this.logicalStatus().maxSequence;
  }

  metadata(key, createValue) {
    this.assertOpen();
    const normalized = String(key);
    if (this.metadataValues.has(normalized)) return this.metadataValues.get(normalized);
    const fromBase = this.base?.metadata(normalized);
    if (fromBase !== undefined && fromBase !== null) {
      this.metadataValues.set(normalized, fromBase);
      return fromBase;
    }
    if (typeof createValue !== 'function') return null;
    const value = String(createValue());
    this.metadataValues.set(normalized, value);
    return value;
  }

  setMetadata(key, value) {
    this.assertOpen();
    this.metadataValues.set(String(key), String(value));
  }

  prunePartitionBefore(partition, firstAvailableSequence) {
    this.assertOpen();
    return this.base?.prunePartitionBefore(partition, firstAvailableSequence) || 0;
  }

  clear() {
    this.assertOpen();
    this.base?.clear();
    this.baseHighWater = 0;
  }

  reclaim(options = {}) {
    this.assertOpen();
    return this.base?.reclaim(options)
      || { beforeBytes: 0, afterBytes: 0, reclaimedBytes: 0, autoVacuum: null };
  }

  storageBytes() {
    this.assertOpen();
    return this.base?.storageBytes() || 0;
  }

  status() {
    if (this.closed) return { ...this.lastStatus, closed: true };
    const logical = this.logicalStatus();
    const base = this.base?.status() || null;
    return {
      ok: true,
      adapter: this.base ? 'sqlite-projection+mmap-tail' : 'mmap-scan-projection',
      authoritative: false,
      rebuildable: true,
      persistence: Boolean(this.base),
      degraded: true,
      boundedMemory: true,
      reason: this.reason,
      count: logical.count,
      maxSequence: logical.maxSequence,
      baseHighWater: this.baseHighWater,
      tailFirstSequence: this.baseHighWater + 1,
      bytes: Number(base?.bytes || 0),
      totalBytes: Number(base?.totalBytes || 0),
      budgetBytes: this.budgetBytes,
      overQuota: Number(base?.totalBytes || 0) > this.budgetBytes,
      quotaScope: 'host-sqlite-projection',
      base,
      closed: false,
    };
  }

  close() {
    if (this.closed) return;
    let firstError = null;
    try {
      this.lastStatus = this.status();
    } catch (error) {
      firstError = error;
    }
    try {
      this.base?.close();
    } catch (error) {
      if (!firstError) firstError = error;
    }
    this.closed = true;
    if (firstError) throw firstError;
  }

  scanMatching(normalized) {
    const items = [];
    let cursor = { partitionId: PARTITION_ALL, afterSequence: normalized.afterSequence };
    while (true) {
      const scanned = this.engine.scan(cursor);
      cursor = scanned.cursor;
      if (scanned.done) break;
      const fact = this.decodeFact(scanned.payload, scanned.record.sequence);
      if (!fact) continue;
      if (!matches(fact, normalized)) continue;
      items.push(locationFrom(fact, scanned.record));
      if (items.length > normalized.limit) break;
    }
    return {
      items: items.slice(0, normalized.limit),
      hasMore: items.length > normalized.limit,
    };
  }

  logicalStatus() {
    let count = 0;
    let maxSequence = 0;
    let cursor = { partitionId: PARTITION_ALL, afterSequence: 0 };
    while (true) {
      const scanned = this.engine.scan(cursor);
      cursor = scanned.cursor;
      if (scanned.done) break;
      const fact = this.decodeFact(scanned.payload, scanned.record.sequence);
      if (!fact) continue;
      count += 1;
      maxSequence = scanned.record.sequence;
    }
    return { count, maxSequence };
  }

  assertOpen() {
    if (this.closed) throw new Error('MmapScanIndex is closed');
  }
}

function normalizeQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new TypeError('query must be an object');
  const limit = query.limit === undefined ? 100 : positiveInteger(query.limit, 'limit');
  if (limit > 1000) throw new TypeError('limit must not exceed 1000');
  return {
    afterSequence: query.afterSequence === undefined
      ? 0
      : nonNegativeInteger(query.afterSequence, 'afterSequence'),
    limit,
    targetKey: nullableString(query.targetKey),
    partitions: query.partitions === undefined
      ? []
      : [...new Set((Array.isArray(query.partitions) ? query.partitions : [query.partitions]).map(String))],
    runtimeEpoch: nullableString(query.runtimeEpoch),
    hasActionId: Object.prototype.hasOwnProperty.call(query, 'actionId'),
    actionId: nullableString(query.actionId),
    fromObservedAtMs: nullableInteger(query.fromObservedAtMs, 'fromObservedAtMs'),
    toObservedAtMs: nullableInteger(query.toObservedAtMs, 'toObservedAtMs'),
  };
}

function indexQuery(query) {
  return {
    afterSequence: query.afterSequence,
    limit: query.limit,
    targetKey: query.targetKey,
    partitions: query.partitions,
    runtimeEpoch: query.runtimeEpoch,
    ...(query.hasActionId ? { actionId: query.actionId } : {}),
    fromObservedAtMs: query.fromObservedAtMs,
    toObservedAtMs: query.toObservedAtMs,
  };
}

function matches(fact, query) {
  if (query.targetKey !== null && fact.targetKey !== query.targetKey) return false;
  if (query.partitions.length > 0 && !query.partitions.includes(fact.partition)) return false;
  if (query.runtimeEpoch !== null && fact.runtimeEpoch !== query.runtimeEpoch) return false;
  if (query.hasActionId && (fact.actionId ?? null) !== query.actionId) return false;
  const observedAtMs = Number(fact.timestamps?.observedAtMs);
  if (query.fromObservedAtMs !== null && observedAtMs < query.fromObservedAtMs) return false;
  if (query.toObservedAtMs !== null && observedAtMs > query.toObservedAtMs) return false;
  return true;
}

function indexedLocation(fact, location) {
  return {
    sequence: Number(location.sequence),
    partition: String(fact.partition),
    targetKey: String(fact.targetKey),
    runtimeEpoch: String(fact.runtimeEpoch),
    actionId: fact.actionId ?? null,
    dedupeKey: fact.dedupeKey ?? null,
    timestamps: { ...fact.timestamps },
    segmentId: Number(location.segmentId),
    frameOffset: Number(location.frameOffset),
    payloadLength: logicalPayloadLength(fact, location.payloadLength),
  };
}

function logicalPayloadLength(fact, fallback) {
  const value = Number(fact?.__aiAppBridgeLogicalPayloadBytes);
  return Number.isSafeInteger(value) && value > 0 ? value : Number(fallback);
}

function locationFrom(fact, record) {
  return indexedLocation(fact, {
    sequence: record.sequence,
    segmentId: record.segmentId,
    frameOffset: record.frameOffset,
    payloadLength: record.payloadLength,
  });
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return number;
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return number;
}

function nullableString(value) {
  return value === undefined || value === null ? null : String(value);
}

function nullableInteger(value, name) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new TypeError(`${name} must be a safe integer`);
  return number;
}

module.exports = { MmapScanIndex };
