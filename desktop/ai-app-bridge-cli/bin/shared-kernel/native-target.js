'use strict';

const { checkExecution } = require('./execution-scope');

// The top non-hidden Android window owns all semantic selection. Unknown or
// disabled foreground roots block controls in earlier windows.

function visible(node) {
  return node && (node.effectiveVisible === true || node.visible === true)
    && node.effectiveVisible !== false && node.visible !== false && node.enabled !== false
    && node.visibility !== 'gone' && node.visibility !== 'invisible' && node.alpha !== 0;
}

function validBounds(bounds) {
  return bounds && ['left', 'top', 'right', 'bottom'].every((key) => Number.isFinite(bounds[key]))
    && bounds.right > bounds.left && bounds.bottom > bounds.top;
}

function foregroundNativeWindow(rawTree) {
  if (!rawTree || typeof rawTree !== 'object') return null;
  const windows = Array.isArray(rawTree.windows) ? rawTree.windows : [];
  if (windows.length) {
    const index = windows.findLastIndex(item => !explicitlyHidden(item?.root));
    if (index < 0) return null;
    const window = windows[index];
    return { index, root: window?.root, type: window?.type, windowId: window?.windowId,
      bounds: window && Object.hasOwn(window, 'bounds') ? window.bounds : window?.root?.bounds };
  }
  return rawTree.root ? { index: null, root: rawTree.root, bounds: rawTree.root.bounds, type: 'activity' } : null;
}

function nativeWindow(rawTree) {
  const window = foregroundNativeWindow(rawTree);
  return window && visible(window.root) && validBounds(window.bounds) ? window : null;
}

function explicitlyHidden(node) {
  return node && (node.effectiveVisible === false || node.visible === false
    || node.visibility === 'gone' || node.visibility === 'invisible' || node.alpha === 0);
}

function selectNativeNode(rawTree, spec, editable) {
  const reject = (error) => ({ ok: false, error, dispatched: false });
  const window = nativeWindow(rawTree);
  if (!window) return reject('visible_observed_window_required');
  const selector = spec.selector || (typeof spec.text === 'string' ? { text: spec.text } : null);
  if (spec.exact === false || (spec.selector && spec.text != null)) return reject('explicit_native_selector_required');
  const keys = Object.keys(selector || {}).filter(key => key !== 'within');
  if (keys.length !== 1 || !['resourceName', 'text', 'contentDescription'].includes(keys[0]) || typeof selector[keys[0]] !== 'string' || !selector[keys[0]]) return reject('explicit_native_selector_required');
  const hasScope = Object.hasOwn(selector, 'within');
  const scope = selector.within;
  let anchorKey;
  let ancestorKey;
  let ancestorParentKey;
  if (hasScope) {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return reject('invalid_native_scope');
    const anchorKeys = Object.keys(scope).filter(key => key !== 'ancestor');
    if (anchorKeys.length !== 1 || !['resourceName', 'text', 'contentDescription'].includes(anchorKeys[0])
      || typeof scope[anchorKeys[0]] !== 'string' || !scope[anchorKeys[0]]) return reject('invalid_native_scope');
    const ancestor = scope.ancestor;
    if (!ancestor || typeof ancestor !== 'object' || Array.isArray(ancestor)) return reject('invalid_native_scope');
    const ancestorKeys = Object.keys(ancestor).filter(key => key !== 'parent');
    if (ancestorKeys.length !== 1 || !['className', 'resourceName'].includes(ancestorKeys[0])
      || typeof ancestor[ancestorKeys[0]] !== 'string' || !ancestor[ancestorKeys[0]]) return reject('invalid_native_scope');
    if (Object.hasOwn(ancestor, 'parent')) {
      const parent = ancestor.parent;
      if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return reject('invalid_native_scope');
      const parentKeys = Object.keys(parent);
      if (parentKeys.length !== 1 || !['className', 'resourceName'].includes(parentKeys[0])
        || typeof parent[parentKeys[0]] !== 'string' || !parent[parentKeys[0]]) return reject('invalid_native_scope');
      [ancestorParentKey] = parentKeys;
    }
    [anchorKey] = anchorKeys;
    [ancestorKey] = ancestorKeys;
  }
  const eligible = [];
  const visit = (node, ancestors = []) => {
    if (!visible(node)) return;
    const bounds = node.bounds;
    if (validBounds(bounds)) {
      const x = Math.round((bounds.left + bounds.right) / 2);
      const y = Math.round((bounds.top + bounds.bottom) / 2);
      const inViewport = x >= window.bounds.left && x < window.bounds.right && y >= window.bounds.top && y < window.bounds.bottom;
      // effectiveVisible does not prove the chosen center survives RecyclerView clipping.
      // Without clipChildren/clipToPadding geometry, conservatively require every ancestor.
      const inAncestors = ancestors.every(ancestor => validBounds(ancestor.bounds) && pointInsideBounds({ x, y }, ancestor.bounds));
      if (inViewport && inAncestors) eligible.push({ node, x, y, ancestors });
    }
    for (const child of node.children || []) visit(child, [...ancestors, node]);
  };
  visit(window.root);
  let scopeRoot;
  if (hasScope) {
    const anchors = eligible.filter(item => item.node[anchorKey] === scope[anchorKey]);
    if (anchors.length !== 1) return reject(anchors.length ? 'native_scope_anchor_ambiguous' : 'native_scope_anchor_not_found');
    const anchor = anchors[0];
    const ancestors = anchor.ancestors.filter((node, index) => visible(node) && validBounds(node.bounds)
      && node[ancestorKey] === scope.ancestor[ancestorKey]
      && (!ancestorParentKey || anchor.ancestors[index - 1]?.[ancestorParentKey] === scope.ancestor.parent[ancestorParentKey]));
    // A named row type/resource must resolve once. Never choose a nearest arbitrary ancestor.
    if (ancestors.length !== 1) return reject(ancestors.length ? 'native_scope_ancestor_ambiguous' : 'native_scope_ancestor_not_found');
    [scopeRoot] = ancestors;
    if (!pointInsideBounds(anchor, scopeRoot.bounds)) return reject('native_scope_anchor_out_of_bounds');
  }
  const matches = eligible.filter(item => item.node[keys[0]] === selector[keys[0]]
    && (!scopeRoot || ((item.node === scopeRoot || item.ancestors.includes(scopeRoot)) && pointInsideBounds(item, scopeRoot.bounds))));
  if (matches.length !== 1) return reject(matches.length ? 'native_selector_ambiguous' : 'native_selector_not_found');
  const selected = matches[0];
  if (editable && selected.node.editable !== true) return reject('native_target_not_editable');
  return { ok: true, ...selected, windowBounds: window.bounds, window };
}

function nativeNodeIdentity(node) {
  return Object.fromEntries(['className', 'resourceName', 'id', 'text', 'contentDescription', 'editable', 'targetRef']
    .map(key => [key, node?.[key] ?? null]));
}

function nativeWindowIdentity(window) {
  return { type: window?.type ?? null, index: window?.index ?? null, windowId: window?.windowId ?? null, root: nativeNodeIdentity(window?.root) };
}

function nativeTargetRequest(node, selector) {
  const ref = node?.targetRef;
  const reject = error => ({ ok: false, error, dispatched: false, ambiguous: false,
    message: 'Native semantic actions require a current SDK target reference. Update the app SDK and observe again.' });
  if (!ref || ref.schemaVersion !== 'aab.native-target/v1') return reject('native_atomic_target_unavailable');
  const fields = ['schemaVersion', 'runtimeEpoch', 'windowId', 'viewId', 'guard'];
  if (Object.keys(ref).length !== fields.length || fields.some(key => typeof ref[key] !== 'string' || !ref[key])
    || !/^[a-f0-9]{64}$/.test(ref.guard)) return reject('invalid_native_target_reference');
  return { ok: true, request: { selector: structuredClone(selector), targetRef: { ...ref } } };
}

function nativeSelectionIdentity(selection) {
  return { window: nativeWindowIdentity(selection.window), node: nativeNodeIdentity(selection.node),
    ancestors: selection.ancestors.map(nativeNodeIdentity) };
}

async function revalidateNativeNode(readTree, rawTree, spec, editable = false) {
  const observed = selectNativeNode(rawTree, spec, editable);
  if (!observed.ok) return observed;
  checkExecution();
  const current = selectNativeNode(await readTree(), spec, editable);
  checkExecution();
  if (!current.ok) return current;
  if (JSON.stringify(nativeSelectionIdentity(observed)) !== JSON.stringify(nativeSelectionIdentity(current))) {
    return { ok: false, error: 'reobserve_required', dispatched: false };
  }
  return current;
}

function pointInsideBounds(point, bounds) {
  return point.x >= bounds.left && point.x < bounds.right && point.y >= bounds.top && point.y < bounds.bottom;
}

module.exports = { foregroundNativeWindow, nativeWindow, visible, explicitlyHidden, validBounds, selectNativeNode,
  pointInsideBounds, nativeNodeIdentity, nativeWindowIdentity, revalidateNativeNode, nativeTargetRequest };
