'use strict';

// One real JavaScript program owns all three workflows and their checkpoints.
// Test faults deliberately stop only after an entire verified case is committed.
module.exports.main = async ctx => {
  const fs = require('node:fs'), path = require('node:path');
  const run = require(path.join(ctx.inputs.sourceDir, ctx.inputs.flowSource || 'native-city-flow.js')).main;
  const checkpoint = ctx.resume() || ctx.inputs.initialCheckpoint || { completed: 0, reports: [] };
  const reports = checkpoint.reports.slice(), started = Date.now();
  for (let i = checkpoint.completed; i < ctx.inputs.cases.length; i++) {
    const fixture = ctx.inputs.cases[i];
    const inputs = { ...ctx.inputs, ...fixture, helperPath: path.join(ctx.inputs.sourceDir, 'lab-client.js') };
    const result = await run({ ...ctx, inputs });
    reports.push({ case: fixture.name, runId: fixture.runId, ...result });
    if (!result.ok) return { ok: false, reports, error: 'workflow_failed', commands: reports.reduce((n, r) => n + r.calls, 0) };
    const next = { completed: i + 1, reports };
    await ctx.checkpoint(`case-${i + 1}-verified`, next);
    fs.writeFileSync(path.join(ctx.inputs.outDir, 'last-checkpoint.json'), JSON.stringify(next, null, 2));
    if (ctx.inputs.crashAfterCase === i + 1) process.exit(31);
    if (ctx.inputs.pauseAfterCase === i + 1 && !ctx.inputs.initialCheckpoint) {
      await ctx.askAgent({ reason: 'Deliberate cancellation probe at a verified workflow boundary', question: 'Continue with the remaining cases?', context: { completed: i + 1 } });
    }
  }
  return { ok: true, resumedAfter: checkpoint.completed, elapsedMs: Date.now() - started,
    commands: reports.reduce((n, r) => n + r.calls, 0), reports };
};
