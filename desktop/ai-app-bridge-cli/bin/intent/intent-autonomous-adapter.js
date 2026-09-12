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
      return decide(input);
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
    check({ steps = 0, agentCalls = 0, action = null, atMs = now(), phase = 'agent' } = {}) {
      if ((phase === 'agent' || action) && steps >= maxSteps) return { ok: false, reason: 'max_steps' };
      if (atMs - started >= maxDurationMs) return { ok: false, reason: 'max_duration' };
      if (phase === 'agent' ? agentCalls >= maxAgentCalls : agentCalls > maxAgentCalls) return { ok: false, reason: 'max_agent_calls' };
      if (action && !allowlist.includes(action.action)) {
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
