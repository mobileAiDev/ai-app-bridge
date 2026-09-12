const assert = require('assert/strict');
const test = require('node:test');

const {
  TargetExecution,
  targetFor,
} = require('../bin/target-execution');
const { executeCommand } = require('../test-support/host-client');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('shared command entry rejects an unknown command before dispatch', async () => {
  assert.equal(typeof executeCommand, 'function');
  const rejected = await executeCommand('not-a-real-command', {});
  assert.equal(rejected.error, 'unknown_command');
  assert.equal(rejected.dispatched, false);
});

test('preserves canonical empty input text and zero coordinates', async () => {
  const execution = new TargetExecution();
  let received;

  const result = await execution.execute('input-text', {
    requestId: 'normalize-1',
    serial: 'android-1',
    packageName: 'com.example.one',
    text: '',
    tapX: 0,
    tapY: 0,
  }, async (command, args) => {
    received = { command, args };
    return { ok: true, action: 'input-text' };
  });

  assert.equal(received.command, 'input-text');
  assert.equal(received.args.text, '');
  assert.equal(Object.hasOwn(received.args, 'targetText'), false);
  assert.equal(received.args.tapX, 0);
  assert.equal(received.args.tapY, 0);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'input-text');
  assert.equal(result._feedback.status, 'completed');
  assert.deepEqual(result._feedback.evidence, []);
});


test('target identity includes Android serial and package, iOS device and bundle, and Web session and target', () => {
  const android = targetFor('tap', { serial: 'a-1', packageName: 'com.example.a' });
  const androidOtherDevice = targetFor('tap', { serial: 'a-2', packageName: 'com.example.a' });
  const androidOtherPackage = targetFor('tap', { serial: 'a-1', packageName: 'com.example.b' });
  assert.notEqual(android.key, androidOtherDevice.key);
  assert.notEqual(android.key, androidOtherPackage.key);
  assert.deepEqual(android, {
    kind: 'android', platform: 'android',
    key: android.key,
    serial: 'a-1',
    packageName: 'com.example.a',
  });

  const ios = targetFor('ios-tap', { deviceId: 'ios-1', bundleId: 'com.example.ios' });
  const iosOtherDevice = targetFor('ios-tap', { deviceId: 'ios-2', bundleId: 'com.example.ios' });
  const iosOtherBundle = targetFor('ios-tap', { deviceId: 'ios-1', bundleId: 'com.example.other' });
  assert.notEqual(ios.key, iosOtherDevice.key);
  assert.notEqual(ios.key, iosOtherBundle.key);
  assert.deepEqual(ios, {
    kind: 'ios', platform: 'ios',
    key: ios.key,
    deviceId: 'ios-1',
    bundleId: 'com.example.ios',
  });

  const web = targetFor('web-click', { sessionId: 'session-1', targetId: 'target-1' });
  const webOtherSession = targetFor('web-click', { sessionId: 'session-2', targetId: 'target-1' });
  const webOtherTarget = targetFor('web-click', { sessionId: 'session-1', targetId: 'target-2' });
  assert.notEqual(web.key, webOtherSession.key);
  assert.notEqual(web.key, webOtherTarget.key);
  assert.deepEqual(web, {
    kind: 'web', platform: 'web',
    key: web.key,
    sessionId: 'session-1',
    runtimeEpoch: '',
    targetId: 'target-1',
  });
});

test('runs one actor at a time for the same target', async () => {
  const execution = new TargetExecution();
  const firstGate = deferred();
  const starts = [];

  const first = execution.execute('tap', {
    serial: 'android-1',
    packageName: 'com.example.app',
    requestId: 'same-target-1',
  }, async () => {
    starts.push('first');
    await firstGate.promise;
    return { ok: true, order: 1 };
  });
  const second = execution.execute('tap', {
    serial: 'android-1',
    packageName: 'com.example.app',
    requestId: 'same-target-2',
  }, async () => {
    starts.push('second');
    return { ok: true, order: 2 };
  });

  await nextTurn();
  assert.deepEqual(starts, ['first']);
  firstGate.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(starts, ['first', 'second']);
  assert.equal(firstResult.order, 1);
  assert.equal(secondResult.order, 2);
  assert.equal(firstResult._feedback.dispatch.serializedByTarget, true);
  assert.equal(secondResult._feedback.timings.queueWaitMs >= 0, true);
});

test('runs actors for different targets in parallel', async () => {
  const execution = new TargetExecution();
  const gate = deferred();
  const starts = [];

  const first = execution.execute('tap', {
    serial: 'android-1',
    packageName: 'com.example.app',
  }, async () => {
    starts.push('android-1');
    await gate.promise;
    return { ok: true };
  });
  const second = execution.execute('tap', {
    serial: 'android-2',
    packageName: 'com.example.app',
  }, async () => {
    starts.push('android-2');
    await gate.promise;
    return { ok: true };
  });

  await nextTurn();
  assert.deepEqual(new Set(starts), new Set(['android-1', 'android-2']));
  gate.resolve();
  await Promise.all([first, second]);
});

test('serializes different Android packages on the same serial', async () => {
  const execution = new TargetExecution();
  const gate = deferred();
  const starts = [];

  const first = execution.execute('tap', {
    serial: 'android-1',
    packageName: 'com.example.first',
  }, async () => {
    starts.push('com.example.first');
    await gate.promise;
    return { ok: true };
  });
  const second = execution.execute('tap', {
    serial: 'android-1',
    packageName: 'com.example.second',
  }, async () => {
    starts.push('com.example.second');
    await gate.promise;
    return { ok: true };
  });

  await nextTurn();
  try {
    assert.deepEqual(
      new Set(starts),
      new Set(['com.example.first']),
    );
  } finally {
    gate.resolve();
    await Promise.allSettled([first, second]);
  }
});

test('deduplicates in-flight and completed requests by requestId within a target', async () => {
  const execution = new TargetExecution();
  const gate = deferred();
  let runs = 0;
  const args = {
    serial: 'android-1',
    packageName: 'com.example.app',
    requestId: 'idempotent-1',
  };
  const runner = async () => {
    runs += 1;
    await gate.promise;
    return { ok: true, run: runs };
  };

  const first = execution.execute('tap', args, runner);
  const duplicate = execution.execute('tap', args, runner);
  await nextTurn();
  assert.equal(runs, 1);
  gate.resolve();
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
  assert.equal(runs, 1);
  assert.strictEqual(firstResult, duplicateResult);

  const completedDuplicate = await execution.execute('tap', args, runner);
  assert.equal(runs, 1);
  assert.strictEqual(firstResult, completedDuplicate);
});

test('does not collide equal requestIds that address different targets', async () => {
  const execution = new TargetExecution();
  let runs = 0;
  const runner = async () => ({ ok: true, run: ++runs });

  const [first, second] = await Promise.all([
    execution.execute('tap', { serial: 'android-1', packageName: 'com.example.app', requestId: 'same-id' }, runner),
    execution.execute('tap', { serial: 'android-2', packageName: 'com.example.app', requestId: 'same-id' }, runner),
  ]);

  assert.equal(runs, 2);
  assert.notEqual(first.run, second.run);
});

test('reports verified, inconclusive, and failed object outcomes', async () => {
  const execution = new TargetExecution();
  const base = { serial: 'android-1', packageName: 'com.example.app' };

  const verified = await execution.execute('tap', { ...base, requestId: 'status-verified' }, async () => ({ ok: true, verified: true }));
  const inconclusive = await execution.execute('tap', { ...base, requestId: 'status-inconclusive' }, async () => ({ inconclusive: true }));
  const failed = await execution.execute('tap', { ...base, requestId: 'status-failed' }, async () => ({ ok: false, error: 'not handled' }));

  assert.equal(verified._feedback.status, 'verified');
  assert.equal(inconclusive._feedback.status, 'inconclusive');
  assert.equal(failed._feedback.status, 'failed');
  assert.equal(typeof verified._feedback.timings.requestedAtMs, 'number');
  assert.equal(typeof verified._feedback.timings.startedAtMs, 'number');
  assert.equal(typeof verified._feedback.timings.completedAtMs, 'number');
  assert.equal(verified._feedback.target.key, targetFor('tap', base).key);
  assert.equal(verified._feedback.dispatch.command, 'tap');
});

test('preserves strings, Buffers, and arrays instead of wrapping legacy results', async () => {
  const execution = new TargetExecution();
  const base = { serial: 'android-1', packageName: 'com.example.app' };
  const buffer = Buffer.from('screenshot');
  const array = [{ id: 1 }];

  const stringResult = await execution.execute('tree', { ...base, requestId: 'raw-string' }, async () => 'raw tree');
  const bufferResult = await execution.execute('screenshot', { ...base, requestId: 'raw-buffer' }, async () => buffer);
  const arrayResult = await execution.execute('logs', { ...base, requestId: 'raw-array' }, async () => array);

  assert.equal(stringResult, 'raw tree');
  assert.strictEqual(bufferResult, buffer);
  assert.strictEqual(arrayResult, array);
});

test('keeps runner failures throwable and attaches failed feedback to the error', async () => {
  const execution = new TargetExecution();
  const failure = new Error('runner failed');

  await assert.rejects(
    execution.execute('tap', {
      serial: 'android-1',
      packageName: 'com.example.app',
      requestId: 'throws-1',
    }, async () => {
      throw failure;
    }),
    (error) => {
      assert.strictEqual(error, failure);
      assert.equal(error._feedback.status, 'failed');
      assert.deepEqual(error._feedback.evidence, []);
      return true;
    },
  );
});

test('bounds completed request idempotency entries by ttl and maximum count', async () => {
  let now = 1_000;
  let runs = 0;
  const execution = new TargetExecution({
    requestTtlMs: 100,
    maxRequests: 2,
    now: () => now,
  });
  const base = { serial: 'android-1', packageName: 'com.example.app' };
  const runner = async () => ({ ok: true, run: ++runs });

  await execution.execute('tap', { ...base, requestId: 'one' }, runner);
  await execution.execute('tap', { ...base, requestId: 'two' }, runner);
  await execution.execute('tap', { ...base, requestId: 'three' }, runner);
  await execution.execute('tap', { ...base, requestId: 'one' }, runner);
  assert.equal(runs, 4, 'oldest completed entry should be evicted after maxRequests');

  now += 101;
  await execution.execute('tap', { ...base, requestId: 'three' }, runner);
  assert.equal(runs, 5, 'expired completed entry should execute again');
});

test('supports additive feedback opt-out without changing the legacy result', async () => {
  const execution = new TargetExecution();
  const legacyResult = { ok: true, action: 'tap' };
  const result = await execution.execute('tap', {
    serial: 'android-1',
    packageName: 'com.example.app',
    feedback: 'off',
  }, async () => legacyResult);

  assert.strictEqual(result, legacyResult);
  assert.equal(Object.prototype.hasOwnProperty.call(result, '_feedback'), false);
});
