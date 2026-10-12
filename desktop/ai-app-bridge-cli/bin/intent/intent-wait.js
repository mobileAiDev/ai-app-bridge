'use strict';

const { currentExecution, executionFailure } = require('../shared-kernel/execution-scope');
const terminal = new Set(['completed', 'failed', 'cancelled', 'inconclusive', 'ambiguous', 'timeout', 'intervention_required', 'blocked_evidence_store']);

// Subscribe once instead of repeatedly observing the device or polling status.
// Cancelling a waiting caller stops this wait, not the independently owned task.
function wait(worker, args) {
  const after = args.afterEventSequence ?? 0, waitMs = args.waitMs ?? 30000;
  const scope = currentExecution();
  return new Promise((resolve, reject) => {
    let timer, unsubscribe, finished = false;
    const finish = (timedOut, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); unsubscribe?.(); scope?.signal.removeEventListener('abort', abort);
      if (error) { reject(error); return; }
      try {
        const result = worker.status(args);
        resolve({ ...result, events: result.events.filter(event => event.sequence > after), timedOut, waitMs });
      } catch (error) { reject(error); }
    };
    const abort = () => finish(false, executionFailure(scope));
    unsubscribe = worker.runtime.subscribe(() => finish(false));
    scope?.signal.addEventListener('abort', abort, { once: true });
    if (scope?.signal.aborted) { abort(); return; }
    const current = worker.runtime.snapshot();
    if (current.eventSequence > after || terminal.has(current.status)) { finish(false); return; }
    if (waitMs === 0) { finish(true); return; }
    timer = setTimeout(() => finish(true), waitMs);
  });
}

module.exports = { wait };
