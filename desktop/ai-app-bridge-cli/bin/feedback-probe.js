'use strict';

async function runWithFeedbackProbe(options = {}) {
  const { command, args = {}, runner } = options;
  if (!isFullFeedback(args.feedback) || !isMutationCommand(command)
      || command === 'launch-app' || command === 'launch-activity') return runFeedback(options);
  const observationCommand = String(command).startsWith('ios-') ? 'ios-ui-observation'
    : String(command).startsWith('web-') ? 'web-ui-observation' : 'ui-observation';
  const targetArgs = pick(args, ['serial', 'adb', 'packageName', 'port', 'deviceId', 'bundleId', 'runtimeUrl', 'iosHost', 'iosPort', 'sessionId', 'runtimeEpoch', 'targetId']);
  if (observationCommand !== 'web-ui-observation') targetArgs.provider = String(command).includes('flutter') ? 'flutter' : 'native';
  const started = await runner(observationCommand, { ...targetArgs, operation: 'start', durationMs: 5000 });
  if (started?.ok !== true || started.active !== true || typeof started.leaseId !== 'string') {
    return { result: { ok: false, error: 'ui_observation_unavailable', dispatched: false, ambiguous: false, details: started ?? null },
      observation: { mode: 'full', inconclusive: true }, evidence: [] };
  }
  let output;
  try {
    output = await runFeedback(options);
    return output;
  } finally {
    let cleanup;
    try { cleanup = await runner(observationCommand, { ...targetArgs, operation: 'stop', leaseId: started.leaseId }); }
    catch (error) { cleanup = { ok: false, error: error.code || 'ui_observation_cleanup_failed' }; }
    if (output?.observation) output.observation.window = { leaseId: started.leaseId, maxDurationMs: 5000, cleanup };
  }
}

async function runFeedback({
  command,
  args = {},
  runner,
  sleep = delay,
  maxWaitMs = 400,
  intervalMs = 100,
} = {}) {
  if (typeof runner !== 'function') throw new TypeError('runner is required');
  if (!isFullFeedback(args.feedback) || !isMutationCommand(command)) {
    return { result: await runner(command, args), observation: null, evidence: [] };
  }
  if (command === 'launch-app' || command === 'launch-activity') {
    return captureLaunchFeedback(command, args, runner);
  }

  const eventCommand = eventCommandFor(command);
  const before = await safeRun(runner, eventCommand, { ...args, limit: 1 });
  let sinceId = latestId(before?.items);
  const result = await runner(command, args);
  const evidence = [];
  const uiEvents = [];
  const semanticEvents = [];
  const renderEvents = [];
  const interactionEvents = [];
  const attempts = Math.max(1, Math.ceil(maxWaitMs / Math.max(1, intervalMs)));
  let pollCount = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(intervalMs);
    pollCount += 1;
    const captured = await safeRun(runner, eventCommand, {
      ...args,
      sinceId,
      limit: 100,
    });
    if (!captured) continue;
    evidence.push({ command: eventCommand, result: captured });
    const items = Array.isArray(captured.items) ? captured.items : [];
    sinceId = Math.max(sinceId, latestId(items));
    for (const item of items.filter(isUiEvent)) {
      const kind = uiEventKind(item);
      if (kind === 'stable') continue;
      uiEvents.push(item);
      if (kind === 'semantic') semanticEvents.push(item);
      if (kind === 'render' || item?.data?.renderChanged === true) renderEvents.push(item);
      if (kind === 'interaction' || uiEventHasInteraction(item)) interactionEvents.push(item);
    }
    if (semanticEvents.length > 0) break;
  }

  if (semanticEvents.length > 0) {
    return {
      result,
      evidence,
      observation: {
        mode: 'full',
        changed: true,
        semanticChanged: true,
        renderChanged: renderEvents.length > 0,
        interactionObserved: interactionEvents.length > 0,
        inconclusive: false,
        waitedMs: Math.min(maxWaitMs, pollCount * intervalMs),
        events: uiEvents.slice(0, 20).map(summarizeUiEvent),
      },
    };
  }

  const fallback = {};
  const treeCommand = treeCommandFor(command);
  const tree = await safeRun(runner, treeCommand, args);
  if (tree) {
    evidence.push({ command: treeCommand, result: tree });
    fallback.tree = summarizeTree(tree);
  }
  if (args.feedbackScreenshot !== false && !String(command).startsWith('web-')) {
    const screenshotCommand = screenshotCommandFor(command);
    const screenshot = await safeRun(runner, screenshotCommand, args);
    if (screenshot) {
      evidence.push({ command: screenshotCommand, result: screenshot });
      fallback.screenshot = summarizeScreenshot(screenshot);
    }
  }
  return {
    result,
    evidence,
    observation: {
      mode: 'full',
      changed: renderEvents.length > 0,
      semanticChanged: false,
      renderChanged: renderEvents.length > 0,
      interactionObserved: interactionEvents.length > 0,
      inconclusive: true,
      waitedMs: Math.min(maxWaitMs, pollCount * intervalMs),
      events: uiEvents.slice(0, 20).map(summarizeUiEvent),
      fallback,
    },
  };
}

async function captureLaunchFeedback(command, args, runner) {
  // Launch must work without a running App SDK. Observe the system only after
  // the original launch has settled, without claiming a before/after UI change.
  const result = await runner(command, args);
  if (result?.ok !== true) return { result, observation: null, evidence: [] };
  const evidence = [];
  const current = { foreground: result.foreground ?? null };
  const targetArgs = pick(args, ['serial', 'adb', 'adbPath', 'packageName']);
  const reads = [['uia-tree', { ...targetArgs, compact: true }, 'tree', summarizeTree]];
  if (args.feedbackScreenshot !== false) reads.push(['screenshot', targetArgs, 'screenshot', summarizeScreenshot]);
  for (const [readCommand, readArgs, key, summarize] of reads) {
    let captured;
    try { captured = await runner(readCommand, readArgs); }
    catch (error) { captured = { ok: false, error: error.code || 'feedback_capture_failed', message: String(error.message || error) }; }
    evidence.push({ command: readCommand, result: captured });
    current[key] = summarize(captured);
  }
  return { result, evidence, observation: {
    mode: 'full', basis: 'post-launch-system-snapshot', changed: false,
    semanticChanged: false, renderChanged: false, interactionObserved: false,
    inconclusive: true, events: [], current,
  } };
}

function isFullFeedback(value) {
  return String(value || '').toLowerCase() === 'full';
}

function isMutationCommand(command) {
  const normalized = String(command || '').toLowerCase();
  const readOnly = new Set([
    'ui-observation', 'ios-ui-observation', 'web-ui-observation',
    'status', 'tree', 'uia-tree', 'screenshot', 'logs', 'network', 'state', 'events',
    'logcat', 'keyboard-state', 'wait-text', 'flutter-tree', 'flutter-nodes', 'h5-dom',
    'flutter-h5-dom', 'webview-pages', 'webview-network', 'webview-console',
    'ios-status', 'ios-tree', 'ios-logs', 'ios-network', 'ios-state', 'ios-events',
    'ios-h5-dom', 'ios-flutter-tree', 'ios-flutter-nodes', 'ios-screenshot',
    'ios-uia-tree', 'ios-wda-status', 'ios-devices', 'ios-doctor',
    'web-provider-status', 'web-connect-info', 'web-sessions', 'web-status', 'web-dom',
    'web-logs', 'web-network', 'web-state', 'web-events', 'web-wait',
  ]);
  return !readOnly.has(normalized);
}

function eventCommandFor(command) {
  const normalized = String(command || '');
  if (normalized.startsWith('ios-')) return 'ios-events';
  if (normalized.startsWith('web-')) return 'web-events';
  return 'events';
}

function treeCommandFor(command) {
  const normalized = String(command || '');
  if (normalized.startsWith('ios-')) return 'ios-tree';
  if (normalized.startsWith('web-')) return 'web-dom';
  return 'tree';
}

function screenshotCommandFor(command) {
  return String(command || '').startsWith('ios-') ? 'ios-screenshot' : 'screenshot';
}

async function safeRun(runner, command, args) {
  try {
    return await runner(command, args);
  } catch (_) {
    return null;
  }
}

function latestId(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((latest, item) => {
    const id = Number(item?.id);
    return Number.isFinite(id) ? Math.max(latest, id) : latest;
  }, 0);
}

function isUiEvent(item) {
  const category = String(item?.category || '').toLowerCase();
  const name = String(item?.name || '').toLowerCase();
  return category === 'ui' || category.startsWith('ui.') || name.startsWith('ui.');
}

function uiEventKind(item) {
  const name = String(item?.name || '').toLowerCase();
  const data = item?.data && typeof item.data === 'object' ? item.data : {};
  if (name === 'ui.stable' || name.endsWith('.stable')) return 'stable';
  if (data.semanticChanged === true) return 'semantic';
  if (data.semanticChanged === false && data.renderChanged === true) return 'render';
  if (data.renderOnly === true) return 'render';
  if (name.includes('animation') || name.includes('frame') || name.includes('render')) return 'render';
  if (
    name === 'ui.changed'
    && String(data.platform || '').toLowerCase() === 'flutter'
    && (Number(data.frameCount) > 0 || Number(data.batchFrames) > 0)
  ) {
    return 'render';
  }
  if (
    name === 'ui.changed'
    && data.activeAnimations === true
    && Number(data.changedComponentCount || 0) === 0
  ) {
    return 'render';
  }
  if (name === 'batch' || name === 'ui.batch') return uiBatchKind(data.events);
  if (name.includes('interaction') || name.endsWith('.click') || name.endsWith('.tap')) {
    return 'interaction';
  }
  return 'semantic';
}

function uiBatchKind(events) {
  if (!Array.isArray(events) || events.length === 0) return 'semantic';
  let interactionOnly = true;
  for (const event of events) {
    const type = String(event?.type || '').toLowerCase();
    if (!type.startsWith('interaction.')) interactionOnly = false;
  }
  return interactionOnly ? 'interaction' : 'semantic';
}

function uiEventHasInteraction(item) {
  const name = String(item?.name || '').toLowerCase();
  if (name.includes('interaction') || name.endsWith('.click') || name.endsWith('.tap')) return true;
  const events = item?.data?.events;
  return Array.isArray(events) && events.some((event) => (
    String(event?.type || '').toLowerCase().startsWith('interaction.')
  ));
}

function summarizeUiEvent(item) {
  return {
    id: item?.id,
    name: item?.name,
    category: item?.category,
    timestampMs: item?.timestampMs,
    data: boundedObject(item?.data),
  };
}

function summarizeTree(tree) {
  return pick(tree, [
    'ok', 'error', 'activity', 'nodeCount', 'windowCount', 'targetId', 'sessionId',
    'updatedAtMs',
  ]);
}

function summarizeScreenshot(screenshot) {
  return pick(screenshot, [
    'ok', 'error', 'path', 'outFile', 'format', 'width', 'height', 'deviceId',
    'updatedAtMs',
  ]);
}

function pick(value, keys) {
  if (!value || typeof value !== 'object') return { value: String(value) };
  const result = {};
  for (const key of keys) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  return result;
}

function boundedObject(value) {
  if (!value || typeof value !== 'object') return value ?? null;
  const result = {};
  for (const [key, child] of Object.entries(value).slice(0, 20)) {
    if (typeof child === 'string') result[key] = child.slice(0, 300);
    else if (child === null || typeof child !== 'object') result[key] = child;
  }
  return result;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  eventCommandFor,
  isMutationCommand,
  runWithFeedbackProbe,
  uiEventKind,
};
