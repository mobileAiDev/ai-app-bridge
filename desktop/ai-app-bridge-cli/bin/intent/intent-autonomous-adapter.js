'use strict';

function createAutonomousAgentAdapter({ decide } = {}) {
  if (typeof decide !== 'function') {
    throw new TypeError('AutonomousAgentAdapter requires a decide function from the Agent');
  }
  let calls = 0;
  return {
    get callCount() { return calls; },
    async decide(input) {
      calls += 1;
      const decision = await decide(input);
      if (!decision || typeof decision !== 'object') {
        throw new TypeError('Agent decide must return a decision object');
      }
      if (!decision.decisionId) {
        throw new TypeError('Agent decide must return decisionId');
      }
      return decision;
    },
  };
}

function createIntentBudget({
  maxSteps = 30,
  maxDurationMs = 120000,
  maxAgentCalls = 30,
  allowlist = ['tap'],
  startedAtMs,
  now = Date.now,
} = {}) {
  const started = startedAtMs != null ? startedAtMs : now();
  return {
    maxSteps,
    maxDurationMs,
    maxAgentCalls,
    allowlist,
    check({ steps = 0, agentCalls = 0, action = null, atMs = now() } = {}) {
      if (steps >= maxSteps) return { ok: false, reason: 'max_steps' };
      if (atMs - started >= maxDurationMs) return { ok: false, reason: 'max_duration' };
      if (agentCalls >= maxAgentCalls) return { ok: false, reason: 'max_agent_calls' };
      if (action && allowlist && !allowlist.includes(action.action || action.name)) {
        return { ok: false, reason: 'action_not_allowed' };
      }
      return { ok: true };
    },
  };
}

module.exports = {
  createAutonomousAgentAdapter,
  createIntentBudget,
};
