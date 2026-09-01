'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  LARGE_FACT_WIRE_V1,
  PARTITIONS,
  SegmentedFactStoreAdapter,
  createLargeFactManifest,
  encodeLargeFactChunk,
} = require('../bin/segmented-fact-store');
const { normalizePersistentFact } = require('../bin/fact-codec');
const { MemorySegmentIndex } = require('../bin/memory-segment-index');

const SEGMENT_SIZE = 4_096;
const PARTITION_QUOTAS = Array(PARTITIONS.length).fill(SEGMENT_SIZE * 2);
const BUDGET_BYTES = SEGMENT_SIZE * PARTITIONS.length * 3;

function fact(sequence, overrides = {}) {
  return {
    partition: overrides.partition || 'ui',
    targetKey: overrides.targetKey || 'android:device-a:com.example',
    app: { platform: 'android', packageName: 'com.example' },
    runtimeEpoch: overrides.runtimeEpoch || 'runtime-1',
    actionId: overrides.actionId === undefined ? `action-${sequence}` : overrides.actionId,
    ...(overrides.dedupeKey ? { dedupeKey: overrides.dedupeKey } : {}),
    timestamps: {
      occurredAtMs: 1_000 + sequence,
      observedAtMs: 2_000 + sequence,
    },
    payload: overrides.payload || { kind: 'test', sequence },
  };
}

function makeStore(t, overrides = {}) {
  const directory = overrides.directory
    || fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'segmented-fact-store-')));
  let store = new SegmentedFactStoreAdapter({
    directory,
    profile: '64mb',
    budgetBytes: BUDGET_BYTES,
    segmentSize: SEGMENT_SIZE,
    partitionQuotas: PARTITION_QUOTAS,
    ...overrides,
  });
  t.after(() => {
    try {
      store?.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  return {
    directory,
    get store() { return store; },
    replace(next) { store = next; },
    reopen(options = {}) {
      store.close();
      store = new SegmentedFactStoreAdapter({
        directory,
        profile: '64mb',
        budgetBytes: BUDGET_BYTES,
        segmentSize: SEGMENT_SIZE,
        partitionQuotas: PARTITION_QUOTAS,
        ...options,
      });
      return store;
    },
  };
}

function allSegmentBytes(directory) {
  const buffers = [];
  const pending = [path.join(directory, 'segments')];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile()) buffers.push(fs.readFileSync(child));
    }
  }
  return Buffer.concat(buffers);
}

test('large-fact wire v1 matches the cross-platform golden fixture', () => {
  const fixturePath = path.resolve(
    __dirname,
    '../../../native/segmented-fact-store/tests/golden/large-fact-v1.json',
  );
  const golden = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const payload = Buffer.from(golden.fixture.payloadUtf8, 'utf8');
  const digest = crypto.createHash('sha256').update(payload).digest();
  assert.deepEqual(LARGE_FACT_WIRE_V1, {
    chunkMagicAscii: golden.chunkWire.magicAscii,
    chunkVersion: golden.chunkWire.version,
    chunkHeaderBytes: golden.chunkWire.headerBytes,
    manifestMarkerField: golden.manifestWire.markerField,
    manifestMarkerValue: golden.manifestWire.markerValue,
  });
  assert.equal(payload.length, golden.fixture.byteLength);
  assert.equal(digest.toString('hex'), golden.fixture.sha256Hex);

  const chunk = encodeLargeFactChunk({
    digest,
    ordinal: 0,
    chunkCount: 1,
    totalLength: payload.length,
    bytes: payload,
  });
  assert.equal(chunk.subarray(0, golden.chunkWire.headerBytes).toString('hex'), golden.fixture.chunkHeaderHex);
  assert.deepEqual(chunk.subarray(golden.chunkWire.headerBytes), payload);

  const manifest = createLargeFactManifest({
    normalized: JSON.parse(golden.fixture.payloadUtf8),
    digest,
    byteLength: payload.length,
    chunks: golden.fixture.manifest.content.chunks,
  });
  assert.deepEqual(manifest, golden.fixture.manifest);
});

test('native segmented Adapter persists canonical facts, filters pages, and signs scoped cursors', (t) => {
  const harness = makeStore(t);
  const { store } = harness;
  const first = store.record(fact(1));
  const second = store.record(fact(2, {
    partition: 'network',
    payload: {
      url: 'https://url-user:url-password@example.test/tokenpluginfile.php/path-token-secret/data?token=url-secret&code=otp-secret&signature=sig-secret',
      headers: {
        Authorization: 'Bearer header-secret',
        'X-API-Key': 'x-api-key-secret',
      },
      requestBody: 'raw-request-secret',
      responseBody: Buffer.from('raw-response-secret'),
    },
  }));
  const third = store.record(fact(3, { partition: 'action' }));

  assert.deepEqual([first.globalSeq, second.globalSeq, third.globalSeq], [1, 2, 3]);
  assert.equal(third.durability, 'sync');
  const page = store.read({ targetKey: fact(1).targetKey, limit: 2 });
  assert.equal(page.ok, true);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.items.map((item) => item.globalSeq), [1, 2]);
  assert.match(page.cursor, /^fs1\./);

  const next = store.read({ targetKey: fact(1).targetKey, limit: 2, cursor: page.cursor });
  assert.deepEqual(next.items.map((item) => item.globalSeq), [3]);
  assert.equal(next.hasMore, false);
  assert.equal(store.read({ partitions: ['action'] }).items[0].globalSeq, 3);
  assert.equal(store.read({ targetKey: 'different-target', cursor: page.cursor }).error, 'invalid_cursor');
  assert.equal(store.read({ targetKey: fact(1).targetKey, cursor: `${page.cursor}x` }).error, 'invalid_cursor');

  const raw = allSegmentBytes(harness.directory).toString('utf8');
  assert.doesNotMatch(
    raw,
    /url-password|path-token-secret|url-secret|header-secret/,
  );
  assert.match(raw, /url-user/);
  assert.match(raw, /otp-secret/);
  assert.match(raw, /sig-secret/);
  assert.match(raw, /x-api-key-secret/);
  assert.match(raw, /raw-request-secret/);
  const persistedNetwork = store.read({ partitions: ['network'] }).items[0].payload;
  assert.equal(persistedNetwork.headers['X-API-Key'], 'x-api-key-secret');
  assert.match(persistedNetwork.url, /code=otp-secret/);
  assert.match(persistedNetwork.url, /signature=sig-secret/);
  assert.equal(persistedNetwork.requestBody, 'raw-request-secret');
  assert.equal(persistedNetwork.responseBody.type, 'buffer');
  assert.equal(persistedNetwork.responseBody.byteLength, Buffer.byteLength('raw-response-secret'));
});

test('reopen preserves facts and dedupe while a missing SQLite projection rebuilds from mmap', (t) => {
  const harness = makeStore(t);
  const first = harness.store.record(fact(1, { dedupeKey: 'stable-capture' }));
  harness.store.record(fact(2, { partition: 'state-event' }));
  const cursorBeforeProjectionLoss = harness.store.read({}).cursor;

  let reopened = harness.reopen();
  assert.deepEqual(reopened.read({}).items.map((item) => item.globalSeq), [1, 2]);
  const duplicate = reopened.record(fact(99, { dedupeKey: 'stable-capture' }));
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.globalSeq, first.globalSeq);
  assert.equal(duplicate.partition, 'ui');
  assert.equal(duplicate.targetKey, 'android:device-a:com.example');
  assert.equal(duplicate.runtimeEpoch, 'runtime-1');
  assert.equal(duplicate.actionId, 'action-1');

  reopened.close();
  fs.rmSync(path.join(harness.directory, 'projection'), { recursive: true, force: true });
  reopened = new SegmentedFactStoreAdapter({
    directory: harness.directory,
    profile: '64mb',
    budgetBytes: BUDGET_BYTES,
    segmentSize: SEGMENT_SIZE,
    partitionQuotas: PARTITION_QUOTAS,
  });
  harness.replace(reopened);
  assert.equal(reopened.status().recovery.recoveredRecords, 2);
  assert.deepEqual(reopened.read({}).items.map((item) => item.globalSeq), [1, 2]);
  assert.equal(reopened.read({ cursor: cursorBeforeProjectionLoss }).error, 'invalid_cursor');
});

test('Host Adapter reopens after rotation leaves a clean tail shorter than a frame prefix', (t) => {
  const harness = makeStore(t);
  const targetPayloadBytes = SEGMENT_SIZE - 104;
  const seed = fact(1, { payload: { kind: 'short-zero-tail', padding: '' } });
  const seedBytes = Buffer.byteLength(JSON.stringify(normalizePersistentFact(seed, 1_788_218_100_000)));
  seed.payload.padding = 'x'.repeat(targetPayloadBytes - seedBytes);

  const first = harness.store.record(seed, { durability: 'sync' });
  assert.equal(first.sizeBytes, targetPayloadBytes);
  harness.store.record(fact(2), { durability: 'sync' });
  assert.equal(harness.store.status().engine.partitions[1].segmentCount, 2);

  const reopened = harness.reopen();
  assert.deepEqual(reopened.read({ partitions: ['ui'] }).items.map((item) => item.globalSeq), [1, 2]);
  assert.equal(reopened.status().engine.recordCount, 2);
});

test('64mb native store returns a 600 KiB raw tree as one logical fact across reopen and projection rebuild', (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'segmented-large-fact-')));
  const rawSentinel = 'RAW-TREE-BINARY-CHUNK';
  const rawMarker = `<node text="${rawSentinel}" bounds="[0,0][1080,2400]" />`;
  const rawTree = `<hierarchy>${rawMarker}${'x'.repeat((600 * 1024) - rawMarker.length)}</hierarchy>`;
  const largeTreeFact = fact(1, {
    dedupeKey: 'large-tree-dedupe',
    payload: {
      kind: 'evidence',
      stream: 'uia-tree',
      record: { rawTree },
    },
  });
  let store = new SegmentedFactStoreAdapter({ directory, profile: '64mb' });
  t.after(() => {
    try {
      store?.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  const largeReceipt = store.record(largeTreeFact);
  const immediate = store.read({ partitions: ['ui'] });
  assert.equal(immediate.count, 1);
  assert.equal(immediate.items[0].globalSeq, largeReceipt.globalSeq);
  assert.equal(immediate.items[0].payload.record.rawTree, rawTree);
  assert.equal(immediate.items[0].sizeBytes, largeReceipt.sizeBytes);
  assert.equal(largeReceipt.globalSeq, store.status().engine.nextSequence - 1);

  const smallReceipt = store.record(fact(2, {
    payload: { kind: 'evidence', stream: 'uia-tree', record: { rawTree: '<hierarchy />' } },
  }));
  const firstPage = store.read({ partitions: ['ui'], limit: 1 });
  const secondPage = store.read({ partitions: ['ui'], limit: 1, cursor: firstPage.cursor });
  assert.deepEqual(firstPage.items.map((item) => item.globalSeq), [largeReceipt.globalSeq]);
  assert.deepEqual(secondPage.items.map((item) => item.globalSeq), [smallReceipt.globalSeq]);
  assert.equal(firstPage.hasMore, true);
  assert.equal(secondPage.hasMore, false);
  assert.equal(store.status().index.count, 2);
  assert.ok(store.status().engine.recordCount > 2, 'physical chunks must not enter the logical projection');

  const persistedBytes = allSegmentBytes(directory);
  assert.ok(persistedBytes.includes(Buffer.from(rawSentinel)), 'chunk payload must remain binary instead of base64 text');
  assert.equal(persistedBytes.includes(Buffer.from(Buffer.from(rawSentinel).toString('base64'))), false);

  store.close();
  store = new SegmentedFactStoreAdapter({ directory, profile: '64mb' });
  assert.equal(store.read({ partitions: ['ui'] }).items[0].payload.record.rawTree, rawTree);
  store.close();

  fs.rmSync(path.join(directory, 'projection'), { recursive: true, force: true });
  store = new SegmentedFactStoreAdapter({ directory, profile: '64mb' });
  const rebuilt = store.read({ partitions: ['ui'] });
  assert.deepEqual(rebuilt.items.map((item) => item.globalSeq), [largeReceipt.globalSeq, smallReceipt.globalSeq]);
  assert.equal(rebuilt.items[0].payload.record.rawTree, rawTree);
  assert.equal(store.status().recovery.recoveredRecords, 2);
  assert.equal(store.status().index.count, 2);
  const physicalCountBeforeDedupe = store.status().engine.recordCount;
  const duplicate = store.record(fact(99, { dedupeKey: 'large-tree-dedupe' }));
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.globalSeq, largeReceipt.globalSeq);
  assert.equal(duplicate.sizeBytes, largeReceipt.sizeBytes);
  assert.equal(store.status().engine.recordCount, physicalCountBeforeDedupe);
});

test('auto reopens the manifest configuration when available disk would select a different profile', (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'segmented-auto-reopen-')));
  let store = new SegmentedFactStoreAdapter({
    directory,
    profile: '64mb',
  });
  t.after(() => {
    try {
      store?.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  store.record(fact(1));
  store.close();

  store = new SegmentedFactStoreAdapter({
    directory,
    profile: 'auto',
    storageCapacity: {
      totalBytes: 64 * 1024 * 1024 * 1024,
      availableBytes: 16 * 1024 * 1024 * 1024,
    },
  });

  const status = store.status();
  assert.equal(status.profile, '64mb');
  assert.equal(status.profileSelection.mode, 'auto-existing');
  assert.equal(status.profileSelection.capacityCandidate, '1gb');
  assert.equal(status.segmentSize, 512 * 1024);
  assert.deepEqual(store.read({}).items.map((item) => item.globalSeq), [1]);
});

test('an explicit incompatible profile still rejects an existing store instead of rewriting it', (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'segmented-explicit-mismatch-')));
  const original = new SegmentedFactStoreAdapter({ directory, profile: '64mb' });
  original.record(fact(1));
  original.close();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.throws(
    () => new SegmentedFactStoreAdapter({ directory, profile: '1gb' }),
    /configured segment_size does not match the store/,
  );
});

test('SQLite projection unavailability degrades to a bounded-memory mmap scan', (t) => {
  const harness = makeStore(t, { sqliteModule: null });
  assert.equal(harness.store.status().index.adapter, 'mmap-scan-projection');
  assert.equal(harness.store.status().projectionFallback.code, 'TypeError');

  harness.store.record(fact(1, { dedupeKey: 'memory-fallback-dedupe' }));
  harness.store.record(fact(2, { partition: 'network' }));
  const cursor = harness.store.read({ partitions: ['ui'] }).cursor;
  assert.deepEqual(
    harness.store.read({ targetKey: fact(1).targetKey }).items.map((item) => item.globalSeq),
    [1, 2],
  );
  const duplicate = harness.store.record(fact(99, { dedupeKey: 'memory-fallback-dedupe' }));
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.partition, 'ui');
  assert.equal(duplicate.targetKey, 'android:device-a:com.example');
  assert.equal(duplicate.runtimeEpoch, 'runtime-1');
  assert.equal(duplicate.actionId, 'action-1');

  const reopened = harness.reopen({ sqliteModule: null });
  assert.equal(reopened.status().index.adapter, 'mmap-scan-projection');
  assert.equal(reopened.status().recovery.projectionMode, 'mmap-scan');
  assert.deepEqual(reopened.read({}).items.map((item) => item.globalSeq), [1, 2]);
  assert.equal(reopened.read({ partitions: ['ui'], cursor }).error, 'invalid_cursor');
});

test('mmap-scan fallback hides large-fact chunks and reassembles only their committed manifest', (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'segmented-large-fallback-')));
  const rawTree = `<hierarchy>${'fallback-tree'.repeat(55_000)}</hierarchy>`;
  let store = new SegmentedFactStoreAdapter({ directory, profile: '64mb', sqliteModule: null });
  t.after(() => {
    try {
      store?.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  const large = store.record(fact(1, { payload: { stream: 'uia-tree', record: { rawTree } } }));
  const small = store.record(fact(2));
  const first = store.read({ partitions: ['ui'], limit: 1 });
  const second = store.read({ partitions: ['ui'], limit: 1, cursor: first.cursor });
  assert.deepEqual(first.items.map((item) => item.globalSeq), [large.globalSeq]);
  assert.deepEqual(second.items.map((item) => item.globalSeq), [small.globalSeq]);
  assert.equal(first.items[0].payload.record.rawTree, rawTree);
  assert.equal(store.status().index.count, 2);
  assert.ok(store.status().engine.recordCount > 2);

  store.close();
  store = new SegmentedFactStoreAdapter({ directory, profile: '64mb', sqliteModule: null });
  const reopened = store.read({ partitions: ['ui'] });
  assert.deepEqual(reopened.items.map((item) => item.globalSeq), [large.globalSeq, small.globalSeq]);
  assert.equal(reopened.items[0].payload.record.rawTree, rawTree);
});

test('large-fact validation never returns partial data for changed, reordered, or missing chunks', (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'segmented-large-corrupt-')));
  const store = new SegmentedFactStoreAdapter({ directory, profile: '64mb' });
  t.after(() => {
    try {
      store.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  store.record(fact(1, { payload: { kind: 'small-before-large' } }));
  const rawTree = `<hierarchy>${'validated-tree'.repeat(50_000)}</hierarchy>`;
  store.record(fact(2, { payload: { stream: 'uia-tree', record: { rawTree } } }));
  const originalReadAt = store.engine.readAt.bind(store.engine);

  for (const mutate of [
    (payload) => { payload[payload.length - 1] ^= 0x01; },
    (payload) => { payload.writeUInt32LE(payload.readUInt32LE(48) + 1, 48); },
    (payload) => { payload.writeUInt32LE(payload.readUInt32LE(64) - 1, 64); },
  ]) {
    let changed = false;
    store.engine.readAt = (location) => {
      const scanned = originalReadAt(location);
      if (!changed && scanned.payload.subarray(0, 8).toString('ascii') === 'AIBCHN01') {
        changed = true;
        const payload = Buffer.from(scanned.payload);
        mutate(payload);
        return { ...scanned, payload };
      }
      return scanned;
    };
    try {
      assert.throws(
        () => store.read({ partitions: ['ui'] }),
        (error) => error?.code === 'large_fact_invalid',
      );
    } finally {
      store.engine.readAt = originalReadAt;
    }
  }

  let removed = false;
  store.engine.readAt = (location) => {
    const scanned = originalReadAt(location);
    if (!removed && scanned.payload.subarray(0, 8).toString('ascii') === 'AIBCHN01') {
      removed = true;
      const error = new Error('injected missing chunk');
      error.code = 'segment_location_expired';
      throw error;
    }
    return scanned;
  };
  try {
    const incomplete = store.read({ partitions: ['ui'] });
    assert.equal(incomplete.ok, false);
    assert.equal(incomplete.error, 'cursor_expired');
    assert.deepEqual(incomplete.items, []);
  } finally {
    store.engine.readAt = originalReadAt;
  }

  const intact = store.read({ partitions: ['ui'] });
  assert.equal(intact.count, 2);
  assert.equal(intact.items[1].payload.record.rawTree, rawTree);
});

test('chunks without a final manifest stay invisible to mmap fallback and projection rebuild', (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'segmented-large-orphan-')));
  let store = new SegmentedFactStoreAdapter({ directory, profile: '64mb' });
  t.after(() => {
    try {
      store?.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  const originalAppend = store.engine.append.bind(store.engine);
  store.engine.append = (partitionId, payload, options) => {
    if (payload[0] === 0x7b && payload.includes(Buffer.from('ai-app-bridge.large-fact-manifest.v1'))) {
      const error = new Error('injected manifest commit failure');
      error.code = 'injected_manifest_failure';
      throw error;
    }
    return originalAppend(partitionId, payload, options);
  };
  assert.throws(
    () => store.record(fact(1, {
      payload: { stream: 'uia-tree', record: { rawTree: 'orphan'.repeat(110_000) } },
    })),
    (error) => error?.code === 'injected_manifest_failure',
  );
  store.engine.append = originalAppend;
  assert.equal(store.read({ partitions: ['ui'] }).count, 0);
  assert.ok(store.status().engine.recordCount > 0);
  assert.equal(store.status().sequences.latestGlobalSeq, 0);

  store.close();
  fs.rmSync(path.join(directory, 'projection'), { recursive: true, force: true });
  store = new SegmentedFactStoreAdapter({ directory, profile: '64mb' });
  assert.equal(store.status().recovery.recoveredRecords, 0);
  assert.equal(store.status().index.count, 0);
  assert.equal(store.read({ partitions: ['ui'] }).count, 0);

  store.close();
  store = new SegmentedFactStoreAdapter({ directory, profile: '64mb', sqliteModule: null });
  assert.equal(store.status().index.count, 0);
  assert.equal(store.read({ partitions: ['ui'] }).count, 0);
});

test('a logical fact larger than its partition quota is rejected before writing any chunks', (t) => {
  const harness = makeStore(t);
  const before = harness.store.status().engine.recordCount;
  assert.throws(
    () => harness.store.record(fact(1, {
      payload: { stream: 'uia-tree', record: { rawTree: 'too-large'.repeat(2_000) } },
    })),
    (error) => error?.code === 'large_fact_exceeds_partition_quota',
  );
  assert.equal(harness.store.status().engine.recordCount, before);
  assert.equal(harness.store.read({ partitions: ['ui'] }).count, 0);
});

test('a committed mmap fact survives an index failure and is reconciled after restart', (t) => {
  const harness = makeStore(t);
  harness.store.index.insert = () => {
    throw new Error('injected projection failure');
  };
  const receipt = harness.store.record(fact(1, { partition: 'action' }));
  assert.equal(receipt.ok, true);
  assert.equal(receipt.globalSeq, 1);
  assert.equal(receipt.projectionDegraded, true);
  assert.equal(harness.store.status().index.adapter, 'sqlite-projection+mmap-tail');
  assert.equal(harness.store.status().projectionFallback.phase, 'post-commit');
  assert.equal(harness.store.status().projectionFallback.mode, 'sqlite-base+mmap-tail');
  assert.deepEqual(harness.store.read({ partitions: ['action'] }).items.map((item) => item.globalSeq), [1]);

  const reopened = harness.reopen();
  const recovered = reopened.read({ partitions: ['action'] });
  assert.equal(recovered.count, 1);
  assert.equal(recovered.items[0].globalSeq, 1);
  assert.equal(reopened.status().recovery.recoveredRecords, 1);
});

test('a projection failure never erases mmap eviction feedback from the same append', (t) => {
  const harness = makeStore(t, { projectionBudgetBytes: 64 * 1024 * 1024 });
  for (let sequence = 1; sequence <= 6; sequence += 1) {
    harness.store.record(fact(sequence, {
      partition: 'action',
      payload: { chunk: 'x'.repeat(900) },
    }));
  }
  const before = harness.store.status().quota.partitions.action.evictedRecords;
  assert.equal(before, 0);
  harness.store.index.insert = () => {
    throw new Error('injected projection failure during an evicting append');
  };

  const receipt = harness.store.record(fact(7, {
    partition: 'action',
    payload: { chunk: 'x'.repeat(900) },
  }));
  const after = harness.store.status().quota.partitions.action.evictedRecords;

  assert.equal(receipt.ok, true);
  assert.equal(receipt.projectionDegraded, true);
  assert.equal(receipt.evictedCount, 3);
  assert.equal(after - before, 3);
  assert.deepEqual(harness.store.read({ partitions: ['action'] }).items.map((item) => item.globalSeq), [4, 5, 6, 7]);
});

test('reopen repairs an index hole below the projection high-water mark', (t) => {
  const harness = makeStore(t);
  harness.store.record(fact(1));
  harness.store.record(fact(2, { dedupeKey: 'middle-index-record' }));
  harness.store.record(fact(3));
  harness.store.index.db.exec('DELETE FROM segment_records WHERE sequence = 2');

  const reopened = harness.reopen();
  assert.deepEqual(reopened.read({}).items.map((item) => item.globalSeq), [1, 2, 3]);
  assert.equal(reopened.status().recovery.recoveredRecords, 1);
  const duplicate = reopened.record(fact(200, { dedupeKey: 'middle-index-record' }));
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.globalSeq, 2);
});

test('partition quota eviction returns an explicit gap for an old cursor', (t) => {
  const harness = makeStore(t);
  harness.store.record(fact(1, { partition: 'network', payload: { chunk: 'a'.repeat(1_500) } }));
  const oldCursor = harness.store.read({ partitions: ['network'] }).cursor;
  for (let sequence = 2; sequence <= 18; sequence += 1) {
    harness.store.record(fact(sequence, {
      partition: 'network',
      payload: { chunk: String(sequence).repeat(1_500) },
    }));
  }

  const status = harness.store.status();
  assert.ok(status.quota.partitions.network.evictedRecords > 0);
  const expired = harness.store.read({ partitions: ['network'], cursor: oldCursor });
  assert.equal(expired.ok, false);
  assert.equal(expired.error, 'cursor_expired');
  assert.equal(expired.gap, true);
  assert.equal(expired.evictedPartitions[0].partition, 'network');
});

test('append pruning releases evicted dedupe keys and keeps the projection within the live mmap set', (t) => {
  const harness = makeStore(t);
  const first = harness.store.record(fact(1, {
    partition: 'network',
    dedupeKey: 'reusable-after-eviction',
    payload: { chunk: 'first'.repeat(300) },
  }));
  let receiptEvictedCount = 0;
  for (let sequence = 2; sequence <= 40; sequence += 1) {
    const receipt = harness.store.record(fact(sequence, {
      partition: 'network',
      payload: { chunk: String(sequence).repeat(750) },
    }));
    receiptEvictedCount += receipt.evictedCount;
  }

  const beforeReuse = harness.store.status();
  assert.ok(receiptEvictedCount > 0);
  assert.ok(beforeReuse.quota.partitions.network.firstSequence > first.globalSeq);
  assert.equal(beforeReuse.index.count, Number(beforeReuse.engine.recordCount));
  assert.ok(
    beforeReuse.quota.partitions.network.allocatedBytes
      <= beforeReuse.quota.partitions.network.hardQuotaBytes,
  );

  const reused = harness.store.record(fact(100, {
    partition: 'network',
    dedupeKey: 'reusable-after-eviction',
  }));
  assert.equal(reused.deduplicated, undefined);
  assert.ok(reused.globalSeq > first.globalSeq);
});

test('projection pruning runs only when a partition eviction floor advances', (t) => {
  const harness = makeStore(t);
  const originalPrune = harness.store.index.prunePartitionBefore.bind(harness.store.index);
  const calls = [];
  harness.store.index.prunePartitionBefore = (partition, firstSequence) => {
    calls.push({ partition, firstSequence });
    return originalPrune(partition, firstSequence);
  };

  for (let sequence = 1; sequence <= 40; sequence += 1) {
    harness.store.record(fact(sequence, {
      partition: 'network',
      payload: { chunk: String(sequence).repeat(750) },
    }));
  }
  const networkCallsAfterEviction = calls.filter((call) => call.partition === 'network').length;
  assert.ok(networkCallsAfterEviction > 0);
  for (let sequence = 41; sequence <= 60; sequence += 1) {
    harness.store.record(fact(sequence, { partition: 'ui', payload: { sequence } }));
  }
  assert.equal(
    calls.filter((call) => call.partition === 'network').length,
    networkCallsAfterEviction,
  );
});

test('custom quotas cannot exceed the total FactStore budget', () => {
  assert.throws(
    () => new SegmentedFactStoreAdapter({
      directory: path.join(os.tmpdir(), `segmented-invalid-${process.pid}-${Date.now()}`),
      profile: '64mb',
      budgetBytes: SEGMENT_SIZE * 8,
      segmentSize: SEGMENT_SIZE,
      partitionQuotas: Array(8).fill(SEGMENT_SIZE * 2),
    }),
    /exceed budgetBytes/,
  );
});

test('Host SQLite projection pressure cannot evict authoritative mmap facts', (t) => {
  const projectionBudgetBytes = 64 * 1024;
  const index = new MemorySegmentIndex({ budgetBytes: projectionBudgetBytes });
  const harness = makeStore(t, { index, projectionBudgetBytes });
  const projectionDirectory = path.join(harness.directory, 'projection');
  fs.mkdirSync(projectionDirectory, { recursive: true });
  const oversizedProjection = fs.openSync(path.join(projectionDirectory, 'index.sqlite'), 'w');
  fs.ftruncateSync(oversizedProjection, projectionBudgetBytes + 1);
  fs.closeSync(oversizedProjection);

  for (let sequence = 1; sequence <= PARTITIONS.length; sequence += 1) {
    harness.store.record(fact(sequence, {
      partition: PARTITIONS[sequence - 1],
      payload: { sequence },
    }));
  }

  const status = harness.store.status();
  assert.equal(status.storage.projectionOverQuota, true);
  assert.equal(status.storage.overQuota, false);
  assert.equal(status.storage.independentBudgets, true);
  assert.equal(status.storage.crossStoreEviction, false);
  assert.equal(status.engine.recordCount, PARTITIONS.length);
  assert.equal(
    status.engine.partitions.reduce((sum, partition) => sum + Number(partition.evictedRecords), 0),
    0,
  );
});

test('a full Host SQLite projection falls back online without failing or deleting the mmap commit', (t) => {
  const projectionBudgetBytes = 512 * 1024;
  const harness = makeStore(t, {
    budgetBytes: 4 * 1024 * 1024,
    partitionQuotas: Array(PARTITIONS.length).fill(512 * 1024),
    projectionBudgetBytes,
    projectionCheckInterval: 1,
  });
  let fallbackReceipt = null;
  for (let sequence = 1; sequence <= 5_000 && !fallbackReceipt; sequence += 1) {
    const receipt = harness.store.record(fact(sequence, {
      partition: PARTITIONS[(sequence - 1) % PARTITIONS.length],
      payload: { sequence },
    }));
    if (receipt.projectionDegraded) fallbackReceipt = receipt;
  }

  assert.ok(fallbackReceipt, 'expected the deliberately small SQLite projection to reach capacity');
  const status = harness.store.status();
  assert.equal(status.index.adapter, 'sqlite-projection+mmap-tail');
  assert.equal(status.projectionFallback.code, 'sqlite_projection_capacity');
  assert.equal(status.projectionFallback.mode, 'sqlite-base+mmap-tail');
  assert.ok(status.storage.projectionBytes <= projectionBudgetBytes);
  assert.equal(status.storage.crossStoreEviction, false);
  assert.equal(status.engine.nextSequence - 1, fallbackReceipt.globalSeq);
  const live = harness.store.read({ actionId: `action-${fallbackReceipt.globalSeq}` });
  assert.deepEqual(live.items.map((item) => item.globalSeq), [fallbackReceipt.globalSeq]);
});

test('residual SQLite cleanup failure never turns later mmap commits into failed receipts', (t) => {
  const projectionBudgetBytes = 512 * 1024;
  let cleanupAttempts = 0;
  const harness = makeStore(t, {
    budgetBytes: 4 * 1024 * 1024,
    partitionQuotas: Array(PARTITIONS.length).fill(512 * 1024),
    projectionBudgetBytes,
    projectionCheckInterval: 1,
    removeProjection() {
      cleanupAttempts += 1;
      const error = new Error('injected projection cleanup denial');
      error.code = 'EACCES';
      throw error;
    },
  });
  harness.store.record(fact(1));
  const residual = fs.openSync(path.join(harness.directory, 'projection', 'orphan.sqlite'), 'w');
  fs.ftruncateSync(residual, projectionBudgetBytes + 1);
  fs.closeSync(residual);
  harness.store.index.query = () => {
    throw new Error('injected projection read failure');
  };

  assert.deepEqual(harness.store.read({}).items.map((item) => item.globalSeq), [1]);
  const receipt = harness.store.record(fact(2));
  assert.equal(receipt.ok, true);
  assert.equal(receipt.globalSeq, 2);
  assert.equal(receipt.projectionDegraded, true);
  assert.ok(cleanupAttempts >= 2);
  const status = harness.store.status();
  assert.equal(status.projectionFallback.cleanupPending, true);
  assert.equal(status.storage.projectionOverQuota, true);
  assert.deepEqual(harness.store.read({}).items.map((item) => item.globalSeq), [1, 2]);
});

test('separate device-and-App store directories never share quotas or eviction state', (t) => {
  const first = makeStore(t);
  const second = makeStore(t);
  second.store.record(fact(1, {
    targetKey: 'android:device-b:com.example.second',
    payload: { store: 'second' },
  }));
  const secondBefore = second.store.status();

  for (let sequence = 1; sequence <= 40; sequence += 1) {
    first.store.record(fact(sequence, {
      targetKey: 'android:device-a:com.example.first',
      partition: 'network',
      payload: { chunk: String(sequence).repeat(750) },
    }));
  }

  const firstAfter = first.store.status();
  const secondAfter = second.store.status();
  assert.notEqual(firstAfter.directory, secondAfter.directory);
  assert.notEqual(firstAfter.storeId, secondAfter.storeId);
  assert.ok(firstAfter.quota.partitions.network.evictedRecords > 0);
  assert.equal(secondAfter.engine.recordCount, secondBefore.engine.recordCount);
  assert.equal(secondAfter.quota.partitions.ui.evictedRecords, 0);
  assert.deepEqual(second.store.read({}).items.map((item) => item.payload.store), ['second']);
});

test('constructor closes an opened index when engine open fails and preserves the open error', (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'segmented-constructor-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const primary = new Error('engine open failed');
  let indexCloseCount = 0;
  const index = {
    close() {
      indexCloseCount += 1;
      throw new Error('index cleanup failed');
    },
  };

  assert.throws(
    () => new SegmentedFactStoreAdapter({
      directory,
      profile: '64mb',
      budgetBytes: BUDGET_BYTES,
      segmentSize: SEGMENT_SIZE,
      partitionQuotas: PARTITION_QUOTAS,
      index,
      binding: {
        open() { throw primary; },
      },
    }),
    (error) => error === primary,
  );
  assert.equal(indexCloseCount, 1);
});

test('constructor closes both resources when projection initialization fails', (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'segmented-initialize-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const primary = new Error('metadata initialization failed');
  let engineCloseCount = 0;
  let indexCloseCount = 0;
  const engine = {
    close() {
      engineCloseCount += 1;
      throw new Error('engine cleanup failed');
    },
  };
  const index = {
    metadata() { throw primary; },
    close() {
      indexCloseCount += 1;
      throw new Error('index cleanup failed');
    },
  };

  assert.throws(
    () => new SegmentedFactStoreAdapter({
      directory,
      profile: '64mb',
      budgetBytes: BUDGET_BYTES,
      segmentSize: SEGMENT_SIZE,
      partitionQuotas: PARTITION_QUOTAS,
      index,
      engine,
    }),
    (error) => error === primary,
  );
  assert.equal(engineCloseCount, 1);
  assert.equal(indexCloseCount, 1);
});

test('close attempts every resource cleanup and preserves the first error', (t) => {
  const harness = makeStore(t);
  const primary = new Error('flush failed');
  const originalEngineClose = harness.store.engine.close.bind(harness.store.engine);
  const originalIndexClose = harness.store.index.close.bind(harness.store.index);
  let engineCloseCount = 0;
  let indexCloseCount = 0;
  harness.store.engine.flush = () => { throw primary; };
  harness.store.engine.status = () => { throw new Error('status failed'); };
  harness.store.engine.close = () => {
    engineCloseCount += 1;
    originalEngineClose();
    throw new Error('engine close failed');
  };
  harness.store.index.close = () => {
    indexCloseCount += 1;
    originalIndexClose();
    throw new Error('index close failed');
  };

  assert.throws(() => harness.store.close(), (error) => error === primary);
  assert.equal(engineCloseCount, 1);
  assert.equal(indexCloseCount, 1);
  assert.equal(harness.store.closed, true);
  assert.equal(harness.store.engine.closed, true);
  assert.equal(harness.store.index.closed, true);
});
