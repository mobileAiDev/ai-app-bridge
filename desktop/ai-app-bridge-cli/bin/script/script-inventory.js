'use strict';

const { object, text, integer, validateValue } = require('../shared-kernel/argument-schema');
const { verifyChecksum } = require('../shared-kernel/evidence-schema');
const { scriptError } = require('./script-errors');

const inventorySchema = object({ cursor: text, limit: integer(1, 100), view: { enum: ['attention', 'all'], default: 'attention' } });

function readScriptInventory({ store, registry, ...options }) {
  try {
    validateValue(options, inventorySchema, 'inventory');
    if (!store) return scriptError('recovery_store_unavailable');
    const records = store.list();
    const view = options.view || 'attention';
    let cursor;
    if (options.cursor) {
      try {
        cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
        if (cursor.v !== 1 || cursor.view !== view || typeof cursor.throughId !== 'string' || typeof cursor.after !== 'string') throw new Error('scope');
      } catch { return scriptError('invalid_inventory_cursor'); }
    }
    const throughId = cursor?.throughId || records.at(-1)?.evidenceId || null;
    const throughIndex = throughId ? records.findIndex(row => row.evidenceId === throughId) : -1;
    if (cursor && throughIndex < 0) return scriptError('inventory_cursor_expired', {
      message: 'The retained boundary has expired. Start a new inventory query; no operation is resumed or replayed.' });
    const byOperation = new Map();
    for (const row of records.slice(0, throughIndex + 1)) {
      if (typeof row.operationId !== 'string') continue;
      if (!byOperation.has(row.operationId)) byOperation.set(row.operationId, []);
      byOperation.get(row.operationId).push(row);
    }
    // Live ownership is deliberately separate from the frozen durable page.
    // A running checkpoint with no local runtime is not proof of process death.
    const rows = [...byOperation].map(([operationId, facts]) => summarize(operationId, facts, registry?.get(operationId)));
    rows.sort((a, b) => a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0);
    const matching = rows.filter(row => (view === 'all' || row.needsInspection) && (!cursor || row.operationId > cursor.after));
    const items = matching.slice(0, options.limit || 20), hasMore = items.length < matching.length;
    return { ok: true, command: 'script', readOnly: true, view, throughId, items, hasMore,
      cursor: hasMore ? Buffer.from(JSON.stringify({ v: 1, view, throughId, after: items.at(-1).operationId })).toString('base64url') : null,
      coverage: { scope: 'retained-script-evidence', completeHistory: false,
        meaning: 'Operations absent from retained evidence are not proved absent. Live state is sampled now; durable summaries are pinned to throughId. A missing local runtime requires inspection, not automatic replay.' } };
  } catch (error) { return scriptError(error.code || 'inventory_read_failed', { field: error.field, message: error.message }); }
}

function summarize(operationId, facts, live) {
  const corrupt = facts.find(row => !verifyChecksum(row).ok);
  if (corrupt) return { operationId, needsInspection: true, error: 'checksum_mismatch', evidenceId: corrupt.evidenceId,
    nextAction: { command: 'script', arguments: { operation: 'status', operationId } } };
  const checkpoint = facts.filter(row => row.kind === 'checkpoint').at(-1);
  const receipts = new Map(facts.filter(row => row.kind === 'action-receipt').map(row => [row.actionId, row]));
  const markers = new Map(facts.filter(row => row.kind === 'dispatch-marker').map(row => [row.actionId, row]));
  // Retention can remove a marker before its later receipt. An unknown receipt
  // still requires inspection even when the program itself completed.
  const actions = new Map([...receipts, ...markers]);
  const unsettled = [...actions.values()].filter(row => {
    const receipt = receipts.get(row.actionId);
    return !receipt || receipt.ambiguous === true || receipt.dispatched == null;
  }).map(row => ({ actionId: row.actionId, command: row.command || null, label: row.label || null,
    receiptRef: receipts.get(row.actionId)?.evidenceId || null,
    ...(!markers.has(row.actionId) ? { markerMissing: true } : {}) }));
  const durableStatus = checkpoint?.status || 'unknown';
  const liveStatus = live?.status || null;
  // Selection uses only frozen durable facts, so live progress cannot move an
  // operation in or out of a continuation page. Running work may appear here.
  const needsInspection = Boolean(unsettled.length || durableStatus !== 'completed');
  return { operationId, name: checkpoint?.name || null, target: checkpoint?.target || null,
    durableStatus, liveStatus, needsInspection, checkpointId: checkpoint?.evidenceId || null,
    lastEvidenceId: facts.at(-1).evidenceId, unsettled: unsettled.slice(0, 3), unsettledCount: unsettled.length,
    omittedUnsettled: Math.max(0, unsettled.length - 3),
    nextAction: { command: 'script', arguments: { operation: unsettled.length ? 'recovery' : 'status', operationId } } };
}

module.exports = { readScriptInventory, inventorySchema };
