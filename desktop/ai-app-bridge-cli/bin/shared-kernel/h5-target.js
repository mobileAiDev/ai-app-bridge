'use strict';

const { isDeepStrictEqual } = require('node:util');
const { object, text } = require('./argument-schema');
const { selectionFailure } = require('./action-guidance');
const string = { type: 'string' };
const elementKeys = ['elementId', 'tag', 'id', 'name', 'type', 'text', 'ariaLabel', 'href'];
const elementSchema = { ...object(Object.fromEntries(elementKeys.map(key => [key,
  key === 'elementId' ? text : string])), elementKeys), additionalProperties: true };
const selectorSchema = { ...object({ elementId: text, text, ariaLabel: text, tag: text }),
  anyOf: ['elementId', 'text', 'ariaLabel'].map(key => ({ required: [key] })) };

function h5TargetContract({ schema, pageSchema, errorPrefix }) {
  const expectedTargetSchema = object({ pageRef: { ...pageSchema, additionalProperties: true }, element: elementSchema }, ['pageRef', 'element']);
  const pageKeys = Object.keys(pageSchema.properties);
  // Observation metadata is accepted by the public contract but is not renderer identity.
  const projectTarget = target => ({
    pageRef: Object.fromEntries(pageKeys.map(key => [key, target.pageRef[key]])),
    element: Object.fromEntries(elementKeys.map(key => [key, target.element[key]])),
  });
  const reject = error => ({ ok: false, error, dispatched: false, ambiguous: false });
  function selectH5Node(tree, selector, expectedTarget, { requireEnabled = true } = {}) {
    if (tree?.h5TargetSchema !== schema) return reject(errorPrefix + '_target_schema_required');
    if (tree.dom.truncated && selector.elementId === undefined) return reject(errorPrefix + '_snapshot_truncated');
    const nodes = tree.dom.controls.filter(node => node.visible === true
      && ['elementId', 'text', 'ariaLabel', 'tag'].every(key => selector[key] === undefined || selector[key] === node[key]));
    if (nodes.length !== 1) return selectionFailure(errorPrefix + (nodes.length ? '_selector_ambiguous' : '_selector_not_found'),
      nodes.map(node => ({ text: node.text, tag: node.tag, ariaLabel: node.ariaLabel, disabled: node.disabled, bounds: node.bounds,
        selector: { elementId: node.elementId } })));
    const node = nodes[0];
    if (requireEnabled && node.disabled) return reject(errorPrefix + '_target_disabled');
    const targetRef = projectTarget({ pageRef: tree.pageRef, element: node });
    const expected = expectedTarget === undefined ? undefined : projectTarget(expectedTarget);
    if (expected !== undefined && (!isDeepStrictEqual(expected.pageRef, targetRef.pageRef)
      || expected.element.elementId !== targetRef.element.elementId)) return reject('reobserve_required');
    // Preserve the observed attributes for the renderer's change diagnostics.
    return { ok: true, node, targetRef: expected ?? targetRef };
  }
  return { schema, selectorSchema, pageSchema, expectedTargetSchema, selectH5Node, projectTarget };
}

module.exports = { h5TargetContract };
