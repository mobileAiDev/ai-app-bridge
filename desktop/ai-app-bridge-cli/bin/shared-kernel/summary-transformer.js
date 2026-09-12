'use strict';

const { foregroundNativeWindow } = require('./native-target');

const { semanticNode } = require('./semantic-node');
const { parseXmlAttributes } = require('./xml-attributes');
const iosNative = require('./ios-native-target');
const uia = require('./uia-protocol');

const DEFAULT_MAX_BYTES = 64 * 1024;
const HARD_LIMIT_MS = 50;

function summarizeTree({
  provider,
  rawTree,
  rawTreeId,
  screenshotId = null,
  now = Date.now,
  maxBytes = DEFAULT_MAX_BYTES,
  hardLimitMs = HARD_LIMIT_MS,
} = {}) {
  if (!rawTreeId) {
    return { ok: false, error: 'rawTreeId_required' };
  }
  if (!['native', 'uia', 'flutter', 'h5'].includes(provider)) {
    return { ok: false, error: 'invalid_provider' };
  }
  const startedAtMs = now();
  const collected = [];
  let visited = 0;
  let truncated = false;
  let reason = null;
  const page = provider === 'h5' && ([require('./ios-h5-target').schema, require('./android-h5-target').schema].includes(rawTree?.h5TargetSchema)
    || rawTree?.webTargetSchema === require('./web-dom-target').schema)
    ? { ...rawTree.pageRef, title: rawTree.dom.title.slice(0,500), readyState: rawTree.dom.readyState,
      ...(rawTree.dom.viewport === undefined ? {} : { viewport: rawTree.dom.viewport }),
      bodyText: rawTree.dom.bodyText.slice(0, Math.min(12000, Math.floor(maxBytes / 12))),
      bodyTextTruncated: rawTree.dom.bodyTextTruncated || rawTree.dom.bodyText.length > Math.min(12000, Math.floor(maxBytes / 12)) } : undefined;
  const activity = provider === 'native' && typeof rawTree?.activity === 'string' ? rawTree.activity : undefined;
  const uiaSnapshot = provider === 'uia' ? uia.snapshotIdentity(rawTree) : null;

  walkProvider(provider, rawTree, (source, sourceIndex) => {
    visited += 1;
    if (now() - startedAtMs > hardLimitMs) {
      truncated = true;
      reason = 'hard_limit_ms';
      return false;
    }
    const node = toSemanticNode(provider, source, sourceIndex, rawTreeId, screenshotId, uiaSnapshot);
    if (node && keepNode(node)) collected.push(node);
    return true;
  });

  const nodes = fitNodes(collected, {
    provider,
    rawTreeId,
    screenshotId,
    visited,
    truncated,
    reason,
    maxBytes,
    activity,
    page,
    prioritizeVisibleControls: provider === 'native' && rawTree?.nativeTargetSchema === iosNative.schema,
  });
  truncated = truncated || nodes.truncated;
  reason = reason || nodes.reason;

  return {
    ok: true,
    provider,
    rawTreeId,
    screenshotId,
    visited,
    truncated,
    reason,
    ...(activity === undefined ? {} : { activity }),
    ...(page === undefined ? {} : { page }),
    nodes: nodes.nodes,
  };
}

function walkProvider(provider, rawTree, visit) {
  if (provider === 'native') walkNative(rawTree, visit);
  else if (provider === 'uia') walkUia(rawTree, visit);
  else if (provider === 'flutter') walkFlutter(rawTree, visit);
  else walkH5(rawTree, visit);
}

function walkNative(tree, visit) {
  if (tree?.nativeTargetSchema === iosNative.schema) {
    let sourceIndex = 0;
    for (const node of iosNative.nodesOf(tree)) {
      const rect = node.rect;
      const source = { id: node.elementId, elementId: node.elementId, className: node.type, elementType: node.type,
        text: node.value, label: node.label, accessibilityId: node.rawIdentifier,
        enabled: node.isEnabled === '1', visible: node.isVisible === '1',
        editable: ['TextField', 'SecureTextField', 'TextView', 'SearchField'].includes(node.type),
        bounds: rect ? { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height } : null };
      if (visit(source, sourceIndex++) === false) return;
    }
    return;
  }
  const index = { i: 0 };
  if (Array.isArray(tree?.windows) && tree.windows.length) {
    // Match native action selection: the last non-hidden root owns the foreground.
    // An unknown/disabled root still blocks background controls. Do not spend the
    // summary budget on a long background page before exposing its modal dialog.
    const selected = foregroundNativeWindow(tree);
    if (!selected) return;
    const foreground = selected.index;
    // Preserve the sourceIndex ordinal in the original windows' preorder.
    for (let i = 0; i < foreground; i++) walkChildren(tree.windows[i]?.root, () => true, index);
    walkChildren(tree.windows[foreground]?.root, visit, index);
    return;
  }
  if (tree?.root) walkChildren(tree.root, visit, index);
  else if (tree && !tree.windows && !tree.root) walkChildren(tree, visit, index);
}

function walkUia(tree, visit) {
  if (typeof tree === 'string' || typeof tree?.xml === 'string' || typeof tree?.hierarchy === 'string') {
    walkUiaXml(typeof tree === 'string' ? tree : (tree.xml || tree.hierarchy), visit);
    return;
  }
  if (Array.isArray(tree?.nodes)) {
    const index = { i: 0 };
    for (const node of tree.nodes) {
      if (visit(node, index.i++) === false) return;
    }
    return;
  }
  walkNative(tree, visit);
}

function walkUiaXml(xml, visit) {
  const tokenRegex = /<\/node>|<node\b[^>]*\/?>/g;
  let sourceIndex = 0;
  let token;
  while ((token = tokenRegex.exec(String(xml || ''))) !== null) {
    const tag = token[0];
    if (tag.startsWith('</node') || !tag.startsWith('<node')) continue;
    if (visit(parseXmlAttributes(tag), sourceIndex++) === false) return;
  }
}

function walkFlutter(tree, visit) {
  const operable = tree?.operable || tree?.layout?.operable;
  if (Array.isArray(operable?.nodes)) {
    let sourceIndex = 0;
    for (const node of operable.nodes) {
      if (visit(node, sourceIndex++) === false) return;
    }
    return;
  }
  if (Array.isArray(tree?.nodes)) {
    let sourceIndex = 0;
    for (const node of tree.nodes) {
      if (visit(node, sourceIndex++) === false) return;
    }
    return;
  }
  walkChildren(tree?.root || tree, visit, { i: 0 });
}

function walkH5(tree, visit) {
  if ([require('./ios-h5-target').schema, require('./android-h5-target').schema].includes(tree?.h5TargetSchema) || tree?.webTargetSchema === require('./web-dom-target').schema) {
    for (const [index, node] of tree.dom.controls.entries()) {
      if (visit({ ...node, elementType: node.tag, label: node.ariaLabel, enabled: !node.disabled,
        clickable: ['a', 'button'].includes(node.tag)
          || node.tag === 'input' && ['checkbox', 'radio'].includes(node.type)
          || ['checkbox', 'menuitemcheckbox', 'radio', 'menuitemradio', 'switch'].includes(node.role) }, index) === false) return;
    }
    return;
  }
  if (Array.isArray(tree?.nodes)) {
    let sourceIndex = 0;
    for (const node of tree.nodes) {
      if (visit(node, sourceIndex++) === false) return;
    }
    return;
  }
  walkChildren(tree?.documentElement || tree?.root || tree, visit, { i: 0 });
}

function walkChildren(node, visit, index) {
  if (!node || typeof node !== 'object') return true;
  if (visit(node, index.i++) === false) return false;
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (walkChildren(child, visit, index) === false) return false;
  }
  return true;
}

function toSemanticNode(provider, source, sourceIndex, rawTreeId, screenshotId, uiaSnapshot) {
  if (!source || typeof source !== 'object') return null;
  const className = String(source.className || source.class || source.widgetType || source.tag || source.tagName || '');
  const text = firstString(source.text, source.value);
  const label = firstString(
    source.contentDescription,
    source['content-desc'],
    source.label,
    source.accessibilityLabel,
    source['aria-label'],
    source.alt,
  );
  const role = classifyRole(source, className);
  return semanticNode({
    nodeId: nodeIdOf(provider, source, sourceIndex),
    sourceIndex,
    rawTreeId,
    screenshotId,
    targetRef: uiaSnapshot ? uia.nodeTargetRef(uiaSnapshot, source) : undefined,
    role,
    text,
    label,
    ...(provider === 'flutter' ? { hint: source.hint, errorText: source.errorText } : {}),
    bounds: boundsOf(source),
    enabled: source.enabled !== false && source.enabled !== 'false',
    checked: provider === 'uia' && boolOrNull(source.checkable) !== true
      ? null : source.checked === 'mixed' ? 'mixed' : boolOrNull(source.checked),
    selected: boolOrNull(source.selected),
    clickable: Boolean(
      source.clickable === true
      || source.clickable === 'true'
      || (Array.isArray(source.actions) && source.actions.includes('tap')),
    ),
    ...(['native', 'h5'].includes(provider) ? {
      resourceName: source.resourceName,
      editable: source.editable,
      interaction: source.interaction,
      visible: source.visible,
      effectiveVisible: source.effectiveVisible,
      accessibilityId: source.accessibilityId,
      elementId: source.elementId,
      elementType: source.elementType,
    } : {}),
  });
}

function keepNode(node) {
  return Boolean(
    node.text
    || node.label
    || node.accessibilityId
    || node.clickable
    || node.checked !== null
    || node.selected === true
    || node.role === 'button'
    || node.role === 'input'
    || node.role === 'image',
  );
}

function classifyRole(source, className) {
  const lower = className.toLowerCase();
  const role = String(source.role || '').toLowerCase();
  if (['checkbox', 'menuitemcheckbox', 'radio', 'menuitemradio', 'switch'].includes(role)) return role;
  if (lower === 'input' && ['checkbox', 'radio'].includes(source.type)) return source.type;
  if (role === 'textbox' || source.editable === true || /edit|input|textfield|textarea|search/.test(lower)) return 'input';
  if (role === 'button' || /button|btn/.test(lower)) return 'button';
  if (role === 'image' || source.src || /image|img|imageview/.test(lower)) return 'image';
  if (source.clickable === true || source.clickable === 'true' || (Array.isArray(source.actions) && source.actions.includes('tap'))) {
    return 'clickable';
  }
  return 'text';
}

function nodeIdOf(provider, source, sourceIndex) {
  if (source.id != null && source.id !== '') return source.id;
  if (source.nodeId != null && source.nodeId !== '') return source.nodeId;
  if (source.resourceName) return source.resourceName;
  if (source['resource-id']) return source['resource-id'];
  if (source.resourceId) return source.resourceId;
  return `${provider}:${sourceIndex}`;
}

function boundsOf(source) {
  if (source.bounds && typeof source.bounds === 'object') return source.bounds;
  if (typeof source.bounds === 'string') return parseUiaBounds(source.bounds);
  return null;
}

function parseUiaBounds(value) {
  const match = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(String(value || ''));
  if (!match) return null;
  return {
    left: Number(match[1]),
    top: Number(match[2]),
    right: Number(match[3]),
    bottom: Number(match[4]),
  };
}

function firstString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value);
    if (text !== '') return text;
  }
  return null;
}

function boolOrNull(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

function fitNodes(nodes, { provider, rawTreeId, screenshotId, visited, truncated, reason, maxBytes, activity, page, prioritizeVisibleControls }) {
  const meta = { ok: true, provider, rawTreeId, screenshotId, visited, truncated, reason, ...(activity === undefined ? {} : { activity }), ...(page === undefined ? {} : { page }) };
  if (byteSize(nodes, meta) <= maxBytes) {
    return { nodes, truncated, reason };
  }
  // WDA places native toolbars and sheets after potentially long WKWebView text.
  // Reserve their visible controls before spending the budget on article content;
  // retain the original identities, visibility and preorder in the final result.
  const candidates = prioritizeVisibleControls
    ? [...nodes].sort((a, b) => visibleControlPriority(a) - visibleControlPriority(b))
    : nodes;
  let low = 0;
  let high = nodes.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = {
      ...meta,
      truncated: true,
      reason: reason || 'max_bytes',
    };
    if (byteSize(candidates.slice(0, mid), candidate) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  const selected = candidates.slice(0, low);
  if (prioritizeVisibleControls) selected.sort((a, b) => a.sourceIndex - b.sourceIndex);
  return { nodes: selected, truncated: true, reason: reason || 'max_bytes' };
}

function visibleControlPriority(node) {
  if (node.visible !== true) return 2;
  return node.role === 'button' || node.role === 'input' || node.clickable ? 0 : 1;
}

function byteSize(nodes, meta) {
  return Buffer.byteLength(JSON.stringify({ ...meta, nodes }), 'utf8');
}

module.exports = {
  DEFAULT_MAX_BYTES,
  HARD_LIMIT_MS,
  summarizeTree,
};
