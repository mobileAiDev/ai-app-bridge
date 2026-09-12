'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { CommandError } = require('../command-errors');

const context = new AsyncLocalStorage();

// One budget covers queueing, observation, dispatch and provider I/O. Nested
// calls may shorten it, never restart or extend it. Signals stay inside Host.
async function runExecution({ timeoutMs, deadlineMs = Infinity, signal, mutation } = {}, action) {
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)) {
    throw new CommandError('invalid_argument', 'timeoutMs must be a positive integer in milliseconds.', { field: 'timeoutMs' });
  }
  const parent = context.getStore();
  if (parent?.closed) throw new CommandError('runtime_stopped', 'The owning execution has already settled.');
  const controller = new AbortController();
  const scope = {
    parent, controller, signal: controller.signal, closed: false, dispatched: false,
    mutation: mutation ?? parent?.mutation ?? false,
    deadlineMs: Math.min(parent?.deadlineMs ?? Infinity, deadlineMs, timeoutMs === undefined ? Infinity : Date.now() + timeoutMs),
  };
  const subscriptions = [];
  for (const upstream of new Set([parent?.signal, signal].filter(Boolean))) {
    const abort = () => controller.abort(upstream.reason);
    if (upstream.aborted) abort();
    else {
      upstream.addEventListener('abort', abort, { once: true });
      subscriptions.push(() => upstream.removeEventListener('abort', abort));
    }
  }
  const remaining = scope.deadlineMs - Date.now();
  let timer;
  if (remaining <= 0) controller.abort({ code: 'deadline_exceeded' });
  else if (Number.isFinite(remaining)) timer = setTimeout(() => controller.abort({ code: 'deadline_exceeded' }), remaining);
  try {
    return await context.run(scope, () => { checkExecution(); return action(); });
  } finally {
    scope.closed = true;
    clearTimeout(timer);
    for (const unsubscribe of subscriptions) unsubscribe();
  }
}

function currentExecution() { return context.getStore(); }

// Long-lived collectors own their own lifecycle; starting one from a command
// must not attach all of its later observations to that command's deadline.
function withoutExecution(action) { return context.exit(action); }

function executionFailure(scope = currentExecution()) {
  const code = scope?.signal.reason?.code || 'runtime_stopped';
  return new CommandError(code, code === 'deadline_exceeded'
    ? 'The execution deadline expired.' : 'The execution was stopped.', {
    dispatched: scope?.dispatched === true,
    ambiguous: scope?.dispatched === true,
  });
}

function checkExecution() {
  const scope = currentExecution();
  if (!scope) return;
  // A busy event loop may not have delivered the timer yet.
  if (Date.now() >= scope.deadlineMs) scope.controller.abort({ code: 'deadline_exceeded' });
  if (scope.closed || scope.signal.aborted) throw executionFailure(scope);
}

function markExecutionDispatched() {
  for (let scope = currentExecution(); scope; scope = scope.parent) scope.dispatched = true;
}

async function executionSleep(ms) {
  checkExecution();
  const scope = currentExecution();
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      scope?.signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    };
    const abort = () => finish(executionFailure(scope));
    const timer = setTimeout(() => finish(), ms);
    scope?.signal.addEventListener('abort', abort, { once: true });
  });
  checkExecution();
}

module.exports = { runExecution, currentExecution, withoutExecution, checkExecution, markExecutionDispatched, executionFailure, executionSleep };
