'use strict';

const bytes = value => Buffer.byteLength(JSON.stringify(value));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyPath = key => String(key).replaceAll('~', '~0').replaceAll('/', '~1');

// A complete, readable JSON representation for repetitive records. Common leaf
// paths become columns; heterogeneous rows retain their other leaves explicitly.
// Missing fields, nulls, empty containers, order and duplicates remain distinct.
function tableView(value, originalBytes, source, { homogeneousOnly = false } = {}) {
  const tables = [];
  function leaves(item, path = '', depth = 0) {
    if (record(item) && Object.keys(item).length && depth < 12) {
      return Object.keys(item).sort().flatMap(key => leaves(item[key], `${path}/${keyPath(key)}`, depth + 1));
    }
    return [[path, item]];
  }
  function visit(item, path, depth) {
    if (depth > 12) return item;
    if (Array.isArray(item) && item.length >= 3 && item.every(record)) {
      const rows = item.map(row => leaves(row));
      const values = rows.map(row => new Map(row));
      const paths = rows[0].map(([key]) => key).filter(key => values.every(row => row.has(key)));
      if (paths.length && (!homogeneousOnly || rows.every(row => row.length === paths.length))) {
        const constants = [], variable = [];
        for (let i = 0; i < paths.length; i++) {
          const key = paths[i], value = values[0].get(key), encoded = JSON.stringify(value);
          if (values.every(row => JSON.stringify(row.get(key)) === encoded)) constants.push([key, value]);
          else variable.push(key);
        }
        const common = new Set(paths);
        const sparse = new Map();
        rows.forEach((row, index) => row.forEach(([key, value]) => {
          if (common.has(key)) return;
          if (!sparse.has(key)) sparse.set(key, []);
          sparse.get(key).push([index, value]);
        }));
        const table = { path, constants: Object.fromEntries(constants), columns: variable,
          rows: values.map(row => variable.map(key => row.get(key))),
          ...(sparse.size ? { sparseColumns: Object.fromEntries(sparse) } : {}) };
        if (bytes(table) < bytes(item)) { tables.push(table); return null; }
      }
    }
    if (Array.isArray(item)) return item.map((child, index) => visit(child, `${path}/${index}`, depth + 1));
    if (record(item)) return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, `${path}/${keyPath(key)}`, depth + 1)]));
    return item;
  }
  const data = visit(value, '', 0);
  const heterogeneous = tables.some(table => table.sparseColumns);
  const view = { format: heterogeneous ? 'aab.response-tables/v3' : 'aab.response-tables/v1', originalKind: 'json', originalBytes, partial: false,
    note: 'Complete response. At each table.path, replace the null placeholder with its rows as objects: set the JSON Pointer leaf paths from constants, then columns using the corresponding row cells. '
      + (heterogeneous ? 'Then for each sparseColumns path, set that leaf only in the listed [rowIndex,value] pairs; absent leaves remain absent. ' : '')
      + 'Row order and duplicates are preserved. Capture coverage is unchanged.',
    data, tables };
  const shared = shareTexts(view);
  if (!shared && !tables.length) return null;
  const result = shared || view;
  if (source.ref) result.read = { command: 'response', arguments: { operation: 'read', ref: source.ref },
    extract: { mode: 'select', path: tables[0]?.path ?? result.sharedTexts[0].paths[0].slice('/data'.length), offset: 0, limit: 1 } };
  return result;
}

// Nested workflows often repeat the same window/package diagnostic in several
// envelopes. Keep each distinct long text once, with explicit replacement paths;
// no source field disappears and no follow-up read is needed to recover it.
function shareTexts(view) {
  const texts = new Map();
  function scan(item, pointer, depth = 0) {
    if (typeof item === 'string' && item.length >= 256 && bytes(item) >= 512) {
      if (!texts.has(item)) texts.set(item, []);
      texts.get(item).push(pointer);
    } else if (item && typeof item === 'object' && depth < 64) {
      for (const [key, child] of Object.entries(item)) scan(child, `${pointer}/${keyPath(key)}`, depth + 1);
    }
  }
  scan(view.data, '/data'); scan(view.tables, '/tables');
  const sharedTexts = [...texts].filter(([text, paths]) => paths.length > 1
    && bytes({ text, paths }) + paths.length * 4 < bytes(text) * paths.length).map(([text, paths]) => ({ text, paths }));
  if (!sharedTexts.length) return null;
  const result = structuredClone(view);
  for (const { paths } of sharedTexts) for (const pointer of paths) {
    const parts = pointer.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'));
    let parent = result;
    for (const key of parts.slice(0, -1)) parent = parent[key];
    Object.defineProperty(parent, parts.at(-1), { value: null, enumerable: true, writable: true, configurable: true });
  }
  result.format = view.format === 'aab.response-tables/v3' ? view.format : 'aab.response-tables/v2';
  result.note = 'Complete response. First restore every sharedTexts text at its paths (JSON Pointers into this entire representation, under /data or /tables), replacing null placeholders. Then expand tables as follows. ' + view.note;
  result.sharedTexts = sharedTexts;
  return bytes(result) < bytes(view) ? result : null;
}

module.exports = { tableView };
