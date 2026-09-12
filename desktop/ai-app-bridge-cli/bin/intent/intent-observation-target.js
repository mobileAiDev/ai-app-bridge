'use strict';

const { object, text, validateValue } = require('../shared-kernel/argument-schema');
const { executionTargetSchema, normalizeExecutionTarget } = require('../shared-kernel/execution-target');
const { CommandError } = require('../command-errors');

const observationTargetSchema = { anyOf: [object({ webViewId: text }, ['webViewId']), { type: 'null' }],
  description: 'Android or iOS H5 WebView selection. Null requires one visible WebView; an explicit ID never selects a replacement.' };

function intentTargetSchema() {
  const schema = executionTargetSchema({ intent: true });
  // Script defaults and immutable evidence targets retain their own contract.
  // A live Intent selects WebViews as observation state, not its frozen target.
  delete schema.anyOf.find(branch => branch.properties.platform.const === 'ios').properties.webViewId;
  return schema;
}

function normalizeIntentTarget(value) {
  validateValue(value, intentTargetSchema(), 'target');
  return normalizeExecutionTarget(value, { intent: true });
}

function normalizeObservationTarget(target, provider, value) {
  validateValue(value, observationTargetSchema, 'observationTarget');
  if (value === null) return null;
  if (!['android', 'ios'].includes(target.platform) || provider !== 'h5') {
    throw new CommandError('unsupported_intent_observation_target', 'webViewId selects an Android or iOS H5 observation.',
      { field: 'observationTarget.webViewId' });
  }
  return Object.freeze({ webViewId: value.webViewId });
}

module.exports = { observationTargetSchema, intentTargetSchema, normalizeIntentTarget, normalizeObservationTarget };
