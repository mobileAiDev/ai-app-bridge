'use strict';

// Endurance and checkpoint recovery against the same SDK-free upstream App.
module.exports.main = async ctx => {
  const fs = require('node:fs'), path = require('node:path');
  const run = require(path.join(ctx.inputs.sourceDir, 'uia-regression.js')).main;
  const checkpoint = ctx.resume() || { completed: 0, reports: [] };
  const reports = checkpoint.reports.slice(), began = Date.now();
  for (let i = checkpoint.completed; i < ctx.inputs.cases.length; i++) {
    const fixture = ctx.inputs.cases[i];
    const result = await run({ ...ctx, inputs: fixture });
    reports.push(result);
    const commands = reports.reduce((sum, report) => sum + report.commands, 0);
    if (!result.ok) return { ok: false, commands, reports };
    const next = { completed: i + 1, reports };
    await ctx.checkpoint(`note-${i + 1}-persisted-and-reopened`, next);
    fs.writeFileSync(path.join(ctx.inputs.outDir, 'last-checkpoint.json'), JSON.stringify(next, null, 2));
    if (ctx.inputs.crashAfterCase === i + 1) process.exit(31);
  }
  return { ok: true, resumedAfter: checkpoint.completed, elapsedMs: Date.now() - began,
    commands: reports.reduce((sum, report) => sum + report.commands, 0), reports };
};
