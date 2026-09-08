'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalJson, validateRecord, verifyChecksum } = require('./evidence-schema');

const SCHEMA = 'aab.evidence-archive/v1';
const MAX_RECORDS = 10_000;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function requireValue(condition, code, detail) {
  if (!condition) throw Object.assign(new Error(code), { code, detail });
}

function textArgument(value, field) {
  requireValue(typeof value === 'string' && value.trim().length > 0, 'invalid_argument', field);
}

function namespaceArgument(namespace) {
  requireValue(namespace === 'intent' || namespace === 'script', 'invalid_argument', 'namespace');
}

async function handle(args = {}, { getFactStore } = {}) {
  try {
    if (args.operation === 'verify') return verifyArchive(args);
    if (args.operation === 'export') {
      namespaceArgument(args.namespace);
      textArgument(args.operationId, 'operationId');
      textArgument(args.outputDir, 'outputDir');
      requireValue(!fs.existsSync(path.resolve(args.outputDir)), 'output_exists');
      const store = getFactStore();
      await store.drain();
      return exportArchive(args, store);
    }
    return { ok: false, error: 'invalid_operation' };
  } catch (error) {
    return {
      ok: false,
      error: error.code || 'archive_failed',
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(error.code === 'invalid_argument' ? { field: error.detail } : {}),
    };
  }
}

// There is no await between the watermark, page reads and final status: the
// owning Host writer cannot interleave another command with this snapshot.
function exportArchive({ namespace, operationId, outputDir }, store) {
  const status = store.status();
  requireValue(status.ok === true && status.authoritative === true && status.persistence === true,
    'fact_store_unavailable');
  requireValue(Number.isSafeInteger(status.sequences?.nextGlobalSeq), 'invalid_store_snapshot');
  const throughGlobalSeq = status.sequences.nextGlobalSeq - 1;
  requireValue(typeof status.storeId === 'string' && status.storeId.length > 0 && Number.isSafeInteger(throughGlobalSeq)
    && throughGlobalSeq >= 0, 'invalid_store_snapshot');
  const targetKey = `evidence:${namespace}:${operationId}`;
  const facts = [];
  const cursors = new Set();
  let cursor;
  let byteCount = 2;
  do {
    const page = store.read({ targetKey, limit: 1000, ...(cursor === undefined ? {} : { cursor }) });
    requireValue(page.ok === true, 'fact_store_read_failed', page.error);
    requireValue(page.gap === false && page.cursorExpired === false, 'evidence_gap');
    requireValue(Array.isArray(page.items) && typeof page.hasMore === 'boolean', 'invalid_store_page');
    for (const fact of page.items) {
      byteCount += Buffer.byteLength(JSON.stringify(fact)) + 1;
      requireValue(facts.length < MAX_RECORDS && byteCount <= MAX_BYTES, 'archive_limit_exceeded');
      facts.push(fact);
    }
    if (!page.hasMore) break;
    requireValue(page.items.length > 0 && typeof page.cursor === 'string' && page.cursor.length > 0 && !cursors.has(page.cursor),
      'invalid_store_cursor');
    cursors.add(page.cursor);
    cursor = page.cursor;
  } while (true);
  requireValue(facts.length > 0, 'operation_not_found');
  const after = store.status();
  requireValue(after.ok === true && after.storeId === status.storeId
    && after.sequences?.nextGlobalSeq === throughGlobalSeq + 1, 'store_changed_during_export');
  const analysis = analyzeFacts(facts, { namespace, operationId, throughGlobalSeq });
  const recordsBytes = Buffer.from(JSON.stringify(facts) + '\n');
  requireValue(recordsBytes.length <= MAX_BYTES, 'archive_limit_exceeded');
  const manifest = {
    schemaVersion: SCHEMA,
    namespace,
    operationId,
    exportedAtMs: Date.now(),
    source: {
      kind: 'host-fact-store',
      storeId: status.storeId,
      targetKey,
      throughGlobalSeq,
      // These describe retention for whole partitions, not just this operation.
      retention: { ui: status.quota?.partitions?.ui ?? null, action: status.quota?.partitions?.action ?? null },
    },
    records: { path: 'records.json', bytes: recordsBytes.length, sha256: sha256(recordsBytes) },
    ...analysis,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  requireValue(manifestBytes.length <= MAX_MANIFEST_BYTES, 'archive_limit_exceeded');
  const directory = path.resolve(outputDir);
  // An output directory is created exclusively. Interrupted writes have no
  // manifest, and existing user files are never replaced or removed.
  try { fs.mkdirSync(directory); }
  catch (error) { if (error.code === 'EEXIST') error.code = 'output_exists'; throw error; }
  fs.writeFileSync(path.join(directory, 'records.json'), recordsBytes, { flag: 'wx' });
  fs.writeFileSync(path.join(directory, 'manifest.json'), manifestBytes, { flag: 'wx' });
  return resultOf(manifest, directory, sha256(manifestBytes));
}

function analyzeFacts(facts, { namespace, operationId, throughGlobalSeq }) {
  requireValue(Array.isArray(facts) && facts.length > 0 && facts.length <= MAX_RECORDS, 'invalid_records');
  const ids = new Map();
  const positions = new Map();
  const counts = {};
  const targets = new Map();
  let previousSequence = 0;
  function target(role, value) {
    if (value === undefined) return;
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid_record_target');
    const item = { role, value };
    targets.set(canonicalJson(item), item);
  }
  for (const fact of facts) {
    requireValue(fact && Number.isSafeInteger(fact.globalSeq) && fact.globalSeq > previousSequence
      && fact.globalSeq <= throughGlobalSeq, 'invalid_record_sequence');
    previousSequence = fact.globalSeq;
    const record = fact.payload;
    requireValue(record?.namespace === namespace && record.operationId === operationId, 'record_scope_mismatch');
    requireValue(fact.targetKey === `evidence:${namespace}:${operationId}`
      && fact.runtimeEpoch === operationId && fact.actionId === record.evidenceId, 'fact_binding_mismatch');
    requireValue(record.persisted === true && typeof record.evidenceId === 'string' && record.evidenceId.length > 0,
      'invalid_evidence_record');
    requireValue(!ids.has(record.evidenceId), 'duplicate_evidence_id');
    requireValue(validateRecord(namespace, record.kind, record).ok, 'invalid_evidence_record');
    requireValue(verifyChecksum(record).ok, 'record_checksum_mismatch', record.evidenceId);
    ids.set(record.evidenceId, record);
    positions.set(record.evidenceId, fact.globalSeq);
    counts[record.kind] = (counts[record.kind] || 0) + 1;
    target(namespace === 'script' && record.kind === 'dispatch-marker' ? 'dispatch' : 'owner', record.target);
    target('owner', record.requestedTarget);
    target('foreground', record.foreground);
    if (record.kind === 'observation') target('observed', { serial: record.serial, packageName: record.packageName });
  }
  const missingReferences = [];
  const externalReferences = [];
  function uniqueIndex(kind, field) {
    const index = new Map();
    for (const { payload: record } of facts) {
      if (record.kind !== kind || record[field] === undefined) continue;
      requireValue(!index.has(record[field]), 'ambiguous_evidence_reference', field);
      index.set(record[field], record);
    }
    return index;
  }
  const observations = uniqueIndex('observation', 'rawTreeId');
  const summaries = new Set(facts.filter(f => f.payload.kind === 'summary').map(f => f.payload.rawTreeId));
  const markers = uniqueIndex('dispatch-marker', 'actionId');
  const decisions = uniqueIndex('decision', 'decisionId');
  const missing = (record, field, value) => missingReferences.push({ evidenceId: record.evidenceId, field, value });
  const precedes = (reference, record) => requireValue(
    positions.get(reference.evidenceId) < positions.get(record.evidenceId), 'invalid_reference_binding', record.evidenceId);
  for (const { payload: record } of facts) {
    if (record.kind === 'observation' && record.rawTree == null) missing(record, 'rawTree', null);
    if (record.kind === 'observation' && !summaries.has(record.rawTreeId)) missing(record, 'summary', record.rawTreeId ?? null);
    if (record.basedOnEvidenceIds !== undefined) {
      requireValue(Array.isArray(record.basedOnEvidenceIds), 'invalid_evidence_references');
      for (const id of record.basedOnEvidenceIds) {
        if (!ids.has(id)) missing(record, 'basedOnEvidenceIds', id);
        else precedes(ids.get(id), record);
      }
    }
    if (record.parentFactId) {
      if (!ids.has(record.parentFactId)) missing(record, 'parentFactId', record.parentFactId);
      else precedes(ids.get(record.parentFactId), record);
    }
    if (record.kind !== 'observation' && record.rawTreeId !== undefined) {
      const observation = observations.get(record.rawTreeId);
      if (!observation) missing(record, 'rawTreeId', record.rawTreeId);
      else {
        precedes(observation, record);
        requireValue(observation.revision === record.revision, 'invalid_reference_binding', record.evidenceId);
      }
    }
    if (record.kind === 'dispatch-marker' && record.decisionId) {
      const decision = decisions.get(record.decisionId);
      if (!decision) missing(record, 'decisionId', record.decisionId);
      else {
        precedes(decision, record);
        requireValue(decision.revision === record.revision && decision.actionSpecHash === record.actionSpecHash,
          'invalid_reference_binding', record.evidenceId);
      }
    }
    if (record.kind === 'action-receipt') {
      const marker = markers.get(record.actionId);
      if (!marker) missing(record, 'actionId', record.actionId);
      else {
        precedes(marker, record);
        requireValue(record.target === undefined || canonicalJson(record.target) === canonicalJson(marker.target),
          'invalid_reference_binding', record.evidenceId);
      }
    }
    for (const field of ['captureRefs', 'evidenceRefs']) {
      if (record[field] === undefined) continue;
      requireValue(Array.isArray(record[field]), 'invalid_evidence_references');
      for (const ref of record[field]) {
        if (typeof ref !== 'string' || !ids.has(ref)) externalReferences.push({ evidenceId: record.evidenceId, field, ref });
      }
    }
  }
  return {
    recordCount: facts.length,
    firstGlobalSeq: facts[0].globalSeq,
    lastGlobalSeq: facts.at(-1).globalSeq,
    counts,
    targets: [...targets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value),
    coverage: {
      scope: 'retained-host-records',
      priorHistoryComplete: 'unknown',
      referenceClosure: missingReferences.length === 0 ? 'complete' : 'partial',
      missingReferences,
      externalPayloads: 'not-included',
      externalReferences,
      executionStatus: 'not-inferred',
      businessVerdict: 'not-evaluated',
      exclusions: ['external-screenshots', 'mobile-capture-items', 'script-call-results-and-assertions', 'in-memory-events'],
    },
  };
}

function readRegularFile(directory, name, maxBytes) {
  const file = path.join(directory, name);
  const stat = fs.lstatSync(file);
  requireValue(stat.isFile() && !stat.isSymbolicLink(), 'invalid_archive_file', name);
  requireValue(stat.size <= maxBytes, 'archive_limit_exceeded');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    requireValue(opened.isFile() && opened.size <= maxBytes, 'invalid_archive_file', name);
    const bytes = fs.readFileSync(descriptor);
    requireValue(bytes.length <= maxBytes, 'archive_limit_exceeded');
    return bytes;
  } finally { fs.closeSync(descriptor); }
}

function verifyArchive({ archiveDir, manifestSha256 }) {
  textArgument(archiveDir, 'archiveDir');
  requireValue(typeof manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(manifestSha256),
    'invalid_argument', 'manifestSha256');
  const directory = path.resolve(archiveDir);
  requireValue(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink(), 'invalid_archive_directory');
  const manifestBytes = readRegularFile(directory, 'manifest.json', MAX_MANIFEST_BYTES);
  requireValue(sha256(manifestBytes) === manifestSha256, 'manifest_checksum_mismatch');
  const manifest = JSON.parse(manifestBytes);
  requireValue(manifest.schemaVersion === SCHEMA, 'unsupported_archive_schema');
  namespaceArgument(manifest.namespace);
  textArgument(manifest.operationId, 'operationId');
  requireValue(manifest.records?.path === 'records.json', 'invalid_archive_path');
  requireValue(manifest.source?.kind === 'host-fact-store' && typeof manifest.source.storeId === 'string'
    && manifest.source.targetKey === `evidence:${manifest.namespace}:${manifest.operationId}`
    && Number.isSafeInteger(manifest.source.throughGlobalSeq) && manifest.source.throughGlobalSeq >= 0,
  'invalid_archive_source');
  const recordsBytes = readRegularFile(directory, 'records.json', MAX_BYTES);
  requireValue(recordsBytes.length === manifest.records.bytes && sha256(recordsBytes) === manifest.records.sha256,
    'records_checksum_mismatch');
  const analysis = analyzeFacts(JSON.parse(recordsBytes), { namespace: manifest.namespace,
    operationId: manifest.operationId, throughGlobalSeq: manifest.source.throughGlobalSeq });
  for (const [field, expected] of Object.entries(analysis)) {
    requireValue(canonicalJson(manifest[field]) === canonicalJson(expected), 'manifest_analysis_mismatch', field);
  }
  return { ...resultOf(manifest, directory, manifestSha256), integrity: 'verified' };
}

function resultOf(manifest, directory, manifestSha256) {
  return { ok: true, archiveDir: directory, manifestPath: path.join(directory, 'manifest.json'), manifestSha256,
    namespace: manifest.namespace, operationId: manifest.operationId, recordCount: manifest.recordCount,
    targets: manifest.targets, coverage: manifest.coverage };
}

module.exports = { handle, analyzeFacts };
