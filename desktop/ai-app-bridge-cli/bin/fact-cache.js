const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_BUDGET_BYTES = 512 * 1024 * 1024;
const DEFAULT_MMAP_BYTES = DEFAULT_BUDGET_BYTES;
const SOFT_QUOTA_RATIO = 0.9;
const GIB = 1024 * 1024 * 1024;
const REDACTED = '[REDACTED]';
const FACT_CACHE_PROFILES = Object.freeze({
  '512mb': 512 * 1024 * 1024,
  '256mb': 256 * 1024 * 1024,
  '64mb': 64 * 1024 * 1024,
});
const PARTITION_WEIGHTS = Object.freeze({
  network: 30,
  ui: 20,
  'app-log': 12,
  'device-log': 8,
  'state-event': 10,
  action: 10,
  note: 5,
  index: 5,
});

class FactCache {
  constructor(options = {}) {
    const explicitDbPath = options.path || options.dbPath;
    this.dbPath = path.resolve(explicitDbPath || (
      options.directory ? path.join(options.directory, 'facts.sqlite') : defaultFactCachePath()
    ));
    this.directory = path.dirname(this.dbPath);
    const requestedProfile = normalizeProfile(options.profile);
    const storageCapacity = requestedProfile === 'auto'
      ? normalizeStorageCapacity(options.storageCapacity || readStorageCapacity(this.directory))
      : null;
    const selectedProfile = requestedProfile === 'auto'
      ? selectAutomaticProfile(storageCapacity)
      : requestedProfile;
    this.budgetBytes = positiveInteger(
      options.budgetBytes,
      FACT_CACHE_PROFILES[selectedProfile],
      'budgetBytes',
    );
    this.profile = options.budgetBytes === undefined || this.budgetBytes === FACT_CACHE_PROFILES[selectedProfile]
      ? selectedProfile
      : 'custom';
    this.profileSelection = requestedProfile === 'auto'
      ? { mode: 'auto', ...storageCapacity }
      : { mode: 'explicit' };
    this.mmapBytes = nonNegativeInteger(options.mmapBytes, Math.min(this.budgetBytes, DEFAULT_MMAP_BYTES), 'mmapBytes');
    this.closed = false;
    const directoryExisted = fs.existsSync(this.directory);
    this.restrictDirectoryPermissions = Boolean(options.directory)
      || !explicitDbPath
      || !directoryExisted;

    const sqliteResolution = resolveSqliteModule(options);
    if (!sqliteResolution.module) {
      const error = new Error(`FactCache requires node:sqlite: ${sqliteResolution.reason}`);
      error.code = sqliteResolution.reason;
      throw error;
    }

    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      restrictFactCacheDirectory(this.directory, this.restrictDirectoryPermissions);
      this.db = new sqliteResolution.module.DatabaseSync(this.dbPath);
      this.configureDatabase();
      this.createSchema();
      this.cursorSecret = this.readOrCreateCursorSecret();
      this.enforceExistingQuotas();
      restrictFactCacheFiles(this.dbPath);
    } catch (error) {
      try {
        this.db?.close();
      } catch (_) {
        // Preserve the initialization failure.
      }
      this.db = null;
      throw error;
    }
  }

  append(partitionOrFact, maybeFact) {
    this.assertOpen();
    const fact = typeof partitionOrFact === 'string'
      ? { ...(maybeFact || {}), partition: partitionOrFact }
      : partitionOrFact;
    const normalized = normalizeFact(fact);
    if (!Object.hasOwn(PARTITION_WEIGHTS, normalized.partition)) {
      throw new TypeError(`partition must be one of: ${Object.keys(PARTITION_WEIGHTS).join(', ')}`);
    }
    const payloadJson = JSON.stringify(normalized.payload);
    const appJson = JSON.stringify(normalized.app);
    let globalSeq;
    let sizeBytes;
    let eviction;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (normalized.dedupeKey) {
        const existing = this.db.prepare(`
          SELECT global_seq, byte_size
          FROM facts
          WHERE dedupe_key = ?
          LIMIT 1
        `).get(normalized.dedupeKey);
        if (existing) {
          this.db.exec('COMMIT');
          return {
            ok: true,
            stored: true,
            globalSeq: Number(existing.global_seq),
            sizeBytes: Number(existing.byte_size),
            evictedCount: 0,
            deduplicated: true,
          };
        }
      }
      const result = this.db.prepare(`
        INSERT INTO facts (
          partition_name,
          target_key,
          app_json,
          runtime_epoch,
          action_id,
          dedupe_key,
          occurred_at_ms,
          observed_at_ms,
          ingested_at_ms,
          payload_json,
          byte_size
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        normalized.partition,
        normalized.targetKey,
        appJson,
        normalized.runtimeEpoch,
        normalized.actionId,
        normalized.dedupeKey,
        normalized.timestamps.occurredAtMs,
        normalized.timestamps.observedAtMs,
        normalized.timestamps.ingestedAtMs,
        payloadJson,
      );
      globalSeq = Number(result.lastInsertRowid);
      const record = { ...normalized, globalSeq };
      sizeBytes = Buffer.byteLength(JSON.stringify(record));
      this.db.prepare('UPDATE facts SET byte_size = ? WHERE global_seq = ?').run(sizeBytes, globalSeq);
      eviction = this.enforceLogicalQuotas(normalized.partition);
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_) {
        // Preserve the transactional failure.
      }
      throw error;
    }

    let physicalEviction = { count: 0 };
    let maintenanceWarning = null;
    try {
      physicalEviction = this.enforcePhysicalQuota();
      this.lastMaintenanceWarning = null;
    } catch (error) {
      maintenanceWarning = {
        code: 'physical_quota_maintenance_failed',
        message: error.message,
      };
      this.lastMaintenanceWarning = maintenanceWarning;
    }
    const stored = Boolean(this.db.prepare('SELECT 1 AS present FROM facts WHERE global_seq = ?').get(globalSeq));
    return {
      ok: true,
      stored,
      globalSeq,
      sizeBytes,
      ...(stored ? {} : { reason: 'record_exceeds_quota' }),
      evictedCount: eviction.count + physicalEviction.count,
      ...(maintenanceWarning ? { maintenanceWarning } : {}),
    };
  }

  read(query = {}) {
    this.assertOpen();
    const normalizedQuery = normalizeReadQuery(query);
    const scope = cursorScope(normalizedQuery);
    const decodedCursor = normalizedQuery.cursor === null
      ? { ok: true, sequence: 0 }
      : decodeCursor(normalizedQuery.cursor, scope, this.cursorSecret);
    if (!decodedCursor.ok) {
      return {
        ok: false,
        error: 'invalid_cursor',
        message: decodedCursor.message,
        items: [],
        count: 0,
        gap: false,
        cursorExpired: false,
      };
    }
    const evictedThroughGlobalSeq = this.metadataNumber('evicted_through_seq');
    if (normalizedQuery.cursor !== null && decodedCursor.sequence < evictedThroughGlobalSeq) {
      return {
        ok: false,
        error: 'cursor_expired',
        message: 'Facts after this cursor have been evicted.',
        items: [],
        count: 0,
        gap: true,
        cursorExpired: true,
        evictedThroughGlobalSeq,
      };
    }
    const clauses = [];
    const parameters = [];
    clauses.push('global_seq > ?');
    parameters.push(decodedCursor.sequence);
    if (normalizedQuery.targetKey !== null) {
      clauses.push('target_key = ?');
      parameters.push(normalizedQuery.targetKey);
    }
    if (normalizedQuery.partitions.length > 0) {
      clauses.push(`partition_name IN (${normalizedQuery.partitions.map(() => '?').join(', ')})`);
      parameters.push(...normalizedQuery.partitions);
    }
    if (normalizedQuery.runtimeEpoch !== null) {
      clauses.push('runtime_epoch = ?');
      parameters.push(normalizedQuery.runtimeEpoch);
    }
    if (normalizedQuery.hasActionId) {
      if (normalizedQuery.actionId === null) {
        clauses.push('action_id IS NULL');
      } else {
        clauses.push('action_id = ?');
        parameters.push(normalizedQuery.actionId);
      }
    }
    if (normalizedQuery.fromObservedAtMs !== null) {
      clauses.push('observed_at_ms >= ?');
      parameters.push(normalizedQuery.fromObservedAtMs);
    }
    if (normalizedQuery.toObservedAtMs !== null) {
      clauses.push('observed_at_ms <= ?');
      parameters.push(normalizedQuery.toObservedAtMs);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT
        global_seq,
        partition_name,
        target_key,
        app_json,
        runtime_epoch,
        action_id,
        occurred_at_ms,
        observed_at_ms,
        ingested_at_ms,
        payload_json,
        byte_size
      FROM facts
      ${where}
      ORDER BY global_seq ASC
      LIMIT ?
    `).all(...parameters, normalizedQuery.limit + 1);
    const hasMore = rows.length > normalizedQuery.limit;
    const items = rows.slice(0, normalizedQuery.limit).map(rowToFact);
    const latestAllocatedSeq = this.latestAllocatedSequence();
    const cursorSeq = hasMore && items.length > 0
      ? items[items.length - 1].globalSeq
      : latestAllocatedSeq;
    return {
      ok: true,
      items,
      count: items.length,
      cursor: encodeCursor(cursorSeq, scope, this.cursorSecret),
      gap: false,
      cursorExpired: false,
      hasMore,
    };
  }

  query(query = {}) {
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      throw new TypeError('query must be an object');
    }
    const normalized = { ...query };
    if (normalized.partitions === undefined && normalized.partition !== undefined) {
      normalized.partitions = normalized.partition;
    }
    if (normalized.targetKey === undefined && normalized.target !== undefined) {
      normalized.targetKey = normalized.target;
    }
    delete normalized.partition;
    delete normalized.target;
    return this.read(normalized);
  }

  stats() {
    return this.status();
  }

  status() {
    if (this.closed) return { ...this.lastStatus, closed: true };
    const journalMode = String(this.db.prepare('PRAGMA journal_mode').get().journal_mode || '').toLowerCase();
    const mmapEffectiveBytes = Number(this.db.prepare('PRAGMA mmap_size').get().mmap_size || 0);
    const partitionRows = this.db.prepare(`
      SELECT partition_name, COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes
      FROM facts
      GROUP BY partition_name
    `).all();
    const usageByPartition = new Map(partitionRows.map((row) => [row.partition_name, row]));
    const partitions = {};
    for (const [partition, weight] of Object.entries(PARTITION_WEIGHTS)) {
      const hardQuotaBytes = Math.floor(this.budgetBytes * weight / 100);
      const row = usageByPartition.get(partition);
      partitions[partition] = {
        weight,
        softQuotaBytes: Math.floor(hardQuotaBytes * SOFT_QUOTA_RATIO),
        hardQuotaBytes,
        bytes: row ? Number(row.bytes) : 0,
        count: row ? Number(row.count) : 0,
      };
    }
    const logicalBytes = Object.values(partitions).reduce((total, partition) => total + partition.bytes, 0);
    const storage = storageBytes(this.dbPath, this.budgetBytes);
    const oldestRow = this.db.prepare('SELECT COALESCE(MIN(global_seq), 0) AS value FROM facts').get();
    const latestGlobalSeq = this.latestAllocatedSequence();
    const evictedThroughGlobalSeq = this.metadataNumber('evicted_through_seq');
    return {
      ok: true,
      adapter: 'sqlite',
      degraded: false,
      degradationReason: null,
      persistence: true,
      profile: this.profile,
      profileSelection: this.profileSelection,
      budgetBytes: this.budgetBytes,
      dbPath: this.dbPath,
      quota: {
        budgetBytes: this.budgetBytes,
        softQuotaBytes: Math.floor(this.budgetBytes * SOFT_QUOTA_RATIO),
        hardQuotaBytes: this.budgetBytes,
        logicalBytes,
        partitions,
      },
      storage,
      evictions: {
        count: this.metadataNumber('eviction_count'),
        bytes: this.metadataNumber('evicted_bytes'),
        throughGlobalSeq: evictedThroughGlobalSeq,
      },
      sequences: {
        oldestAvailableGlobalSeq: Number(oldestRow.value),
        latestGlobalSeq,
        nextGlobalSeq: latestGlobalSeq + 1,
        evictedThroughGlobalSeq,
      },
      sqlite: {
        journalMode,
        mmap: {
          requestedBytes: this.mmapBytes,
          effectiveBytes: mmapEffectiveBytes,
          enabled: mmapEffectiveBytes > 0,
        },
      },
      maintenanceWarning: this.lastMaintenanceWarning || null,
      closed: false,
    };
  }

  close() {
    if (this.closed) return;
    this.lastStatus = this.status();
    this.db.close();
    this.closed = true;
  }

  configureDatabase() {
    this.db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    const autoVacuumMode = Number(this.db.prepare('PRAGMA auto_vacuum').get().auto_vacuum);
    if (autoVacuumMode !== 2) {
      this.db.exec('VACUUM');
      this.db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    }
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA wal_autocheckpoint = 32');
    this.db.exec(`PRAGMA mmap_size = ${this.mmapBytes}`);
  }

  createSchema() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS facts (
          global_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          partition_name TEXT NOT NULL,
          target_key TEXT NOT NULL,
          app_json TEXT NOT NULL,
          runtime_epoch TEXT NOT NULL,
          action_id TEXT,
          dedupe_key TEXT,
          occurred_at_ms INTEGER NOT NULL,
          observed_at_ms INTEGER NOT NULL,
          ingested_at_ms INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          byte_size INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS fact_cache_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS facts_target_sequence
          ON facts(target_key, global_seq);
      `);
      const columns = this.db.prepare('PRAGMA table_info(facts)').all();
      if (!columns.some((column) => column.name === 'dedupe_key')) {
        this.db.exec('ALTER TABLE facts ADD COLUMN dedupe_key TEXT');
      }
      this.backfillEvidenceDedupeKeys();
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS facts_dedupe_key
          ON facts(dedupe_key)
          WHERE dedupe_key IS NOT NULL;
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_) {
        // Preserve the schema migration failure.
      }
      throw error;
    }
  }

  backfillEvidenceDedupeKeys() {
    const seen = new Set(
      this.db.prepare('SELECT dedupe_key FROM facts WHERE dedupe_key IS NOT NULL')
        .all()
        .map((row) => row.dedupe_key),
    );
    const update = this.db.prepare('UPDATE facts SET dedupe_key = ? WHERE global_seq = ?');
    for (const row of this.db.prepare(`
      SELECT global_seq, target_key, runtime_epoch, payload_json
      FROM facts
      WHERE dedupe_key IS NULL
      ORDER BY global_seq ASC
    `).iterate()) {
      let payload;
      try {
        payload = JSON.parse(row.payload_json);
      } catch (_) {
        continue;
      }
      const captureId = payload?.record?.id;
      if (payload?.kind !== 'evidence' || !payload.stream || captureId === undefined || captureId === null) {
        continue;
      }
      const dedupeKey = normalizeDedupeKey(JSON.stringify([
        row.target_key,
        row.runtime_epoch,
        payload.stream,
        String(captureId),
      ]));
      if (seen.has(dedupeKey)) continue;
      update.run(dedupeKey, row.global_seq);
      seen.add(dedupeKey);
    }
  }

  readOrCreateCursorSecret() {
    const row = this.db.prepare("SELECT value FROM fact_cache_metadata WHERE key = 'cursor_secret'").get();
    if (row) return row.value;
    const value = crypto.randomBytes(32).toString('base64url');
    this.db.prepare("INSERT OR IGNORE INTO fact_cache_metadata(key, value) VALUES ('cursor_secret', ?)").run(value);
    return this.db.prepare("SELECT value FROM fact_cache_metadata WHERE key = 'cursor_secret'").get().value;
  }

  enforceLogicalQuotas(partition) {
    const evicted = emptyEvictionSummary();
    const hardPartitionBytes = Math.floor(this.budgetBytes * PARTITION_WEIGHTS[partition] / 100);
    const softPartitionBytes = Math.floor(hardPartitionBytes * SOFT_QUOTA_RATIO);
    let partitionBytes = this.sumBytes('WHERE partition_name = ?', [partition]);
    if (partitionBytes > hardPartitionBytes) {
      for (const row of this.db.prepare(`
        SELECT global_seq, byte_size
        FROM facts
        WHERE partition_name = ?
        ORDER BY global_seq ASC
      `).iterate(partition)) {
        this.db.prepare('DELETE FROM facts WHERE global_seq = ?').run(row.global_seq);
        partitionBytes -= Number(row.byte_size);
        addEviction(evicted, row);
        if (partitionBytes <= softPartitionBytes) break;
      }
    }

    let totalBytes = this.sumBytes();
    const globalSoftBytes = Math.floor(this.budgetBytes * SOFT_QUOTA_RATIO);
    if (totalBytes > this.budgetBytes) {
      for (const row of this.db.prepare(`
        SELECT global_seq, byte_size
        FROM facts
        ORDER BY global_seq ASC
      `).iterate()) {
        this.db.prepare('DELETE FROM facts WHERE global_seq = ?').run(row.global_seq);
        totalBytes -= Number(row.byte_size);
        addEviction(evicted, row);
        if (totalBytes <= globalSoftBytes) break;
      }
    }

    this.recordSqliteEvictions(evicted);
    return { count: evicted.count };
  }

  enforceExistingQuotas() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const partition of Object.keys(PARTITION_WEIGHTS)) {
        this.enforceLogicalQuotas(partition);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_) {
        // Preserve the quota initialization failure.
      }
      throw error;
    }
    this.enforcePhysicalQuota();
  }

  enforcePhysicalQuota() {
    let current = storageBytes(this.dbPath, this.budgetBytes);
    if (!current.overQuota) return { count: 0 };

    this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
    current = storageBytes(this.dbPath, this.budgetBytes);
    if (!current.overQuota) return { count: 0 };

    let evictedCount = 0;
    const pageSize = Number(this.db.prepare('PRAGMA page_size').get().page_size) || 4096;
    for (let pass = 0; pass < 8 && current.overQuota; pass += 1) {
      const targetBytes = Math.max(current.totalBytes - this.budgetBytes, pageSize * 8);
      const evicted = emptyEvictionSummary();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of this.db.prepare(`
          SELECT global_seq, byte_size
          FROM facts
          ORDER BY global_seq ASC
        `).iterate()) {
          this.db.prepare('DELETE FROM facts WHERE global_seq = ?').run(row.global_seq);
          addEviction(evicted, row);
          if (evicted.bytes >= targetBytes) break;
        }
        this.recordSqliteEvictions(evicted);
        this.db.exec('COMMIT');
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch (_) {
          // Preserve the maintenance failure.
        }
        throw error;
      }
      if (evicted.count === 0) break;
      evictedCount += evicted.count;
      this.db.exec('PRAGMA incremental_vacuum(2147483647)');
      this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
      current = storageBytes(this.dbPath, this.budgetBytes);
    }
    return { count: evictedCount };
  }

  recordSqliteEvictions(evicted) {
    const summary = Array.isArray(evicted) ? summarizeEvictions(evicted) : evicted;
    if (!summary || summary.count === 0) return;
    this.incrementMetadata('eviction_count', summary.count);
    this.incrementMetadata('evicted_bytes', summary.bytes);
    this.writeMetadataNumber(
      'evicted_through_seq',
      Math.max(this.metadataNumber('evicted_through_seq'), summary.throughGlobalSeq),
    );
  }

  sumBytes(where = '', parameters = []) {
    const row = this.db.prepare(`SELECT COALESCE(SUM(byte_size), 0) AS value FROM facts ${where}`).get(...parameters);
    return Number(row.value);
  }

  metadataNumber(key) {
    const row = this.db.prepare('SELECT value FROM fact_cache_metadata WHERE key = ?').get(key);
    return row ? Number(row.value) || 0 : 0;
  }

  latestAllocatedSequence() {
    const row = this.db.prepare("SELECT seq AS value FROM sqlite_sequence WHERE name = 'facts'").get();
    return row ? Number(row.value) : 0;
  }

  incrementMetadata(key, amount) {
    this.writeMetadataNumber(key, this.metadataNumber(key) + amount);
  }

  writeMetadataNumber(key, value) {
    this.db.prepare(`
      INSERT INTO fact_cache_metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  assertOpen() {
    if (this.closed) throw new Error('FactCache is closed');
  }
}

function normalizeFact(fact) {
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
    throw new TypeError('fact must be an object');
  }
  const now = Date.now();
  const timestamps = fact.timestamps && typeof fact.timestamps === 'object' ? fact.timestamps : {};
  return {
    partition: requiredString(fact.partition, 'partition'),
    targetKey: requiredString(fact.targetKey, 'targetKey'),
    app: sanitizeValue(fact.app === undefined ? {} : fact.app, 'app'),
    runtimeEpoch: requiredString(fact.runtimeEpoch, 'runtimeEpoch'),
    actionId: fact.actionId === undefined || fact.actionId === null ? null : String(fact.actionId),
    dedupeKey: fact.dedupeKey === undefined || fact.dedupeKey === null
      ? null
      : normalizeDedupeKey(fact.dedupeKey),
    timestamps: {
      occurredAtMs: finiteInteger(timestamps.occurredAtMs, now, 'timestamps.occurredAtMs'),
      observedAtMs: finiteInteger(timestamps.observedAtMs, now, 'timestamps.observedAtMs'),
      ingestedAtMs: now,
    },
    payload: sanitizeValue(fact.payload === undefined ? null : fact.payload, 'payload'),
  };
}

function sanitizeValue(value, key = '', ancestors = new WeakSet()) {
  if (isSensitiveKey(key)) return REDACTED;
  if (value === null || value === undefined) return value === undefined ? null : value;
  if (typeof value === 'string') return sanitizeString(value, key);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (ancestors.has(value)) throw new TypeError('fact must be JSON-serializable without cycles');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry) => sanitizeValue(entry, key, ancestors));
  } else {
    result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = sanitizeValue(childValue, childKey, ancestors);
    }
  }
  ancestors.delete(value);
  return result;
}

function sanitizeString(value, key) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        value = JSON.stringify(sanitizeValue(parsed));
      }
    } catch (_) {
      // Preserve non-JSON text and apply the bounded inline rules below.
    }
  }
  if (looksLikeUrlKey(key)) {
    try {
      const url = new URL(value);
      for (const parameter of [...url.searchParams.keys()]) {
        if (isSensitiveKey(parameter)) url.searchParams.set(parameter, REDACTED);
      }
      value = url.toString();
    } catch (_) {
      // Non-absolute URL-like values still receive credential pattern redaction below.
    }
  }
  let sanitized = value.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]');
  // Device/app logs are intentionally unstructured, so key-based object
  // redaction is not enough. Scrub common header and assignment forms before
  // any string becomes observable through the cache.
  sanitized = sanitized.replace(
    /(\b(?:authorization|proxy[-_ ]?authorization|cookie|set[-_ ]?cookie)\b\s*[:=]\s*)[^\r\n]*/gi,
    '$1[REDACTED]',
  );
  const assignmentPattern = /((?:["']?)(?:password|passwd|passcode|client[-_ ]?secret|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|session[-_ ]?token|secret|token|credentials?)(?:["']?)\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&#"'{}\[\]]+)/gi;
  sanitized = sanitized.replace(assignmentPattern, (_match, prefix, secretValue) => {
    const unquotedValue = secretValue.replace(/^["']|["']$/g, '');
    if (unquotedValue === REDACTED || /^%5bredacted%5d$/i.test(unquotedValue)) {
      return _match;
    }
    const quote = secretValue.length >= 2
      && (secretValue[0] === '"' || secretValue[0] === "'")
      && secretValue.at(-1) === secretValue[0]
      ? secretValue[0]
      : '';
    return `${prefix}${quote}${REDACTED}${quote}`;
  });
  return sanitized;
}

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  return [
    'authorization',
    'proxyauthorization',
    'cookie',
    'setcookie',
    'password',
    'passwd',
    'passcode',
    'secret',
    'clientsecret',
    'apikey',
    'token',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'sessiontoken',
    'credential',
    'credentials',
  ].includes(normalized)
    || normalized.endsWith('password')
    || normalized.endsWith('secret')
    || normalized.endsWith('token')
    || normalized === 'privatekey';
}

function looksLikeUrlKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === 'url' || normalized === 'uri' || normalized.endsWith('url') || normalized.endsWith('uri');
}

function resolveSqliteModule(options) {
  if (Object.hasOwn(options, 'sqliteModule')) {
    const candidate = options.sqliteModule;
    return candidate && typeof candidate.DatabaseSync === 'function'
      ? { module: candidate, reason: null }
      : { module: null, reason: 'node_sqlite_unavailable' };
  }
  try {
    const candidate = require('node:sqlite');
    return candidate && typeof candidate.DatabaseSync === 'function'
      ? { module: candidate, reason: null }
      : { module: null, reason: 'node_sqlite_unavailable' };
  } catch (error) {
    if (error && (error.code === 'ERR_UNKNOWN_BUILTIN_MODULE' || error.code === 'MODULE_NOT_FOUND')) {
      return { module: null, reason: 'node_sqlite_unavailable' };
    }
    return { module: null, reason: `node_sqlite_load_failed:${error.code || error.name || 'error'}` };
  }
}

function normalizeDedupeKey(value) {
  return crypto.createHash('sha256')
    .update(`fact-dedupe-v1\0${String(value)}`)
    .digest('base64url');
}

function rowToFact(row) {
  return {
    globalSeq: Number(row.global_seq),
    partition: row.partition_name,
    targetKey: row.target_key,
    app: JSON.parse(row.app_json),
    runtimeEpoch: row.runtime_epoch,
    actionId: row.action_id,
    timestamps: {
      occurredAtMs: Number(row.occurred_at_ms),
      observedAtMs: Number(row.observed_at_ms),
      ingestedAtMs: Number(row.ingested_at_ms),
    },
    payload: JSON.parse(row.payload_json),
    sizeBytes: Number(row.byte_size),
  };
}

function encodeCursor(sequence, scope, secret) {
  const payload = Buffer.from(JSON.stringify({ v: 1, s: sequence, q: scope })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 22);
  return `fc1.${payload}.${signature}`;
}

function decodeCursor(cursor, scope, secret) {
  if (typeof cursor !== 'string') return { ok: false, message: 'Cursor must be a string.' };
  const match = /^fc1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(cursor);
  if (!match) return { ok: false, message: 'Cursor format is invalid.' };
  const expected = crypto.createHmac('sha256', secret).update(match[1]).digest('base64url').slice(0, 22);
  const providedBuffer = Buffer.from(match[2]);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return { ok: false, message: 'Cursor signature is invalid.' };
  }
  try {
    const payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    if (payload.v !== 1 || !Number.isSafeInteger(payload.s) || payload.s < 0 || payload.q !== scope) {
      return { ok: false, message: 'Cursor scope is invalid.' };
    }
    return { ok: true, sequence: payload.s };
  } catch (_) {
    return { ok: false, message: 'Cursor payload is invalid.' };
  }
}

function normalizeReadQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new TypeError('query must be an object');
  }
  const partitions = query.partitions === undefined
    ? []
    : [...new Set((Array.isArray(query.partitions) ? query.partitions : [query.partitions]).map(String))].sort();
  for (const partition of partitions) {
    if (!Object.hasOwn(PARTITION_WEIGHTS, partition)) {
      throw new TypeError(`partition must be one of: ${Object.keys(PARTITION_WEIGHTS).join(', ')}`);
    }
  }
  const limit = positiveInteger(query.limit, 100, 'limit');
  if (limit > 1000) throw new TypeError('limit must not exceed 1000');
  return {
    cursor: query.cursor === undefined || query.cursor === null ? null : query.cursor,
    targetKey: query.targetKey === undefined || query.targetKey === null ? null : String(query.targetKey),
    partitions,
    runtimeEpoch: query.runtimeEpoch === undefined || query.runtimeEpoch === null
      ? null
      : String(query.runtimeEpoch),
    hasActionId: Object.hasOwn(query, 'actionId'),
    actionId: query.actionId === undefined || query.actionId === null ? null : String(query.actionId),
    fromObservedAtMs: optionalInteger(query.fromObservedAtMs, 'fromObservedAtMs'),
    toObservedAtMs: optionalInteger(query.toObservedAtMs, 'toObservedAtMs'),
    limit,
  };
}

function cursorScope(query) {
  return crypto.createHash('sha256').update(JSON.stringify({
    targetKey: query.targetKey,
    partitions: query.partitions,
    runtimeEpoch: query.runtimeEpoch,
    hasActionId: query.hasActionId,
    actionId: query.actionId,
    fromObservedAtMs: query.fromObservedAtMs,
    toObservedAtMs: query.toObservedAtMs,
  })).digest('base64url').slice(0, 22);
}

function storageBytes(dbPath, hardQuotaBytes) {
  const sizes = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map(fileSize);
  const totalBytes = sizes[0] + sizes[1] + sizes[2];
  return {
    databaseBytes: sizes[0],
    walBytes: sizes[1],
    shmBytes: sizes[2],
    totalBytes,
    hardQuotaBytes,
    overQuota: totalBytes > hardQuotaBytes,
  };
}

function emptyEvictionSummary() {
  return { count: 0, bytes: 0, throughGlobalSeq: 0 };
}

function addEviction(summary, row) {
  summary.count += 1;
  summary.bytes += Number(row.byte_size);
  summary.throughGlobalSeq = Math.max(summary.throughGlobalSeq, Number(row.global_seq));
  return summary;
}

function summarizeEvictions(rows) {
  const summary = emptyEvictionSummary();
  for (const row of rows) addEviction(summary, row);
  return summary;
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if (error && error.code === 'ENOENT') return 0;
    throw error;
  }
}

function restrictFactCacheDirectory(directory, shouldRestrict) {
  if (!shouldRestrict || process.platform === 'win32') return;
  fs.chmodSync(directory, 0o700);
}

function restrictFactCacheFiles(dbPath) {
  if (process.platform === 'win32') return;
  for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function requiredString(value, name) {
  const result = value === undefined || value === null ? '' : String(value).trim();
  if (!result) throw new TypeError(`${name} must be a non-empty string`);
  return result;
}

function normalizeProfile(value) {
  const raw = value === undefined || value === null ? '512mb' : String(value).trim().toLowerCase();
  const profile = {
    default: '512mb',
    512: '512mb',
    '512m': '512mb',
    256: '256mb',
    '256m': '256mb',
    64: '64mb',
    '64m': '64mb',
  }[raw] || raw;
  if (profile === 'auto') return profile;
  if (!Object.hasOwn(FACT_CACHE_PROFILES, profile)) {
    throw new TypeError(`profile must be auto or one of: ${Object.keys(FACT_CACHE_PROFILES).join(', ')}`);
  }
  return profile;
}

function selectAutomaticProfile(storageCapacity) {
  if (storageCapacity.totalBytes >= 16 * GIB && storageCapacity.availableBytes >= 4 * GIB) {
    return '512mb';
  }
  if (storageCapacity.totalBytes >= 4 * GIB && storageCapacity.availableBytes >= 2 * GIB) {
    return '256mb';
  }
  return '64mb';
}

function normalizeStorageCapacity(value) {
  if (!value || typeof value !== 'object') throw new TypeError('storageCapacity must be an object');
  const totalBytes = positiveInteger(value.totalBytes, undefined, 'storageCapacity.totalBytes');
  const availableBytes = nonNegativeInteger(
    value.availableBytes,
    undefined,
    'storageCapacity.availableBytes',
  );
  if (availableBytes > totalBytes) {
    throw new TypeError('storageCapacity.availableBytes cannot exceed totalBytes');
  }
  return { totalBytes, availableBytes };
}

function readStorageCapacity(directory) {
  let probe = path.resolve(directory);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) throw new Error(`No existing parent for FactCache directory: ${directory}`);
    probe = parent;
  }
  const stats = fs.statfsSync(probe);
  const blockSize = Number(stats.bsize);
  return {
    totalBytes: Number(stats.blocks) * blockSize,
    availableBytes: Number(stats.bavail) * blockSize,
  };
}

function defaultFactCachePath() {
  if (process.env.AI_APP_BRIDGE_FACT_CACHE_PATH) {
    return path.resolve(process.env.AI_APP_BRIDGE_FACT_CACHE_PATH);
  }
  if (process.platform === 'win32') {
    const root = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(root, 'ai-app-bridge', 'fact-cache', 'facts.sqlite');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'ai-app-bridge', 'fact-cache', 'facts.sqlite');
  }
  const root = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(root, 'ai-app-bridge', 'fact-cache', 'facts.sqlite');
}

function positiveInteger(value, fallback, name) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return candidate;
}

function nonNegativeInteger(value, fallback, name) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return candidate;
}

function finiteInteger(value, fallback, name) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate)) throw new TypeError(`${name} must be a safe integer`);
  return candidate;
}

function optionalInteger(value, name) {
  if (value === undefined || value === null) return null;
  return finiteInteger(value, undefined, name);
}

function createFactCache(options = {}) {
  return new FactCache(options);
}

module.exports = {
  FACT_CACHE_PROFILES,
  FactCache,
  PARTITION_WEIGHTS,
  createFactCache,
  defaultFactCachePath,
};
