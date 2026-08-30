const assert = require('assert/strict');
const test = require('node:test');

const { ConnectionCache } = require('../bin/connection-cache');

test('reuses a live connection entry until its ttl expires', async () => {
  let now = 1_000;
  let creates = 0;
  const cache = new ConnectionCache({ ttlMs: 100, now: () => now });
  const create = async () => ({ generation: ++creates });

  const first = await cache.getOrCreate('android:one', create);
  const reused = await cache.getOrCreate('android:one', create);
  assert.strictEqual(reused, first);
  assert.equal(creates, 1);

  now += 101;
  const refreshed = await cache.getOrCreate('android:one', create);
  assert.notStrictEqual(refreshed, first);
  assert.equal(creates, 2);
});

test('coalesces concurrent connection setup for the same target', async () => {
  let release;
  let creates = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = new ConnectionCache({ ttlMs: 100 });
  const create = async () => {
    creates += 1;
    await gate;
    return { ok: true };
  };

  const first = cache.getOrCreate('android:one', create);
  const second = cache.getOrCreate('android:one', create);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(creates, 1);
  release();
  assert.strictEqual(await first, await second);
});

test('does not retain failed setup and supports explicit invalidation', async () => {
  let creates = 0;
  const cache = new ConnectionCache({ ttlMs: 1_000 });

  await assert.rejects(
    cache.getOrCreate('android:one', async () => {
      creates += 1;
      throw new Error('forward failed');
    }),
    /forward failed/,
  );
  assert.equal(cache.has('android:one'), false);

  const recovered = await cache.getOrCreate('android:one', async () => ({ generation: ++creates }));
  assert.equal(recovered.generation, 2);
  assert.equal(cache.invalidate('android:one'), true);
  assert.equal(cache.has('android:one'), false);
});

test('force refresh replaces a live entry', async () => {
  let creates = 0;
  const cache = new ConnectionCache({ ttlMs: 1_000 });
  const create = async () => ({ generation: ++creates });

  const first = await cache.getOrCreate('android:one', create);
  const refreshed = await cache.getOrCreate('android:one', create, { force: true });
  assert.equal(first.generation, 1);
  assert.equal(refreshed.generation, 2);
});

test('a late stale setup cannot overwrite a forced refresh', async () => {
  let releaseStale;
  const staleGate = new Promise((resolve) => { releaseStale = resolve; });
  const cache = new ConnectionCache({ ttlMs: 1_000 });

  const stale = cache.getOrCreate('android:one', async () => {
    await staleGate;
    return { generation: 1 };
  });
  await new Promise((resolve) => setImmediate(resolve));
  const fresh = await cache.getOrCreate(
    'android:one',
    async () => ({ generation: 2 }),
    { force: true },
  );
  releaseStale();

  assert.equal((await stale).generation, 1);
  assert.equal(fresh.generation, 2);
  const reused = await cache.getOrCreate('android:one', async () => ({ generation: 3 }));
  assert.equal(reused.generation, 2);
});

test('prunes expired connection keys and bounds live entries', async () => {
  let now = 1_000;
  const cache = new ConnectionCache({ ttlMs: 100, maxEntries: 2, now: () => now });

  await cache.getOrCreate('android:one', async () => ({ key: 'one' }));
  await cache.getOrCreate('android:two', async () => ({ key: 'two' }));
  await cache.getOrCreate('android:three', async () => ({ key: 'three' }));
  assert.deepEqual([...cache.entries.keys()], ['android:two', 'android:three']);

  now += 101;
  await cache.getOrCreate('android:four', async () => ({ key: 'four' }));
  assert.deepEqual([...cache.entries.keys()], ['android:four']);
});
