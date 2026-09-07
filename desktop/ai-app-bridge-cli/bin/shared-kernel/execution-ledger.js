'use strict';

function createExecutionLedger({ maxEvents = 256, maxExecutions = 256 } = {}) {
  const executions = new Map();
  const tombstones = new Map();

  function evictOldest() {
    const oldest = executions.keys().next().value;
    if (oldest === undefined) return;
    const bucket = executions.get(oldest);
    tombstones.set(oldest, {
      lastSequence: bucket.sequence,
      lastFact: bucket.events[bucket.events.length - 1] || null,
      gap: true,
    });
    executions.delete(oldest);
    while (tombstones.size > maxExecutions) {
      tombstones.delete(tombstones.keys().next().value);
    }
  }

  function record(fact) {
    if (!fact || typeof fact.executionId !== 'string' || fact.executionId.length === 0) {
      throw new TypeError('executionId');
    }
    let bucket = executions.get(fact.executionId);
    if (!bucket) {
      const prior = tombstones.get(fact.executionId);
      while (executions.size >= maxExecutions) {
        evictOldest();
      }
      tombstones.delete(fact.executionId);
      bucket = {
        sequence: prior ? prior.lastSequence : 0,
        events: [],
        latestByKind: new Map(),
        gap: prior ? true : false,
      };
      executions.set(fact.executionId, bucket);
    }
    bucket.sequence = Number.isInteger(fact.sequence) ? fact.sequence : bucket.sequence + 1;
    const stored = {
      schemaVersion: 'aab.execution-fact/v1',
      executionId: fact.executionId,
      sequence: bucket.sequence,
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
    bucket.events.push(stored);
    while (bucket.events.length > maxEvents) {
      bucket.events.shift();
      bucket.gap = true;
    }
    bucket.latestByKind.set(fact.kind, stored);
    return {
      ok: true,
      executionId: fact.executionId,
      sequence: bucket.sequence,
      kind: fact.kind,
    };
  }

  function snapshot(executionId) {
    const bucket = executions.get(executionId);
    if (bucket) {
      return {
        executionId,
        lastSequence: bucket.sequence,
        lastFact: bucket.events[bucket.events.length - 1],
        gap: bucket.gap === true,
      };
    }
    const tomb = tombstones.get(executionId);
    if (tomb) {
      return {
        executionId,
        lastSequence: tomb.lastSequence,
        lastFact: tomb.lastFact,
        gap: true,
      };
    }
    return { executionId, lastSequence: 0, lastFact: null };
  }

  function query(executionId, afterSequence, limit) {
    const bucket = executions.get(executionId);
    if (!bucket) {
      const tomb = tombstones.get(executionId);
      if (tomb) {
        return { items: [], lastSequence: tomb.lastSequence, hasMore: false, gap: true };
      }
      return { items: [], lastSequence: 0, hasMore: false, gap: false };
    }
    const items = bucket.events.filter((event) => event.sequence > afterSequence);
    const limited = items.length > limit ? items.slice(0, limit) : items;
    return {
      items: limited,
      lastSequence: limited.length > 0
        ? limited[limited.length - 1].sequence
        : (items.length > 0 ? afterSequence : bucket.sequence),
      hasMore: items.length > limited.length,
      gap: bucket.gap === true,
    };
  }

  function latest(executionId, kind) {
    const bucket = executions.get(executionId);
    if (!bucket) {
      return null;
    }
    const found = bucket.latestByKind.get(kind);
    return found === undefined ? null : found;
  }

  return { record, snapshot, query, latest };
}

module.exports = { createExecutionLedger };
