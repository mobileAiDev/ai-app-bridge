'use strict';

const { validBounds } = require('./native-target');

function selectFlutterNode(rawTree, spec) {
  const reject = error => ({ ok: false, error, dispatched: false });
  if (!Array.isArray(rawTree?.nodes) || rawTree.ok === false) return reject('observed_flutter_tree_required');
  if (rawTree.truncated === true) return reject('flutter_observation_incomplete');
  const selector = spec.selector || (typeof spec.text === 'string' ? { text: spec.text } : null);
  const keys = Object.keys(selector || {});
  if (keys.length !== 1 || !['text', 'nodeId'].includes(keys[0])
    || typeof selector[keys[0]] !== 'string' || !selector[keys[0]]
    || spec.exact === false || (spec.selector && spec.text != null)) return reject('explicit_exact_flutter_selector_required');
  const action = spec.action === 'inputText' ? 'input' : ['scrollBy', 'scrollUntilText'].includes(spec.action) ? 'scroll' : 'tap';
  const operable = node => node.enabled !== false && node.visible !== false && node.offstage !== true && validBounds(node[action]?.bounds);
  const matches = rawTree.nodes.filter(node => keys[0] === 'nodeId'
    ? node.id != null && String(node.id) === selector.nodeId
    : (node.text === selector.text || node.value === selector.text) && operable(node));
  if (matches.length !== 1) return reject(matches.length ? 'flutter_selector_not_unique' : 'flutter_selector_not_found');
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
  if (rawTree?.ok === false || !Array.isArray(rawTree?.nodes) || rawTree.truncated === true) return reject('flutter_observation_incomplete');
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
    if (nodes.length !== 1) return reject(nodes.length ? 'flutter_selector_not_unique' : 'flutter_selector_not_found');
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

module.exports = { selectFlutterNode, flutterNodeIdentity, flutterTargetRequest, bindFlutterAction };
