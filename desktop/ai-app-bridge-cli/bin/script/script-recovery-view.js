'use strict';

const { object, text, integer, validateValue } = require('../shared-kernel/argument-schema');
const { verifyChecksum } = require('../shared-kernel/evidence-schema');
const { scriptError } = require('./script-errors');

const recoveryReadSchema = object({ checkpointId: text, cursor: text, limit: integer(1, 100) });

// A fact view never dispatches, cancels, or infers a business outcome. Pagination
// pins the original checkpoint and last retained fact, not a moving live tail.
function readScriptRecovery(args) {
  try { return recoveryView(args); }
  catch (error) { return scriptError(error.code || 'recovery_read_failed', { operationId: args.operationId, message: error.message }); }
}

function recoveryView({ store, operationId, ...options }) {
  try { validateValue(options, recoveryReadSchema, 'recovery'); }
  catch (error) { return scriptError(error.code || 'invalid_argument', { field: error.field, message: error.message }); }
  if (!store) return scriptError('recovery_store_unavailable', { operationId });
  const records = store.list(operationId);
  if (!records.length) return scriptError('unknown_operation', { operationId });
  if (records.some(row => row.operationId !== operationId || !verifyChecksum(row).ok))
    return scriptError('checksum_mismatch', { operationId });

  let page;
  if (options.cursor) {
    try {
      page = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
      if (page.v !== 1 || page.operationId !== operationId || typeof page.checkpointId !== 'string'
          || typeof page.throughId !== 'string' || !Number.isSafeInteger(page.after) || page.after < 0
          || options.checkpointId && options.checkpointId !== page.checkpointId) throw new Error('scope');
    } catch { return scriptError('invalid_recovery_cursor', { operationId }); }
  }
  const latest = records.filter(row => row.kind === 'checkpoint').at(-1);
  let checkpointId = page?.checkpointId || options.checkpointId || latest?.evidenceId;
  if (!page && !options.checkpointId) {
    const visited = new Set();
    let boundary = latest;
    while (boundary?.recovery?.previousCheckpointId) {
      if (visited.has(checkpointId)) return scriptError('recovery_identity_conflict', { operationId, checkpointId });
      visited.add(checkpointId);
      checkpointId = boundary.recovery.previousCheckpointId;
      boundary = records.find(row => row.kind === 'checkpoint' && row.evidenceId === checkpointId);
    }
  }
  const checkpoint = records.find(row => row.kind === 'checkpoint' && row.evidenceId === checkpointId);
  if (!checkpoint) return scriptError('recovery_checkpoint_unavailable', { operationId, checkpointId: checkpointId || null,
    message: 'The requested checkpoint is no longer retained. Read Script status or select a retained checkpoint; missing evidence is not proof that an action did not run.' });
  const throughId = page?.throughId || records.at(-1).evidenceId;
  const throughIndex = records.findIndex(row => row.evidenceId === throughId);
  if (throughIndex < 0) return scriptError('recovery_cursor_expired', { operationId,
    message: 'The recovery page boundary is no longer retained. Start a new recovery query; original effects are not replayed.' });
  const retained = records.slice(0, throughIndex + 1);
  const boundary = checkpoint.checkpointActionSequence || 0;
  const high = retained.reduce((value, row) => Math.max(value, row.actionSequence || 0), boundary);
  const actions = new Map();
  for (const row of retained) {
    if (!['dispatch-marker', 'action-receipt'].includes(row.kind) || row.actionSequence <= boundary) continue;
    let action = actions.get(row.actionSequence);
    if (!action) { action = { actionId: row.actionId, actionSequence: row.actionSequence, marker: null, receipt: null }; actions.set(row.actionSequence, action); }
    if (action.actionId !== row.actionId) return scriptError('recovery_identity_conflict', { operationId, actionSequence: row.actionSequence });
    action[row.kind === 'dispatch-marker' ? 'marker' : 'receipt'] = row;
  }
  const ordered = [...actions.values()].sort((a, b) => a.actionSequence - b.actionSequence);
  const gaps = [];
  let next = boundary + 1;
  for (const action of ordered) {
    if (action.actionSequence > next) gaps.push({ fromActionSequence: next, throughActionSequence: action.actionSequence - 1 });
    next = action.actionSequence + 1;
  }
  if (next <= high) gaps.push({ fromActionSequence: next, throughActionSequence: high });
  const after = page?.after ?? boundary;
  if (after < boundary || after > high) return scriptError('invalid_recovery_cursor', { operationId });
  const remaining = ordered.filter(action => action.actionSequence > after);
  const selected = remaining.slice(0, options.limit ?? 20);
  const hasMore = selected.length < remaining.length;
  const items = selected.map(({ actionId, actionSequence, marker, receipt }) => ({
    actionId, actionSequence,
    command: marker?.command ?? receipt?.command ?? null,
    label: marker?.label ?? receipt?.label ?? null,
    target: marker ? marker.target : receipt.target,
    markerRef: marker?.evidenceId ?? null,
    receiptRef: receipt?.evidenceId ?? null,
    dispatched: receipt?.dispatched ?? null,
    ambiguous: receipt ? receipt.ambiguous === true : true,
    error: receipt?.error ?? null,
    executionReceipt: receipt?.executionReceipt ?? null,
    ...(receipt?.executionReceipts ? { executionReceipts: receipt.executionReceipts } : {}),
  }));
  return { ok: true, command: 'script', operationId, readOnly: true,
    checkpoint: { evidenceId: checkpoint.evidenceId, revision: checkpoint.revision,
      state: checkpoint.checkpoint ?? null, actionSequence: boundary },
    through: { evidenceId: throughId, actionSequence: high }, items, hasMore,
    cursor: hasMore ? Buffer.from(JSON.stringify({ v: 1, operationId, checkpointId, throughId,
      after: selected.at(-1).actionSequence })).toString('base64url') : null,
    coverage: { retainedActions: ordered.length, expectedActions: high - boundary, gaps,
      missingMarkers: ordered.filter(action => !action.marker).map(action => action.actionId),
      meaning: 'Retained Host facts only. A missing receipt or gap does not mean the effect was absent; query the original action or business state before deciding what to do next.' },
  };
}

module.exports = { readScriptRecovery, recoveryReadSchema };
