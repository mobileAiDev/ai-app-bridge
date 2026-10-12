'use strict';

const { object, text } = require('./argument-schema');

const attributes = {
  text, textContains: text, contentDescription: text, contentDescriptionContains: text,
  resourceName: text, className: text,
  clickable: { type: 'boolean' }, enabled: { type: 'boolean' }, checked: { type: 'boolean' },
};

// Every supplied attribute is a condition, including false. A scope selects a
// set of containers; uniqueness is required only for the final action target.
function selectorSchema(extra = {}) {
  const properties = { ...attributes, ...extra };
  const query = extensions => ({ ...object({ ...properties, ...extensions }),
    anyOf: Object.keys(properties).map(key => ({ required: [key] })) });
  return query({ within: query({ ancestor: query({ parent: query({}) }) }) });
}

function matches(node, query, value = (node, key) => node[key]) {
  return Object.entries(query).every(([key, expected]) => {
    if (['within', 'ancestor', 'parent'].includes(key)) return true;
    const contains = key === 'textContains' || key === 'contentDescriptionContains';
    if (!contains && node[`${key}Truncated`] === true) return false;
    const actual = value(node, contains ? key.slice(0, -8) : key);
    return contains ? typeof actual === 'string' && actual.includes(expected) : actual === expected;
  });
}

function scopeRoots(eligible, scope, match) {
  if (!scope.ancestor) {
    // Large containers can have their own center outside the viewport while
    // containing visible targets. Their visible ancestry is enough for scope.
    const nodes = new Set(eligible.flatMap(item => [...item.ancestors, item.node]));
    const roots = [...nodes].filter(node => match(node, scope));
    return roots.length ? { roots } : { error: 'scope_not_found' };
  }
  const anchors = eligible.filter(item => match(item.node, scope));
  if (!anchors.length) return { error: 'scope_anchor_not_found' };
  const roots = new Set();
  for (const anchor of anchors) anchor.ancestors.forEach((node, index, chain) => {
    if (match(node, scope.ancestor) && (!scope.ancestor.parent
      || index > 0 && match(chain[index - 1], scope.ancestor.parent))) roots.add(node);
  });
  return roots.size ? { roots: [...roots] } : { error: 'scope_ancestor_not_found' };
}

module.exports = { selectorSchema, matches, scopeRoots };
