'use strict';

const { commandFailure } = require('./command-errors');
const { encodeReply } = require('./runtime-protocol');
const { randomUUID } = require('node:crypto');
const DEFAULT_OUTPUT_BYTES = 96 * 1024;

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
    for (const key of ['warnings', 'foregroundObservations']) {
      if (value[key] !== undefined) control[key] = value[key];
      else if (intentCommands.has(command) && value.summary?.[key] !== undefined) control[key] = value.summary[key];
    }
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
  const body = {
    command: typeof command === 'string' && command ? command : null,
    execution,
    control: { ...controlFacts(command, reply.value, reply.history), source: { responseId: randomUUID(), capturedAtMs: Date.now(), persisted: false, reason: 'not_requested' } },
    extraction: { status: 'skipped' },
    delivery: { status: 'inline' },
    kind, value,
    ...(failureStage ? { failureStage } : {}),
  };
  try {
    body.delivery.valueBytes = Buffer.byteLength(JSON.stringify(value));
    JSON.stringify(body);
    return body;
  } catch { return serializationFailure(body); }
}

function publicFailure({ command, stage, error, maxBytes = DEFAULT_OUTPUT_BYTES }) {
  return boundedReply(publicReply({ command, reply: { value: commandFailure(error, command) }, stage }), maxBytes);
}

function minimalExecution(execution) {
  return { ok: execution.ok === true ? true : execution.ok === false ? false : null,
    ...pick(execution, ['dispatched', 'ambiguous', 'settled', 'exitCode']),
    ...(typeof execution.error === 'string' && execution.error.length < 128 ? { error: execution.error } : {}) };
}

function serializationFailure(body) {
  return { command: body.command, execution: minimalExecution(body.execution),
    control: { source: body.control.source, controlComplete: false }, extraction: { status: 'skipped' },
    delivery: { status: 'unavailable', reason: 'response_serialization_failed', limitBytes: DEFAULT_OUTPUT_BYTES },
    kind: body.kind, failureStage: body.failureStage || 'delivery' };
}

function replyBytes(body) { return Buffer.byteLength(JSON.stringify(body)); }

function boundedReply(body, limitBytes = DEFAULT_OUTPUT_BYTES) {
  body.delivery.limitBytes = limitBytes;
  const attemptedBytes = replyBytes(body);
  if (attemptedBytes <= limitBytes) return body;
  delete body.value;
  body.delivery = { ...body.delivery, status: body.control.source.persisted ? 'reference' : 'unavailable',
    reason: 'output_budget_exceeded', attemptedBytes, limitBytes };
  body.failureStage ||= 'delivery';
  if (replyBytes(body) <= limitBytes) return body;
  // A large question, receipt or diagnostic must never become a silently
  // incomplete continuation. Keep dispatch uncertainty and the real source.
  const source = pick(body.control.source, ['responseId', 'capturedAtMs', 'persisted', 'ref', 'reason']);
  if (body.control.source.error) source.error = 'source_unavailable';
  return { command: typeof body.command === 'string' && body.command.length < 256 ? body.command : null,
    execution: minimalExecution(body.execution), control: { source, controlComplete: false },
    extraction: pick(body.extraction, ['status', 'mode', 'language', 'durationMs', 'error']),
    delivery: { status: source.persisted ? 'reference' : 'unavailable', reason: 'control_over_budget', attemptedBytes, limitBytes },
    kind: body.kind, failureStage: body.failureStage };
}

async function finishReply({ body, extract, output, frozen, getStore, sourceReason = 'offline' }) {
  const limitBytes = output?.maxBytes ?? DEFAULT_OUTPUT_BYTES;
  body.delivery.limitBytes = limitBytes;
  if (body.delivery.reason === 'response_serialization_failed') return boundedReply(body, limitBytes);
  const { freezeResponse, MAX_SNAPSHOT_BYTES } = require('./response-store');
  const extracting = extract !== null;
  const needsSource = extracting || replyBytes(body) > limitBytes;
  if (!needsSource) return body;
  if (!frozen) {
    try { frozen = freezeResponse(body); }
    catch { return boundedReply(serializationFailure(body), limitBytes); }
    if (getStore && body.kind !== 'bytes') {
      try { body.control.source = await getStore().save(frozen); }
      catch (error) { body.control.source = { ...body.control.source, reason: undefined, error: error.code || 'snapshot_save_failed' }; }
    } else body.control.source = { ...body.control.source, reason: body.kind === 'bytes' ? 'binary_snapshot_unsupported' : sourceReason };
  }
  if (extracting) {
    let result;
    if (frozen.snapshot.kind === 'bytes') result = { ok: false, error: 'extraction_binary_unsupported' };
    else if (frozen.bytes.length > MAX_SNAPSHOT_BYTES) result = { ok: false, error: 'extraction_input_too_large', maxBytes: MAX_SNAPSHOT_BYTES };
    else {
      const { kind, value: response, execution, control } = frozen.snapshot;
      result = await require('./extraction/runner').runExtraction(extract, { kind, response, execution, control });
    }
    const { ok, result: value, timings, ...details } = result;
    body.extraction = { status: ok ? 'succeeded' : 'failed', mode: extract.mode,
      ...(extract.language ? { language: extract.language } : {}), ...details };
    if (ok) {
      body.kind = 'json';
      body.value = value;
      body.delivery.valueBytes = Buffer.byteLength(JSON.stringify(value));
    } else {
      delete body.value;
      body.delivery = { status: body.control.source.persisted ? 'reference' : 'unavailable', limitBytes, reason: 'extraction_failed' };
      body.failureStage ||= 'extraction';
    }
  }
  return boundedReply(body, limitBytes);
}

function responseReply({ snapshot, source }) {
  return { command: 'response', execution: { ok: true, dispatched: false, ambiguous: false },
    control: { ...snapshot.control, origin: { ...snapshot.identity, execution: snapshot.execution }, source },
    extraction: { status: 'skipped' }, delivery: { status: 'inline', valueBytes: Buffer.byteLength(JSON.stringify(snapshot.value)) },
    kind: snapshot.kind, value: snapshot.value };
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

module.exports = { publicReply, publicFailure, responseReply, isPublicReply, exitCodeFor, finishReply, boundedReply, DEFAULT_OUTPUT_BYTES };
