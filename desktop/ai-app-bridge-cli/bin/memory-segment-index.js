'use strict';

/**
 * Non-persistent query projection used only when SQLite is unavailable.
 * The mmap segments remain authoritative; this projection is rebuilt from
 * them on every open and never stores fact payloads.
 */
class MemorySegmentIndex {
  constructor({ reason = null, budgetBytes = 1024 * 1024 * 1024 } = {}) {
    this.reason = reason;
    this.budgetBytes = budgetBytes;
    this.records = [];
    this.bySequence = new Map();
    this.byDedupe = new Map();
    this.metadataValues = new Map();
    this.closed = false;
  }

  insert(fact, location) {
    this.assertOpen();
    const record = indexedLocation(fact, location);
    const existing = this.bySequence.get(record.sequence);
    if (existing) this.removeRecord(existing);
    const position = lowerBound(this.records, record.sequence);
    this.records.splice(position, 0, record);
    this.bySequence.set(record.sequence, record);
    if (record.dedupeKey !== null) this.byDedupe.set(record.dedupeKey, record);
    return { ...record, timestamps: { ...record.timestamps } };
  }

  insertBatch(records) {
    this.assertOpen();
    if (!Array.isArray(records)) throw new TypeError('records must be an array');
    for (const record of records) this.insert(record.fact, record.location);
  }

  query(query = {}) {
    this.assertOpen();
    const normalized = normalizeQuery(query);
    const items = [];
    let index = lowerBound(this.records, normalized.afterSequence + 1);
    for (; index < this.records.length && items.length <= normalized.limit; index += 1) {
      const record = this.records[index];
      if (normalized.throughSequence !== null && record.sequence > normalized.throughSequence) break;
      if (normalized.targetKey !== null && record.targetKey !== normalized.targetKey) continue;
      if (normalized.partitions.length > 0 && !normalized.partitions.includes(record.partition)) continue;
      if (normalized.runtimeEpoch !== null && record.runtimeEpoch !== normalized.runtimeEpoch) continue;
      if (normalized.hasActionId && record.actionId !== normalized.actionId) continue;
      if (
        normalized.fromObservedAtMs !== null
        && record.timestamps.observedAtMs < normalized.fromObservedAtMs
      ) continue;
      if (
        normalized.toObservedAtMs !== null
        && record.timestamps.observedAtMs > normalized.toObservedAtMs
      ) continue;
      items.push(record);
    }
    return {
      items: items.slice(0, normalized.limit).map(cloneLocation),
      hasMore: items.length > normalized.limit,
    };
  }

  findDedupe(dedupeKey) {
    this.assertOpen();
    if (dedupeKey === undefined || dedupeKey === null) return null;
    const record = this.byDedupe.get(String(dedupeKey));
    return record ? cloneLocation(record) : null;
  }

  locationForSequence(sequence) {
    this.assertOpen();
    const record = this.bySequence.get(Number(sequence));
    return record ? cloneLocation(record) : null;
  }

  maxSequence() {
    this.assertOpen();
    return this.records.at(-1)?.sequence || 0;
  }

  metadata(key, createValue) {
    this.assertOpen();
    const normalized = String(key);
    if (this.metadataValues.has(normalized)) return this.metadataValues.get(normalized);
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
    const normalizedPartition = String(partition);
    const sequence = Number(firstAvailableSequence);
    const removed = this.records.filter(
      (record) => record.partition === normalizedPartition && record.sequence < sequence,
    );
    if (removed.length === 0) return 0;
    for (const record of removed) this.removeRecord(record);
    const removedSequences = new Set(removed.map((record) => record.sequence));
    this.records = this.records.filter((record) => !removedSequences.has(record.sequence));
    return removed.length;
  }

  clear() {
    this.assertOpen();
    this.records = [];
    this.bySequence.clear();
    this.byDedupe.clear();
  }

  reclaim() {
    this.assertOpen();
    return { beforeBytes: 0, afterBytes: 0, reclaimedBytes: 0, autoVacuum: null };
  }

  storageBytes() {
    this.assertOpen();
    return 0;
  }

  status() {
    return {
      ok: true,
      adapter: 'memory-projection',
      authoritative: false,
      rebuildable: true,
      persistence: false,
      degraded: true,
      reason: this.reason,
      count: this.records.length,
      maxSequence: this.records.at(-1)?.sequence || 0,
      bytes: 0,
      totalBytes: 0,
      budgetBytes: this.budgetBytes,
      overQuota: false,
      quotaScope: 'host-memory-projection',
      closed: this.closed,
    };
  }

  close() {
    this.closed = true;
  }

  removeRecord(record) {
    this.bySequence.delete(record.sequence);
    if (record.dedupeKey !== null && this.byDedupe.get(record.dedupeKey) === record) {
      this.byDedupe.delete(record.dedupeKey);
    }
  }

  assertOpen() {
    if (this.closed) throw new Error('MemorySegmentIndex is closed');
  }
}

function indexedLocation(fact, location) {
  if (!fact || typeof fact !== 'object' || !fact.timestamps) throw new TypeError('normalized fact is required');
  const sequence = Number(location?.sequence);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new TypeError('location.sequence is required');
  return {
    sequence,
    partition: String(fact.partition),
    targetKey: String(fact.targetKey),
    runtimeEpoch: String(fact.runtimeEpoch),
    actionId: fact.actionId === undefined || fact.actionId === null ? null : String(fact.actionId),
    dedupeKey: fact.dedupeKey === undefined || fact.dedupeKey === null ? null : String(fact.dedupeKey),
    timestamps: {
      occurredAtMs: Number(fact.timestamps.occurredAtMs),
      observedAtMs: Number(fact.timestamps.observedAtMs),
      ingestedAtMs: Number(fact.timestamps.ingestedAtMs),
    },
    segmentId: Number(location.segmentId),
    frameOffset: Number(location.frameOffset),
    payloadLength: Number(location.payloadLength),
  };
}

function normalizeQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new TypeError('query must be an object');
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) {
    throw new TypeError('limit must be an integer between 1 and 1000');
  }
  const afterSequence = query.afterSequence === undefined ? 0 : Number(query.afterSequence);
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new TypeError('afterSequence must be a non-negative safe integer');
  }
  return {
    afterSequence,
    throughSequence: nullableInteger(query.throughSequence, 'throughSequence'),
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

function nullableString(value) {
  return value === undefined || value === null ? null : String(value);
}

function nullableInteger(value, name) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new TypeError(`${name} must be a safe integer`);
  return number;
}

function lowerBound(records, sequence) {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (records[middle].sequence < sequence) low = middle + 1;
    else high = middle;
  }
  return low;
}

function cloneLocation(record) {
  return { ...record, timestamps: { ...record.timestamps } };
}

module.exports = { MemorySegmentIndex };
