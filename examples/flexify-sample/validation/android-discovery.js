'use strict';

module.exports.main = async ctx => {
  const fs = require('node:fs'), path = require('node:path');
  const startedAtMs = Date.now(), calls = [];
  async function call(command, args) {
    const began = Date.now(), reply = await ctx.call(command, args);
    calls.push({ command, elapsedMs: Date.now() - began, reply });
    return reply;
  }
  const launch = await call('launch-activity', { activity: 'com.presley.flexify.MainActivity', clearTask: true });
  let ready, tree;
  if (launch.ok && !launch.ambiguous) {
    ready = await call('wait-text', { provider: 'flutter', targetText: 'Plans', timeoutMs: 30000, intervalMs: 100 });
    if (ready.ok) tree = await call('flutter-nodes', {});
  }
  await call('screenshot', { outFile: path.join(ctx.inputs.outDir, 'initial-screen.png') });
  const result = { ok: tree?.ok === true, startedAtMs, finishedAtMs: Date.now(), calls: calls.length,
    launchMs: calls.find(entry => entry.command === 'launch-activity')?.elapsedMs,
    readinessMs: calls.find(entry => entry.command === 'wait-text')?.elapsedMs,
    screenshotMs: calls.find(entry => entry.command === 'screenshot')?.elapsedMs,
    error: !launch.ok ? launch.error : !ready?.ok ? ready?.error : tree?.error,
    nodes: tree?.result.nodes.filter(n => n.text || n.label || n.input).map(n => ({
      id: n.id, role: n.role, text: n.text, label: n.label, value: n.value, tap: !!n.tap, input: !!n.input,
    })) };
  fs.writeFileSync(path.join(ctx.inputs.outDir, 'discovery.json'), JSON.stringify({ result, calls }, null, 2));
  return result;
};
