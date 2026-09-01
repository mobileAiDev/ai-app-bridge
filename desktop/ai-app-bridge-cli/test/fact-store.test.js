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

test('FactStore exposes only record/read/status semantics', () => {
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
});

test('FactStore rejects shallow adapters before runtime work starts', () => {
  assert.throws(
    () => new FactStore({ record() {}, read() {} }),
    /record\/read\/status/,
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
