'use strict';

const { CommandError } = require('./command-errors');
const { currentExecution } = require('./shared-kernel/execution-scope');

const schemaVersion = 'aab.ios-runtime/v1';
const sdkCommands = new Set(['ios-status', 'ios-tree', 'ios-logs', 'ios-network', 'ios-state', 'ios-events',
  'ios-h5-dom', 'ios-h5-eval', 'ios-h5-click', 'ios-h5-input', 'ios-h5-scroll', 'ios-flutter-tree', 'ios-flutter-nodes', 'ios-flutter-action',
  'ios-tap-flutter', 'ios-input-flutter-text', 'ios-scroll-flutter', 'ios-flutter-back', 'ios-flutter-hide-keyboard']);
const fields = ['schemaVersion', 'bundleId', 'runtimeEpoch', 'processId', 'port'];

function bindingFailure(code, message) {
  const dispatched = currentExecution()?.dispatched === true;
  return new CommandError(code, message, { dispatched, ambiguous: dispatched });
}

function runtimeBinding(value, minimumPort = 1) {
  if (!value || value.schemaVersion !== schemaVersion || typeof value.bundleId !== 'string'
    || !/^[A-Za-z0-9_.-]{1,255}$/.test(value.bundleId)
    || typeof value.runtimeEpoch !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.runtimeEpoch)
    || !Number.isSafeInteger(value.processId) || value.processId < 1
    || !Number.isInteger(value.port) || value.port < minimumPort || value.port > 65535) {
    throw bindingFailure('invalid_ios_runtime_binding', `Expected a ${schemaVersion} identity with bundleId, runtimeEpoch, processId and port.`);
  }
  return Object.freeze(Object.fromEntries(fields.map(field => [field, value[field]])));
}

function descriptorBinding(value, bundleId) {
  const binding = runtimeBinding(value, value?.ok === false ? 0 : 1);
  if (value.ok !== true) throw bindingFailure('ios_runtime_not_ready',
    `The selected App has not published a ready runtime descriptor${typeof value.error === 'string' ? `: ${value.error}` : '.'}`);
  if (binding.bundleId !== bundleId) throw bindingFailure('ios_runtime_binding_mismatch', 'The App container descriptor does not match the requested bundleId.');
  return binding;
}

function bindingHeaders(binding) {
  return {
    'X-AAB-Runtime-Schema': binding.schemaVersion,
    'X-AAB-Bundle-Id': binding.bundleId,
    'X-AAB-Runtime-Epoch': binding.runtimeEpoch,
    'X-AAB-Process-Id': String(binding.processId),
    'X-AAB-Runtime-Port': String(binding.port),
  };
}

function assertRuntimeResponse(response, expected) {
  const actual = runtimeBinding(response?.runtimeBinding);
  if (fields.some(field => actual[field] !== expected[field])) {
    throw bindingFailure('ios_runtime_binding_mismatch', 'The HTTP endpoint does not match the runtime copied from the selected device and App.');
  }
  if (typeof response.ok !== 'boolean') throw bindingFailure('invalid_ios_runtime_response', 'The bound runtime response must declare ok as a boolean.');
}

module.exports = { sdkCommands, descriptorBinding, bindingHeaders, assertRuntimeResponse, bindingFailure };
