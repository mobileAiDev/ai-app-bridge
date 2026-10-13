'use strict';

// A read-only warmed-page sample. It deliberately excludes app launch/readiness.
module.exports.main = async ctx => {
  const fs = require('node:fs'), path = require('node:path'), reads = [];
  for (let index = 0; index < 30; index++) {
    const began = Date.now(), reply = await ctx.call('flutter-nodes');
    reads.push({ index, ms: Date.now() - began, reply });
  }
  fs.writeFileSync(path.join(ctx.inputs.outDir, 'reads.json'), JSON.stringify(reads, null, 2));
  const times = reads.map(read => read.ms).sort((a, b) => a - b);
  return { ok: reads.every(read => read.reply.ok), calls: reads.length, scope: 'already displayed page; launch/readiness excluded',
    medianMs: (times[14] + times[15]) / 2, minMs: times[0], maxMs: times.at(-1),
    totalReadMs: times.reduce((a, b) => a + b, 0),
    samples: reads.map(read => ({ ms: read.ms, ok: read.reply.ok, error: read.reply.error, nodes: read.reply.result?.nodes?.length })) };
};
