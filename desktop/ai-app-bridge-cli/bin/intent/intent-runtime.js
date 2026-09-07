'use strict';

function createIntentRuntime({
  operationId,
  now = Date.now,
  maxEvents = 256,
  maxEventBytes = 256 * 1024,
} = {}) {
  const events = [];
  let sequence = 0;
  let eventBytes = 0;
  let droppedEvents = 0;
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
    const encoded = Buffer.byteLength(JSON.stringify(event), 'utf8');
    events.push({ event, encoded });
    eventBytes += encoded;
    while (events.length > maxEvents || eventBytes > maxEventBytes) {
      const removed = events.shift();
      if (!removed) break;
      eventBytes -= removed.encoded;
      droppedEvents += 1;
    }
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
      events: events.map((item) => item.event),
      eventGap: droppedEvents > 0,
      droppedEvents,
    };
  }

  return {
    state,
    emit,
    snapshot,
    get events() { return events.map((item) => item.event); },
    get eventBytes() { return eventBytes; },
  };
}

module.exports = { createIntentRuntime };
