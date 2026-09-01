'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BUDGET_BYTES = 1024 * 1024 * 1024;

class SegmentIndex {
  constructor(options = {}) {
    const sqlite = resolveSqlite(options.sqliteModule);
    const explicitPath = options.path || options.dbPath;
    if (!explicitPath && !options.directory) {
      throw new TypeError('SegmentIndex requires directory or path');
    }
    this.dbPath = path.resolve(explicitPath || path.join(options.directory, 'index.sqlite'));
    this.directory = path.dirname(this.dbPath);
    this.budgetBytes = positiveInteger(options.budgetBytes, DEFAULT_BUDGET_BYTES, 'budgetBytes');
    this.pageSizeBytes = 4_096;
    this.auxiliaryReserveBytes = 0;
    this.maxPageCount = 1;
    this.walAutocheckpointPages = 1;
    this.journalSizeLimitBytes = this.pageSizeBytes;
    this.configureCapacity();
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(this.directory, 0o700);
    this.db = null;
    this.closed = false;
    try {
      this.db = new sqlite.DatabaseSync(this.dbPath);
      this.configure();
      this.createSchema();
      restrictFiles(this.dbPath);
    } catch (error) {
      this.closed = true;
      try {
        this.db?.close();
      } catch (_) {
        // Preserve the database setup error.
      }
      throw error;
    }
  }

  insert(fact, location) {
    this.assertOpen();
    validateIndexedFact(fact);
    validateLocation(location);
    this.db.prepare(`
      INSERT INTO segment_records (
        sequence, partition_name, target_key, runtime_epoch, action_id,
        dedupe_key, occurred_at_ms, observed_at_ms, ingested_at_ms,
        segment_id, frame_offset, payload_length
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sequence) DO UPDATE SET
        partition_name = excluded.partition_name,
        target_key = excluded.target_key,
        runtime_epoch = excluded.runtime_epoch,
        action_id = excluded.action_id,
        dedupe_key = excluded.dedupe_key,
        occurred_at_ms = excluded.occurred_at_ms,
        observed_at_ms = excluded.observed_at_ms,
        ingested_at_ms = excluded.ingested_at_ms,
        segment_id = excluded.segment_id,
        frame_offset = excluded.frame_offset,
        payload_length = excluded.payload_length
    `).run(
      location.sequence,
      fact.partition,
      fact.targetKey,
      fact.runtimeEpoch,
      fact.actionId,
      fact.dedupeKey,
      fact.timestamps.occurredAtMs,
      fact.timestamps.observedAtMs,
      fact.timestamps.ingestedAtMs,
      location.segmentId,
      location.frameOffset,
      location.payloadLength,
    );
    return this.locationForSequence(location.sequence);
  }

  insertBatch(records) {
    this.assertOpen();
    if (!Array.isArray(records)) throw new TypeError('records must be an array');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of records) this.insert(record.fact, record.location);
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_) {
        // Preserve the original indexing error.
      }
      throw error;
    }
  }

  query(query = {}) {
    this.assertOpen();
    const normalized = normalizeQuery(query);
    const clauses = ['sequence > ?'];
    const parameters = [normalized.afterSequence];
    if (normalized.throughSequence !== null) {
      clauses.push('sequence <= ?');
      parameters.push(normalized.throughSequence);
    }
    if (normalized.targetKey !== null) {
      clauses.push('target_key = ?');
      parameters.push(normalized.targetKey);
    }
    if (normalized.partitions.length > 0) {
      clauses.push(`partition_name IN (${normalized.partitions.map(() => '?').join(', ')})`);
      parameters.push(...normalized.partitions);
    }
    if (normalized.runtimeEpoch !== null) {
      clauses.push('runtime_epoch = ?');
      parameters.push(normalized.runtimeEpoch);
    }
    if (normalized.hasActionId) {
      if (normalized.actionId === null) clauses.push('action_id IS NULL');
      else {
        clauses.push('action_id = ?');
        parameters.push(normalized.actionId);
      }
    }
    if (normalized.fromObservedAtMs !== null) {
      clauses.push('observed_at_ms >= ?');
      parameters.push(normalized.fromObservedAtMs);
    }
    if (normalized.toObservedAtMs !== null) {
      clauses.push('observed_at_ms <= ?');
      parameters.push(normalized.toObservedAtMs);
    }
    const rows = this.db.prepare(`
      SELECT *
      FROM segment_records
      WHERE ${clauses.join(' AND ')}
      ORDER BY sequence ASC
      LIMIT ?
    `).all(...parameters, normalized.limit + 1);
    return {
      items: rows.slice(0, normalized.limit).map(rowToLocation),
      hasMore: rows.length > normalized.limit,
    };
  }

  findDedupe(dedupeKey) {
    this.assertOpen();
    if (dedupeKey === undefined || dedupeKey === null) return null;
    const row = this.db.prepare('SELECT * FROM segment_records WHERE dedupe_key = ? LIMIT 1').get(String(dedupeKey));
    return row ? rowToLocation(row) : null;
  }

  locationForSequence(sequence) {
    this.assertOpen();
    const row = this.db.prepare('SELECT * FROM segment_records WHERE sequence = ?').get(Number(sequence));
    return row ? rowToLocation(row) : null;
  }

  maxSequence() {
    this.assertOpen();
    return Number(this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM segment_records').get().value);
  }

  metadata(key, createValue) {
    this.assertOpen();
    const normalized = String(key);
    const row = this.db.prepare('SELECT value FROM segment_metadata WHERE key = ?').get(normalized);
    if (row) return row.value;
    if (typeof createValue !== 'function') return null;
    const value = String(createValue());
    this.db.prepare('INSERT OR IGNORE INTO segment_metadata(key, value) VALUES (?, ?)').run(normalized, value);
    return this.db.prepare('SELECT value FROM segment_metadata WHERE key = ?').get(normalized).value;
  }

  setMetadata(key, value) {
    this.assertOpen();
    this.db.prepare(`
      INSERT INTO segment_metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(key), String(value));
  }

  prunePartitionBefore(partition, firstAvailableSequence) {
    this.assertOpen();
    const result = this.db.prepare(`
      DELETE FROM segment_records
      WHERE partition_name = ? AND sequence < ?
    `).run(String(partition), Number(firstAvailableSequence));
    return Number(result.changes || 0);
  }

  clear() {
    this.assertOpen();
    this.db.exec('DELETE FROM segment_records');
  }

  reclaim({ force = false } = {}) {
    this.assertOpen();
    const beforeBytes = projectionBytes(this.directory);
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const row = this.db.prepare('PRAGMA auto_vacuum').get();
    const autoVacuum = Number(row?.auto_vacuum ?? Object.values(row || {})[0] ?? 0);
    if (autoVacuum === 2) {
      this.db.exec('PRAGMA incremental_vacuum');
    } else if (force) {
      // VACUUM can transiently allocate almost a second database, violating
      // the independent projection budget. The adapter will replace the full
      // SQLite projection with bounded mmap scanning instead.
      const error = new Error('SQLite projection requires a bounded rebuild');
      error.code = 'sqlite_projection_rebuild_required';
      throw error;
    }
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    restrictFiles(this.dbPath);
    const afterBytes = projectionBytes(this.directory);
    return {
      beforeBytes,
      afterBytes,
      reclaimedBytes: Math.max(0, beforeBytes - afterBytes),
      autoVacuum: Number(this.db.prepare('PRAGMA auto_vacuum').get().auto_vacuum),
    };
  }

  status() {
    if (this.closed) return { ...this.lastStatus, closed: true };
    const count = Number(this.db.prepare('SELECT COUNT(*) AS value FROM segment_records').get().value);
    const maxSequence = this.maxSequence();
    const stat = safeStat(this.dbPath);
    const totalBytes = projectionBytes(this.directory);
    return {
      ok: true,
      adapter: 'sqlite-projection',
      authoritative: false,
      rebuildable: true,
      dbPath: this.dbPath,
      count,
      maxSequence,
      bytes: stat?.size || 0,
      totalBytes,
      budgetBytes: this.budgetBytes,
      overQuota: totalBytes > this.budgetBytes,
      quotaScope: 'host-sqlite-projection',
      pageSizeBytes: this.pageSizeBytes,
      maxPageCount: this.maxPageCount,
      auxiliaryReserveBytes: this.auxiliaryReserveBytes,
      walAutocheckpointPages: this.walAutocheckpointPages,
      journalSizeLimitBytes: this.journalSizeLimitBytes,
      closed: false,
    };
  }

  storageBytes() {
    this.assertOpen();
    return projectionBytes(this.directory);
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
      this.db.close();
    } catch (error) {
      if (!firstError) firstError = error;
    }
    this.closed = true;
    if (firstError) throw firstError;
  }

  configure() {
    // auto_vacuum must be selected before the first table is created (and
    // before switching to WAL) for a new projection database.
    this.db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    this.db.exec(`PRAGMA page_size = ${this.pageSizeBytes}`);
    if (typeof this.db.prepare === 'function') {
      const row = this.db.prepare('PRAGMA page_size').get();
      this.pageSizeBytes = Number(row?.page_size ?? Object.values(row || {})[0] ?? this.pageSizeBytes);
    }
    this.configureCapacity();
    // The size cap belongs only to this rebuildable Host projection. It never
    // asks the authoritative mmap engine (or a mobile App store) to evict.
    this.db.exec(`PRAGMA max_page_count = ${this.maxPageCount}`);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`PRAGMA wal_autocheckpoint = ${this.walAutocheckpointPages}`);
    this.db.exec(`PRAGMA journal_size_limit = ${this.journalSizeLimitBytes}`);
  }

  configureCapacity() {
    const desiredReserve = Math.max(64 * 1024, Math.floor(this.budgetBytes * 0.02));
    this.auxiliaryReserveBytes = Math.min(
      Math.max(0, this.budgetBytes - this.pageSizeBytes),
      16 * 1024 * 1024,
      desiredReserve,
    );
    const mainBudgetBytes = Math.max(
      this.pageSizeBytes,
      this.budgetBytes - this.auxiliaryReserveBytes,
    );
    this.maxPageCount = Math.max(1, Math.floor(mainBudgetBytes / this.pageSizeBytes));
    const walReserveBytes = Math.max(0, this.auxiliaryReserveBytes - (32 * 1024));
    this.walAutocheckpointPages = Math.max(
      1,
      Math.min(64, Math.floor(walReserveBytes / Math.max(this.pageSizeBytes, 1))),
    );
    this.journalSizeLimitBytes = Math.max(this.pageSizeBytes, walReserveBytes);
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS segment_records (
        sequence INTEGER PRIMARY KEY,
        partition_name TEXT NOT NULL,
        target_key TEXT NOT NULL,
        runtime_epoch TEXT NOT NULL,
        action_id TEXT,
        dedupe_key TEXT,
        occurred_at_ms INTEGER NOT NULL,
        observed_at_ms INTEGER NOT NULL,
        ingested_at_ms INTEGER NOT NULL,
        segment_id INTEGER NOT NULL,
        frame_offset INTEGER NOT NULL,
        payload_length INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS segment_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS segment_records_dedupe
        ON segment_records(dedupe_key)
        WHERE dedupe_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS segment_records_target_sequence
        ON segment_records(target_key, sequence);
      CREATE INDEX IF NOT EXISTS segment_records_partition_sequence
        ON segment_records(partition_name, sequence);
      CREATE INDEX IF NOT EXISTS segment_records_action_sequence
        ON segment_records(action_id, sequence)
        WHERE action_id IS NOT NULL;
    `);
  }

  assertOpen() {
    if (this.closed) throw new Error('SegmentIndex is closed');
  }
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
      : [...new Set((Array.isArray(query.partitions) ? query.partitions : [query.partitions]).map(String))].sort(),
    runtimeEpoch: nullableString(query.runtimeEpoch),
    hasActionId: Object.prototype.hasOwnProperty.call(query, 'actionId'),
    actionId: nullableString(query.actionId),
    fromObservedAtMs: nullableInteger(query.fromObservedAtMs, 'fromObservedAtMs'),
    toObservedAtMs: nullableInteger(query.toObservedAtMs, 'toObservedAtMs'),
  };
}

function rowToLocation(row) {
  return {
    sequence: Number(row.sequence),
    partition: row.partition_name,
    targetKey: row.target_key,
    runtimeEpoch: row.runtime_epoch,
    actionId: row.action_id,
    dedupeKey: row.dedupe_key,
    timestamps: {
      occurredAtMs: Number(row.occurred_at_ms),
      observedAtMs: Number(row.observed_at_ms),
      ingestedAtMs: Number(row.ingested_at_ms),
    },
    segmentId: Number(row.segment_id),
    frameOffset: Number(row.frame_offset),
    payloadLength: Number(row.payload_length),
  };
}

function validateIndexedFact(fact) {
  if (!fact || typeof fact !== 'object' || !fact.timestamps) throw new TypeError('normalized fact is required');
  for (const [name, value] of [
    ['partition', fact.partition],
    ['targetKey', fact.targetKey],
    ['runtimeEpoch', fact.runtimeEpoch],
  ]) {
    if (value === undefined || value === null || String(value).length === 0) {
      throw new TypeError(`${name} is required`);
    }
  }
}

function validateLocation(location) {
  if (!location || typeof location !== 'object') throw new TypeError('location is required');
  for (const name of ['sequence', 'segmentId', 'frameOffset', 'payloadLength']) {
    const value = Number(location[name]);
    if (!Number.isSafeInteger(value) || value < 0 || (name === 'sequence' && value === 0)) {
      throw new TypeError(`${name} must be a valid safe integer`);
    }
  }
}

function positiveInteger(value, fallback, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return number;
}

function resolveSqlite(injected) {
  if (injected !== undefined) {
    if (!injected || typeof injected.DatabaseSync !== 'function') throw new TypeError('sqliteModule.DatabaseSync is required');
    return injected;
  }
  return require('node:sqlite');
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

function restrictFiles(dbPath) {
  if (process.platform === 'win32') return;
  for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function projectionBytes(directory) {
  let total = 0;
  for (const name of ['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm']) {
    total += safeStat(path.join(directory, name))?.size || 0;
  }
  return total;
}

module.exports = {
  DEFAULT_BUDGET_BYTES,
  SegmentIndex,
};
