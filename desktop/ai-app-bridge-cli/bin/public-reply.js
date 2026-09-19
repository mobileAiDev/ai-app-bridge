'use strict';

const { commandFailure } = require('./command-errors');
const { encodeReply } = require('./runtime-protocol');
const { randomUUID } = require('node:crypto');

// The public reply of one run request, assembled once at the Runtime boundary
// and by the client for its local paths. The original result stays in `value`
// (including `_feedback`); execution facts and the fields needed to continue
// are copied next to it so an extraction cannot hide them.

const executionKeys = ['ok', 'error', 'message', 'field', 'details', 'dispatched', 'ambiguous', 'settled',
  'executionReceipt', 'executionReceipts', 'exitCode', 'target', 'matched', 'verified', 'inconclusive'];
// Continuation fields per response family. Only fields the response actually
// carries are copied; a business field of the same name in `value` is not one.
const scriptControlKeys = ['operationId', 'status', 'pauseReason', 'eventSequence', 'resultRef', 'persisted', 'timedOut', 'waitMs', 'pendingQuestion'];
const intentControlKeys = ['operationId', 'status', 'revision', 'lastDecisionId', 'eventSequence', 'eventGap', 'droppedEvents', 'evidenceId',
  'latestEvidenceIds', 'terminalEvidenceId', 'observationFailure', 'provider', 'observationTarget', 'deadlineMs', 'pendingOperations', 'lastAction'];
const commonControlKeys = ['cursor', 'nextCursor', 'factCursor', 'hasMore', 'truncated', 'dropped', 'gap', 'updatedAtMs', 'observedAtMs', 'capturedAtMs'];
const intentCommands = new Set(['intent', 'install-apk', 'permission-dialog']);
const captureCommands = new Set(['logs', 'network', 'state', 'events', 'ios-logs', 'ios-network', 'ios-state', 'ios-events',
  'web-logs', 'web-network', 'web-state', 'web-events', 'webview-console', 'webview-network']);
const captureControlKeys = ['stream', 'coverage', 'window', 'runtimeEpoch', 'targetKey', 'storeGeneration', 'watermarkCursor',
  'throughWatermark', 'barrier', 'committed'];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}

// The invoking layer can confirm completion for raw JSON/text/bytes. An object
// response must carry its own execution outcome; missing ok remains unknown.
function executionFacts(value, completed) {
  if (!isRecord(value)) return { ok: completed ? true : null };
  const facts = pick(value, executionKeys);
  if (facts.ok === undefined) facts.ok = null;
  return facts;
}

function controlFacts(command, value, history) {
  const control = {};
  if (isRecord(value)) {
    if (command === 'script') Object.assign(control, pick(value, scriptControlKeys));
    else if (intentCommands.has(command)) Object.assign(control, pick(value, intentControlKeys));
    else Object.assign(control, pick(value, commonControlKeys));
    if (captureCommands.has(command)) {
      Object.assign(control, pick(value, captureControlKeys));
      if (isRecord(value._factCache)) control._factCache = pick(value._factCache,
        ['history', 'cursor', 'gap', 'cursorExpired', 'hasMore', 'scannedCount', 'targetKey', 'partitions']);
    }
    if (control.pendingQuestion === null) delete control.pendingQuestion;
    // Script/Intent history is source content; only its page cursor is control.
    if ((command === 'script' || intentCommands.has(command)) && isRecord(value.history)) {
      control.history = pick(value.history, ['lastSequence', 'hasMore', 'gap']);
    }
  }
  if (history) control.history = history;
  return control;
}

// `reply` is the internal {value, history?} of the executed command; `stage`
// names the public stage that rejected the request, when one did.
function publicReply({ command, reply, stage, completed = false }) {
  const { kind, value } = encodeReply(reply);
  const execution = executionFacts(reply.value, completed);
  const failureStage = stage || (execution.ok !== true || execution.ambiguous === true ? 'execution' : undefined);
  return {
    command: typeof command === 'string' && command ? command : null,
    execution,
    control: { ...controlFacts(command, reply.value, reply.history), source: { responseId: randomUUID(), capturedAtMs: Date.now(), persisted: false, reason: 'not_requested' } },
    extraction: { status: 'skipped' },
    delivery: { status: 'inline', valueBytes: Buffer.byteLength(JSON.stringify(value)) },
    kind, value,
    ...(failureStage ? { failureStage } : {}),
  };
}

function publicFailure({ command, stage, error }) {
  return publicReply({ command, reply: { value: commandFailure(error, command) }, stage });
}

function isPublicReply(value) {
  return isRecord(value) && isRecord(value.execution) && isRecord(value.delivery) && ['json', 'text', 'bytes'].includes(value.kind);
}

// 0: delivered as requested. 1: rejected, failed or unknown execution.
// 2: the command succeeded but extraction or delivery failed.
function exitCodeFor(reply) {
  if (!reply.failureStage) return 0;
  return ['validation', 'execution'].includes(reply.failureStage) ? 1 : 2;
}

module.exports = { publicReply, publicFailure, isPublicReply, exitCodeFor };
