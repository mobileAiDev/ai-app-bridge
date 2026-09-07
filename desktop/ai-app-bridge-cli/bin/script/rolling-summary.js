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
  let agentRequest = null;
  let pausedAtMs = null;
  let pausedMs = 0;

  function apply(event) {
    if (event.kind === 'heartbeat') {
      return snapshot(event.timestampMs);
    }
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
      agentRequest = event.request;
    }
    if (event.kind === 'agent_decision') {
      agentRequest = null;
    }
    if (event.kind === 'paused') {
      status = 'paused';
      pausedAtMs = event.timestampMs;
    }
    if (event.kind === 'resumed') {
      status = 'running';
      if (pausedAtMs !== null) {
        pausedMs += event.timestampMs - pausedAtMs;
        pausedAtMs = null;
      }
      agentRequest = null;
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
    return snapshot(event.timestampMs);
  }

  function snapshot(nowMs) {
    const holdMs = pausedAtMs === null ? 0 : nowMs - pausedAtMs;
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
      elapsedMs: nowMs - startedAtMs,
      activeMs: nowMs - startedAtMs - pausedMs - holdMs,
      decisionWaitMs: agentRequest === null ? 0 : nowMs - lastEventAtMs,
      latestEvidenceRefs,
      agentRequest,
    };
  }

  function heartbeat(nowMs, childHealth) {
    return {
      kind: 'heartbeat',
      timestampMs: nowMs,
      elapsedMs: nowMs - startedAtMs,
      lastEventAtMs,
      lastKind,
      childHealth,
    };
  }

  return { apply, snapshot, heartbeat };
}

module.exports = { createRollingSummary };
