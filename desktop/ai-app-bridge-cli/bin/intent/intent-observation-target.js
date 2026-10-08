'use strict';

const { object, text, validateValue } = require('../shared-kernel/argument-schema');
const { executionTargetSchema, normalizeExecutionTarget } = require('../shared-kernel/execution-target');
const { CommandError } = require('../command-errors');

const observationTargetSchema = { anyOf: [{ ...object({ webViewId: text, packageName: text }), anyOf: [{ required: ['webViewId'] }, { required: ['packageName'] }] }, { type: 'null' }],
  description: 'Explicit Android package or Android/iOS H5 WebView for the next observation. Foreground warnings never change this selection.' };

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
  if (value.packageName !== undefined && target.platform !== 'android') {
    throw new CommandError('unsupported_intent_observation_target', 'packageName selects an Android observation.', { field: 'observationTarget.packageName' });
  }
  if (value.webViewId !== undefined && (!['android', 'ios'].includes(target.platform) || provider !== 'h5')) {
    throw new CommandError('unsupported_intent_observation_target', 'webViewId selects an Android or iOS H5 observation.', { field: 'observationTarget.webViewId' });
  }
  return Object.freeze({ ...value });
}

module.exports = { observationTargetSchema, intentTargetSchema, normalizeIntentTarget, normalizeObservationTarget };
