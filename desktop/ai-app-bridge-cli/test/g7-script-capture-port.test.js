'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createScriptCapturePort } = require('../bin/script/script-capture-port');
const { createFakeHostPort } = require('../bin/script/fake-host-port');

function page(overrides = {}) {
  return {
    coverage: { status: 'complete', gap: false, committed: true },
    gap: false,
    refs: [{ mobileFactId: 'mf1:1:1:abcd', stream: 'network', captureId: 1 }],
    items: [{ id: 1, url: 'https://example.test/login', statusCode: 200 }],
    ...overrides,
  };
}

test('G7 ScriptCapturePort network statusCode uses decision-window coverage', async () => {
  const port = createScriptCapturePort({
    query: (request) => {
      assert.equal(request.view, 'decision-window');
      assert.equal(request.stream, 'network');
      assert.equal(request.afterActionId, 'action-1');
      return page();
    },
  });
  const window = await port.query('network', {}, { actionId: 'action-1', runtimeEpoch: 'epoch-1' });
  assert.equal(window.coverage.status, 'complete');
  assert.equal(window.gap, false);
  assert.equal(window.committed, true);
  assert.equal(window.items[0].statusCode, 200);
  const host = createFakeHostPort({
    target: { platform: 'android', serial: 'capture-port-fixture', packageName: 'pkg' },
    query: (request) => page({
      runtimeEpoch: 'epoch-1', targetKey: 'pkg', watermarkCursor: 'cursor-1', hasMore: false,
      window: { afterActionId: request.afterActionId, factCursor: request.factCursor ?? null,
        runtimeEpoch: 'epoch-1', targetKey: 'pkg', filterApplied: true },
      refs: [{ mobileFactId: 'mf1', stream: 'network', runtimeEpoch: 'epoch-1', targetKey: 'pkg' }],
    }),
  });
  const before = await host.call('network');
  const tap = await host.call('tap');
  const result = await host.call('network', { afterActionId: tap.execution.actionId, factCursor: before.evidence.capture.watermarkCursor }, { runtimeEpoch: 'epoch-1' });
  const passed = await host.assert({
    name: 'login-status',
    requireCoverage: 'complete',
    requiredEvidence: ['network'],
    condition: result.result.items[0].statusCode === 200,
    evidence: result.evidence,
  });
  assert.equal(passed.verdict, 'passed');
});

test('G7 ScriptCapturePort gap drop restart and disconnect are inconclusive', async () => {
  const host = createFakeHostPort();
  const gapPort = createScriptCapturePort({
    query: () => page({
      coverage: { status: 'partial', gap: true, committed: false },
      gap: true,
      refs: [],
      items: [],
    }),
  });
  const gap = await gapPort.query('logs', {}, { actionId: 'a' });
  const gapVerdict = await host.assert({
    name: 'log-present',
    requireCoverage: 'complete',
    condition: true,
    evidence: gap,
  });
  assert.equal(gapVerdict.verdict, 'inconclusive');

  const dropped = createScriptCapturePort({
    query: () => page({
      coverage: { status: 'partial', gap: true, committed: false },
      refs: [],
      items: [],
    }),
  }).query('events', {}, { actionId: 'a' });
  assert.equal((await dropped).committed, false);

  const restart = createScriptCapturePort({
    query: () => page(),
  }).query('state', {}, { actionId: 'a', runtimeEpochChanged: true });
  assert.equal((await restart).coverage.status, 'unavailable');
  const restartVerdict = await host.assert({
    name: 'state',
    condition: true,
    evidence: await restart,
  });
  assert.equal(restartVerdict.verdict, 'inconclusive');

  const disconnected = createScriptCapturePort({
    query: () => page(),
  }).query('network', {}, { disconnected: true });
  assert.equal((await disconnected).coverage.status, 'unavailable');
});

test('G7 FakeHostPort capture.read uses injected query and does not invent complete coverage', async () => {
  const host = createFakeHostPort({
    target: { platform: 'android', serial: 'capture-port-fixture', packageName: 'pkg' },
    query: (request) => {
      assert.equal(request.view, 'decision-window');
      assert.equal(request.stream, 'network');
      assert.equal(request.afterActionId, 'action-9');
      return page({
        coverage: { status: 'partial', gap: true, committed: false },
        gap: true,
        refs: [],
        items: [{ statusCode: 200 }],
      });
    },
  });
  const result = await host.call('network', { afterActionId: 'action-9' });
  assert.equal(result.evidence.coverage.status, 'partial');
  assert.equal(result.evidence.coverage.gap, true);
  const verdict = await host.assert({
    name: 'login-status',
    requireCoverage: 'complete',
    requiredEvidence: ['network'],
    condition: result.result.items[0].statusCode === 200,
    evidence: {
      coverage: result.evidence.coverage,
      refs: result.evidence.refs,
    },
  });
  assert.equal(verdict.verdict, 'inconclusive');
});

test('G7 ScriptCapturePort stays off Intent and Legacy modules', () => {
  const source = fs.readFileSync(path.join(__dirname, '../bin/script/script-capture-port.js'), 'utf8');
  assert.equal(/intent\/|legacy\/|runBatch|runBridgeChecked|mcp-server/.test(source), false);
});
