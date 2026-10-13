'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const host = require('../bin/execution-host');
const { publicReply, finishReply } = require('../bin/public-reply');
const { createResponseStore } = require('../bin/response-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { difference, representation } = require('../bin/extraction/delta');
const { checksumOf } = require('../bin/shared-kernel/evidence-schema');
test.after(() => host.close());

// Independent RFC 6902 consumer: verifies pointers and sequential array edits.
function applyPatch(value, operations) {
  let result = structuredClone(value);
  for (const operation of operations) {
    const { op, path, value } = operation;
    if (path === '') { assert.equal(op, 'replace'); result = structuredClone(value); continue; }
    const keys = path.slice(1).split('/').map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'));
    const key = keys.pop(), parent = keys.reduce((node, part) => { assert(Object.hasOwn(node, part)); return node[part]; }, result);
    if (op !== 'add') assert(Object.hasOwn(parent, key));
    if (op === 'remove') { if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; }
    else if (op === 'add' && Array.isArray(parent)) parent.splice(Number(key), 0, structuredClone(value));
    else Object.defineProperty(parent, key, { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function expand(data) {
  if (data?.format !== 'aab.response-columns/v1') return data;
  const set = (root, pointer, value) => {
    if (pointer === '') return structuredClone(value);
    const keys = pointer.slice(1).split('/').map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'));
    let parent = root;
    for (const key of keys.slice(0, -1)) {
      if (!Object.hasOwn(parent, key)) Object.defineProperty(parent, key, { value: {}, enumerable: true, writable: true, configurable: true });
      parent = parent[key];
    }
    Object.defineProperty(parent, keys.at(-1), { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
    return root;
  };
  let result = structuredClone(data.data);
  for (const [pointer, table] of Object.entries(data.tables)) {
    const rows = Array.from({ length: table.rowCount }, (_, i) => {
      let row = {};
      for (const [path, value] of Object.entries(table.constants)) row = set(row, path, value);
      for (const [path, values] of Object.entries(table.columns)) row = set(row, path, values[i]);
      return row;
    });
    result = set(result, pointer, rows);
  }
  return result;
}

function fixture() {
  const adapter = createMemoryEvidenceAdapter(), store = createResponseStore({ adapter });
  const run = (value, base, command = 'uia-tree', output) => finishReply({ body: publicReply({ command, reply: { value } }),
    extract: { mode: 'delta', ...(base ? { base } : {}) }, getStore: () => store, output });
  return { adapter, store, run };
}
const page = (epoch = 'epoch') => ({ ok: true, truncated: false, coverage: { complete: true },
  nodes: Array.from({ length: 80 }, (_, index) => ({ index, text: index % 2 ? '同意' : '我已阅读并同意完整用户说明',
    checked: false, enabled: true, bounds: { left: 0, top: index * 50, right: 400, bottom: index * 50 + 40 },
    targetRef: { schemaVersion: 'aab.uia.target/v1', bootId: 'boot', runtimeEpoch: epoch, snapshotId: 'snapshot', nodeRef: randomUUID() } })) });

test('fresh references and small UI edits reconstruct exactly with no second device read', async () => {
  const f = fixture(), before = page(), first = await f.run(before);
  assert.equal(first.value.mode, 'full'); assert.equal(first.value.reason, 'initial');
  assert(first.control.source.persisted);
  const after = page(); after.nodes.forEach(n => { n.targetRef.snapshotId = 'new-snapshot'; });
  after.nodes[1].checked = true; after.nodes[1].text = '已同意';
  const second = await f.run(after, first.control.source.ref);
  assert.equal(second.value.mode, 'patch'); assert.equal(second.delivery.status, 'delta');
  const reconstructed = applyPatch(first.value.data, second.value.operations);
  assert.equal(checksumOf(reconstructed), second.value.sha256);
  assert.equal(checksumOf(first.value.data), second.value.baseSha256);
  assert.deepEqual(reconstructed, representation(f.store.read(second.control.source.ref).snapshot));
  assert.deepEqual(expand(reconstructed), after);
  assert.deepEqual(f.store.read(second.control.source.ref).snapshot.value, after);
  assert(Buffer.byteLength(JSON.stringify(second)) < Buffer.byteLength(JSON.stringify(first)));
  assert(Buffer.byteLength(JSON.stringify(second)) < Buffer.byteLength(JSON.stringify(after)) * 0.4);
});

test('unchanged data, reorders, deleted and added rows, new runtime and capture loss are never hidden', async () => {
  const f = fixture(), first = await f.run(page());
  const same = f.store.read(first.control.source.ref).snapshot.value;
  const unchanged = await f.run(same, first.control.source.ref);
  assert.deepEqual(unchanged.value.operations, []);
  const next = structuredClone(same);
  next.nodes.reverse(); next.nodes.splice(3, 10); next.nodes.push({ text: 'new shape', enabled: false });
  next.nodes[0].targetRef.runtimeEpoch = 'new-epoch';
  next.truncated = true; next.coverage.complete = false;
  const changed = await f.run(next, unchanged.control.source.ref);
  const restored = changed.value.mode === 'patch' ? applyPatch(first.value.data, changed.value.operations) : changed.value.data;
  assert.deepEqual(restored, representation(f.store.read(changed.control.source.ref).snapshot));
  assert.deepEqual(expand(restored), next);
});

test('expired, corrupt, mismatched and unavailable bases deliver current data without execution failure', async () => {
  const f = fixture(), first = await f.run(page());
  for (const ref of [ { ...first.control.source.ref, evidenceId: 'evicted' },
    { ...first.control.source.ref, checksum: '0'.repeat(64) }, { ...first.control.source.ref, operationId: 'wrong' } ]) {
    const latest = page('fresh-epoch'), reply = await f.run(latest, ref);
    assert.equal(reply.execution.ok, true); assert.equal(reply.failureStage, undefined);
    assert.equal(reply.value.mode, 'full'); assert.equal(reply.value.reason, 'base_unavailable');
    assert(reply.value.detail.startsWith('response_'));
    assert.deepEqual(reply.value.data, representation(f.store.read(reply.control.source.ref).snapshot));
  }
  const different = await f.run(page(), first.control.source.ref, 'native-tree');
  assert.equal(different.value.reason, 'base_kind_or_command_changed');
});

test('current execution and continuation facts remain visible even when values are differenced', async () => {
  const f = fixture(), first = await f.run({ ...page(), operationId: 'intent-one', revision: 1, status: 'ready' }, null, 'intent');
  const result = await f.run({ ...page(), ok: false, error: 'network_timeout', dispatched: true, ambiguous: true,
    operationId: 'intent-one', revision: 2, status: 'waiting_for_agent' }, first.control.source.ref, 'intent');
  assert.equal(result.execution.error, 'network_timeout'); assert.equal(result.execution.ambiguous, true);
  assert.equal(result.control.revision, 2); assert.equal(result.control.status, 'waiting_for_agent');
  assert.equal(result.failureStage, 'execution');
});

test('public request accepts delta on the initial call and saved offline reads never dispatch again', async () => {
  const f = fixture(); let calls = 0;
  const dependencies = { responseStore: f.store, factRecorder: null, observationCollector: null,
    rawRunner: async () => { calls++; return page(); } };
  const first = (await host.run({ command: 'uia-tree', arguments: { serial: 'delta-fixture', compact: true, feedback: 'off' },
    extract: { mode: 'delta' } }, dependencies)).value;
  assert.equal(first.execution.ok, true, JSON.stringify(first));
  const read = (await host.run({ command: 'response', arguments: { operation: 'read', ref: first.control.source.ref },
    extract: { mode: 'delta', base: first.control.source.ref } }, dependencies)).value;
  assert.equal(calls, 1); assert.deepEqual(read.value.operations, []);
  assert.deepEqual(read.control.source, first.control.source);
});

test('storage failures keep an inline baseline and budgets never emit partial patches', async () => {
  const store = createResponseStore({ adapter: createMemoryEvidenceAdapter({ fault: 'enospc' }) });
  const result = await finishReply({ body: publicReply({ command: 'uia-tree', reply: { value: page() } }),
    extract: { mode: 'delta' }, getStore: () => store });
  assert.equal(result.execution.ok, true); assert.equal(result.control.source.persisted, false);
  assert.equal(result.value.mode, 'full'); assert.equal(result.control.source.ref, undefined);
  const f = fixture(), huge = { ok: true, content: randomUUID().repeat(10000) };
  const over = await f.run(huge, null, 'native-tree', { maxBytes: 16384 });
  assert.equal(over.value, undefined); assert.equal(over.delivery.status, 'reference');
  assert(Buffer.byteLength(JSON.stringify(over)) <= 16384);
  assert.deepEqual(f.store.read(over.control.source.ref).snapshot.value, huge);
});

test('RFC pointers, null, missing keys, Unicode and array index shifts round trip independently', () => {
  const cases = [
    [{ 'a/b~': { '': 1, '中文': 2 } }, { 'a/b~': { '': null, '中文': 3 } }],
    [{ rows: Array.from({ length: 100 }, (_, i) => i) }, { rows: [0, 2, 3, 4] }],
    [[0, 1], [0, 1, null, false, '中文']], [null, { rows: [] }], [{ rows: [] }, 'text'],
    [JSON.parse('{"__proto__":{"x":1},"a":2}'), JSON.parse('{"__proto__":{"x":2},"a":2,"constructor":0}')],
  ];
  for (const [a, b] of cases) assert.deepEqual(applyPatch(a, difference(a, b)), b);
  assert.equal({}.x, undefined);
});

test('column baselines preserve escaped keys, empty values, duplicate rows and nested arrays', () => {
  for (const root of ['', '/a~1b~0']) {
    const rows = Array.from({ length: 10 }, (_, index) => JSON.parse(JSON.stringify({ '': index, blank: '', empty: [], nil: null,
      nested: { 'a/b~': 'same text '.repeat(70) }, list: [index, false], '__proto__': null }).replace('"blank":', '"__proto__":')));
    const value = root ? { 'a/b~': rows } : rows;
    assert.deepEqual(expand(representation({ kind: 'json', value })), value);
  }
  assert.equal({}.polluted, undefined);
});

test('application data that resembles a column representation remains ordinary JSON', async () => {
  const original = { format: 'aab.response-columns/v1', data: 'application-owned', tables: {} };
  const reply = await fixture().run(original);
  assert.equal(reply.value.encoding, 'json');
  assert.deepEqual(require('../scripts/validation/response-delta-consumer').decode(reply.value).value, original);
});
