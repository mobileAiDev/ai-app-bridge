'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRollingSummary } = require('../bin/script/rolling-summary');

test('P5 RollingSummary merges call-level events and business progress', () => {
  const summary = createRollingSummary({ operationId: 'script-1', startedAtMs: 1000 });
  summary.apply({ kind: 'call_started', timestampMs: 1100, command: 'network' });
  summary.apply({ kind: 'call_completed', timestampMs: 1200, evidenceRefs: ['n1'] });
  const view = summary.apply({
    kind: 'progress',
    timestampMs: 1300,
    stage: 'search',
    message: 'waiting for results',
  });
  assert.equal(view.operationId, 'script-1');
  assert.equal(view.status, 'running');
  assert.equal(view.completedCalls, 1);
  assert.equal(view.stage, 'search');
  assert.equal(view.message, 'waiting for results');
  assert.equal(view.latestEvidenceRefs[0], 'n1');
  assert.equal(view.elapsedMs, 300);
  summary.apply({ kind: 'agent_question_created', timestampMs: 1400, request: { question: 'go?' } });
  summary.apply({ kind: 'heartbeat', timestampMs: 3400 });
  const waiting = summary.snapshot(3600);
  assert.equal(waiting.agentRequest.question, 'go?');
  assert.equal(waiting.decisionWaitMs, 2200);
  const decided = summary.apply({ kind: 'agent_decision', timestampMs: 1600, requestId: 'ask-1' });
  assert.equal(decided.agentRequest, null);
});

test('P5 RollingSummary heartbeat reports elapsed without a device query', () => {
  const summary = createRollingSummary({ operationId: 'script-1', startedAtMs: 1000 });
  summary.apply({ kind: 'child_started', timestampMs: 1050 });
  const beat = summary.heartbeat(3000, 'alive');
  assert.equal(beat.kind, 'heartbeat');
  assert.equal(beat.elapsedMs, 2000);
  assert.equal(beat.lastKind, 'child_started');
  assert.equal(beat.childHealth, 'alive');
});

test('P5 RollingSummary stays off Intent, Legacy, and device adapters', () => {
  const source = fs.readFileSync(path.join(__dirname, '../bin/script/rolling-summary.js'), 'utf8');
  assert.equal(/intent\/|legacy\/|runBatch|runBridgeChecked|mcp-server|adb/.test(source), false);
});
