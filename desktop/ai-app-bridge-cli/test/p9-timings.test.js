'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { timingsFromScriptEvents, attachOnce } = require('../bin/script/p9-timings');

test('P9 timings classify provider, business, evidence, pause, and wall', () => {
  const timings = timingsFromScriptEvents([
    { type: 'call_started', command: 'uia-tree', atMs: 1000 },
    { type: 'call_completed', command: 'uia-tree', atMs: 1120 },
    { type: 'call_started', command: 'wait-text', atMs: 1120 },
    { type: 'call_completed', command: 'wait-text', atMs: 4120 },
    { type: 'call_started', command: 'state', atMs: 4120 },
    { type: 'call_completed', command: 'state', atMs: 4150 },
    { type: 'paused', atMs: 4150 },
    { type: 'resumed', atMs: 5150 },
  ], {
    rollingSummary: { activeMs: 7000, decisionWaitMs: 0 },
    wallMs: 8000,
  });
  assert.equal(timings.providerWaitMs, 120);
  assert.equal(timings.businessWaitMs, 3000);
  assert.equal(timings.evidenceQueryMs, 30);
  assert.equal(timings.pausedMs, 1000);
  assert.equal(timings.activeMs, 7000);
  assert.equal(timings.wallMs, 8000);
  assert.equal(timings.decisionWaitMs, 0);
});

test('P9 attachOnce writes the matrix onto the first counted step', () => {
  const withTimings = attachOnce({ providerWaitMs: 4 });
  assert.equal(withTimings({ status: 'skipped' }).timings, undefined);
  const passed = withTimings({ status: 'passed' });
  assert.equal(passed.timings.providerWaitMs, 4);
  assert.equal(withTimings({ status: 'passed' }).timings, undefined);
});
