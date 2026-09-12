'use strict';

const { object, text, validateValue } = require('./argument-schema');
const schema = 'aab.web-dom-target/v1';
const string = { type: 'string' };
const elementKeys = ['elementId', 'tag', 'id', 'name', 'type', 'role', 'ariaLabel', 'placeholder', 'href', 'text'];
const elementSchema = object(Object.fromEntries(elementKeys.map(key => [key, key === 'elementId' ? text : string])), elementKeys);
const pageSchema = object({ schemaVersion: { const: schema }, sessionId: text, runtimeEpoch: text,
  targetId: text, navigationId: text, url: text }, ['schemaVersion', 'sessionId', 'runtimeEpoch', 'targetId', 'navigationId', 'url']);
const selectorSchema = { ...object({ elementId: text, text, ariaLabel: text, css: text, tag: text, role: text }),
  oneOf: ['elementId', 'text', 'ariaLabel', 'css'].map(key => ({ required: [key] })) };
const intentSelectorSchema = { ...object({ elementId: text, text, ariaLabel: text, tag: text, role: text }),
  oneOf: ['elementId', 'text', 'ariaLabel'].map(key => ({ required: [key] })) };
const expectedTargetSchema = object({ pageRef: pageSchema, element: elementSchema }, ['pageRef', 'element']);
const reject = error => ({ ok: false, error, dispatched: false, ambiguous: false });

function validateSnapshot(dom, target) {
  validateValue(dom.pageRef, pageSchema);
  if (dom.targetSchema !== schema || dom.url !== dom.pageRef.url
    || ['sessionId', 'runtimeEpoch', 'targetId'].some(key => dom.pageRef[key] !== target[key])
    || !Array.isArray(dom.controls) || dom.controlCount !== dom.controls.length
    || typeof dom.truncated !== 'boolean' || typeof dom.bodyTextTruncated !== 'boolean') throw new Error('invalid_web_dom_target');
  const ids = new Set();
  for (const node of dom.controls) {
    validateValue(Object.fromEntries(elementKeys.map(key => [key, node[key]])), elementSchema);
    if (ids.has(node.elementId) || ['visible', 'disabled', 'editable'].some(key => typeof node[key] !== 'boolean')
      || ![true, false, 'mixed', null].includes(node.checked)) throw new Error('invalid_web_dom_control');
    ids.add(node.elementId);
  }
}

function selectWebNode(tree, selector) {
  if (tree?.webTargetSchema !== schema || tree.dom?.targetSchema !== schema) return reject('web_dom_target_schema_required');
  if (selector.css !== undefined) return reject('web_intent_css_selector_requires_observation');
  if (tree.dom.truncated) return reject('web_dom_snapshot_truncated');
  const matches = tree.dom.controls.filter(node => node.visible === true
    && ['elementId', 'text', 'ariaLabel', 'tag', 'role'].every(key => selector[key] === undefined || selector[key] === node[key]));
  if (matches.length !== 1) return { ...reject(matches.length ? 'web_element_ambiguous' : 'web_element_not_found'), matched: matches.length };
  const node = matches[0];
  if (node.disabled) return reject('web_element_disabled');
  return { ok: true, node, targetRef: { pageRef: tree.pageRef, element: Object.fromEntries(elementKeys.map(key => [key, node[key]])) } };
}

module.exports = { schema, selectorSchema, intentSelectorSchema, expectedTargetSchema, pageSchema, elementKeys, selectWebNode, validateSnapshot };
