'use strict';

const { executeProviderCommand } = require('./device-provider');
const { validateRunRequest, publicOutputLimit } = require('./command-request');
const { resolveCommandPaths } = require('./shared-kernel/request-context');
const { commandFailure, normalizeCommandResult } = require('./command-errors');
const { withActionGuidance } = require('./shared-kernel/action-guidance');
const { publicReply, publicFailure, responseReply, finishReply, boundedReply } = require('./public-reply');
const { prepareExtraction } = require('./extraction/prepare');
const { runExecution, withoutExecution, currentExecution } = require('./shared-kernel/execution-scope');
const { getHostFactStore } = require('./shared-kernel/host-fact-store');
const { FactRecorder, historyDescriptor, isMobileCaptureCommand } = require('./fact-recorder');
const { runWithFeedbackProbe } = require('./feedback-probe');
const { IOSBridgeProvider } = require('./ios-provider');
const { ObservationCollector } = require('./observation-collector');
const { WebBridgeProvider } = require('./web-provider');
const { TargetExecution } = require('./target-execution');
const { createCommandRouter, isolatedCommandDefinitions } = require('./command-router');
const {
  createLegacyFactStoreAdapter,
  createSegmentedEvidenceAdapter,
} = require('./shared-kernel/evidence-adapters');
const iosProvider = new IOSBridgeProvider();
const webProvider = new WebBridgeProvider();
const targetExecution = new TargetExecution();
let browserExecutor = null;
let androidExecutor = null;
let flutterExecutor = null;

let sharedFactStore = null;
let sharedFactRecorder = null;
let sharedObservationCollector = null;
let factStoreCloseInstalled = false;
let internalActionSequence = 0;

let shutdownPromise = null;
let closing = false;
const activeRuns = new Set();

// Callers share one execution host. The owning process controls its lifecycle.
// Every reply is the public reply of the request, assembled exactly once here.
function run(args, dependencies) {
  if (closing) return Promise.resolve({ value: boundedReply(publicReply({ command: requestedCommand(args), reply: valueReply({ ok: false, error: 'runtime_stopping', dispatched: false, ambiguous: false }) })) });
  const task = runGeneric(args, dependencies);
  activeRuns.add(task);
  task.then(() => activeRuns.delete(task), () => activeRuns.delete(task));
  return task;
}

function close() {
  if (shutdownPromise) return shutdownPromise;
  closing = true;
  shutdownPromise = (async () => {
    await require('./script/script-entry').cancelActiveScripts();
    await require('./intent/intent-entry').cancelActiveIntents();
    await webProvider.close();
    await browserExecutor?.close();
    await androidExecutor?.close();
    await flutterExecutor?.close();
    await Promise.allSettled([...activeRuns]);
    try { await sharedObservationCollector?.stop(); }
    finally {
      sharedObservationCollector = null;
      try { await sharedFactStore?.drain?.(); }
      finally {
        sharedFactStore?.close();
        sharedFactStore = null;
        sharedFactRecorder = null;
      }
    }
  })();
  return shutdownPromise;
}

const { commandDefinitions, commandByName, isolatedByName, commandSchema, commandContract, validateCommandArguments, isMutationCommand, executionTimeoutMs } = require('./command-registry');

const commandRouter = createCommandRouter({
  loadScript: () => wrapIsolatedEntry(require('./script/script-entry'), 'script'),
  loadIntent: () => wrapIsolatedEntry(require('./intent/intent-entry'), 'intent'),
  loadEvidence: () => ({
    handle: (args) => require('./shared-kernel/evidence-archive').handle(args, {
      getFactStore: getSharedFactStore,
    }),
  }),
  dispatchCommon: runCommand,
});

// One in-process command path for Script and Intent. Compound workflows keep
// their own lifetime/locks; ordinary commands retain target admission. Neither
// path serializes through MCP nor adds another feedback observation/history.
async function dispatchProviderCommand(command, args, options = {}) {
  try {
    const validated = resolveCommandPaths(command, validateCommandArguments(command, args));
    if (command === 'response') return responseReply(getResponseStore().read(validated.ref));
    if (command === 'runtime') {
      if (validated.operation === 'stop' || validated.operation === 'force-stop') {
        return require('./shared-kernel/composed-control').start(command, validated);
      }
      return await require('./runtime-client').runtimeCommand(validated, { signal: currentExecution()?.signal });
    }
    if (command === 'device-ownership' && validated.operation === 'force-stop') {
      return require('./shared-kernel/composed-control').start(command, validated);
    }
    if (isolatedByName.has(command) || ['install-apk', 'permission-dialog'].includes(command)) {
      if (command === 'intent' && validated.operation === 'start' && options.caller && validated.background === undefined) validated.background = true;
      const invoke = () => commandRouter.route(command, validated).then(reply => reply.value);
      if (options.caller?.command === command && options.caller.operationId === validated.operationId) {
        if (validated.operation === 'cancel' || validated.operation === 'intervene') {
          // Request cancellation now; the owner drains this call after it
          // returns. Awaiting the owner's drain here would wait on ourselves.
          withoutExecution(() => invoke().catch(error => process.stderr.write(`${error.message}\n`)));
          return { ok: true, command, operationId: validated.operationId, status: 'cancelling',
            controlAccepted: true, completionScope: 'control-request', settled: true };
        }
        if (validated.operation === 'wait') {
          const { waitMs, ...statusArgs } = validated;
          return commandRouter.route(command, { ...statusArgs, operation: 'status' })
            .then(reply => ({ ...reply.value, message: 'A task cannot wait for its own completion from inside ctx.call; current status is returned.' }));
        }
      }
      // A returned child operationId has an independent lifetime. Future
      // calls use its own deadline, rather than the already-settled start call.
      return validated.operation === 'start' || ['install-apk', 'permission-dialog'].includes(command)
        ? withoutExecution(() => require('./shared-kernel/device-mutation-lease').withoutDeviceMutationLease(invoke)) : invoke();
    }
    return withActionGuidance(command, validated, normalizeCommandResult(await targetExecution.execute(command, validated, (name, parameters) =>
      runRawCommand(name, isMutationCommand(name, parameters)
        ? { ...parameters, runtimeActionId: actionIdForInvocation(parameters) } : parameters)), command));
  } catch (error) { return withActionGuidance(command, args, commandFailure(error, command)); }
}

function resolveScriptWaitMs(value) {
  if (value == null || value === '') return { ok: true, waitMs: 30_000 };
  const waitMs = Number(value);
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60_000) {
    return { ok: false };
  }
  return { ok: true, waitMs };
}

function wrapIsolatedEntry(entry, namespace) {
  return {
    handle(args) {
      if (namespace === 'script' && args.operation === 'runtime-status') return entry.handle(args);
      if (namespace === 'script' && (args.operation === 'wait' || ['start', 'resume', 'decide'].includes(args.operation) && args.waitMs > 0)) {
        if (Object.prototype.hasOwnProperty.call(args, 'isolatedTimeoutMs')) {
          return require('./script/script-errors').scriptError('unsupported_argument', {
            field: 'isolatedTimeoutMs',
          });
        }
        const resolved = resolveScriptWaitMs(args.waitMs);
        if (!resolved.ok) {
          return require('./script/script-errors').scriptError('invalid_argument', {
            field: 'waitMs',
          });
        }
        args.waitMs = resolved.waitMs;
      }
      if (!args.adapter) args.adapter = 'production';
      if (namespace === 'intent' && args.target?.platform === 'web') args.ports = { ...args.ports, web: webProvider };
      if (!args.store) {
        const storeFactory = namespace === 'script'
          ? require('./script/script-evidence-store').createScriptEvidenceStore
          : require('./intent/intent-evidence-store').createIntentEvidenceStore;
        args.store = storeFactory({
          adapter: createSegmentedEvidenceAdapter(getSharedFactStore()),
        });
      }
      if (namespace === 'script' && !args.host && typeof args.actions !== 'function') {
        args.actions = dispatchProviderCommand;
        if (typeof args.runner !== 'function') {
          args.runner = args.actions;
        }
      }
      if (namespace === 'intent' && !args.capturePort) {
        const { createLiveCaptureQuery } = require('./shared-kernel/live-capture-query');
        const { createIntentCapturePort } = require('./intent/intent-capture-port');
        args.capturePort = createIntentCapturePort({
          query: createLiveCaptureQuery({ runner: dispatchProviderCommand }),
        });
      }
      if (namespace === 'intent' && !args.commands) args.commands = dispatchProviderCommand;
      return entry.handle(args);
    },
  };
}

function requestedCommand(args) {
  return typeof args?.command === 'string' ? args.command : undefined;
}

async function runGeneric(args = {}, dependencies = {}) {
  const command = requestedCommand(args);
  const maxBytes = publicOutputLimit(args);
  let request;
  let commandArguments;
  let extract;
  try {
    request = validateRunRequest(args);
    commandArguments = resolveCommandPaths(request.command, request.arguments);
    extract = prepareExtraction(request.extract);
  } catch (error) { return { value: publicFailure({ command, stage: 'validation', error, maxBytes }) }; }
  try {
    const getStore = () => dependencies.responseStore || getResponseStore();
    if (command === 'response') {
      const frozen = getStore().read(commandArguments.ref);
      return { value: await finishReply({ body: responseReply(frozen), extract, output: request.output, frozen, getStore }) };
    }
    const reply = await commandRouter.route(request.command, commandArguments, dependencies);
    reply.value = withActionGuidance(command, commandArguments, reply.value);
    return { value: await finishReply({ body: publicReply({ command: request.command, reply, completed: true, args: commandArguments }), extract, output: request.output, getStore }) };
  } catch (error) { return { value: publicFailure({ command: request.command, stage: 'execution', error, args: commandArguments, maxBytes: request.output?.maxBytes }) }; }
}

async function runCommand(command, args = {}, dependencies = {}) {
  try { args = validateCommandArguments(command, args); }
  catch (error) { return valueReply(commandFailure(error, command)); }
  try {
    return await runExecution({ timeoutMs: executionTimeoutMs(command, args), mutation: isMutationCommand(command, args) },
      () => runBridgeWithinExecution(command, args, dependencies));
  } catch (error) { return valueReply(commandFailure(error, command)); }
}

async function runBridgeWithinExecution(command, args, dependencies) {
  const execution = dependencies.targetExecution || targetExecution;
  const rawRunner = dependencies.rawRunner || runRawCommand;
  let factRecorder = null;
  let factCacheInitializationError = null;
  try {
    if (Object.prototype.hasOwnProperty.call(dependencies, 'factRecorder')) {
      factRecorder = dependencies.factRecorder;
    } else if (typeof dependencies.factRecorderFactory === 'function') {
      factRecorder = dependencies.factRecorderFactory();
    } else if (!dependencies.rawRunner) {
      factRecorder = getSharedFactRecorder();
    }
  } catch (error) {
    factCacheInitializationError = {
      degraded: true,
      persistence: false,
      error: error.code || error.name || 'fact_cache_initialization_failed',
      message: error.message || String(error),
    };
  }
  const historyRead = wantsFactHistory(args);
  let observerSetupError = null;
  let observationCollector = null;
  if (!historyRead) {
    try {
      observationCollector = Object.prototype.hasOwnProperty.call(dependencies, 'observationCollector')
        ? dependencies.observationCollector
        : (dependencies.rawRunner ? null : getSharedObservationCollector(factRecorder));
    } catch (error) {
      observerSetupError = error.message || String(error);
    }
  }
  const observation = observerSetupError
    ? { collector: null, registration: null, error: observerSetupError }
    : safeRegisterObservation(observationCollector, command, args);
  const actionId = historyRead ? null : actionIdForInvocation(args);
  const tracksMutation = !historyRead && isMutationCommand(command, args);
  const requestedAtMs = Date.now();
  if (tracksMutation) {
    noteObservationAction(observation, actionId, { requestedAtMs });
  }
  let feedbackProbe = null;
  try {
    const result = copyFeedback(await execution.execute(command, args, async (normalizedCommand, normalizedArgs) => {
      if (tracksMutation) {
        noteObservationAction(observation, actionId, { startedAtMs: Date.now() });
      }
      if (historyRead && !isMobileCaptureCommand(normalizedCommand) && !normalizedCommand.startsWith('web-')) {
        if (factRecorder) {
          return factRecorder.readHistory(normalizedCommand, normalizedArgs);
        }
        return {
          ok: false,
          error: factCacheInitializationError ? 'fact_cache_unavailable' : 'fact_cache_disabled',
          command: normalizedCommand,
          ...(factCacheInitializationError ? { factCache: factCacheInitializationError } : {}),
        };
      }
      const runtimeArgs = tracksMutation
        ? { ...normalizedArgs, runtimeActionId: actionId }
        : normalizedArgs;
      feedbackProbe = await runWithFeedbackProbe({
        command: normalizedCommand,
        args: runtimeArgs,
        runner: rawRunner,
      });
      return normalizeCommandResult(feedbackProbe.result, command);
    }));
    if (result && typeof result === 'object' && result._feedback) {
      result._feedback.outcome = executionOutcome(result);
      if (feedbackProbe?.observation) {
        result._feedback.ui = feedbackProbe.observation;
        if (
          feedbackProbe.observation.semanticChanged === true
          && result._feedback.status !== 'failed'
        ) {
          result._feedback.status = 'verified';
        } else if (
          feedbackProbe.observation.inconclusive === true
          && result._feedback.status !== 'verified'
          && result._feedback.status !== 'failed'
        ) {
          result._feedback.status = 'inconclusive';
        }
      }
    }
    const timings = completedActionTimings(result?._feedback?.timings, requestedAtMs);
    if (tracksMutation) noteObservationAction(observation, actionId, timings);
    let history = historyUnavailable(actionId, factCacheInitializationError);
    if (factRecorder) {
      const recorded = {
        factRecorder,
        command,
        args,
        result,
        historyRead,
        probeEvidence: feedbackProbe?.evidence || [],
        actionId,
        actionTimeline: actionTimelineFor(actionId, timings),
      };
      try {
        history = attachRecordedFacts(recorded);
      } catch (error) {
        history = historyUnavailable(actionId, { error: error.code || 'history_recording_failed' });
      }
    }
    if (result && typeof result === 'object' && result._feedback) {
      if (factCacheInitializationError) result._feedback.factCache = factCacheInitializationError;
      const observerStatus = compactObservationStatus(observation);
      if (observerStatus) result._feedback.observer = observerStatus;
    }
    return resultReply(result, history);
  } catch (error) {
    const failure = copyFeedback(commandFailure(error, command));
    const timings = completedActionTimings(failure._feedback?.timings, requestedAtMs);
    if (tracksMutation) noteObservationAction(observation, actionId, timings);
    let history = historyUnavailable(actionId, factCacheInitializationError);
    if (factRecorder) {
      try {
        const actionReference = safeRecordExecution(factRecorder, {
          command,
          args,
          error,
          feedback: failure._feedback,
          actionId,
        });
        history = historySummary(actionId, actionReference, []);
        if (actionReference && failure._feedback) {
          failure._feedback.evidence.push(actionReference);
          failure._feedback.factCache = compactFactCacheStatus(factRecorder);
        }
      } catch (recordingError) {
        history = historyUnavailable(actionId, { error: recordingError.code || 'history_recording_failed' });
      }
    }
    if (failure._feedback) {
      if (factCacheInitializationError) failure._feedback.factCache = factCacheInitializationError;
      const observerStatus = compactObservationStatus(observation);
      if (observerStatus) failure._feedback.observer = observerStatus;
    }
    return resultReply(failure, history);
  }
}

// Each delivery reports its own history attempt. Do not mutate the original
// result/error retained by the request-id cache on every repeated read.
function copyFeedback(result) {
  if (!result?._feedback) return result;
  return { ...result, _feedback: { ...result._feedback, evidence: [...result._feedback.evidence] } };
}

function actionIdForInvocation(args = {}) {
  if (args.requestId !== undefined && args.requestId !== null) return String(args.requestId);
  internalActionSequence += 1;
  return `host-action-${process.pid}-${Date.now()}-${internalActionSequence}`;
}


function completedActionTimings(timings, requestedAtMs) {
  if (timings && typeof timings === 'object') return { ...timings };
  const completedAtMs = Date.now();
  return {
    requestedAtMs,
    startedAtMs: requestedAtMs,
    completedAtMs,
    queueWaitMs: 0,
    durationMs: Math.max(0, completedAtMs - requestedAtMs),
  };
}

function actionTimelineFor(actionId, timings) {
  if (actionId === undefined || actionId === null || !timings) return [];
  return [{
    actionId: String(actionId),
    requestedAtMs: timings.requestedAtMs ?? null,
    startedAtMs: timings.startedAtMs ?? null,
    completedAtMs: timings.completedAtMs ?? null,
  }];
}

function wantsFactHistory(args = {}) {
  return args.history === true
    || args.history === 'true'
    || args.source === 'cache'
    || args.factCursor !== undefined
    || args.cursor !== undefined;
}

function attachRecordedFacts({
  factRecorder,
  command,
  args,
  result,
  historyRead,
  probeEvidence = [],
  actionId,
  actionTimeline = [],
}) {
  const feedback = result && typeof result === 'object' && !Buffer.isBuffer(result)
    ? result._feedback
    : null;
  const evidence = historyRead
    ? []
    : safeRecordEvidence(factRecorder, command, args, result, { actionId, actionTimeline });
  for (const captured of probeEvidence) {
    evidence.push(...safeRecordEvidence(
      factRecorder,
      captured.command,
      args,
      captured.result,
      { actionId, actionTimeline },
    ));
  }
  const actionReference = safeRecordExecution(factRecorder, {
    command,
    args,
    result,
    feedback,
    actionId,
  });
  if (feedback) {
    feedback.evidence.push(...evidence, actionReference);
    feedback.factCache = compactFactCacheStatus(factRecorder);
  }
  return historySummary(actionId, actionReference, evidence);
}

function historySummary(actionId, action, evidence) {
  const errors = [action, ...evidence].filter(ref => ref.stored !== true)
    .map(ref => ({ partition: ref.partition, error: ref.error || 'history_write_failed' }));
  return { schemaVersion: 'aab.command-history/v1', status: errors.length ? 'partial' : 'stored',
    actionId, action, evidence, errors, replayed: false };
}

function historyUnavailable(actionId, failure) {
  return { schemaVersion: 'aab.command-history/v1', status: failure ? 'unavailable' : 'disabled',
    actionId, action: null, evidence: [], errors: failure ? [{ error: failure.error }] : [], replayed: false };
}

function safeRegisterObservation(collector, command, args) {
  if (!collector) return { collector: null, registration: null, error: null };
  try {
    const registration = withoutExecution(() => collector.register(command, args));
    if (!registration || registration.ignored) {
      return { collector, registration: null, error: null };
    }
    return { collector, registration, error: null };
  } catch (error) {
    return {
      collector,
      registration: null,
      error: error.message || String(error),
    };
  }
}

function noteObservationAction(observation, actionId, timings = {}) {
  if (!observation.collector || !observation.registration?.target || actionId === undefined || actionId === null) {
    return;
  }
  try {
    observation.collector.noteAction(observation.registration.target, actionId, timings);
  } catch (error) {
    observation.error ||= error.message || String(error);
  }
}

function compactObservationStatus(observation) {
  if (observation.error) {
    return { running: false, degraded: true, error: observation.error };
  }
  if (!observation.collector || !observation.registration?.target) return null;
  try {
    const status = observation.collector.status();
    const key = observation.registration.target.key;
    const target = Array.isArray(status.targets)
      ? status.targets.find((candidate) => candidate.key === key)
      : null;
    return {
      running: Boolean(status.running),
      targetCount: Number(status.targetCount || 0),
      maxTargets: Number(status.maxTargets || 0),
      inactiveTargetTtlMs: Number(status.inactiveTargetTtlMs || 0),
      targetEvictions: Number(status.targetEvictions || 0),
      targetExpirations: Number(status.targetExpirations || 0),
      ...(target ? {
        target: {
          key: target.key,
          runtimeEpoch: target.runtimeEpoch ?? null,
          failureCount: Number(target.failureCount || 0),
          lastError: target.lastError ?? null,
          backgroundPolling: target.backgroundPolling ?? null,
          expiresAtMs: target.expiresAtMs ?? null,
          lastSuccessAtMs: target.lastSuccessAtMs ?? null,
          ...(target.deviceLog ? { deviceLog: target.deviceLog } : {}),
        },
      } : {}),
      ...(status.dropped ? { dropped: status.dropped } : {}),
    };
  } catch (error) {
    return { running: false, degraded: true, error: error.message || String(error) };
  }
}

function executionOutcome(result) {
  if (!result || typeof result !== 'object' || Buffer.isBuffer(result)) {
    return { resultType: Buffer.isBuffer(result) ? 'buffer' : typeof result };
  }
  const outcome = {};
  for (const key of [
    'ok', 'error', 'action', 'source', 'transport', 'target', 'matched', 'activity',
    'component', 'windowType', 'x', 'y', 'handledDown', 'handledUp', 'verified',
    'inconclusive', 'dispatched', 'ambiguous', 'settled', 'executionReceipt', 'executionReceipts',
  ]) {
    if (result[key] !== undefined) outcome[key] = result[key];
  }
  return outcome;
}

function safeRecordEvidence(factRecorder, command, args, result, context) {
  try {
    return factRecorder.recordEvidence(command, args, result, context);
  } catch (error) {
    return [{ partition: 'index', stored: false, error: error.code || 'fact_evidence_write_failed' }];
  }
}

function safeRecordExecution(factRecorder, input) {
  try {
    const recorded = factRecorder.recordExecution(input);
    return {
      partition: 'action',
      globalSeq: recorded.globalSeq ?? null,
      stored: recorded.ok !== false && recorded.stored === true,
      actionId: recorded.actionId,
      ...(recorded.ok === false || recorded.stored !== true ? { error: recorded.error || 'fact_action_not_stored' } : {}),
    };
  } catch (error) {
    return { partition: 'action', stored: false, actionId: input.actionId, error: error.code || 'fact_action_write_failed' };
  }
}

function compactFactCacheStatus(factRecorder) {
  try {
    const status = factRecorder.status();
    const mmap = status.sqlite?.mmap || (status.adapter === 'segmented-mmap'
      ? {
          enabled: true,
          requestedBytes: status.budgetBytes,
          effectiveBytes: status.storage?.mmapBytes,
        }
      : undefined);
    return {
      adapter: status.adapter,
      persistence: status.persistence,
      degraded: status.degraded,
      profile: status.profile,
      profileSelection: status.profileSelection,
      budgetBytes: status.budgetBytes,
      totalBytes: status.storage?.totalBytes,
      overQuota: status.storage?.overQuota,
      mmap,
    };
  } catch (error) {
    return { degraded: true, persistence: false, error: error.message };
  }
}

function getSharedFactStore() {
  if (sharedFactStore) return sharedFactStore;
  sharedFactStore = getHostFactStore();
  return sharedFactStore;
}

function getResponseStore() {
  return require('./response-store').createResponseStore({ adapter: createSegmentedEvidenceAdapter(getSharedFactStore()) });
}

function getSharedFactRecorder() {
  if (String(process.env.AI_APP_BRIDGE_FACT_CACHE || '').toLowerCase() === 'off') return null;
  if (sharedFactRecorder) return sharedFactRecorder;
  getSharedFactStore();
  sharedFactRecorder = new FactRecorder({
    cache: createLegacyFactStoreAdapter(sharedFactStore),
  });
  if (!factStoreCloseInstalled) {
    factStoreCloseInstalled = true;
    process.once('exit', () => {
      try {
        const stopping = sharedObservationCollector?.stop();
        stopping?.catch?.(() => {});
      } catch (_) {
        // Process shutdown must not be blocked by observer cleanup.
      }
      try {
        sharedFactStore?.close();
      } catch (_) {
        // Process shutdown must not be blocked by FactStore cleanup.
      }
    });
  }
  return sharedFactRecorder;
}

function getSharedObservationCollector(factRecorder) {
  if (!factRecorder) return null;
  if (sharedObservationCollector) return sharedObservationCollector;
  sharedObservationCollector = new ObservationCollector({
    rawRunner: runRawCommand,
    recordEvidence: (command, args, result, context) => {
      safeRecordEvidence(factRecorder, command, args, result, context);
    },
    recordDeviceLog: (args, batch, context) => {
      try {
        factRecorder.recordDeviceLog(args, batch, context);
      } catch (_) {
        // Background persistence must never fail a foreground command.
      }
    },
  });
  withoutExecution(() => sharedObservationCollector.start());
  return sharedObservationCollector;
}

async function runRawCommand(command, args = {}) {
  if (command === 'executor-prepare') return require('./executors/preparation').prepareExecutor(args);
  if (command === 'android-executor') {
    androidExecutor ||= new (require('./executors/android-host').AndroidExecutorHost)();
    return androidExecutor.run(args);
  }
  if (command === 'flutter-executor') {
    flutterExecutor ||= new (require('./executors/flutter-host').FlutterExecutorHost)();
    return flutterExecutor.run(args);
  }
  if (command === 'web-executor') {
    browserExecutor ||= new (require('./executors/playwright-host').PlaywrightHost)();
    return browserExecutor.run(args);
  }
  const definition = commandByName.get(command);
  if (definition?.domain === 'ios') return iosProvider.run(command, args);
  if (definition?.domain === 'web') return webProvider.run(command, args);
  return executeProviderCommand(command, args);
}

// A protocol-neutral reply keeps payload and history distinct, including XML
// observations. Adapters decide how to represent them on their own wire.
function valueReply(value) { return { value }; }

function resultReply(result, history) {
  return { value: normalizeCommandResult(result), ...(history ? { history } : {}) };
}

function diagnosticState() {
  return { closing, activeRequests: activeRuns.size, web: webProvider.providerStatus(), sessions: webProvider.listSessions({ maintainConnections: false }) };
}

module.exports = { run, close, diagnosticState, dispatchProviderCommand, commandRouter, ...require('./command-discovery') };
