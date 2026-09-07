'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { TargetExecution, targetFor } = require('../bin/target-execution');
const { androidAppTargetKey } = require('../bin/shared-kernel/target-lease-protocol');
const snapshot = require('./fixtures/legacy-surface-g0.json');

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('P0 Legacy Android target key stays (serial, packageName)', () => {
  const first = targetFor('tap', { serial: 'android-1', packageName: 'com.example.first' });
  const second = targetFor('tap', { serial: 'android-1', packageName: 'com.example.second' });
  assert.equal(first.key, 'android:["android-1","com.example.first"]');
  assert.equal(second.key, 'android:["android-1","com.example.second"]');
  assert.notEqual(first.key, second.key);
  assert.equal(
    androidAppTargetKey('android-1', 'com.example.first'),
    'android:["android-1","com.example.first"]',
  );
});

test('P0 Legacy same-serial different-package commands still run in parallel', async () => {
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
    assert.deepEqual(new Set(starts), new Set(['com.example.first', 'com.example.second']));
  } finally {
    gate.resolve();
    await Promise.allSettled([first, second]);
  }
});

test('P0 Legacy HTTP/JSON four-stream command names and query keys stay frozen', () => {
  for (const command of ['logs', 'network', 'state', 'events']) {
    assert.equal(snapshot.commands.includes(command), true, command);
  }
  const cli = fs.readFileSync(path.join(__dirname, '../bin/ai-app-bridge.js'), 'utf8');
  assert.match(cli, /case 'logs':\n\s+return bridgeGet\(ctx, withQuery\('\/v1\/logs', captureQuery\(options\)\)\)/);
  assert.match(cli, /withQuery\('\/v1\/network', captureQuery\(options\)\)/);
  assert.match(cli, /case 'state':\n\s+return bridgeGet\(ctx, withQuery\('\/v1\/state', captureQuery\(options\)\)\)/);
  assert.match(cli, /case 'events':\n\s+return bridgeGet\(ctx, withQuery\('\/v1\/events', captureQuery\(options\)\)\)/);
  assert.match(cli, /sinceId: options\.sinceId,\n\s+sinceMs: options\.sinceMs,\n\s+limit: options\.limit,/);

  const ios = fs.readFileSync(path.join(__dirname, '../bin/ios-provider.js'), 'utf8');
  assert.match(ios, /withQuery\('\/v1\/logs', captureQuery\(args\)\)/);
  assert.match(ios, /withQuery\('\/v1\/network', captureQuery\(args\)\)/);
  assert.match(ios, /withQuery\('\/v1\/state', captureQuery\(args\)\)/);
  assert.match(ios, /withQuery\('\/v1\/events', captureQuery\(args\)\)/);

  const targetSource = fs.readFileSync(path.join(__dirname, '../bin/target-execution.js'), 'utf8');
  assert.match(targetSource, /key: targetKey\('android', serial, packageName\)/);
});
