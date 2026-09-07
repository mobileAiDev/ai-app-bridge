'use strict';

function createScriptAgentPort() {
  const pending = [];

  function askAgent(request) {
    const queued = {
      requestId: (request && request.requestId) || `ask-${pending.length + 1}`,
      request,
      answered: false,
    };
    pending.push(queued);
    return new Promise((resolve) => {
      queued.resolve = resolve;
    });
  }

  function decide(requestId, decision) {
    const open = pending.find((entry) => entry.requestId === requestId && entry.answered === false);
    if (open) {
      open.answered = true;
      open.decision = decision;
      if (open.resolve) open.resolve(decision);
      return { ok: true, requestId, decision };
    }
    const answered = pending.find((entry) => entry.requestId === requestId && entry.answered === true);
    if (answered) {
      return { ok: true, requestId, decision: answered.decision };
    }
    return { ok: false, error: 'unknown_or_duplicate_decide', requestId };
  }

  return {
    askAgent,
    decide,
    pending: () => pending.filter((item) => item.answered === false),
  };
}

module.exports = { createScriptAgentPort };
