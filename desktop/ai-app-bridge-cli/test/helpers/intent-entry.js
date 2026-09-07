'use strict';
const entry = require('../../bin/intent/intent-entry');
const { createFakeIntentDeviceAdapter } = require('../../bin/intent/intent-device-adapter');
function handle(args = {}) {
  return entry.handle((args.operation || 'start') === 'start' && args.adapter == null
    ? { ...args, adapter: createFakeIntentDeviceAdapter() }
    : args);
}
module.exports = { ...entry, handle };
