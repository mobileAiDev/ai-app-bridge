'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tableView } = require('../bin/extraction/tables');
const { publicReply, finishReply, responseReply } = require('../bin/public-reply');
const { createResponseStore } = require('../bin/response-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');

// Independent consumer of the documented wire format. No production decoder is
// involved: every input value must be recoverable from the first reply alone.
function expand(view) {
  function set(root, pointer, value) {
    if (pointer === '') return structuredClone(value);
    const keys = pointer.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'));
    let target = root;
    for (const key of keys.slice(0, -1)) {
      if (!Object.hasOwn(target, key)) Object.defineProperty(target, key, { value: {}, enumerable: true, writable: true, configurable: true });
      target = target[key];
    }
    Object.defineProperty(target, keys.at(-1), { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
    return root;
  }
  view = structuredClone(view);
  for (const entry of view.sharedTexts || []) for (const pointer of entry.paths) view = set(view, pointer, entry.text);
  let result = structuredClone(view.data);
  for (const table of view.tables) {
    const rows = table.rows.map(cells => {
      let row = {};
      for (const [path, value] of Object.entries(table.constants)) row = set(row, path, value);
      table.columns.forEach((path, index) => { row = set(row, path, cells[index]); });
      return row;
    });
    result = set(result, table.path, rows);
  }
  return result;
}

test('nested workflow diagnostics keep repeated long text once and restore every field without a read', async () => {
  const text = 'Window package identity and original diagnostics\n'.repeat(140);
  const detail = { ok: true, evidence: { window: text, package: text + 'different' } };
  const original = { ok: true, summary: { foreground: detail }, lastAction: { result: {
    observed: { foregroundObservations: [detail, detail], result: { foregroundObservations: [detail, detail] } },
    tap: { foregroundObservations: [detail, detail, detail], result: { foregroundObservations: [detail, detail, detail] } },
  } } };
  const store = createResponseStore({ adapter: createMemoryEvidenceAdapter() });
  const result = await finishReply({ body: publicReply({ command: 'intent', reply: { value: original } }),
    extract: { mode: 'auto' }, getStore: () => store });
  assert.equal(result.delivery.status, 'compact');
  assert.equal(result.value.format, 'aab.response-tables/v2');
  assert.equal(result.value.partial, false);
  assert.deepEqual(expand(result.value), original);
  assert(Buffer.byteLength(JSON.stringify(result)) < 96 * 1024);
  assert.ok(result.value.sharedTexts.some(item => item.paths.some(pointer => pointer.startsWith('/tables/'))));
  assert.deepEqual(store.read(result.control.source.ref).snapshot.value, original);
});

test('shared texts work without tables and keep nulls and escaped pointer keys distinct', () => {
  const text = '原始 long diagnostic "quoted"\n'.repeat(150);
  const original = JSON.parse(JSON.stringify({ 'a/b~c': text, nested: { '__proto__': null, other: text }, nil: null }));
  Object.defineProperty(original.nested, '__proto__', { value: text, enumerable: true });
  const view = tableView(original, Buffer.byteLength(JSON.stringify(original)), { ref: { id: 'original' } });
  assert.equal(view.format, 'aab.response-tables/v2'); assert.equal(view.tables.length, 0);
  assert.deepEqual(expand(view), original);
  assert.equal(view.read.extract.path, '/a~1b~0c');
  assert.equal({}.polluted, undefined);
});

test('large page tables retain every node, duplicate label, state and complete action binding', async () => {
  const raw = { ok: true, truncated: false, nodes: Array.from({ length: 400 }, (_, id) => ({
    id, text: id % 5 === 0 ? '同意' : '', enabled: id % 3 !== 0, checked: id % 2 === 0,
    description: '说明'.repeat(100), bounds: { left: 10, top: id, width: 400, height: 50 },
    targetRef: { schemaVersion: 'aab.uia.target/v1', bootId: 'boot', runtimeEpoch: 'epoch', snapshotId: 'snapshot', nodeRef: `node-${id}` },
  })) };
  const store = createResponseStore({ adapter: createMemoryEvidenceAdapter() });
  const result = await finishReply({ body: publicReply({ command: 'uia-tree', reply: { value: raw } }),
    extract: { mode: 'auto' }, getStore: () => store });
  assert.equal(result.delivery.status, 'compact'); assert.equal(result.extraction.partial, false);
  assert.equal(result.value.partial, false); assert.deepEqual(expand(result.value), raw);
  assert(Buffer.byteLength(JSON.stringify(result)) < 96 * 1024);
  const retained = store.read(result.control.source.ref);
  const firstRow = await finishReply({ body: responseReply(retained), frozen: retained,
    extract: result.value.read.extract, getStore: () => store });
  assert.equal(firstRow.delivery.status, 'inline'); assert.deepEqual(firstRow.value, raw.nodes.slice(0, 1));
});

test('table views preserve empty values, escaped keys, missing properties and nested arrays', () => {
  const common = { description: 'long constant '.repeat(100), emptyArray: [], emptyObject: {}, nil: null, no: false, zero: 0, blank: '' };
  const cases = [
    Array.from({ length: 8 }, (_, i) => ({ ...common, 'a/b~c': { '': i }, __proto__: null })),
    { 'a/b~c': Array.from({ length: 8 }, (_, i) => JSON.parse(JSON.stringify({ ...common, i }).replace('"i":', '"__proto__":'))) },
    { items: [{ a: Array(5).fill(common) }, { b: Array(5).fill(common) }, { c: [] }] },
    { items: [{ ...common, optional: null }, { ...common }, { ...common, optional: false }] },
  ];
  for (const raw of cases) {
    const view = tableView(raw, Buffer.byteLength(JSON.stringify(raw)), { ref: {} });
    if (view) assert.deepEqual(expand(view), JSON.parse(JSON.stringify(raw)));
  }
  assert.equal({}.polluted, undefined);
});

test('complete table delivery survives unavailable storage without inventing a read reference', async () => {
  const raw = { ok: true, items: Array.from({ length: 1000 }, (_, id) => ({ id, message: 'same content '.repeat(20) })) };
  const store = createResponseStore({ adapter: createMemoryEvidenceAdapter({ fault: 'enospc' }) });
  const result = await finishReply({ body: publicReply({ command: 'logs', reply: { value: raw } }),
    extract: { mode: 'auto' }, getStore: () => store });
  assert.equal(result.delivery.status, 'compact'); assert.deepEqual(expand(result.value), raw);
  assert.equal(result.control.source.persisted, false); assert.equal(result.value.read, undefined);
});

test('medium repetitive results save context without introducing a discovery round trip', async () => {
  const raw = { ok: true, nodes: Array.from({ length: 80 }, (_, id) => ({ id, label: 'label '.repeat(90), checked: id % 2 === 0 })) };
  const originalBytes = Buffer.byteLength(JSON.stringify(raw));
  assert(originalBytes > 32 * 1024 && originalBytes < 96 * 1024);
  const store = createResponseStore({ adapter: createMemoryEvidenceAdapter() });
  const result = await finishReply({ body: publicReply({ command: 'tree', reply: { value: raw } }),
    extract: { mode: 'auto' }, getStore: () => store });
  assert.equal(result.delivery.status, 'compact'); assert.deepEqual(expand(result.value), raw);
  assert(Buffer.byteLength(JSON.stringify(result.value)) < originalBytes * 0.7);
  assert.equal(result.value.partial, false);
});

test('varied JSON records round trip with no generated defaults or loss of duplicates', () => {
  for (let seed = 0; seed < 50; seed++) {
    const raw = { seed, rows: Array.from({ length: 20 }, (_, i) => ({
      constant: 'repeated metadata '.repeat(8), i: Math.floor(i / 2),
      nested: { selected: (i + seed) % 2 === 0, value: [null, false, '', 0, { a: seed }][(i + seed) % 5] },
      ...(i % 3 === 0 && seed % 2 === 0 ? { optional: null } : {}),
    })) };
    const view = tableView(raw, Buffer.byteLength(JSON.stringify(raw)), { ref: {} });
    if (view) assert.deepEqual(expand(view), raw);
  }
});
