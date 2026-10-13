'use strict';

const { object, text, validateValue } = require('../shared-kernel/argument-schema');
const { scriptError } = require('./script-errors');

const recoverySchema = {
  ...object({ checkpoint: object({ name: text, state: {} }, ['name', 'state']), reason: text }, ['checkpoint']),
  description: 'Explicit Agent recovery for a stopped checkpoint-enabled Script. Persist this new ctx.resume() state before restarting the frozen program. Old receipts and unknown outcomes remain unchanged; the Agent chooses how the program queries or continues them.',
};

function planRecovery({ base, previous, actionSequence, recovery }) {
  try { validateValue(recovery, recoverySchema, 'recovery'); }
  catch (error) { return scriptError(error.code || 'invalid_argument', { field: error.field, message: error.message }); }
  if (base.policy?.restartPolicy !== 'checkpoint' || previous.status === 'completed') {
    return scriptError('not_resumable', { operationId: base.operationId, status: previous.status,
      message: 'Recovery needs a stopped checkpoint-enabled program. Start a new Script to continue a completed or non-checkpoint program.' });
  }
  const decision = JSON.parse(JSON.stringify(recovery));
  return { ok: true, checkpoint: {
    ...base,
    revision: previous.revision + 1,
    stepId: decision.checkpoint.name,
    checkpoint: decision.checkpoint,
    actionSequence,
    checkpointActionSequence: actionSequence,
    recovery: { previousCheckpoint: previous.checkpoint?.name || null, previousStatus: previous.status,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }) },
  } };
}

function recoveryRequired(checkpoint, records, pauseReason) {
  const operationId = checkpoint.operationId;
  const actions = new Map();
  for (const row of records) {
    if (row.actionSequence <= (checkpoint.checkpointActionSequence || 0)) continue;
    if (row.kind === 'dispatch-marker' && row.state === 'prepared') {
      actions.set(row.actionId, { actionId: row.actionId, actionSequence: row.actionSequence, dispatched: null, ambiguous: true });
    } else if (row.kind === 'action-receipt') {
      actions.set(row.actionId, { actionId: row.actionId, actionSequence: row.actionSequence,
        dispatched: row.dispatched, ambiguous: row.ambiguous });
    }
  }
  return scriptError('ambiguous', { operationId, status: 'ambiguous', pauseReason,
    message: 'Actions followed the saved checkpoint. Inspect their results, then resume with recovery.checkpoint naming the state to continue; old effects are not replayed automatically.',
    recoveryCheckpoint: checkpoint.checkpoint || null,
    actions: [...actions.values()].slice(-8),
    guidance: { summary: 'Choose a recovery state that queries or continues the existing effects. Original receipts remain unchanged.',
      nextActions: [{ command: 'script', arguments: { operation: 'status', operationId, limit: 20, eventLimit: 1 } }] },
  });
}

module.exports = { recoverySchema, planRecovery, recoveryRequired };
