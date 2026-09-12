'use strict';

const { CommandError } = require('../command-errors');

const fieldAt = (parent, name) => parent ? `${parent}.${name}` : name;
const invalid = (field, message) => new CommandError('invalid_argument', message, { field: field || 'arguments' });

// Validate the JSON Schema subset emitted by the command registry. Defaults
// describe the contract; validation never invents a value or converts its type.
function validateValue(value, schema, field = '') {
  const label = field || 'arguments';
  if (schema === true) return validateJson(value, field);
  if (schema === false) throw invalid(field, `${label} is not accepted.`);
  if (Object.hasOwn(schema, 'const') && value !== schema.const) throw invalid(field, `${label} must be ${JSON.stringify(schema.const)}.`);
  if (schema.enum && !schema.enum.includes(value)) throw invalid(field, `${label} must be one of: ${schema.enum.join(', ')}.`);
  const type = schema.type;
  const matches = type === undefined || (type === 'array' ? Array.isArray(value)
    : type === 'null' ? value === null
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'integer' ? Number.isSafeInteger(value)
    : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : typeof value === type);
  if (!matches) throw invalid(field, `${label} must be ${type}; no implicit type conversion is performed.`);
  if (schema.minLength !== undefined && value.length < schema.minLength) throw invalid(field, `${label} must not be empty.`);
  if (schema.maxLength !== undefined && value.length > schema.maxLength) throw invalid(field, `${label} must contain at most ${schema.maxLength} characters.`);
  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) throw invalid(field, `${label} must match ${schema.pattern}.`);
  if (schema.minimum !== undefined && value < schema.minimum) throw invalid(field, `${label} must be >= ${schema.minimum}.`);
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) throw invalid(field, `${label} must be > ${schema.exclusiveMinimum}.`);
  if (schema.maximum !== undefined && value > schema.maximum) throw invalid(field, `${label} must be <= ${schema.maximum}.`);
  if (type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw invalid(field, `${label} requires at least ${schema.minItems} item(s).`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw invalid(field, `${label} accepts at most ${schema.maxItems} item(s).`);
    value.forEach((item, index) => validateValue(item, schema.items ?? {}, `${label}[${index}]`));
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) throw invalid(field, `${label} must not contain duplicate items.`);
  }
  if (type === 'object' || schema.properties || schema.required || schema.additionalProperties !== undefined) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid(field, `${label} must be an object.`);
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid(field, `${label} must be a JSON object.`);
    const properties = schema.properties || {};
    for (const name of schema.required || []) {
      if (!Object.hasOwn(value, name)) throw new CommandError('missing_argument', `${fieldAt(field, name)} is required.`, { field: fieldAt(field, name) });
    }
    for (const [name, rule] of Object.entries(properties)) {
      if (Object.hasOwn(value, name) && (Object.hasOwn(rule, 'const') || rule.enum)) validateValue(value[name], rule, fieldAt(field, name));
    }
    // Validate the selected operation before its aggregate discovery properties.
    // Otherwise a wrong field can fail a different operation's nested union.
    if (schema.anyOf) validateUnion(value, schema.anyOf, field, false);
    if (schema.oneOf) validateUnion(value, schema.oneOf, field, true);
    for (const [name, item] of Object.entries(value)) {
      const child = fieldAt(field, name);
      if (Object.hasOwn(properties, name)) validateValue(item, properties[name], child);
      else if (schema.additionalProperties === false) throw new CommandError('unsupported_argument', `${child} is not accepted by this contract.`, { field: child });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateValue(item, schema.additionalProperties, child);
      else if (type === 'object') validateJson(item, child);
    }
  }
  for (const part of schema.allOf || []) validateValue(value, part, field);
  if (!(type === 'object' || schema.properties || schema.required || schema.additionalProperties !== undefined)) {
    if (schema.anyOf) validateUnion(value, schema.anyOf, field, false);
    if (schema.oneOf) validateUnion(value, schema.oneOf, field, true);
  }
  if (schema.not && accepts(value, schema.not, field)) throw invalid(field, `${label} combines mutually exclusive fields.`);
  if (schema.if) {
    const branch = accepts(value, schema.if, field) ? schema.then : schema.else;
    if (branch) validateValue(value, branch, field);
  }
  if (Object.keys(schema).every(key => ['description', 'default'].includes(key))) validateJson(value, field);
}

function accepts(value, schema, field) {
  try { validateValue(value, schema, field); return true; }
  catch (error) { if (!(error instanceof CommandError)) throw error; return false; }
}

function validateUnion(value, branches, field, exactlyOne) {
  const failures = [];
  let matched = 0;
  for (const branch of branches) {
    try { validateValue(value, branch, field); matched++; }
    catch (error) { if (!(error instanceof CommandError)) throw error; failures.push({ branch, error }); }
  }
  if (matched && (!exactlyOne || matched === 1)) return;
  if (!matched) {
    // A tagged branch gives a useful precise error instead of a generic union
    // failure, e.g. decision.action.durationMs for an observed long press.
    const tagged = failures.filter(({ branch }) => {
      const tags = Object.entries(branch.properties || {}).filter(([, rule]) => Object.hasOwn(rule, 'const'));
      return tags.some(([key, rule]) => value?.[key] === rule.const)
        && tags.every(([key, rule]) => Object.hasOwn(value || {}, key) ? value[key] === rule.const : !branch.required?.includes(key));
    });
    if (tagged.length === 1) throw tagged[0].error;
    const candidates = tagged.length ? tagged : failures;
    if (candidates.every(({ error }) => error.code === candidates[0].error.code && error.field === candidates[0].error.field && error.message === candidates[0].error.message)) throw candidates[0].error;
    if (branches.length === 1) throw failures[0].error;
  }
  throw new CommandError('invalid_argument', `${field || 'arguments'} must match ${exactlyOne ? 'exactly one' : 'one'} of the documented variants.`,
    { field: field || 'arguments', details: { variants: failures.map(({ error }) => ({ field: error.field, error: error.code, message: error.message })) } });
}

function validateJson(value, field = '', ancestors = new Set(), depth = 0) {
  if (depth > 64) throw invalid(field, 'JSON nesting must not exceed 64 levels.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') throw invalid(field, `${field || 'value'} must be a JSON value.`);
  if (ancestors.has(value)) throw invalid(field, `${field || 'value'} must not contain a cycle.`);
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid(field, `${field || 'value'} must be a JSON object.`);
  ancestors.add(value);
  for (const [key, item] of Object.entries(value)) validateJson(item, Array.isArray(value) ? `${field}[${key}]` : fieldAt(field, key), ancestors, depth + 1);
  ancestors.delete(value);
}

const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const integer = (minimum, maximum = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', minimum, maximum });
const text = { type: 'string', minLength: 1 };
const milliseconds = integer(1, 2147483647);

module.exports = { validateValue, validateJson, object, integer, text, milliseconds };
