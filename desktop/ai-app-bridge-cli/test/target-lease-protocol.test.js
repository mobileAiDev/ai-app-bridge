'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  androidAppTargetKey,
  createTargetLease,
} = require('../bin/shared-kernel/target-lease-protocol');

test('target lease blocks the same app and allows different apps on one serial', () => {
  const lease = createTargetLease();
  const firstKey = androidAppTargetKey('android-1', 'com.example.first');
  const secondKey = androidAppTargetKey('android-1', 'com.example.second');

  assert.notEqual(firstKey, secondKey);
  const first = lease.acquire(firstKey);
  assert.equal(first.ok, true);
  assert.deepEqual(lease.acquire(firstKey), {
    ok: false,
    error: 'target_busy',
    serial: firstKey,
    active: 1,
  });

  const second = lease.acquire(secondKey);
  assert.equal(second.ok, true);
  first.release();
  second.release();
  assert.equal(lease.status(firstKey).active, 0);
  assert.equal(lease.status(secondKey).active, 0);
});
