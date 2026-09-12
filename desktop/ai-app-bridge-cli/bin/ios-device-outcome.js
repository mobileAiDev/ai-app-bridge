'use strict';
const { isDeepStrictEqual } = require('node:util');

// A normal process exit alone cannot settle a remote action. Only the original
// devicectl JSON response, with its exact arguments and explicit OS rejection,
// can identify a known device rejection. Timeout/transport loss stays unknown.
function deviceCommandRejection(reply, args, error) {
  if (!Number.isInteger(error?.code) || error.code === 0 || error.signal || error.killed) return null;
  return originalDeviceRejection(reply, args);
}

// For recovery, the caller must independently associate the retained original
// response and exact invocation with the pending operation before using it.
function originalDeviceRejection(reply, args) {
  const command = args.slice(0, 3).join(' ');
  const type = command === 'device process launch' ? 'devicectl.device.process.launch'
    : command === 'device install app' ? 'devicectl.device.install.app' : null;
  if (!type
      || reply?.info?.jsonVersion !== 4 || reply.info.outcome !== 'failed'
      || reply.info.commandType !== type
      || !isDeepStrictEqual(reply.info.arguments, ['devicectl', ...args])) return null;
  const errors = [];
  function visit(value, depth) {
    if (!value || typeof value !== 'object' || depth > 16 || errors.length > 32) return;
    if (typeof value.domain === 'string' && Number.isInteger(value.code)) errors.push(value);
    for (const item of Object.values(value)) visit(item, depth + 1);
  }
  visit(reply.error, 0);
  if (command === 'device install app') {
    const installer = errors.find(value => value.domain === 'MIInstallerErrorDomain' && value.code === 13);
    if (!errors.some(value => value.domain === 'com.apple.dt.CoreDeviceError' && value.code === 3002)
        || !errors.some(value => value.domain === 'IXUserPresentableErrorDomain' && value.code === 14)
        || installer?.userInfo?.LegacyErrorString?.string !== 'ApplicationVerificationFailed'
        || !installer.userInfo.NSLocalizedDescription?.string?.startsWith('This device has reached the maximum number of installed apps using a free developer profile:')) return null;
    return { ok: false, error: 'ios_free_profile_app_limit',
      message: 'The selected iPhone has reached the free developer profile App limit. Remove an explicitly selected test App before installing another.',
      settled: true, dispatched: true, ambiguous: false, deviceOutcome: reply };
  }
  const reason = errors.find(value => value.domain === 'FBSOpenApplicationErrorDomain' && [3, 7].includes(value.code));
  if (!errors.some(value => value.domain === 'FBSOpenApplicationServiceErrorDomain' && value.code === 1) || !reason) return null;
  return { ok: false, error: reason.code === 7 ? 'ios_device_locked' : 'ios_app_launch_rejected',
    message: reason.code === 7 ? 'Unlock the selected iPhone before launching the App.'
      : 'iOS rejected the App launch. Check its code signature, entitlements and developer trust on the selected device.',
    settled: true, dispatched: true, ambiguous: false, deviceOutcome: reply };
}

module.exports = { deviceCommandRejection, originalDeviceRejection };
