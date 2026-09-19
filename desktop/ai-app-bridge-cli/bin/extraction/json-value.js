'use strict';

function validateJsonValue(value, location = '', parents = new Set()) {
  function invalid(reason) { throw Object.assign(new TypeError(`${location || '/'}: ${reason}`),
    { code: 'extraction_type_error', valuePath: location }); }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) invalid('expected a finite number in the safe integer range');
    return;
  }
  if (typeof value !== 'object') invalid(`unsupported JSON type: ${typeof value}`);
  if (parents.has(value)) invalid('cyclic value');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('expected a plain JSON object');
  if (Object.getOwnPropertySymbols(value).length) invalid('symbol keys are unsupported');
  parents.add(value);
  const keyPath = key => `${location}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) invalid('sparse arrays or extra array properties are unsupported');
    for (let i = 0; i < value.length; i++) validateJsonValue(value[i], keyPath(i), parents);
  } else {
    for (const key of Object.keys(value)) validateJsonValue(value[key], keyPath(key), parents);
  }
  parents.delete(value);
}

module.exports = { validateJsonValue };
