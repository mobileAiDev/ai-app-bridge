'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { flutterLayoutResult } = require('../bin/shared-kernel/flutter-layout-result');
const { publicReply, exitCodeFor } = require('../bin/public-reply');

const layout = () => ({ widgetInspector: { ok: true, root: {} }, widgetDump: { ok: true, text: 'Widget' },
  semantics: { ok: false, error: 'no_root_semantics_node' },
  operable: { ok: true, nodes: [{ id: 1, label: 'Continue', targetRef: { runtimeEpoch: 'observed-epoch' } }],
    coverage: { status: 'partial', reason: 'max_nodes' } } });

test('available Flutter observations are successful reads without hiding unavailable or truncated sources', () => {
  const original = layout(), result = flutterLayoutResult({ ok: true, flutter: { layout: original } });
  assert.equal(result.ok, true); assert.equal(Object.hasOwn(result, 'partial'), false);
  assert.deepEqual(result.unavailableSources, ['semantics']);
  for (const key of Object.keys(original)) assert.deepEqual(result[key], original[key]);
  assert.equal(result.operable.coverage.status, 'partial');
});

test('a layout without top-level SDK ok no longer becomes an unknown public result', () => {
  const result = flutterLayoutResult({ ok: true, flutter: { layout: layout() } });
  const reply = publicReply({ command: 'flutter-tree', reply: { value: result }, completed: true });
  assert.equal(reply.execution.ok, true);
  assert.equal(exitCodeFor(reply), 0);
});

test('successful sources do not imply complete layout coverage in the public reply', () => {
  const original = layout();
  original.semantics = { ok: true, nodes: [] };
  original.widgetDump = { ok: true, text: 'Widget…', truncated: true };
  original.operable.truncated = false;
  original.operable.coverage = { status: 'partial', reason: 'text_truncated' };
  const result = flutterLayoutResult({ ok: true, flutter: { layout: original } });
  const reply = publicReply({ command: 'flutter-tree', reply: { value: result }, completed: true });
  assert.equal(reply.execution.ok, true);
  assert.equal(Object.hasOwn(reply.value, 'partial'), false);
  assert.deepEqual(reply.value.unavailableSources, []);
  assert.equal(reply.value.widgetDump.truncated, true);
  assert.deepEqual(reply.value.operable.coverage, original.operable.coverage);
});

test('missing and malformed layouts cannot become successful null observations', () => {
  for (const value of [undefined, null, [], 'missing']) {
    const result = flutterLayoutResult({ ok: true, flutter: { layout: value } });
    assert.equal(result.error, 'flutter_layout_absent');
    assert.equal(result.ok, false); assert.equal(result.dispatched, false); assert.equal(result.ambiguous, false);
  }
});

test('all unavailable sources remain readable as errors and do not masquerade as an available layout', () => {
  const original = Object.fromEntries(['widgetInspector', 'widgetDump', 'semantics', 'operable']
    .map(key => [key, { ok: false, error: 'source_unavailable' }]));
  const result = flutterLayoutResult({ ok: true, flutter: { layout: original } });
  assert.equal(result.ok, false); assert.equal(result.error, 'flutter_layout_unavailable');
  assert.equal(result.dispatched, false);
  for (const key of Object.keys(original)) assert.deepEqual(result[key], original[key]);
});

test('privacy suppression and outer runtime failure are preserved', () => {
  const original = layout(); original.widgetInspector = { ok: false, error: 'suppressed_secure_input' };
  const result = flutterLayoutResult({ ok: true, flutter: { layout: original } });
  assert.equal(result.widgetInspector.error, 'suppressed_secure_input');
  assert.equal(result.ok, true); assert.ok(result.unavailableSources.includes('widgetInspector'));
  const failure = { ok: false, error: 'runtime_changed', dispatched: false, ambiguous: false };
  assert.deepEqual(flutterLayoutResult(failure), failure);
});
