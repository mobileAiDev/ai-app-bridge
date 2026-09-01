'use strict';

const { targetFor } = require('./target-execution');

const UI_EVIDENCE_COMMANDS = new Set([
  'tree',
  'uia-tree',
  'flutter-tree',
  'flutter-nodes',
  'screenshot',
  'h5-dom',
  'web-dom',
  'ios-tree',
  'ios-uia-tree',
  'ios-screenshot',
  'ios-h5-dom',
  'ios-flutter-tree',
  'ios-flutter-nodes',
]);

const REDACTED = '[REDACTED]';
const SECURE_TEXT_KEYS = new Set([
  'text',
  'value',
]);
const SECURE_FLAG_KEYS = new Set([
  'secure',
  'sensitive',
  'obscured',
  'ispassword',
  'issecure',
  'issecuretextentry',
  'securetextentry',
  'isobscured',
]);

class FactRecorder {
  constructor({ cache, now = Date.now, hostEpoch, actionCompletionGraceMs = 250 } = {}) {
    if (!cache || typeof cache.append !== 'function' || typeof cache.query !== 'function') {
      throw new TypeError('cache with append/query is required');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (!Number.isFinite(actionCompletionGraceMs) || actionCompletionGraceMs < 0) {
      throw new TypeError('actionCompletionGraceMs must be a non-negative number');
    }
    this.cache = cache;
    this.now = now;
    this.actionCompletionGraceMs = actionCompletionGraceMs;
    this.hostEpoch = hostEpoch || `host-${process.pid}-${now()}`;
    this.runtimeEpochs = new Map();
    this.actionSequence = 0;
    this.seenEvidence = new Set();
    this.seenEvidenceOrder = [];
    this.maxSeenEvidence = 20_000;
  }

  recordExecution({ command, args = {}, result, error, feedback, actionId } = {}) {
    const target = targetFor(command, args);
    const resolvedActionId = actionId || args.requestId || this.nextActionId();
    const runtimeEpoch = this.observeRuntimeEpoch(target.key, result, args.runtimeEpoch);
    if (args.requestId) {
      const existing = this.cache.query({
        partition: 'action',
        target: target.key,
        actionId: String(resolvedActionId),
        limit: 1,
      });
      if (existing.ok && existing.items.length > 0) {
        const fact = existing.items[0];
        return {
          ok: true,
          stored: true,
          globalSeq: fact.globalSeq,
          sizeBytes: fact.sizeBytes,
          evictedCount: 0,
          deduplicated: true,
          partition: 'action',
          targetKey: target.key,
          runtimeEpoch: fact.runtimeEpoch,
          actionId: String(resolvedActionId),
        };
      }
    }
    const observedAtMs = feedback?.timings?.completedAtMs || this.now();
    const appendResult = this.cache.append('action', {
      targetKey: target.key,
      app: appIdentity(target, result),
      runtimeEpoch,
      actionId: resolvedActionId,
      timestamps: {
        occurredAtMs: feedback?.timings?.requestedAtMs || observedAtMs,
        observedAtMs,
      },
      payload: {
        kind: 'execution',
        command,
        status: feedback?.status || executionStatus(result, error),
        args: summarizeArgs(args),
        result: summarizeResult(result),
        ...(error ? { error: String(error.message || error).slice(0, 1_000) } : {}),
      },
    });
    return {
      ...appendResult,
      partition: 'action',
      targetKey: target.key,
      runtimeEpoch,
      actionId: String(resolvedActionId),
    };
  }

  recordEvidence(command, args = {}, result, context = {}) {
    if (!result || typeof result !== 'object' || Buffer.isBuffer(result)) return [];
    const target = targetFor(command, args);
    const runtimeEpoch = this.observeRuntimeEpoch(
      target.key,
      result,
      context.runtimeEpoch || args.runtimeEpoch,
    );
    const descriptors = evidenceDescriptors(command, result);
    const references = [];
    for (const descriptor of descriptors) {
      const record = descriptor.record;
      const persistedRecord = shouldProjectPrivateUiEvidence(command, descriptor)
        ? privacyProjectUiEvidence(record)
        : record;
      const evidenceKey = record?.id === undefined || record?.id === null
        ? null
        : JSON.stringify([target.key, runtimeEpoch, descriptor.stream, String(record.id)]);
      if (evidenceKey && this.seenEvidence.has(evidenceKey)) continue;
      const evidenceTimestampMs = optionalTimestamp(
        record?.timestampMs ?? record?.updatedAtMs ?? result.updatedAtMs,
      );
      const observedAtMs = evidenceTimestampMs ?? this.now();
      const appended = this.cache.append(descriptor.partition, {
        targetKey: target.key,
        app: appIdentity(target, result),
        runtimeEpoch,
        actionId: actionIdForEvidence({
          context,
          fallbackActionId: args.requestId,
          runtimeActionId: record?.actionId,
          evidenceTimestampMs,
          completionGraceMs: this.actionCompletionGraceMs,
        }),
        ...(evidenceKey ? { dedupeKey: evidenceKey } : {}),
        timestamps: {
          occurredAtMs: observedAtMs,
          observedAtMs,
        },
        payload: {
          kind: 'evidence',
          stream: descriptor.stream,
          record: persistedRecord,
        },
      });
      references.push({
        partition: descriptor.partition,
        globalSeq: appended.globalSeq,
        stored: appended.stored,
        ...(appended.deduplicated ? { deduplicated: true } : {}),
      });
      if (evidenceKey) this.rememberEvidence(evidenceKey);
    }
    return references;
  }

  recordDeviceLog(args = {}, batch = {}, context = {}) {
    const command = 'logcat';
    const target = targetFor(command, args);
    const runtimeEpoch = this.observeRuntimeEpoch(
      target.key,
      null,
      context.runtimeEpoch || args.runtimeEpoch,
    );
    const evidenceTimestampMs = optionalTimestamp(batch.observedAtMs);
    const observedAtMs = evidenceTimestampMs ?? this.now();
    const appended = this.cache.append('device-log', {
      targetKey: target.key,
      app: appIdentity(target, null),
      runtimeEpoch,
      actionId: actionIdForEvidence({
        context,
        evidenceTimestampMs,
        completionGraceMs: this.actionCompletionGraceMs,
      }),
      timestamps: { occurredAtMs: observedAtMs, observedAtMs },
      payload: {
        kind: 'evidence',
        stream: 'logcat',
        record: {
          lines: Array.isArray(batch.lines) ? batch.lines : [],
          count: Number(batch.count || batch.lines?.length || 0),
          dropped: Number(batch.dropped || 0),
          buffers: Array.isArray(batch.buffers) ? batch.buffers : [],
        },
      },
    });
    return { ...appended, partition: 'device-log', targetKey: target.key };
  }

  readHistory(command, args = {}) {
    const target = targetFor(command, args);
    const history = historyDescriptor(command, args);
    if (!history) {
      return { ok: false, error: 'fact_history_unsupported', command };
    }
    const queried = this.cache.query({
      partitions: history.partitions,
      target: target.key,
      cursor: args.factCursor ?? args.cursor ?? null,
      limit: args.limit === undefined ? 100 : Number(args.limit),
    });
    if (!queried.ok) {
      return {
        ...queried,
        type: history.type,
        _factCache: {
          history: true,
          gap: Boolean(queried.gap),
          cursorExpired: Boolean(queried.cursorExpired),
        },
      };
    }
    const matching = queried.items.filter((fact) => (
      history.streams.has(fact.payload?.stream)
      || (history.includeActions && fact.partition === 'action' && fact.payload?.kind === 'execution')
    ));
    const items = matching.map((fact) => ({
      ...cloneRecord(fact.partition === 'action' ? fact.payload : fact.payload.record),
      _fact: {
        globalSeq: fact.globalSeq,
        partition: fact.partition,
        runtimeEpoch: fact.runtimeEpoch,
        actionId: fact.actionId,
        timestamps: fact.timestamps,
      },
    }));
    return {
      ok: true,
      type: history.type,
      items,
      count: items.length,
      limit: args.limit === undefined ? 100 : Number(args.limit),
      updatedAtMs: this.now(),
      _factCache: {
        history: true,
        cursor: queried.cursor,
        gap: false,
        cursorExpired: false,
        hasMore: queried.hasMore,
        scannedCount: queried.count,
        targetKey: target.key,
        partitions: history.partitions,
      },
    };
  }

  status() {
    return this.cache.status();
  }

  observeRuntimeEpoch(targetKey, result, explicitEpoch) {
    const discovered = explicitEpoch
      || result?.debugBridge?.runtimeEpoch
      || result?.runtimeEpoch
      || (result?.session?.connectedAtMs
        ? `web-${result.session.connectedAtMs}`
        : null);
    if (discovered) this.runtimeEpochs.set(targetKey, String(discovered));
    if (!this.runtimeEpochs.has(targetKey)) {
      this.runtimeEpochs.set(targetKey, `${this.hostEpoch}:${targetKey}`);
    }
    return this.runtimeEpochs.get(targetKey);
  }

  nextActionId() {
    this.actionSequence += 1;
    return `action-${this.now()}-${this.actionSequence}`;
  }

  rememberEvidence(key) {
    this.seenEvidence.add(key);
    this.seenEvidenceOrder.push(key);
    while (this.seenEvidenceOrder.length > this.maxSeenEvidence) {
      this.seenEvidence.delete(this.seenEvidenceOrder.shift());
    }
  }
}

function evidenceDescriptors(command, result) {
  const normalized = String(command || '').toLowerCase();
  const stream = captureStream(normalized);
  if (stream) {
    const items = Array.isArray(result.items) ? result.items : [];
    return items.map((record) => ({
      partition: partitionForStream(stream, record),
      stream,
      record,
    }));
  }
  if (UI_EVIDENCE_COMMANDS.has(normalized)) {
    return [{ partition: 'ui', stream: normalized, record: result }];
  }
  if (normalized.endsWith('status')) {
    return [{ partition: 'state-event', stream: normalized, record: result }];
  }
  return [];
}

function captureStream(command) {
  if (command === 'logs' || command === 'ios-logs' || command === 'web-logs') return 'logs';
  if (command === 'network' || command === 'ios-network' || command === 'web-network') return 'network';
  if (command === 'state' || command === 'ios-state' || command === 'web-state') return 'state';
  if (command === 'events' || command === 'ios-events' || command === 'web-events') return 'events';
  return null;
}

function partitionForStream(stream, record) {
  if (stream === 'logs') return 'app-log';
  if (stream === 'network') return 'network';
  if (stream === 'events' && isUiRecord(record)) return 'ui';
  return 'state-event';
}

function isUiRecord(record) {
  const category = String(record?.category || '').toLowerCase();
  const name = String(record?.name || '').toLowerCase();
  return category === 'ui'
    || category.startsWith('ui.')
    || name === 'ui.changed'
    || name === 'ui.stable'
    || name.startsWith('ui.');
}

function shouldProjectPrivateUiEvidence(command, descriptor) {
  const normalized = String(command || '').toLowerCase();
  return descriptor.partition === 'ui'
    || UI_EVIDENCE_COMMANDS.has(normalized)
    || normalized.endsWith('status');
}

function privacyProjectUiEvidence(record) {
  return projectPrivateUiValue(record, {
    inheritedSecure: false,
    ancestors: new WeakSet(),
  });
}

function projectPrivateUiValue(value, state) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { type: 'buffer', byteLength: value.length };
  if (state.ancestors.has(value)) return '[CIRCULAR]';

  state.ancestors.add(value);
  if (Array.isArray(value)) {
    const projected = value.map((entry) => projectPrivateUiValue(entry, {
      inheritedSecure: false,
      ancestors: state.ancestors,
    }));
    state.ancestors.delete(value);
    return projected;
  }

  const secure = state.inheritedSecure
    || hasAndroidPasswordInputType(value.inputType)
    || hasPasswordType(value)
    || hasSensitiveInputIdentity(value)
    || isTruePrivacyFlag(value.input?.secure)
    || hasDirectSecureFlag(value)
    || /\bisobscured\b|\bobscured\b/i.test(String(value.flags || ''));
  const projected = {};
  for (const [key, childValue] of Object.entries(value)) {
    if (secure && isSecureTextKey(key)) {
      projected[key] = REDACTED;
      projected[`${key}Length`] = secureTextLength(value, key, childValue);
      continue;
    }
    projected[key] = projectPrivateUiValue(childValue, {
      inheritedSecure: false,
      ancestors: state.ancestors,
    });
  }
  if (secure) projected.secure = true;
  state.ancestors.delete(value);
  return projected;
}

function hasAndroidPasswordInputType(value) {
  const inputType = Number(value);
  if (!Number.isSafeInteger(inputType)) return false;
  const inputClass = inputType & 0x0f;
  const variation = inputType & 0x0ff0;
  return (inputClass === 0x01 && [0x80, 0x90, 0xe0].includes(variation))
    || (inputClass === 0x02 && variation === 0x10);
}

function hasPasswordType(value) {
  return normalizePrivacyKey(value?.type) === 'password'
    || /password|passcode|secure/i.test(String(value?.inputType || ''))
    || [value?.className, value?.simpleClassName, value?.type, value?.role]
      .some((candidate) => /securetext|passwordfield|passwordinput/i.test(String(candidate || '')));
}

function hasSensitiveInputIdentity(value) {
  const inputShape = [
    value?.className,
    value?.simpleClassName,
    value?.tag,
    value?.role,
    value?.type,
  ].some((candidate) => (
    /edittext|textfield|textinput|securefield|searchfield|^input$|^textarea$|textbox/i
      .test(String(candidate || ''))
  ));
  if (!inputShape) return false;
  return [
    value?.resourceName,
    value?.resourceId,
    value?.id,
    value?.name,
    value?.identifier,
    value?.autocomplete,
    value?.textContentType,
    value?.placeholder,
  ].some((candidate) => (
    /password|passwd|pwd|passcode|current-password|new-password/i
      .test(String(candidate || ''))
  ));
}

function isTruePrivacyFlag(value) {
  return value === true || value === 1 || String(value).toLowerCase() === 'true';
}

function hasDirectSecureFlag(value) {
  return Object.entries(value).some(([key, flag]) => (
    SECURE_FLAG_KEYS.has(normalizePrivacyKey(key)) && isTruePrivacyFlag(flag)
  ));
}

function isSecureTextKey(key) {
  return SECURE_TEXT_KEYS.has(normalizePrivacyKey(key));
}

function secureTextLength(container, key, value) {
  const explicit = Number(container?.[`${key}Length`]);
  if (Number.isSafeInteger(explicit) && explicit >= 0) return explicit;
  if (typeof value === 'string') {
    const encodedLength = /^\[secure:length=(\d+)]$/i.exec(value.trim());
    if (encodedLength) return Number(encodedLength[1]);
    return value === REDACTED ? 0 : value.length;
  }
  if (Array.isArray(value) || Buffer.isBuffer(value)) return value.length;
  return value === null || value === undefined ? 0 : String(value).length;
}

function normalizePrivacyKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function historyDescriptor(command, args = {}) {
  const normalized = String(command || '').toLowerCase();
  const stream = captureStream(normalized);
  if (stream === 'logs') return descriptor('logs', ['app-log'], ['logs']);
  if (stream === 'network') return descriptor('network', ['network'], ['network']);
  if (stream === 'state') return descriptor('state', ['state-event'], ['state']);
  if (stream === 'events') {
    const includeActions = args.includeActions === true || args.includeActions === 'true';
    return descriptor(
      'events',
      includeActions ? ['ui', 'state-event', 'action'] : ['ui', 'state-event'],
      ['events'],
      { includeActions },
    );
  }
  if (normalized === 'logcat') return descriptor('logcat', ['device-log'], ['logcat']);
  if (UI_EVIDENCE_COMMANDS.has(normalized)) return descriptor(normalized, ['ui'], [normalized]);
  return null;
}

function descriptor(type, partitions, streams, extra = {}) {
  return { type, partitions, streams: new Set(streams), ...extra };
}

function summarizeArgs(args, depth = 0, ancestors = new WeakSet()) {
  if (!args || typeof args !== 'object') return {};
  if (ancestors.has(args)) return '[circular]';
  ancestors.add(args);
  const result = {};
  for (const [key, value] of Object.entries(args || {})) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (['text', 'value', 'script', 'payload', 'requestbody', 'responsebody'].includes(normalized)) {
      result[`${key}Length`] = value === undefined || value === null ? 0 : String(value).length;
      continue;
    }
    result[key] = boundedValue(value, depth + 1, ancestors);
  }
  ancestors.delete(args);
  return result;
}

function boundedValue(value, depth, ancestors = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.slice(0, 300);
  if (typeof value !== 'object') return value;
  if (depth >= 3) return '[truncated]';
  if (ancestors.has(value)) return '[circular]';
  if (Array.isArray(value)) {
    ancestors.add(value);
    const result = value.slice(0, 20).map((item) => boundedValue(item, depth + 1, ancestors));
    ancestors.delete(value);
    return result;
  }
  return summarizeArgs(value, depth, ancestors);
}

function summarizeResult(result) {
  if (result === undefined || result === null) return null;
  if (typeof result !== 'object' || Buffer.isBuffer(result)) {
    return { type: Buffer.isBuffer(result) ? 'buffer' : typeof result };
  }
  const summary = {};
  for (const key of [
    'ok', 'error', 'message', 'action', 'source', 'transport', 'activity', 'component',
    'path', 'count', 'nodeCount', 'sessionId', 'targetId', 'packageName', 'bundleId',
    'textLength', 'matched', 'target', 'windowType', 'x', 'y', 'handledDown', 'handledUp',
    'verified', 'inconclusive',
  ]) {
    if (result[key] !== undefined) summary[key] = boundedValue(result[key], 0);
  }
  return summary;
}

function appIdentity(target, result) {
  return {
    ...(result?.app && typeof result.app === 'object' ? result.app : {}),
    kind: target.kind,
    ...(target.serial !== undefined ? { serial: target.serial } : {}),
    ...(target.packageName !== undefined ? { packageName: target.packageName } : {}),
    ...(target.deviceId !== undefined ? { deviceId: target.deviceId } : {}),
    ...(target.bundleId !== undefined ? { bundleId: target.bundleId } : {}),
    ...(target.sessionId !== undefined ? { sessionId: target.sessionId } : {}),
    ...(target.targetId !== undefined ? { targetId: target.targetId } : {}),
  };
}

function executionStatus(result, error) {
  if (error || result?.ok === false) return 'failed';
  if (result?.verified === true) return 'verified';
  if (result === undefined || result === null || result?.inconclusive === true) return 'inconclusive';
  return 'completed';
}

function finiteTimestamp(value, fallback) {
  return optionalTimestamp(value) ?? fallback;
}

function optionalTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function actionIdForEvidence({
  context = {},
  fallbackActionId,
  runtimeActionId,
  evidenceTimestampMs,
  completionGraceMs,
}) {
  const explicitRuntimeActionId = nullableActionId(runtimeActionId);
  if (explicitRuntimeActionId !== null) return explicitRuntimeActionId;
  const timeline = normalizedActionTimeline(context.actionTimeline);
  const explicitActionId = context.actionId ?? fallbackActionId ?? null;
  if (evidenceTimestampMs === null) {
    return latestTimelineActionId(timeline) ?? nullableActionId(explicitActionId);
  }
  if (timeline.length === 0) return nullableActionId(explicitActionId);

  const exact = timeline.filter((action) => timestampInActionInterval(action, evidenceTimestampMs, timeline));
  if (exact.length === 1) return exact[0].actionId;
  if (exact.length > 1) return null;

  const grace = timeline.filter((action) => timestampInCompletionGrace(
    action,
    evidenceTimestampMs,
    timeline,
    completionGraceMs,
  ));
  return grace.length === 1 ? grace[0].actionId : null;
}

function normalizedActionTimeline(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    const actionId = nullableActionId(candidate?.actionId);
    const requestedAtMs = optionalTimestamp(candidate?.requestedAtMs);
    const startedAtMs = optionalTimestamp(candidate?.startedAtMs);
    const completedAtMs = optionalTimestamp(candidate?.completedAtMs);
    const startAtMs = startedAtMs ?? (completedAtMs === null ? null : requestedAtMs);
    if (
      actionId === null
      || (requestedAtMs === null && startedAtMs === null && completedAtMs === null)
    ) return [];
    return [{
      actionId,
      requestedAtMs,
      startedAtMs,
      completedAtMs,
      startAtMs,
      order: index,
    }];
  });
}

function timestampInActionInterval(action, timestampMs, timeline) {
  if (action.startAtMs === null || timestampMs < action.startAtMs) return false;
  if (action.completedAtMs !== null) return timestampMs <= action.completedAtMs;
  const nextStartAtMs = nextActionStartAtMs(action, timeline);
  return nextStartAtMs === null || timestampMs < nextStartAtMs;
}

function timestampInCompletionGrace(action, timestampMs, timeline, completionGraceMs) {
  if (action.completedAtMs === null || timestampMs <= action.completedAtMs) return false;
  if (timestampMs > action.completedAtMs + completionGraceMs) return false;
  const nextStartAtMs = nextActionStartAtMs(action, timeline);
  return nextStartAtMs === null || timestampMs < nextStartAtMs;
}

function nextActionStartAtMs(action, timeline) {
  let next = null;
  for (const candidate of timeline) {
    if (
      candidate === action
      || candidate.startAtMs === null
      || candidate.startAtMs <= action.startAtMs
    ) continue;
    if (next === null || candidate.startAtMs < next) next = candidate.startAtMs;
  }
  return next;
}

function latestTimelineActionId(timeline) {
  let latest = null;
  for (const action of timeline) {
    const atMs = action.completedAtMs ?? action.startedAtMs ?? action.requestedAtMs;
    if (atMs === null) continue;
    if (!latest || atMs > latest.atMs || (atMs === latest.atMs && action.order > latest.order)) {
      latest = { actionId: action.actionId, atMs, order: action.order };
    }
  }
  return latest?.actionId ?? null;
}

function nullableActionId(value) {
  return value === undefined || value === null ? null : String(value);
}

function cloneRecord(record) {
  if (!record || typeof record !== 'object') return { value: record };
  return JSON.parse(JSON.stringify(record));
}

module.exports = {
  FactRecorder,
  captureStream,
  historyDescriptor,
  isUiRecord,
  summarizeArgs,
};
