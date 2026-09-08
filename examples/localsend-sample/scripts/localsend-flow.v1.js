'use strict';

// Authored from frozen Intent artifacts. Device I/O only uses ctx.call.
// The controller must opt into recordingDir and independently verify its archive.
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
function language(nodes, title, selected) {
  const chosen = label(nodes, selected);
  const check = unique(nodes, n => n.widgetType === 'RichText' && n.text === '\ue159');
  return !!label(nodes, title) && !!label(nodes, 'English') && !!chosen && !!check
    && validBounds(chosen.tap?.bounds) && validBounds(check.tap?.bounds)
    && JSON.stringify(chosen.tap.bounds) === JSON.stringify(check.tap.bounds);
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
  const assertions = [], externalOracles = [], checkpoints = [], actions = [], screenshots = [], openGates = [], mobileCaptures = [], stableObservations = [];
  let lastActionId = null, lastPage = 'unknown', imageIndex = 0, flowCompleted = false;
  let geometryBaseline = null, geometryRestored = null;

  function settingsAtBaseline(nodes) {
    return settings(nodes) && geometryBaseline !== null && matchesSettingsGeometry(nodes, geometryBaseline.bounds);
  }

  async function check(name, condition, read, requiredEvidence = ['tree'], fatal = true) {
    const verdict = await ctx.assert({ name, predicateSummary: name, condition,
      requiredEvidence, evidence: read.evidence, requireCoverage: 'complete' });
    assertions.push({ ...verdict, observationId: read.evidence?.observationId,
      evidenceRefs: read.evidence?.refs });
    if (fatal && verdict.verdict !== 'passed') throw new Stop(verdict.verdict, `${name}: ${verdict.reason || verdict.verdict}`);
    return verdict;
  }
  async function call(command, args = {}, packageName = PACKAGE, options = {}) {
    const response = await ctx.call(command, { ...target, packageName, ...args }, options);
    if (!response.ok) {
      await check(`${command}: successful fresh observation or dispatch`, false, response,
        ['tree'], false);
      throw new Stop('inconclusive', `${command}: ${response.error || 'provider_call_failed'}; mutation is never retried`);
    }
    return response;
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
      read = await call('uia-tree', { compact: true, maxNodes: 1000, maxDepth: 100 }, PICKER);
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
    if (command === 'tap' && packageName === PACKAGE && r.result.transport !== 'bridge') {
      throw new Stop('inconclusive', `${name}: unexpected tap transport ${r.result.transport}; stop after receipt, no retry`);
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
    return mutate(name, 'tap', { tapX: Math.round(point.x * v.devicePixelRatio),
      tapY: Math.round(point.y * v.devicePixelRatio) }, current,
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
        const container = unique(current.result.nodes, n => n.widgetType === 'SingleChildScrollView'
          && validBounds(n.scroll?.bounds)
          && ['left', 'top', 'right', 'bottom'].every(k => n.scroll.bounds[k] === b[k]));
        await check(`${name}-${i + 1}: unique observed About scroll container`, !!container, current);
        args = { delta: (direction === 'down' ? 1 : -1) * Math.min(450, (bottom - top) * 0.6) };
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
  async function mobileEvidence(name, boundaries, mutationPackage = PACKAGE) {
    for (const stream of ['events', 'state', 'logs']) {
      const { before, ready } = boundaries[stream];
      const c = before.evidence.capture;
      // No cursor is invented or reused across another mutation. A missing
      // boundary is retained as unavailable evidence, without querying history.
      const r = ready ? await ctx.call(stream, { ...target, factCursor: c.watermarkCursor,
        runtimeEpoch: c.runtimeEpoch, afterActionId: lastActionId, limit: 200 }, windowOptions()) : before;
      const applicable = ready && mutationPackage === PACKAGE;
      await check(`${name}: ${stream} facts recorded in the current action window`,
        r.ok && applicable && Array.isArray(r.result.items) && r.result.items.length > 0
        && r.evidence.window?.afterActionId === lastActionId, r, [stream], false);
      mobileCaptures.push({ name, stream, phase: ready ? 'after' : 'after-unavailable',
        applicable, mutationPackage, afterActionId: lastActionId, error: r.error,
        evidence: r.evidence, itemCount: r.result.items.length });
      if (!ready || !r.ok || !applicable) openGates.push({
        id: `${name}-${stream}-capture-boundary`, verdict: 'inconclusive',
        reason: !ready ? 'Current complete committed pre-action mobile watermark unavailable.'
          : !applicable ? 'System picker mutation has no app-local capture association across packages.'
            : `Post-action capture unavailable: ${r.error}`,
        observationId: r.evidence.observationId,
      });
    }
  }
  async function placeholder(name) {
    // A positive diagnostic widget presence establishes this UI branch only.
    // It does not establish network discovery completeness or peer isolation.
    for (let sample = 1; sample <= 2; sample += 1) {
      const r = await call('flutter-tree', {}, PACKAGE, windowOptions());
      const all = [], stack = [r.result.widgetInspector];
      while (stack.length) {
        const n = stack.pop();
        if (!n || typeof n !== 'object') continue;
        all.push(n);
        if (Array.isArray(n.children)) stack.push(...n.children);
      }
      const send = all.filter(n => n.widgetRuntimeType === 'SendTab');
      const placeholders = all.filter(n => n.widgetRuntimeType === 'DevicePlaceholderListTile');
      await check(`${name}-${sample}: Send empty-discovery placeholder branch`, send.length === 1
        && placeholders.length === 1 && r.result.operable?.truncated === false
        && emptySelection(r.result.operable.nodes), r);
      if (sample === 1) await new Promise(resolve => setTimeout(resolve, 500));
    }
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
      await screenshot('send-empty-selection');
      await placeholder('before-picker');
      openGates.push({ id: 'controlled-no-peer-fixture', verdict: 'inconclusive',
        reason: 'Fresh repeated DevicePlaceholderListTile UI branch is asserted; no frozen network isolation or discovery-completeness oracle establishes that the network has no peers.' });
      page = await observe('send-before-picker', emptySelection);
      await tap('open-files-picker', page, ns => label(ns, '文件'));
      await observePicker();
      await screenshot('files-picker-zero-selection', PICKER);
      const pickerBoundary = await mobileBoundary('picker-cancel');
      const picker = await observePicker();
      const { cancel } = pickerControls(picker);
      const point = center(cancel.bounds);
      await mutate('cancel-files-picker', 'tap', { tapX: Math.round(point.x), tapY: Math.round(point.y), feedback: 'off' }, picker,
        { resourceId: cancel.resourceId, text: cancel.text, physicalBounds: cancel.bounds }, PICKER);
      page = await observe('send-after-picker-cancel', emptySelection);
      await screenshot('send-after-picker-cancel');
      await mobileEvidence('picker-cancel', pickerBoundary, PICKER);
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
      await tap('restore-system-theme', page, ns => label(ns, '跟随系统'));
      page = await observe('settings-restored', ns => settings(ns));
      await screenshot('settings-restored');
      await oracle('settings-restored', BASELINE, page);
      await mobileEvidence('settings-restored', restoredBoundary);
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
      await placeholder('final-send');
      page = await observe('final-send-before-receive', emptySelection);
    }
    const finalBoundary = await mobileBoundary('final-receive');
    page = await observe('before-final-visit-receive', scenario === 'acceptance' ? emptySelection : settingsAtBaseline);
    await tap('final-visit-receive', page, ns => label(ns, '接收', 'NavigationDestination'));
    page = await observe('final-receive', receive);
    await check('Final Receive preserves fixture device name', !!label(page.result.nodes, expectedDeviceName), page);
    await screenshot('final-receive');
    await checkpoint('final-fixture', page, { expectedSettings: BASELINE, settingsScroll: 'top', selectedFiles: 0 });
    await mobileEvidence('final-receive', finalBoundary);
    openGates.push({ id: 'required-mobile-business-evidence', verdict: 'inconclusive',
      reason: 'Recorded fresh action-window events/state/logs are retained. Frozen evidence does not define reliable business event/state/log predicates or demonstrate Rust transport coverage. Capture existence is not a business oracle.' });
    openGates.push({ id: 'final-independent-fixture-equality', verdict: 'inconclusive',
      reason: 'Controller must capture final persisted preferences after execution and compare exactly with its independently verified initial fixture; final checkpoint is not that external observation.' });
    flowCompleted = true;
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    stop = { verdict: error.verdict, reason: error.message };
  }
  const ui = assertions.filter(a => a.name.indexOf('facts recorded in the current action window') === -1);
  const uiVerdict = ui.some(a => a.verdict === 'failed') ? 'failed'
    : stop?.verdict || (flowCompleted && ui.every(a => a.verdict === 'passed') ? 'passed' : 'inconclusive');
  const businessVerdict = uiVerdict === 'failed' || externalOracles.some(o => o.verdict === 'failed') ? 'failed'
    : !flowCompleted || openGates.length || assertions.some(a => a.verdict !== 'passed') ? 'inconclusive' : 'passed';
  const result = { schemaVersion: 'localsend.script-result/v1', scenario, flowCompleted,
    uiVerdict, businessVerdict, assertions, externalOracles, openGates, checkpoints, actions,
    screenshots, mobileCaptures, stableObservations, settingsGeometry: { baseline: geometryBaseline, restored: geometryRestored,
      toleranceLogicalPixels: GEOMETRY_TOLERANCE, comparison: 'strict-less-than' }, lastPage, stop, wallMs: Date.now() - started,
    timingSource: 'Use Host per-run active/provider/business/decision/paused/evidence/wall timings; oracle waits count in wall time.',
    executionStatusMeaning: 'completed only means this function returned; inspect businessVerdict and every assertion.' };
  await ctx.progress({ stage: 'finished', flowCompleted, uiVerdict, businessVerdict, lastPage });
  return result;
}

module.exports = { main };
