'use strict';

const { createEvidenceStore } = require('./shared-kernel/evidence-store');
const { canonicalJson, validateRecord } = require('./shared-kernel/evidence-schema');
const { CommandError } = require('./command-errors');
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

function responseSchema() {
  return { type: 'object', additionalProperties: false, required: ['operation', 'ref'], properties: {
    operation: { const: 'read' },
    ref: { type: 'object', additionalProperties: false, required: ['namespace', 'evidenceId', 'checksum', 'operationId'], properties: {
      namespace: { const: 'response' }, evidenceId: { type: 'string', minLength: 1, maxLength: 256 },
      operationId: { type: 'string', minLength: 1, maxLength: 128 }, checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    }, description: 'Pass control.source.ref unchanged. Reads the saved response; never repeats the original device action.' },
  } };
}

// Detach using the public JSON encoding before sorting keys. These same bytes
// supply immediate extraction and durable storage, after all feedback is added.
function freezeResponse(body) {
  const { source, ...control } = body.control;
  const snapshot = JSON.parse(JSON.stringify({ kind: body.kind, value: body.value, execution: body.execution, control,
    identity: { command: body.command, responseId: source.responseId, capturedAtMs: source.capturedAtMs } }));
  const bytes = Buffer.from(canonicalJson(snapshot));
  return { snapshot: JSON.parse(bytes), bytes };
}

function createResponseStore({ adapter, now } = {}) {
  const evidence = createEvidenceStore({ namespace: 'response', adapter, now,
    maxBytes: Math.ceil(MAX_SNAPSHOT_BYTES / 3) * 4 + 64 * 1024 });
  async function save({ snapshot, bytes }) {
    const identity = snapshot.identity;
    const source = { responseId: identity.responseId, capturedAtMs: identity.capturedAtMs, persisted: false };
    if (snapshot.kind === 'bytes') return { ...source, error: 'binary_snapshot_unsupported' };
    if (bytes.length > MAX_SNAPSHOT_BYTES) return { ...source, error: 'snapshot_too_large', bytes: bytes.length, maxBytes: MAX_SNAPSHOT_BYTES };
    const stored = await evidence.persist('response', { operationId: identity.responseId, revision: 1, snapshotBase64: bytes.toString('base64') });
    if (!stored.ok) return { ...source, error: stored.error };
    return { ...source, persisted: true, ref: { namespace: 'response', evidenceId: stored.evidenceId,
      checksum: stored.checksum, operationId: identity.responseId } };
  }
  function read(ref) {
    const result = evidence.read(ref.evidenceId);
    if (!result.ok) throw new CommandError(`response_${result.error}`, result.error === 'not_found'
      ? 'Saved response is missing, expired or evicted. No device action was repeated.' : 'Saved response integrity verification failed.');
    const record = result.record;
    if (record.checksum !== ref.checksum) throw new CommandError('response_checksum_mismatch', 'The supplied ref does not match the saved response checksum.');
    if (record.operationId !== ref.operationId) throw new CommandError('response_identity_mismatch', 'The supplied ref does not match the saved response identity.');
    if (!validateRecord('response', 'response', record).ok) throw new CommandError('response_invalid_snapshot', 'The saved response has an invalid snapshot.');
    const bytes = Buffer.from(record.snapshotBase64, 'base64');
    if (bytes.length > MAX_SNAPSHOT_BYTES) throw new CommandError('response_snapshot_too_large', 'The saved response exceeds the 8 MiB input limit.');
    const snapshot = JSON.parse(bytes);
    return { snapshot, bytes, source: { responseId: snapshot.identity.responseId,
      capturedAtMs: snapshot.identity.capturedAtMs, persisted: true, ref } };
  }
  return { save, read };
}

module.exports = { createResponseStore, freezeResponse, responseSchema, MAX_SNAPSHOT_BYTES };
