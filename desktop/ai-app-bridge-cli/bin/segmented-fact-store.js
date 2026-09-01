'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { normalizePersistentFact } = require('./fact-codec');
const { MmapScanIndex } = require('./mmap-scan-index');
const { SegmentIndex } = require('./segment-index');

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const MINIMUM_SAFETY_RESERVE = 256 * MIB;
const DEFAULT_PROJECTION_BUDGET_BYTES = GIB;
const PARTITION_ALL = 0xffff_ffff;
const NATIVE_SEGMENT_OVERHEAD_BYTES = 96;
const LARGE_FACT_CHUNK_MAGIC = Buffer.from('AIBCHN01', 'ascii');
const LARGE_FACT_CHUNK_VERSION = 1;
const LARGE_FACT_CHUNK_HEADER_BYTES = 72;
const LARGE_FACT_MANIFEST_KIND = 'ai-app-bridge.large-fact-manifest.v1';
const LARGE_FACT_LOGICAL_BYTES = '__aiAppBridgeLogicalPayloadBytes';
const LARGE_FACT_WIRE_V1 = Object.freeze({
  chunkMagicAscii: LARGE_FACT_CHUNK_MAGIC.toString('ascii'),
  chunkVersion: LARGE_FACT_CHUNK_VERSION,
  chunkHeaderBytes: LARGE_FACT_CHUNK_HEADER_BYTES,
  manifestMarkerField: '__aiAppBridgeInternal',
  manifestMarkerValue: LARGE_FACT_MANIFEST_KIND,
});
const FACT_STORE_PROFILES = Object.freeze({
  '1gb': 1024 * 1024 * 1024,
  '512mb': 512 * 1024 * 1024,
  '256mb': 256 * 1024 * 1024,
  '64mb': 64 * 1024 * 1024,
});
const SEGMENT_SIZE_BY_PROFILE = Object.freeze({
  '1gb': 4 * 1024 * 1024,
  '512mb': 4 * 1024 * 1024,
  '256mb': 2 * 1024 * 1024,
  '64mb': 512 * 1024,
});
const PARTITIONS = Object.freeze([
  'network',
  'ui',
  'app-log',
  'device-log',
  'state-event',
  'action',
  'note',
  'index',
]);
const PARTITION_IDS = Object.freeze(Object.fromEntries(PARTITIONS.map((name, index) => [name, index])));
// Ten percent remains outside mmap segment quotas for manifests, recovery and
// critical control operations. The Host query projection has a separate 1 GiB
// budget and is never charged to this reserve.
const PARTITION_WEIGHTS = Object.freeze({
  network: 25,
  ui: 18,
  'app-log': 10,
  'device-log': 7,
  'state-event': 10,
  action: 13,
  note: 5,
  index: 2,
});
class NativeSegmentEngine {
  constructor({
    binding = loadNativeBinding(),
    directory,
    segmentSize,
    partitionQuotas,
    inheritExistingConfiguration = false,
  }) {
    this.binding = binding;
    this.handle = binding.open(inheritExistingConfiguration
      ? { directory, segmentSize: 0 }
      : { directory, segmentSize, partitionQuotas });
    this.closed = false;
  }

  append(partitionId, payload, options = {}) {
    this.assertOpen();
    return numericRecord(this.binding.append(
      this.handle,
      partitionId,
      payload,
      options.durability === 'sync',
    ));
  }

  scan(cursor = {}) {
    this.assertOpen();
    const result = this.binding.scan(this.handle, cursor);
    return {
      ...result,
      cursor: numericCursor(result.cursor),
      ...(result.record ? { record: numericRecord(result.record) } : {}),
    };
  }

  readAt(location) {
    const result = this.scan({
      partitionId: PARTITION_IDS[location.partition],
      afterSequence: location.sequence - 1,
      segmentId: location.segmentId,
      offset: location.frameOffset,
    });
    if (result.done || result.record.sequence !== location.sequence) {
      const error = new Error(`segment record ${location.sequence} is no longer available`);
      error.code = 'segment_location_expired';
      throw error;
    }
    return result;
  }

  status() {
    this.assertOpen();
    return numericTree(this.binding.status(this.handle));
  }

  flush() {
    this.assertOpen();
    this.binding.flush(this.handle);
  }

  close() {
    if (this.closed) return;
    this.binding.close(this.handle);
    this.closed = true;
  }

  assertOpen() {
    if (this.closed) throw new Error('NativeSegmentEngine is closed');
  }
}

class DisabledSegmentedFactStoreAdapter {
  constructor({ directory, storageCapacity, reason = 'insufficient-space' } = {}) {
    this.directory = path.resolve(directory || defaultSegmentedFactStorePath());
    this.storageCapacity = normalizeStorageCapacity(storageCapacity);
    this.reason = reason;
    this.closed = false;
    this.droppedRecords = 0;
  }

  record() {
    this.droppedRecords += 1;
    return {
      ok: false,
      stored: false,
      dropped: true,
      error: 'fact_store_disabled',
      reason: this.reason,
    };
  }

  read() {
    return {
      ok: false,
      error: 'fact_store_disabled',
      message: `Segmented FactStore is disabled: ${this.reason}.`,
      items: [],
      count: 0,
      gap: false,
      cursorExpired: false,
      hasMore: false,
    };
  }

  status() {
    return {
      ok: true,
      adapter: 'segmented-mmap-disabled',
      authoritative: true,
      persistence: false,
      degraded: true,
      profile: 'off-low-disk',
      profileSelection: { mode: 'auto', ...this.storageCapacity },
      budgetBytes: 0,
      segmentSize: 0,
      directory: this.directory,
      disabledReason: this.reason,
      droppedRecords: this.droppedRecords,
      closed: this.closed,
    };
  }

  close() {
    this.closed = true;
  }
}

class SegmentedFactStoreAdapter {
  constructor(options = {}) {
    this.directory = path.resolve(options.directory || defaultSegmentedFactStorePath());
    const requestedProfile = normalizeProfile(options.profile);
    const storageCapacity = requestedProfile === 'auto'
      ? normalizeStorageCapacity(options.storageCapacity || readStorageCapacity(this.directory))
      : null;
    const capacityCandidate = requestedProfile === 'auto' ? selectAutomaticProfile(storageCapacity) : null;
    this.profile = capacityCandidate || requestedProfile;
    this.budgetBytes = positiveInteger(options.budgetBytes, FACT_STORE_PROFILES[this.profile], 'budgetBytes');
    if (options.budgetBytes !== undefined && this.budgetBytes !== FACT_STORE_PROFILES[this.profile]) {
      this.profile = 'custom';
    }
    this.profileSelection = requestedProfile === 'auto'
      ? { mode: 'auto', ...storageCapacity }
      : { mode: 'explicit' };
    this.projectionBudgetBytes = positiveInteger(
      options.projectionBudgetBytes,
      DEFAULT_PROJECTION_BUDGET_BYTES,
      'projectionBudgetBytes',
    );
    this.segmentSize = positiveInteger(
      options.segmentSize,
      SEGMENT_SIZE_BY_PROFILE[this.profile] || Math.min(512 * 1024, this.budgetBytes),
      'segmentSize',
    );
    this.partitionQuotas = options.partitionQuotas
      ? normalizePartitionQuotas(options.partitionQuotas, this.segmentSize)
      : partitionQuotas(this.budgetBytes, this.segmentSize);
    const allocatedBytes = this.partitionQuotas.reduce((sum, quota) => sum + quota, 0);
    if (allocatedBytes > this.budgetBytes) {
      throw new RangeError('partitionQuotas exceed budgetBytes');
    }
    this.segmentsDirectory = path.join(this.directory, 'segments');
    const inheritExistingConfiguration = requestedProfile === 'auto'
      && options.budgetBytes === undefined
      && options.segmentSize === undefined
      && options.partitionQuotas === undefined
      && hasCommittedManifest(this.segmentsDirectory);
    this.indexDirectory = path.join(this.directory, 'projection');
    this.removeProjection = typeof options.removeProjection === 'function'
      ? options.removeProjection
      : () => fs.rmSync(this.indexDirectory, { recursive: true, force: true });
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    restrictDirectory(this.directory);
    this.index = null;
    this.engine = null;
    this.ownsIndex = !options.index;
    this.projectionFallback = null;
    this.projectionInitializationError = null;
    this.projectionCheckInterval = positiveInteger(
      options.projectionCheckInterval,
      1,
      'projectionCheckInterval',
    );
    this.projectionWritesSinceCheck = 0;
    this.lastPrunedFirstSequence = Array(PARTITIONS.length).fill(0);
    this.closed = false;
    try {
      if (options.index) {
        this.index = options.index;
      } else {
        try {
          this.index = new SegmentIndex({
            directory: this.indexDirectory,
            budgetBytes: this.projectionBudgetBytes,
            ...(Object.prototype.hasOwnProperty.call(options, 'sqliteModule')
              ? { sqliteModule: options.sqliteModule }
              : {}),
          });
        } catch (error) {
          this.projectionFallback = {
            code: error?.code || error?.name || 'sqlite_projection_unavailable',
            message: String(error?.message || error),
          };
          this.projectionInitializationError = error;
          this.index = null;
        }
      }
      this.engine = options.engine || new NativeSegmentEngine({
        binding: options.binding,
        directory: this.segmentsDirectory,
        segmentSize: this.segmentSize,
        partitionQuotas: this.partitionQuotas,
        inheritExistingConfiguration,
      });
      if (inheritExistingConfiguration) {
        const engineStatus = this.engine.status();
        const inheritedSegmentSize = positiveInteger(
          engineStatus.segmentSize,
          undefined,
          'existing segmentSize',
        );
        const inheritedQuotas = existingPartitionQuotas(engineStatus);
        const inheritedProfile = profileForConfiguration(inheritedSegmentSize, inheritedQuotas);
        this.segmentSize = inheritedSegmentSize;
        this.partitionQuotas = inheritedQuotas;
        this.profile = inheritedProfile || 'custom';
        this.budgetBytes = inheritedProfile
          ? FACT_STORE_PROFILES[inheritedProfile]
          : inheritedQuotas.reduce((sum, quota) => sum + quota, 0);
        this.profileSelection = {
          mode: 'auto-existing',
          capacityCandidate,
          ...storageCapacity,
        };
      }
      if (!this.index) {
        this.activateMmapScanProjection(
          this.projectionInitializationError,
          'startup-open',
          { forceScanOnly: true },
        );
      } else try {
        this.cursorSecret = this.index.metadata('cursor-secret', () => crypto.randomBytes(32).toString('base64url'));
        this.storeId = this.index.metadata('store-id', () => crypto.randomUUID());
        this.recovery = this.reconcileProjection();
        this.maintainProjectionBudget({ force: true });
      } catch (error) {
        if (!this.ownsIndex) throw error;
        this.activateMmapScanProjection(error, 'startup-reconcile', { forceScanOnly: true });
      }
    } catch (error) {
      this.closed = true;
      try {
        this.engine?.close();
      } catch (_) {
        // Preserve the construction error.
      }
      try {
        this.index?.close();
      } catch (_) {
        // Preserve the construction error.
      }
      throw error;
    }
  }

  record(fact, options = {}) {
    this.assertOpen();
    const normalized = normalizePersistentFact(fact);
    const partitionId = PARTITION_IDS[normalized.partition];
    if (partitionId === undefined) {
      throw new TypeError(`partition must be one of: ${PARTITIONS.join(', ')}`);
    }
    let projectionDegraded = false;
    if (normalized.dedupeKey) {
      let existing;
      try {
        existing = this.index.findDedupe(normalized.dedupeKey);
      } catch (error) {
        this.activateMmapScanProjection(error, 'dedupe-read', { forceScanOnly: true });
        projectionDegraded = true;
        existing = this.index.findDedupe(normalized.dedupeKey);
      }
      if (existing) {
        return {
          ok: true,
          stored: true,
          deduplicated: true,
          globalSeq: existing.sequence,
          partition: existing.partition,
          targetKey: existing.targetKey,
          runtimeEpoch: existing.runtimeEpoch,
          actionId: existing.actionId,
          sizeBytes: existing.payloadLength,
          evictedCount: 0,
          ...(projectionDegraded ? { projectionDegraded: true } : {}),
        };
      }
    }
    const payload = Buffer.from(JSON.stringify(normalized));
    const critical = normalized.partition === 'action';
    const durability = options.durability || (critical ? 'sync' : 'memory');
    const location = this.appendLogicalFact(partitionId, normalized, payload, { durability });
    let evictedCount = 0;
    try {
      const engineStatus = this.engine.status();
      evictedCount = this.pruneEvictedProjection(engineStatus.partitions);
      this.index.insert(normalized, {
        sequence: location.sequence,
        segmentId: location.segmentId,
        frameOffset: location.frameOffset,
        payloadLength: location.payloadLength,
      });
      this.updateProjectionCheckpoint(engineStatus);
      const maintenance = this.maintainProjectionBudget();
      projectionDegraded ||= maintenance.degraded;
    } catch (error) {
      try {
        this.activateMmapScanProjection(error, 'post-commit', {
          failedSequence: location.sequence,
        });
        projectionDegraded = true;
      } catch (fallbackError) {
        const wrapped = new Error(`fact committed but every query projection failed: ${fallbackError.message}`);
        wrapped.code = 'segment_commit_index_unknown';
        wrapped.sequence = location.sequence;
        wrapped.cause = fallbackError;
        throw wrapped;
      }
    }
    return {
      ok: true,
      stored: true,
      globalSeq: location.sequence,
      partition: normalized.partition,
      targetKey: normalized.targetKey,
      runtimeEpoch: normalized.runtimeEpoch,
      actionId: normalized.actionId,
      sizeBytes: payload.length,
      evictedCount,
      durability: critical ? 'sync' : 'memory',
      segmentId: location.segmentId,
      frameOffset: location.frameOffset,
      ...(projectionDegraded ? {
        projectionDegraded: true,
        projectionFallbackCode: this.projectionFallback?.code,
      } : {}),
    };
  }

  appendLogicalFact(partitionId, normalized, payload, { durability }) {
    const maxNativePayload = this.segmentSize - NATIVE_SEGMENT_OVERHEAD_BYTES;
    if (payload.length <= maxNativePayload) {
      return this.engine.append(partitionId, payload, { durability });
    }
    const maxChunkBytes = maxNativePayload - LARGE_FACT_CHUNK_HEADER_BYTES;
    if (maxChunkBytes <= 0) {
      throw new RangeError('segmentSize is too small for a large-fact chunk header');
    }
    const digest = crypto.createHash('sha256').update(payload).digest();
    const chunkCount = Math.ceil(payload.length / maxChunkBytes);
    const slices = [];
    for (let ordinal = 0; ordinal < chunkCount; ordinal += 1) {
      const start = ordinal * maxChunkBytes;
      slices.push(payload.subarray(start, Math.min(payload.length, start + maxChunkBytes)));
    }
    const manifestUpperBound = Buffer.from(JSON.stringify(createLargeFactManifest({
      normalized,
      digest,
      byteLength: payload.length,
      chunks: slices.map((bytes, ordinal) => ({
        ordinal,
        sequence: Number.MAX_SAFE_INTEGER,
        segmentId: Number.MAX_SAFE_INTEGER,
        frameOffset: Number.MAX_SAFE_INTEGER,
        payloadLength: LARGE_FACT_CHUNK_HEADER_BYTES + bytes.length,
        byteLength: bytes.length,
      })),
    })));
    if (manifestUpperBound.length > maxNativePayload) {
      const error = new RangeError('large fact manifest does not fit in an empty segment');
      error.code = 'large_fact_manifest_too_large';
      throw error;
    }
    this.assertLargeFactCapacity(partitionId, [
      ...slices.map((bytes) => LARGE_FACT_CHUNK_HEADER_BYTES + bytes.length),
      manifestUpperBound.length,
    ]);

    const chunks = [];
    for (let ordinal = 0; ordinal < slices.length; ordinal += 1) {
      const bytes = slices[ordinal];
      const chunkPayload = encodeLargeFactChunk({
        digest,
        ordinal,
        chunkCount,
        totalLength: payload.length,
        bytes,
      });
      const location = this.engine.append(partitionId, chunkPayload, { durability: 'memory' });
      chunks.push({
        ordinal,
        sequence: location.sequence,
        segmentId: location.segmentId,
        frameOffset: location.frameOffset,
        payloadLength: location.payloadLength,
        byteLength: bytes.length,
      });
    }
    const manifestPayload = Buffer.from(JSON.stringify(createLargeFactManifest({
      normalized,
      digest,
      byteLength: payload.length,
      chunks,
    })));
    const manifestLocation = this.engine.append(partitionId, manifestPayload, { durability });
    return {
      ...manifestLocation,
      payloadLength: payload.length,
    };
  }

  assertLargeFactCapacity(partitionId, payloadLengths) {
    const status = this.engine.status();
    const partition = status.partitions[partitionId];
    const maxSegments = Math.floor(this.partitionQuotas[partitionId] / this.segmentSize);
    let hasSegment = Number(partition?.segmentCount || 0) > 0;
    let offset = hasSegment ? Number(partition.activeWriteOffset) : 64;
    let currentSegmentContainsFact = false;
    let factSegments = 0;
    for (const payloadLength of payloadLengths) {
      const frameLength = nativeFrameLength(payloadLength);
      if (!hasSegment || offset > this.segmentSize - frameLength) {
        hasSegment = true;
        offset = 64;
        currentSegmentContainsFact = false;
      }
      if (!currentSegmentContainsFact) {
        factSegments += 1;
        currentSegmentContainsFact = true;
      }
      offset += frameLength;
    }
    if (factSegments > maxSegments) {
      const error = new RangeError(
        `large fact needs ${factSegments} segments but partition ${PARTITIONS[partitionId]} retains ${maxSegments}`,
      );
      error.code = 'large_fact_exceeds_partition_quota';
      error.requiredSegments = factSegments;
      error.availableSegments = maxSegments;
      throw error;
    }
  }

  read(query = {}) {
    this.assertOpen();
    const normalized = normalizeReadQuery(query);
    const scope = cursorScope(normalized);
    const decoded = normalized.cursor === null
      ? { ok: true, sequence: 0 }
      : decodeCursor(normalized.cursor, scope, this.cursorSecret, this.storeId);
    if (!decoded.ok) {
      return {
        ok: false,
        error: 'invalid_cursor',
        message: decoded.message,
        items: [],
        count: 0,
        gap: false,
        cursorExpired: false,
      };
    }
    const decodedThrough = normalized.throughCursor === null
      ? { ok: true, sequence: null }
      : decodeCursor(normalized.throughCursor, scope, this.cursorSecret, this.storeId);
    if (!decodedThrough.ok) {
      return {
        ok: false,
        error: 'invalid_through_cursor',
        message: decodedThrough.message,
        items: [],
        count: 0,
        gap: false,
        cursorExpired: false,
      };
    }
    const engineStatus = this.engine.status();
    const gap = cursorGap(decoded.sequence, normalized.partitions, engineStatus.partitions);
    try {
      this.pruneEvictedProjection(engineStatus.partitions);
    } catch (error) {
      this.activateMmapScanProjection(error, 'query-prune', { forceScanOnly: true });
      return this.read(query);
    }
    if (normalized.cursor !== null && gap) {
      return {
        ok: false,
        error: 'cursor_expired',
        message: 'Facts after this cursor have been evicted from one or more partitions.',
        items: [],
        count: 0,
        gap: true,
        cursorExpired: true,
        evictedPartitions: gap,
      };
    }
    let located;
    try {
      located = this.index.query({
        afterSequence: decoded.sequence,
        throughSequence: decodedThrough.sequence,
        targetKey: normalized.targetKey,
        partitions: normalized.partitions,
        runtimeEpoch: normalized.runtimeEpoch,
        ...(normalized.hasActionId ? { actionId: normalized.actionId } : {}),
        fromObservedAtMs: normalized.fromObservedAtMs,
        toObservedAtMs: normalized.toObservedAtMs,
        limit: normalized.limit,
      });
    } catch (error) {
      this.activateMmapScanProjection(error, 'query', { forceScanOnly: true });
      return this.read(query);
    }
    const items = [];
    try {
      for (const location of located.items) {
        const scanned = this.engine.readAt(location);
        const decoded = decodeLogicalFact({
          engine: this.engine,
          partition: location.partition,
          payload: scanned.payload,
          sequence: location.sequence,
        });
        items.push({
          ...decoded.fact,
          globalSeq: location.sequence,
          sizeBytes: decoded.byteLength,
        });
      }
    } catch (error) {
      if (error.code !== 'segment_location_expired') throw error;
      return {
        ok: false,
        error: 'cursor_expired',
        message: error.message,
        items: [],
        count: 0,
        gap: true,
        cursorExpired: true,
      };
    }
    const latestSequence = Math.max(0, engineStatus.nextSequence - 1);
    const cursorSequence = located.hasMore && items.length > 0
      ? items.at(-1).globalSeq
      : (decodedThrough.sequence ?? latestSequence);
    return {
      ok: true,
      items,
      count: items.length,
      cursor: encodeCursor(cursorSequence, scope, this.cursorSecret, this.storeId),
      gap: false,
      cursorExpired: false,
      hasMore: located.hasMore,
    };
  }

  status() {
    if (this.closed) return { ...this.lastStatus, closed: true };
    const engine = this.engine.status();
    const index = this.index.status();
    const totalBytes = directoryBytes(this.directory);
    const mmapBytes = Number(engine.segmentCount || 0) * this.segmentSize;
    const projectionBytes = directoryBytes(this.indexDirectory);
    return {
      ok: true,
      adapter: 'segmented-mmap',
      authoritative: true,
      persistence: true,
      degraded: Boolean(this.projectionFallback),
      profile: this.profile,
      profileSelection: this.profileSelection,
      budgetBytes: this.budgetBytes,
      segmentSize: this.segmentSize,
      directory: this.directory,
      storeId: this.storeId,
      quota: {
        scope: 'host-mmap-store',
        budgetBytes: this.budgetBytes,
        emergencyReserveBytes: this.budgetBytes - this.partitionQuotas.reduce((sum, quota) => sum + quota, 0),
        partitions: Object.fromEntries(PARTITIONS.map((partition, id) => [partition, {
          id,
          weight: PARTITION_WEIGHTS[partition],
          hardQuotaBytes: this.partitionQuotas[id],
          ...(engine.partitions[id] || {}),
        }])),
      },
      storage: {
        totalBytes,
        // overQuota describes only the authoritative mmap store. The
        // rebuildable SQLite projection has its own budget and
        // can never trigger mmap fact eviction.
        overQuota: mmapBytes > this.budgetBytes,
        mmapBytes,
        mmapBudgetBytes: this.budgetBytes,
        mmapQuotaScope: 'host-mmap-store',
        projectionBytes,
        projectionBudgetBytes: this.projectionBudgetBytes,
        projectionOverQuota: projectionBytes > this.projectionBudgetBytes,
        projectionQuotaScope: 'host-sqlite-projection',
        independentBudgets: true,
        crossStoreEviction: false,
        controlBytes: Math.max(0, totalBytes - mmapBytes - projectionBytes),
      },
      sequences: {
        latestGlobalSeq: Math.max(0, Number(index.maxSequence || 0)),
        nextGlobalSeq: engine.nextSequence,
      },
      recovery: {
        ...this.recovery,
        recoveredTail: engine.recoveredTail,
        recoveryPartitionId: engine.recoveryPartitionId,
        recoverySegmentId: engine.recoverySegmentId,
        recoveryOffset: engine.recoveryOffset,
        discardedBytes: engine.recoveryDiscardedBytes,
      },
      engine,
      index,
      projectionFallback: this.projectionFallback,
      closed: false,
    };
  }

  flush() {
    this.assertOpen();
    this.engine.flush();
  }

  close() {
    if (this.closed) return;
    let firstError = null;
    for (const operation of [
      () => this.engine.flush(),
      () => { this.lastStatus = this.status(); },
      () => this.index.close(),
      () => this.engine.close(),
    ]) {
      try {
        operation();
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
    this.closed = true;
    if (firstError) throw firstError;
  }

  reconcileProjection() {
    const status = this.engine.status();
    const engineMax = Math.max(0, status.nextSequence - 1);
    const indexMax = this.index.maxSequence();
    let rebuilt = false;
    if (indexMax > engineMax) {
      this.index.clear();
      rebuilt = true;
    }
    const pruned = this.pruneEvictedProjection(status.partitions);
    const indexedCount = Number(this.index.status().count || 0);
    const checkpointCount = metadataNonNegativeInteger(this.index, 'logical-count');
    const checkpointNextSequence = metadataNonNegativeInteger(this.index, 'projected-next-sequence');
    const checkpointPhysicalCount = metadataNonNegativeInteger(this.index, 'projected-physical-count');
    if (
      !rebuilt
      && checkpointCount === indexedCount
      && checkpointNextSequence === Number(status.nextSequence)
      && checkpointPhysicalCount === Number(status.recordCount)
    ) {
      return { rebuilt: false, recoveredRecords: 0, prunedRecords: pruned };
    }
    let recovered = this.scanLogicalRecordsIntoProjection();
    if (this.index.status().count > recovered.logicalCount) {
      this.index.clear();
      rebuilt = true;
      recovered = this.scanLogicalRecordsIntoProjection();
    }
    this.index.setMetadata('logical-count', String(recovered.logicalCount));
    this.index.setMetadata('projected-next-sequence', String(status.nextSequence));
    this.index.setMetadata('projected-physical-count', String(status.recordCount));
    const recoveredRecords = recovered.recoveredRecords;
    return { rebuilt, recoveredRecords, prunedRecords: pruned };
  }

  updateProjectionCheckpoint(engineStatus) {
    if (this.index instanceof MmapScanIndex) return;
    this.index.setMetadata('logical-count', String(this.index.status().count));
    this.index.setMetadata('projected-next-sequence', String(engineStatus.nextSequence));
    this.index.setMetadata('projected-physical-count', String(engineStatus.recordCount));
  }

  scanLogicalRecordsIntoProjection() {
    const pending = [];
    let cursor = { partitionId: PARTITION_ALL, afterSequence: 0 };
    let logicalCount = 0;
    let recoveredRecords = 0;
    while (true) {
      const scanned = this.engine.scan(cursor);
      cursor = scanned.cursor;
      if (scanned.done) break;
      const fact = decodeFactPayload(scanned.payload, scanned.record.sequence);
      if (!fact) continue;
      logicalCount += 1;
      if (this.index.locationForSequence(scanned.record.sequence)) continue;
      pending.push({
        fact,
        location: {
          sequence: scanned.record.sequence,
          segmentId: scanned.record.segmentId,
          frameOffset: scanned.record.frameOffset,
          payloadLength: logicalPayloadLength(fact, scanned.record.payloadLength),
        },
      });
      if (pending.length >= 256) {
        this.index.insertBatch(pending.splice(0));
      }
      recoveredRecords += 1;
    }
    if (pending.length > 0) this.index.insertBatch(pending);
    return { logicalCount, recoveredRecords };
  }

  pruneEvictedProjection(partitionStatuses = []) {
    let pruned = 0;
    for (let id = 0; id < PARTITIONS.length; id += 1) {
      const status = partitionStatuses[id];
      if (!status || Number(status.evictedRecords || 0) === 0 || Number(status.firstSequence || 0) <= 0) continue;
      const firstSequence = Number(status.firstSequence);
      if (firstSequence <= this.lastPrunedFirstSequence[id]) continue;
      pruned += this.index.prunePartitionBefore(PARTITIONS[id], firstSequence);
      this.lastPrunedFirstSequence[id] = firstSequence;
    }
    return pruned;
  }

  maintainProjectionBudget({ force = false } = {}) {
    if (!this.ownsIndex) return { checked: false, degraded: false };
    this.projectionWritesSinceCheck += 1;
    if (!force && this.projectionWritesSinceCheck < this.projectionCheckInterval) {
      return { checked: false, degraded: false };
    }
    this.projectionWritesSinceCheck = 0;
    if (
      this.index instanceof MmapScanIndex
      && !this.index.base
      && this.projectionFallback?.cleanupPending
    ) {
      this.projectionFallback.lastCleanupRetryAtMs = Date.now();
      this.retryProjectionCleanup(this.projectionFallback);
    }
    const beforeBytes = directoryBytes(this.indexDirectory);
    if (beforeBytes <= this.projectionBudgetBytes) {
      return { checked: true, degraded: false, beforeBytes, afterBytes: beforeBytes };
    }
    let reclaimed;
    try {
      reclaimed = this.index.reclaim({ force: true });
    } catch (error) {
      this.activateMmapScanProjection(error, 'projection-reclaim', { forceScanOnly: true });
      return {
        checked: true,
        degraded: true,
        beforeBytes,
        afterBytes: directoryBytes(this.indexDirectory),
      };
    }
    const afterBytes = directoryBytes(this.indexDirectory);
    if (afterBytes <= this.projectionBudgetBytes) {
      return { checked: true, degraded: false, beforeBytes, afterBytes, reclaimed };
    }
    const error = new Error(
      `SQLite projection uses ${afterBytes} bytes, exceeding its independent ${this.projectionBudgetBytes}-byte budget`,
    );
    error.code = 'sqlite_projection_budget_exceeded';
    error.projectionBytes = afterBytes;
    error.projectionBudgetBytes = this.projectionBudgetBytes;
    this.activateMmapScanProjection(error, 'projection-budget', { forceScanOnly: true });
    return {
      checked: true,
      degraded: true,
      beforeBytes,
      afterBytes: directoryBytes(this.indexDirectory),
      reclaimed,
    };
  }

  activateMmapScanProjection(
    error,
    phase,
    { failedSequence = null, forceScanOnly = false } = {},
  ) {
    if (!this.ownsIndex) throw error;
    const oldIndex = this.index;
    if (oldIndex instanceof MmapScanIndex && !oldIndex.base) {
      const fallback = this.projectionFallback || {
        code: projectionErrorCode(error),
        message: String(error?.message || error),
        phase,
        mode: 'mmap-scan',
        activatedAtMs: Date.now(),
      };
      fallback.lastCleanupRetryAtMs = Date.now();
      this.retryProjectionCleanup(fallback);
      this.projectionFallback = fallback;
      return fallback;
    }
    const cursorSecret = this.cursorSecret || crypto.randomBytes(32).toString('base64url');
    const storeId = this.storeId || crypto.randomUUID();
    const fallback = {
      code: projectionErrorCode(error),
      message: String(error?.message || error),
      phase,
      activatedAtMs: Date.now(),
    };
    let retainedBase = null;
    let baseHighWater = 0;
    if (!forceScanOnly && oldIndex && !(oldIndex instanceof MmapScanIndex)) {
      try {
        const engineStatus = this.engine.status();
        const baseStatus = oldIndex.status();
        const expectedMax = failedSequence === null
          ? Math.max(0, Number(engineStatus.nextSequence || 1) - 1)
          : Math.max(0, Number(failedSequence) - 1);
        const expectedCount = failedSequence === null
          ? Number(engineStatus.recordCount || 0)
          : Math.max(0, Number(engineStatus.recordCount || 0) - 1);
        oldIndex.query({ afterSequence: 0, limit: 1 });
        if (
          Number(baseStatus.maxSequence || 0) === expectedMax
          && Number(baseStatus.count || 0) === expectedCount
          && directoryBytes(this.indexDirectory) <= this.projectionBudgetBytes
        ) {
          retainedBase = oldIndex;
          baseHighWater = expectedMax;
        }
      } catch (_) {
        retainedBase = null;
        baseHighWater = 0;
      }
    }

    // Construct the bounded-memory candidate before touching the current
    // projection. The pointer swap is therefore atomic from readers' view.
    const candidate = new MmapScanIndex({
      engine: this.engine,
      decodeFact: decodeFactPayload,
      base: retainedBase,
      baseHighWater,
      reason: fallback,
      budgetBytes: this.projectionBudgetBytes,
    });
    candidate.setMetadata('cursor-secret', cursorSecret);
    candidate.setMetadata('store-id', storeId);
    this.index = candidate;
    this.cursorSecret = cursorSecret;
    this.storeId = storeId;
    fallback.mode = retainedBase ? 'sqlite-base+mmap-tail' : 'mmap-scan';
    this.projectionFallback = fallback;
    this.projectionWritesSinceCheck = 0;
    this.recovery = {
      ...(this.recovery || {}),
      rebuilt: false,
      recoveredRecords: 0,
      prunedRecords: 0,
      projectionMode: fallback.mode,
    };

    if (!retainedBase) {
      try {
        oldIndex?.close();
      } catch (closeError) {
        fallback.closeError = String(closeError?.message || closeError);
      }
      try {
        // Only the non-authoritative Host projection is removed. mmap facts
        // and every mobile App sandbox are outside this directory.
        this.retryProjectionCleanup(fallback);
      } catch (_) {
        // retryProjectionCleanup records the failure without affecting facts.
      }
    }
    return fallback;
  }

  retryProjectionCleanup(fallback) {
    try {
      this.removeProjection();
      delete fallback.removeError;
    } catch (removeError) {
      fallback.removeError = String(removeError?.message || removeError);
    }
    fallback.residualProjectionBytes = directoryBytes(this.indexDirectory);
    fallback.cleanupPending = fallback.residualProjectionBytes > 0;
    return !fallback.cleanupPending;
  }

  assertOpen() {
    if (this.closed) throw new Error('SegmentedFactStoreAdapter is closed');
  }
}

function projectionErrorCode(error) {
  const message = String(error?.message || error || '');
  if (/database or disk is full/i.test(message) || error?.code === 'SQLITE_FULL') {
    return 'sqlite_projection_capacity';
  }
  return String(error?.code || error?.name || 'sqlite_projection_failure');
}

function createSegmentedFactStoreAdapter(options = {}) {
  if (normalizeProfile(options.profile) === 'auto') {
    const directory = path.resolve(options.directory || defaultSegmentedFactStorePath());
    const storageCapacity = normalizeStorageCapacity(
      options.storageCapacity || readStorageCapacity(directory),
    );
    if (storageCapacity.availableBytes < FACT_STORE_PROFILES['64mb'] + MINIMUM_SAFETY_RESERVE) {
      return new DisabledSegmentedFactStoreAdapter({ directory, storageCapacity });
    }
  }
  return new SegmentedFactStoreAdapter(options);
}

function loadNativeBinding() {
  try {
    return require('@mobileaidev/segmented-fact-store-native');
  } catch (packageError) {
    const localPath = path.resolve(__dirname, '../../../native/segmented-fact-store');
    try {
      return require(localPath);
    } catch (localError) {
      const error = new Error(`segmented mmap native binding is unavailable: ${localError.message}`);
      error.code = 'segmented_native_unavailable';
      error.packageError = packageError;
      error.cause = localError;
      throw error;
    }
  }
}

function partitionQuotas(budgetBytes, segmentSize) {
  const quotas = PARTITIONS.map((partition) => {
    const target = Math.floor(budgetBytes * PARTITION_WEIGHTS[partition] / 100);
    return Math.max(segmentSize, Math.floor(target / segmentSize) * segmentSize);
  });
  const allocated = quotas.reduce((sum, quota) => sum + quota, 0);
  if (allocated > budgetBytes) {
    throw new RangeError('budgetBytes is too small for one segment in every partition');
  }
  return quotas;
}

function normalizePartitionQuotas(value, segmentSize) {
  if (!Array.isArray(value) || value.length !== PARTITIONS.length) {
    throw new TypeError(`partitionQuotas must contain ${PARTITIONS.length} entries`);
  }
  return value.map((quota, index) => {
    const number = positiveInteger(quota, undefined, `partitionQuotas[${index}]`);
    if (number < segmentSize || number % segmentSize !== 0) {
      throw new TypeError(`partitionQuotas[${index}] must be a segmentSize multiple`);
    }
    return number;
  });
}

function normalizeReadQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new TypeError('query must be an object');
  const partitions = query.partitions === undefined
    ? []
    : [...new Set((Array.isArray(query.partitions) ? query.partitions : [query.partitions]).map(String))].sort();
  for (const partition of partitions) {
    if (PARTITION_IDS[partition] === undefined) throw new TypeError(`unknown partition: ${partition}`);
  }
  const limit = positiveInteger(query.limit, 100, 'limit');
  if (limit > 1000) throw new TypeError('limit must not exceed 1000');
  return {
    cursor: query.cursor === undefined || query.cursor === null ? null : query.cursor,
    throughCursor: query.throughCursor === undefined || query.throughCursor === null
      ? null
      : query.throughCursor,
    targetKey: nullableString(query.targetKey),
    partitions,
    runtimeEpoch: nullableString(query.runtimeEpoch),
    hasActionId: Object.prototype.hasOwnProperty.call(query, 'actionId'),
    actionId: nullableString(query.actionId),
    fromObservedAtMs: nullableInteger(query.fromObservedAtMs, 'fromObservedAtMs'),
    toObservedAtMs: nullableInteger(query.toObservedAtMs, 'toObservedAtMs'),
    limit,
  };
}

function cursorScope(query) {
  return crypto.createHash('sha256').update(JSON.stringify({
    targetKey: query.targetKey,
    partitions: query.partitions,
    runtimeEpoch: query.runtimeEpoch,
    hasActionId: query.hasActionId,
    actionId: query.actionId,
  })).digest('base64url').slice(0, 22);
}

function encodeCursor(sequence, scope, secret, storeId) {
  const payload = Buffer.from(JSON.stringify({ v: 1, s: sequence, q: scope, i: storeId })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 22);
  return `fs1.${payload}.${signature}`;
}

function decodeCursor(cursor, scope, secret, storeId) {
  if (typeof cursor !== 'string') return { ok: false, message: 'Cursor must be a string.' };
  const match = /^fs1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(cursor);
  if (!match) return { ok: false, message: 'Cursor format is invalid.' };
  const expected = crypto.createHmac('sha256', secret).update(match[1]).digest('base64url').slice(0, 22);
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(match[2]);
  if (expectedBuffer.length !== providedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
    return { ok: false, message: 'Cursor signature is invalid.' };
  }
  try {
    const payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    if (
      payload.v !== 1
      || !Number.isSafeInteger(payload.s)
      || payload.s < 0
      || payload.q !== scope
      || payload.i !== storeId
    ) return { ok: false, message: 'Cursor scope is invalid.' };
    return { ok: true, sequence: payload.s };
  } catch (_) {
    return { ok: false, message: 'Cursor payload is invalid.' };
  }
}

function cursorGap(sequence, requestedPartitions, statuses = []) {
  const selected = requestedPartitions.length > 0
    ? requestedPartitions
    : PARTITIONS;
  const gaps = [];
  for (const partition of selected) {
    const status = statuses[PARTITION_IDS[partition]];
    if (!status || Number(status.evictedRecords || 0) === 0) continue;
    const first = Number(status.firstSequence || 0);
    if (first > 0 && sequence < first - 1) {
      gaps.push({ partition, firstAvailableSequence: first, evictedRecords: Number(status.evictedRecords) });
    }
  }
  return gaps.length > 0 ? gaps : null;
}

function createLargeFactManifest({ normalized, digest, byteLength, chunks }) {
  return {
    __aiAppBridgeInternal: LARGE_FACT_MANIFEST_KIND,
    index: factIndexMetadata(normalized),
    content: {
      encoding: 'json-utf8',
      byteLength,
      sha256: digest.toString('hex'),
      chunks,
    },
  };
}

function nativeFrameLength(payloadLength) {
  return Math.ceil((24 + Number(payloadLength)) / 8) * 8 + 8;
}

function encodeLargeFactChunk({ digest, ordinal, chunkCount, totalLength, bytes }) {
  const payload = Buffer.allocUnsafe(LARGE_FACT_CHUNK_HEADER_BYTES + bytes.length);
  LARGE_FACT_CHUNK_MAGIC.copy(payload, 0);
  payload.writeUInt32LE(LARGE_FACT_CHUNK_VERSION, 8);
  payload.writeUInt32LE(LARGE_FACT_CHUNK_HEADER_BYTES, 12);
  digest.copy(payload, 16);
  payload.writeUInt32LE(ordinal, 48);
  payload.writeUInt32LE(chunkCount, 52);
  payload.writeBigUInt64LE(BigInt(totalLength), 56);
  payload.writeUInt32LE(bytes.length, 64);
  payload.writeUInt32LE(0, 68);
  bytes.copy(payload, LARGE_FACT_CHUNK_HEADER_BYTES);
  return payload;
}

function decodeLargeFactChunk(payload, sequence) {
  try {
    if (payload.length < LARGE_FACT_CHUNK_HEADER_BYTES) throw new Error('chunk header is truncated');
    if (!payload.subarray(0, LARGE_FACT_CHUNK_MAGIC.length).equals(LARGE_FACT_CHUNK_MAGIC)) {
      throw new Error('chunk magic is invalid');
    }
    if (payload.readUInt32LE(8) !== LARGE_FACT_CHUNK_VERSION) throw new Error('chunk version is unsupported');
    if (payload.readUInt32LE(12) !== LARGE_FACT_CHUNK_HEADER_BYTES) throw new Error('chunk header length is invalid');
    const totalLength = Number(payload.readBigUInt64LE(56));
    if (!Number.isSafeInteger(totalLength) || totalLength <= 0) throw new Error('chunk total length is invalid');
    const byteLength = payload.readUInt32LE(64);
    if (byteLength !== payload.length - LARGE_FACT_CHUNK_HEADER_BYTES) {
      throw new Error('chunk byte length does not match its payload');
    }
    if (payload.readUInt32LE(52) === 0) throw new Error('chunk count is invalid');
    if (payload.readUInt32LE(68) !== 0) throw new Error('chunk reserved bytes are not zero');
    return {
      digest: Buffer.from(payload.subarray(16, 48)),
      ordinal: payload.readUInt32LE(48),
      chunkCount: payload.readUInt32LE(52),
      totalLength,
      byteLength,
      bytes: payload.subarray(LARGE_FACT_CHUNK_HEADER_BYTES),
    };
  } catch (error) {
    throw invalidLargeFactError(sequence, `physical chunk is invalid: ${error.message}`, error);
  }
}

function decodeFactPayload(payload, sequence) {
  const decoded = decodePhysicalFactPayload(payload, sequence);
  return decoded.kind === 'chunk' ? null : decoded.fact;
}

function decodePhysicalFactPayload(payload, sequence) {
  if (
    payload.length >= LARGE_FACT_CHUNK_MAGIC.length
    && payload.subarray(0, LARGE_FACT_CHUNK_MAGIC.length).equals(LARGE_FACT_CHUNK_MAGIC)
  ) {
    return { kind: 'chunk' };
  }
  try {
    const fact = JSON.parse(payload.toString('utf8'));
    if (fact?.__aiAppBridgeInternal === LARGE_FACT_MANIFEST_KIND) {
      const manifest = validateLargeFactManifest(fact, sequence);
      const indexFact = { ...manifest.index, timestamps: { ...manifest.index.timestamps } };
      Object.defineProperty(indexFact, LARGE_FACT_LOGICAL_BYTES, {
        configurable: false,
        enumerable: false,
        value: manifest.content.byteLength,
        writable: false,
      });
      return {
        kind: 'manifest',
        fact: indexFact,
        manifest,
        byteLength: manifest.content.byteLength,
      };
    }
    validateFactShape(fact);
    return { kind: 'fact', fact, byteLength: payload.length };
  } catch (error) {
    if (error?.code === 'large_fact_invalid') throw error;
    const wrapped = new Error(`segment payload at sequence ${sequence} is invalid: ${error.message}`);
    wrapped.code = 'segment_payload_invalid';
    wrapped.sequence = sequence;
    wrapped.cause = error;
    throw wrapped;
  }
}

function decodeLogicalFact({ engine, partition, payload, sequence }) {
  const decoded = decodePhysicalFactPayload(payload, sequence);
  if (decoded.kind === 'chunk') {
    throw invalidLargeFactError(sequence, 'query projection points to a physical chunk');
  }
  if (decoded.kind === 'fact') return { fact: decoded.fact, byteLength: decoded.byteLength };

  const { manifest } = decoded;
  const expectedDigest = Buffer.from(manifest.content.sha256, 'hex');
  const buffers = [];
  let totalLength = 0;
  for (const expected of manifest.content.chunks) {
    let scanned;
    try {
      scanned = engine.readAt({
        partition,
        sequence: expected.sequence,
        segmentId: expected.segmentId,
        frameOffset: expected.frameOffset,
      });
    } catch (error) {
      if (error?.code === 'segment_location_expired') throw error;
      throw invalidLargeFactError(sequence, `chunk ${expected.ordinal} cannot be read: ${error.message}`, error);
    }
    if (scanned.record.payloadLength !== expected.payloadLength) {
      throw invalidLargeFactError(sequence, `chunk ${expected.ordinal} physical length changed`);
    }
    const chunk = decodeLargeFactChunk(scanned.payload, expected.sequence);
    if (
      chunk.ordinal !== expected.ordinal
      || chunk.chunkCount !== manifest.content.chunks.length
      || chunk.totalLength !== manifest.content.byteLength
      || chunk.byteLength !== expected.byteLength
      || !chunk.digest.equals(expectedDigest)
    ) {
      throw invalidLargeFactError(sequence, `chunk ${expected.ordinal} metadata does not match the manifest`);
    }
    buffers.push(chunk.bytes);
    totalLength += chunk.byteLength;
  }
  if (totalLength !== manifest.content.byteLength) {
    throw invalidLargeFactError(sequence, 'chunk lengths do not match the manifest total');
  }
  const assembled = Buffer.concat(buffers, totalLength);
  const actualDigest = crypto.createHash('sha256').update(assembled).digest();
  if (!actualDigest.equals(expectedDigest)) {
    throw invalidLargeFactError(sequence, 'assembled fact SHA-256 does not match the manifest');
  }
  const logical = decodePhysicalFactPayload(assembled, sequence);
  if (logical.kind !== 'fact') {
    throw invalidLargeFactError(sequence, 'assembled payload is not a canonical fact');
  }
  if (JSON.stringify(factIndexMetadata(logical.fact)) !== JSON.stringify(manifest.index)) {
    throw invalidLargeFactError(sequence, 'assembled fact metadata does not match the manifest');
  }
  return { fact: logical.fact, byteLength: assembled.length };
}

function validateLargeFactManifest(value, sequence) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidLargeFactError(sequence, 'manifest must be an object');
  }
  validateFactShape(value.index);
  const content = value.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw invalidLargeFactError(sequence, 'manifest content is missing');
  }
  if (content.encoding !== 'json-utf8') throw invalidLargeFactError(sequence, 'manifest encoding is invalid');
  if (!Number.isSafeInteger(content.byteLength) || content.byteLength <= 0) {
    throw invalidLargeFactError(sequence, 'manifest byte length is invalid');
  }
  if (typeof content.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(content.sha256)) {
    throw invalidLargeFactError(sequence, 'manifest SHA-256 is invalid');
  }
  if (!Array.isArray(content.chunks) || content.chunks.length === 0) {
    throw invalidLargeFactError(sequence, 'manifest chunks are missing');
  }
  let priorSequence = 0;
  let totalLength = 0;
  const chunks = content.chunks.map((chunk, ordinal) => {
    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
      throw invalidLargeFactError(sequence, `manifest chunk ${ordinal} is invalid`);
    }
    const normalized = {
      ordinal: nonNegativeInteger(chunk.ordinal, undefined, `manifest chunk ${ordinal} ordinal`),
      sequence: positiveInteger(chunk.sequence, undefined, `manifest chunk ${ordinal} sequence`),
      segmentId: nonNegativeInteger(chunk.segmentId, undefined, `manifest chunk ${ordinal} segmentId`),
      frameOffset: nonNegativeInteger(chunk.frameOffset, undefined, `manifest chunk ${ordinal} frameOffset`),
      payloadLength: positiveInteger(chunk.payloadLength, undefined, `manifest chunk ${ordinal} payloadLength`),
      byteLength: positiveInteger(chunk.byteLength, undefined, `manifest chunk ${ordinal} byteLength`),
    };
    if (normalized.ordinal !== ordinal) throw invalidLargeFactError(sequence, `manifest chunk ordinal ${ordinal} is missing`);
    if (normalized.sequence <= priorSequence || normalized.sequence >= sequence) {
      throw invalidLargeFactError(sequence, `manifest chunk ${ordinal} sequence is out of order`);
    }
    priorSequence = normalized.sequence;
    totalLength += normalized.byteLength;
    return normalized;
  });
  if (totalLength !== content.byteLength) {
    throw invalidLargeFactError(sequence, 'manifest chunk lengths do not match its total');
  }
  return {
    __aiAppBridgeInternal: LARGE_FACT_MANIFEST_KIND,
    index: factIndexMetadata(value.index),
    content: {
      encoding: 'json-utf8',
      byteLength: content.byteLength,
      sha256: content.sha256,
      chunks,
    },
  };
}

function validateFactShape(fact) {
  if (!fact || typeof fact !== 'object' || Array.isArray(fact) || !fact.timestamps) {
    throw new Error('required fact fields are missing');
  }
  for (const key of ['partition', 'targetKey', 'runtimeEpoch']) {
    if (fact[key] === undefined || fact[key] === null || String(fact[key]).length === 0) {
      throw new Error('required fact fields are missing');
    }
  }
  for (const key of ['occurredAtMs', 'observedAtMs', 'ingestedAtMs']) {
    if (!Number.isSafeInteger(Number(fact.timestamps[key]))) {
      throw new Error(`fact timestamp ${key} is invalid`);
    }
  }
}

function factIndexMetadata(fact) {
  validateFactShape(fact);
  return {
    partition: String(fact.partition),
    targetKey: String(fact.targetKey),
    runtimeEpoch: String(fact.runtimeEpoch),
    actionId: fact.actionId === undefined || fact.actionId === null ? null : String(fact.actionId),
    dedupeKey: fact.dedupeKey === undefined || fact.dedupeKey === null ? null : String(fact.dedupeKey),
    timestamps: {
      occurredAtMs: Number(fact.timestamps.occurredAtMs),
      observedAtMs: Number(fact.timestamps.observedAtMs),
      ingestedAtMs: Number(fact.timestamps.ingestedAtMs),
    },
  };
}

function logicalPayloadLength(fact, fallback) {
  const value = Number(fact?.[LARGE_FACT_LOGICAL_BYTES]);
  return Number.isSafeInteger(value) && value > 0 ? value : Number(fallback);
}

function metadataNonNegativeInteger(index, key) {
  const raw = index.metadata(key);
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function invalidLargeFactError(sequence, message, cause) {
  const error = new Error(`large fact at sequence ${sequence} is invalid: ${message}`);
  error.code = 'large_fact_invalid';
  error.sequence = sequence;
  if (cause) error.cause = cause;
  return error;
}

function numericRecord(record) {
  return {
    ...record,
    sequence: safeNumber(record.sequence, 'sequence'),
    segmentId: safeNumber(record.segmentId, 'segmentId'),
    frameOffset: safeNumber(record.frameOffset, 'frameOffset'),
    gapFirstSequence: safeNumber(record.gapFirstSequence, 'gapFirstSequence'),
    gapLastSequence: safeNumber(record.gapLastSequence, 'gapLastSequence'),
  };
}

function numericCursor(cursor) {
  return {
    ...cursor,
    afterSequence: safeNumber(cursor.afterSequence, 'afterSequence'),
    segmentId: safeNumber(cursor.segmentId, 'segmentId'),
    offset: safeNumber(cursor.offset, 'offset'),
  };
}

function numericTree(value) {
  if (typeof value === 'bigint') return safeNumber(value, 'native status');
  if (Array.isArray(value)) return value.map(numericTree);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, numericTree(child)]));
}

function safeNumber(value, name) {
  const number = typeof value === 'bigint' ? Number(value) : Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) throw new RangeError(`${name} exceeds JavaScript safe integer range`);
  return number;
}

function normalizeProfile(value) {
  const raw = value === undefined || value === null ? 'auto' : String(value).trim().toLowerCase();
  const profile = {
    default: '1gb',
    1024: '1gb',
    '1024m': '1gb',
    '1g': '1gb',
    512: '512mb',
    '512m': '512mb',
    256: '256mb',
    '256m': '256mb',
    64: '64mb',
    '64m': '64mb',
  }[raw] || raw;
  if (profile === 'auto') return profile;
  if (!FACT_STORE_PROFILES[profile]) throw new TypeError('profile must be auto, 1gb, 512mb, 256mb, or 64mb');
  return profile;
}

function selectAutomaticProfile(storage) {
  if (storage.totalBytes >= 32 * GIB && storage.availableBytes >= 8 * GIB) return '1gb';
  if (storage.totalBytes >= 16 * GIB && storage.availableBytes >= 4 * GIB) return '512mb';
  if (storage.totalBytes >= 4 * GIB && storage.availableBytes >= 2 * GIB) return '256mb';
  return '64mb';
}

function hasCommittedManifest(segmentsDirectory) {
  try {
    const status = fs.statSync(path.join(segmentsDirectory, '.sfs-manifest'));
    return status.isFile() && status.size > 0;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function existingPartitionQuotas(engineStatus) {
  if (!Array.isArray(engineStatus?.partitions) || engineStatus.partitions.length !== PARTITIONS.length) {
    throw new Error('existing segmented store has an invalid partition layout');
  }
  return engineStatus.partitions.map((partition, index) => nonNegativeInteger(
    partition?.quotaBytes,
    undefined,
    `existing partitionQuotas[${index}]`,
  ));
}

function profileForConfiguration(segmentSize, quotas) {
  for (const [profile, budgetBytes] of Object.entries(FACT_STORE_PROFILES)) {
    const expectedSegmentSize = SEGMENT_SIZE_BY_PROFILE[profile];
    if (segmentSize !== expectedSegmentSize) continue;
    const expectedQuotas = partitionQuotas(budgetBytes, expectedSegmentSize);
    if (expectedQuotas.every((quota, index) => quota === quotas[index])) return profile;
  }
  return null;
}

function readStorageCapacity(directory) {
  let probe = path.resolve(directory);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) throw new Error(`No existing parent for segmented FactStore directory: ${directory}`);
    probe = parent;
  }
  const stats = fs.statfsSync(probe);
  const blockSize = Number(stats.bsize);
  return { totalBytes: Number(stats.blocks) * blockSize, availableBytes: Number(stats.bavail) * blockSize };
}

function normalizeStorageCapacity(value) {
  if (!value || typeof value !== 'object') throw new TypeError('storageCapacity must be an object');
  const totalBytes = positiveInteger(value.totalBytes, undefined, 'storageCapacity.totalBytes');
  const availableBytes = nonNegativeInteger(value.availableBytes, undefined, 'storageCapacity.availableBytes');
  if (availableBytes > totalBytes) throw new TypeError('storageCapacity.availableBytes cannot exceed totalBytes');
  return { totalBytes, availableBytes };
}

function defaultSegmentedFactStorePath() {
  if (process.env.AI_APP_BRIDGE_FACT_STORE_PATH) return path.resolve(process.env.AI_APP_BRIDGE_FACT_STORE_PATH);
  if (process.platform === 'win32') {
    const root = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(root, 'ai-app-bridge', 'fact-store-v1');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ai-app-bridge', 'fact-store-v1');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ai-app-bridge', 'fact-store-v1');
}

function directoryBytes(directory) {
  let total = 0;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile()) total += fs.statSync(child).size;
    }
  }
  return total;
}

function restrictDirectory(directory) {
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function positiveInteger(value, fallback, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return number;
}

function nonNegativeInteger(value, fallback, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return number;
}

function nullableString(value) {
  return value === undefined || value === null ? null : String(value);
}

function nullableInteger(value, name) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new TypeError(`${name} must be a safe integer`);
  return number;
}

module.exports = {
  DEFAULT_PROJECTION_BUDGET_BYTES,
  DisabledSegmentedFactStoreAdapter,
  FACT_STORE_PROFILES,
  LARGE_FACT_WIRE_V1,
  NativeSegmentEngine,
  PARTITIONS,
  PARTITION_IDS,
  PARTITION_WEIGHTS,
  SegmentedFactStoreAdapter,
  createSegmentedFactStoreAdapter,
  createLargeFactManifest,
  defaultSegmentedFactStorePath,
  encodeLargeFactChunk,
  partitionQuotas,
};
