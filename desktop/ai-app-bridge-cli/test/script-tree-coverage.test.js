'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createScriptHostPort } = require('../bin/script/script-host-port');

const complete = () => ({ ok: true, truncated: false });
const layout = () => Object.fromEntries(['widgetInspector', 'widgetDump', 'semantics', 'operable'].map(name => [name, complete()]));

for (const [name, command, payload, expected] of [
  ['native source', 'tree', { ok: true, coverage: { status: 'partial', reason: 'node_limit' } }, 'partial'],
  ['compact source', 'uia-tree', { ok: true, coverage: { source: { status: 'partial' }, projection: { truncated: false } } }, 'partial'],
  ['compact projection', 'uia-tree', { ok: true, coverage: { source: { status: 'complete' }, projection: { truncated: true, reason: 'max_nodes' } } }, 'partial'],
  ['raw UIA', 'uia-tree', '<hierarchy aab-truncated="true"><node bounds="[0,0][10,10]"/></hierarchy>', 'partial'],
  ['H5 text', 'h5-dom', { ok: true, dom: { truncated: false, bodyTextTruncated: true } }, 'partial'],
  ['Flutter diagnostic', 'flutter-tree', { ok: true, ...layout(), widgetDump: { ok: true, truncated: true } }, 'partial'],
  ['Flutter unavailable source', 'flutter-tree', { ok: true, ...layout(), semantics: { ok: false, error: 'no_root_semantics_node' } }, 'partial'],
  ['Flutter semantics without a completeness report', 'flutter-tree', { ok: true, ...layout(), semantics: { ok: true, root: {}, nodeCount: 1 } }, 'unknown'],
  ['iOS Flutter full layout', 'ios-flutter-tree', { ok: true, layout: { ...layout(), widgetInspector: { ok: true, truncated: true } } }, 'partial'],
  ['unreported source', 'tree', { ok: true, root: {} }, 'unknown'],
  ['complete native', 'tree', { ok: true, coverage: { status: 'complete' } }, 'complete'],
  ['complete visible projection', 'uia-tree', { ok: true, coverage: { source: { status: 'complete' }, projection: { truncated: false, filtered: true } } }, 'complete'],
  ['operable only', 'flutter-nodes', { ok: true, operable: complete() }, 'complete'],
  ['full Flutter', 'flutter-tree', { ok: true, ...layout() }, 'complete'],
]) {
  test(`Script preserves ${name} coverage without failing the read`, async () => {
    const target = command.startsWith('ios-') ? { platform: 'ios', deviceId: 'device', bundleId: 'app' }
      : { platform: 'android', serial: 'device', packageName: 'app' };
    const host = createScriptHostPort({ target, actions: async () => structuredClone(payload) });
    const read = await host.call(command);
    assert.equal(read.ok, true);
    assert.deepEqual(read.result, payload);
    assert.equal(read.evidence.coverage.status, expected);
    assert.equal(read.evidence.coverage.gap, expected !== 'complete');
    const verdict = await host.assert({ name, condition: true, requiredEvidence: ['tree'], evidence: read.evidence });
    assert.equal(verdict.verdict, expected === 'complete' ? 'passed' : 'inconclusive');
  });
}

test('page-summary retains provider and projection coverage', async () => {
  const host = createScriptHostPort({ actions: async () => { throw new Error('local summary must not dispatch'); } });
  const result = await host.call('page-summary', { provider: 'flutter', rawTreeId: 'captured',
    rawTree: { nodes: [], truncated: true } });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.coverage.status, 'partial');
});
