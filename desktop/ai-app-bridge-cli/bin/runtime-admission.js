'use strict';

const { CommandError } = require('./command-errors');
const { requestAdmission } = require('./shared-kernel/request-context');

// A serial is only unique within its ADB server. Unrelated environment settings
// are advisory, but silently replacing an explicitly selected route can operate
// another device. Check this only when admitting new Android I/O, including
// commands invoked later by a Script. Original-operation recovery owns its route.
function requireCommandRoute(command, args) {
  const admission = requestAdmission();
  if (!admission || args.history === true || command === 'device-ownership') return;
  const android = command === 'intent' ? (args.operation ?? 'start') === 'start' && args.target?.platform === 'android'
    : command === 'power' ? args.operation === 'acquire' && args.target?.platform === 'android'
      : require('./command-registry').commandContract(command).platform === 'android';
  if (!android) return;
  const requested = admission.client.requestedProviders || {};
  const actual = admission.runtime.providers;
  for (const field of ['adb', 'adbServerSocket']) {
    // An explicit command argument takes precedence over client environment.
    if (args[field] !== undefined || args.target?.[field] !== undefined || requested[field] === undefined) continue;
    const canonical = value => field === 'adbServerSocket' ? require('./shared-kernel/android-adb-route').parseAdbServer(value).socket : value;
    if (JSON.stringify(canonical(requested[field])) !== JSON.stringify(canonical(actual[field]))) throw new CommandError('android_runtime_route_mismatch',
      `The client explicitly selects a different ${field}. Select that route in the command or start a Runtime with that route.`,
      { details: { field, requested: requested[field], runtime: actual[field] }, dispatched: false, ambiguous: false });
  }
}

module.exports = { requireCommandRoute };
