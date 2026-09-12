'use strict';

const { parseXmlAttributes } = require('./xml-attributes');
const { visitAndroidUiHierarchyTags, looksLikeAndroidUiHierarchyXml } = require('../android-uia-xml');

const selectorSchema = { type: 'object', additionalProperties: false, minProperties: 1, maxProperties: 1,
  properties: Object.fromEntries(['text', 'contentDescription', 'resourceName']
    .map(key => [key, { type: 'string', minLength: 1 }])) };
const intentSelectorSchema = { ...selectorSchema, properties: { ...selectorSchema.properties,
  nodeRef: require('./uia-protocol').targetRefSchema.properties.nodeRef } };

function selectUiaNode(rawTree, spec, packageName) {
  const reject = error => ({ ok: false, error, dispatched: false });
  if (typeof rawTree !== 'string' || !looksLikeAndroidUiHierarchyXml(rawTree)) return reject('observed_uia_xml_required');
  const selector = spec.selector || (typeof spec.text === 'string' ? { text: spec.text } : null);
  const keys = Object.keys(selector || {});
  const attribute = { text: 'text', contentDescription: 'content-desc', resourceName: 'resource-id', nodeRef: 'aab-ref' }[keys[0]];
  if (keys.length !== 1 || !attribute || typeof selector[keys[0]] !== 'string' || !selector[keys[0]]
    || spec.exact === false || (spec.selector && spec.text != null)) return reject('explicit_exact_uia_selector_required');
  const nodes = [];
  visitAndroidUiHierarchyTags(rawTree, ({ tag, tagName, closing }) => {
    if (!closing) {
      const node = parseXmlAttributes(tag);
      if (!node.class && tagName !== 'node') node.class = tagName;
      nodes.push(node);
    }
  });
  const selected = nodes.filter(node => node.package === packageName && node[attribute] === selector[keys[0]]
    && node['visible-to-user'] !== 'false' && node.displayed !== 'false');
  if (selected.length !== 1) return reject(selected.length ? 'uia_selector_not_unique' : 'uia_selector_not_found');
  const node = selected[0];
  const bounds = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(node.bounds || '');
  if (!bounds || node.enabled !== 'true' || (spec.requireClickable === true && node.clickable !== 'true')) return reject('uia_node_not_operable');
  const [left, top, right, bottom] = bounds.slice(1).map(Number);
  if (left < 0 || top < 0 || right <= left || bottom <= top) return reject('uia_node_not_operable');
  return { ok: true, node, x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
}

module.exports = { selectUiaNode, selectorSchema, intentSelectorSchema };
