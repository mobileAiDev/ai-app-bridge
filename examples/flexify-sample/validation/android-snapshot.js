'use strict';

// Copy only the observed SQLite database/journals after this sample has stopped.
// The separate read-workout.py oracle checks business values in a read copy.
module.exports.main = async ctx => {
  const fs = require('node:fs'), path = require('node:path');
  const pkg = ctx.target.packageName, outDir = ctx.inputs.outDir, steps = [];
  const snapshot = path.join(outDir, 'database');
  fs.mkdirSync(snapshot);
  async function adb(argv, options = {}) {
    const reply = await ctx.call('adb-exec', { argv, ...options });
    steps.push({ argv, reply });
    fs.writeFileSync(path.join(outDir, 'snapshot-steps.json'), JSON.stringify(steps, null, 2));
    return reply;
  }
  function completed(reply) {
    if (!reply.ok || reply.ambiguous || reply.result?.exitCode !== 0) throw new Error(reply.error || 'ADB command did not complete');
    return reply.result;
  }
  async function absent() {
    const reply = await adb(['shell', 'pidof', pkg], { readOnly: true });
    if (reply.ambiguous || reply.result?.exitCode !== 1 || reply.result?.stdout !== '' || reply.result?.stderr !== '') {
      throw new Error('The exact sample process is not confirmed absent');
    }
  }
  completed(await adb(['shell', 'am', 'force-stop', pkg]));
  await absent();
  const listed = completed(await adb(['shell', 'run-as', pkg, 'find', 'app_flutter', '-maxdepth', '1', '-name', 'flexify.sqlite*', '-type', 'f'], { readOnly: true }));
  const files = listed.stdout.trim().split('\n');
  if (!files.includes('app_flutter/flexify.sqlite') || files.some(file => !/^app_flutter\/flexify\.sqlite(?:-wal|-shm|-journal)?$/.test(file))) {
    throw new Error('Unexpected database file inventory');
  }
  for (const file of files) completed(await adb(['exec-out', 'run-as', pkg, 'cat', file], {
    readOnly: true, outFile: path.join(snapshot, path.basename(file)),
  }));
  await absent();
  return { ok: true, packageName: pkg, snapshot, files, processAbsentBeforeAndAfter: true, calls: steps.length };
};
