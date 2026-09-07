'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDeviceMutationLease } = require('../bin/shared-kernel/device-mutation-lease');

test('P4 device-mutation lease serializes the same physical serial', () => {
  const lease = createDeviceMutationLease();
  const first = lease.acquire('phone-1');
  const second = lease.acquire('phone-1');
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.error, 'target_busy');
  assert.equal(lease.status('phone-1').active, 1);
  assert.equal(lease.status('phone-1').maxActive, 1);
  first.release();
  const again = lease.acquire('phone-1');
  assert.equal(again.ok, true);
  again.release();
});

test('P4 device-mutation lease allows different serials in parallel', () => {
  const lease = createDeviceMutationLease();
  const first = lease.acquire('phone-1');
  const second = lease.acquire('phone-2');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(lease.status('phone-1').active, 1);
  assert.equal(lease.status('phone-2').active, 1);
  first.release();
  second.release();
});

test('P4 device-mutation lease stays off Script Intent and Legacy modules', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../bin/shared-kernel/device-mutation-lease.js'),
    'utf8',
  );
  assert.equal(/intent\/|script\/|legacy\/|runBatch|runBridgeChecked|mcp-server/.test(source), false);
});
