'use strict';

const { compileScriptSpec, isCodeScript, scriptHash } = require('./script-spec');
const { scriptError } = require('./script-errors');
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
    return { ok: true, format: 'steps', checkpoint };
  }
  const candidate = script && isCodeScript(script) ? script : null;
  if (candidate?.target && checkpoint.target && checksumOf(candidate.target) !== checksumOf(checkpoint.target)) {
    return scriptError('script_target_mismatch');
  }
  if (candidate?.permissions && checkpoint.permissions && checksumOf(candidate.permissions) !== checksumOf(checkpoint.permissions)) {
    return scriptError('script_permissions_mismatch');
  }
  const source = candidate && candidate.source ? candidate.source : checkpoint.source;
  const language = candidate && candidate.language ? candidate.language : checkpoint.language;
  if (!source || !language) {
    return scriptError('script_source_required', { hash: checkpoint.hash || null });
  }
  const compiled = compileScriptSpec({
    schemaVersion: 'aab.code-script/v1',
    name: (candidate && candidate.name) || checkpoint.name || 'script',
    language,
    source,
    target: checkpoint.target || candidate?.target,
    permissions: checkpoint.permissions || candidate?.permissions,
    policy: (candidate && candidate.policy) || checkpoint.policy,
    inputs: (candidate && candidate.inputs) || checkpoint.inputs,
    entrypoint: (candidate && candidate.entrypoint) || checkpoint.entrypoint,
  });
  if (!compiled.ok) return compiled;
  if (checkpoint.sourcePath) {
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
  if (checkpoint.script && Array.isArray(checkpoint.script.steps)) return { ok: true, format: 'steps', checkpoint };
  const op = args.operation || 'status';
  const gate = restartGate(checkpoint, loaded.records);
  if (op === 'status' || op === 'wait' || op === 'progress') {
    const terminal = ['completed', 'cancelled', 'failed'].includes(checkpoint.status);
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
