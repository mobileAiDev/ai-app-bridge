'use strict';

const commands = new Set(['ui-observation', 'ios-ui-observation', 'web-ui-observation']);

function schema(command, optionTypes) {
  const target = command === 'web-ui-observation' ? ['sessionId', 'runtimeEpoch', 'targetId', 'timeoutMs']
    : command === 'ios-ui-observation' ? ['deviceId', 'bundleId', 'runtimeUrl', 'iosHost', 'iosPort', 'timeoutMs', 'devicectl']
      : ['serial', 'packageName', 'port', 'adb', 'timeoutMs'];
  const properties = Object.fromEntries(target.map(name => [name, optionTypes[name]]));
  Object.assign(properties, { operation: { enum: ['start', 'status', 'stop'] },
    durationMs: { type: 'integer', minimum: 100, maximum: 5000 }, leaseId: { type: 'string', minLength: 1, maxLength: 256 } });
  if (command !== 'web-ui-observation') properties.provider = { enum: ['native', 'flutter'], default: 'native' };
  return { type: 'object', additionalProperties: false, properties,
    required: ['operation', ...(command === 'web-ui-observation' ? ['sessionId', 'runtimeEpoch'] : command === 'ios-ui-observation' ? ['deviceId', 'bundleId'] : ['packageName'])],
    oneOf: [
      { properties: { operation: { const: 'start' }, leaseId: false }, required: ['durationMs'] },
      { properties: { operation: { const: 'stop' }, durationMs: false }, required: ['leaseId'] },
      { properties: { operation: { const: 'status' }, durationMs: false, leaseId: false } },
    ] };
}

function request(args) {
  return { operation: args.operation,
    ...(args.operation === 'start' ? { durationMs: args.durationMs } : {}),
    ...(args.operation === 'stop' ? { leaseId: args.leaseId } : {}) };
}
function path(args) { return args.provider === 'flutter' ? '/v1/flutter/observation' : '/v1/ui/observation'; }

module.exports = { commands, schema, request, path };
