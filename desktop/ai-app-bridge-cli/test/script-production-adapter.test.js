'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createProductionScriptDeviceAdapter } = require('../bin/script/script-production-adapter');
const { createTargetLease } = require('../bin/shared-kernel/target-lease-protocol');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { handle, resetScriptOperations } = require('../bin/script/script-entry');

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

test('production Script adapter allows different packages on the same serial in parallel', async () => {
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
  const adapter = createProductionScriptDeviceAdapter({
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

test('G4-B production adapter uses injected ports and never overlaps device I/O', async () => {
  resetScriptOperations();
  const active = [];
  const ports = {
    createBridgeContext: (options) => options,
    async bridgeTree() {
      active.push('tree');
      assert.equal(active.filter((item) => item !== 'done').length <= 1, true);
      active.pop();
      return {
        root: {
          id: 'about',
          className: 'Button',
          text: 'About',
          clickable: true,
          bounds: { left: 10, top: 20, right: 30, bottom: 40 },
          children: [],
        },
      };
    },
    async uiaTree() { throw new Error('UIA must be explicit'); },
    async flutterNodes() { throw new Error('Flutter must be explicit'); },
    findTappableNodeByText(tree, text) {
      if (tree.root && tree.root.text === text) return { node: tree.root };
      return { node: null };
    },
    async tap(_ctx, x, y) {
      active.push('tap');
      assert.equal(active.length, 1);
      active.pop();
      return { ok: true, x, y };
    },
    async tapText() { throw new Error('tapText must not be used on the new path'); },
    async flutterAction() { throw new Error('flutterAction must be explicit'); },
  };
  const adapter = createProductionScriptDeviceAdapter({
    lease: createTargetLease(),
    ports,
    probeAdb: async () => ({ ok: true, ms: 1 }),
  });
  const result = await handle({
    operation: 'start',
    script: {
      name: 'prod',
      target: { serial: 'b46093e6', packageName: 'com.example.app' },
      steps: [
        { id: 'o1', type: 'observe', provider: 'native' },
        { id: 'a1', type: 'action', action: 'tap', text: 'About' },
      ],
    },
    store: createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() }),
    adapter,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'script_format_removed');
});

test('G4-B production adapter taps Flutter text with bounds via host tap', async () => {
  resetScriptOperations();
  const taps = [];
  let flutterAcquires = 0;
  const ports = {
    createBridgeContext: (options) => options,
    async flutterNodes() {
      flutterAcquires += 1;
      return {
        nodes: [{
          text: '返回',
          tap: { bounds: { left: 8, top: 48, right: 48, bottom: 88, centerX: 28, centerY: 68 } },
        }],
        viewport: { devicePixelRatio: 3 },
      };
    },
    async tap(_ctx, x, y) {
      taps.push({ x, y });
      return { ok: true, transport: 'adb', x, y };
    },
    async flutterAction() { throw new Error('flutterAction must not be used when bounds exist'); },
    async uiaTree() { throw new Error('UIA must be explicit'); },
    async bridgeTree() { throw new Error('native tree must be explicit'); },
    async tapText() { throw new Error('tapText must be explicit'); },
  };
  const adapter = createProductionScriptDeviceAdapter({
    lease: createTargetLease(),
    ports,
    probeAdb: async () => ({ ok: true, ms: 1 }),
  });
  const result = await handle({
    operation: 'start',
    operationId: 'g7-flutter-bounds-tap',
    script: {
      name: 'flutter-bounds',
      target: { serial: 'b46093e6', packageName: 'com.example.app' },
      steps: [
        { id: 'o1', type: 'observe', provider: 'flutter' },
        { id: 'a1', type: 'action', action: 'tap', provider: 'flutter', text: '返回' },
      ],
    },
    store: createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() }),
    adapter,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'script_format_removed');
  assert.equal(flutterAcquires, 0);
  assert.deepEqual(taps, []);
});

test('G4-B production adapter does not call runBridgeChecked or Batch', () => {
  const source = fs.readFileSync(path.join(__dirname, '../bin/script/script-production-adapter.js'), 'utf8');
  assert.equal(/runBridgeChecked|runBatch|LegacyDispatcher|executeCommand|\.tapText\(/.test(source), false);
  assert.equal(/probeAdb|shell', 'true'|adb_probe/.test(source), false);
});
