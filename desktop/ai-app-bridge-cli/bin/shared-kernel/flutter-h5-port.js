'use strict';

const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { executionSleep } = require('./execution-scope');
const { validateValue } = require('./argument-schema');
const h5 = require('./flutter-h5-target');
const reject = error => ({ ok: false, error, dispatched: false, ambiguous: false });

// The same managed Flutter action port owns admission, receipts and cancellation.
// No arbitrary JavaScript or active-adapter lookup is used by typed commands.
function createFlutterH5Port(invoke, { actionId } = {}) {
  const mutate = payload => invoke(payload, { actionId });
  async function snapshot(adapterId) {
    const result = await invoke({ action: 'h5Dom', ...(adapterId === undefined ? {} : { adapterId }) }, { actionId: randomUUID() });
    if (result.ok !== true) return result;
    if (result.h5TargetSchema !== h5.schema) return reject('flutter_h5_target_schema_required');
    try { validateValue(result.pageRef, h5.pageSchema, 'pageRef'); }
    catch { return reject('invalid_flutter_h5_page_ref'); }
    if (!Array.isArray(result.dom?.controls) || typeof result.dom.truncated !== 'boolean'
        || result.dom.documentId !== result.pageRef.documentId || result.dom.url !== result.pageRef.url) return reject('invalid_flutter_h5_snapshot');
    if (adapterId !== undefined && result.pageRef.adapterId !== adapterId) return reject('reobserve_required');
    return result;
  }
  async function control(operation, options) {
    const expected = options.expectedTarget?.pageRef ?? options.expectedPage;
    if (options.adapterId !== undefined && expected && options.adapterId !== expected.adapterId) return reject('flutter_h5_adapter_conflict');
    const tree = await snapshot(options.adapterId ?? expected?.adapterId);
    if (tree.ok !== true) return tree;
    if (operation === 'scrollBy') {
      if (expected !== undefined && !isDeepStrictEqual(expected, tree.pageRef)) return reject('reobserve_required');
      return mutate({ action: 'h5Control', operation, expectedPage: tree.pageRef,
        deltaX: options.deltaX, deltaY: options.deltaY });
    }
    const selected = h5.selectH5Node(tree, options.selector, options.expectedTarget);
    if (!selected.ok) return selected;
    return mutate({ action: 'h5Control', operation, expectedTarget: selected.targetRef,
      ...(operation === 'input' ? { text: options.text } : {}) });
  }
  async function wait(options) {
    const timeoutMs = options.timeoutMs ?? 5000, intervalMs = options.intervalMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    let page, selected;
    do {
      const tree = await snapshot(page?.adapterId ?? options.adapterId);
      if (tree.ok !== true) return tree;
      if (page && !isDeepStrictEqual(page, tree.pageRef)) return reject('reobserve_required');
      page = tree.pageRef;
      selected = h5.selectH5Node(tree, options.selector);
      if (selected.ok || selected.error !== 'flutter_h5_selector_not_found') return selected;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await executionSleep(Math.min(intervalMs, remaining));
    } while (Date.now() < deadline);
    return { ...reject('flutter_h5_wait_timeout'), timeoutMs, lastResult: selected };
  }
  return { snapshot, control, wait,
    evaluate: options => mutate({ action: 'h5Eval', script: options.script, expectedPage: options.expectedPage }) };
}
module.exports = { createFlutterH5Port };
