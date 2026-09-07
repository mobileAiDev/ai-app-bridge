'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createScriptHostPort } = require('../bin/script/script-host-port');

const nativeFixture = require('./fixtures/summary-native.json');
const flutterFixture = require('./fixtures/summary-flutter.json');
const h5Fixture = require('./fixtures/summary-h5.json');
const uiaXml = fs.readFileSync(path.join(__dirname, 'fixtures/summary-uia.xml'), 'utf8');

test('P8 page-summary Host path uses existing fixtures and never calls actions or runner', async () => {
  let actions = 0;
  let runner = 0;
  const host = createScriptHostPort({
    target: { serial: 'p8' },
    actions: async () => {
      actions += 1;
      return { ok: true };
    },
    runner: async () => {
      runner += 1;
      return { ok: true, coverage: { status: 'unavailable', gap: true, committed: false }, refs: [], items: [] };
    },
  });
  const fixtures = [
    { provider: nativeFixture.provider, rawTree: nativeFixture.rawTree, rawTreeId: nativeFixture.rawTreeId },
    { provider: 'uia', rawTree: uiaXml, rawTreeId: 'uia-tree-1' },
    { provider: flutterFixture.provider, rawTree: flutterFixture.rawTree, rawTreeId: flutterFixture.rawTreeId },
    { provider: h5Fixture.provider, rawTree: h5Fixture.rawTree, rawTreeId: h5Fixture.rawTreeId },
  ];
  for (const fixture of fixtures) {
    const started = process.hrtime.bigint();
    const summary = await host.call('page-summary', fixture);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(summary.ok, true, fixture.provider);
    assert.equal(summary.result.ok, true, fixture.provider);
    assert.equal(summary.result.nodes.length > 0, true, fixture.provider);
    assert.equal(ms < 50, true, `${fixture.provider} ${ms}ms`);
  }
  assert.equal(actions, 0);
  assert.equal(runner, 0);
  assert.equal(host.actionCallCount, 0);
});

test('P8 page-summary transformer stays off ADB provider and screenshot', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../bin/shared-kernel/summary-transformer.js'),
    'utf8',
  );
  assert.equal(/child_process|mcp-server|runBridgeChecked|ai-app-bridge\.js/.test(source), false);
});
