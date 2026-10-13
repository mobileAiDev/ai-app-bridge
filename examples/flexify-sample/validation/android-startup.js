'use strict';

// Observe the same visible first-screen label with or without the SDK installed.
// Stop only this sample process; keep its database, preferences and permissions.
module.exports.main = async ctx => {
  const fs = require('node:fs'), path = require('node:path');
  const calls = [], startedAtMs = Date.now();
  async function call(command, args) {
    const start = Date.now(), reply = await ctx.call(command, args);
    calls.push({ command, args, elapsedMs: Date.now() - start, reply });
    return reply;
  }
  let error, ready, launch, launchBegan;
  try {
    const stop = await call('adb-exec', { argv: ['shell', 'am', 'force-stop', ctx.target.packageName] });
    if (!stop.ok || stop.ambiguous || stop.result?.exitCode !== 0) throw Error('Sample process stop was not confirmed');
    const absent = await call('adb-exec', { argv: ['shell', 'pidof', ctx.target.packageName], readOnly: true });
    if (absent.ambiguous || absent.result?.exitCode !== 1 || absent.result.stdout !== '' || absent.result.stderr !== '') {
      throw Error('Sample process remains present or could not be checked');
    }
    launchBegan = Date.now();
    launch = await call('launch-activity', { activity: 'com.presley.flexify.MainActivity', clearTask: true });
    if (!launch.ok || launch.ambiguous) throw Error(launch.error || 'Launch outcome unknown');
    // Both the actual UIA and Flutter observations expose this exact label.
    // The upstream navigation label is merged as "Plans\nPlans" by UIA.
    ready = await call('wait-text', { provider: ctx.inputs.provider, targetText: 'Add', timeoutMs: 45000, intervalMs: 100 });
    if (!ready.ok || ready.ambiguous) throw Error(ready.error || 'First screen was not confirmed');
  } catch (e) { error = e.message; }
  const firstScreenMs = launchBegan === undefined ? null : Date.now() - launchBegan;
  await call('screenshot', { outFile: path.join(ctx.inputs.outDir, 'first-screen.png') });
  const result = { ok: ready?.ok === true && !error, provider: ctx.inputs.provider,
    startedAtMs, finishedAtMs: Date.now(), firstScreenMs,
    launchMs: calls.find(c => c.command === 'launch-activity')?.elapsedMs,
    waitMs: calls.find(c => c.command === 'wait-text')?.elapsedMs,
    attempts: ready?.result?.attempts, failedReads: ready?.result?.failedReads,
    lastFailures: ready?.result?.failures, error: error || null, calls: calls.length };
  fs.writeFileSync(path.join(ctx.inputs.outDir, 'startup.json'), JSON.stringify({ result, calls }, null, 2));
  return result;
};
