'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createAutonomousAgentAdapter, createIntentBudget } = require('../bin/intent/intent-autonomous-adapter');
const { createProductionIntentDeviceAdapter } = require('../bin/intent/intent-production-adapter');
const { handle } = require('./helpers/intent-entry');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createTargetLease } = require('../bin/shared-kernel/target-lease-protocol');

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

test('production Intent adapter allows different packages on the same serial in parallel', async () => {
  const gate = deferred();
  const starts = [];
  const ports = {
    createBridgeContext: (options) => options,
    async bridgeTree(ctx) {
      starts.push(ctx.packageName);
      await gate.promise;
      return { root: { id: ctx.packageName, children: [] } };
    },
  };
  const adapter = createProductionIntentDeviceAdapter({
    lease: createTargetLease(),
    ports,
    probeAdb: async () => ({ ok: true, ms: 1 }),
  });

  const first = adapter.observe({
    serial: 'android-1',
    packageName: 'com.example.first',
    provider: 'native',
    rawTreeId: 'tree-first',
  });
  await nextTurn();
  const second = adapter.observe({
    serial: 'android-1',
    packageName: 'com.example.second',
    provider: 'native',
    rawTreeId: 'tree-second',
  });
  await nextTurn();

  let results;
  try {
    assert.deepEqual(
      new Set(starts),
      new Set(['com.example.first', 'com.example.second']),
    );
  } finally {
    gate.resolve();
    results = await Promise.all([first, second]);
  }
  assert.deepEqual(results[0].adbTimings, []);
  assert.deepEqual(results[1].adbTimings, []);
});

test('G7 production Intent adapter uses injected ports and never overlaps device I/O', async () => {
  const active = [];
  const ports = {
    createBridgeContext: (options) => options,
    async uiaTreeOnce() {
      active.push('uia');
      assert.equal(active.filter((item) => item !== 'done').length <= 1, true);
      active.pop();
      return { root: { id: 'more', className: 'Button', text: 'More', clickable: true, children: [] } };
    },
    async uiaTree() { throw new Error('legacy uiaTree must not be used on the new path'); },
    async bridgeTree() { throw new Error('native tree must be explicit'); },
    async flutterNodes() { throw new Error('flutter must be explicit'); },
    findUiaNodeByAny() {
      return { left: 10, top: 20, right: 30, bottom: 40 };
    },
    async tap() {
      active.push('tap');
      assert.equal(active.length, 1);
      active.pop();
      return { ok: true };
    },
    async tapUiaText() { throw new Error('tapUiaText must not be used on the new path'); },
    async tapText() { throw new Error('tapText must be explicit'); },
    async keyevent() { throw new Error('keyevent must be explicit'); },
  };
  const adapter = createProductionIntentDeviceAdapter({
    lease: createTargetLease(),
    ports,
    probeAdb: async () => ({ ok: true, ms: 1 }),
  });
  const agent = createAutonomousAgentAdapter({
    decide({ revision }) {
      if (revision === 1) {
        return {
          decisionId: 'd1',
          agentDecision: 'act',
          basedOnRevision: revision,
          action: { action: 'tap', provider: 'uia', text: 'More' },
        };
      }
      return { decisionId: 'done', agentDecision: 'complete', basedOnRevision: revision };
    },
  });
  const result = await handle({
    operation: 'start',
    operationId: 'g7-prod-ports',
    mode: 'autonomous',
    goal: 'open more',
    target: { serial: 'b46093e6', packageName: 'org.wikipedia' },
    provider: 'uia',
    store: createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() }),
    adapter,
    agent,
    budget: createIntentBudget({ maxSteps: 4, maxAgentCalls: 4 }),
  });
  assert.equal(result.status, 'completed');
  assert.equal(adapter.maxActive, 1);
  assert.deepEqual(adapter.calls.map((item) => item.name), ['observe:uia', 'action', 'observe:uia']);
});

test('G7 production Intent adapter taps native text from the observed tree', async () => {
  const taps = [];
  const ports = {
    createBridgeContext: (options) => options,
    async bridgeTree() {
      return {
        root: {
          id: 'more',
          className: 'Button',
          text: 'More',
          visible: true,
          effectiveVisible: true,
          clickable: true,
          bounds: { left: 10, top: 20, right: 30, bottom: 40 },
          children: [],
        },
      };
    },
    async uiaTree() { throw new Error('legacy uiaTree must not be used on the new path'); },
    async uiaTreeOnce() { throw new Error('UIA must be explicit'); },
    async flutterNodes() { throw new Error('flutter must be explicit'); },
    findTappableNodeByText(tree, text) {
      if (tree.root && tree.root.text === text) return { node: tree.root };
      return { node: null };
    },
    async tap(_ctx, x, y) {
      taps.push({ x, y });
      return { ok: true, x, y };
    },
    async tapText() { throw new Error('tapText must not be used on the new path'); },
    async tapUiaText() { throw new Error('tapUiaText must not be used on the new path'); },
  };
  const adapter = createProductionIntentDeviceAdapter({
    lease: createTargetLease(),
    ports,
    probeAdb: async () => ({ ok: true, ms: 1 }),
  });
  const agent = createAutonomousAgentAdapter({
    decide({ revision }) {
      if (revision === 1) {
        return {
          decisionId: 'd1',
          agentDecision: 'act',
          basedOnRevision: revision,
          action: { action: 'tap', text: 'More' },
        };
      }
      return { decisionId: 'done', agentDecision: 'complete', basedOnRevision: revision };
    },
  });
  const result = await handle({
    operation: 'start',
    operationId: 'g7-prod-native-tap',
    mode: 'autonomous',
    goal: 'open more',
    target: { serial: 'b46093e6', packageName: 'org.wikipedia' },
    provider: 'native',
    store: createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() }),
    adapter,
    agent,
    budget: createIntentBudget({ maxSteps: 4, maxAgentCalls: 4 }),
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(taps, [{ x: 20, y: 30 }]);
});

test('G7 production Intent adapter taps Flutter text from the observed tree', async () => {
  let flutterAcquires = 0;
  const taps = [];
  const ports = {
    createBridgeContext: (options) => options,
    async flutterNodes() {
      flutterAcquires += 1;
      throw new Error('flutterNodes must not be re-acquired on tap');
    },
    async tap() { throw new Error('Flutter intent actions must carry actionId to the runtime'); },
    async flutterAction(_ctx, payload) {
      taps.push(payload);
      return { ok: true };
    },
    async tapText() { throw new Error('tapText must not be used on the new path'); },
  };
  const adapter = createProductionIntentDeviceAdapter({
    lease: createTargetLease(),
    ports,
    probeAdb: async () => ({ ok: true, ms: 1 }),
  });
  const result = await adapter.action({
    serial: 'b46093e6',
    packageName: 'com.example.app',
    actionId: 'intent:flutter-tap',
    spec: { action: 'tap', provider: 'flutter', text: '返回' },
    rawTree: {
      nodes: [{
        text: '返回',
        tap: { bounds: { left: 8, top: 48, right: 48, bottom: 88, centerX: 28, centerY: 68 } },
      }],
      viewport: { devicePixelRatio: 3 },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(flutterAcquires, 0);
  assert.deepEqual(taps, [{ action: 'tapAt', x: 28, y: 68, actionId: 'intent:flutter-tap' }]);
});

test('G7 production Intent adapter scrolls UIA via host swipe', async () => {
  const swipes = [];
  const ports = {
    createBridgeContext: (options) => options,
    async uiaTree() { throw new Error('legacy uiaTree must not be used on the new path'); },
    async uiaTreeOnce() { throw new Error('observe must supply rawTree'); },
    parseUiaViewport() {
      return { left: 0, top: 0, right: 1080, bottom: 2376, width: 1080, height: 2376 };
    },
    async swipe(_ctx, startX, startY, endX, endY, durationMs) {
      swipes.push({ startX, startY, endX, endY, durationMs });
      return { ok: true, startX, startY, endX, endY, durationMs };
    },
    async flutterAction() { throw new Error('flutterAction must not be used for UIA scroll'); },
    async tapUiaText() { throw new Error('tapUiaText must be explicit'); },
    async tapText() { throw new Error('tapText must be explicit'); },
  };
  const adapter = createProductionIntentDeviceAdapter({
    lease: createTargetLease(),
    ports,
    probeAdb: async () => ({ ok: true, ms: 1 }),
  });
  const result = await adapter.action({
    serial: 'b46093e6',
    packageName: 'org.wikipedia.dev',
    spec: { action: 'scroll', provider: 'uia' },
    rawTree: '<node bounds="[0,0][1080,2376]" text="设置"/>',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(swipes, [{ startX: 540, startY: 1806, endX: 540, endY: 523, durationMs: 400 }]);
});

test('G7 production Intent adapter does not call Script, Batch, or runBridgeChecked', () => {
  const source = fs.readFileSync(path.join(__dirname, '../bin/intent/intent-production-adapter.js'), 'utf8');
  assert.equal(/script\/|legacy\/|runBridgeChecked|runBatch|LegacyDispatcher|executeCommand|\.tapText\(/.test(source), false);
  assert.equal(/probeAdb|shell', 'true'|adb_probe/.test(source), false);
});
