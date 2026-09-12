'use strict';

const crypto = require('node:crypto');
const { sanitizePersistentValue } = require('../fact-codec');

const NAMESPACES = Object.freeze(['script', 'intent']);
const PROVIDERS = Object.freeze(['native', 'uia', 'flutter', 'h5']);
const RECORD_SCHEMA = 'aab.execution-evidence/v1';
const AGENT_DECISIONS = Object.freeze(['act', 'complete', 'fail', 'inconclusive']);
const KINDS = Object.freeze([
  'observation',
  'summary',
  'plan',
  'decision',
  'dispatch-marker',
  'action-receipt',
  'checkpoint',
  'result',
  'attachment',
]);

function checksumOf(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function serializeRecord(value) {
  try {
    const json = canonicalJson(value);
    JSON.parse(json);
    return { ok: true, json, bytes: Buffer.byteLength(json) };
  } catch (error) {
    return { ok: false, error: 'serialize_failed', detail: error.message || String(error) };
  }
}

function verifyChecksum(record) {
  if (!record || typeof record !== 'object') {
    return { ok: false, error: 'checksum_mismatch' };
  }
  const { checksum, persisted, ...body } = record;
  if (checksumOf(body) !== checksum) {
    return { ok: false, error: 'checksum_mismatch' };
  }
  return { ok: true, record };
}

function requiredFields(kind) {
  if (kind === 'observation') {
    return ['operationId', 'revision', 'target', 'provider', 'capturedAtMs'];
  }
  if (kind === 'summary') {
    return ['operationId', 'revision', 'rawTreeId'];
  }
  if (kind === 'plan') {
    return ['operationId', 'revision', 'planStepId', 'actionSpecHash'];
  }
  if (kind === 'decision') {
    return ['decisionId', 'operationId', 'revision', 'basedOnEvidenceIds', 'actionSpecHash', 'agentDecision'];
  }
  if (kind === 'dispatch-marker') {
    return ['actionId', 'operationId', 'target', 'actionSpecHash'];
  }
  if (kind === 'action-receipt') {
    return ['actionId', 'startedAtMs', 'completedAtMs', 'mechanicalStatus'];
  }
  if (kind === 'checkpoint') {
    return ['operationId', 'revision', 'stepId'];
  }
  if (kind === 'result') {
    return ['operationId', 'revision', 'bytes', 'sha256', 'originalSha256', 'representation'];
  }
  if (kind === 'attachment') {
    return ['operationId', 'revision', 'recordingId', 'sequence', 'payloadKind', 'directory', 'file'];
  }
  return null;
}

function validateRecord(namespace, kind, record, { archivedUnversioned = false } = {}) {
  if (!NAMESPACES.includes(namespace)) {
    return { ok: false, error: 'invalid_namespace' };
  }
  if (!KINDS.includes(kind)) {
    return { ok: false, error: 'invalid_kind' };
  }
  if (!record || typeof record !== 'object') {
    return { ok: false, error: 'invalid_record' };
  }
  if (!archivedUnversioned && record.schemaVersion !== undefined && record.schemaVersion !== RECORD_SCHEMA) {
    return { ok: false, error: 'unsupported_record_schema', field: 'schemaVersion' };
  }
  const fields = archivedUnversioned && kind === 'observation'
    ? ['operationId', 'revision', 'serial', 'packageName', 'provider', 'capturedAtMs'] : requiredFields(kind);
  for (const field of fields) {
    if (record[field] === undefined || record[field] === null || record[field] === '') {
      return { ok: false, error: 'invalid_record', field };
    }
  }
  if (kind === 'result' && (namespace !== 'script' || !Object.hasOwn(record, 'result')
    || !Number.isSafeInteger(record.bytes) || record.bytes < 1
    || !/^[a-f0-9]{64}$/.test(record.sha256) || !/^[a-f0-9]{64}$/.test(record.originalSha256)
    || !['original-json', 'redacted-json'].includes(record.representation))) {
    return { ok: false, error: 'invalid_record', field: 'result' };
  }
  for (const field of ['target', 'observedTarget']) {
    if (archivedUnversioned || record[field] === undefined) continue;
    try {
      require('./execution-target').normalizeExecutionTarget(record[field], { intent: namespace === 'intent', nullable: true });
    } catch (error) {
      return { ok: false, error: 'invalid_record', field: error.field?.replace(/^target/, field), detail: error.message };
    }
  }
  if (kind === 'observation' && !PROVIDERS.includes(record.provider)) {
    return { ok: false, error: 'invalid_provider' };
  }
  if (kind === 'decision' && !AGENT_DECISIONS.includes(record.agentDecision)) {
    return { ok: false, error: 'invalid_agent_decision' };
  }
  if (kind === 'decision' && !Array.isArray(record.basedOnEvidenceIds)) {
    return { ok: false, error: 'invalid_record', field: 'basedOnEvidenceIds' };
  }
  if (kind === 'dispatch-marker' && !record.decisionId && !record.planStepId) {
    return { ok: false, error: 'invalid_record', field: 'decisionId' };
  }
  return { ok: true };
}

// Immutable archive v1/v2 files predate platform targets. Verify their declared
// original fields and checksum without converting them into current targets.
// New execution writes always use validateRecord's current contract.
function validateArchivedRecord(namespace, kind, record) {
  if (record?.schemaVersion === RECORD_SCHEMA) return validateRecord(namespace, kind, record);
  if (record?.schemaVersion !== undefined) return { ok: false, error: 'unsupported_record_schema' };
  return validateRecord(namespace, kind, record, { archivedUnversioned: true });
}

function buildEnvelope(namespace, kind, record, { now, sequence } = {}) {
  const validation = validateRecord(namespace, kind, record);
  if (!validation.ok) return validation;
  const committedAtMs = typeof now === 'function' ? now() : Date.now();
  const revision = record.revision;
  const evidenceId = record.evidenceId || `${namespace}:${kind}:${record.operationId}:${revision}:${sequence}`;
  const body = {
    ...record,
    schemaVersion: RECORD_SCHEMA,
    namespace,
    kind,
    evidenceId,
    revision,
    committedAtMs,
  };
  const serialized = serializeRecord(body);
  if (!serialized.ok) return serialized;
  // Hash the detached JSON representation that the FactStore will persist.
  // Otherwise absent values or write-side redaction change the body after hashing.
  const durableBody = sanitizePersistentValue(JSON.parse(serialized.json));
  const durableSerialized = serializeRecord(durableBody);
  if (!durableSerialized.ok) return durableSerialized;
  return {
    ok: true,
    envelope: {
      ...durableBody,
      checksum: checksumOf(durableBody),
      persisted: true,
    },
    bytes: durableSerialized.bytes,
  };
}

module.exports = {
  AGENT_DECISIONS,
  KINDS,
  NAMESPACES,
  PROVIDERS,
  RECORD_SCHEMA,
  buildEnvelope,
  canonicalJson,
  checksumOf,
  serializeRecord,
  validateRecord,
  validateArchivedRecord,
  verifyChecksum,
};
