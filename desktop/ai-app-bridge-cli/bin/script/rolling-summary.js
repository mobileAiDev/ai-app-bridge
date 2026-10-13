'use strict';

function createRollingSummary({ operationId, startedAtMs }) {
  const assertions = { passed: 0, failed: 0, inconclusive: 0 };
  const assertionScopes = {
    code: { passed: 0, failed: 0, inconclusive: 0 },
    device: { passed: 0, failed: 0, inconclusive: 0 },
  };
  let status = 'running';
  let stage = null;
  let message = null;
  let currentCall = null;
  let completedCalls = 0;
  let lastCheckpoint = null;
  let lastEventAtMs = startedAtMs;
  let lastKind = null;
  let latestEvidenceRefs = [];
  const agentRequests = new Map();
  let paused = false;
  let accountedAtMs = startedAtMs;
  let activeMs = 0;
  let decisionWaitMs = 0;
  let terminalAtMs = null;

  function apply(event) {
    if (event.kind === 'heartbeat') {
      return snapshot(event.timestampMs);
    }
    // Charge the interval to the state that held before this event. Explicit
    // pause and Agent wait can overlap; their union is excluded from active time.
    if (terminalAtMs === null) {
      const durationMs = event.timestampMs - accountedAtMs;
      if (!paused && agentRequests.size === 0) activeMs += durationMs;
      if (agentRequests.size > 0) decisionWaitMs += durationMs;
    }
    accountedAtMs = event.timestampMs;
    lastEventAtMs = event.timestampMs;
    lastKind = event.kind;
    if (event.evidenceRefs !== undefined) {
      latestEvidenceRefs = event.evidenceRefs;
    }
    if (event.kind === 'call_started') {
      currentCall = event.command;
    }
    if (event.kind === 'call_completed' || event.kind === 'call_failed') {
      completedCalls += 1;
      currentCall = null;
    }
    if (event.kind === 'assertion_passed') {
      assertions.passed += 1;
    }
    if (event.kind === 'assertion_failed') {
      assertions.failed += 1;
    }
    if (event.kind === 'assertion_inconclusive') {
      assertions.inconclusive += 1;
    }
    if (event.kind.startsWith('assertion_')) {
      const verdict = event.kind.slice('assertion_'.length);
      const scope = event.scope || 'device';
      if (assertionScopes[scope] && Object.hasOwn(assertionScopes[scope], verdict)) assertionScopes[scope][verdict] += 1;
    }
    if (event.kind === 'checkpoint_committed') {
      lastCheckpoint = event.name;
    }
    if (event.kind === 'progress') {
      stage = event.stage;
      message = event.message;
    }
    if (event.kind === 'agent_question_created') {
      agentRequests.set(event.requestId, event.request);
      if (!paused) status = 'waiting_for_agent';
    }
    if (event.kind === 'agent_decision') {
      agentRequests.delete(event.requestId);
      if (!paused) status = agentRequests.size === 0 ? 'running' : 'waiting_for_agent';
    }
    if (event.kind === 'paused') {
      status = 'paused';
      paused = true;
    }
    if (event.kind === 'resumed') {
      status = agentRequests.size === 0 ? 'running' : 'waiting_for_agent';
      paused = false;
      terminalAtMs = null;
    }
    if (event.kind === 'script_completed') {
      status = 'completed';
    }
    if (event.kind === 'script_failed') {
      status = 'failed';
    }
    if (event.kind === 'script_cancelled') {
      status = 'cancelled';
    }
    if (event.kind === 'script_ambiguous') {
      status = 'ambiguous';
    }
    if (['script_completed', 'script_failed', 'script_cancelled', 'script_ambiguous'].includes(event.kind)
      && terminalAtMs === null) {
      terminalAtMs = event.timestampMs;
      paused = false;
      agentRequests.clear();
    }
    return snapshot(event.timestampMs);
  }

  function snapshot(nowMs) {
    const endAtMs = terminalAtMs ?? nowMs;
    const liveMs = terminalAtMs === null ? endAtMs - accountedAtMs : 0;
    const agentRequest = agentRequests.size === 0 ? null : [...agentRequests.values()].at(-1);
    return {
      operationId,
      status,
      stage,
      message,
      currentCall,
      completedCalls,
      assertions: {
        passed: assertions.passed,
        failed: assertions.failed,
        inconclusive: assertions.inconclusive,
      },
      assertionScopes: { code: { ...assertionScopes.code }, device: { ...assertionScopes.device } },
      lastCheckpoint,
      startedAtMs,
      elapsedMs: endAtMs - startedAtMs,
      activeMs: activeMs + (!paused && agentRequests.size === 0 ? liveMs : 0),
      decisionWaitMs: decisionWaitMs + (agentRequests.size === 0 ? 0 : liveMs),
      latestEvidenceRefs,
      agentRequest,
    };
  }

  function heartbeat(nowMs, childHealth) {
    return {
      kind: 'heartbeat',
      timestampMs: nowMs,
      elapsedMs: (terminalAtMs ?? nowMs) - startedAtMs,
      lastEventAtMs,
      lastKind,
      childHealth,
    };
  }

  return { apply, snapshot, heartbeat };
}

module.exports = { createRollingSummary };
