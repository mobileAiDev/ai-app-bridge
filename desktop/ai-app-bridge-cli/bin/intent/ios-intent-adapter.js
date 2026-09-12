'use strict';

const { isDeepStrictEqual } = require('node:util');
const { selectH5Node, schema: h5Schema } = require('../shared-kernel/ios-h5-target');
const { IOSBridgeProvider } = require('../ios-provider');
const { selectFlutterNode, flutterNodeIdentity, flutterTargetRequest } = require('../shared-kernel/flutter-target');
const { checkExecution } = require('../shared-kernel/execution-scope');
const { selectNativeNode, sessionRef, schema: nativeSchema } = require('../shared-kernel/ios-native-target');

function createIOSIntentDeviceAdapter({ provider = new IOSBridgeProvider() } = {}) {
  const reject = error => ({ ok: false, error, dispatched: false, ambiguous: false, mechanicalStatus: 'failed' });
  function argumentsFor(target, native = false) {
    return Object.fromEntries(['deviceId', 'bundleId', 'devicectl', ...(native
      ? ['wdaUrl', 'wdaRunnerBundleId', 'wdaSessionId'] : ['runtimeUrl', 'iosHost', 'iosPort'])]
      .filter(key => target[key] !== undefined).map(key => [key, target[key]]));
  }
  return {
    async observe(target) {
      if (!['native', 'h5', 'flutter'].includes(target.provider)) return reject('unsupported_ios_intent_provider');
      const native = target.provider === 'native';
      const rawTree = await provider.run(native ? 'ios-uia-tree' : target.provider === 'h5' ? 'ios-h5-dom' : 'ios-flutter-nodes',
        { ...argumentsFor(target, native), ...(target.observationTarget === null || target.observationTarget === undefined ? {} : target.observationTarget) });
      if (rawTree.ok !== true) return rawTree;
      if (native && rawTree.nativeTargetSchema !== nativeSchema) return reject('ios_native_target_schema_required');
      if (target.provider === 'h5' && rawTree.h5TargetSchema !== h5Schema) return reject('ios_h5_target_schema_required');
      return { ok: true, provider: target.provider, rawTreeId: target.rawTreeId, rawTree,
        foregroundTarget: target.bundleId };
    },
    async action(target) {
      const { spec, rawTree, actionId } = target;
      if (spec.provider === 'h5') {
        const commands = { tap: 'ios-h5-click', inputText: 'ios-h5-input', scroll: 'ios-h5-scroll' };
        if (!commands[spec.action]) return reject('unsupported_ios_intent_action');
        const observed = selectH5Node(rawTree, spec.selector);
        if (!observed.ok) return observed;
        const result = await provider.run(commands[spec.action], { ...argumentsFor(target),
          webViewId: observed.targetRef.pageRef.webViewId, selector: { elementId: observed.node.elementId },
          expectedTarget: observed.targetRef, ...(spec.action === 'inputText' ? { text: spec.value } : {}), runtimeActionId: actionId });
        return { ...result, mechanicalStatus: result.ok === true ? 'ok' : 'failed' };
      }
      if (spec.provider === 'native') {
        if (spec.action === 'setOrientation') {
          if (rawTree?.nativeTargetSchema !== nativeSchema) return reject('ios_native_target_schema_required');
          const result = await provider.run('ios-set-orientation', { ...argumentsFor(target, true),
            orientation: spec.orientation, expectedSession: sessionRef(rawTree), runtimeActionId: actionId });
          return { ...result, mechanicalStatus: result.ok === true ? 'ok' : 'failed' };
        }
        if (!['tap', 'inputText'].includes(spec.action)) return reject('unsupported_ios_intent_action');
        const observed = selectNativeNode(rawTree, spec.selector);
        if (!observed.ok) return observed;
        const result = await provider.run(spec.action === 'tap' ? 'ios-tap-native' : 'ios-input-native-text', {
          ...argumentsFor(target, true), selector: spec.selector, expectedTarget: observed.targetRef,
          ...(spec.action === 'inputText' ? { text: spec.value } : {}), runtimeActionId: actionId,
        });
        return { ...result, mechanicalStatus: result.ok === true ? 'ok' : 'failed' };
      }
      if (spec.provider !== 'flutter') return reject('unsupported_ios_intent_provider');
      if (!['tap', 'inputText', 'scrollBy', 'back', 'hideKeyboard'].includes(spec.action)) return reject('unsupported_ios_intent_action');
      let payload;
      if (spec.action === 'back' || spec.action === 'hideKeyboard') payload = { action: spec.action };
      else {
        const observed = selectFlutterNode(rawTree, spec);
        if (!observed.ok) return observed;
        const fresh = await provider.run('ios-flutter-nodes', argumentsFor(target));
        if (fresh.ok !== true) return fresh;
        const current = selectFlutterNode(fresh, spec);
        checkExecution();
        if (!current.ok) return current;
        if (!isDeepStrictEqual(flutterNodeIdentity(observed.node), flutterNodeIdentity(current.node))) {
          return reject('reobserve_required');
        }
        const guarded = flutterTargetRequest(current.node, spec.selector);
        if (!guarded.ok) return guarded;
        payload = { ...guarded.request, ...(spec.action === 'tap' ? { action: 'tapTarget' }
          : spec.action === 'inputText' ? { action: 'inputText', text: spec.value }
          : { action: 'scrollBy', delta: spec.delta }) };
      }
      checkExecution();
      const result = await provider.run('ios-flutter-action', {
        ...argumentsFor(target), payload, runtimeActionId: actionId,
      });
      if (result.ok === true && spec.action === 'back' && result.handled === false) {
        return { ...result, ok: false, error: 'back_not_handled', mechanicalStatus: 'failed' };
      }
      return { ...result, mechanicalStatus: result.ok === true ? 'ok' : 'failed' };
    },
  };
}

module.exports = { createIOSIntentDeviceAdapter };
