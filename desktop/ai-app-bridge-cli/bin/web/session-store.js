'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { getHostFactStore } = require('../shared-kernel/host-fact-store');
const { sanitizePersistentValue } = require('../fact-codec');
const { CommandError } = require('../command-errors');

const partitions = { logs: 'app-log', network: 'network', state: 'state-event', events: 'state-event', dom: 'ui', completion: 'action', 'capture-barrier': 'action' };
const maxRecordBytes = 128 * 1024;
const maxPageRecords = 16;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (target, stream) => `web:${JSON.stringify([target.sessionId, target.targetId, stream])}`;

// Web facts are Host-owned. Every ingress is committed through the existing
// FactStore; sessions keep connection metadata, never another payload cache.
class WebSessionStore {
  constructor(getStore = getHostFactStore) { this.getStore = getStore; }

  record(target, stream, item, { captureId, actionId = null } = {}) {
    if (!partitions[stream]) throw new CommandError('invalid_web_stream', 'Unknown Web capture stream.');
    const payload = { schemaVersion: 'aab.web-fact/v1', stream, ...target, captureId, item };
    if (Buffer.byteLength(JSON.stringify(payload)) > maxRecordBytes)
      throw new CommandError('web_record_too_large', 'Web facts must not exceed 128 KiB.');
    const result = this.getStore().record({ partition: partitions[stream], targetKey: key(target, stream),
      runtimeEpoch: target.runtimeEpoch, actionId, dedupeKey: `${key(target, stream)}:${target.runtimeEpoch}:${captureId}:${digest(payload)}`,
      payload }, { durability: 'sync' });
    const receipt = result.receipt;
    if (result.ok !== true || receipt?.stored !== true)
      throw new CommandError('web_persistence_unavailable', 'The Web fact was not committed; no memory result is substituted.');
    return { stored: true, source: 'host-fact-store', globalSeq: receipt.globalSeq,
      targetKey: key(target, stream), runtimeEpoch: target.runtimeEpoch, captureId,
      representation: 'fact-store-redacted', originalSha256: digest(payload), storedSha256: digest(sanitizePersistentValue(payload)) };
  }

  read(target, stream, args = {}) {
    const limit = args.limit ?? maxPageRecords;
    if (!partitions[stream] || !Number.isInteger(limit) || limit < 1 || limit > maxPageRecords)
      throw new CommandError('invalid_web_query', 'Web capture queries require a known stream and limit from 1 to 16.');
    const query = { targetKey: key(target, stream), runtimeEpoch: target.runtimeEpoch,
      partitions: [partitions[stream]], limit,
      ...(args.sinceMs === undefined ? {} : { fromObservedAtMs: args.sinceMs }) };
    const store = this.getStore();
    const upper = args.throughCursor === undefined
      ? store.read({ ...query, fromObservedAtMs: Number.MAX_SAFE_INTEGER, limit: 1 }) : null;
    if (upper && upper.ok !== true) return upper;
    const throughCursor = args.throughCursor ?? upper.cursor;
    const page = store.read({ ...query, cursor: args.cursor, throughCursor });
    if (!page.ok) return page;
    const items = page.items.map(fact => {
      const value = fact.payload;
      if (value?.schemaVersion !== 'aab.web-fact/v1' || value.stream !== stream
          || !isDeepStrictEqual({ sessionId: value.sessionId, runtimeEpoch: value.runtimeEpoch, targetId: value.targetId }, target))
        throw new CommandError('invalid_web_fact', 'Stored Web fact does not match the requested document.');
      return { ...value.item, id: fact.globalSeq, captureId: value.captureId, actionId: fact.actionId,
        sessionId: target.sessionId, runtimeEpoch: target.runtimeEpoch, targetId: target.targetId,
        receivedAtMs: fact.timestamps.observedAtMs,
        ref: { source: 'host-fact-store', stream, globalSeq: fact.globalSeq, targetKey: fact.targetKey, runtimeEpoch: fact.runtimeEpoch } };
    });
    // State is a stream of recorded updates. Values describes this returned
    // page only; it is not a fabricated snapshot of every current App key.
    return { ok: true, type: stream, ...target, source: 'host-fact-store', persistence: true,
      history: args.history === true, items, count: items.length, ...(stream === 'state' ? { values: stateValues(items) } : {}),
      cursor: page.cursor, throughCursor, hasMore: page.hasMore, gap: page.gap, cursorExpired: page.cursorExpired };
  }

  saveCaptureBarrier(target, stream, status) {
    const upper = this.getStore().read({ targetKey: key(target, stream), runtimeEpoch: target.runtimeEpoch,
      partitions: [partitions[stream]], fromObservedAtMs: Number.MAX_SAFE_INTEGER, limit: 1 });
    if (upper.ok !== true) throw new CommandError(upper.error, 'The capture watermark could not be read.');
    const id = randomUUID();
    const value = { stream, cursor: upper.cursor, ...status };
    const receipt = this.record(target, 'capture-barrier', value, { captureId: id, actionId: id });
    return { ...value, token: `wc1:${id}`, globalSeq: receipt.globalSeq };
  }

  captureBarrier(target, stream, token) {
    if (typeof token !== 'string' || !/^wc1:[a-f0-9-]{36}$/.test(token))
      throw new CommandError('invalid_web_capture_cursor', 'Use a watermark issued for this document and stream.');
    const page = this.getStore().read({ partitions: ['action'], targetKey: key(target, 'capture-barrier'),
      runtimeEpoch: target.runtimeEpoch, actionId: token.slice(4), limit: 2 });
    if (page.ok !== true || page.items.length !== 1)
      throw new CommandError('web_capture_cursor_unavailable', 'The original persisted capture watermark is unavailable.');
    const fact = page.items[0], value = fact.payload;
    if (value?.schemaVersion !== 'aab.web-fact/v1' || value.stream !== 'capture-barrier'
      || value.item.stream !== stream || value.sessionId !== target.sessionId
      || value.runtimeEpoch !== target.runtimeEpoch || value.targetId !== target.targetId)
      throw new CommandError('web_capture_cursor_mismatch', 'The capture watermark belongs to another document or stream.');
    return { ...value.item, token, globalSeq: fact.globalSeq };
  }

  readWindow(target, stream, args, through) {
    const before = args.factCursor === undefined ? null : this.captureBarrier(target, stream, args.factCursor);
    if (args.afterActionId !== undefined && before === null)
      throw new CommandError('decision_watermark_required', 'Observe a capture watermark before the action.');
    if (before && before.globalSeq > through.globalSeq)
      throw new CommandError('invalid_web_capture_window', 'The upper watermark precedes the lower watermark.');
    const page = this.read(target, stream, { ...args,
      cursor: args.cursor ?? before?.cursor, throughCursor: through.cursor });
    if (page.ok !== true) return page;
    const reasons = [];
    if (before && before.connectionId !== through.connectionId) reasons.push('web_capture_connection_changed');
    const sdkProduced = through.sdk.sequence - (before?.sdk.sequence ?? 0);
    const hostAccepted = through.host.accepted - (before?.host.accepted ?? 0);
    if (sdkProduced !== hostAccepted || through.host.lastSequence !== through.sdk.sequence)
      reasons.push('web_capture_sequence_gap');
    if (through.sdk.losses !== (before?.sdk.losses ?? 0)
      || through.host.rejected !== (before?.host.rejected ?? 0)) reasons.push('web_capture_loss');
    const gap = reasons.length > 0 || page.gap;
    if (through.sdk.pending > 0) reasons.push('web_capture_pending');
    const items = args.afterActionId === undefined ? page.items : page.items.filter(item => item.actionId === args.afterActionId);
    return { ...page, items, count: items.length, ...(stream === 'state' ? { values: stateValues(items) } : {}),
      refs: items.map(item => item.ref), stream,
      targetKey: key(target, stream), runtimeEpoch: target.runtimeEpoch,
      coverage: { status: reasons.length ? 'partial' : 'complete', gap, committed: true,
        scope: 'sdk-captures-through-barrier', reasons }, gap, committed: true,
      window: { filterApplied: true, afterActionId: args.afterActionId ?? null,
        factCursor: args.factCursor ?? null, sinceId: null, sinceMs: args.sinceMs ?? null,
        targetKey: key(target, stream), runtimeEpoch: target.runtimeEpoch },
      watermarkCursor: through.token, throughWatermark: through.globalSeq,
      nextCursor: page.hasMore ? page.cursor : null, throughCursor: through.token,
      barrier: { schemaVersion: 'aab.web-capture-window/v1',
        lower: before === null ? null : { sdk: before.sdk, host: before.host, connectionId: before.connectionId },
        upper: { sdk: through.sdk, host: through.host, connectionId: through.connectionId } },
    };
  }

  saveCompletion(target, result) {
    return this.record(target, 'completion', { result, originalSha256: digest(result) },
      { captureId: result.actionId, actionId: result.actionId });
  }

  completion(target, actionId) {
    const page = this.getStore().read({ partitions: ['action'], targetKey: key(target, 'completion'),
      runtimeEpoch: target.runtimeEpoch, actionId, limit: 2 });
    if (!page.ok) return page;
    if (page.items.length !== 1) return { ok: false, error: 'web_original_completion_unavailable', settled: false };
    const fact = page.items[0], payload = fact.payload;
    if (payload?.schemaVersion !== 'aab.web-fact/v1' || payload.stream !== 'completion'
        || !isDeepStrictEqual({ sessionId: payload.sessionId, runtimeEpoch: payload.runtimeEpoch, targetId: payload.targetId }, target)
        || payload.item?.result?.actionId !== actionId)
      return { ok: false, error: 'invalid_web_completion', settled: false };
    return { ok: true, actionId, runtimeEpoch: target.runtimeEpoch, executionResult: payload.item.result,
      receipt: { stored: true, globalSeq: fact.globalSeq, source: 'host-fact-store', originalSha256: payload.item.originalSha256 } };
  }
}

function stateValues(items) {
  const values = {};
  for (const item of items) {
    if (!Object.hasOwn(values, item.namespace)) Object.defineProperty(values, item.namespace, { value: {}, enumerable: true });
    Object.defineProperty(values[item.namespace], item.key, { value: item.value, enumerable: true, configurable: true });
  }
  return values;
}

module.exports = { WebSessionStore, maxRecordBytes, maxPageRecords, digest };
