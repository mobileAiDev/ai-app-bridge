'use strict';

const { compileScriptSpec, scriptHash } = require('./script-spec');
const { scriptError } = require('./script-errors');
const { readScriptResult } = require('./script-result');
const { verifyChecksum, checksumOf } = require('../shared-kernel/evidence-schema');

const RESTORE_CONTEXT = Symbol('scriptRestoreContext');

function unmatchedPreparedAction(store, operationId) {
  const records = store.list(operationId);
  return records.some((marker) => {
    if (marker.kind !== 'dispatch-marker' || marker.state !== 'prepared') return false;
    const receipt = records.find((item) => item.kind === 'action-receipt' && item.actionId === marker.actionId);
    return !receipt || receipt.ambiguous === true;
  });
}

function loadDurableCheckpoint(store, operationId) {
  if (!store || typeof store.latest !== 'function' || typeof store.list !== 'function' || !operationId) {
    return scriptError('unknown_operation', { operationId: operationId || null });
  }
  const records = store.list(operationId);
  for (const record of records) {
    if (!verifyChecksum(record).ok) return scriptError('checksum_mismatch', { operationId });
  }
  const checkpoint = records.filter((item) => item.kind === 'checkpoint').at(-1);
  if (!checkpoint) return scriptError('unknown_operation', { operationId });
  if (unmatchedPreparedAction(store, operationId)) {
    return scriptError('ambiguous', { operationId, status: 'ambiguous', pauseReason: 'ambiguous' });
  }
  const actionSequence = records.reduce((maximum, item) => Math.max(maximum, item.actionSequence || 0), checkpoint.actionSequence || 0);
  return { ok: true, checkpoint, records, actionSequence };
}

function planCodeRestore({ checkpoint, script } = {}) {
  if (!checkpoint) return scriptError('unknown_operation');
  if (checkpoint.script && Array.isArray(checkpoint.script.steps)) {
    return scriptError('script_format_removed');
  }
  const candidate = script;
  if (candidate?.target && checkpoint.target && checksumOf(candidate.target) !== checksumOf(checkpoint.target)) {
    return scriptError('script_target_mismatch');
  }
  if (candidate?.permissions && checkpoint.permissions && checksumOf(candidate.permissions) !== checksumOf(checkpoint.permissions)) {
    return scriptError('script_permissions_mismatch');
  }
  let input = candidate;
  if (input === undefined) {
    if (!checkpoint.source || !checkpoint.language) return scriptError('script_source_required', { hash: checkpoint.hash || null });
    input = { schemaVersion: 'aab.code-script/v1' };
    // The durable record owns the frozen program. Omit absent optional fields
    // instead of injecting undefined or mixing it with a caller's program.
    for (const field of ['name', 'language', 'source', 'target', 'permissions', 'policy', 'inputs', 'entrypoint']) {
      if (Object.hasOwn(checkpoint, field)) input[field] = checkpoint[field];
    }
  }
  const compiled = compileScriptSpec(input);
  if (!compiled.ok) return compiled;
  if (candidate === undefined && checkpoint.sourcePath) {
    compiled.spec.sourcePath = checkpoint.sourcePath;
    compiled.hash = scriptHash(compiled.spec);
  }
  if (checkpoint.hash && compiled.hash !== checkpoint.hash) {
    return scriptError('script_hash_mismatch', {
      hash: checkpoint.hash,
      provided: compiled.hash,
    });
  }
  return { ok: true, format: 'code', compiled, checkpoint };
}

function codeStartCheckpoint(compiled, operationId) {
  const spec = compiled.spec;
  const body = {
    operationId,
    revision: 1,
    stepId: 'start',
    status: 'running',
    hash: compiled.hash,
    language: spec.language,
    sourcePath: spec.sourcePath,
    name: spec.name,
    target: spec.target,
    permissions: spec.permissions,
    policy: spec.policy,
    inputs: spec.inputs,
    entrypoint: spec.entrypoint,
    actionSequence: 0,
  };
  if (spec.policy.restartPolicy === 'checkpoint') {
    body.source = spec.source;
  }
  return body;
}

function codeRuntimeCheckpoint(record, checkpoint, revision) {
  return {
    ...codeStartCheckpoint({ spec: record.spec, hash: record.hash }, record.operationId),
    revision,
    stepId: checkpoint.name,
    checkpoint,
    actionSequence: record.actionSequence,
    checkpointActionSequence: record.actionSequence,
  };
}

function specFromCompiled(compiled) {
  const spec = compiled.spec;
  return {
    schemaVersion: 'aab.code-script/v1',
    name: spec.name,
    language: spec.language,
    source: spec.source,
    target: spec.target,
    permissions: spec.permissions,
    policy: spec.policy,
    inputs: spec.inputs,
    entrypoint: spec.entrypoint,
  };
}

function restartGate(checkpoint, records = []) {
  if (checkpoint.policy?.restartPolicy !== 'checkpoint' || !checkpoint.checkpoint) {
    return scriptError('not_resumable', { restartPolicy: checkpoint.policy?.restartPolicy || 'none' });
  }
  if (checkpoint.status === 'completed' || checkpoint.status === 'cancelled'
      || (checkpoint.status === 'failed' && !['child_crashed', 'runtime_lost'].includes(checkpoint.error))) {
    return scriptError('not_resumable', { status: checkpoint.status });
  }
  // A receipt can confirm an effect while the language state still precedes it.
  // Re-entering that checkpoint would repeat the effect, so require reconciliation.
  const boundary = checkpoint.checkpointActionSequence || 0;
  if (records.some((item) => item.kind === 'action-receipt'
      && item.actionSequence > boundary && item.dispatched !== false)) {
    return scriptError('ambiguous', { status: 'ambiguous', pauseReason: 'checkpoint_precedes_action' });
  }
  return { ok: true };
}

async function restoreUnknownOperation(args = {}) {
  const { store, operationId, script, supervisor } = args;
  const loaded = loadDurableCheckpoint(store, operationId);
  if (!loaded.ok) return loaded;
  const checkpoint = loaded.checkpoint;
  if (checkpoint.script && Array.isArray(checkpoint.script.steps)) return scriptError('script_format_removed');
  const op = args.operation || 'status';
  const gate = restartGate(checkpoint, loaded.records);
  if (op === 'status' || op === 'wait') {
    const terminal = ['completed', 'cancelled', 'failed'].includes(checkpoint.status);
    const result = checkpoint.status === 'completed' && checkpoint.resultRef
      ? readScriptResult({ store, operationId }) : null;
    if (result?.ok === false) return { ...result, status: 'failed', restored: true, resumable: false };
    return {
      ok: true,
      command: 'script',
      operationId,
      status: terminal ? checkpoint.status : 'failed',
      error: terminal ? checkpoint.error || null : 'runtime_lost',
      persisted: true,
      restored: true,
      resumeMode: gate.ok ? 'checkpoint' : 'none',
      resumable: gate.ok,
      hash: checkpoint.hash || null,
      resultRef: checkpoint.resultRef ?? null,
    };
  }
  if (op !== 'resume') return scriptError('not_resumable', { operationId });
  if (!gate.ok) return { ...gate, operationId };
  const planned = planCodeRestore({ checkpoint, script });
  if (!planned.ok) return planned;
  return supervisor.handle({
    ...args,
    operation: 'start',
    script: specFromCompiled(planned.compiled),
    [RESTORE_CONTEXT]: {
      compiled: planned.compiled,
      checkpoint: checkpoint.checkpoint,
      revision: checkpoint.revision,
      actionSequence: loaded.actionSequence,
      checkpointActionSequence: checkpoint.checkpointActionSequence || 0,
    },
  });
}

module.exports = {
  unmatchedPreparedAction,
  loadDurableCheckpoint,
  planCodeRestore,
  codeStartCheckpoint,
  codeRuntimeCheckpoint,
  restoreUnknownOperation,
  RESTORE_CONTEXT,
  restartGate,
};
