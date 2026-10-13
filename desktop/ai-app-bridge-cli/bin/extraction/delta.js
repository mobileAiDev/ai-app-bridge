'use strict';

const { checksumOf } = require('../shared-kernel/evidence-schema');
const { tableView } = require('./tables');
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const escape = key => String(key).replaceAll('~', '~0').replaceAll('/', '~1');

// Both sides use the same complete representation. In UIA this keeps the
// snapshot id once, while retaining every fresh node reference in the rows.
function representation(snapshot) {
  const value = snapshot.value, size = bytes(value);
  // columns/v1 has no sparse-field encoding. Keep its original homogeneous
  // strategy, so optional fields elsewhere cannot disable existing columns.
  const table = snapshot.kind === 'json' ? tableView(value, size, {}, { homogeneousOnly: true }) : null;
  if (!table || table.format !== 'aab.response-tables/v1') return value;
  // Key columns by their paths instead of numeric positions. If one checkbox
  // changes from a shared constant to a variable, other columns do not shift.
  const columns = { format: 'aab.response-columns/v1', data: table.data,
    tables: Object.fromEntries(table.tables.map(t => [t.path, { rowCount: t.rows.length, constants: t.constants,
      columns: Object.fromEntries(t.columns.map((name, i) => [name, t.rows.map(row => row[i])])) }])) };
  return bytes(columns) < size * 0.7 ? columns : value;
}

// RFC 6902. Array removals run backwards so later indices remain meaningful.
// Prefer replacing a changed branch when its patch would be more expensive.
function difference(before, after) {
  let visited = 0;
  function visit(a, b, path, depth) {
    if (a === b) return [];
    const replacement = [{ op: 'replace', path, value: b }];
    if (++visited > 100000 || depth > 64) return replacement;
    let changes = [];
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.min(a.length, b.length); i++) changes.push(...visit(a[i], b[i], `${path}/${i}`, depth + 1));
      for (let i = a.length - 1; i >= b.length; i--) changes.push({ op: 'remove', path: `${path}/${i}` });
      for (let i = a.length; i < b.length; i++) changes.push({ op: 'add', path: `${path}/${i}`, value: b[i] });
    } else if (record(a) && record(b)) {
      for (const key of Object.keys(a)) if (!Object.hasOwn(b, key)) changes.push({ op: 'remove', path: `${path}/${escape(key)}` });
      for (const key of Object.keys(b)) {
        const pointer = `${path}/${escape(key)}`;
        changes.push(...(Object.hasOwn(a, key) ? visit(a[key], b[key], pointer, depth + 1) : [{ op: 'add', path: pointer, value: b[key] }]));
      }
    } else return replacement;
    return bytes(changes) < bytes(replacement) ? changes : replacement;
  }
  return visit(before, after, '', 0);
}

function deltaView(current, base, ref, unavailable) {
  const data = representation(current), sha256 = checksumOf(data);
  const encoding = data === current.value ? 'json' : 'columns';
  const full = reason => ({ format: 'aab.response-delta/v1', originalKind: current.kind, encoding, mode: 'full', reason, sha256, data });
  if (!ref) return full('initial');
  if (!base) return { ...full('base_unavailable'), detail: unavailable || 'response_not_found' };
  if (current.identity.command !== base.identity.command || current.kind !== base.kind) return full('base_kind_or_command_changed');
  const previous = representation(base);
  const patch = { format: 'aab.response-delta/v1', originalKind: current.kind, encoding, mode: 'patch', base: ref,
    baseSha256: checksumOf(previous), sha256, operations: difference(previous, data) };
  const complete = full('patch_not_smaller');
  return bytes(patch) < bytes(complete) ? patch : complete;
}

module.exports = { deltaView, representation, difference };
