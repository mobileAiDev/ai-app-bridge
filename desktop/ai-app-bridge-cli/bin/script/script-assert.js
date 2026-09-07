'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

// The registry is an execution-local verifier, never a second mobile payload store.
function createObservationRegistry({ maxCount = 128, maxBytes = 256 * 1024 } = {}) {
  const entries = new Map();
  let retainedBytes = 0;
  return {
    set(id, record) {
      const bytes = Buffer.byteLength(JSON.stringify(record));
      const previous = entries.get(id);
      if (previous) { retainedBytes -= previous.bytes; entries.delete(id); }
      if (bytes > maxBytes) return;
      while (entries.size >= maxCount || retainedBytes + bytes > maxBytes) {
        const oldest = entries.keys().next().value;
        retainedBytes -= entries.get(oldest).bytes;
        entries.delete(oldest);
      }
      entries.set(id, { record, bytes });
      retainedBytes += bytes;
    },
    get(id) { return entries.get(id)?.record; },
    entries() { return [...entries].map(([id, item]) => [id, item.record]); },
    get retainedCount() { return entries.size; },
    get retainedBytes() { return retainedBytes; },
  };
}

// Stored metadata belongs to the Host. The child only receives a JSON copy.
function issueObservation(observations, evidence, { afterActionId, mutationRevision, pendingMutation, captureValid }, { command, payload, tree = false }) {
  evidence.observationId = randomUUID();
  evidence.window.closedAtMs = Date.now();
  evidence.source = {
    scope: 'execution',
    command,
    payloadSha256: createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex'),
  };
  if (tree && evidence.refs.length === 0) {
    evidence.refs = [{ stream: 'tree', hostObservationId: evidence.observationId, ...evidence.source }];
  }
  observations.set(evidence.observationId, {
    evidence: structuredClone(evidence),
    afterActionId,
    mutationRevision,
    pendingMutation,
    captureValid,
  });
  return evidence;
}

function judgeAssertion(assertion, observations, { afterActionId = null, mutationRevision = 0, pendingMutation = false } = {}) {
  const scope = assertion.scope || 'device';
  const result = (verdict, reason) => ({
    verdict,
    name: assertion.name || null,
    scope,
    ...(reason ? { reason } : {}),
  });
  if (scope !== 'device' && scope !== 'code') return result('inconclusive', 'assertion_scope_invalid');
  if (typeof assertion.condition !== 'boolean') return result('inconclusive', 'assertion_condition_not_boolean');
  if (scope === 'code') {
    if (assertion.evidence != null || (assertion.requiredEvidence || []).length > 0) {
      return result('inconclusive', 'code_assertion_cannot_claim_device_evidence');
    }
    return result(assertion.condition ? 'passed' : 'failed');
  }
  const evidence = assertion.evidence;
  const issued = observations.get(evidence?.observationId);
  if (!issued || !isDeepStrictEqual(evidence, issued.evidence)) {
    return result('inconclusive', 'evidence_not_host_issued');
  }
  const coverage = issued.evidence.coverage;
  if (coverage.status !== 'complete' || coverage.gap !== false || coverage.committed !== true) {
    return result('inconclusive', 'evidence_coverage_incomplete');
  }
  if (
    pendingMutation || issued.pendingMutation
    || issued.mutationRevision !== mutationRevision
    || issued.afterActionId !== afterActionId
  ) {
    return result('inconclusive', 'evidence_action_window_stale');
  }
  if (issued.captureValid === false) return result('inconclusive', 'capture_boundary_not_host_observed');
  const refs = issued.evidence.refs;
  if (!Array.isArray(refs) || refs.length === 0) return result('inconclusive', 'device_evidence_refs_empty');
  const streams = new Set(refs.map((ref) => ref.stream));
  if ((assertion.requiredEvidence || []).some((stream) => !streams.has(stream))) {
    return result('inconclusive', 'required_evidence_missing');
  }
  return result(assertion.condition ? 'passed' : 'failed');
}

module.exports = { createObservationRegistry, issueObservation, judgeAssertion };
