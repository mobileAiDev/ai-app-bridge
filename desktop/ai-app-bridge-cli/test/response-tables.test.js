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
    for (const [path, entries] of Object.entries(table.sparseColumns || {}))
      for (const [index, value] of entries) rows[index] = set(rows[index], path, value);
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

test('a first Web page below 32 KiB keeps optional control state in one complete compact reply', async () => {
  const raw = { ok: true, dom: { targetSchema: 'aab.web-dom-target/v1',
    pageRef: { schemaVersion: 'aab.web-dom-target/v1', sessionId: 'first-use', runtimeEpoch: 'document',
      targetId: 'main', navigationId: 'nav', url: 'http://localhost/' },
    bodyText: 'Calendar and two same-prefix notes', bodyTextTruncated: false, truncated: false,
    controlCount: 62, controls: Array.from({ length: 62 }, (_, index) => ({
      elementId: `e${index}`, tag: index < 40 ? 'button' : 'input', id: '', name: '', type: '', role: '',
      ariaLabel: '', placeholder: '', href: '', text: index < 40 ? String(index) : '',
      index, visible: true, disabled: index === 40, editable: index >= 40, sensitive: index === 41,
      checked: index === 42 ? 'mixed' : null, ariaChecked: null,
      interaction: { status: 'ready', point: { x: 10, y: index * 5 } },
      bounds: { left: 0, top: index * 5, right: 50, bottom: index * 5 + 5, width: 50, height: 5 },
      ...(index === 41 ? { valueLength: 17 } : {}),
      ...(index > 55 ? { context: { source: 'ancestor-dom-text', truncated: false, ancestors: [
        { depth: 3, tag: 'article', id: '', role: '', text: index % 2 ? 'Prefix FIRST original' : 'Prefix SECOND untouched',
          textTruncated: false, identityTruncated: false },
      ] } } : {}),
    })) } };
  const originalBytes = Buffer.byteLength(JSON.stringify(raw));
  assert(originalBytes > 8 * 1024 && originalBytes < 32 * 1024);
  const store = createResponseStore({ adapter: createMemoryEvidenceAdapter() });
  const reply = await finishReply({ body: publicReply({ command: 'web-dom', reply: { value: raw } }),
    extract: { mode: 'auto' }, getStore: () => store });
  assert.equal(reply.delivery.status, 'compact');
  assert.equal(reply.value.format, 'aab.response-tables/v3');
  assert.equal(reply.value.partial, false);
  assert.deepEqual(expand(reply.value), raw);
  assert(Buffer.byteLength(JSON.stringify(reply.value)) < originalBytes * 0.6);
  assert.deepEqual(store.read(reply.control.source.ref).snapshot.value, raw);
});

test('heterogeneous tables distinguish absent, null and changing nested types without defaults', () => {
  const raw = Array.from({ length: 30 }, (_, index) => {
    const node = { identity: 'same-page', index, diagnostics: 'original warning '.repeat(20),
      state: [null, {}, [], false, { inner: [1, 2] }, { inner: { deep: 3 } }][index % 6],
      ...(index % 3 === 0 ? { optional: null } : index % 3 === 1 ? { optional: false } : {}),
      'a/b~c': index % 2 ? { '': null } : {},
    };
    Object.defineProperty(node, '__proto__', { value: index % 2 ? null : { kept: index }, enumerable: true });
    return node;
  });
  const view = tableView(raw, Buffer.byteLength(JSON.stringify(raw)), {});
  assert.equal(view.format, 'aab.response-tables/v3');
  assert.deepEqual(expand(view), raw);
  assert.equal(Object.hasOwn(expand(view)[2], 'optional'), false);
  assert.equal({}.kept, undefined);
});

test('v3 shares long sparse values and restores original state and failure diagnostics', async () => {
  const diagnostic = 'original ambiguous response; do not replay\n'.repeat(50);
  const raw = { ok: false, error: 'response_lost', dispatched: true, ambiguous: true,
    nodes: Array.from({ length: 40 }, (_, index) => ({ index, target: { epoch: 'original', nodeRef: `node-${index}` },
      ...(index % 2 ? { warning: diagnostic } : { warning: { text: diagnostic } }),
    })) };
  const store = createResponseStore({ adapter: createMemoryEvidenceAdapter() });
  const result = await finishReply({ body: publicReply({ command: 'web-click', reply: { value: raw } }),
    extract: { mode: 'auto' }, getStore: () => store });
  assert.equal(result.value.format, 'aab.response-tables/v3');
  assert.ok(result.value.sharedTexts.length > 0);
  assert.deepEqual(expand(result.value), raw);
  assert.deepEqual(result.execution, { ok: false, error: 'response_lost', dispatched: true, ambiguous: true });
  assert.equal(result.failureStage, 'execution');
});

test('explicit null preserves heterogeneous Web JSON and auto skips small savings', async () => {
  const raw = { controls: Array.from({ length: 50 }, (_, i) => ({ id: i, text: `unshared-${i}-`.repeat(30),
    ...(i % 2 ? { checked: null } : {}) })) };
  const original = publicReply({ command: 'web-dom', reply: { value: raw } });
  const exact = await finishReply({ body: structuredClone(original), extract: null });
  assert.equal(exact.delivery.status, 'inline'); assert.deepEqual(exact.value, raw);
  const automatic = await finishReply({ body: structuredClone(original), extract: { mode: 'auto' } });
  assert.equal(automatic.delivery.status, 'inline'); assert.deepEqual(automatic.value, raw);
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
