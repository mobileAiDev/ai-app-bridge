'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const clone = value => structuredClone(value);
const parts = path => path.slice(1).split('/').map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'));
const define = (parent, key, value) => Object.defineProperty(parent, key, { value: clone(value), enumerable: true, writable: true, configurable: true });
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const checksum = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function decode(view, previous) {
  let data;
  if (view.mode === 'full') data = clone(view.data);
  else {
    assert.equal(checksum(previous), view.baseSha256, 'delta base hash');
    data = clone(previous);
    for (const { op, path, value } of view.operations) {
      if (path === '') { assert.equal(op, 'replace'); data = clone(value); continue; }
      const keys = parts(path), key = keys.pop(), parent = keys.reduce((v, k) => { assert(Object.hasOwn(v, k)); return v[k]; }, data);
      if (op !== 'add') assert(Object.hasOwn(parent, key));
      if (op === 'remove') { if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; }
      else if (op === 'add' && Array.isArray(parent)) parent.splice(Number(key), 0, clone(value));
      else { assert(op === 'replace' || op === 'add'); define(parent, key, value); }
    }
  }
  assert.equal(checksum(data), view.sha256, 'delta result hash');
  return { data, value: view.encoding === 'columns' ? expand(data) : data };
}
function expand(data) {
  if (data?.format !== 'aab.response-columns/v1') return data;
  const set = (root, pointer, value) => {
    if (pointer === '') return clone(value);
    const keys = parts(pointer); let parent = root;
    for (const key of keys.slice(0, -1)) { if (!Object.hasOwn(parent, key)) define(parent, key, {}); parent = parent[key]; }
    define(parent, keys.at(-1), value); return root;
  };
  let value = clone(data.data);
  for (const [path, table] of Object.entries(data.tables)) {
    const rows = Array.from({ length: table.rowCount }, (_, i) => {
      let row = {};
      for (const [pointer, cell] of Object.entries(table.constants)) row = set(row, pointer, cell);
      for (const [pointer, cells] of Object.entries(table.columns)) row = set(row, pointer, cells[i]);
      return row;
    });
    value = set(value, path, rows);
  }
  return value;
}
module.exports = { decode };
