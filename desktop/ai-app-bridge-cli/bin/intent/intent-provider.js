'use strict';

function intentProviderError(target, provider) {
  if (!['android', 'ios', 'web'].includes(target.platform)) return {
    error: 'unsupported_intent_platform', field: 'target.platform', platform: target.platform,
    message: 'Intent observation/action binding is not implemented for this platform yet.',
  };
  if (target.platform === 'web' && provider !== 'h5') return {
    error: 'unsupported_web_intent_provider', field: 'provider', provider,
    message: 'Web Intent uses provider h5 with the original connected document session and runtimeEpoch.',
  };
  if (target.platform === 'ios' && !['native', 'h5', 'flutter'].includes(provider)) return {
    error: 'unsupported_ios_intent_provider', field: 'provider', provider,
    message: 'iOS Intent supports native through an explicit WDA session, and h5 or flutter through the bound SDK.',
  };
  if (target.platform === 'android' && !['native', 'uia', 'flutter', 'h5'].includes(provider)) return {
    error: 'unsupported_android_intent_provider', field: 'provider', provider,
    message: 'Android Intent supports native, uia, flutter and h5 with explicit observation binding.',
  };
  if (target.platform === 'ios' && provider === 'native' && (!target.wdaRunnerBundleId || !target.wdaSessionId)) return {
    error: 'ios_wda_session_required', field: 'target.wdaSessionId',
    message: 'Native iOS Intent requires wdaRunnerBundleId and an explicit ios-wda-session for the selected foreground App.',
  };
  return null;
}

module.exports = { intentProviderError };
