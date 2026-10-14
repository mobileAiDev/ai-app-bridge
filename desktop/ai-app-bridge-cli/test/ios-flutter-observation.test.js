'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IOSBridgeProvider } = require('../bin/ios-provider');

function provider(layout) {
  const instance = new IOSBridgeProvider();
  instance.runtimeGet = async () => ({ ok: true, endpoint: 'http://device', runtimeBinding: { runtimeEpoch: 'epoch' }, flutter: { layout } });
  return instance;
}

test('iOS Flutter nodes preserve a reported source error and runtime binding', async () => {
  const source = { ok: false, error: 'fixture_operable_unavailable', message: 'Engine is starting' };
  const result = await provider({ operable: source }).flutterNodes();
  assert.equal(result.ok, false);
  assert.equal(result.error, source.error);
  assert.equal(result.message, source.message);
  assert.deepEqual(result.runtimeBinding, { runtimeEpoch: 'epoch' });
});

test('iOS Flutter full read retains partial sources and does not invent an available layout', async () => {
  const partial = { operable: { ok: true, nodes: [], truncated: false }, semantics: { ok: false, error: 'unavailable' } };
  const result = await provider(partial).flutterTree();
  assert.equal(result.ok, true);
  assert.deepEqual(result.layout, partial);
  assert.ok(result.unavailableSources.includes('semantics'));
  for (const value of [null, {}, { operable: { ok: false, error: 'unavailable' } }]) {
    assert.equal((await provider(value).flutterTree()).ok, false);
  }
});

test('iOS Flutter successful operable read preserves coverage and controls', async () => {
  const source = { ok: true, nodes: [{ id: 'one' }], count: 1, coverage: { status: 'partial', reason: 'max_nodes' } };
  const result = await provider({ operable: source }).flutterNodes();
  assert.equal(result.ok, true);
  assert.deepEqual(result.coverage, source.coverage);
  assert.deepEqual(result.nodes, source.nodes);
});
