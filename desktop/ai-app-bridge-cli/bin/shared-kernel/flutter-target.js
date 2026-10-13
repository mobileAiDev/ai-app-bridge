'use strict';

const { validBounds } = require('./native-target');
const { selectionFailure } = require('./action-guidance');
const flutterCandidates = nodes => nodes.map(node => ({ text: node.text, value: node.value, label: node.label, hint: node.hint, role: node.role,
  ...(node.textTruncated ? { textTruncated: true } : {}), ...(node.valueTruncated ? { valueTruncated: true } : {}),
  enabled: node.enabled, visible: node.visible, bounds: node.tap?.bounds || node.input?.bounds || node.scroll?.bounds,
  selector: { nodeId: String(node.id) } }));

function selectFlutterNode(rawTree, spec) {
  const reject = error => ({ ok: false, error, dispatched: false });
  if (!Array.isArray(rawTree?.nodes) || rawTree.ok === false) return reject('observed_flutter_tree_required');
  const selector = spec.selector || (typeof spec.text === 'string' ? { text: spec.text } : null);
  const keys = Object.keys(selector || {});
  if (!keys.length || keys.some(key => !['text', 'nodeId', 'label', 'hint', 'role', 'widgetType'].includes(key)
    || typeof selector[key] !== 'string' || !selector[key]) || (keys.includes('nodeId') && keys.length !== 1)
    || spec.exact === false || (spec.selector && spec.text != null)) return reject('explicit_exact_flutter_selector_required');
  const action = spec.action === 'inputText' ? 'input' : ['scrollBy', 'scrollUntilText'].includes(spec.action) ? 'scroll' : 'tap';
  const operable = node => node.enabled !== false && node.visible !== false && node.offstage !== true && validBounds(node[action]?.bounds);
  const matches = rawTree.nodes.filter(node => keys[0] === 'nodeId'
    ? node.id != null && String(node.id) === selector.nodeId
    : keys.every(key => key === 'text'
      ? (node.textTruncated !== true && node.text === selector.text || node.valueTruncated !== true && node.value === selector.text)
      : node[`${key}Truncated`] !== true && node[key] === selector[key]) && operable(node));
  if (rawTree.truncated === true && selector?.nodeId === undefined) return incompleteSelection(matches);
  if (matches.length !== 1) return selectionFailure(matches.length ? 'flutter_selector_not_unique' : 'flutter_selector_not_found', flutterCandidates(matches));
  const node = matches[0];
  if (!operable(node)) return reject('flutter_node_not_operable');
  const bounds = node[action].bounds;
  const x = (bounds.left + bounds.right) / 2, y = (bounds.top + bounds.bottom) / 2;
  const viewport = rawTree.viewport;
  if (x < 0 || y < 0 || (Number.isFinite(viewport?.logicalWidth) && x >= viewport.logicalWidth)
    || (Number.isFinite(viewport?.logicalHeight) && y >= viewport.logicalHeight)) return reject('flutter_node_not_operable');
  return { ok: true, node, x, y };
}

function flutterNodeIdentity(node) {
  return Object.fromEntries(['id', 'text', 'value', 'label', 'hint', 'widgetType', 'role', 'targetRef'].map(key => [key, node?.[key] ?? null]));
}

function flutterTargetRequest(node, selector) {
  const ref = node?.targetRef;
  if (!ref || ref.schemaVersion !== 'aab.flutter-target/v1'
    || !['runtimeEpoch', 'elementId', 'guard'].every(key => typeof ref[key] === 'string' && ref[key])) {
    return { ok: false, error: 'flutter_atomic_target_unavailable', dispatched: false, ambiguous: false,
      message: 'Update the Flutter SDK and observe again. This action requires a live Element reference.' };
  }
  return { ok: true, request: { selector, targetRef: ref } };
}

function bindFlutterAction(rawTree, payload) {
  const reject = error => ({ ok: false, error, dispatched: false, ambiguous: false });
  if (rawTree?.ok === false || !Array.isArray(rawTree?.nodes)) return reject('flutter_observation_incomplete');
  let selector = payload.selector;
  if (payload.action === 'tapText') selector = { text: payload.text };
  if (!selector) {
    const action = payload.action === 'inputText' ? 'input' : 'scroll';
    let nodes = rawTree.nodes.filter(node => validBounds(node[action]?.bounds) && node.enabled !== false && node.visible !== false);
    if (action === 'input') {
      if (payload.x !== undefined || payload.y !== undefined) {
        if (!Number.isFinite(payload.x) || !Number.isFinite(payload.y)) return reject('invalid_flutter_coordinates');
        nodes = nodes.filter(node => { const b = node.input.bounds; return payload.x >= b.left && payload.x < b.right && payload.y >= b.top && payload.y < b.bottom; });
      } else {
        const focused = nodes.filter(node => node.input.focused === true);
        if (focused.length) nodes = focused;
      }
    } else nodes = nodes.filter(node => node.role === 'scrollable');
    if (rawTree.truncated === true) return incompleteSelection(nodes);
    if (nodes.length !== 1) return selectionFailure(nodes.length ? 'flutter_selector_not_unique' : 'flutter_selector_not_found', flutterCandidates(nodes));
    selector = { nodeId: String(nodes[0].id) };
  }
  const selected = selectFlutterNode(rawTree, { action: payload.action, selector });
  if (!selected.ok) return selected;
  const guarded = flutterTargetRequest(selected.node, selector);
  if (!guarded.ok) return guarded;
  const { x, y, ...action } = payload;
  if (payload.action === 'tapText') delete action.text;
  return { ok: true, payload: {
    ...action, ...(payload.action === 'tapText' ? { action: 'tapTarget' } : {}), ...guarded.request,
  } };
}

function incompleteSelection(nodes) {
  return { ...selectionFailure('flutter_observation_incomplete', flutterCandidates(nodes)), selectionRequired: nodes.length > 0,
    message: 'Only part of the Flutter tree was observed. Select an available candidate by nodeId; matches outside this portion have not been ruled out.' };
}

module.exports = { selectFlutterNode, flutterNodeIdentity, flutterTargetRequest, bindFlutterAction };
