'use strict';

const { isDeepStrictEqual } = require('node:util');
const { object, text, integer } = require('./argument-schema');

const schema = 'aab.ios-native-target/v1';
const sessionSchema = 'aab.ios-native-session/v1';
const orientationSchema = { enum: ['portrait', 'landscapeLeft', 'landscapeRight', 'portraitUpsideDown'],
  description: 'Requested App interface orientation. Landscape directions are UIInterfaceOrientation, not the opposite UIDeviceOrientation.' };
const expectedSessionSchema = object({ schemaVersion: { const: sessionSchema }, runnerEpoch: text,
  bundleId: text, processId: integer(1), sessionId: text },
['schemaVersion', 'runnerEpoch', 'bundleId', 'processId', 'sessionId']);
const nullableLabel = { anyOf: [{ type: 'string', maxLength: 16384 }, { type: 'null' }] };
const selectorSchema = { ...object({ accessibilityId: text, label: text, elementId: text, type: text }),
  oneOf: ['accessibilityId', 'label', 'elementId'].map(key => ({ required: [key] })) };
const elementSchema = object({ elementId: text, type: text, identifier: nullableLabel, label: nullableLabel },
  ['elementId', 'type', 'identifier', 'label']);
const expectedTargetSchema = object({ schemaVersion: { const: schema }, runnerEpoch: text,
  bundleId: text, processId: integer(1), sessionId: text, element: elementSchema },
['schemaVersion', 'runnerEpoch', 'bundleId', 'processId', 'sessionId', 'element']);
const reject = error => ({ ok: false, error, dispatched: false, ambiguous: false });

function nodesOf(tree) {
  const nodes = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    nodes.push(node);
    for (const child of node.children || []) walk(child);
  }
  walk(tree.source);
  return nodes;
}

function elementRef(node) {
  return { elementId: node.elementId, type: node.type, identifier: node.rawIdentifier, label: node.label };
}

function targetRef(tree, node) {
  return { schemaVersion: schema, runnerEpoch: tree.runtimeBinding.runtimeEpoch,
    bundleId: tree.session.bundleId, processId: tree.session.processId,
    sessionId: tree.session.sessionId, element: elementRef(node) };
}

function sessionRef(tree) {
  return { schemaVersion: sessionSchema, runnerEpoch: tree.runtimeBinding.runtimeEpoch,
    bundleId: tree.session.bundleId, processId: tree.session.processId, sessionId: tree.session.sessionId };
}

function selectNativeNode(tree, selector) {
  if (tree?.nativeTargetSchema !== schema) return reject('ios_native_target_schema_required');
  const nodes = nodesOf(tree).filter(node => node.isVisible === '1'
    && (selector.type === undefined || node.type === selector.type)
    && (selector.accessibilityId === undefined || node.rawIdentifier === selector.accessibilityId)
    && (selector.label === undefined || node.label === selector.label)
    && (selector.elementId === undefined || node.elementId === selector.elementId));
  if (nodes.length !== 1) return { ...reject(nodes.length ? 'ios_native_selector_ambiguous' : 'ios_native_selector_not_found'), matched: nodes.length };
  const node = nodes[0];
  if (typeof node.elementId !== 'string' || !node.elementId) return reject('ios_native_element_identity_required');
  if (node.isEnabled !== '1') return reject('ios_native_target_disabled');
  return { ok: true, node, targetRef: targetRef(tree, node), matched: 1 };
}

function bindNativeTarget(tree, selector, expectedTarget) {
  const selected = selectNativeNode(tree, selector);
  if (!selected.ok) return selected;
  if (expectedTarget !== undefined && !isDeepStrictEqual(selected.targetRef, expectedTarget)) return reject('reobserve_required');
  return selected;
}

module.exports = { schema, selectorSchema, expectedTargetSchema, nodesOf, selectNativeNode, bindNativeTarget, targetRef,
  orientationSchema, expectedSessionSchema, sessionRef };
