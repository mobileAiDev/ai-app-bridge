'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createProgressProjector } = require('../bin/script/progress-projector');

function fact(kind, extra = {}) {
  return {
    executionId: 'ex-1',
    revision: 1,
    kind,
    target: { platform: 'android', serial: 's', packageName: 'p' },
    timestampMs: 1000,
    actionId: extra.actionId,
    parentFactId: extra.parentFactId,
    payloadSummary: extra.payloadSummary,
    evidenceRefs: extra.evidenceRefs,
    timings: extra.timings,
  };
}

test('P5 ProgressProjector projects call-level facts without device queries', () => {
  const projector = createProgressProjector();
  const first = projector.accept(fact('call', { actionId: 'action-1', payloadSummary: 'tap' }));
  assert.equal(first.lastSequence, 1);
  assert.equal(first.lastKind, 'call');
  assert.equal(first.business, null);
  const page = projector.read('ex-1', 0, 10);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].schemaVersion, 'aab.execution-fact/v1');
  assert.equal(page.items[0].actionId, 'action-1');
});

test('P5 ProgressProjector merges business progress and pages afterSequence', () => {
  const projector = createProgressProjector();
  projector.accept(fact('call', { actionId: 'action-1' }));
  const progress = projector.accept(fact('progress', { payloadSummary: 'opened settings' }));
  assert.equal(progress.business.kind, 'progress');
  assert.equal(progress.business.payloadSummary, 'opened settings');
  const page = projector.read('ex-1', 1, 10);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].kind, 'progress');
  assert.equal(page.hasMore, false);
});

test('P5 ProgressProjector stays off Intent, Legacy, and device adapters', () => {
  const source = fs.readFileSync(path.join(__dirname, '../bin/script/progress-projector.js'), 'utf8');
  assert.equal(/intent\/|legacy\/|runBatch|runBridgeChecked|mcp-server|adb/.test(source), false);
});
