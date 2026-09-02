'use strict';

const { buildEnvelope, verifyChecksum } = require('./evidence-schema');

function createEvidenceStore({ namespace, adapter, now = Date.now, maxBytes = 8 * 1024 * 1024 } = {}) {
  if (namespace !== 'script' && namespace !== 'intent') {
    throw new TypeError('namespace must be script or intent');
  }
  if (!adapter || typeof adapter.record !== 'function' || typeof adapter.readById !== 'function') {
    throw new TypeError('adapter with record/readById is required');
  }
  let sequence = 0;

  async function persist(kind, record) {
    sequence += 1;
    const built = buildEnvelope(namespace, kind, record, { now, sequence });
    if (!built.ok) {
      return { ok: false, persisted: false, error: built.error, field: built.field, detail: built.detail };
    }
    if (built.bytes > maxBytes) {
      return { ok: false, persisted: false, error: 'payload_too_large', bytes: built.bytes, maxBytes };
    }
    let receipt;
    try {
      receipt = await adapter.record(built.envelope);
    } catch (error) {
      return {
        ok: false,
        persisted: false,
        error: error.code || 'persist_failed',
        detail: error.message || String(error),
      };
    }
    if (!receipt || receipt.ok === false) {
      return {
        ok: false,
        persisted: false,
        error: receipt?.error || 'persist_failed',
        detail: receipt?.detail,
      };
    }
    return {
      ok: true,
      persisted: true,
      evidenceId: built.envelope.evidenceId,
      checksum: built.envelope.checksum,
      revision: built.envelope.revision,
      kind,
      namespace,
    };
  }

  function read(evidenceId) {
    const record = adapter.readById(evidenceId);
    if (!record) {
      return { ok: false, error: 'not_found' };
    }
    if (record.namespace !== namespace) {
      return { ok: false, error: 'namespace_mismatch' };
    }
    const verified = verifyChecksum(record);
    if (!verified.ok) return verified;
    return { ok: true, record: verified.record };
  }

  function list(operationId) {
    return (adapter.list?.({ namespace, operationId }) || []).filter((item) => item.namespace === namespace);
  }

  function latest(operationId, kind) {
    const matches = list(operationId).filter((item) => item.kind === kind);
    return matches.length === 0 ? null : matches[matches.length - 1];
  }

  function canExposeRevision(operationId) {
    const observation = latest(operationId, 'observation');
    if (!observation || observation.persisted !== true) {
      return { ok: false, error: 'evidence_not_persisted' };
    }
    const verified = verifyChecksum(observation);
    if (!verified.ok) return verified;
    return { ok: true, revision: observation.revision, evidenceId: observation.evidenceId };
  }

  function canPrepareAction(operationId) {
    const exposed = canExposeRevision(operationId);
    if (!exposed.ok) return exposed;
    const plan = latest(operationId, 'plan');
    const decision = latest(operationId, 'decision');
    if (!plan && !decision) {
      return { ok: false, error: 'plan_or_decision_not_persisted' };
    }
    return { ok: true, revision: exposed.revision, plan, decision };
  }

  function canDispatch(operationId) {
    const prepared = canPrepareAction(operationId);
    if (!prepared.ok) return prepared;
    const marker = latest(operationId, 'dispatch-marker');
    if (!marker || marker.persisted !== true) {
      return { ok: false, error: 'dispatch_marker_not_persisted' };
    }
    const verified = verifyChecksum(marker);
    if (!verified.ok) return { ok: false, error: 'checksum_mismatch' };
    return { ok: true, marker, revision: prepared.revision };
  }

  function status() {
    return adapter.status?.() || { ok: true };
  }

  return {
    namespace,
    persist,
    read,
    list,
    latest,
    canExposeRevision,
    canPrepareAction,
    canDispatch,
    status,
    close: () => adapter.close?.(),
  };
}

module.exports = { createEvidenceStore };
