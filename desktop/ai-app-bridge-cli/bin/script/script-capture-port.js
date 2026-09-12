'use strict';

const { capturePage, unavailablePage } = require('../shared-kernel/live-capture-query');

function createScriptCapturePort({ query } = {}) {
  if (typeof query !== 'function') {
    throw new TypeError('query');
  }

  async function queryWindow(commandName, args = {}, executionContext = {}) {
    const stream = streamFor(commandName);
    if (!stream) {
      return unavailablePage('unsupported_capture_stream');
    }
    if (executionContext.runtimeEpochChanged === true || executionContext.disconnected === true) {
      return unavailablePage(executionContext.disconnected ? 'target_disconnected' : 'runtime_epoch_changed');
    }
    const page = await query({
      ...args,
      command: commandName,
      view: args.view ?? (args.history === true ? 'connected-history' : 'decision-window'),
      stream,
      afterActionId: afterActionIdOf(args, executionContext),
      timeoutMs: timeoutMsOf(args, executionContext),
      runtimeEpoch: executionContext.runtimeEpoch ?? args.runtimeEpoch ?? null,
      sinceMs: args.sinceMs ?? null,
      limit: args.limit ?? (commandName.startsWith('web-') ? 16 : 200),
      serial: args.serial,
      packageName: args.packageName,
    });
    return capturePage(page);
  }

  return { query: queryWindow };
}

function afterActionIdOf(args, executionContext) {
  if (executionContext.evidenceWindow && executionContext.evidenceWindow.afterActionId != null) {
    return executionContext.evidenceWindow.afterActionId;
  }
  if (executionContext.actionId != null) return executionContext.actionId;
  if (args.afterActionId != null) return args.afterActionId;
  return null;
}

function timeoutMsOf(args, executionContext) {
  if (executionContext.evidenceWindow && executionContext.evidenceWindow.timeoutMs != null) {
    return executionContext.evidenceWindow.timeoutMs;
  }
  if (executionContext.timeoutMs != null) return executionContext.timeoutMs;
  return args.timeoutMs ?? null;
}

function streamFor(commandName) {
  if (
    commandName === 'logs'
    || commandName === 'ios-logs'
    || commandName === 'web-logs'
    || commandName === 'webview-console'
  ) return 'logs';
  if (
    commandName === 'network'
    || commandName === 'ios-network'
    || commandName === 'web-network'
    || commandName === 'webview-network'
  ) return 'network';
  if (commandName === 'state' || commandName === 'ios-state' || commandName === 'web-state') return 'state';
  if (commandName === 'events' || commandName === 'ios-events' || commandName === 'web-events') return 'events';
  return null;
}

function isCaptureReadCommand(commandName) {
  return streamFor(commandName) !== null;
}

module.exports = { createScriptCapturePort, isCaptureReadCommand };
