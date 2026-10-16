'use strict';

const { validateValue } = require('./argument-schema');
const query = require('./android-node-query');
const selectorSchema = query.selectorSchema({ viewId: { type: 'string', minLength: 1 }, editable: { type: 'boolean' } });
const matches = (node, selector) => query.matches(node, selector, (node, key) => key === 'viewId' ? node.targetRef?.viewId : node[key]);
const { selectionFailure } = require('./action-guidance');

const nativeCandidates = nodes => nodes.map(node => ({ text: node.text, contentDescription: node.contentDescription,
  resourceName: node.resourceName, className: node.className, bounds: node.bounds, clickable: node.clickable, enabled: node.enabled,
  ...(node.targetRef?.viewId ? { selector: { viewId: node.targetRef.viewId },
    action: { command: 'tap-native', arguments: { selector: { viewId: node.targetRef.viewId } } } } : {}) }));

// The SDK owns Android window topology and publishes its foreground decision.
// Explicit references bind their original window regardless of focus.

function visible(node) {
  return node && (node.effectiveVisible === true || node.visible === true)
    && node.effectiveVisible !== false && node.visible !== false
    && node.visibility !== 'gone' && node.visibility !== 'invisible' && node.alpha !== 0;
}

function validBounds(bounds) {
  return bounds && ['left', 'top', 'right', 'bottom'].every((key) => Number.isFinite(bounds[key]))
    && bounds.right > bounds.left && bounds.bottom > bounds.top;
}

function foregroundNativeWindow(rawTree, selectedWindowId) {
  if (!rawTree || typeof rawTree !== 'object') return null;
  const windows = Array.isArray(rawTree.windows) ? rawTree.windows : [];
  if (windows.length) {
    const id = selectedWindowId ?? rawTree.foregroundWindowId;
    if (typeof id !== 'string' || !id.trim()) return null;
    const matches = windows.map((window, index) => window?.windowId === id ? index : -1).filter(index => index >= 0);
    if (matches.length !== 1) return null;
    const [index] = matches;
    const window = windows[index];
    if (explicitlyHidden(window?.root)) return null;
    return { index, root: window?.root, type: window?.type, windowId: window?.windowId,
      bounds: window && Object.hasOwn(window, 'bounds') ? window.bounds : window?.root?.bounds };
  }
  return rawTree.root ? { index: null, root: rawTree.root, bounds: rawTree.root.bounds, type: 'activity' } : null;
}

function nativeWindow(rawTree, selectedWindowId) {
  const window = foregroundNativeWindow(rawTree, selectedWindowId);
  return window && visible(window.root) && validBounds(window.bounds) ? window : null;
}

function explicitlyHidden(node) {
  return node && (node.effectiveVisible === false || node.visible === false
    || node.visibility === 'gone' || node.visibility === 'invisible' || node.alpha === 0);
}

function selectNativeNode(rawTree, spec, editable, selectedWindowId) {
  const reject = (error) => ({ ok: false, error, dispatched: false });
  if (spec.selector?.viewId && !selectedWindowId) {
    const contains = node => node?.targetRef?.viewId === spec.selector.viewId || node?.children?.some(contains);
    const windows = (rawTree?.windows || []).filter(window => contains(window.root));
    if (windows.length === 1) selectedWindowId = windows[0].windowId;
  }
  if (!selectedWindowId && rawTree?.windows?.length && (typeof rawTree.foregroundWindowId !== 'string' || !rawTree.foregroundWindowId.trim())) {
    return reject('native_window_metadata_unavailable');
  }
  const window = nativeWindow(rawTree, selectedWindowId);
  if (!window) return reject('visible_observed_window_required');
  const selector = spec.selector || (typeof spec.text === 'string' ? { text: spec.text } : null);
  if (spec.exact === false || (spec.selector && spec.text != null)) return reject('explicit_native_selector_required');
  try { validateValue(selector, selectorSchema, 'selector'); }
  catch (error) {
    return { ...reject(error.field?.startsWith('selector.within') ? 'invalid_native_scope' : 'explicit_native_selector_required'),
      message: error.message, field: error.field };
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
  let roots;
  if (selector.within) {
    const scope = query.scopeRoots(eligible, selector.within, matches);
    if (scope.error) return reject(`native_${scope.error}`);
    roots = scope.roots;
  }
  const selectedMatches = eligible.filter(item => matches(item.node, selector)
    && (!roots || roots.some(root => item.node === root || item.ancestors.includes(root))));
  if (selectedMatches.length !== 1) return selectionFailure(selectedMatches.length ? 'native_selector_ambiguous' : 'native_selector_not_found', nativeCandidates(selectedMatches.map(item => item.node)));
  const selected = selectedMatches[0];
  if (selected.node.enabled === false) return reject('native_target_disabled');
  if (editable && selected.node.editable !== true) return reject('native_target_not_editable');
  return { ok: true, ...selected, windowBounds: window.bounds, window };
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

function pointInsideBounds(point, bounds) {
  return point.x >= bounds.left && point.x < bounds.right && point.y >= bounds.top && point.y < bounds.bottom;
}

module.exports = { foregroundNativeWindow, nativeWindow, visible, explicitlyHidden, validBounds, selectNativeNode,
  pointInsideBounds, nativeTargetRequest, nativeCandidates, selectorSchema };
