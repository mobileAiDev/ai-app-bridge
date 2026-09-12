const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

let sqliteModule = null;
try {
  sqliteModule = require('node:sqlite');
} catch (_) {
  // SQLite-specific migration coverage is skipped on older Node versions.
}

const {
  FACT_CACHE_PROFILES,
  FactCache,
  PARTITION_WEIGHTS,
  createFactCache,
} = require('../test-support/fact-cache.js');

function makeCache(t, options = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-app-bridge-fact-cache-')));
  const cache = new FactCache({
    directory,
    budgetBytes: 512 * 1024,
    mmapBytes: 128 * 1024,
    ...options,
  });
  t.after(() => {
    cache.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return cache;
}

test('FactCache persists ordered facts through its public SQLite interface with WAL and mmap enabled', (t) => {
  const cache = makeCache(t);

  const first = cache.append({
    partition: 'ui',
    targetKey: 'android:emulator-5554:com.example.app',
    app: { platform: 'android', packageName: 'com.example.app' },
    runtimeEpoch: 'runtime-1',
    actionId: 'action-1',
    timestamps: { occurredAtMs: 1000, observedAtMs: 1010 },
    payload: { surface: 'checkout' },
  });
  const second = cache.append({
    partition: 'network',
    targetKey: 'android:emulator-5554:com.example.app',
    app: { platform: 'android', packageName: 'com.example.app' },
    runtimeEpoch: 'runtime-1',
    actionId: 'action-1',
    timestamps: { occurredAtMs: 1020, observedAtMs: 1030 },
    payload: { url: 'https://example.test/cart' },
  });

  assert.deepEqual(
    [first.ok, first.stored, first.globalSeq, second.globalSeq],
    [true, true, 1, 2],
  );

  const page = cache.read({ targetKey: 'android:emulator-5554:com.example.app' });
  assert.equal(page.ok, true);
  assert.equal(page.gap, false);
  assert.deepEqual(page.items.map((item) => item.globalSeq), [1, 2]);
  assert.equal(page.items[0].timestamps.occurredAtMs, 1000);
  assert.equal(page.items[0].timestamps.observedAtMs, 1010);
  assert.equal(Number.isSafeInteger(page.items[0].timestamps.ingestedAtMs), true);
  assert.equal(page.items[0].targetKey, 'android:emulator-5554:com.example.app');
  assert.deepEqual(page.items[0].app, { platform: 'android', packageName: 'com.example.app' });
  assert.equal(page.items[0].runtimeEpoch, 'runtime-1');
  assert.equal(page.items[0].actionId, 'action-1');
  assert.match(page.cursor, /^fc1\./);
  assert.notEqual(page.cursor, '2');

  const status = cache.status();
  assert.equal(status.adapter, 'sqlite');
  assert.equal(status.degraded, false);
  assert.equal(status.sqlite.journalMode, 'wal');
  assert.deepEqual(status.sqlite.mmap, {
    requestedBytes: 128 * 1024,
    effectiveBytes: 128 * 1024,
    enabled: true,
  });
});

test('FactCache restricts its dedicated directory and SQLite sidecar permissions', { skip: !sqliteModule }, (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-app-bridge-fact-permissions-')));
  const directory = path.join(root, 'fact-cache');
  fs.mkdirSync(directory, { mode: 0o755 });
  fs.chmodSync(directory, 0o755);
  const cache = new FactCache({ directory, budgetBytes: 512 * 1024, mmapBytes: 128 * 1024 });
  t.after(() => {
    cache.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  cache.append({
    partition: 'app-log',
    targetKey: 'android:permissions:com.example.app',
    app: { platform: 'android', packageName: 'com.example.app' },
    runtimeEpoch: 'runtime-permissions',
    actionId: null,
    payload: { message: 'private cache evidence' },
  });

  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  for (const suffix of ['', '-wal', '-shm']) {
    const file = path.join(directory, `facts.sqlite${suffix}`);
    assert.equal(fs.existsSync(file), true, `${file} should exist while the cache is open`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, `${file} should be owner-only`);
  }
});

test('FactCache does not change an existing parent mode for an explicit database path', { skip: !sqliteModule }, (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-app-bridge-fact-custom-parent-')));
  fs.chmodSync(directory, 0o755);
  const dbPath = path.join(directory, 'private-facts.sqlite');
  const cache = new FactCache({ path: dbPath, budgetBytes: 512 * 1024, mmapBytes: 128 * 1024 });
  t.after(() => {
    cache.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
  assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
});

test('FactCache applies weighted soft and hard byte quotas and evicts the oldest partition facts', (t) => {
  const budgetBytes = 256 * 1024;
  const cache = makeCache(t, { budgetBytes, mmapBytes: 64 * 1024 });
  const base = {
    partition: 'note',
    targetKey: 'web:session-1:main',
    app: { platform: 'web', origin: 'https://example.test' },
    runtimeEpoch: 'page-load-1',
    actionId: null,
    timestamps: { occurredAtMs: 2000, observedAtMs: 2010 },
  };

  cache.append({ ...base, payload: { label: 'oldest', body: 'a'.repeat(7000) } });
  cache.append({ ...base, payload: { label: 'newest', body: 'b'.repeat(7000) } });

  const page = cache.read({ targetKey: base.targetKey });
  assert.deepEqual(page.items.map((item) => [item.globalSeq, item.payload.label]), [[2, 'newest']]);

  const status = cache.status();
  assert.deepEqual(PARTITION_WEIGHTS, {
    network: 30,
    ui: 20,
    'app-log': 12,
    'device-log': 8,
    'state-event': 10,
    action: 10,
    note: 5,
    index: 5,
  });
  assert.equal(status.quota.budgetBytes, budgetBytes);
  assert.equal(status.quota.partitions.note.hardQuotaBytes, Math.floor(budgetBytes * 0.05));
  assert.equal(
    status.quota.partitions.note.softQuotaBytes,
    Math.floor(Math.floor(budgetBytes * 0.05) * 0.9),
  );
  assert.ok(status.quota.partitions.note.bytes <= status.quota.partitions.note.softQuotaBytes);
  assert.ok(status.evictions.count >= 1);
  assert.equal(
    status.storage.totalBytes,
    status.storage.databaseBytes + status.storage.walBytes + status.storage.shmBytes,
  );
  assert.ok(status.storage.totalBytes <= budgetBytes);
});

test('FactCache paginates with opaque cursors and reports an explicit gap when a cursor expires', (t) => {
  const cache = makeCache(t, { budgetBytes: 256 * 1024 });
  const targetKey = 'ios:device-1:com.example.app';
  const base = {
    partition: 'action',
    targetKey,
    app: { platform: 'ios', bundleId: 'com.example.app' },
    runtimeEpoch: 'launch-1',
    actionId: 'flow-1',
  };
  for (let index = 1; index <= 3; index += 1) {
    cache.append({
      ...base,
      timestamps: { occurredAtMs: 3000 + index, observedAtMs: 3100 + index },
      payload: { index },
    });
  }

  const firstPage = cache.read({
    targetKey,
    partitions: ['action'],
    runtimeEpoch: 'launch-1',
    actionId: 'flow-1',
    limit: 1,
  });
  assert.deepEqual(firstPage.items.map((item) => item.globalSeq), [1]);
  assert.equal(firstPage.hasMore, true);

  const secondPage = cache.read({
    targetKey,
    partitions: ['action'],
    runtimeEpoch: 'launch-1',
    actionId: 'flow-1',
    cursor: firstPage.cursor,
    limit: 1,
  });
  assert.deepEqual(secondPage.items.map((item) => item.globalSeq), [2]);
  assert.equal(secondPage.gap, false);

  const tampered = cache.read({
    targetKey,
    partitions: ['action'],
    runtimeEpoch: 'launch-1',
    actionId: 'flow-1',
    cursor: `${firstPage.cursor}x`,
  });
  assert.deepEqual(
    { ok: tampered.ok, error: tampered.error, gap: tampered.gap },
    { ok: false, error: 'invalid_cursor', gap: false },
  );

  const noteBase = {
    ...base,
    partition: 'note',
    actionId: null,
    timestamps: { occurredAtMs: 4000, observedAtMs: 4010 },
  };
  cache.append({ ...noteBase, payload: { body: 'c'.repeat(7000) } });
  cache.append({ ...noteBase, payload: { body: 'd'.repeat(7000) } });

  const expired = cache.read({
    targetKey,
    partitions: ['action'],
    runtimeEpoch: 'launch-1',
    actionId: 'flow-1',
    cursor: firstPage.cursor,
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.error, 'cursor_expired');
  assert.equal(expired.cursorExpired, true);
  assert.equal(expired.gap, true);
  assert.ok(expired.evictedThroughGlobalSeq >= 4);
});

test('FactCache reports node:sqlite absence instead of pretending memory is persistent storage', () => {
  assert.throws(
    () => new FactCache({
      directory: path.join(os.tmpdir(), 'ai-app-bridge-fact-cache-unavailable'),
      sqliteModule: null,
      budgetBytes: 64 * 1024,
      mmapBytes: 32 * 1024,
    }),
    (error) => {
      assert.equal(error.code, 'node_sqlite_unavailable');
      assert.match(error.message, /FactCache requires node:sqlite/);
      return true;
    },
  );
});

test('FactCache redacts only password and token material before facts are observable', (t) => {
  const cache = makeCache(t);
  cache.append({
    partition: 'network',
    targetKey: 'web:session-sensitive:main',
    app: {
      platform: 'web',
      origin: 'https://example.test',
      clientSecret: 'app-client-secret',
    },
    runtimeEpoch: 'load-sensitive',
    actionId: 'login-action',
    timestamps: { occurredAtMs: 6000, observedAtMs: 6010 },
    payload: {
      headers: {
        Authorization: 'Bearer live-access-token',
        Cookie: 'session=live-cookie',
        'X-Trace-Id': 'trace-safe',
      },
      body: {
        password: 'plain-password',
        nested: { api_key: 'nested-api-key' },
      },
      url: 'https://example.test/login?token=query-token&mode=safe',
      message: 'request used Bearer live-access-token',
    },
  });

  const record = cache.read({ targetKey: 'web:session-sensitive:main' }).items[0];
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes('plain-password'), false);
  assert.equal(serialized.includes('query-token'), false);
  assert.equal(serialized.includes('live-access-token'), false);
  assert.equal(record.app.clientSecret, 'app-client-secret');
  assert.equal(record.payload.headers.Authorization, '[REDACTED]');
  assert.equal(record.payload.headers.Cookie, 'session=live-cookie');
  assert.equal(record.payload.headers['X-Trace-Id'], 'trace-safe');
  assert.equal(record.payload.body.password, '[REDACTED]');
  assert.equal(record.payload.body.nested.api_key, 'nested-api-key');
  assert.match(record.payload.url, /token=%5BREDACTED%5D/);
  assert.match(record.payload.url, /mode=safe/);
  assert.equal(record.payload.message, 'request used Bearer [REDACTED]');
});

test('FactCache redacts credentials embedded in unstructured device log lines', (t) => {
  const cache = makeCache(t);
  cache.append({
    partition: 'device-log',
    targetKey: 'android:device-sensitive:com.example.app',
    app: { platform: 'android', packageName: 'com.example.app' },
    runtimeEpoch: 'process-sensitive',
    timestamps: { occurredAtMs: 6100, observedAtMs: 6110 },
    payload: {
      stream: 'logcat',
      record: {
        lines: [
          'Login password=plain-password token: query-token mode=safe',
          'request {"api_key":"nested-api-key","message":"safe"}',
          'Cookie: session=live-cookie; account=user-1',
        ],
      },
    },
  });

  const serialized = JSON.stringify(cache.read({
    targetKey: 'android:device-sensitive:com.example.app',
  }).items[0]);
  assert.equal(serialized.includes('plain-password'), false);
  assert.equal(serialized.includes('query-token'), false);
  assert.match(serialized, /nested-api-key/);
  assert.match(serialized, /live-cookie/);
  assert.match(serialized, /mode=safe/);
  assert.match(serialized, /message/);
});

test('FactCache keeps JSON body strings parseable while redacting inline credentials', (t) => {
  const cache = makeCache(t);
  const requestBody = JSON.stringify({
    counter: 22,
    input: 'password=FinalSecret token=FinalBearer',
    nested: { apiKey: 'NestedSecret', safe: true },
  });
  cache.append({
    partition: 'network',
    targetKey: 'android:device-json:com.example.app',
    app: { platform: 'android', packageName: 'com.example.app' },
    runtimeEpoch: 'runtime-json',
    timestamps: { occurredAtMs: 6200, observedAtMs: 6210 },
    payload: { stream: 'network', record: { id: 1, requestBody } },
  });

  const record = cache.query({ partition: 'network' }).items[0];
  const parsed = JSON.parse(record.payload.record.requestBody);
  assert.equal(parsed.counter, 22);
  assert.equal(parsed.input, 'password=[REDACTED] token=[REDACTED]');
  assert.equal(parsed.nested.apiKey, 'NestedSecret');
  assert.equal(parsed.nested.safe, true);
  assert.equal(JSON.stringify(record).includes('FinalSecret'), false);
  assert.equal(JSON.stringify(record).includes('FinalBearer'), false);
});

test('FactCache exposes singleton-friendly append/query/stats aliases and selectable budget profiles', (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-app-bridge-fact-cache-api-')));
  const dbPath = path.join(directory, 'singleton.sqlite');
  const cache = createFactCache({ path: dbPath, profile: '64mb', mmapBytes: 2 * 1024 * 1024 });
  const defaultProfile = createFactCache({ path: path.join(directory, 'default.sqlite') });
  const middleProfile = createFactCache({ path: path.join(directory, 'middle.sqlite'), profile: 256 });
  t.after(() => {
    cache.close();
    defaultProfile.close();
    middleProfile.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  cache.append('app-log', {
    targetKey: 'android:device-2:com.example.api',
    app: { platform: 'android', packageName: 'com.example.api' },
    runtimeEpoch: 'process-2',
    actionId: 'action-api',
    timestamps: { occurredAtMs: 7000, observedAtMs: 7010 },
    payload: { message: 'ready' },
  });

  const page = cache.query({
    partition: 'app-log',
    target: 'android:device-2:com.example.api',
    limit: 10,
  });
  assert.deepEqual(page.items.map((item) => item.payload.message), ['ready']);
  assert.deepEqual(FACT_CACHE_PROFILES, {
    '512mb': 512 * 1024 * 1024,
    '256mb': 256 * 1024 * 1024,
    '64mb': 64 * 1024 * 1024,
  });
  assert.deepEqual(
    [defaultProfile.stats().profile, defaultProfile.stats().budgetBytes],
    ['512mb', FACT_CACHE_PROFILES['512mb']],
  );
  assert.deepEqual(
    [middleProfile.stats().profile, middleProfile.stats().budgetBytes],
    ['256mb', FACT_CACHE_PROFILES['256mb']],
  );
  const stats = cache.stats();
  assert.equal(stats.profile, '64mb');
  assert.equal(stats.budgetBytes, FACT_CACHE_PROFILES['64mb']);
  assert.equal(stats.dbPath, dbPath);
  assert.equal(stats.quota.partitions['app-log'].count, 1);
});

test('FactCache auto profile uses explicit disk-capacity thresholds', (t) => {
  const gib = 1024 * 1024 * 1024;
  const cases = [
    {
      storageCapacity: { totalBytes: 20 * gib, availableBytes: 5 * gib },
      profile: '512mb',
    },
    {
      storageCapacity: { totalBytes: 8 * gib, availableBytes: 3 * gib },
      profile: '256mb',
    },
    {
      storageCapacity: { totalBytes: 3 * gib, availableBytes: 1 * gib },
      profile: '64mb',
    },
  ];
  for (const [index, entry] of cases.entries()) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `ai-app-bridge-fact-cache-auto-${index}-`));
    const cache = new FactCache({
      directory,
      profile: 'auto',
      storageCapacity: entry.storageCapacity,
      mmapBytes: 2 * 1024 * 1024,
    });
    t.after(() => {
      cache.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const status = cache.status();
    assert.equal(status.profile, entry.profile);
    assert.equal(status.budgetBytes, FACT_CACHE_PROFILES[entry.profile]);
    assert.deepEqual(status.profileSelection, {
      mode: 'auto',
      ...entry.storageCapacity,
    });
  }
});

test('FactCache accounts for database, WAL, and SHM files inside an injected small storage budget', (t) => {
  const budgetBytes = 256 * 1024;
  const cache = makeCache(t, { budgetBytes, mmapBytes: 64 * 1024 });
  for (let index = 0; index < 100; index += 1) {
    cache.append('network', {
      targetKey: 'android:storage-budget:com.example.storage',
      app: { platform: 'android', packageName: 'com.example.storage' },
      runtimeEpoch: 'storage-run-1',
      actionId: `request-${index}`,
      timestamps: { occurredAtMs: 8000 + index, observedAtMs: 9000 + index },
      payload: { index, body: 'z'.repeat(4000) },
    });
  }

  const status = cache.status();
  assert.equal(status.storage.hardQuotaBytes, budgetBytes);
  assert.equal(
    status.storage.totalBytes,
    status.storage.databaseBytes + status.storage.walBytes + status.storage.shmBytes,
  );
  assert.ok(status.storage.databaseBytes > 0);
  assert.ok(status.storage.shmBytes > 0);
  assert.ok(status.storage.totalBytes <= budgetBytes);
  assert.equal(status.storage.overQuota, false);
  assert.ok(status.evictions.count > 0);
});

test('FactCache preserves global sequence and cursor continuity when the SQLite cache is reopened', (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-app-bridge-fact-cache-reopen-')));
  const dbPath = path.join(directory, 'reopen.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const base = {
    targetKey: 'android:reopen:com.example.reopen',
    app: { platform: 'android', packageName: 'com.example.reopen' },
    runtimeEpoch: 'process-reopen',
    actionId: 'action-reopen',
  };

  const firstCache = new FactCache({ path: dbPath, budgetBytes: 512 * 1024 });
  const first = firstCache.append('ui', {
    ...base,
    timestamps: { occurredAtMs: 10000, observedAtMs: 10010 },
    payload: { state: 'before' },
  });
  const cursor = firstCache.query({ target: base.targetKey }).cursor;
  firstCache.close();

  const secondCache = new FactCache({ path: dbPath, budgetBytes: 512 * 1024 });
  t.after(() => secondCache.close());
  const second = secondCache.append('action', {
    ...base,
    timestamps: { occurredAtMs: 10020, observedAtMs: 10030 },
    payload: { state: 'after' },
  });
  const continued = secondCache.query({ target: base.targetKey, cursor });

  assert.deepEqual([first.globalSeq, second.globalSeq], [1, 2]);
  assert.deepEqual(continued.items.map((item) => item.globalSeq), [2]);
  assert.deepEqual(secondCache.status().sequences, {
    oldestAvailableGlobalSeq: 1,
    latestGlobalSeq: 2,
    nextGlobalSeq: 3,
    evictedThroughGlobalSeq: 0,
  });
});

test('FactCache persists dedupe keys across SQLite reopen without allocating a second sequence', (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-app-bridge-fact-dedupe-')));
  const dbPath = path.join(directory, 'facts.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fact = {
    partition: 'app-log',
    targetKey: 'android:device-1:com.example.app',
    app: { platform: 'android', packageName: 'com.example.app' },
    runtimeEpoch: 'runtime-1',
    dedupeKey: JSON.stringify(['android:device-1:com.example.app', 'runtime-1', 'logs', '7']),
    timestamps: { occurredAtMs: 7000, observedAtMs: 7010 },
    payload: { kind: 'evidence', stream: 'logs', record: { id: 7, message: 'ready' } },
  };

  const firstCache = createFactCache({ path: dbPath, profile: '64mb' });
  const first = firstCache.append(fact);
  firstCache.close();

  const reopened = createFactCache({ path: dbPath, profile: '64mb' });
  const duplicate = reopened.append(fact);
  const records = reopened.query({ target: fact.targetKey, partition: 'app-log' });
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.globalSeq, first.globalSeq);
  assert.equal(records.count, 1);
  assert.equal(records.items[0].dedupeKey, undefined);
  assert.equal(reopened.status().sequences.latestGlobalSeq, first.globalSeq);
  reopened.close();
});

test('FactCache migrates an existing schema and backfills evidence dedupe identity', {
  skip: !sqliteModule,
}, (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-app-bridge-fact-migrate-')));
  const dbPath = path.join(directory, 'facts.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const targetKey = 'android:device-old:com.example.app';
  const runtimeEpoch = 'runtime-old';
  const oldDb = new sqliteModule.DatabaseSync(dbPath);
  oldDb.exec(`
    CREATE TABLE facts (
      global_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      partition_name TEXT NOT NULL,
      target_key TEXT NOT NULL,
      app_json TEXT NOT NULL,
      runtime_epoch TEXT NOT NULL,
      action_id TEXT,
      occurred_at_ms INTEGER NOT NULL,
      observed_at_ms INTEGER NOT NULL,
      ingested_at_ms INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      byte_size INTEGER NOT NULL
    );
    CREATE TABLE fact_cache_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const payload = { kind: 'evidence', stream: 'logs', record: { id: 17, message: 'old' } };
  oldDb.prepare(`
    INSERT INTO facts (
      partition_name, target_key, app_json, runtime_epoch, action_id,
      occurred_at_ms, observed_at_ms, ingested_at_ms, payload_json, byte_size
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'app-log',
    targetKey,
    JSON.stringify({ platform: 'android', packageName: 'com.example.app' }),
    runtimeEpoch,
    null,
    8000,
    8010,
    8020,
    JSON.stringify(payload),
    256,
  );
  oldDb.close();

  const migrated = createFactCache({ path: dbPath, profile: '64mb' });
  const duplicate = migrated.append({
    partition: 'app-log',
    targetKey,
    app: { platform: 'android', packageName: 'com.example.app' },
    runtimeEpoch,
    dedupeKey: JSON.stringify([targetKey, runtimeEpoch, 'logs', '17']),
    timestamps: { occurredAtMs: 8000, observedAtMs: 8010 },
    payload,
  });

  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.globalSeq, 1);
  assert.equal(migrated.query({ target: targetKey, partition: 'app-log' }).count, 1);
  assert.equal(migrated.db.prepare('PRAGMA table_info(facts)').all().some((column) => column.name === 'dedupe_key'), true);
  migrated.close();
});

test('FactCache reapplies a smaller injected quota profile when an existing SQLite cache is opened', (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-app-bridge-fact-cache-resize-')));
  const dbPath = path.join(directory, 'resize.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fact = {
    targetKey: 'web:resize:main',
    app: { platform: 'web', origin: 'https://example.test' },
    runtimeEpoch: 'resize-load',
    actionId: null,
    timestamps: { occurredAtMs: 11000, observedAtMs: 11010 },
    payload: { body: 'r'.repeat(40 * 1024) },
  };

  const large = new FactCache({ path: dbPath, budgetBytes: 2 * 1024 * 1024 });
  assert.equal(large.append('note', fact).stored, true);
  large.close();

  const small = new FactCache({ path: dbPath, budgetBytes: 256 * 1024 });
  t.after(() => small.close());
  assert.deepEqual(small.query({ target: fact.targetKey }).items, []);
  assert.ok(small.status().evictions.count >= 1);
  assert.ok(small.status().storage.totalBytes <= 256 * 1024);
});
