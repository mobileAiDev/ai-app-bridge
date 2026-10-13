'use strict';

const { projectForegroundDiagnostics } = require('./shared-kernel/foreground-diagnostics');

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
  'latestEvidenceIds', 'terminalEvidenceId', 'observationFailure', 'provider', 'observationTarget', 'deadlineMs', 'pendingOperations', 'lastAction', 'uiObservation', 'background', 'accepted', 'timedOut', 'waitMs'];
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
  if (Array.isArray(facts.details?.candidates)) {
    const { candidates, ...details } = facts.details;
    facts.details = { ...details, candidatesPath: '/details/candidates', availableCandidates: candidates.length };
  }
  if (facts.ok === undefined) facts.ok = null;
  return facts;
}

// Full candidates remain source content. Keep the extraction-proof control
// preview short so it cannot consume the entire delivery budget by itself.
function candidatePreview(source, path, offset = 0, count = 20) {
  const all = source.candidates, candidates = [];
  let bytes = 2;
  for (const candidate of all.slice(offset, offset + Math.min(count, 20))) {
    const size = Buffer.byteLength(JSON.stringify(candidate)) + 1;
    if (bytes + size > 8192) break;
    candidates.push(candidate); bytes += size;
  }
  const hasMore = offset + candidates.length < all.length;
  return { candidates, candidatesTruncated: source.candidatesTruncated === true || hasMore,
    ...(hasMore || offset > 0 || source.candidatesTruncated ? { candidatePage: {
      path, offset, count: candidates.length, available: all.length, sourceTruncated: source.candidatesTruncated === true,
      ...(source.matched === undefined ? {} : { matched: source.matched }), hasMore,
    } } : {}) };
}

function candidateReads(body, frozen, extract) {
  for (const control of [body.control, body.control.lastAction]) {
    const page = control?.candidatePage;
    if (!page) continue;
    let nextOffset = page.offset + page.count;
    if (extract?.mode === 'select' && extract.path === page.path && Array.isArray(body.value)) {
      const all = page.path.split('/').slice(1).reduce((value, key) => value[key], frozen.snapshot.value);
      const offset = extract.offset ?? 0;
      Object.assign(control, candidatePreview({ candidates: all, candidatesTruncated: page.sourceTruncated, matched: page.matched }, page.path, offset, body.value.length));
      nextOffset = offset + body.value.length;
    }
    const current = control.candidatePage;
    if (!current) continue;
    delete current.read;
    current.hasMore = nextOffset < current.available;
    if (current.hasMore && body.control.source.ref) {
      const all = current.path.split('/').slice(1).reduce((value, key) => value[key], frozen.snapshot.value);
      const availableBytes = DEFAULT_OUTPUT_BYTES - replyBytes({ ...body, value: null }) - 2048;
      let bytes = 2, count = 0;
      for (const candidate of all.slice(nextOffset, nextOffset + 20)) {
        bytes += Buffer.byteLength(JSON.stringify(candidate)) + 1;
        if (bytes > availableBytes) break;
        count++;
      }
      current.read = { command: 'response', arguments: { operation: 'read', ref: body.control.source.ref },
        extract: { mode: 'select', path: current.path, offset: nextOffset, limit: Math.max(1, count) } };
    }
  }
}

function controlFacts(command, value, history) {
  const control = {};
  if (isRecord(value)) {
    for (const key of ['warnings', 'foregroundObservations', 'guidance', 'selectionRequired']) {
      if (value[key] !== undefined) control[key] = projectForegroundDiagnostics(value[key], { path: `/${key}` });
      else if (intentCommands.has(command) && value.summary?.[key] !== undefined) control[key] = projectForegroundDiagnostics(value.summary[key], { path: `/summary/${key}` });
    }
    if (command === 'script') Object.assign(control, pick(value, scriptControlKeys));
    else if (intentCommands.has(command)) Object.assign(control, pick(value, intentControlKeys));
    else Object.assign(control, pick(value, commonControlKeys));
    if (value.controlAccepted === true) Object.assign(control, pick(value,
      ['controlAccepted', 'completionScope', 'controlId', 'controlPid', 'status', 'resultPath']));
    if (isRecord(control.lastAction) && Object.hasOwn(control.lastAction, 'result')) {
      const { result, ...actionFacts } = control.lastAction;
      // Command output is source data, not continuation metadata. Copying a
      // child Script result here doubles it and can make auto delivery useless.
      control.lastAction = { ...actionFacts, resultPath: '/lastAction/result',
        ...(isRecord(result) ? { resultControl: pick(result, ['command', 'operationId', 'status', 'revision', 'eventSequence',
          'resultRef', 'pendingQuestion', 'controlAccepted', 'controlId', 'resultPath', 'completionScope', 'accepted', 'background']) } : {}) };
    }
    if (isRecord(control.lastAction)) control.lastAction = projectForegroundDiagnostics(control.lastAction, { path: '/lastAction' });
    const selection = Array.isArray(value.candidates) ? [value, '/candidates']
      : Array.isArray(value.details?.candidates) ? [value.details, '/details/candidates']
        : Array.isArray(value.summary?.candidates) ? [value.summary, '/summary/candidates'] : null;
    if (selection) Object.assign(control, candidatePreview(...selection));
    if (Array.isArray(control.lastAction?.candidates)) control.lastAction = {
      ...control.lastAction, ...candidatePreview(control.lastAction, '/lastAction/candidates'),
    };
    if (captureCommands.has(command)) {
      Object.assign(control, pick(value, captureControlKeys));
      if (isRecord(value._factCache)) control._factCache = pick(value._factCache,
        ['history', 'cursor', 'gap', 'cursorExpired', 'hasMore', 'scannedCount', 'targetKey', 'partitions']);
    }
    if (control.pendingQuestion === null) delete control.pendingQuestion;
    // Script/Intent history is source content; only its page cursor is control.
    if ((command === 'script' || intentCommands.has(command)) && isRecord(value.history)) {
      control.history = pick(value.history, ['lastSequence', 'hasMore', 'gap', 'window', 'omittedBefore']);
    }
  }
  if (history) control.history = history;
  return control;
}

// `reply` is the internal {value, history?} of the executed command; `stage`
// names the public stage that rejected the request, when one did.
function publicReply({ command, reply, stage, completed = false, args = {} }) {
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
  if (command === 'logcat') {
    const guidance = require('./shared-kernel/logcat-query').logcatGuidance(args, reply.value);
    if (guidance) body.control.guidance = guidance;
  }
  try {
    body.delivery.valueBytes = Buffer.byteLength(JSON.stringify(value));
    JSON.stringify(body);
    return body;
  } catch { return serializationFailure(body); }
}

function publicFailure({ command, stage, error, args = {}, maxBytes = DEFAULT_OUTPUT_BYTES }) {
  const value = require('./shared-kernel/action-guidance').withActionGuidance(command, args, commandFailure(error, command));
  return boundedReply(publicReply({ command, reply: { value }, stage }), maxBytes);
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
    execution: minimalExecution(body.execution), control: { ...pick(body.control,
      ['operationId', 'status', 'revision', 'eventSequence', 'lastDecisionId', 'deadlineMs', 'timedOut']), source, controlComplete: false },
    extraction: pick(body.extraction, ['status', 'mode', 'language', 'durationMs', 'error']),
    delivery: { status: source.persisted ? 'reference' : 'unavailable', reason: 'control_over_budget', attemptedBytes, limitBytes },
    kind: body.kind, failureStage: body.failureStage };
}

async function finishReply({ body, extract, output, frozen, getStore, sourceReason = 'offline' }) {
  const limitBytes = output?.maxBytes ?? DEFAULT_OUTPUT_BYTES;
  body.delivery.limitBytes = limitBytes;
  if (body.delivery.reason === 'response_serialization_failed') return boundedReply(body, limitBytes);
  const { freezeResponse, MAX_SNAPSHOT_BYTES } = require('./response-store');
  const automatic = extract?.mode === 'auto';
  const comparing = extract?.mode === 'delta';
  const extracting = extract !== null && !automatic && !comparing;
  const valueBytes = body.value === undefined ? 0 : Buffer.byteLength(JSON.stringify(body.value));
  const previewing = automatic && replyBytes(body) > limitBytes;
  const retained = Boolean(frozen);
  let compact = null;
  // Try a complete representation for repetitive medium/large JSON too. This
  // threshold changes formatting only: it never removes content or forces a read.
  if (automatic && body.kind === 'json' && (previewing || valueBytes > 8 * 1024)) {
    try { frozen ||= freezeResponse(body); }
    catch { return boundedReply(serializationFailure(body), limitBytes); }
    compact = require('./extraction/tables').tableView(frozen.snapshot.value, valueBytes, body.control.source);
    if (!previewing && compact && Buffer.byteLength(JSON.stringify(compact)) > valueBytes * 0.7) compact = null;
  }
  const needsSource = comparing || extracting || previewing || compact || replyBytes(body) > limitBytes;
  if (!needsSource) return body;
  if (!frozen) {
    try { frozen = freezeResponse(body); }
    catch { return boundedReply(serializationFailure(body), limitBytes); }
  }
  let base, baseError;
  if (comparing && extract.base) {
    try { base = getStore?.().read(extract.base).snapshot; }
    catch (error) { baseError = error.code || 'response_read_failed'; }
  }
  if (!retained) {
    if (getStore && body.kind !== 'bytes') {
      try { body.control.source = await getStore().save(frozen); }
      catch (error) { body.control.source = { ...body.control.source, reason: undefined, error: error.code || 'snapshot_save_failed' }; }
    } else body.control.source = { ...body.control.source, reason: body.kind === 'bytes' ? 'binary_snapshot_unsupported' : sourceReason };
  }
  if (comparing && frozen.snapshot.kind !== 'bytes') {
    body.value = require('./extraction/delta').deltaView(frozen.snapshot, base, extract.base, baseError);
    body.kind = 'json';
    body.extraction = { status: 'succeeded', mode: 'delta', partial: false };
    body.delivery = { status: body.value.mode === 'patch' ? 'delta' : 'inline', originalValueBytes: valueBytes,
      valueBytes: Buffer.byteLength(JSON.stringify(body.value)), limitBytes };
  } else if (previewing || compact) {
    const original = { value: body.value, kind: body.kind, extraction: body.extraction, delivery: body.delivery };
    body.kind = 'json';
    body.extraction = { status: 'succeeded', mode: 'auto', partial: true };
    body.delivery = { status: 'overview', originalValueBytes: valueBytes, valueBytes: 0, limitBytes };
    body.value = null;
    const availableBytes = Math.max(0, limitBytes - replyBytes(body) - 64);
    if (compact && body.control.source.ref) compact.read = { command: 'response', arguments: { operation: 'read', ref: body.control.source.ref },
      extract: { mode: 'select', path: compact.tables[0]?.path ?? compact.sharedTexts[0].paths[0].slice('/data'.length), offset: 0, limit: 1 } };
    if (compact && Buffer.byteLength(JSON.stringify(compact)) <= availableBytes) {
      body.value = compact;
      body.extraction.partial = false;
      body.delivery.status = 'compact';
    } else if (body.control.source.persisted) {
      body.value = require('./extraction/overview').overview(body.command, frozen.snapshot.value, frozen.snapshot.kind, valueBytes, body.control.source, availableBytes);
    } else Object.assign(body, original);
    body.delivery.valueBytes = Buffer.byteLength(JSON.stringify(body.value));
  } else if (extracting) {
    let result;
    if (frozen.snapshot.kind === 'bytes') result = { ok: false, error: 'extraction_binary_unsupported' };
    else if (frozen.bytes.length > MAX_SNAPSHOT_BYTES) result = { ok: false, error: 'extraction_input_too_large', maxBytes: MAX_SNAPSHOT_BYTES };
    else {
      const { kind, value: response, execution, control } = frozen.snapshot;
      result = extract.mode === 'select' ? require('./extraction/overview').selectValue(response, extract)
        : await require('./extraction/runner').runExtraction(extract, { kind, response, execution, control });
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
  candidateReads(body, frozen, extract);
  return boundedReply(body, limitBytes);
}

function responseReply({ snapshot, source }) {
  return { command: 'response', execution: { ok: true, dispatched: false, ambiguous: false },
    control: { ...structuredClone(snapshot.control), origin: { ...snapshot.identity, execution: snapshot.execution }, source },
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
