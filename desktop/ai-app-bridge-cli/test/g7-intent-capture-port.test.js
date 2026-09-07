'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createIntentCapturePort } = require('../bin/intent/intent-capture-port');

test('G7 IntentCapturePort observe returns decision-window refs', async () => {
  const port = createIntentCapturePort({
    query: (request) => {
      assert.equal(request.view, 'decision-window');
      assert.equal(request.stream, 'network');
      return {
        coverage: { status: 'complete', gap: false, committed: true },
        gap: false,
        refs: [{ mobileFactId: 'mf1:1:2:efgh', stream: 'network', captureId: 2 }],
        items: [{ id: 2, statusCode: 403 }],
      };
    },
  });
  const observed = await port.observe({ stream: 'network' }, { actionId: 'intent-1' });
  assert.equal(observed.committed, true);
  assert.equal(observed.items[0].statusCode, 403);
  assert.equal(observed.refs[0].stream, 'network');
});

test('G7 IntentCapturePort disconnect is unavailable', async () => {
  const port = createIntentCapturePort({
    query: () => {
      throw new Error('must-not-query');
    },
  });
  const observed = await port.observe({ stream: 'logs' }, { disconnected: true });
  assert.equal(observed.coverage.status, 'unavailable');
  assert.equal(observed.gap, true);
});

test('G7 IntentCapturePort stays off Script and Legacy modules', () => {
  const source = fs.readFileSync(path.join(__dirname, '../bin/intent/intent-capture-port.js'), 'utf8');
  assert.equal(/script\/|legacy\/|runBatch|runBridgeChecked|mcp-server/.test(source), false);
});
