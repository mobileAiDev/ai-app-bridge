'use strict';

const { capturePage, unavailablePage } = require('../shared-kernel/live-capture-query');

function createIntentCapturePort({ query } = {}) {
  if (typeof query !== 'function') {
    throw new TypeError('query');
  }

  async function observe(requirements = {}, executionContext = {}) {
    const stream = requirements.stream;
    if (!stream) {
      return unavailablePage('unsupported_capture_stream');
    }
    if (executionContext.runtimeEpochChanged === true || executionContext.disconnected === true) {
      return unavailablePage(executionContext.disconnected ? 'target_disconnected' : 'runtime_epoch_changed');
    }
    // Foreground routing belongs to Intent observation, not a phone data query.
    const { foregroundPackages: _foregroundPackages, ...target } = executionContext.target || {};
    for (const key of ['serial', 'packageName', 'port', 'adb', 'platform', 'deviceId', 'bundleId', 'sessionId', 'targetId', 'runtimeUrl', 'iosHost', 'iosPort']) {
      if (target[key] != null && requirements[key] != null && requirements[key] !== target[key]) {
        return unavailablePage('capture_target_mismatch');
      }
    }
    if (target.platform === 'web' && requirements.runtimeEpoch !== undefined
      && requirements.runtimeEpoch !== target.runtimeEpoch) return unavailablePage('capture_target_mismatch');
    const page = await query({
      ...requirements,
      ...target,
      view: requirements.view ?? (requirements.history === true ? 'connected-history' : 'decision-window'),
      platform: executionContext.platform ?? target.platform ?? requirements.platform,
      stream,
      afterActionId: afterActionIdOf(requirements, executionContext),
      timeoutMs: timeoutMsOf(requirements, executionContext),
      runtimeEpoch: executionContext.runtimeEpoch ?? target.runtimeEpoch ?? requirements.runtimeEpoch ?? null,
      sinceMs: requirements.sinceMs ?? null,
      limit: requirements.limit ?? ((executionContext.platform ?? target.platform ?? requirements.platform) === 'web' ? 16 : 200),
    });
    return capturePage(page);
  }

  return { observe };
}

function afterActionIdOf(requirements, executionContext) {
  if (requirements.afterActionId === null) return null;
  if (executionContext.evidenceWindow && executionContext.evidenceWindow.afterActionId != null) {
    return executionContext.evidenceWindow.afterActionId;
  }
  if (executionContext.actionId != null) return executionContext.actionId;
  if (requirements.afterActionId != null) return requirements.afterActionId;
  return null;
}

function timeoutMsOf(requirements, executionContext) {
  if (executionContext.evidenceWindow && executionContext.evidenceWindow.timeoutMs != null) {
    return executionContext.evidenceWindow.timeoutMs;
  }
  if (executionContext.timeoutMs != null) return executionContext.timeoutMs;
  if (requirements.timeoutMs != null) return requirements.timeoutMs;
  return null;
}

module.exports = { createIntentCapturePort };
