'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { normalizePersistentFact } = require('../bin/fact-codec');
const { SegmentIndex } = require('../bin/segment-index');

function makeIndex(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'segment-index-')));
  const index = new SegmentIndex({ directory });
  t.after(() => {
    index.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, index };
}

function indexedFact(sequence, overrides = {}) {
  const fact = normalizePersistentFact({
    partition: overrides.partition || 'ui',
    targetKey: overrides.targetKey || 'android:device:com.example',
    app: { platform: 'android' },
    runtimeEpoch: overrides.runtimeEpoch || 'runtime-1',
    actionId: overrides.actionId === undefined ? `action-${sequence}` : overrides.actionId,
    ...(overrides.dedupeKey ? { dedupeKey: overrides.dedupeKey } : {}),
    timestamps: {
      occurredAtMs: 1_000 + sequence,
      observedAtMs: 2_000 + sequence,
    },
    payload: { secret: 'must-not-enter-index', sequence },
  }, 3_000 + sequence);
  return {
    fact,
    location: {
      sequence,
      segmentId: Math.ceil(sequence / 2),
      frameOffset: 64 + (sequence * 80),
      payloadLength: 40 + sequence,
    },
  };
}

test('SegmentIndex stores only query metadata and physical locations', (t) => {
  const { directory, index } = makeIndex(t);
  const first = indexedFact(1, { dedupeKey: 'capture-1' });
  index.insert(first.fact, first.location);

  const queried = index.query({ targetKey: first.fact.targetKey });
  assert.equal(queried.items.length, 1);
  assert.deepEqual(queried.items[0], {
    sequence: 1,
    partition: 'ui',
    targetKey: 'android:device:com.example',
    runtimeEpoch: 'runtime-1',
    actionId: 'action-1',
    dedupeKey: first.fact.dedupeKey,
    timestamps: { occurredAtMs: 1001, observedAtMs: 2001, ingestedAtMs: 3001 },
    segmentId: 1,
    frameOffset: 144,
    payloadLength: 41,
  });
  assert.equal(index.findDedupe(first.fact.dedupeKey).sequence, 1);

  index.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const databaseBytes = fs.readFileSync(path.join(directory, 'index.sqlite'));
  assert.equal(databaseBytes.includes(Buffer.from('must-not-enter-index')), false);
  assert.equal(
    index.db.prepare('PRAGMA table_info(segment_records)').all()
      .some((column) => ['payload', 'payload_json', 'payload_blob'].includes(column.name)),
    false,
  );
  assert.equal(index.status().authoritative, false);
  assert.equal(index.status().rebuildable, true);
  assert.equal(index.status().budgetBytes, 1024 * 1024 * 1024);
  assert.equal(index.status().quotaScope, 'host-sqlite-projection');
  assert.ok(index.status().maxPageCount * index.status().pageSizeBytes < index.status().budgetBytes);
});

test('SegmentIndex filters by partition, target, runtime, action and time without payload scans', (t) => {
  const { index } = makeIndex(t);
  index.insertBatch([
    indexedFact(1, { partition: 'ui', actionId: 'a' }),
    indexedFact(2, { partition: 'network', actionId: 'a' }),
    indexedFact(3, { partition: 'ui', actionId: 'b', targetKey: 'web:session:main' }),
    indexedFact(4, { partition: 'ui', actionId: null, runtimeEpoch: 'runtime-2' }),
  ]);

  assert.deepEqual(index.query({ partitions: ['ui'], actionId: 'a' }).items.map((item) => item.sequence), [1]);
  assert.deepEqual(index.query({ targetKey: 'web:session:main' }).items.map((item) => item.sequence), [3]);
  assert.deepEqual(index.query({ runtimeEpoch: 'runtime-2', actionId: null }).items.map((item) => item.sequence), [4]);
  assert.deepEqual(index.query({ fromObservedAtMs: 2002, toObservedAtMs: 2003 }).items.map((item) => item.sequence), [2, 3]);
  assert.deepEqual(index.query({ afterSequence: 2, limit: 1 }), {
    items: [index.locationForSequence(3)],
    hasMore: true,
  });
});

test('SegmentIndex is rebuildable, idempotent by sequence, and prunes evicted partition ranges', (t) => {
  const { index } = makeIndex(t);
  const first = indexedFact(1);
  index.insert(first.fact, first.location);
  index.insert(first.fact, { ...first.location, frameOffset: 999 });
  index.insert(indexedFact(2, { partition: 'network' }).fact, indexedFact(2, { partition: 'network' }).location);
  index.insert(indexedFact(3).fact, indexedFact(3).location);

  assert.equal(index.maxSequence(), 3);
  assert.equal(index.locationForSequence(1).frameOffset, 999);
  assert.equal(index.prunePartitionBefore('ui', 3), 1);
  assert.deepEqual(index.query({ partitions: ['ui'] }).items.map((item) => item.sequence), [3]);
  assert.deepEqual(index.query({ partitions: ['network'] }).items.map((item) => item.sequence), [2]);
  index.clear();
  assert.equal(index.status().count, 0);
  assert.equal(index.metadata('store-id', () => 'store-1'), 'store-1');
  assert.equal(index.metadata('store-id', () => 'store-2'), 'store-1');
  index.setMetadata('generation', '2');
  assert.equal(index.metadata('generation'), '2');
});

test('SegmentIndex reclaims deleted projection pages with incremental auto-vacuum', (t) => {
  const { index } = makeIndex(t);
  const records = [];
  for (let sequence = 1; sequence <= 2_000; sequence += 1) {
    records.push(indexedFact(sequence, {
      targetKey: `android:device-${sequence}:com.example.application`,
      actionId: `action-${sequence}`,
    }));
  }
  index.insertBatch(records);
  index.reclaim();
  const populated = index.status().totalBytes;
  index.clear();
  const reclaimed = index.reclaim();

  assert.equal(reclaimed.autoVacuum, 2);
  assert.ok(reclaimed.reclaimedBytes > 0);
  assert.ok(index.status().totalBytes < populated);
});

test('SegmentIndex constructor closes an opened database and preserves the setup error', (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'segment-index-constructor-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const primary = new Error('pragma setup failed');
  let closeCount = 0;
  class FailingDatabase {
    exec() {
      throw primary;
    }

    close() {
      closeCount += 1;
      throw new Error('database cleanup failed');
    }
  }

  assert.throws(
    () => new SegmentIndex({ directory, sqliteModule: { DatabaseSync: FailingDatabase } }),
    (error) => error === primary,
  );
  assert.equal(closeCount, 1);
});

test('SegmentIndex close still closes SQLite when its status snapshot fails', (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'segment-index-close-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const primary = new Error('status snapshot failed');
  let closeCount = 0;
  class TrackingDatabase {
    exec() {}

    close() {
      closeCount += 1;
      throw new Error('sqlite close failed');
    }
  }
  const index = new SegmentIndex({ directory, sqliteModule: { DatabaseSync: TrackingDatabase } });
  index.status = () => { throw primary; };

  assert.throws(() => index.close(), (error) => error === primary);
  assert.equal(closeCount, 1);
  assert.equal(index.closed, true);
});
