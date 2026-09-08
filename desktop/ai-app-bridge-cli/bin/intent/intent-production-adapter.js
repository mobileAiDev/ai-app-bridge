'use strict';

const { androidAppTargetKey, getProcessTargetLease } = require('../shared-kernel/target-lease-protocol');
const { parseXmlAttributes } = require('../shared-kernel/xml-attributes');

function createProductionIntentDeviceAdapter({
  lease = getProcessTargetLease(),
  ports = null,
  adb = process.env.ADB || 'adb',
} = {}) {
  const impl = ports || require('../ai-app-bridge');
  let currentActive = 0;
  let maxActive = 0;
  const calls = [];

  async function withDevice(serial, packageName, name, fn) {
    const waitStarted = Date.now();
    const held = lease.acquire(androidAppTargetKey(serial, packageName));
    if (!held.ok) {
      return {
        ...held,
        serial,
        packageName,
        targetLeaseWaitMs: Date.now() - waitStarted,
      };
    }
    currentActive += 1;
    maxActive = Math.max(maxActive, currentActive);
    calls.push({ name, serial, packageName, atMs: Date.now() });
    try {
      const result = await fn();
      return {
        ...result,
        adbTimings: [],
        targetLeaseWaitMs: Date.now() - waitStarted,
      };
    } finally {
      currentActive -= 1;
      held.release();
    }
  }

  function context(target) {
    return impl.createBridgeContext({
      serial: target.serial,
      packageName: target.packageName,
      port: target.port,
      adb: target.adb || adb,
    });
  }

  async function foregroundRoute(ctx, provider, foregroundPackages) {
    if (!Array.isArray(foregroundPackages) || foregroundPackages.some(value => typeof value !== 'string'
      || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(value))) throw new Error('invalid_foreground_packages');
    if (!['native', 'uia', 'flutter'].includes(provider)) throw new Error('unsupported_provider');
    const foreground = await impl.foregroundWindow(ctx);
    if (!foreground?.ok) throw new Error(foreground?.error || 'foreground_probe_failed');
    if (!foreground.packageName || !foreground.component || !foreground.activity) throw new Error('foreground_identity_required');
    if (foreground.packageName !== ctx.packageName && !foregroundPackages.includes(foreground.packageName)) throw new Error('foreground_package_not_allowed');
    return { provider: foreground.packageName === ctx.packageName ? provider : 'uia', packageName: foreground.packageName,
      activity: foreground.activity, component: foreground.component, source: foreground.source, observedAtMs: Date.now() };
  }

  return {
    calls,
    adbTimings: [],
    get maxActive() { return maxActive; },
    get callCount() { return calls.length; },
    async observe({ serial, packageName, provider, rawTreeId, port, adb: targetAdb, foregroundPackages }) {
      return withDevice(serial, packageName, `observe:${provider}`, async () => {
        const ctx = context({ serial, packageName, port, adb: targetAdb });
        try {
          const route = foregroundPackages === undefined ? null : await foregroundRoute(ctx, provider, foregroundPackages);
          const activeProvider = route ? route.provider : provider;
          const activeContext = route ? context({ serial, packageName: route.packageName, port, adb: targetAdb }) : ctx;
          let rawTree;
          if (activeProvider === 'uia') rawTree = await impl.uiaTreeOnce(activeContext);
          else if (activeProvider === 'flutter') rawTree = await impl.flutterNodes(activeContext);
          else rawTree = await impl.bridgeTree(activeContext);
          if (route) {
            const after = await foregroundRoute(ctx, provider, foregroundPackages);
            if (after.component !== route.component || after.provider !== route.provider) throw new Error('foreground_changed_during_observation');
            if (activeProvider === 'uia') {
              const root = typeof rawTree === 'string' && rawTree.match(/<node\b[^>]*>/);
              if (!root || parseXmlAttributes(root[0]).package !== route.packageName) throw new Error('observed_foreground_package_mismatch');
            }
            route.verifiedAtMs = after.observedAtMs;
          }
          return {
            ok: true,
            provider: activeProvider,
            rawTreeId,
            rawTree,
            foregroundTarget: route ? route.packageName : packageName,
            ...(route ? { route } : {}),
          };
        } catch (error) {
          return { ok: false, error: error.message || String(error) };
        }
      });
    },
    async action({ serial, spec, packageName, port, adb: targetAdb, rawTree, actionId, foregroundPackages, route, primaryProvider }) {
      const targetPackageName = packageName || spec.packageName;
      return withDevice(serial, targetPackageName, 'action', async () => {
        let ctx = context({ serial, packageName: targetPackageName, port, adb: targetAdb });
        // Foreground routing is explicit. Never reinterpret a prior tree after a
        // package/activity change, and never send an SDK action to a system app.
        if (foregroundPackages !== undefined) {
          try {
            if (!route) return shapeAction({ ok: false, error: 'observed_foreground_required', dispatched: false });
            if (spec.provider !== route.provider) return shapeAction({ ok: false, error: 'observation_provider_mismatch', dispatched: false });
            const current = await foregroundRoute(ctx, primaryProvider, foregroundPackages);
            if (current.component !== route.component || current.provider !== route.provider) return shapeAction({ ok: false, error: 'reobserve_required', dispatched: false });
            ctx = context({ serial, packageName: route.packageName, port, adb: targetAdb });
          } catch (error) {
            return shapeAction({ ok: false, error: error.message, dispatched: false });
          }
        }
        try {
          if (!['native', 'uia', 'flutter'].includes(spec.provider)) return shapeAction({ ok: false, error: 'unsupported_provider', dispatched: false });
          if (!['tap', 'inputText', 'back', 'keyevent', 'scroll', 'scrollBy', 'swipe', 'longPress'].includes(spec.action)) {
            return shapeAction({ ok: false, error: 'unsupported_action', dispatched: false });
          }
          if (spec.action === 'back' && spec.provider === 'flutter') {
            const result = await impl.flutterAction(ctx, { action: 'back', actionId });
            if (result?.handled === false) {
              return {
                ok: false,
                mechanicalStatus: 'failed',
                providerResult: result,
                ambiguous: false,
                error: 'back_not_handled',
              };
            }
            return shapeAction(result);
          }
          if (spec.action === 'back' || spec.action === 'keyevent') {
            return shapeAction(await impl.keyevent(ctx, spec.keyCode != null ? spec.keyCode : 4));
          }
          if (spec.action === 'longPress') {
            if (spec.provider !== 'native') return shapeAction({ ok: false, error: 'long_press_provider_unsupported', dispatched: false });
            return shapeAction(await longPressFromNativeObservedTree(impl, ctx, spec, rawTree));
          }
          if (spec.action === 'swipe') {
            if (spec.provider !== 'native') return shapeAction({ ok: false, error: 'swipe_provider_unsupported', dispatched: false });
            return shapeAction(await swipeFromNativeObservedTree(impl, ctx, spec, rawTree));
          }
          if (spec.action === 'scroll' || spec.action === 'scrollBy') {
            if (spec.provider === 'flutter') {
              return shapeAction(await impl.flutterAction(ctx, {
                action: 'scrollBy',
                actionId,
                delta: spec.delta != null ? spec.delta : 420,
              }));
            }
            return shapeAction(await scrollHost(impl, ctx, spec, rawTree));
          }
          if (spec.action === 'inputText') {
            if (spec.provider !== 'native') return shapeAction({ ok: false, error: 'inputText_provider_unsupported', dispatched: false });
            return shapeAction(await inputFromNativeObservedTree(impl, ctx, spec, rawTree, actionId));
          }
          if (spec.provider === 'flutter' && spec.action === 'tap') {
            return shapeAction(await tapFromFlutterObservedTree(impl, ctx, spec, rawTree, actionId));
          }
          if (spec.provider === 'uia' && spec.action === 'tap' && (spec.selector || route)) {
            return shapeAction(await tapUniqueUiaNode(impl, ctx, spec, rawTree));
          }
          if (spec.provider === 'uia' && spec.action === 'tap' && spec.text) {
            return shapeAction(await tapFromUiaObservedTree(impl, ctx, spec, rawTree));
          }
          if (spec.provider === 'native') return shapeAction(await tapFromNativeObservedTree(impl, ctx, spec, rawTree, actionId));
          return shapeAction({ ok: false, error: 'unsupported_action_selector', dispatched: false });
        } catch (error) {
          return {
            ok: false,
            mechanicalStatus: 'failed',
            providerResult: null,
            ambiguous: true,
            error: error.message || String(error),
          };
        }
      });
    },
    async launch({ serial, packageName, kind, port, adb: targetAdb }) {
      return withDevice(serial, packageName, `launch:${kind || 'app'}`, async () => {
        const ctx = context({ serial, packageName, port, adb: targetAdb });
        if (kind === 'flutter') return impl.launchFlutter(ctx, '');
        if (kind === 'native-test') return impl.launchNativeTest(ctx);
        return impl.launchApp(ctx);
      });
    },
  };
}

async function tapUniqueUiaNode(impl, ctx, spec, rawTree) {
  const reject = error => ({ ok: false, error, dispatched: false });
  if (typeof rawTree !== 'string') return reject('observed_uia_xml_required');
  const selector = spec.selector || (typeof spec.text === 'string' ? { text: spec.text } : null);
  const keys = Object.keys(selector || {});
  const attribute = { text: 'text', contentDescription: 'content-desc', resourceName: 'resource-id' }[keys[0]];
  if (keys.length !== 1 || !attribute || typeof selector[keys[0]] !== 'string' || !selector[keys[0]] || spec.exact === false) return reject('explicit_exact_uia_selector_required');
  const nodes = [...rawTree.matchAll(/<node\b[^>]*>/g)].map(match => parseXmlAttributes(match[0]));
  const selected = nodes.filter(node => node.package === ctx.packageName && node[attribute] === selector[keys[0]]);
  if (selected.length !== 1) return reject(selected.length ? 'uia_selector_not_unique' : 'uia_selector_not_found');
  const node = selected[0];
  const bounds = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(node.bounds || '');
  if (!bounds || node.enabled !== 'true' || (spec.requireClickable === true && node.clickable !== 'true')) return reject('uia_node_not_operable');
  const [left, top, right, bottom] = bounds.slice(1).map(Number);
  if (left < 0 || top < 0 || right <= left || bottom <= top) return reject('uia_node_not_operable');
  return impl.tap(ctx, Math.round((left + right) / 2), Math.round((top + bottom) / 2));
}

async function tapFromUiaObservedTree(impl, ctx, spec, rawTree) {
  if (!rawTree) return { ok: false, error: 'observed_tree_required' };
  const node = impl.findUiaNodeByAny(rawTree, {
    texts: [spec.text],
    exact: spec.exact === true,
    requireClickable: spec.requireClickable === true,
  });
  if (!node) return { ok: false, error: 'text_not_found' };
  const x = Math.round((node.left + node.right) / 2);
  const y = Math.round((node.top + node.bottom) / 2);
  return impl.tap(ctx, x, y);
}

async function tapFromNativeObservedTree(impl, ctx, spec, rawTree, actionId) {
  const selected = selectNativeNode(rawTree, spec, false);
  if (!selected.ok) return selected;
  const { x, y } = selected;
  return impl.tap(ctx, x, y, { feedback: 'off', appLocalAction: true, runtimeActionId: actionId, requestId: actionId });
}

async function inputFromNativeObservedTree(impl, ctx, spec, rawTree, actionId) {
  if (typeof spec.value !== 'string') return { ok: false, error: 'input_value_required', dispatched: false };
  const selected = selectNativeNode(rawTree, spec, true);
  if (!selected.ok) return selected;
  if (typeof impl.inputText !== 'function') return { ok: false, error: 'inputText_port_unavailable', dispatched: false };
  return impl.inputText(ctx, spec.value, { tapX: selected.x, tapY: selected.y,
    feedback: 'off', appLocalAction: true, runtimeActionId: actionId, requestId: actionId });
}

async function swipeFromNativeObservedTree(impl, ctx, spec, rawTree) {
  const reject = (error) => ({ ok: false, error, dispatched: false });
  if (!Number.isFinite(spec.deltaX) || !Number.isFinite(spec.deltaY)) return reject('invalid_swipe_delta');
  if (!Number.isSafeInteger(spec.durationMs) || spec.durationMs <= 0) return reject('invalid_swipe_duration');
  if (!spec.selector) return reject('explicit_native_selector_required');
  const selected = selectNativeNode(rawTree, spec, false);
  if (!selected.ok) return selected;
  const { x, y, windowBounds } = selected;
  const endX = Math.round(x + spec.deltaX);
  const endY = Math.round(y + spec.deltaY);
  if (endX === x && endY === y) return reject('swipe_delta_zero');
  if (!Number.isFinite(endX) || !Number.isFinite(endY)
    || endX < windowBounds.left || endX >= windowBounds.right
    || endY < windowBounds.top || endY >= windowBounds.bottom) return reject('swipe_endpoint_out_of_bounds');
  if (typeof impl.swipe !== 'function') return reject('swipe_port_unavailable');
  // The existing swipe port is ADB mechanical input and has no runtime actionId parameter.
  return impl.swipe(ctx, x, y, endX, endY, spec.durationMs);
}

async function longPressFromNativeObservedTree(impl, ctx, spec, rawTree) {
  const reject = (error) => ({ ok: false, error, dispatched: false });
  if (!Number.isSafeInteger(spec.durationMs) || spec.durationMs < 500 || spec.durationMs > 10000) return reject('invalid_long_press_duration');
  if (!spec.selector) return reject('explicit_native_selector_required');
  const selected = selectNativeNode(rawTree, spec, false);
  if (!selected.ok) return selected;
  if (typeof impl.longPress !== 'function') return reject('long_press_port_unavailable');
  // ADB holds the observed point. The Host receipt ID is not a transported SDK causal ID.
  return impl.longPress(ctx, selected.x, selected.y, spec.durationMs);
}

function visible(node) {
  return node && (node.effectiveVisible === true || node.visible === true)
    && node.effectiveVisible !== false && node.visible !== false && node.enabled !== false
    && node.visibility !== 'gone' && node.visibility !== 'invisible' && node.alpha !== 0;
}

function validBounds(bounds) {
  return bounds && ['left', 'top', 'right', 'bottom'].every((key) => Number.isFinite(bounds[key]))
    && bounds.right > bounds.left && bounds.bottom > bounds.top;
}

function nativeWindow(rawTree) {
  if (!rawTree || typeof rawTree !== 'object') return null;
  const windows = Array.isArray(rawTree.windows) ? rawTree.windows : [];
  // Android lists roots from back to front. A foreground dialog blocks activity controls.
  const window = windows.slice().reverse().find((item) => !explicitlyHidden(item?.root));
  if (window && visible(window.root) && validBounds(window.bounds || window.root?.bounds)) {
    return { root: window.root, bounds: window.bounds || window.root.bounds };
  }
  if (windows.length) return null;
  return visible(rawTree.root) && validBounds(rawTree.root.bounds) ? { root: rawTree.root, bounds: rawTree.root.bounds } : null;
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
  if (editable) {
    const editability = selected.node.editable;
    const legacyStandardEditText = editability == null && /^(android\.widget\.)?EditText$/.test(selected.node.className || '');
    if (editability !== true && !legacyStandardEditText) return reject('native_target_not_editable');
  }
  return { ok: true, ...selected, windowBounds: window.bounds };
}

function pointInsideBounds(point, bounds) {
  return point.x >= bounds.left && point.x < bounds.right && point.y >= bounds.top && point.y < bounds.bottom;
}

async function scrollHost(impl, ctx, spec, rawTree) {
  if (!rawTree) return { ok: false, error: 'observed_tree_required', dispatched: false };
  const viewport = spec.provider === 'native' ? nativeWindow(rawTree)?.bounds : impl.parseUiaViewport(rawTree);
  if (!viewport || !viewport.width || !viewport.height) {
    if (!validBounds(viewport)) return { ok: false, error: 'viewport_unavailable', dispatched: false };
  }
  const width = viewport.width || viewport.right - viewport.left;
  const height = viewport.height || viewport.bottom - viewport.top;
  if (spec.direction != null && !['up', 'down'].includes(spec.direction)) return { ok: false, error: 'unsupported_scroll_direction', dispatched: false };
  const startX = Math.round(viewport.left + width / 2);
  const startY = Math.round(viewport.top + height * (spec.direction === 'up' ? 0.22 : 0.76));
  const endY = Math.round(viewport.top + height * (spec.direction === 'up' ? 0.76 : 0.22));
  return impl.swipe(ctx, startX, startY, startX, endY, spec.durationMs != null ? spec.durationMs : 400);
}

async function tapFromFlutterObservedTree(impl, ctx, spec, rawTree, actionId) {
  const reject = error => ({ ok: false, error, dispatched: false });
  if (!Array.isArray(rawTree?.nodes)) return reject('observed_tree_required');
  const selector = spec.selector || (typeof spec.text === 'string' ? { text: spec.text } : null);
  const keys = Object.keys(selector || {});
  if (keys.length !== 1 || !['text', 'nodeId'].includes(keys[0])
    || typeof selector[keys[0]] !== 'string' || !selector[keys[0]]
    || spec.exact === false || (spec.selector && spec.text != null)) return reject('explicit_exact_flutter_selector_required');
  const selected = rawTree.nodes.filter(node => keys[0] === 'nodeId'
    ? node.id != null && String(node.id) === selector.nodeId
    : node.text === selector.text && node.tap?.bounds);
  if (selected.length !== 1) return reject(selected.length ? 'flutter_selector_not_unique' : 'flutter_selector_not_found');
  const bounds = selected[0].tap?.bounds;
  if (!validBounds(bounds)) return reject('flutter_node_not_operable');
  const x = (bounds.left + bounds.right) / 2;
  const y = (bounds.top + bounds.bottom) / 2;
  return impl.flutterAction(ctx, { action: 'tapAt', x, y, actionId });
}

function shapeAction(result) {
  if (!result || typeof result.ok !== 'boolean') return {
    ok: false, mechanicalStatus: 'failed', providerResult: result ?? null,
    ambiguous: true, error: 'invalid_action_receipt',
  };
  return {
    ok: result.ok,
    mechanicalStatus: result.ok ? 'ok' : 'failed',
    providerResult: result,
    ambiguous: result.ambiguous === true,
    dispatched: result.dispatched !== false,
    error: result?.error || null,
  };
}

module.exports = {
  createProductionIntentDeviceAdapter,
};
