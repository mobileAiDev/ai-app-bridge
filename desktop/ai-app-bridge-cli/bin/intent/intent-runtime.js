'use strict';

function createIntentRuntime({ operationId, now = Date.now } = {}) {
  const events = [];
  let sequence = 0;
  const state = {
    operationId,
    status: 'created',
    revision: 1,
    error: null,
    lastDecisionId: null,
    seenDecisionIds: new Set(),
    mode: 'supervised',
  };

  function emit(type, extra = {}) {
    sequence += 1;
    const event = { sequence, type, atMs: now(), status: state.status, ...extra };
    events.push(event);
    return event;
  }

  function snapshot() {
    return {
      command: 'intent',
      operationId,
      status: state.status,
      revision: state.revision,
      error: state.error,
      lastDecisionId: state.lastDecisionId,
      mode: state.mode,
      eventSequence: sequence,
      events: events.slice(),
    };
  }

  return { state, emit, snapshot, events };
}

module.exports = { createIntentRuntime };
