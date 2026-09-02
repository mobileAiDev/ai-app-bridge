'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { summarizeTree } = require('../bin/shared-kernel/summary-transformer');

const nativeFixture = require('./fixtures/summary-native.json');
const flutterFixture = require('./fixtures/summary-flutter.json');
const h5Fixture = require('./fixtures/summary-h5.json');
const uiaXml = fs.readFileSync(path.join(__dirname, 'fixtures/summary-uia.xml'), 'utf8');

test('G3 Native, UIA, Flutter, and H5 fixtures summarize to mapped nodes', () => {
  const native = summarizeTree(nativeFixture);
  const uia = summarizeTree({ provider: 'uia', rawTree: uiaXml, rawTreeId: 'uia-tree-1' });
  const flutter = summarizeTree(flutterFixture);
  const h5 = summarizeTree(h5Fixture);

  assert.equal(native.ok, true);
  assert.deepEqual(native.nodes.map((node) => node.nodeId), ['title', 'about', 'search', 'logo', 'wifi']);
  assert.equal(native.nodes.find((node) => node.nodeId === 'about').role, 'button');
  assert.equal(native.nodes.find((node) => node.nodeId === 'search').role, 'input');
  assert.equal(native.nodes.find((node) => node.nodeId === 'wifi').checked, true);
  assert.equal(native.nodes.every((node) => node.rawTreeId === 'native-tree-1'), true);

  assert.equal(uia.ok, true);
  assert.equal(uia.nodes.some((node) => node.text === 'Explore'), true);
  assert.equal(uia.nodes.some((node) => node.role === 'input' && node.label === 'Search Wikipedia'), true);
  assert.equal(uia.nodes.find((node) => node.text === 'Saved').selected, true);
  assert.equal(uia.nodes.every((node) => node.rawTreeId === 'uia-tree-1'), true);

  assert.equal(flutter.nodes.map((node) => node.nodeId).join(','), 'settings-tile,about-tile,name-field');
  assert.equal(flutter.nodes.find((node) => node.nodeId === 'name-field').role, 'input');
  assert.equal(h5.nodes.find((node) => node.nodeId === 'go').role, 'button');
  assert.equal(h5.nodes.find((node) => node.nodeId === 'logo').role, 'image');
});

test('G3 identical input is deterministic and each node maps back', () => {
  const first = summarizeTree(nativeFixture);
  const second = summarizeTree(nativeFixture);
  assert.deepEqual(first, second);
  const sourceIds = collectNativeIds(nativeFixture.rawTree.root);
  for (const node of first.nodes) {
    assert.equal(sourceIds.includes(node.nodeId), true, node.nodeId);
  }
});

test('G3 5k and 10k node p95 stays under 20ms and output stays bounded', () => {
  const five = benchmark(5_000);
  const ten = benchmark(10_000);
  assert.equal(five.p95 < 20, true, `5k p95 ${five.p95}`);
  assert.equal(ten.p95 < 20, true, `10k p95 ${ten.p95}`);
  assert.equal(five.summary.ok, true);
  assert.equal(ten.summary.ok, true);
  assert.equal(Buffer.byteLength(JSON.stringify(five.summary), 'utf8') <= 64 * 1024, true);
  assert.equal(Buffer.byteLength(JSON.stringify(ten.summary), 'utf8') <= 64 * 1024, true);
});

test('G3 SummaryTransformer makes zero Provider or ADB calls', () => {
  const source = fs.readFileSync(path.join(__dirname, '../bin/shared-kernel/summary-transformer.js'), 'utf8');
  assert.equal(/child_process|mcp-server|runBridgeChecked|ai-app-bridge\.js/.test(source), false);
  const calls = { adb: 0, provider: 0 };
  summarizeTree({
    ...nativeFixture,
    acquireProvider() { calls.provider += 1; throw new Error('provider must not be called'); },
    adb() { calls.adb += 1; throw new Error('adb must not be called'); },
  });
  assert.deepEqual(calls, { adb: 0, provider: 0 });
});

function collectNativeIds(node, ids = []) {
  if (node.id) ids.push(node.id);
  for (const child of node.children || []) collectNativeIds(child, ids);
  return ids;
}

function benchmark(count) {
  const rawTree = {
    operable: {
      nodes: Array.from({ length: count }, (_, index) => ({
        id: `n-${index}`,
        widgetType: index % 7 === 0 ? 'TextField' : 'ListTile',
        text: `Item ${index}`,
        actions: ['tap'],
        bounds: { left: 0, top: index, right: 100, bottom: index + 1 },
      })),
    },
  };
  const samples = [];
  let summary;
  for (let i = 0; i < 12; i += 1) {
    const started = process.hrtime.bigint();
    summary = summarizeTree({ provider: 'flutter', rawTree, rawTreeId: `bench-${count}` });
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return { p95: samples[Math.ceil(samples.length * 0.95) - 1], summary, samples };
}
