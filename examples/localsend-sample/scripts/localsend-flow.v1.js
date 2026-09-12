'use strict';

// Authored from frozen Intent artifacts. Device I/O only uses ctx.call.
// The controller must opt into recordingDir and independently verify its archive.
const { isDeepStrictEqual } = require('node:util');
const PACKAGE = 'org.localsend.localsend_app.bridge_sample';
const PICKER = 'com.coloros.filemanager';
const BASELINE = { 'flutter.ls_theme': 'system', 'flutter.ls_color': 'system' };
const DARK = { 'flutter.ls_theme': 'dark', 'flutter.ls_color': 'system' };
const ENGLISH = { ...DARK, 'flutter.ls_locale': 'en' };
const SETTINGS_GEOMETRY_LABELS = ['设置', '主题', '颜色', '语言'];
const BOUNDS_EDGES = ['left', 'top', 'right', 'bottom'];
const GEOMETRY_TOLERANCE = 0.5;
const SELECTION = ['选择', '文件', '媒体', '剪贴板', '文本', '文件夹', '应用'];
const LICENSE_BODY = [
  'Copyright 2019, the Dart project authors.',
  'Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:',
];

class Stop extends Error {
  constructor(verdict, message) { super(message); this.verdict = verdict; }
}

function unique(nodes, predicate) {
  const found = nodes.filter(predicate);
  return found.length === 1 ? found[0] : null;
}
function label(nodes, text, widgetType = 'Text') {
  return unique(nodes, n => n.text === text && n.widgetType === widgetType);
}
function validBounds(b) {
  return b && ['left', 'top', 'right', 'bottom'].every(k => Number.isFinite(b[k]))
    && b.right > b.left && b.bottom > b.top;
}
function center(b) { return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 }; }
function row(nodes, name, value) {
  const title = label(nodes, name);
  if (!title || !validBounds(title.bounds)) return null;
  const y = center(title.bounds).y;
  return unique(nodes, n => n.widgetType === 'Text' && n.text === value
    && validBounds(n.bounds) && validBounds(n.tap?.bounds)
    && n.bounds.left >= title.bounds.right
    && n.tap.bounds.top <= y && n.tap.bounds.bottom >= y
    && Math.abs(center(n.bounds).y - y) <= 2);
}
function navigation(nodes) {
  return ['接收', '发送', '设置'].every(text => label(nodes, text, 'NavigationDestination'));
}
function receive(nodes) { return navigation(nodes) && !!label(nodes, '通过链接接收'); }
function settings(nodes, theme = '跟随系统') {
  return navigation(nodes) && !!row(nodes, '主题', theme)
    && !!row(nodes, '颜色', '跟随系统') && !!row(nodes, '语言', '跟随系统');
}
function settingsGeometry(nodes) {
  const geometry = {};
  for (const text of SETTINGS_GEOMETRY_LABELS) {
    const n = label(nodes, text);
    if (!n || !validBounds(n.bounds)) return null;
    geometry[text] = Object.fromEntries(BOUNDS_EDGES.map(edge => [edge, n.bounds[edge]]));
  }
  return geometry;
}
function matchesSettingsGeometry(nodes, baseline) {
  const geometry = settingsGeometry(nodes);
  return !!geometry && SETTINGS_GEOMETRY_LABELS.every(text => BOUNDS_EDGES.every(edge =>
    Math.abs(geometry[text][edge] - baseline[text][edge]) < GEOMETRY_TOLERANCE));
}
function emptySelection(nodes) {
  const nearby = label(nodes, '附近的设备');
  if (!nearby || !navigation(nodes)) return false;
  const text = nodes.filter(n => n.widgetType === 'Text' && validBounds(n.bounds)
    && n.bounds.bottom < nearby.bounds.top).map(n => n.text).sort();
  return JSON.stringify(text) === JSON.stringify([...SELECTION].sort());
}
function emptyDiscovery(nodes, view) {
  if (!emptySelection(nodes)) return false;
  const nearby = label(nodes, '附近的设备'), end = label(nodes, '故障排除');
  if (!end || !fullyVisibleTarget(nearby, view) || !fullyVisibleTarget(end, view)
    || !validBounds(nearby.scroll?.bounds) || nearby.scroll.pixels !== 0
    || typeof nearby.scroll.nodeId !== 'string' || end.scroll?.nodeId !== nearby.scroll.nodeId
    || nearby.bounds.bottom >= end.bounds.top || end.bounds.bottom > nearby.scroll.bounds.bottom) return false;
  // In the fixed upstream App, real cards have visible aliases and HTTP/WebRTC
  // badges. Its placeholder has one 46px device icon and transparent text.
  // Both list anchors must be visible, so an offscreen peer is not accepted.
  const region = nodes.filter(n => ['Text', 'RichText', 'EditableText'].includes(n.widgetType)
    && validBounds(n.bounds) && n.bounds.bottom > nearby.bounds.bottom && n.bounds.top < end.bounds.top);
  const icon = unique(region, n => n.widgetType === 'RichText' && typeof n.text === 'string' && n.text.trim()
    && Math.abs(n.bounds.right - n.bounds.left - 46) < GEOMETRY_TOLERANCE
    && Math.abs(n.bounds.bottom - n.bounds.top - 46) < GEOMETRY_TOLERANCE);
  return !!icon && region.length === 1 && icon.scroll?.nodeId === nearby.scroll.nodeId
    && fullyVisibleTarget(icon, view) && icon.bounds.top >= nearby.bounds.bottom && icon.bounds.bottom <= end.bounds.top;
}
function language(nodes, title, selected) {
  const chosen = label(nodes, selected);
  const check = unique(nodes, n => n.widgetType === 'RichText' && n.text === '\ue159');
  return !!label(nodes, title) && !!label(nodes, 'English') && !!chosen && !!check
    && validBounds(chosen.bounds) && validBounds(check.bounds)
    && validBounds(chosen.scroll?.bounds) && validBounds(check.scroll?.bounds)
    && typeof chosen.scroll.nodeId === 'string' && chosen.scroll.nodeId === check.scroll.nodeId
    && Math.abs(center(chosen.bounds).y - center(check.bounds).y) < GEOMETRY_TOLERANCE
    && check.bounds.left > chosen.bounds.right
    && [chosen, check].every(n => n.bounds.top >= n.scroll.bounds.top
      && n.bounds.bottom <= n.scroll.bounds.bottom);
}
function signature(nodes) {
  // Ignore animated icon glyphs; retain exact node and actionable geometry.
  const edges = bounds => bounds && BOUNDS_EDGES.map(edge => bounds[edge]);
  return JSON.stringify(nodes.filter(n => n.widgetType !== 'RichText').map(n => [
    n.widgetType, n.text, edges(n.bounds), edges(n.tap?.bounds), edges(n.scroll?.bounds),
  ]));
}
function advancingStableSnapshot(previous, current) {
  return previous && Number.isFinite(previous.updatedAtMs) && Number.isFinite(current.updatedAtMs)
    && current.updatedAtMs > previous.updatedAtMs
    && signature(previous.nodes) === signature(current.nodes)
    && JSON.stringify(previous.viewport) === JSON.stringify(current.viewport);
}
function fullyVisibleTarget(node, view) {
  if (!node || !validBounds(node.bounds) || !validBounds(node.tap?.bounds)) return false;
  return [node.bounds, node.tap.bounds].every(bounds => bounds.left >= 0 && bounds.top >= 0
    && bounds.right <= view.logicalWidth && bounds.bottom <= view.logicalHeight);
}
function scrollAnchor(nodes) {
  const eligible = nodes.filter(n => n.widgetType === 'Text' && n.text
    && validBounds(n.bounds) && validBounds(n.scroll?.bounds)
    && n.bounds.top >= n.scroll.bounds.top && n.bounds.bottom <= n.scroll.bounds.bottom
    && label(nodes, n.text) === n);
  return unique(eligible, n => eligible.every(other => other === n || n.bounds.top < other.bounds.top
    || (n.bounds.top === other.bounds.top && n.bounds.left < other.bounds.left)));
}
function exactSettings(actual, expected) {
  return actual && Object.keys(actual).length === Object.keys(expected).length
    && Object.keys(expected).every(k => actual[k] === expected[k]);
}

// Record existence alone is insufficient. Bind the actual mobile events to the
// original Flutter receipt and target; UI and persisted settings are checked separately.
function flutterActionEvidence(read, action, route = null) {
  const receipt = action?.executionReceipt, id = action?.execution?.actionId;
  if (!read.ok || !action?.ok || action.command !== 'tap-flutter'
    || receipt?.kind !== 'flutter' || receipt.settled !== true || receipt.actionId !== id
    || receipt.dispatched !== true || receipt.ambiguous !== false
    || read.evidence.window.afterActionId !== id
    || !isDeepStrictEqual(read.execution.target, action.execution.target)) return false;
  const items = read.result.items;
  if (!items.every(item => item.type === 'event' && item.source === 'flutter-sdk' && item.actionId === id)) return false;
  const started = unique(items, item => item.name === 'flutter.action.started' && item.category === 'execution');
  const tapped = unique(items, item => item.name === 'target.tap' && item.category === 'ui.interaction');
  const settled = unique(items, item => item.name === 'flutter.action.settled' && item.category === 'execution');
  if (!started || !tapped || !settled || !(started.id < tapped.id && tapped.id < settled.id)
    || ![started, settled].every(item => item.data.actionId === id && item.data.runtimeEpoch === receipt.runtimeEpoch)
    || tapped.data.ok !== true || tapped.data.dispatched !== true || tapped.data.ambiguous !== false
    || tapped.data.targetValidation !== 'aab.flutter-target/v1'
    || !isDeepStrictEqual(tapped.data.targetRef, action.result.request.targetRef)
    || settled.data.dispatched !== true || settled.data.stopReason !== null) return false;
  const proofs = [started, tapped, settled];
  if (route !== null) {
    const changed = unique(items, item => item.name === 'ui.route.changed' && item.category === 'ui'
      && item.data.location === route.location && item.data.action === route.action && item.data.semanticChanged === true);
    if (!changed || !(started.id < changed.id && changed.id < settled.id)) return false;
    proofs.push(changed);
  }
  return proofs.every(item => read.evidence.refs.some(ref => ref.stream === 'events' && ref.captureId === item.id));
}

async function main(ctx) {
  const { serial, outputDir, scenario = 'acceptance', expectedDeviceName = '好的椰子',
    cancelBeforeSettings = false } = ctx.inputs;
  if (typeof serial !== 'string' || !serial || typeof outputDir !== 'string' || !outputDir.startsWith('/')) {
    throw new Error('serial and an absolute existing outputDir are required');
  }
  if (!['core', 'acceptance'].includes(scenario) || typeof expectedDeviceName !== 'string'
    || typeof cancelBeforeSettings !== 'boolean') throw new Error('invalid scenario inputs');
  const started = Date.now();
  const target = { serial, packageName: PACKAGE };
  const assertions = [], externalOracles = [], checkpoints = [], actions = [], screenshots = [], openGates = [], mobileCaptures = [], stableObservations = [], businessEvidence = [];
  let lastActionId = null, lastPage = 'unknown', imageIndex = 0, flowCompleted = false;
  let geometryBaseline = null, geometryRestored = null;

  function settingsAtBaseline(nodes) {
    return settings(nodes) && geometryBaseline !== null && matchesSettingsGeometry(nodes, geometryBaseline.bounds);
  }

  async function check(name, condition, read, requiredEvidence = ['tree'], fatal = true) {
    const verdict = await ctx.assert({ name, predicateSummary: name, condition,
      requiredEvidence, evidence: read.evidence, requireCoverage: 'complete' });
    assertions.push({ ...verdict, evidenceKind: requiredEvidence.some(stream => ['events', 'state', 'logs', 'network'].includes(stream)) ? 'capture' : 'ui',
      observationId: read.evidence?.observationId,
      evidenceRefs: read.evidence?.refs });
    if (fatal && verdict.verdict !== 'passed') throw new Stop(verdict.verdict, `${name}: ${verdict.reason || verdict.verdict}`);
    return verdict;
  }
  async function requireCall(command, response) {
    if (!response.ok) {
      await check(`${command}: successful fresh observation or dispatch`, false, response,
        ['tree'], false);
      throw new Stop('inconclusive', `${command}: ${response.error || 'provider_call_failed'}; mutation is never retried`);
    }
    return response;
  }
  async function call(command, args = {}, packageName = PACKAGE, options = {}) {
    return requireCall(command, await ctx.call(command, { ...target, packageName, ...args }, options));
  }
  function windowOptions() {
    return lastActionId ? { evidenceWindow: { afterActionId: lastActionId, timeoutMs: 1000 } } : {};
  }
  async function observe(name, predicate, { setup = false, seed = null } = {}) {
    const deadline = Date.now() + 10000;
    let previous = seed, current, sawAdvance = false;
    do {
      current = await call('flutter-nodes', {}, PACKAGE, windowOptions());
      if (!current.result?.ok || !Array.isArray(current.result.nodes) || current.result.truncated !== false) {
        await check(`${name}: complete Flutter operable tree`, false, current);
      }
      viewport(current);
      const stamp = current.result.updatedAtMs;
      if (!Number.isFinite(stamp) || stamp <= 0) throw new Stop('inconclusive', `${name}: Flutter snapshot timestamp unavailable`);
      if (previous && stamp < previous.result.updatedAtMs) throw new Stop('inconclusive', `${name}: Flutter snapshot timestamp regressed`);
      if (previous && stamp > previous.result.updatedAtMs) sawAdvance = true;
      if (previous && advancingStableSnapshot(previous.result, current.result)
        && predicate(previous.result.nodes, previous.result.viewport)
        && predicate(current.result.nodes, current.result.viewport)) {
        await check(name, true, current);
        stableObservations.push({ name, firstObservationId: previous.evidence.observationId,
          firstUpdatedAtMs: previous.result.updatedAtMs, firstEvidenceRefs: previous.evidence.refs,
          observationId: current.evidence.observationId, updatedAtMs: stamp,
          evidenceRefs: current.evidence.refs, relation: 'matching geometry across advancing SDK snapshot generations' });
        lastPage = name;
        return current;
      }
      if (!previous || stamp > previous.result.updatedAtMs) previous = current;
      await new Promise(resolve => setTimeout(resolve, 180));
    } while (Date.now() < deadline);
    if (!sawAdvance) throw new Stop('inconclusive', `${name}: SDK snapshot generation did not advance before deadline`);
    if (setup) {
      openGates.push({ id: 'unfrozen-setup-branch', verdict: 'inconclusive',
        reason: 'Initial Receive fixture absent. Onboarding/permissions/installer or changed localization needs an explicit frozen setup branch.',
        observationId: current.evidence.observationId });
      throw new Stop('inconclusive', 'Initial setup differs from the frozen Receive fixture');
    }
    await check(name, predicate(current.result.nodes, current.result.viewport), current);
    throw new Stop('inconclusive', `${name}: geometry did not stabilize across advancing SDK snapshots before deadline`);
  }
  async function screenshot(name, packageName = PACKAGE) {
    const r = await call('screenshot', { outFile: `${outputDir}/${String(++imageIndex).padStart(2, '0')}-${name}.png` }, packageName);
    await check(`${name}: screenshot foreground belongs to expected package`,
      r.result.foregroundMatchesPackage === true && r.result.foreground?.packageName === packageName,
      r, ['screenshot']);
    screenshots.push({ name, artifact: r.result.artifact, evidence: r.evidence,
      binding: 'separate capture after nearby tree; not atomic' });
    return r;
  }
  function pickerControls(read) {
    const ns = read.result.nodes;
    if (!Array.isArray(ns)) return { cancel: null, add: null };
    return {
      cancel: unique(ns, n => n.packageName === PICKER && n.resourceId === `${PICKER}:id/action_cancel`
        && n.text === '取消' && n.enabled === true && validBounds(n.bounds)),
      add: unique(ns, n => n.packageName === PICKER && n.resourceId === `${PICKER}:id/action_finish`
        && n.text === '添加(0)' && n.enabled === false),
    };
  }
  async function observePicker() {
    const deadline = Date.now() + 10000;
    let read;
    do {
      read = await ctx.call('uia-tree', { ...target, packageName: PICKER, compact: true, maxNodes: 1000, maxDepth: 100 });
      if (!read.ok && read.error === 'uia_tree_changed' && read.dispatched === false
        && read.ambiguous === false && read.execution.actionId === null) {
        await ctx.progress({ stage: 'picker-tree-reobserve', error: read.error,
          callId: read.execution.callId, observationId: read.evidence.observationId });
        await new Promise(resolve => setTimeout(resolve, 180));
        continue;
      }
      await requireCall('uia-tree', read);
      const { cancel, add } = pickerControls(read);
      if (read.result.source === 'uiautomator' && read.result.truncated === false && cancel && add) {
        await check('Actual OPPO picker has Cancel and disabled Add(0)', true, read);
        return read;
      }
      await new Promise(resolve => setTimeout(resolve, 180));
    } while (Date.now() < deadline);
    await check('Actual OPPO picker has Cancel and disabled Add(0)', false, read);
    return read;
  }
  async function checkpoint(name, read, state = {}) {
    const data = { page: lastPage, afterActionId: lastActionId,
      observationId: read.evidence.observationId, evidenceRefs: read.evidence.refs, ...state };
    await ctx.checkpoint(name, data);
    checkpoints.push({ name, ...data });
  }
  function viewport(read) {
    const v = read.result.viewport;
    const keys = ['devicePixelRatio', 'logicalWidth', 'logicalHeight', 'physicalWidth', 'physicalHeight'];
    if (!v || !keys.every(k => Number.isFinite(v[k]) && v[k] > 0)
      || Math.abs(v.logicalWidth * v.devicePixelRatio - v.physicalWidth) > 1
      || Math.abs(v.logicalHeight * v.devicePixelRatio - v.physicalHeight) > 1) {
      throw new Stop('inconclusive', 'Fresh Flutter viewport physical/logical extents are inconsistent');
    }
    return v;
  }
  async function mutate(name, command, args, read, chosen, packageName = PACKAGE) {
    await ctx.progress({ stage: name, sourceObservationId: read.evidence.observationId,
      selector: chosen, actionWindow: lastActionId });
    const r = await call(command, args, packageName);
    actions.push({ name, command, callId: r.execution?.callId, actionId: r.execution?.actionId,
      sourceObservationId: read.evidence.observationId, selected: chosen, arguments: args,
      transport: r.result?.transport });
    if (command === 'tap-flutter' && (r.executionReceipt?.kind !== 'flutter'
      || r.executionReceipt.settled !== true || r.executionReceipt.actionId !== r.execution?.actionId)) {
      throw new Stop('inconclusive', `${name}: original bound Flutter receipt unavailable; no retry`);
    }
    if (typeof r.execution?.actionId !== 'string') throw new Stop('inconclusive', `${name}: actionId missing`);
    lastActionId = r.execution.actionId;
    return r;
  }
  async function tap(name, read, selector) {
    const current = await observe(`${name}: fully visible actionable target`,
      (nodes, view) => fullyVisibleTarget(selector(nodes), view), { seed: read });
    const n = selector(current.result.nodes), v = viewport(current), point = center(n.tap.bounds);
    await check(`${name}: one observed actionable target`, !!n && validBounds(n.tap?.bounds), current);
    await check(`${name}: complete logical target is within current viewport`, fullyVisibleTarget(n, v), current);
    return mutate(name, 'tap-flutter', { selector: { nodeId: n.id } }, current,
    { nodeId: n.id, text: n.text, widgetType: n.widgetType, logicalBounds: n.tap.bounds,
      logicalPoint: point, devicePixelRatio: v.devicePixelRatio, sdkSnapshotUpdatedAtMs: current.result.updatedAtMs });
  }
  async function back(name, read, expected) {
    await tap(name, read, ns => label(ns, '返回', 'Semantics'));
    return observe(`${name}-destination`, expected);
  }
  async function scrollTo(name, read, expected, direction, anchorLabel, maxScrolls, command) {
    let current = read;
    for (let i = 0; i < maxScrolls && !expected(current.result.nodes); i += 1) {
      const anchor = i === 0 ? label(current.result.nodes, anchorLabel)
        : scrollAnchor(current.result.nodes);
      await check(`${name}-${i + 1}: observed scroll anchor`, !!anchor && validBounds(anchor.scroll?.bounds), current);
      const v = viewport(current), b = anchor.scroll.bounds;
      const top = Math.max(0, b.top), bottom = Math.min(v.logicalHeight, b.bottom);
      let args;
      if (command === 'scroll-flutter') {
        const container = unique(current.result.nodes, n => n.role === 'scrollable'
          && n.scroll?.axis === 'vertical' && n.id === anchor.scroll.nodeId
          && n.scroll.nodeId === n.id && n.targetRef?.schemaVersion === 'aab.flutter-target/v1'
          && n.targetRef.elementId === n.id
          && validBounds(n.scroll?.bounds)
          && ['left', 'top', 'right', 'bottom'].every(k => n.scroll.bounds[k] === b[k]));
        await check(`${name}-${i + 1}: unique observed About scroll container`, !!container, current);
        args = { selector: { nodeId: container.id },
          delta: (direction === 'down' ? 1 : -1) * Math.min(450, (bottom - top) * 0.6) };
      } else if (command === 'swipe') {
        const x = (Math.max(0, b.left) + Math.min(v.logicalWidth, b.right)) / 2;
        const high = top + (bottom - top) * 0.2, low = top + (bottom - top) * 0.8;
        args = { startX: Math.round(x * v.devicePixelRatio), endX: Math.round(x * v.devicePixelRatio),
          startY: Math.round((direction === 'down' ? low : high) * v.devicePixelRatio),
          endY: Math.round((direction === 'down' ? high : low) * v.devicePixelRatio), durationMs: 280 };
      } else throw new Stop('inconclusive', `Undeclared scrolling route: ${command}`);
      const before = signature(current.result.nodes);
      await mutate(`${name}-${i + 1}`, command, args, current,
        { nodeId: anchor.id, text: anchor.text, logicalScrollBounds: b, direction, primaryRoute: command });
      current = await observe(`${name}-${i + 1}: moved or reached destination`,
        ns => expected(ns) || (signature(ns) !== before && !!scrollAnchor(ns)));
      // Any next swipe resolves the unique topmost/leftmost visible text anchor
      // in this new, visibly moved observation. A transient navigation-only
      // tree cannot complete the read wait or authorize another scroll.
    }
    await check(`${name}: destination visible`, expected(current.result.nodes), current);
    return current;
  }
  async function oracle(name, expected, read) {
    await checkpoint(name, read, { expectedSettings: expected, requireExactSettings: true });
    const reply = await ctx.askAgent({ question: `Record independent persisted settings at ${name}, compare the exact allowlisted map, and return the saved result.`,
      options: [{ id: 'recorded', label: 'External oracle recorded' }],
      context: { kind: 'localsend.settings-oracle/v1', checkpoint: name, expectedSettings: expected,
        requireExactSettings: true, afterActionId: lastActionId,
        observationId: read.evidence.observationId, evidenceRefs: read.evidence.refs } });
    const valid = reply?.kind === 'localsend.settings-oracle-result/v1' && reply.checkpoint === name
      && ['passed', 'failed', 'inconclusive'].includes(reply.verdict)
      && typeof reply.artifact?.path === 'string' && reply.artifact.path.startsWith('/')
      && /^[a-f0-9]{64}$/.test(reply.artifact.sha256);
    const verdict = !valid ? 'inconclusive' : reply.verdict === 'passed'
      && !exactSettings(reply.observedSettings, expected) ? 'failed' : reply.verdict;
    externalOracles.push({ checkpoint: name, verdict, controllerResult: reply,
      scope: 'external-controller-oracle; not device ctx.assert evidence' });
    await ctx.progress({ stage: name, externalOracleVerdict: verdict, artifact: reply?.artifact });
    if (verdict !== 'passed') throw new Stop(verdict, `${name}: independent settings oracle did not pass`);
  }
  async function mobileBoundary(name) {
    const boundaries = {};
    for (const stream of ['events', 'state', 'logs']) {
      const before = await ctx.call(stream, { ...target, sinceMs: Date.now() - 1000, limit: 200 },
        { evidenceWindow: { timeoutMs: 1000 } });
      const c = before.evidence.capture, coverage = before.evidence.coverage;
      const ready = before.ok && coverage.status === 'complete' && coverage.gap === false
        && coverage.committed === true && c.hasMore === false
        && typeof c.watermarkCursor === 'string' && c.watermarkCursor.length > 0
        && typeof c.runtimeEpoch === 'string' && c.runtimeEpoch.length > 0 && c.targetKey === PACKAGE;
      boundaries[stream] = { before, ready };
      mobileCaptures.push({ name, stream, phase: 'before', ready, error: before.error,
        evidence: before.evidence, itemCount: before.result.items.length });
    }
    return boundaries;
  }
  async function mobileEvidence(name, boundaries, action, route = null) {
    const mutationPackage = action.execution.target.packageName;
    for (const stream of ['events', 'state', 'logs']) {
      const { before, ready } = boundaries[stream];
      const c = before.evidence.capture;
      // No cursor is invented or reused across another mutation. A missing
      // boundary is retained as unavailable evidence, without querying history.
      const r = ready ? await ctx.call(stream, { ...target, factCursor: c.watermarkCursor,
        runtimeEpoch: c.runtimeEpoch, afterActionId: lastActionId, limit: 200 }, windowOptions()) : before;
      const applicable = ready && mutationPackage === PACKAGE;
      if (stream === 'events' && mutationPackage === PACKAGE) {
        await check(`${name}: original Flutter target and completion events${route ? ' with the expected route transition' : ''}`,
          ready && applicable && flutterActionEvidence(r, action, route), r, ['events'], false);
      }
      mobileCaptures.push({ name, stream, phase: ready ? 'after' : 'after-unavailable',
        applicable, mutationPackage, afterActionId: lastActionId, error: r.error,
        purpose: stream === 'events' && mutationPackage === PACKAGE ? 'original-action-facts' : 'supporting-diagnostics',
        association: mutationPackage === PACKAGE ? 'app-action-window' : 'system-action-has-no-app-local-context',
        evidence: r.evidence, itemCount: r.result.items.length });
      if (!ready || !r.ok) openGates.push({
        id: `${name}-${stream}-capture-boundary`, verdict: 'inconclusive',
        reason: !ready ? 'Current complete committed pre-action mobile watermark unavailable.'
          : `Post-action capture unavailable: ${r.error}`,
        observationId: r.evidence.observationId,
      });
    }
  }
  async function networkOracle(name, phase, read) {
    const reply = await ctx.askAgent({ question: `Record the ${phase} phase of the explicit no-SIM, Wi-Fi-disconnected fixture at ${name}. Restore the original network on any exit.`,
      options: [{ id: 'recorded', label: 'Network fixture recorded' }],
      context: { kind: 'localsend.no-peer-fixture/v1', checkpoint: name, phase, serial,
        observationId: read.evidence.observationId, evidenceRefs: read.evidence.refs } });
    const valid = reply?.kind === 'localsend.no-peer-fixture-result/v1' && reply.checkpoint === name
      && reply.phase === phase && reply.serial === serial && reply.condition === 'no-sim-wifi-disconnected'
      && ['passed', 'failed', 'inconclusive'].includes(reply.verdict)
      && typeof reply.artifact?.path === 'string' && reply.artifact.path.startsWith('/')
      && /^[a-f0-9]{64}$/.test(reply.artifact.sha256);
    const verdict = valid ? reply.verdict : 'inconclusive';
    externalOracles.push({ checkpoint: name, phase, verdict, controllerResult: reply,
      scope: 'external-controller-network-fixture; not device ctx.assert evidence' });
    if (verdict !== 'passed') throw new Stop(verdict, `${name}: ${phase} network fixture did not pass`);
    return reply;
  }
  async function placeholder(name, page, imageName) {
    const isolated = await networkOracle(name, 'isolate', page);
    const observed = await observe(`${name}: complete visible empty-discovery region`, emptyDiscovery);
    const captured = await screenshot(imageName);
    const verified = await networkOracle(name, 'verify', observed);
    const restored = await networkOracle(name, 'restore', observed);
    businessEvidence.push({ name, observationId: observed.evidence.observationId,
      evidenceRefs: observed.evidence.refs, screenshot: captured.result.artifact,
      network: { isolated, verified, restored },
      claim: 'Complete empty discovery UI under independently checked disconnected network conditions; no discovery-completion or transport claim.' });
    return observed;
  }

  let stop = null;
  try {
    let page = await observe('initial-receive', receive, { setup: true });
    await check('Receive shows the expected fixture device name', !!label(page.result.nodes, expectedDeviceName), page);
    await checkpoint('initial-fixture', page, { expectedSettings: BASELINE, settingsScroll: 'top', selectedFiles: 0 });
    await screenshot('initial-receive');

    if (scenario === 'acceptance') {
      page = await observe('receive-before-link', receive);
      await tap('open-link-receive', page, ns => label(ns, '通过链接接收'));
      page = await observe('link-receive', ns => ['在浏览器中打开其中一个链接：', '加密', '自动接受请求', '启用 PIN 密码']
        .every(t => label(ns, t)) && !!label(ns, '返回', 'Semantics'));
      await check('Link receive exposes at least one live address', page.result.nodes.some(n => n.widgetType === 'EditableText'
        && typeof n.text === 'string' && /^https?:\/\/[^\s/]+(?::\d+)?\/?$/.test(n.text)), page);
      await screenshot('link-receive');
      page = await observe('link-before-back', ns => !!label(ns, '在浏览器中打开其中一个链接：'));
      page = await back('return-from-link', page, receive);
      await tap('open-send', page, ns => label(ns, '发送', 'NavigationDestination'));
      page = await observe('send-empty-selection', emptySelection);
      page = await placeholder('before-picker', page, 'send-empty-selection');
      page = await observe('send-before-picker', emptySelection);
      await tap('open-files-picker', page, ns => label(ns, '文件'));
      await observePicker();
      await screenshot('files-picker-zero-selection', PICKER);
      const pickerBoundary = await mobileBoundary('picker-cancel');
      const picker = await observePicker();
      const { cancel } = pickerControls(picker);
      const cancelled = await mutate('cancel-files-picker', 'tap-uia', { selector: { resourceName: cancel.resourceId } }, picker,
        { resourceId: cancel.resourceId, text: cancel.text, physicalBounds: cancel.bounds }, PICKER);
      const receipt = cancelled.executionReceipt;
      if (receipt?.kind !== 'uia-node' || receipt.settled !== true
        || receipt.actionId !== cancelled.execution.actionId) {
        throw new Stop('inconclusive', 'Picker Cancel original UIA completion is unavailable');
      }
      const completion = JSON.parse(receipt.receiptJson);
      if (completion.completion !== 'original_callback'
        || completion.binding.actionTarget.packageName !== PICKER
        || completion.binding.actionTarget.resourceName !== cancel.resourceId
        || completion.binding.actionTarget.text !== cancel.text || completion.callback.handled !== true) {
        throw new Stop('inconclusive', 'Picker Cancel original callback does not bind the observed system button');
      }
      page = await observe('send-after-picker-cancel', emptySelection);
      businessEvidence.push({ name: 'picker-cancel', actionCallId: cancelled.execution.callId,
        actionId: cancelled.execution.actionId, receipt: cancelled.executionReceipt,
        resultObservationId: page.evidence.observationId, resultEvidenceRefs: page.evidence.refs,
        claim: 'The original system Cancel callback completed and a fresh App page has no selected files; no app-local actionId is claimed.' });
      await screenshot('send-after-picker-cancel');
      await mobileEvidence('picker-cancel', pickerBoundary, cancelled);
      page = await observe('send-before-settings', emptySelection);
    }

    await tap('open-settings', page, ns => label(ns, '设置', 'NavigationDestination'));
    page = await observe('settings-top-baseline', ns => settings(ns));
    const initialGeometry = settingsGeometry(page.result.nodes);
    await check('Initial Settings has unique finite baseline geometry', !!initialGeometry, page);
    geometryBaseline = { bounds: initialGeometry, observationId: page.evidence.observationId,
      evidenceRefs: page.evidence.refs };
    await screenshot('settings-top-baseline');
    if (scenario === 'acceptance') {
      page = await observe('settings-before-mutations', ns => settings(ns));
      await checkpoint('before-settings-mutations', page, { expectedSettings: BASELINE });
      if (cancelBeforeSettings) {
        const reply = await ctx.askAgent({ question: 'Controlled cancellation gate reached before any settings mutation. The controller should cancel this execution.',
          options: [{ id: 'continue', label: 'Continue only outside cancellation trial' }],
          context: { kind: 'localsend.controlled-cancel/v1', checkpoint: 'before-settings-mutations',
            observationId: page.evidence.observationId, evidenceRefs: page.evidence.refs, afterActionId: lastActionId } });
        if (reply?.kind !== 'localsend.controlled-continue/v1') throw new Stop('inconclusive', 'Cancellation gate did not receive an explicit continue decision');
      }
      page = await observe('settings-before-theme-menu', ns => settings(ns));
      await tap('open-theme-row', page, ns => row(ns, '主题', '跟随系统'));
      page = await observe('theme-menu', ns => ['跟随系统', '浅色', '深色'].every(t => label(ns, t)) && !navigation(ns));
      await tap('choose-dark', page, ns => label(ns, '深色'));
      page = await observe('settings-dark', ns => settings(ns, '深色'));
      await screenshot('settings-dark');
      await oracle('settings-dark', DARK, page);
      page = await observe('settings-before-language', ns => settings(ns, '深色'));
      await tap('open-language-row', page, ns => row(ns, '语言', '跟随系统'));
      page = await observe('language-system-before-change', ns => language(ns, '语言', '跟随系统'));
      await tap('choose-english', page, ns => label(ns, 'English'));
      page = await observe('language-english-selected', ns => language(ns, 'Language', 'English'));
      await screenshot('language-english-selected');
      await oracle('settings-dark-english', ENGLISH, page);
      page = await observe('language-before-system-restore', ns => language(ns, 'Language', 'English'));
      await tap('restore-system-language', page, ns => label(ns, 'System'));
      page = await observe('language-system-restored', ns => language(ns, '语言', '跟随系统'));
      page = await back('return-from-language', page, ns => settings(ns, '深色'));
      await tap('open-dark-theme-row', page, ns => row(ns, '主题', '深色'));
      const restoredBoundary = await mobileBoundary('settings-restored');
      page = await observe('theme-restoration-menu', ns => ['跟随系统', '浅色', '深色'].every(t => label(ns, t)) && !navigation(ns));
      const restoredAction = await tap('restore-system-theme', page, ns => label(ns, '跟随系统'));
      page = await observe('settings-restored', ns => settings(ns));
      await screenshot('settings-restored');
      await oracle('settings-restored', BASELINE, page);
      await mobileEvidence('settings-restored', restoredBoundary, restoredAction, { location: 'HomePage', action: 'pop' });
      businessEvidence.push({ name: 'settings-restored', actionCallId: restoredAction.execution.callId,
        actionId: restoredAction.execution.actionId, resultObservationId: page.evidence.observationId,
        resultEvidenceRefs: page.evidence.refs, externalOracleCheckpoint: 'settings-restored',
        claim: 'The theme menu closed, the settings page displays System, and the external controller read the exact persisted settings.' });
      page = await observe('settings-before-about-scroll', ns => settings(ns));
    }

    page = await scrollTo('settings-to-about', page, ns => !!row(ns, '关于 LocalSend', '打开'), 'down', '主题', 5, 'swipe');
    await tap('open-about-row', page, ns => row(ns, '关于 LocalSend', '打开'));
    page = await observe('about-top', ns => !!label(ns, '关于 LocalSend') && !!label(ns, 'LocalSend') && !!label(ns, 'localsend.org'));
    await screenshot('about-top');
    page = await observe('about-before-license-scroll', ns => !!label(ns, 'LocalSend') && !!label(ns, 'localsend.org'));
    page = await scrollTo('about-to-license-notices', page, ns => !!label(ns, 'License Notices'), 'down', 'LocalSend', 8, 'scroll-flutter');
    await tap('open-license-notices', page, ns => label(ns, 'License Notices'));
    page = await observe('framework-license-list', ns => !!label(ns, '许可') && !!label(ns, 'Powered by Flutter') && !!label(ns, '_fe_analyzer_shared'));
    await screenshot('framework-license-list');
    page = await observe('framework-list-before-detail', ns => !!label(ns, '许可') && !!label(ns, '_fe_analyzer_shared'));
    await tap('open-framework-license', page, ns => label(ns, '_fe_analyzer_shared'));
    page = await observe('framework-license-body', ns => !!label(ns, '_fe_analyzer_shared')
      && LICENSE_BODY.every(t => label(ns, t)) && !!label(ns, '1 份许可'));
    await screenshot('framework-license-body');
    await checkpoint('framework-license-body', page);
    page = await observe('license-body-before-back', ns => LICENSE_BODY.every(t => label(ns, t)));
    page = await back('license-detail-back', page, ns => !!label(ns, '许可') && !!label(ns, '_fe_analyzer_shared'));
    page = await back('license-list-back', page, ns => !!label(ns, '关于 LocalSend') && !!label(ns, 'License Notices'));
    page = await back('about-back-to-settings', page, ns => !!row(ns, '关于 LocalSend', '打开') && navigation(ns));
    page = await scrollTo('restore-settings-scroll-top', page, settingsAtBaseline, 'up', '关于 LocalSend', 5, 'swipe');
    geometryRestored = { bounds: settingsGeometry(page.result.nodes), observationId: page.evidence.observationId,
      evidenceRefs: page.evidence.refs };
    await checkpoint('settings-scroll-restored', page, { expectedSettings: BASELINE, settingsScroll: 'top',
      geometryBaseline, geometryRestored, geometryToleranceLogicalPixels: GEOMETRY_TOLERANCE,
      geometryComparison: 'strict-less-than' });
    if (scenario === 'acceptance') {
      await tap('final-visit-send', page, ns => label(ns, '发送', 'NavigationDestination'));
      page = await observe('final-send-empty-selection', emptySelection);
      page = await placeholder('final-send', page, 'final-send-empty-discovery');
      page = await observe('final-send-before-receive', emptySelection);
    }
    const finalBoundary = await mobileBoundary('final-receive');
    page = await observe('before-final-visit-receive', scenario === 'acceptance' ? emptySelection : settingsAtBaseline);
    const finalAction = await tap('final-visit-receive', page, ns => label(ns, '接收', 'NavigationDestination'));
    page = await observe('final-receive', receive);
    await check('Final Receive preserves fixture device name', !!label(page.result.nodes, expectedDeviceName), page);
    await screenshot('final-receive');
    await checkpoint('final-fixture', page, { expectedSettings: BASELINE, settingsScroll: 'top', selectedFiles: 0 });
    await mobileEvidence('final-receive', finalBoundary, finalAction);
    businessEvidence.push({ name: 'final-receive', actionCallId: finalAction.execution.callId,
      actionId: finalAction.execution.actionId, resultObservationId: page.evidence.observationId,
      resultEvidenceRefs: page.evidence.refs,
      claim: 'The original Receive target action completed and the fresh page has Receive content and the fixture name; tab selection is not a route push.' });
    openGates.push({ id: 'final-independent-fixture-equality', verdict: 'inconclusive',
      reason: 'Controller must capture final persisted preferences after execution and compare exactly with its independently verified initial fixture; final checkpoint is not that external observation.' });
    flowCompleted = true;
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    stop = { verdict: error.verdict, reason: error.message };
  }
  const ui = assertions.filter(a => a.evidenceKind === 'ui');
  const uiVerdict = ui.some(a => a.verdict === 'failed') ? 'failed'
    : stop?.verdict || (flowCompleted && ui.every(a => a.verdict === 'passed')
      && !openGates.some(gate => gate.scope === 'ui') ? 'passed' : 'inconclusive');
  const businessVerdict = uiVerdict === 'failed' || assertions.some(a => a.verdict === 'failed')
    || externalOracles.some(o => o.verdict === 'failed') ? 'failed'
    : !flowCompleted || openGates.length || assertions.some(a => a.verdict !== 'passed') ? 'inconclusive' : 'passed';
  const result = { schemaVersion: 'localsend.script-result/v1', scenario, flowCompleted,
    uiVerdict, businessVerdict, assertions, externalOracles, openGates, checkpoints, actions,
    screenshots, mobileCaptures, businessEvidence, stableObservations, settingsGeometry: { baseline: geometryBaseline, restored: geometryRestored,
      toleranceLogicalPixels: GEOMETRY_TOLERANCE, comparison: 'strict-less-than' }, lastPage, stop, wallMs: Date.now() - started,
    timingSource: 'Use Host per-run active/provider/business/decision/paused/evidence/wall timings; oracle waits count in wall time.',
    executionStatusMeaning: 'completed only means this function returned; inspect businessVerdict and every assertion.' };
  await ctx.progress({ stage: 'finished', flowCompleted, uiVerdict, businessVerdict, lastPage });
  return result;
}

module.exports = { main, flutterActionEvidence, emptyDiscovery };
