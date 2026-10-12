'use strict';

const PREVIEW_BYTES = 64 * 1024;
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));
const pointerKey = key => String(key).replaceAll('~', '~0').replaceAll('/', '~1');

function selectValue(value, { path, offset, limit }) {
  for (const key of path === '' ? [] : path.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key))
      return { ok: false, error: 'extraction_path_not_found', path };
    value = value[key];
  }
  if (offset !== undefined || limit !== undefined) {
    if (!Array.isArray(value) && typeof value !== 'string') return { ok: false, error: 'extraction_slice_type', path };
    const start = offset ?? 0;
    value = value.slice(start, limit === undefined ? undefined : start + limit);
  }
  return { ok: true, result: value };
}

// This is a labelled sample and structural index, never a business verdict or
// an assertion that omitted entries do not exist. The source ref keeps all data.
function overview(command, value, kind, originalBytes, source, maxBytes = PREVIEW_BYTES) {
  const fields = [];
  const collections = [];
  let indexBytes = 0;
  const describe = (item, path, depth) => {
    const type = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
    if (Buffer.byteLength(path) > 2000) return;
    if (type === 'array' || type === 'string') collections.push({ path, type, value: item, bytes: jsonBytes(item) });
    if (fields.length < 40 && indexBytes + Buffer.byteLength(path) < 2000) {
      indexBytes += Buffer.byteLength(path) + 60;
      fields.push({ path, type, ...(type === 'array' ? { count: item.length }
        : type === 'string' ? { characters: item.length } : type === 'object' ? { keys: Object.keys(item).length } : {}),
        ...(type !== 'object' && type !== 'array' && jsonBytes(item) <= 120 ? { value: item } : {}) });
    }
    if (depth > 0 && type === 'object') for (const [key, child] of Object.entries(item)) describe(child, `${path}/${pointerKey(key)}`, depth - 1);
    if (depth > 0 && type === 'array' && item.length) describe(item[0], `${path}/0`, depth - 1);
  };
  describe(value, '', 3);
  let page = collections.sort((a, b) => b.bytes - a.bytes)[0];
  const result = { format: 'aab.response-overview/v1', originalKind: kind, originalBytes, partial: true,
    note: 'Partial view of the saved response. Preview ranges retain source order and offsets; array entries are complete. Missing content is not evidence of absence. Read the same ref to inspect more, without repeating the command.',
    fields,
    read: { command: 'response', arguments: { operation: 'read', ref: source.ref },
      extract: page ? { mode: 'select', path: page.path, offset: 0, limit: 1 } : { mode: 'select', path: '' } },
  };
  if (!page) return result;
  // Reserve room for range metadata and the read hint. Spend the remaining
  // budget on actual data, rather than a fixed three-row / 160-character sample.
  const budget = Math.max(0, Math.min(PREVIEW_BYTES, maxBytes - jsonBytes(result) - 1024));
  let ranges = page.type === 'array' ? arrayRanges(page.value, budget) : textRanges(page.value, budget);
  if (page.type === 'array' && !ranges.length) {
    // One huge network body/log entry should expose its text and sibling scalar
    // facts now, instead of suggesting an over-budget read of the same row.
    const text = collections.find(item => item.type === 'string' && item.path.startsWith(`${page.path}/0/`));
    if (text) { page = text; ranges = textRanges(page.value, budget); result.read.extract.path = page.path; }
  }
  const firstEnd = ranges[0]?.offset === 0 ? ranges[0].end : 0;
  const nextEnd = ranges.find(range => range.offset > firstEnd)?.offset ?? page.value.length;
  result.preview = { path: page.path, type: page.type, total: page.value.length,
    offsetUnit: page.type === 'array' ? 'items' : 'utf16-code-units',
    returned: ranges.reduce((total, range) => total + range.end - range.offset, 0),
    ranges: ranges.map(({ end, ...range }) => range) };
  result.read.extract.offset = firstEnd < nextEnd ? firstEnd : 0;
  // A concrete next page is sized against this frozen source, including rows of
  // unequal size. It is not an invitation to repeat a device query with a limit.
  const next = page.type === 'array'
    ? arrayRange(page.value, result.read.extract.offset, nextEnd, budget)
    : textRange(page.value, result.read.extract.offset, nextEnd, budget);
  result.read.extract.limit = Math.max(1, next.end - next.offset);
  return result;
}

function arrayRange(items, start, end, budget, backwards = false) {
  let used = 2, index = backwards ? end : start;
  while (backwards ? index > start : index < end) {
    const bytes = jsonBytes(items[backwards ? index - 1 : index]) + 1;
    if (used + bytes > budget) break;
    used += bytes; index += backwards ? -1 : 1;
  }
  const offset = backwards ? index : start, through = backwards ? end : index;
  return { offset, end: through, items: items.slice(offset, through) };
}

function arrayRanges(items, budget) {
  const head = arrayRange(items, 0, items.length, Math.floor(budget / 2));
  const tail = arrayRange(items, head.end, items.length, budget - jsonBytes(head.items), true);
  return [head, tail].filter(range => range.end > range.offset);
}

function textRange(text, start, end, budget, backwards = false) {
  let low = 0, high = end - start;
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    const part = backwards ? text.slice(end - length, end) : text.slice(start, start + length);
    if (jsonBytes(part) <= budget) low = length; else high = length - 1;
  }
  let offset = backwards ? end - low : start, through = backwards ? end : start + low;
  // Never split a surrogate pair. Prefer whole lines when the range is partial.
  if (offset > start && /[\uDC00-\uDFFF]/u.test(text[offset] || '')) offset++;
  if (through < end && /[\uD800-\uDBFF]/u.test(text[through - 1] || '')) through--;
  if (backwards && offset > start) {
    const newline = text.indexOf('\n', offset);
    if (newline >= offset && newline < through - 1) offset = newline + 1;
  } else if (!backwards && through < end) {
    const newline = text.lastIndexOf('\n', through - 1);
    if (newline >= offset) through = newline + 1;
  }
  return { offset, end: through, text: text.slice(offset, through) };
}

function textRanges(text, budget) {
  const head = textRange(text, 0, text.length, Math.floor(budget / 2));
  const tail = textRange(text, head.end, text.length, budget - jsonBytes(head.text), true);
  return [head, tail].filter(range => range.end > range.offset);
}

module.exports = { overview, selectValue };
