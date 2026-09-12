'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { flutterNode, flutterRef } = require('../test-support/flutter-target-fixture');
const { bindFlutterAction, flutterTargetRequest } = require('../bin/shared-kernel/flutter-target');
const { createProductionIntentDeviceAdapter } = require('../bin/intent/intent-production-adapter');
const { validateCommandArguments, parseCliOptions, commandSchema } = require('../bin/command-registry');
const { authorizeCommand } = require('../bin/script/script-catalog');

test('Intent Flutter input and scroll bind the observed Element instead of coordinates', async () => {
  for (const [spec, action] of [
    [{ action: 'inputText', selector: { nodeId: 'editor' }, value: '中文' }, 'input'],
    [{ action: 'scrollBy', selector: { nodeId: 'list' }, delta: 240 }, 'scroll'],
  ]) {
    const id = spec.selector.nodeId;
    const rawTree = { nodes: [flutterNode({ id, action, text: '' })] };
    const sent = [];
    const adapter = createProductionIntentDeviceAdapter({ ports: {
      createBridgeContext: args => args,
      bridgeTree: async () => ({ root: { visible: true, bounds: { left: 0, top: 0, right: 400, bottom: 800 } } }),
      flutterNodes: async () => rawTree,
      flutterAction: async (_ctx, payload, context) => { sent.push({ payload, context }); return { ok: true, dispatched: true, ambiguous: false }; },
    } });
    const decision = { decisionId: 'decision-1', basedOnRevision: 1, agentDecision: 'act', action: { provider: 'flutter', ...spec } };
    validateCommandArguments('intent', { operation: 'decide', operationId: 'intent-1', decision });
    const result = await adapter.action({ serial: 'device', packageName: 'example.app', rawTree, actionId: 'intent:1', spec: decision.action });
    assert.equal(result.ok, true);
    assert.deepEqual(sent, [{ payload: { action: spec.action, selector: spec.selector, targetRef: flutterRef(id),
      ...(action === 'input' ? { text: '中文' } : { delta: 240 }) }, context: { runtimeActionId: 'intent:1' } }]);
  }
});

test('same label and traversal ID with a replaced Flutter Element is rejected by Host', async () => {
  let calls = 0;
  const observed = flutterNode();
  const current = { ...observed, targetRef: flutterRef('replacement') };
  const adapter = createProductionIntentDeviceAdapter({ ports: {
    createBridgeContext: args => args,
    bridgeTree: async () => ({ root: { visible: true, bounds: { left: 0, top: 0, right: 400, bottom: 800 } } }),
    flutterNodes: async () => ({ nodes: [current] }),
    flutterAction: async () => { calls++; return { ok: true }; },
  } });
  const result = await adapter.action({ serial: 'device', packageName: 'example.app', rawTree: { nodes: [observed] }, actionId: 'intent:1',
    spec: { provider: 'flutter', action: 'tap', selector: { text: 'Settings' } } });
  assert.equal(result.error, 'reobserve_required');
  assert.equal(result.dispatched, false);
  assert.equal(calls, 0);
});

test('old SDK observations cannot downgrade semantic actions to coordinates', () => {
  const node = flutterNode(); delete node.targetRef;
  assert.equal(flutterTargetRequest(node, { text: 'Settings' }).error, 'flutter_atomic_target_unavailable');
  const result = bindFlutterAction({ nodes: [node] }, { action: 'tapText', text: 'Settings' });
  assert.equal(result.error, 'flutter_atomic_target_unavailable');
  assert.equal(result.dispatched, false);
});

test('direct input binds one focused editor or rejects multiple unfocused editors', () => {
  const a = flutterNode({ id: 'a', action: 'input', text: '' });
  const b = flutterNode({ id: 'b', action: 'input', text: '' });
  const tree = { nodes: [a, b] };
  assert.equal(bindFlutterAction(tree, { action: 'inputText', text: 'value' }).error, 'flutter_selector_not_unique');
  b.input.focused = true;
  const result = bindFlutterAction(tree, { action: 'inputText', text: 'value' });
  assert.deepEqual(result.payload, { action: 'inputText', text: 'value', selector: { nodeId: 'b' }, targetRef: flutterRef('b') });
});

test('scroll binds a selected container and rejects an implicit last-container choice', () => {
  const a = flutterNode({ id: 'a', action: 'scroll', text: '' });
  const b = flutterNode({ id: 'b', action: 'scroll', text: '' });
  assert.equal(bindFlutterAction({ nodes: [a, b] }, { action: 'scrollBy', delta: 100 }).error, 'flutter_selector_not_unique');
  assert.equal(bindFlutterAction({ nodes: [a, b] }, { action: 'scrollBy', delta: 100, selector: { nodeId: 'a' } }).payload.targetRef.elementId, 'a');
});

test('truncated Flutter trees are not sufficient to prove a unique target', () => {
  assert.equal(bindFlutterAction({ nodes: [flutterNode()], truncated: true }, { action: 'tapText', text: 'Settings' }).error, 'flutter_observation_incomplete');
});

test('public and Script selector calls share strict schemas and existing permissions', () => {
  for (const [command, args] of [
    ['tap-flutter', { selector: { text: 'Settings' } }],
    ['input-flutter-text', { selector: { nodeId: 'e2' }, text: '' }],
    ['scroll-flutter', { selector: { nodeId: 'e3' }, delta: 120 }],
  ]) {
    validateCommandArguments(command, { serial: 'device', packageName: 'example.app', ...args });
    assert.equal(authorizeCommand(command, ['app.interact']).ok, true);
    assert.equal(authorizeCommand(command, ['app.read']).ok, false);
    const parsed = parseCliOptions(command, { serial: 'device', packageName: 'example.app', ...args, selector: JSON.stringify(args.selector) });
    assert.deepEqual(parsed.selector, args.selector);
    assert.equal(commandSchema(command).properties.selector.additionalProperties, false);
  }
  for (const [command, args] of [
    ['tap-flutter', { selector: { text: 'Settings' }, tapX: 1, tapY: 2 }],
    ['input-flutter-text', { selector: { nodeId: 'e2' }, text: '', tapX: 1, tapY: 2 }],
    ['flutter-action', { payload: { action: 'inputText', text: '', targetRef: flutterRef('e2') } }],
    ['flutter-action', { payload: { action: 'inputText', selector: { nodeId: 'e2' }, text: '', x: 1, y: 2 } }],
  ]) assert.throws(() => validateCommandArguments(command, { serial: 'device', packageName: 'example.app', ...args }));
});
