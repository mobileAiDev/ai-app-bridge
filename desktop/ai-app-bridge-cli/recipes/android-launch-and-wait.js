'use strict';

exports.main = async ctx => {
  const { readyText, provider = 'uia', timeoutMs = 15000, intervalMs = 250, fullResult = false } = ctx.inputs;
  if (ctx.target?.platform !== 'android' || !ctx.target.serial || !ctx.target.packageName)
    throw new Error('Set script.target to the Android serial and packageName to launch.');
  if (typeof readyText !== 'string' || !readyText || !['uia', 'native', 'flutter', 'auto'].includes(provider)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647
    || !Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 2147483647 || typeof fullResult !== 'boolean')
    throw new Error('Supply readyText, a supported provider, and positive timeoutMs/intervalMs in milliseconds.');
  const launch = await ctx.call('launch-app', { feedback: 'off' });
  if (!launch.ok) return { ok: false, step: 'launch', receipt: fullResult ? launch : brief(launch) };
  const ready = await ctx.call('wait-text', { targetText: readyText, provider, timeoutMs, intervalMs });
  return { ok: ready.ok, step: 'wait', diagnosticDetail: fullResult ? 'full' : 'foreground-identities-without-raw-dumps',
    launch: fullResult ? launch : brief(launch), ready: fullResult ? ready : brief(ready) };
};

// A known recipe can project its result precisely. Keep every receipt/condition
// and foreground identity, while omitting repeated raw package/process/window
// dumps. Callers can choose fullResult before running or edit this plain source.
function brief(reply) {
  const result = structuredClone(reply);
  const identity = value => {
    if (!value?.evidence) return value;
    const { evidence, ...facts } = value;
    return { ...facts, rawEvidenceOmitted: true };
  };
  for (const value of [result, result.result].filter(Boolean)) {
    if (value.foreground) value.foreground = identity(value.foreground);
    for (const field of ['foregroundObservations', 'warnings']) if (value[field]) value[field] = value[field].map(item => ({ ...item,
      ...(item.actual ? { actual: identity(item.actual) } : {}), ...(item.previous ? { previous: identity(item.previous) } : {}) }));
  }
  return result;
}
