'use strict';

// Diagnostic control: no UI/SDK queries during the requested passive window
// (45 seconds by default).
// Android's retained launch event supplies first-frame latency independently of
// the later screenshot and UI check. The passive window is not a speed result.
module.exports.main = async ctx => {
  const fs = require('node:fs'), path = require('node:path');
  const calls = [], pkg = ctx.target.packageName;
  const observationFreeMs = ctx.inputs.observationFreeMs ?? 45000;
  if (!Number.isInteger(observationFreeMs) || observationFreeMs <= 0) throw Error('observationFreeMs must be a positive integer');
  const component = `${pkg}/com.presley.flexify.MainActivity`;
  async function call(command, args) {
    const start = Date.now(), reply = await ctx.call(command, args);
    calls.push({ command, args, elapsedMs: Date.now() - start, reply });
    if (!reply.ok || reply.ambiguous) throw Error(reply.error || 'Unknown outcome');
    return reply.result;
  }
  async function adb(argv, options = {}) {
    const result = await call('adb-exec', { argv, ...options });
    if (result.exitCode !== 0) throw Error(`ADB exit ${result.exitCode}: ${result.stderr}`);
    return result.stdout;
  }
  let result;
  try {
    await adb(['shell', 'am', 'force-stop', pkg]);
    const absenceArgs = { argv: ['shell', 'pidof', pkg], readOnly: true }, absenceStart = Date.now();
    const absent = await ctx.call('adb-exec', absenceArgs);
    calls.push({ command: 'adb-exec', args: absenceArgs, elapsedMs: Date.now() - absenceStart, reply: absent });
    if (absent.ambiguous || absent.result?.exitCode !== 1 || absent.result.stdout !== '' || absent.result.stderr !== '')
      throw Error('App process must be absent before the cold launch');
    const clock = (await adb(['shell', 'date', '+%s'], { readOnly: true })).trim();
    if (!/^\d+$/.test(clock)) throw Error('Expected device epoch seconds');
    const launchBeganAtMs = Date.now();
    await call('launch-activity', { activity: 'com.presley.flexify.MainActivity', clearTask: true });
    await new Promise(resolve => setTimeout(resolve, observationFreeMs));
    const log = await adb(['shell', 'logcat', '-b', 'events', '-d', '-v', 'epoch', '-s', 'wm_activity_launch_time'], { readOnly: true });
    fs.writeFileSync(path.join(ctx.inputs.outDir, 'launch-events.txt'), log);
    const events = log.split('\n').flatMap(line => {
      const timestamp = line.match(/^\s*(\d+\.\d+)/);
      const event = line.match(/wm_activity_launch_time:\s*\[(\d+),(\d+),([^,]+),(\d+)\]/);
      return timestamp && event && Number(timestamp[1]) >= Number(clock) && event[3] === component
        ? [{ timestampSeconds: Number(timestamp[1]), activityId: event[2], firstFrameMs: Number(event[4]), line }] : [];
    });
    const ready = await call('wait-text', { provider: 'uia', targetText: 'Add', timeoutMs: 10000, intervalMs: 100 });
    await call('screenshot', { outFile: path.join(ctx.inputs.outDir, 'first-screen.png') });
    result = { ok: events.length === 1 && ready.ok === true, launchBeganAtMs,
      firstFrameMs: events.length === 1 ? events[0].firstFrameMs : null, events,
      observationFreeMs, note: 'First-frame timing is from Android; the later readiness check has no early-ready timestamp.' };
  } catch (error) { result = { ok: false, error: error.message }; }
  fs.writeFileSync(path.join(ctx.inputs.outDir, 'startup.json'), JSON.stringify({ result, calls }, null, 2));
  return { ...result, calls: calls.length };
};
