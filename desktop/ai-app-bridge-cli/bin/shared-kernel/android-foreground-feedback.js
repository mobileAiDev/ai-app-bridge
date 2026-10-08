'use strict';

const { checkExecution } = require('./execution-scope');
const { sameForegroundWindow } = require('./android-foreground-identity');

// Observation has no authority over action admission. Executor/node/reference
// errors and their dispatch receipts are returned unchanged by withForeground.
async function readForegroundFeedback(ctx, read, previous) {
  let actual;
  const startedAtMs = Date.now();
  try { actual = await read(ctx); }
  catch (error) {
    checkExecution();
    actual = foregroundProbeFailure(error);
  }
  const status = actual?.ok && typeof actual.packageName === 'string'
    ? (ctx.packageName ? actual.packageName === ctx.packageName ? 'match' : 'mismatch' : 'observed') : 'unknown';
  const reason = status === 'unknown' ? actual?.error || 'foreground_identity_unknown'
    : status === 'mismatch' ? 'foreground_package_mismatch' : null;
  const observation = { expected: { serial: ctx.serial ?? null, packageName: ctx.packageName ?? null },
    actual: actual ?? null, status, reason, source: 'android-window-manager',
    startedAtMs, observedAtMs: Date.now() };
  const warnings = reason ? [{ code: reason, ...observation }] : [];
  if (previous?.actual?.ok && actual?.ok && previous.actual.windowIdentity && actual.windowIdentity
    && !sameForegroundWindow(previous.actual, actual)) {
    warnings.push({ code: 'foreground_changed', ...observation, previous: previous.actual });
  }
  return { foregroundObservations: [observation], warnings };
}

function foregroundProbeFailure(error) {
  return { ok: false, ownershipVerified: false,
    error: typeof error.code === 'string' ? error.code : 'foreground_probe_failed',
    message: String(error.message || error),
    cause: { code: error.code ?? null, stdout: error.stdout ?? null, stderr: error.stderr ?? null } };
}

function withForeground(result, ...feedback) {
  const parts = [...feedback.filter(Boolean), result];
  return { ...result,
    foregroundObservations: parts.flatMap(part => part.foregroundObservations || []),
    warnings: parts.flatMap(part => part.warnings || []),
  };
}

module.exports = { readForegroundFeedback, withForeground, foregroundProbeFailure };
