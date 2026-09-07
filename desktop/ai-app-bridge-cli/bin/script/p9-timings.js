'use strict';

const { emptyTimings } = require('./p9-scenario-runner');

const BUSINESS_COMMANDS = new Set([
  'wait-text',
  'h5-wait',
  'web-wait',
]);

const EVIDENCE_COMMANDS = new Set([
  'logs',
  'network',
  'state',
  'events',
  'webview-console',
  'webview-network',
  'ios-logs',
  'ios-network',
  'ios-state',
  'ios-events',
  'web-logs',
  'web-network',
  'web-state',
  'web-events',
]);

const PROVIDER_COMMANDS = new Set([
  'status',
  'tree',
  'uia-tree',
  'screenshot',
  'flutter-tree',
  'flutter-nodes',
  'h5-dom',
  'keyboard-state',
  'permission-state',
  'ios-status',
  'ios-uia-tree',
  'ios-tree',
  'web-status',
  'web-dom',
]);

function timingsFromScriptEvents(events, extras = {}) {
  const timings = emptyTimings();
  let open = null;
  let pausedAt = null;
  let pausedMs = 0;
  for (const event of events || []) {
    if (event.type === 'call_started') {
      open = event;
      continue;
    }
    if ((event.type === 'call_completed' || event.type === 'call_failed') && open) {
      const duration = Math.max(0, Number(event.atMs) - Number(open.atMs));
      const command = event.command || open.command;
      if (BUSINESS_COMMANDS.has(command)) timings.businessWaitMs += duration;
      else if (EVIDENCE_COMMANDS.has(command)) timings.evidenceQueryMs += duration;
      else if (PROVIDER_COMMANDS.has(command)) timings.providerWaitMs += duration;
      open = null;
      continue;
    }
    if (event.type === 'paused') {
      pausedAt = event.atMs;
      continue;
    }
    if (event.type === 'resumed' && pausedAt != null) {
      pausedMs += Math.max(0, Number(event.atMs) - Number(pausedAt));
      pausedAt = null;
    }
  }
  const summary = extras.rollingSummary || {};
  timings.pausedMs = pausedMs;
  timings.decisionWaitMs = typeof summary.decisionWaitMs === 'number' ? summary.decisionWaitMs : 0;
  timings.wallMs = typeof extras.wallMs === 'number' ? extras.wallMs : (summary.elapsedMs || 0);
  timings.activeMs = typeof summary.activeMs === 'number'
    ? summary.activeMs
    : Math.max(0, timings.wallMs - timings.pausedMs);
  return timings;
}

function attachOnce(timings) {
  let used = false;
  return function withTimings(result) {
    if (used || !result || result.status === 'skipped' || result.status === 'not_run') {
      return result;
    }
    used = true;
    return { ...result, timings };
  };
}

module.exports = {
  BUSINESS_COMMANDS,
  EVIDENCE_COMMANDS,
  PROVIDER_COMMANDS,
  timingsFromScriptEvents,
  attachOnce,
};
