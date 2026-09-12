'use strict';

const { canonicalJson, checksumOf } = require('../shared-kernel/evidence-schema');
const { sanitizePersistentValue } = require('../fact-codec');
const { scriptError } = require('./script-errors');

// This is an execution output, separate from the bounded progress stream and
// from live mobile capture queries. It follows the same write-side redaction.
function prepareScriptResult(value, maxBytes) {
  const original = JSON.parse(JSON.stringify(value ?? null));
  const result = sanitizePersistentValue(original);
  const bytes = Buffer.byteLength(canonicalJson(result));
  if (Buffer.byteLength(canonicalJson(original)) > maxBytes || bytes > maxBytes) {
    return { ok: false, error: 'output_too_large' };
  }
  const sha256 = checksumOf(result), originalSha256 = checksumOf(original);
  return { ok: true, result, bytes, sha256, originalSha256,
    representation: sha256 === originalSha256 ? 'original-json' : 'redacted-json' };
}

function resultReference(receipt, prepared) {
  return { evidenceId: receipt.evidenceId, bytes: prepared.bytes, sha256: prepared.sha256,
    originalSha256: prepared.originalSha256, representation: prepared.representation };
}

function readScriptResult({ store, operationId }) {
  if (!store) return scriptError('result_not_persisted', { operationId });
  try {
    let checkpoint = store.latest(operationId, 'checkpoint');
    if (!checkpoint) return scriptError('unknown_operation', { operationId });
    const checked = store.read(checkpoint.evidenceId);
    if (!checked.ok) return scriptError(checked.error, { operationId });
    checkpoint = checked.record;
    if (checkpoint.status !== 'completed') {
      return scriptError(['cancelled', 'failed'].includes(checkpoint.status) ? 'result_unavailable' : 'result_not_ready',
        { operationId, status: checkpoint.status, executionError: checkpoint.error ?? null });
    }
    const ref = checkpoint.resultRef;
    if (!ref) return scriptError('result_not_persisted', { operationId });
    const loaded = store.read(ref.evidenceId);
    if (!loaded.ok) return scriptError(loaded.error === 'not_found' ? 'result_not_retained' : loaded.error, { operationId, resultRef: ref });
    const body = loaded.record;
    if (body.kind !== 'result' || body.operationId !== operationId || body.revision !== checkpoint.revision
      || !Object.hasOwn(body, 'result') || checksumOf(body.result) !== ref.sha256
      || Buffer.byteLength(canonicalJson(body.result)) !== ref.bytes
      || body.sha256 !== ref.sha256 || body.bytes !== ref.bytes
      || body.originalSha256 !== ref.originalSha256 || body.representation !== ref.representation) {
      return scriptError('result_checksum_mismatch', { operationId, resultRef: ref });
    }
    return { ok: true, command: 'script', operationId, status: 'completed',
      result: body.result, resultRef: ref, persisted: true };
  } catch (error) {
    return scriptError(error.code || 'result_read_failed', { operationId });
  }
}

module.exports = { prepareScriptResult, resultReference, readScriptResult };
