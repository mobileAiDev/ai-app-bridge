'use strict';

const { bindCommandTarget } = require('../shared-kernel/execution-target');
const { authorizeCommand } = require('./script-catalog');

const { createBoundedEventLog, createBoundedScriptRegistry } = require('./bounded-script-registry');
const { createScriptAgentPort } = require('./script-agent-port');
const { createScriptHostPort, unavailableEnvelope } = require('./script-host-port');
const { checksumOf } = require('../shared-kernel/evidence-schema');
const { createNodeRuntimeAdapter } = require('./node-runtime-adapter');
const { createProgressProjector } = require('./progress-projector');
const { createPythonRuntimeAdapter, inspectPython } = require('./python-runtime-adapter');
const { createRollingSummary } = require('./rolling-summary');
const { catalogPayload } = require('./script-catalog');
const { isMutationCommand } = require('../command-registry');
const { runExecution } = require('../shared-kernel/execution-scope');
const { compileScriptSpec, isCodeScript } = require('./script-spec');
const { createScriptLedger, scriptEventTarget } = require('./script-ledger');
const {
  codeRuntimeCheckpoint,
  codeStartCheckpoint,
  RESTORE_CONTEXT,
  restartGate,
} = require('./script-durable-restore');
const { scriptError } = require('./script-errors');
const { createEvidenceRecording } = require('../shared-kernel/evidence-recording');
const { prepareScriptResult, resultReference, readScriptResult } = require('./script-result');

function createDefaultRuntime(opts = {}) {
  if (opts.language === 'javascript') return createNodeRuntimeAdapter(opts);
  if (opts.language === 'python') return createPythonRuntimeAdapter(opts);
  throw new TypeError('runtime_unavailable');
}

function createScriptSupervisor({
  registry = createBoundedScriptRegistry(),
  createRuntime = createDefaultRuntime,
  createHost = createScriptHostPort,
  createAgent = createScriptAgentPort,
  createLedger = createScriptLedger,
  now = Date.now,
} = {}) {
  let sequence = 0;
  const scriptLedger = createLedger();

  function handle(args = {}) {
    const operation = args.operation || 'start';
    if (operation === 'start') return start(args);
    if (operation === 'result') return readScriptResult({ ...args, store: registry.get(args.operationId)?.store || args.store });
    if (operation === 'status') {
      const limitGate = rejectBadLimit(args);
      if (limitGate) return limitGate;
      return snapshot(args);
    }
    if (operation === 'wait') {
      const limitGate = rejectBadLimit(args);
      if (limitGate) return limitGate;
      return wait(args);
    }
    if (operation === 'pause') return control(args, 'pause_requested');
    if (operation === 'resume') return resume(args);
    if (operation === 'decide') return decide(args);
    if (operation === 'cancel') return control(args, 'cancelled');
    if (operation === 'runtime-status') return { ok: true, command: 'script', runtimes: inspectRuntimes() };
    return scriptError('invalid_operation', { operation });
  }

  function start(args) {
    const compiled = args[RESTORE_CONTEXT]?.compiled || compileScriptSpec(args.script);
    if (!compiled.ok) return compiled;
    if (args.operationId && knownOperation(args.operationId)) {
      return scriptError('operation_exists', { operationId: args.operationId });
    }
    sequence += 1;
    const operationId = args.operationId || `script-${now()}-${sequence}`;
    if (args.store?.latest?.(operationId, 'checkpoint') && !args[RESTORE_CONTEXT]) {
      return scriptError('operation_exists', { operationId });
    }
    let recording = null;
    if (args.recordingDir !== undefined) {
      if (compiled.spec.policy.restartPolicy !== 'none') {
        return scriptError('recording_restart_unsupported', { operationId });
      }
      try {
        recording = createEvidenceRecording({ directory: args.recordingDir, namespace: 'script',
          operationId, store: args.store, now });
      } catch (error) { return scriptError(error.code || 'recording_failed', { operationId }); }
    }
    const events = createBoundedEventLog({
      maxEvents: registry.maxEvents,
      maxEventBytes: registry.maxEventBytes,
    });
    const agent = args.agent || createAgent();
    let host;
    try {
      host = args.host || createHost({
      handlers: args.handlers,
      permissions: compiled.spec.permissions,
      executionId: operationId,
      runner: args.runner,
      actions: args.actions,
      query: args.query,
      mutationLease: args.mutationLease,
      target: compiled.spec.target,
      });
    } catch (error) {
      return scriptError(error.message === 'actions' ? 'host_actions_required' : error.message, { operationId });
    }
    const runtime = args.runtime || createRuntime({
      program: args.program,
      language: compiled.spec.language,
      spec: compiled.spec,
      pythonPath: args.pythonPath,
    });
    if (runtime.unavailable) {
      return scriptError('runtime_unavailable', { language: compiled.spec.language });
    }
    if (args.store && typeof args.store.persist === 'function' && !args[RESTORE_CONTEXT]) {
      return persistStart(args, {
        compiled,
        operationId,
        events,
        agent,
        host,
        runtime,
        recording,
      });
    }
    return finishStart(args, {
      compiled,
      operationId,
      events,
      agent,
      host,
      runtime,
      recording,
    });
  }

  async function persistStart(args, parts) {
    const persisted = await args.store.persist(
      'checkpoint',
      { ...codeStartCheckpoint(parts.compiled, parts.operationId),
        ...(parts.recording ? { recording: parts.recording.info() } : {}) },
    );
    if (!persisted.ok) {
      return scriptError(persisted.error || 'checkpoint_not_persisted', { operationId: parts.operationId });
    }
    return finishStart(args, parts);
  }

  function finishStart(args, { compiled, operationId, events, agent, host, runtime, recording }) {
    const startedAtMs = now();
    const restoreContext = args[RESTORE_CONTEXT] || null;
    const record = {
      operationId,
      spec: compiled.spec,
      hash: compiled.hash,
      status: 'running',
      pauseReason: null,
      error: null,
      events,
      agent,
      host,
      runtime,
      startedAtMs,
      finished: false,
      projector: createProgressProjector(),
      summary: createRollingSummary({ operationId, startedAtMs }),
      lastMaterialAtMs: startedAtMs,
      inFlightMutations: 0,
      mutationUnknown: false,
      decisionRevision: 0,
      currentRequestId: null,
      questionRevisions: new Map(),
      decisions: new Map(),
      ledger: scriptLedger,
      store: args.store || null,
      recording,
      lastCheckpoint: restoreContext && restoreContext.checkpoint,
      checkpointRevision: Number(restoreContext && restoreContext.revision) || 1,
      actionSequence: Number(restoreContext && restoreContext.actionSequence) || 0,
      checkpointActionSequence: Number(restoreContext && restoreContext.checkpointActionSequence) || 0,
      actionsSinceCheckpoint: [],
      durableError: null,
      persistTail: Promise.resolve(),
      pendingCalls: new Set(),
    };
    record.host = trackHost(host, record, now);
    record.agent = trackAgent(agent, record, now);
    const stored = registry.put(operationId, record);
    if (!stored.ok) return scriptError(stored.error, { operationId });
    emitRecord(record, 'script_started', { status: 'running' }, now);
    startHeartbeat(record, now);
    record.running = startRuntime(record, now);
    return Promise.resolve(snapshotOf(record, args));
  }

  function startRuntime(record, now) {
    record.controller = new AbortController();
    record.deadlineMs = Date.now() + record.spec.policy.timeoutMs;
    record.cancelling = false;
    record.cancelPromise = null;
    return Promise.resolve()
      .then(() => record.runtime.start({
        spec: record.spec,
        host: record.host,
        agent: record.agent,
        emit: (type, extra) => {
          const pending = emitRuntimeRecord(record, type, extra, now);
          return type === 'checkpoint' ? trackPending(record, pending) : pending;
        },
        now,
        control: () => ({
          status: record.status,
          pauseReason: record.pauseReason,
          checkpoint: record.lastCheckpoint,
        }),
      }))
      .then((result) => finishRuntime(record, result, now))
      .catch(async () => {
        if (typeof record.runtime.stop === 'function') await record.runtime.stop();
        return finishRuntime(record, { ok: false, error: 'child_crashed' }, now);
      });
  }

  async function finishRuntime(record, result, now) {
    if (record.cancelling || record.status === 'cancelled') return { ok: false, error: 'cancelled' };
    if (Date.now() >= record.deadlineMs) result = { ok: false, error: 'timeout' };
    record.status = 'finishing';
    record.controller.abort({ code: result?.error === 'timeout' ? 'deadline_exceeded' : 'runtime_stopped' });
    await Promise.allSettled([...record.pendingCalls]);
    const error = record.durableError || (record.mutationUnknown || record.inFlightMutations > 0 ? 'ambiguous' : result?.error || null);
    const status = error || result?.ok === false ? 'failed' : 'completed';
    return commitTerminal(record, status, error, now, result);
  }

  async function wait(args) {
    if (args.isolatedTimeoutMs != null && args._scriptWaitHostTimeout !== true) {
      return scriptError('unsupported_argument', { field: 'isolatedTimeoutMs' });
    }
    const record = registry.get(args.operationId);
    if (!record) return ledgerSnapshot(args, { timedOut: false });
    const resolved = resolveWaitMs(args.waitMs);
    if (!resolved.ok) return resolved;
    const waitMs = resolved.waitMs;
    const after = Number(args.afterSequence) || 0;
    if (waitMs === 0) {
      return snapshotOf(record, args, {
        timedOut: !hasWaitSignal(record, after),
        waitMs,
      });
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (timedOut) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        if (timer) clearTimeout(timer);
        resolve(snapshotOf(record, args, { timedOut, waitMs }));
      };
      const unsubscribe = record.events.subscribe(() => {
        if (hasWaitSignal(record, after)) finish(false);
      });
      if (hasWaitSignal(record, after)) {
        finish(false);
        return;
      }
      timer = setTimeout(() => finish(true), waitMs);
    });
  }

  function snapshot(args) {
    const record = registry.get(args.operationId);
    if (!record) return ledgerSnapshot(args);
    return snapshotOf(record, args);
  }

  function ledgerSnapshot(args, extra = {}) {
    const operationId = args.operationId || null;
    const snap = scriptLedger.ledger.snapshot(operationId);
    if (!snap.lastFact) {
      return scriptError('unknown_operation', { operationId });
    }
    const terminalFact = ['script_completed', 'script_cancelled', 'script_failed']
      .map((kind) => scriptLedger.ledger.latest(operationId, kind))
      .filter(Boolean).sort((a, b) => b.sequence - a.sequence)[0];
    const statusFact = terminalFact || snap.lastFact;
    return {
      ok: true,
      command: 'script',
      operationId,
      status: statusFromFact(statusFact),
      pauseReason: null,
      error: statusFact.payloadSummary ? statusFact.payloadSummary.error || null : null,
      hash: null,
      resultRef: statusFact.payloadSummary?.resultRef ?? null,
      eventSequence: snap.lastSequence,
      events: [],
      rollingSummary: null,
      history: scriptLedger.ledger.query(
        operationId,
        args.afterSequence == null ? 0 : args.afterSequence,
        args.limit,
      ),
      ...extra,
    };
  }

  function control(args, status) {
    const record = registry.get(args.operationId);
    if (!record) return scriptError('unknown_operation', { operationId: args.operationId || null });
    if (record.finished || record.status === 'finishing') return snapshotOf(record, args);
    if (record.cancelling && status !== 'cancelled') return snapshotOf(record, args);
    if (status === 'cancelled') {
      if (record.cancelPromise) {
        return record.cancelPromise.then(() => snapshotOf(record, args));
      }
      record.cancelling = true;
      record.status = 'cancelling';
      emitRecord(record, 'cancel_requested', { status: record.status }, now);
      record.controller.abort({ code: 'cancelled' });
      record.cancelPromise = Promise.resolve()
        .then(() => (typeof record.runtime.stop === 'function' ? record.runtime.stop() : null))
        .then(async () => {
          await Promise.allSettled([...record.pendingCalls]);
          await commitTerminal(record, 'cancelled', record.durableError || (record.mutationUnknown ? 'ambiguous' : null), now);
          record.pauseReason = record.status === 'cancelled' ? 'cancelled' : null;
          stopHeartbeat(record);
          return snapshotOf(record, args);
        });
      return record.cancelPromise;
    }
    if (record.inFlightMutations > 0) {
      record.status = 'pause_requested';
      record.pauseReason = 'pause_requested';
      emitRecord(record, 'pause_requested', { status: 'pause_requested' }, now);
      pushControl(record);
      return snapshotOf(record, args);
    }
    record.status = 'paused_manual';
    record.pauseReason = status;
    emitRecord(record, 'paused', { status: record.status }, now);
    pushControl(record);
    return snapshotOf(record, args);
  }

  function resume(args) {
    const record = registry.get(args.operationId);
    if (!record) return scriptError('unknown_operation', { operationId: args.operationId || null });
    if (record.cancelling) return scriptError('runtime_stopped', { operationId: record.operationId });
    if (record.status === 'finishing') return scriptError('not_resumable', { operationId: record.operationId });
    if (record.mutationUnknown || record.inFlightMutations > 0) {
      return scriptError('ambiguous', { operationId: record.operationId, status: 'ambiguous' });
    }
    if (record.finished) {
      const gate = restartGate({
        policy: record.spec.policy,
        checkpoint: record.lastCheckpoint,
        checkpointActionSequence: record.checkpointActionSequence,
        status: record.status,
        error: record.error,
      }, record.actionsSinceCheckpoint);
      if (!gate.ok) return { ...gate, operationId: record.operationId };
      record.finished = false;
      record.status = 'running';
      record.error = null;
          record.pauseReason = null;
      record.mutationUnknown = false;
      emitRecord(record, 'resumed', { status: 'running' }, now);
      startHeartbeat(record, now);
      record.running = startRuntime(record, now);
      pushControl(record);
      return snapshotOf(record, args);
    }
    record.status = 'running';
    record.pauseReason = null;
    record.mutationUnknown = false;
    emitRecord(record, 'resumed', { status: 'running' }, now);
    pushControl(record);
    return snapshotOf(record, args);
  }

  function decide(args) {
    const record = registry.get(args.operationId);
    if (!record) return scriptError('unknown_operation', { operationId: args.operationId || null });
    if (!Object.hasOwn(args, 'decision') || args.decision === undefined) {
      return scriptError('invalid_argument', { field: 'decision' });
    }
    if (args.revision == null) {
      return scriptError('stale_decide', { revision: record.decisionRevision });
    }
    if (!record.questionRevisions.has(args.requestId)) {
      return scriptError('invalid_argument', { field: 'requestId' });
    }
    if (args.revision !== record.questionRevisions.get(args.requestId)) {
      return scriptError('stale_decide', { revision: record.questionRevisions.get(args.requestId) });
    }
    if (record.decisions.has(args.requestId)) {
      if (checksumOf(record.decisions.get(args.requestId)) !== checksumOf(args.decision)) {
        return scriptError('invalid_argument', { field: 'decision' });
      }
      return snapshotOf(record, args);
    }
    if (record.cancelling || record.finished || record.status === 'finishing') return scriptError('runtime_stopped', { operationId: record.operationId });
    const decided = record.agent.decide(args.requestId, args.decision);
    if (!decided.ok) return scriptError(decided.error, { operationId: record.operationId });
    record.decisions.set(args.requestId, decided.decision);
    if (record.status === 'waiting_for_agent') record.status = 'running';
    emitRecord(record, 'agent_decision', { requestId: args.requestId, decision: decided.decision }, now);
    return snapshotOf(record, args);
  }

  function inspectRuntimes() {
    return {
      fake: { available: true },
      javascript: { available: true, executable: process.execPath },
      python: inspectPython(),
    };
  }

  function snapshotOf(record, args = {}, extra = {}) {
    maybeHeartbeat(record, now);
    return {
      ok: true,
      command: 'script',
      operationId: record.operationId,
      status: record.status,
      pauseReason: record.pauseReason,
      error: record.error,
      hash: record.hash,
      resultRef: record.resultRef ?? null,
      eventSequence: record.events.sequence,
      events: record.events.after(args.afterSequence, args.eventLimit ?? args.limit),
      rollingSummary: record.summary.snapshot(now()),
      history: record.ledger.ledger.query(
        record.operationId,
        args.afterSequence == null ? 0 : args.afterSequence,
        args.limit,
      ),
      ...(record.recording ? { recording: record.recording.info() } : {}),
      catalog: args.includeCatalog ? catalogPayload() : undefined,
      ...extra,
    };
  }

  function knownOperation(operationId) {
    if (!operationId) return false;
    if (registry.get(operationId)) return true;
    return scriptLedger.ledger.snapshot(operationId).lastFact != null;
  }

  async function cancelAll() {
    await Promise.all(registry.values().filter(record => !record.finished).map(record =>
      record.status === 'finishing' ? record.running : control({ operationId: record.operationId }, 'cancelled')));
  }

  return { handle, inspectRuntimes, registry, knownOperation, cancelAll };
}

function resolveWaitMs(value) {
  if (value == null || value === '') return { ok: true, waitMs: 30_000 };
  const waitMs = Number(value);
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60_000) {
    return scriptError('invalid_argument', { field: 'waitMs' });
  }
  return { ok: true, waitMs };
}

function hasWaitSignal(record, after) {
  return record.events.sequence > after || isTerminal(record.status);
}

function isTerminal(status) {
  return status === 'completed' || status === 'cancelled' || status === 'failed';
}

function statusFromFact(fact) {
  if (fact.kind === 'script_completed') return 'completed';
  if (fact.kind === 'script_cancelled') return 'cancelled';
  if (fact.kind === 'script_failed') return 'failed';
  if (fact.payloadSummary && fact.payloadSummary.status) return fact.payloadSummary.status;
  return fact.kind;
}

function rejectBadLimit(args) {
  if (args.limit == null) return null;
  if (!Number.isInteger(args.limit) || args.limit < 1) {
    return scriptError('unsupported_argument', { field: 'limit' });
  }
  return null;
}

function isLivePause(status) {
  return status === 'paused_manual'
    || status === 'paused_live'
    || status === 'pause_requested'
    || status === 'paused_ambiguous';
}

function persistRecord(record, kind, body) {
  if (!record.store) return Promise.resolve({ ok: true, persisted: false });
  const pending = record.persistTail.then(async () => {
    try {
      const result = await record.store.persist(kind, body);
      return result?.ok ? result : { ok: false, error: result?.error || 'persist_failed' };
    } catch (error) {
      return { ok: false, error: error?.code || error?.message || 'persist_failed' };
    }
  });
  record.persistTail = pending;
  return pending;
}

async function commitTerminal(record, status, error, now, result) {
  let revision = record.checkpointRevision + 1;
  let resultRef = null;
  if (status === 'completed' && record.store) {
    const prepared = prepareScriptResult(result?.result, record.spec.policy.maxOutputBytes);
    const saved = prepared.ok ? await persistRecord(record, 'result', {
      operationId: record.operationId, revision, target: record.spec.target,
      result: prepared.result, bytes: prepared.bytes, sha256: prepared.sha256,
      originalSha256: prepared.originalSha256, representation: prepared.representation,
    }) : prepared;
    if (saved.ok && saved.persisted === true) resultRef = resultReference(saved, prepared);
    else { status = 'failed'; error = prepared.ok ? 'result_not_persisted' : prepared.error; }
  }
  const checkpoint = {
    ...codeStartCheckpoint({ spec: record.spec, hash: record.hash }, record.operationId),
    revision,
    stepId: record.lastCheckpoint?.name || 'start',
    checkpoint: record.lastCheckpoint,
    checkpointActionSequence: record.checkpointActionSequence,
    actionSequence: record.actionSequence,
    status,
    error,
    resultRef,
    ...(record.recording ? { recording: record.recording.info() } : {}),
  };
  let persisted = await persistRecord(record, 'checkpoint', checkpoint);
  // The terminal write shares a bounded partition with its result. A successful
  // second write must not conceal eviction of the first one at a quota boundary.
  if (persisted.ok && status === 'completed' && record.store) {
    const verified = readScriptResult({ store: record.store, operationId: record.operationId });
    if (!verified.ok) {
      status = 'failed';
      error = 'result_not_persisted';
      resultRef = null;
      revision += 1;
      persisted = await persistRecord(record, 'checkpoint', {
        ...checkpoint, revision, status, error, resultRef, resultError: verified.error,
      });
    }
  }
  record.checkpointRevision = revision;
  record.finished = true;
  record.status = persisted.ok ? status : 'failed';
  record.error = persisted.ok ? error : 'terminal_not_persisted';
  record.resultRef = persisted.ok ? resultRef : null;
  const type = record.status === 'completed' ? 'script_completed'
    : record.status === 'cancelled' ? 'script_cancelled' : 'script_failed';
  emitRecord(record, type, {
    resultRef: record.resultRef,
    status: record.status,
    error: record.error,
    persisted: persisted.persisted === true,
  }, now);
  stopHeartbeat(record);
  return record.status === 'completed' ? { ok: true, resultRef: record.resultRef }
    : { ok: false, error: record.error || record.status };
}

function failedCall(command, error, actionId = null, ambiguous = false, dispatched = false) {
  return { ok: false, command, error, result: null, ambiguous, dispatched, execution: { actionId } };
}

function trackPending(record, pending) {
  record.pendingCalls.add(pending);
  const settled = () => record.pendingCalls.delete(pending);
  pending.then(settled, settled);
  return pending;
}

function trackHost(host, record, now) {
  function stopped() { return record.cancelling || record.finished || record.status === 'finishing'; }

  function call(command, args = {}, options = {}) {
    if (stopped()) return Promise.resolve(failedCall(command, 'runtime_stopped'));
    const pending = runExecution({ signal: record.controller.signal, deadlineMs: record.deadlineMs,
      timeoutMs: args.timeoutMs, mutation: isMutationCommand(command, args) }, () => callTracked(command, args, options))
      .catch(error => failedCall(command, error.code || error.message, null, error.ambiguous === true, error.dispatched === true));
    return trackPending(record, pending);
  }

  async function callTracked(command, args, options) {
    if (isLivePause(record.status)) return failedCall(command, 'paused');
    if (record.durableError || record.mutationUnknown) {
      return failedCall(command, record.durableError || 'ambiguous', null, record.mutationUnknown);
    }
    const gate = authorizeCommand(command, record.spec.permissions);
    if (!gate.ok) return rejectCall(gate.error);
    let boundTarget = null;
    if (command !== 'page-summary') {
      try {
        const binding = bindCommandTarget(command, args, record.spec.target, options.target);
        boundTarget = binding.target;
        args = binding.args;
      } catch (error) {
        return rejectCall(error.code || 'invalid_target', { field: error.field, message: error.message });
      }
    }
    const mutation = isMutationCommand(command, args);
    const actionSequence = mutation ? ++record.actionSequence : null;
    const actionId = mutation ? `${record.operationId}:action-${actionSequence}` : null;
    const startedAtMs = now();
    if (mutation) record.inFlightMutations += 1;
    emitRecord(record, 'call_started', { command, args, target: boundTarget, actionId }, now);
    try {
      if (mutation) {
        const prepared = await persistRecord(record, 'dispatch-marker', {
          operationId: record.operationId,
          revision: record.checkpointRevision,
          actionSequence,
          actionId,
          target: boundTarget,
          actionSpecHash: checksumOf({ command, args }),
          planStepId: actionId,
          state: 'prepared',
          startedAtMs,
        });
        if (!prepared.ok) {
          record.durableError = 'dispatch_marker_not_persisted';
          emitRecord(record, 'call_failed', { command, args, target: boundTarget, actionId, error: record.durableError }, now);
          return failedCall(command, record.durableError);
        }
      }
      let result;
      try {
        // The host uses this ID for its provider request and returned receipt.
        // Caller-supplied dispatch IDs never become authoritative.
        result = stopped() || isLivePause(record.status)
          ? failedCall(command, isLivePause(record.status) ? 'paused' : 'runtime_stopped')
          : await host.call(command, args, { ...options, dispatchActionId: actionId });
      } catch (error) {
        result = failedCall(command, error?.code || error?.message || String(error), actionId,
          error?.ambiguous ?? mutation, error?.dispatched ?? null);
      }
      if (mutation) {
        record.mutationUnknown ||= result.ambiguous === true;
        const receipt = {
          operationId: record.operationId,
          target: boundTarget,
          revision: record.checkpointRevision,
          actionSequence,
          actionId,
          startedAtMs,
          completedAtMs: now(),
          mechanicalStatus: result.ok === false ? 'failed' : 'ok',
          error: result.error || null,
          ambiguous: result.ambiguous === true,
          dispatched: result.dispatched ?? null,
          executionReceipt: result.executionReceipt ?? null,
          ...(result.executionReceipts === undefined ? {} : { executionReceipts: result.executionReceipts }),
          evidenceRefs: result.evidence?.refs || [],
        };
        const persisted = await persistRecord(record, 'action-receipt', receipt);
        record.actionsSinceCheckpoint.push({ kind: 'action-receipt', ...receipt });
        if (!persisted.ok) {
          record.durableError = 'action_receipt_not_persisted';
          record.mutationUnknown = true;
          return failedCall(command, record.durableError, actionId, true);
        }
        emitRecord(record, 'action_receipt', {
          actionId,
          target: boundTarget,
          payloadSummary: {
            mechanicalStatus: receipt.mechanicalStatus,
            error: receipt.error,
            ambiguous: receipt.ambiguous,
            dispatched: receipt.dispatched,
            args,
            resolved: result.resolved,
            matched: result.matched,
          },
          evidenceRefs: result.evidence?.refs,
          timings: result.timings,
        }, now);
      }
      if (record.recording) {
        const saved = await record.recording.record({ kind: 'script-call', revision: record.checkpointRevision,
          target: boundTarget,
          data: { command, args, options, startedAtMs, completedAtMs: now(), envelope: result } });
        if (!saved.ok) {
          record.durableError = saved.error;
          return failedCall(command, saved.error, actionId, result.ambiguous === true);
        }
      }
      emitRecord(record, result.ok === false ? 'call_failed' : 'call_completed', {
        command, args, target: boundTarget, actionId,
        callId: result.execution?.callId,
        error: result.error || null,
        evidenceRefs: result.evidence?.refs,
        observationId: result.evidence?.observationId,
        source: result.evidence?.source,
        window: result.evidence?.window,
        coverage: result.evidence?.coverage,
      }, now);
      return result;
    } finally {
      if (mutation) {
        record.inFlightMutations -= 1;
        if (record.status === 'pause_requested' && record.inFlightMutations === 0) {
          record.status = record.mutationUnknown ? 'paused_ambiguous' : 'paused_live';
          emitRecord(record, 'paused', { status: record.status }, now);
          pushControl(record);
        }
      }
    }
    async function rejectCall(error, detail = {}) {
      const result = { ...unavailableEnvelope({ command, error, executionId: record.operationId, callId: null }),
        dispatched: false, ambiguous: false, ...detail };
      emitRecord(record, 'call_failed', { command, args, target: null, actionId: null, callId: null, error,
        evidenceRefs: result.evidence.refs, window: result.evidence.window, coverage: result.evidence.coverage }, now);
      if (record.recording) {
        const saved = await record.recording.record({ kind: 'script-call', revision: record.checkpointRevision,
          target: null, data: { command, args, options, startedAtMs: now(), completedAtMs: now(), envelope: result } });
        if (!saved.ok) { record.durableError = saved.error; return failedCall(command, saved.error); }
      }
      return result;
    }
  }
  async function assertTracked(assertion) {
    const result = await host.assert(assertion);
    if (record.recording) {
      const saved = await record.recording.record({ kind: 'script-assertion', revision: record.checkpointRevision,
        target: record.spec.target, data: { assertion, result } });
      if (!saved.ok) {
        record.durableError = saved.error;
        return { ok: false, name: result.name, scope: result.scope, verdict: 'inconclusive', reason: saved.error };
      }
    }
    emitRecord(record, `assertion_${result.verdict}`, {
      name: result.name,
      verdict: result.verdict,
      scope: result.scope,
      reason: result.reason,
      predicateSummary: assertion.predicateSummary,
      condition: assertion.condition,
      requiredEvidence: assertion.requiredEvidence,
      requireCoverage: assertion.requireCoverage,
      refs: assertion.evidence && assertion.evidence.refs,
      coverage: assertion.evidence && assertion.evidence.coverage,
      observationId: assertion.evidence?.observationId,
      window: assertion.evidence?.window,
      source: assertion.evidence?.source,
    }, now);
    return result;
  }

  return {
    call,
    assert(assertion) {
      if (stopped()) return Promise.resolve({ ok: false, verdict: 'inconclusive', reason: 'runtime_stopped' });
      return trackPending(record, assertTracked(assertion));
    },
  };
}

function trackAgent(agent, record, now) {
  return {
    askAgent: (request) => {
      record.decisionRevision += 1;
      const requestId = `ask-${record.decisionRevision}`;
      record.questionRevisions.set(requestId, record.decisionRevision);
      record.currentRequestId = requestId;
      record.status = 'waiting_for_agent';
      emitRecord(record, 'agent_question_created', {
        request,
        revision: record.decisionRevision,
        requestId,
      }, now);
      return agent.askAgent({ ...request, requestId });
    },
    decide: (requestId, decision) => agent.decide(requestId, decision),
  };
}

function pushControl(record) {
  if (typeof record.runtime.setControl !== 'function') return;
  record.runtime.setControl({
    status: record.status,
    pauseReason: record.pauseReason,
    checkpoint: record.lastCheckpoint,
  });
}

function emitRecord(record, type, extra, now) {
  const event = record.events.emit(type, extra, now);
  projectEvent(record, type, extra, event.atMs);
  if (type !== 'heartbeat') {
    record.lastMaterialAtMs = event.atMs;
    record.ledger.append(record, type, { ...extra, sequence: event.sequence }, event.atMs);
  }
  return event;
}

async function emitRuntimeRecord(record, type, extra, now) {
  if (record.cancelling || record.finished || record.status === 'finishing') return { ok: false, error: 'runtime_stopped', persisted: false };
  if (type === 'script_completed' || type === 'script_failed') {
    return null;
  }
  if (type !== 'checkpoint') return emitRecord(record, type, extra, now);
  if (record.mutationUnknown || record.inFlightMutations > 0) return { ok: false, error: 'ambiguous', persisted: false };
  const checkpoint = { name: extra.name, state: extra.state };
  const revision = record.checkpointRevision + 1;
  let persisted = null;
  if (record.store && typeof record.store.persist === 'function') {
    persisted = await persistRecord(record,
      'checkpoint',
      codeRuntimeCheckpoint(record, checkpoint, revision),
    );
    if (!persisted.ok) {
      return {
        ok: false,
        persisted: false,
        error: persisted.error || 'checkpoint_not_persisted',
      };
    }
  }
  record.checkpointRevision = revision;
  record.lastCheckpoint = checkpoint;
  record.checkpointActionSequence = record.actionSequence;
  record.actionsSinceCheckpoint = [];
  if (record.finished || record.status === 'finishing' || record.cancelling) return { ok: false, error: 'runtime_stopped', persisted: Boolean(persisted) };
  emitRecord(record, type, extra, now);
  return {
    ok: true,
    committed: true,
    persisted: Boolean(persisted),
    evidenceId: persisted && persisted.evidenceId,
  };
}

function projectEvent(record, type, extra, timestampMs) {
  record.projector.accept({
    executionId: record.operationId,
    revision: extra.revision,
    kind: type,
    target: scriptEventTarget(record, type, extra),
    timestampMs,
    actionId: extra.actionId,
    parentFactId: extra.parentFactId,
    payloadSummary: extra.payloadSummary,
    evidenceRefs: extra.evidenceRefs,
    timings: extra.timings,
  });
  if (type === 'progress') {
    record.summary.apply({
      kind: 'progress',
      timestampMs,
      stage: extra.stage,
      message: extra.message,
    });
    return;
  }
  if (type === 'checkpoint') {
    record.summary.apply({ kind: 'checkpoint_committed', timestampMs, name: extra.name });
    return;
  }
  if (type === 'heartbeat') {
    return;
  }
  record.summary.apply({
    kind: type,
    timestampMs,
    command: extra.command,
    evidenceRefs: extra.evidenceRefs,
    name: extra.name,
    scope: extra.scope,
    request: extra.request,
  });
}

function startHeartbeat(record, now) {
  stopHeartbeat(record);
  armHeartbeat(record, now);
}

function stopHeartbeat(record) {
  if (!record.heartbeatTimer) return;
  clearTimeout(record.heartbeatTimer);
  clearInterval(record.heartbeatTimer);
  record.heartbeatTimer = null;
}

function armHeartbeat(record, now) {
  const idleMs = now() - record.lastMaterialAtMs;
  const delayMs = idleMs >= 2000 ? 2000 : Math.max(0, 2000 - idleMs);
  record.heartbeatTimer = setTimeout(() => {
    maybeHeartbeat(record, now);
    if (isTerminal(record.status) || !record.heartbeatTimer) return;
    armHeartbeat(record, now);
  }, delayMs);
  if (typeof record.heartbeatTimer.unref === 'function') record.heartbeatTimer.unref();
}

function maybeHeartbeat(record, now) {
  if (isTerminal(record.status)) {
    stopHeartbeat(record);
    return;
  }
  const atMs = now();
  if (atMs - record.lastMaterialAtMs < 2000) return;
  emitRecord(record, 'heartbeat', record.summary.heartbeat(atMs, record.finished ? record.status : 'alive'), now);
}

module.exports = { createScriptSupervisor, createDefaultRuntime, isCodeScript };
