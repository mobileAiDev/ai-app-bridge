'use strict';

function createProgressProjector({ maxEvents = 256 } = {}) {
  const executions = new Map();

  function accept(fact) {
    if (!fact || typeof fact.executionId !== 'string' || fact.executionId.length === 0) {
      throw new TypeError('executionId');
    }
    let record = executions.get(fact.executionId);
    if (!record) {
      record = { sequence: 0, events: [], business: null };
      executions.set(fact.executionId, record);
    }
    record.sequence += 1;
    const stored = {
      schemaVersion: 'aab.execution-fact/v1',
      executionId: fact.executionId,
      sequence: record.sequence,
      revision: fact.revision,
      kind: fact.kind,
      target: fact.target,
      timestampMs: fact.timestampMs,
      actionId: fact.actionId,
      parentFactId: fact.parentFactId,
      payloadSummary: fact.payloadSummary,
      evidenceRefs: fact.evidenceRefs,
      timings: fact.timings,
    };
    record.events.push(stored);
    while (record.events.length > maxEvents) {
      record.events.shift();
    }
    if (fact.kind === 'progress') {
      record.business = stored;
    }
    return {
      lastSequence: record.sequence,
      lastKind: stored.kind,
      business: record.business,
    };
  }

  function read(executionId, afterSequence, limit) {
    const record = executions.get(executionId);
    if (!record) {
      return { items: [], lastSequence: 0, hasMore: false };
    }
    const start = afterSequence;
    const cap = limit;
    const items = record.events.filter((event) => event.sequence > start);
    const limited = items.length > cap ? items.slice(0, cap) : items;
    return {
      items: limited,
      lastSequence: record.sequence,
      hasMore: items.length > limited.length,
    };
  }

  return { accept, read };
}

module.exports = { createProgressProjector };
