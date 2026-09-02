'use strict';

function createScriptRuntime({ operationId, script, now = Date.now } = {}) {
  const events = [];
  let sequence = 0;
  const state = {
    operationId,
    status: 'created',
    pauseReason: null,
    stepIndex: 0,
    completedStepIds: [],
    failedStepId: null,
    error: null,
    hash: script?.hash || null,
  };

  function emit(type, extra = {}) {
    sequence += 1;
    const event = { sequence, type, atMs: now(), status: state.status, ...extra };
    events.push(event);
    return event;
  }

  function snapshot({ afterSequence = 0, eventLimit = null } = {}) {
    const after = Number(afterSequence) || 0;
    let selected = events.filter((event) => event.sequence > after);
    if (eventLimit != null) selected = selected.slice(0, Number(eventLimit));
    return {
      command: 'script',
      operationId,
      status: state.status,
      pauseReason: state.pauseReason,
      stepIndex: state.stepIndex,
      completedStepIds: state.completedStepIds.slice(),
      failedStepId: state.failedStepId,
      error: state.error,
      eventSequence: sequence,
      events: selected,
    };
  }

  return { state, emit, snapshot, events };
}

module.exports = { createScriptRuntime };
