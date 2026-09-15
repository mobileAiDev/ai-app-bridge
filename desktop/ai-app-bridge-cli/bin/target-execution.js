'use strict';

const { createHash } = require('node:crypto');
const { targetIdentity } = require('./shared-kernel/execution-target');
const { CommandError } = require('./command-errors');
const { isAndroidMutation, isMutationCommand, executionTimeoutMs } = require('./command-registry');
const { runExecution, checkExecution, currentExecution, executionFailure } = require('./shared-kernel/execution-scope');
const { getProcessDeviceMutationLease } = require('./shared-kernel/device-mutation-lease');

class TargetExecution {
  constructor({ requestTtlMs = 5 * 60_000, maxRequests = 2_048, now = Date.now } = {}) {
    if (!Number.isFinite(requestTtlMs) || requestTtlMs < 0) {
      throw new TypeError('requestTtlMs must be a non-negative number');
    }
    if (!Number.isInteger(maxRequests) || maxRequests < 1) {
      throw new TypeError('maxRequests must be a positive integer');
    }
    if (typeof now !== 'function') {
      throw new TypeError('now must be a function');
    }
    this.targetTails = new Map();
    this.requests = new Map();
    this.requestTtlMs = requestTtlMs;
    this.maxRequests = maxRequests;
    this.now = now;
  }

  execute(command, args, runner) {
    if (typeof command !== 'string' || command.length === 0) {
      throw new TypeError('command is required');
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new TypeError('args must be an object');
    }
    if (typeof runner !== 'function') {
      throw new TypeError('runner must be a function');
    }

    const normalizedArgs = { ...args };
    const target = targetFor(command, normalizedArgs);
    const requestKey = idempotencyKey(target.key, normalizedArgs.requestId);
    const requestHash = requestKey === null ? null : requestDigest(command, normalizedArgs);
    this.pruneRequests();
    if (requestKey !== null && this.requests.has(requestKey)) {
      const existing = this.requests.get(requestKey);
      if (existing.requestHash !== requestHash) throw new CommandError('idempotency_conflict',
        'requestId was already used for a different command or arguments.', { field: 'requestId' });
      return existing.promise;
    }

    const requestedAtMs = this.now();
    const deviceMutation = isAndroidMutation(command, normalizedArgs);
    const queueKey = deviceMutation ? `android-device:${normalizedArgs.serial}`
      : command === 'web-execution' ? `${target.key}:control`
      : command === 'web-dom' ? `${target.key}:observation` : target.key;
    const execution = runExecution({ timeoutMs: executionTimeoutMs(command, normalizedArgs), mutation: isMutationCommand(command, normalizedArgs) }, () => this.enqueue(queueKey, async () => {
      const startedAtMs = this.now();
      try {
        const legacyResult = deviceMutation
          ? await getProcessDeviceMutationLease().run(normalizedArgs.serial, () => runner(command, normalizedArgs))
          : await runner(command, normalizedArgs);
        const completedAtMs = this.now();
        const feedback = buildFeedback({
          command,
          requestId: normalizedArgs.requestId,
          target,
          status: resultStatus(legacyResult),
          requestedAtMs,
          startedAtMs,
          completedAtMs,
        });
        return feedbackEnabled(normalizedArgs.feedback)
          ? appendFeedback(legacyResult, feedback)
          : legacyResult;
      } catch (error) {
        const completedAtMs = this.now();
        if (feedbackEnabled(normalizedArgs.feedback)) {
          error._feedback = buildFeedback({
            command,
            requestId: normalizedArgs.requestId,
            target,
            status: 'failed',
            requestedAtMs,
            startedAtMs,
            completedAtMs,
          });
        }
        throw error;
      }
    }));

    if (requestKey !== null) {
      const request = {
        requestHash,
        promise: execution,
        settled: false,
        expiresAtMs: Number.POSITIVE_INFINITY,
      };
      this.requests.set(requestKey, request);
      const markSettled = () => {
        request.settled = true;
        request.expiresAtMs = this.now() + this.requestTtlMs;
        this.pruneRequests();
      };
      execution.then(markSettled, markSettled);
    }
    return execution;
  }

  pruneRequests() {
    const now = this.now();
    for (const [key, request] of this.requests) {
      if (request.settled && request.expiresAtMs < now) {
        this.requests.delete(key);
      }
    }
    if (this.requests.size <= this.maxRequests) return;
    for (const [key, request] of this.requests) {
      if (!request.settled) continue;
      this.requests.delete(key);
      if (this.requests.size <= this.maxRequests) return;
    }
  }

  enqueue(targetKey, action) {
    const previous = this.targetTails.get(targetKey) || Promise.resolve();
    const scope = currentExecution();
    let started = false;
    let abort;
    const execution = previous.catch(() => undefined).then(() => {
      started = true;
      scope?.signal.removeEventListener('abort', abort);
      checkExecution();
      return action();
    });
    this.targetTails.set(targetKey, execution);
    const clearTail = () => {
      if (this.targetTails.get(targetKey) === execution) {
        this.targetTails.delete(targetKey);
      }
    };
    execution.then(clearTail, clearTail);
    // A queued cancellation may return immediately, but the queue barrier stays
    // behind the preceding operation. Once dispatched, await actual settlement.
    return new Promise((resolve, reject) => {
      abort = () => { if (!started) reject(executionFailure(scope)); };
      scope?.signal.addEventListener('abort', abort, { once: true });
      execution.then(resolve, reject).finally(() => scope?.signal.removeEventListener('abort', abort));
    });
  }
}

function feedbackEnabled(value) {
  return value !== false && String(value || 'auto').toLowerCase() !== 'off';
}

function requestDigest(command, args) {
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  }
  const { requestId, ...content } = args;
  return createHash('sha256').update(JSON.stringify(canonical({ command, arguments: content }))).digest('hex');
}

function targetFor(command, args) {
  if (command === 'executor-prepare') return { kind: 'host', platform: 'host',
    key: `executor-prepare:${JSON.stringify([args.platform, args.projectDir ?? null])}` };
  if (command === 'logcat' && String(args.deviceLogScope || '').toLowerCase() === 'device') {
    const serial = targetPart(args.serial);
    return {
      kind: 'android-device',
      key: targetKey('android-device', serial, ''),
      serial,
    };
  }

  if (command.startsWith('ios-')) {
    const deviceId = targetPart(args.deviceId);
    const bundleId = targetPart(args.bundleId);
    return {
      kind: 'ios', platform: 'ios',
      key: targetIdentity({ platform: 'ios', deviceId, bundleId }),
      deviceId,
      bundleId,
    };
  }

  if (command.startsWith('web-')) {
    const sessionId = targetPart(args.sessionId);
    const targetId = targetPart(args.targetId);
    const runtimeEpoch = targetPart(args.runtimeEpoch);
    return {
      kind: 'web', platform: 'web',
      key: targetIdentity({ platform: 'web', sessionId, runtimeEpoch, targetId }),
      sessionId,
      runtimeEpoch,
      targetId,
    };
  }

  const serial = targetPart(args.serial);
  const packageName = targetPart(args.packageName);
  return {
    kind: 'android', platform: 'android',
    key: targetIdentity({ platform: 'android', serial, packageName }),
    serial,
    packageName,
  };
}

function targetPart(value) {
  return value === undefined || value === null ? '' : String(value);
}

function targetKey(kind, first, second) {
  return `${kind}:${JSON.stringify([first, second])}`;
}

function idempotencyKey(targetKeyValue, requestId) {
  if (requestId === undefined || requestId === null) return null;
  return JSON.stringify([targetKeyValue, String(requestId)]);
}

function resultStatus(result) {
  if (result && typeof result === 'object' && result.ok === false) return 'failed';
  if (result && typeof result === 'object' && result.verified === true) return 'verified';
  if (result === undefined || result === null) return 'inconclusive';
  if (result && typeof result === 'object' && result.inconclusive === true) return 'inconclusive';
  return 'completed';
}

function buildFeedback({
  command,
  requestId,
  target,
  status,
  requestedAtMs,
  startedAtMs,
  completedAtMs,
}) {
  return {
    status,
    target,
    dispatch: {
      command,
      requestId: requestId === undefined ? null : requestId,
      serializedByTarget: true,
    },
    timings: {
      requestedAtMs,
      startedAtMs,
      completedAtMs,
      queueWaitMs: startedAtMs - requestedAtMs,
      durationMs: completedAtMs - startedAtMs,
    },
    evidence: [],
  };
}

function appendFeedback(legacyResult, feedback) {
  if (
    legacyResult === null
    || typeof legacyResult !== 'object'
    || Buffer.isBuffer(legacyResult)
    || Array.isArray(legacyResult)
  ) {
    return legacyResult;
  }
  return { ...legacyResult, _feedback: feedback };
}

module.exports = {
  TargetExecution,
  targetFor,
};
