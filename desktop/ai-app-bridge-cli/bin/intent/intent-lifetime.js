'use strict';

const { CommandError } = require('../command-errors');
const { runExecution } = require('../shared-kernel/execution-scope');

// An Intent owns work across multiple requests, including time spent idle.
// Draining waits for owned provider/persistence work; it never races that work
// against a timer and pretends it has settled.
function createIntentLifetime({ timeoutMs, onDeadline }) {
  if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)) {
    throw new CommandError('invalid_argument', 'Intent timeoutMs must be a positive integer in milliseconds.', { field: 'timeoutMs' });
  }
  const controller = new AbortController();
  const pending = new Set();
  let started = false;
  let timer;
  let deadlineMs = null;
  function start() {
    if (started) return;
    started = true;
    if (timeoutMs !== null) {
      deadlineMs = Date.now() + timeoutMs;
      timer = setTimeout(onDeadline, timeoutMs);
      timer.unref?.();
    }
  }
  function run(action, mutation = false) {
    if (controller.signal.aborted) return Promise.reject(new CommandError('operation_stopped', 'This Intent no longer accepts work.'));
    const task = runExecution({ deadlineMs: deadlineMs ?? Infinity, signal: controller.signal, mutation }, action);
    pending.add(task);
    const remove = () => pending.delete(task);
    task.then(remove, remove);
    return task;
  }
  function stop(code) {
    clearTimeout(timer);
    controller.abort({ code });
  }
  return { start, run, stop, drain: () => Promise.allSettled([...pending]), signal: controller.signal,
    get deadlineMs() { return deadlineMs; }, get pendingCount() { return pending.size; } };
}

// Agent replies are values, not device actions. Pass a cancellation signal and
// stop accepting replies on pause/cancel. An ignored signal cannot dispatch a
// late decision through the Intent after this promise has settled.
function awaitAgentReply(agent, input, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => finish(new CommandError(signal.reason?.code || 'cancelled', 'The Intent stopped waiting for this Agent reply.'));
    const finish = (error, value) => {
      signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw new CommandError(signal.reason?.code || 'cancelled', 'Agent request cancelled before dispatch.');
      return agent.decide({ ...input, signal });
    }).then(value => finish(null, value), error => finish(error));
  });
}

module.exports = { createIntentLifetime, awaitAgentReply };
