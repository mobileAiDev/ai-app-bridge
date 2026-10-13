'use strict';

const { parseXmlAttributes } = require('./xml-attributes');
const { visitAndroidUiHierarchyTags, looksLikeAndroidUiHierarchyXml } = require('../android-uia-xml');
const { selectionFailure } = require('./action-guidance');
const { validateValue } = require('./argument-schema');
const query = require('./android-node-query');

function uiaCandidates(rawTree, nodes) {
  const { snapshotIdentity, nodeTargetRef } = require('./uia-protocol');
  const snapshot = snapshotIdentity(rawTree);
  return nodes.map(node => {
    const targetRef = snapshot && node['aab-ref'] ? nodeTargetRef(snapshot, node) : undefined;
    const selector = targetRef ? { nodeRef: targetRef.nodeRef } : node['resource-id'] ? { resourceName: node['resource-id'] } : undefined;
    return { text: node.text, contentDescription: node['content-desc'], resourceName: node['resource-id'], className: node.class,
      packageName: node.package, bounds: node.bounds, enabled: node.enabled, clickable: node.clickable,
      ...(selector ? { selector } : {}), ...(targetRef ? { targetRef,
        action: { command: 'tap-uia', arguments: { packageName: node.package, targetRef } } } : {}) };
  });
}

const uiaAttributes = { checkable: { type: 'boolean' } };
const selectorSchema = query.selectorSchema(uiaAttributes);
const intentSelectorSchema = query.selectorSchema({ ...uiaAttributes, nodeRef: require('./uia-protocol').targetRefSchema.properties.nodeRef });
const attributeNames = { text: 'text', contentDescription: 'content-desc', resourceName: 'resource-id', nodeRef: 'aab-ref', className: 'class' };
function matches(node, selector) {
  return query.matches(node, selector, (node, key) => {
    if (key === 'checked' && node.checkable !== 'true') return undefined;
    const value = node[attributeNames[key] || key];
    return ['enabled', 'clickable', 'checked', 'checkable'].includes(key) ? value === 'true' ? true : value === 'false' ? false : undefined : value;
  });
}

function selectUiaNode(rawTree, spec, packageName) {
  const reject = error => ({ ok: false, error, dispatched: false });
  if (typeof rawTree !== 'string' || !looksLikeAndroidUiHierarchyXml(rawTree)) return reject('observed_uia_xml_required');
  const selector = spec.selector || (typeof spec.text === 'string' ? { text: spec.text } : null);
  if (spec.exact === false || (spec.selector && spec.text != null)) return reject('explicit_exact_uia_selector_required');
  try { validateValue(selector, intentSelectorSchema, 'selector'); }
  catch (error) { return { ...reject(error.field?.startsWith('selector.within') ? 'invalid_uia_scope' : 'explicit_exact_uia_selector_required'),
    message: error.message, field: error.field }; }
  const eligible = [], ancestors = [];
  visitAndroidUiHierarchyTags(rawTree, ({ tag, tagName, closing, selfClosing }) => {
    if (closing) { ancestors.pop(); return; }
    const node = parseXmlAttributes(tag);
    if (!node.class && tagName !== 'node') node.class = tagName;
    const hidden = item => item['visible-to-user'] === 'false' || item.displayed === 'false';
    if (node.package === packageName && !hidden(node) && !ancestors.some(hidden)) eligible.push({ node, ancestors: [...ancestors] });
    if (!selfClosing) ancestors.push(node);
  });
  let roots;
  if (selector.within) {
    const scope = query.scopeRoots(eligible, selector.within, matches);
    if (scope.error) return reject(`uia_${scope.error}`);
    roots = scope.roots;
  }
  const selected = eligible.filter(item => matches(item.node, selector)
    && (!roots || roots.some(root => item.node === root || item.ancestors.includes(root))));
  if (selected.length !== 1) return selectionFailure(selected.length ? 'uia_selector_not_unique' : 'uia_selector_not_found', uiaCandidates(rawTree, selected.map(item => item.node)));
  const { node } = selected[0];
  if (node.enabled !== 'true' || (spec.requireClickable === true && node.clickable !== 'true')) return reject('uia_node_not_operable');
  // ACTION_CLICK targets an accessibility node, not a screen coordinate. Layout
  // transitions can expose empty or clipped bounds on an otherwise live control.
  // The device revalidates node identity, visibility and the clickable ancestor.
  return { ok: true, node };
}

module.exports = { selectUiaNode, selectorSchema, intentSelectorSchema, uiaCandidates };
