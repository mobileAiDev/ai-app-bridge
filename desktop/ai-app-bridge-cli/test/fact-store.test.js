'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  FactStore,
  createFactStore,
  createSegmentedFactStore,
} = require('../bin/fact-store');
const packageInfo = require('../package.json');

function fact(sequence = 1) {
  return {
    partition: 'ui',
    targetKey: 'android:device:com.example',
    app: { platform: 'android', packageName: 'com.example' },
    runtimeEpoch: 'runtime-1',
    actionId: `action-${sequence}`,
    timestamps: { occurredAtMs: 1_000 + sequence, observedAtMs: 1_010 + sequence },
    payload: { kind: 'ui', sequence },
  };
}

function memoryAdapter({ throwOnRecord = false, stored = true } = {}) {
  const facts = [];
  return {
    facts,
    record(value) {
      if (throwOnRecord) throw new Error('shadow unavailable');
      facts.push(value);
      return { ok: true, stored, globalSeq: facts.length };
    },
    read() {
      return { ok: true, items: [...facts], count: facts.length, cursor: `memory:${facts.length}` };
    },
    status() {
      return { ok: true, adapter: 'memory', count: facts.length, degraded: false };
    },
    close() {},
  };
}

test('FactStore exposes record/read/status plus bounded asynchronous writes', () => {
  const adapter = memoryAdapter();
  const store = new FactStore(adapter);

  const single = store.record(fact(1));
  const batch = store.record([fact(2), fact(3)]);
  const fourth = store.record(fact(4));

  assert.equal(single.receipt.globalSeq, 1);
  assert.deepEqual(batch.receipts.map((receipt) => receipt.globalSeq), [2, 3]);
  assert.equal(fourth.receipt.globalSeq, 4);
  assert.equal(store.read({}).count, 4);
  assert.equal(store.read({ partitions: ['ui'], targetKey: 'android:device:com.example' }).count, 4);
  assert.equal(store.status().adapter, 'memory');
  assert.equal(store.status().writer.available, true);
});

test('FactStore rejects shallow adapters before runtime work starts', () => {
  assert.throws(
    () => new FactStore({ record() {}, read() {} }),
    /record\/read\/status/,
  );
});

test('published CLI bundles the complete segmented store runtime and native source', () => {
  for (const file of [
    'bin/android-uia-xml.js',
    'bin/fact-codec.js',
    'bin/fact-store.js',
    'bin/mmap-scan-index.js',
    'bin/segment-index.js',
    'bin/segmented-fact-store.js',
  ]) {
    assert.equal(packageInfo.files.includes(file), true, `${file} must be packed`);
  }
  assert.equal(
    packageInfo.dependencies['@mobileaidev/segmented-fact-store-native'],
    'file:../../native/segmented-fact-store',
  );
  assert.equal(
    packageInfo.bundleDependencies.includes('@mobileaidev/segmented-fact-store-native'),
    true,
  );
});

test('production factory exposes segmented mmap as the only authoritative payload store', (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fact-store-segmented-')));
  const segmentSize = 4_096;
  const store = createSegmentedFactStore({
    directory,
    profile: '64mb',
    budgetBytes: segmentSize * 24,
    segmentSize,
    partitionQuotas: Array(8).fill(segmentSize * 2),
  });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.equal(store.record(fact(1)).receipt.globalSeq, 1);
  assert.equal(store.read({}).count, 1);
  assert.equal(store.status().adapter, 'segmented-mmap');
  assert.equal(store.status().authoritative, true);
});

test('production factory rejects alternate authoritative payload backends', () => {
  for (const backend of ['segmented', 'auto', 'sqlite', 'shadow', 'off']) {
    assert.throws(
      () => createFactStore({ backend }),
      /backend selection is not supported/,
    );
  }
});

test('production factory rejects a second writer immediately and reopens after the owner closes', (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fact-store-lock-')));
  const options = {
    directory,
    profile: '64mb',
    budgetBytes: 4_096 * 24,
    segmentSize: 4_096,
    partitionQuotas: Array(8).fill(4_096 * 2),
  };
  const first = createFactStore(options);
  t.after(() => {
    first.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.throws(() => createFactStore(options), (error) => error.code === 'sfs_busy');
  first.close();
  const reopened = createFactStore(options);
  reopened.close();
});

test('automatic segmented profile disables persistence instead of consuming the disk reserve', (t) => {
  const directory = path.join(os.tmpdir(), `fact-store-low-disk-${process.pid}-${Date.now()}`);
  const mib = 1024 * 1024;
  const store = createFactStore({
    directory,
    profile: 'auto',
    storageCapacity: {
      totalBytes: 3 * 1024 * mib,
      availableBytes: 319 * mib,
    },
  });
  t.after(() => store.close());

  const status = store.status();
  assert.equal(status.adapter, 'segmented-mmap-disabled');
  assert.equal(status.profile, 'off-low-disk');
  assert.equal(status.persistence, false);
  assert.equal(status.budgetBytes, 0);
  assert.equal(status.disabledReason, 'insufficient-space');
  assert.equal(store.record(fact(1)).receipt.stored, false);
  assert.equal(store.read({}).error, 'fact_store_disabled');
  assert.equal(fs.existsSync(directory), false);
});
