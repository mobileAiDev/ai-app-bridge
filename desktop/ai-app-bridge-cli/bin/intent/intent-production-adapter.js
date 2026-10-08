'use strict';

const h5Target = require('../shared-kernel/android-h5-target');
const { isDeepStrictEqual } = require('node:util');
const { androidAppTargetKey, getProcessTargetLease } = require('../shared-kernel/target-lease-protocol');
const { validBounds, revalidateNativeNode, nativeTargetRequest } = require('../shared-kernel/native-target');
const { selectFlutterNode, flutterNodeIdentity, flutterTargetRequest } = require('../shared-kernel/flutter-target');
const { selectUiaNode } = require('../shared-kernel/uia-target');
const { observedTarget: observedUiaTarget } = require('../shared-kernel/uia-protocol');
const { checkExecution } = require('../shared-kernel/execution-scope');
const { readForegroundFeedback, withForeground } = require('../shared-kernel/android-foreground-feedback');

function createProductionIntentDeviceAdapter({
  lease = getProcessTargetLease(),
  ports = null,
  adb = process.env.ADB || 'adb',
} = {}) {
  const impl = ports || require('../device-provider');
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
      runtimeActionId: target.runtimeActionId,
    });
  }


  return {
    calls,
    adbTimings: [],
    get maxActive() { return maxActive; },
    get callCount() { return calls.length; },
    async observe({ serial, packageName, provider, rawTreeId, port, adb: targetAdb, foregroundPackages, observationTarget }) {
      return withDevice(serial, packageName, `observe:${provider}`, async () => {
        const selectedPackage = observationTarget?.packageName ?? packageName;
        const ctx = context({ serial, packageName: selectedPackage, port, adb: targetAdb });
        const feedback = await readForegroundFeedback(ctx, impl.foregroundWindow);
        try {
          let rawTree;
          if (provider === 'uia') rawTree = await impl.uiaTreeOnce(ctx);
          else if (provider === 'flutter') rawTree = await impl.flutterNodes(ctx);
          else if (provider === 'h5') rawTree = await impl.h5Dom(ctx, observationTarget?.webViewId === undefined ? {} : { webViewId: observationTarget.webViewId });
          else rawTree = await impl.bridgeTree(ctx);
          if (rawTree?.ok === false) return withForeground(rawTree, feedback);
          const after = await readForegroundFeedback(ctx, impl.foregroundWindow, feedback.foregroundObservations[0]);
          return withForeground({ ok: true, provider, rawTreeId, rawTree,
            foregroundTarget: after.foregroundObservations[0].actual?.packageName ?? null,
            route: { provider, targetPackageName: selectedPackage,
              foreground: after.foregroundObservations[0].actual,
              observation: after.foregroundObservations[0] },
          }, feedback, after);
        } catch (error) {
          return withForeground({ ok: false, error: error.code || error.message || String(error) }, feedback);
        }
      });
    },
    async action({ serial, spec, packageName, port, adb: targetAdb, rawTree, actionId, foregroundPackages, route, primaryProvider }) {
      const targetPackageName = packageName || spec.packageName;
      return withDevice(serial, targetPackageName, 'action', async () => {
        const ctx = context({ serial, packageName: route?.targetPackageName ?? targetPackageName, port, adb: targetAdb, runtimeActionId: actionId });
        let dispatchAttempted = false;
        const feedback = await readForegroundFeedback(ctx, impl.foregroundWindow, route?.observation);
        const finish = result => withForeground(shapeAction(result), feedback);
        if (route && spec.provider !== route.provider) return finish({ ok: false, error: 'observation_provider_mismatch', dispatched: false });
        const actionPorts = { ...impl };
        for (const name of ['tap', 'uiaTap', 'inputText', 'nativeGesture', 'swipe', 'keyevent', 'flutterAction', 'h5Control']) {
          if (typeof impl[name] !== 'function') continue;
          actionPorts[name] = async (...args) => {
            checkExecution();
            const current = await readForegroundFeedback(ctx, impl.foregroundWindow, feedback.foregroundObservations.at(-1));
            feedback.foregroundObservations.push(...current.foregroundObservations);
            feedback.warnings.push(...current.warnings);
            checkExecution();
            dispatchAttempted = true;
            return impl[name](...args);
          };
        }
        try {
          if (!['native', 'uia', 'flutter', 'h5'].includes(spec.provider)) return finish({ ok: false, error: 'unsupported_provider', dispatched: false });
          if (!['tap', 'inputText', 'back', 'keyevent', 'scroll', 'scrollBy', 'swipe', 'longPress', 'hideKeyboard'].includes(spec.action)) {
            return finish({ ok: false, error: 'unsupported_action', dispatched: false });
          }
          if (spec.provider === 'h5') {
            const action = { tap: 'click', inputText: 'input', scroll: 'scroll' }[spec.action];
            if (!action) return finish({ ok: false, error: 'unsupported_android_h5_intent_action', dispatched: false });
            const observed = h5Target.selectH5Node(rawTree, spec.selector);
            if (!observed.ok) return finish(observed);
            return finish(await actionPorts.h5Control(ctx, action, {
              webViewId: observed.targetRef.pageRef.webViewId, selector: { elementId: observed.node.elementId },
              expectedTarget: observed.targetRef, ...(action === 'input' ? { text: spec.value } : {}),
            }));
          }
          if (spec.action === 'hideKeyboard') {
            if (spec.provider !== 'flutter') return finish({ ok: false, error: 'unsupported_action', dispatched: false });
            return finish(await actionPorts.flutterAction(ctx, { action: 'hideKeyboard' }, { runtimeActionId: actionId }));
          }
          if (spec.action === 'back' && spec.provider === 'flutter') {
            const result = await actionPorts.flutterAction(ctx, { action: 'back' }, { runtimeActionId: actionId });
            if (result?.handled === false) {
              return finish({ ...result, ok: false, providerResult: result, error: 'back_not_handled' });
            }
            return finish(result);
          }
          if (spec.action === 'back' || spec.action === 'keyevent') {
            return finish(await actionPorts.keyevent(ctx, spec.keyCode != null ? spec.keyCode : 4));
          }
          if (spec.action === 'longPress') {
            if (spec.provider !== 'native') return finish({ ok: false, error: 'long_press_provider_unsupported', dispatched: false });
            return finish(await gestureFromNativeObservedTree(actionPorts, ctx, spec, rawTree, actionId));
          }
          if (spec.action === 'swipe') {
            if (spec.provider !== 'native') return finish({ ok: false, error: 'swipe_provider_unsupported', dispatched: false });
            return finish(await gestureFromNativeObservedTree(actionPorts, ctx, spec, rawTree, actionId));
          }
          if (spec.action === 'scroll' || spec.action === 'scrollBy') {
            if (spec.provider === 'flutter') {
              return finish(await actionFromFlutterObservedTree(actionPorts, ctx, spec, rawTree, actionId));
            }
            return finish(await (spec.provider === 'native'
              ? gestureFromNativeObservedTree(actionPorts, ctx, spec, rawTree, actionId)
              : scrollHost(actionPorts, ctx, spec, rawTree)));
          }
          if (spec.action === 'inputText') {
            if (spec.provider === 'flutter') return finish(await actionFromFlutterObservedTree(actionPorts, ctx, spec, rawTree, actionId));
            if (spec.provider !== 'native') return finish({ ok: false, error: 'inputText_provider_unsupported', dispatched: false });
            return finish(await inputFromNativeObservedTree(actionPorts, ctx, spec, rawTree, actionId));
          }
          if (spec.provider === 'flutter' && spec.action === 'tap') {
            return finish(await actionFromFlutterObservedTree(actionPorts, ctx, spec, rawTree, actionId));
          }
          if (spec.provider === 'uia' && spec.action === 'tap') {
            return finish(await tapUniqueUiaNode(actionPorts, ctx, spec, rawTree));
          }
          if (spec.provider === 'native') return finish(await tapFromNativeObservedTree(actionPorts, ctx, spec, rawTree, actionId));
          return finish({ ok: false, error: 'unsupported_action_selector', dispatched: false });
        } catch (error) {
          return withForeground({
            ok: false,
            mechanicalStatus: 'failed',
            providerResult: null,
            ambiguous: error.ambiguous ?? dispatchAttempted,
            dispatched: error.dispatched ?? dispatchAttempted,
            settled: error.settled,
            executionReceipt: error.executionReceipt ?? null,
            error: error.code || error.message || String(error),
          }, feedback);
        }
      });
    },
    async launch({ serial, packageName, kind, port, adb: targetAdb }) {
      return withDevice(serial, packageName, `launch:${kind || 'app'}`, async () => {
        const ctx = context({ serial, packageName, port, adb: targetAdb });
        if (kind && kind !== 'app') return { ok: false, error: 'unsupported_launch_kind', dispatched: false };
        return impl.launchApp(ctx);
      });
    },
  };
}

async function tapUniqueUiaNode(impl, ctx, spec, rawTree) {
  const observed = selectUiaNode(rawTree, spec, ctx.packageName);
  if (!observed.ok) return observed;
  const binding = observedUiaTarget(rawTree, observed.node, spec.selector || { text: spec.text }, ctx.packageName);
  return impl.uiaTap(ctx, binding);
}

async function tapFromNativeObservedTree(impl, ctx, spec, rawTree, actionId) {
  const selected = await revalidateNativeNode(() => impl.bridgeTree(ctx), rawTree, spec);
  if (!selected.ok) return selected;
  const { x, y } = selected;
  const guarded = nativeTargetRequest(selected.node, spec.selector || { text: spec.text });
  if (!guarded.ok) return guarded;
  return impl.tap(ctx, x, y, { nativeTarget: guarded.request, feedback: 'off', appLocalAction: true, runtimeActionId: actionId, requestId: actionId });
}

async function inputFromNativeObservedTree(impl, ctx, spec, rawTree, actionId) {
  if (typeof spec.value !== 'string') return { ok: false, error: 'input_value_required', dispatched: false };
  const selected = await revalidateNativeNode(() => impl.bridgeTree(ctx), rawTree, spec, true);
  if (!selected.ok) return selected;
  const guarded = nativeTargetRequest(selected.node, spec.selector || { text: spec.text });
  if (!guarded.ok) return guarded;
  if (typeof impl.inputText !== 'function') return { ok: false, error: 'inputText_port_unavailable', dispatched: false };
  return impl.inputText(ctx, spec.value, { nativeTarget: guarded.request,
    feedback: 'off', appLocalAction: true, runtimeActionId: actionId, requestId: actionId });
}

async function gestureFromNativeObservedTree(impl, ctx, spec, rawTree, actionId) {
  const reject = error => ({ ok: false, error, dispatched: false, ambiguous: false });
  const durationMs = spec.action === 'scroll' && spec.durationMs === undefined ? 400 : spec.durationMs;
  if (!Number.isSafeInteger(durationMs) || durationMs < (spec.action === 'longPress' ? 500 : 1) || durationMs > 10000) {
    return reject(spec.action === 'longPress' ? 'invalid_long_press_duration' : 'invalid_swipe_duration');
  }
  if (spec.action === 'swipe' && (!Number.isFinite(spec.deltaX) || !Number.isFinite(spec.deltaY))) return reject('invalid_swipe_delta');
  if (spec.action === 'scroll' && !['up', 'down'].includes(spec.direction)) return reject('unsupported_scroll_direction');
  if (!spec.selector) return reject('explicit_native_selector_required');
  const selected = await revalidateNativeNode(() => impl.bridgeTree(ctx), rawTree, spec);
  if (!selected.ok) return selected;
  const guarded = nativeTargetRequest(selected.node, spec.selector);
  if (!guarded.ok) return guarded;
  if (typeof impl.nativeGesture !== 'function') return reject('native_gesture_port_unavailable');
  return impl.nativeGesture(ctx, { ...guarded.request, action: spec.action, actionId, durationMs,
    ...(spec.action === 'swipe' ? { deltaX: spec.deltaX, deltaY: spec.deltaY } : {}),
    ...(spec.action === 'scroll' ? { direction: spec.direction } : {}) });
}

async function scrollHost(impl, ctx, spec, rawTree) {
  if (!rawTree) return { ok: false, error: 'observed_tree_required', dispatched: false };
  const currentTree = await impl.uiaTreeOnce(ctx);
  checkExecution();
  const viewport = impl.parseUiaViewport(currentTree);
  if (!viewport || (!viewport.width || !viewport.height) && !validBounds(viewport)) return { ok: false, error: 'viewport_unavailable', dispatched: false };
  const width = viewport.width || viewport.right - viewport.left;
  const height = viewport.height || viewport.bottom - viewport.top;
  if (spec.direction != null && !['up', 'down'].includes(spec.direction)) return { ok: false, error: 'unsupported_scroll_direction', dispatched: false };
  const startX = Math.round(viewport.left + width / 2);
  const startY = Math.round(viewport.top + height * (spec.direction === 'up' ? 0.22 : 0.76));
  const endY = Math.round(viewport.top + height * (spec.direction === 'up' ? 0.76 : 0.22));
  return impl.swipe(ctx, startX, startY, startX, endY, spec.durationMs != null ? spec.durationMs : 400);
}

async function actionFromFlutterObservedTree(impl, ctx, spec, rawTree, actionId) {
  const observed = selectFlutterNode(rawTree, spec);
  if (!observed.ok) return observed;
  const current = selectFlutterNode(await impl.flutterNodes(ctx), spec);
  checkExecution();
  if (!current.ok) return current;
  if (!isDeepStrictEqual(flutterNodeIdentity(observed.node), flutterNodeIdentity(current.node))) {
    return { ok: false, error: 'reobserve_required', dispatched: false };
  }
  const guarded = flutterTargetRequest(current.node, spec.selector);
  if (!guarded.ok) return guarded;
  const payload = spec.action === 'tap' ? { action: 'tapTarget' }
    : spec.action === 'inputText' ? { action: 'inputText', text: spec.value }
      : { action: 'scrollBy', delta: spec.delta };
  return impl.flutterAction(ctx, { ...payload, ...guarded.request }, { runtimeActionId: actionId });
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
    ...(result.warnings ? { warnings: result.warnings, foregroundObservations: result.foregroundObservations } : {}),
    ambiguous: result.ambiguous === true,
    dispatched: result.dispatched ?? (result.ok ? true : null),
    executionReceipt: result.executionReceipt ?? null,
    error: result?.error || null,
  };
}

module.exports = {
  createProductionIntentDeviceAdapter,
};
