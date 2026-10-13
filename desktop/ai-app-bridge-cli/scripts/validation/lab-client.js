'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = ctx => {
  const began = Date.now(), steps = [], checks = [];
  let phase = 'launch', app = ctx.target.packageName;
  async function raw(command, args = {}) {
    const started = Date.now();
    const reply = await ctx.call(command, ['adb-exec', 'uia-tree'].includes(command) ? args : { packageName: app, ...args });
    steps.push({ phase, command, ms: Date.now() - started, ok: reply.ok, error: reply.error, dispatched: reply.dispatched, ambiguous: reply.ambiguous });
    fs.appendFileSync(path.join(ctx.inputs.outDir, 'steps.jsonl'), JSON.stringify(steps.at(-1)) + '\n');
    if (command === 'launch-activity') fs.writeFileSync(path.join(ctx.inputs.outDir, 'launch-receipt.json'), JSON.stringify(reply, null, 2));
    if (!reply.ok) fs.writeFileSync(path.join(ctx.inputs.outDir, 'last-failure.json'), JSON.stringify(reply, null, 2));
    return reply;
  }
  async function call(command, args) {
    let reply = await raw(command, args);
    const deadline = Date.now() + 1500;
    // Page transitions can replace a just-observed Element before dispatch.
    // Retry only an explicitly semantic selector that has had no effect.
    const semantic = args?.selector && !args.selector.nodeId || args?.targetText;
    const notReady = new Set(['flutter_observation_busy', 'flutter_selector_not_found', 'target_not_found', 'flutter_target_changed', 'flutter_target_replaced']);
    while (!reply.ok && reply.dispatched === false && !reply.ambiguous && semantic && notReady.has(reply.error) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      reply = await raw(command, args);
    }
    if (!reply.ok || reply.ambiguous) throw new Error(`${phase}: ${command}: ${reply.error}: ${reply.message || ''}`);
    return reply.result;
  }
  async function check(name, condition) {
    const verdict = await ctx.assert({ name, condition, scope: 'code' }); checks.push({ name, verdict: verdict.verdict });
    if (verdict.verdict !== 'passed') throw new Error(`Assertion failed: ${name}`);
  }
  // Startup can precede the first Flutter engine/frame. Poll the result within
  // an explicit larger budget; this entire wait remains in the reported time.
  const wait = (provider, targetText, timeoutMs = phase === 'launch' ? 30000 : 10000) =>
    call('wait-text', { provider, targetText, timeoutMs, intervalMs: 50 });
  async function flutterInput(label, text) {
    return call('input-flutter-text', { selector: { label, role: 'input' }, text,
      hideKeyboard: ctx.inputs.config?.focusInputs !== false,
      ...(ctx.inputs.config?.focusInputs === undefined ? {} : { focus: ctx.inputs.config.focusInputs }) });
  }
  return { raw, call, check, wait, flutterInput,
    tapNative: description => call('tap-native', { selector: { contentDescription: description } }),
    inputNative: (description, text) => call('input-text', { selector: { contentDescription: description }, text, hideKeyboard: true }),
    tapFlutter: targetText => call('tap-flutter-text', { targetText }),
    scrollFlutter: async targetText => {
      const tree = await call('flutter-nodes');
      if (tree.nodes.some(node => node.text === targetText && !node.textTruncated || node.label === targetText && !node.labelTruncated)) return { alreadyVisible: true };
      const containers = tree.nodes.filter(node => node.role === 'scrollable' && node.scroll?.axis === 'vertical'
        && node.scroll.maxScrollExtent > node.scroll.minScrollExtent);
      if (containers.length !== 1) throw new Error(`Expected one observed vertical list, got ${containers.length}`);
      return call('scroll-flutter', { targetText, maxSwipes: 8, selector: { nodeId: String(containers[0].id) } });
    },
    phase(value) { phase = value; }, app(value) { app = value; },
    report(error) {
      const report = { ok: !error, elapsedMs: Date.now() - began, phase, error: error ? String(error.message || error) : null, calls: steps.length, checks };
      fs.writeFileSync(path.join(ctx.inputs.outDir, 'details.json'), JSON.stringify({ report, steps }, null, 2));
      return report;
    },
  };
};
