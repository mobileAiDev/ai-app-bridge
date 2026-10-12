'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const host = require('../bin/execution-host');
const { createResponseStore } = require('../bin/response-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { overview, selectValue } = require('../bin/extraction/overview');
test.after(() => host.close());
function fixture(raw, fault) {
  let calls = 0;
  const dependencies = { responseStore: createResponseStore({ adapter: createMemoryEvidenceAdapter(fault ? { fault } : {}) }),
    factRecorder: null, observationCollector: null, rawRunner: async () => { calls++; return raw; } };
  return { calls: () => calls,
    run: async (extra = {}) => (await host.run({ command: 'uia-tree', arguments: { serial: 'overview', feedback: 'off' }, ...extra }, dependencies)).value,
    read: async request => (await host.run(request, dependencies)).value };
}
test('large automatic response discovers structure and rereads the same source without redispatch', async () => {
  const raw = { ok: true, items: Array.from({ length: 600 }, (_, i) => ({ id: i, message: `${i}: ${'字'.repeat(100)}` })) };
  const f = fixture(raw); const first = await f.run();
  assert.equal(first.delivery.status, 'overview'); assert.equal(first.value.partial, true);
  assert.equal(first.control.source.persisted, true);
  assert(first.value.fields.some(field => field.path === '/items' && field.count === 600));
  assert(Buffer.byteLength(JSON.stringify(first)) < first.delivery.limitBytes);
  const preview = first.value.preview;
  assert.equal(preview.path, '/items'); assert(preview.returned > 100);
  for (const range of preview.ranges) assert.deepEqual(range.items, raw.items.slice(range.offset, range.offset + range.items.length));
  assert.equal(preview.ranges.at(-1).items.at(-1).id, 599);
  const page = await f.read(first.value.read);
  const { offset, limit } = first.value.read.extract;
  assert.deepEqual(page.value, raw.items.slice(offset, offset + limit));
  const full = await f.read({ ...first.value.read, extract: null, output: { maxBytes: 262144 } });
  assert.deepEqual(full.value, raw);
  const selected = await f.read({ ...first.value.read, extract: { mode: 'select', path: '/items/299/id' } });
  assert.equal(selected.value, 299); assert.equal(f.calls(), 1);
});
test('small auto and explicit null keep values; failed storage never pretends omissions are retrievable', async () => {
  const small = { ok: true, items: [1] }; assert.deepEqual((await fixture(small).run()).value, small);
  const large = { ok: true, text: 'x'.repeat(20000) };
  assert.deepEqual((await fixture(large).run({ extract: null })).value, large);
  const failed = await fixture(large, 'enospc').run({ output: { maxBytes: 16384 } });
  assert.equal(failed.delivery.status, 'unavailable'); assert.equal(failed.control.source.persisted, false);
  assert.equal(failed.control.source.ref, undefined);
});
test('auto delivers ordinary logs and observations in one call up to the caller body budget', async () => {
  for (const bytes of [9, 24, 48, 80]) {
    const raw = { ok: true, text: 'x'.repeat(bytes * 1024), lastLine: 'the diagnostic requested by the caller' };
    const f = fixture(raw); const result = await f.run();
    assert.equal(result.delivery.status, 'inline');
    assert.deepEqual(result.value, raw);
    assert.equal(result.control.source.persisted, false);
    assert.equal(f.calls(), 1);
  }
  const raw = { ok: true, text: 'x'.repeat(20000) };
  const f = fixture(raw);
  assert.equal((await f.run({ output: { maxBytes: 16384 } })).delivery.status, 'overview');
  assert.equal((await f.run({ output: { maxBytes: 32768 } })).delivery.status, 'inline');
});
test('overview preserves failed execution and supports escaped JSON Pointer slices', async () => {
  const raw = { ok: false, error: 'provider_timeout', dispatched: null, ambiguous: true,
    warnings: [{ code: 'previous_execution_unknown', blocking: false }], 'a/b~c': 'x'.repeat(150000) };
  const f = fixture(raw); const first = await f.run();
  assert.equal(first.failureStage, 'execution'); assert.equal(first.execution.ambiguous, true);
  const read = await f.read({ ...first.value.read, extract: { mode: 'select', path: '/a~1b~0c', offset: 9999, limit: 3 } });
  assert.equal(read.value, 'xxx'); assert.equal(read.control.origin.execution.ambiguous, true);
  assert.equal(selectValue({}, { path: '', offset: 0 }).error, 'extraction_slice_type');
  assert.equal(selectValue({}, { path: '/__proto__' }).error, 'extraction_path_not_found'); assert.equal(f.calls(), 1);
});
test('over-budget log previews retain useful beginning and latest lines, Unicode and a readable gap', async () => {
  const raw = Array.from({ length: 1600 }, (_, i) => `line ${i}: ${'诊断😀'.repeat(30)}\n`).join('');
  const f = fixture(raw); const first = await f.run({ command: 'logcat' });
  assert.equal(first.delivery.status, 'overview');
  const preview = first.value.preview;
  assert.equal(preview.type, 'string'); assert.equal(preview.offsetUnit, 'utf16-code-units');
  assert(preview.ranges[0].text.startsWith('line 0:'));
  assert(preview.ranges.at(-1).text.includes('line 1599:'));
  for (const range of preview.ranges) {
    assert.equal(range.text, raw.slice(range.offset, range.offset + range.text.length));
    assert(range.text.isWellFormed()); assert.match(range.text, /^line \d+:/);
  }
  const page = await f.read(first.value.read);
  const { offset, limit } = first.value.read.extract;
  assert.equal(page.value, raw.slice(offset, offset + limit));
  assert.equal(page.delivery.status, 'inline'); assert.equal(f.calls(), 1);
});
test('a large Intent observation previews its nodes instead of its small events array', () => {
  const raw = { ok: true, revision: 4, events: Array.from({ length: 10 }, (_, sequence) => ({ sequence })),
    summary: { nodes: Array.from({ length: 300 }, (_, id) => ({ id, text: 'x'.repeat(700), targetRef: { nodeRef: String(id) } })) } };
  const first = overview('intent', raw, 'json', Buffer.byteLength(JSON.stringify(raw)), { ref: {} });
  assert.equal(first.preview.path, '/summary/nodes');
  assert(first.preview.ranges.every(range => range.items.every(node => node.text.length === 700 && node.targetRef.nodeRef === String(node.id))));
});
test('one oversized response body exposes record facts and a valid text page without a failed reread', async () => {
  const raw = { ok: true, items: [{ id: 7, statusCode: 503, responseBody: 'diagnostic\n'.repeat(20000) }] };
  const f = fixture(raw); const result = await f.run();
  assert.equal(result.delivery.status, 'overview');
  assert.equal(result.value.preview.path, '/items/0/responseBody');
  assert(result.value.fields.some(field => field.path === '/items/0/statusCode' && field.value === 503));
  const page = await f.read(result.value.read);
  assert.equal(page.delivery.status, 'inline'); assert.equal(f.calls(), 1);
});
test('structural hints remain valid and bounded for objects and very long property names', () => {
  for (const value of [{ a: 1, b: 2 }, { ['key'.repeat(10000)]: 'x'.repeat(10000) }]) {
    const result = overview('tree', value, 'json', 20000, { ref: {} });
    assert.equal(selectValue(value, result.read.extract).ok, true); assert(Buffer.byteLength(JSON.stringify(result)) < 8192);
  }
});
