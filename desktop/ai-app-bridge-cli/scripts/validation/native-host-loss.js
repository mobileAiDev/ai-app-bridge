'use strict';

module.exports.main = async ctx => {
  const fs = require('node:fs'), path = require('node:path');
  const call = async (command, args = {}) => {
    const began = Date.now(), reply = await ctx.call(command, args);
    fs.appendFileSync(path.join(ctx.inputs.outDir, 'program-calls.jsonl'), JSON.stringify({ command, args,
      elapsedMs: Date.now() - began, ok: reply.ok, error: reply.error, dispatched: reply.dispatched,
      ambiguous: reply.ambiguous, actionId: reply.execution?.actionId }) + '\n');
    if (!reply.ok || reply.ambiguous) throw new Error(`${command}: ${reply.error}`);
    return reply.result;
  };
  const wait = targetText => call('wait-text', { provider: 'native', targetText, timeoutMs: 12000, intervalMs: 50 });
  const state = ctx.resume();
  if (!state) {
    await call('launch-activity', { activity: 'io.github.mobileaidev.aiappbridge.sample.debugbridge.DebugBridgeNativeTestActivity', clearTask: true });
    await wait('Native counter: 0');
    const tree = await call('tree', { compact: true, maxNodes: 100 });
    const matches = tree.nodes.filter(node => node.text === 'Native Increment' && node.contentDescription === 'native_increment');
    if (matches.length !== 1) throw new Error('Expected one observed increment control');
    fs.writeFileSync(path.join(ctx.inputs.outDir, 'observed-target.json'), JSON.stringify(matches[0], null, 2));
    await ctx.checkpoint('before-long-press', { phase: 'query-original-gesture' });
    const result = await call('native-gesture', { payload: { action: 'longPress',
      selector: { text: matches[0].text, contentDescription: matches[0].contentDescription }, durationMs: 8000 } });
    fs.writeFileSync(path.join(ctx.inputs.outDir, 'unexpected-original-return.json'), JSON.stringify(result, null, 2));
    throw new Error('The Host-loss fault was not injected before the original action returned');
  }
  if (state.phase !== 'verified-original-gesture') throw new Error('Recovery state must reflect the queried original receipt');
  await wait('Native counter: 1');
  await call('screenshot', { outFile: path.join(ctx.inputs.outDir, 'original-effect.png') });
  await ctx.checkpoint('original-effect-verified', { phase: 'new-increment' });
  await call('tap-native', { selector: { text: 'Native Increment', contentDescription: 'native_increment' } });
  await wait('Native counter: 2');
  await call('screenshot', { outFile: path.join(ctx.inputs.outDir, 'continued-effect.png') });
  const records = await call('state', { sinceMs: ctx.inputs.deviceSinceMs, limit: 20 });
  fs.writeFileSync(path.join(ctx.inputs.outDir, 'state-records.json'), JSON.stringify(records, null, 2));
  return { ok: true, originalCounter: 1, finalCounter: 2, originalActionReplayed: false };
};
