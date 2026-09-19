'use strict';

// Run outside the parallel test suite: cold workers, maximum inputs, no device.
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { freezeResponse, MAX_SNAPSHOT_BYTES } = require('../../bin/response-store');
const { publicReply } = require('../../bin/public-reply');
const { canonicalJson } = require('../../bin/shared-kernel/evidence-schema');
const { prepareExtraction } = require('../../bin/extraction/prepare');
const { runExtraction } = require('../../bin/extraction/runner');
const { inspectPython } = require('../../bin/script/python-runtime-adapter');

function sample(name) {
  const value = name === 'large-text' ? { ok: true, text: '中文'.repeat(500000), padding: '' }
    : { ok: true, nodes: Array.from({ length: 30000 }, (_, id) => ({ id, text: `节点${id}`, checked: id % 2 === 0, enabled: true })), padding: '' };
  const body = publicReply({ command: 'tree', reply: { value } });
  body.control.source.responseId = '00000000-0000-4000-8000-000000000001';
  body.control.source.capturedAtMs = 1700000000000;
  let frozen = freezeResponse(body);
  value.padding = 'x'.repeat(MAX_SNAPSHOT_BYTES - frozen.bytes.length);
  frozen = freezeResponse(body);
  if (frozen.bytes.length !== MAX_SNAPSHOT_BYTES) throw new Error('sample size is not exactly 8 MiB');
  const { kind, value: response, execution, control } = frozen.snapshot;
  return { name, inputs: { kind, response, execution, control }, snapshotBytes: frozen.bytes.length,
    encodedSnapshotBytes: frozen.bytes.toString('base64').length,
    checksum: crypto.createHash('sha256').update(frozen.bytes).digest('hex') };
}
function stats(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return { p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
}
async function main(out) {
  const repeats = 5;
  const report = { at: new Date().toISOString(), environment: { os: os.platform(), arch: os.arch(), release: os.release(),
    cpu: os.cpus()[0].model, cores: os.cpus().length, memoryBytes: os.totalmem(), node: process.version,
    python: inspectPython().version }, repeats, timeoutMs: 2000, samples: [], results: [], deviceCalls: 0 };
  for (const name of ['large-text', 'many-nodes']) {
    const data = sample(name);
    report.samples.push({ name, snapshotBytes: data.snapshotBytes, encodedSnapshotBytes: data.encodedSnapshotBytes, checksum: data.checksum });
    for (const language of ['javascript', 'python']) {
      const source = language === 'javascript' ? 'module.exports.main=ctx=>({keys:Object.keys(ctx.inputs.response),kind:ctx.inputs.kind})'
        : 'def main(ctx):\n return {"keys": list(ctx.inputs["response"].keys()), "kind": ctx.inputs["kind"]}';
      const prepared = prepareExtraction({ mode: 'script', language, source });
      for (const concurrency of [1, 2]) {
        const runs = [];
        for (let i = 0; i < repeats; i++) runs.push(...await Promise.all(Array.from({ length: concurrency }, () => runExtraction(prepared, data.inputs))));
        const successful = runs.filter(item => item.ok);
        const metric = key => stats(successful.map(item => item.timings[key]));
        report.results.push({ sample: name, language, concurrency, runs: runs.length, failures: runs.filter(item => !item.ok).map(item => item.error),
          totalMs: stats(runs.map(item => item.durationMs)), coldStartMs: metric('coldStartMs'), parseMs: metric('inputParseMs'),
          extractionMs: metric('executionMs'), responseMs: metric('responseMs'),
          ipcAndSerializationMs: stats(successful.map(item => item.timings.responseMs - item.timings.coldStartMs - item.timings.inputParseMs - item.timings.executionMs)) });
      }
    }
  }
  report.notes = ['totalMs includes worker termination and temporary-directory cleanup; responseMs stops at the final frame.',
    'ipcAndSerializationMs is the residual after cold start, input parse and extraction; includes Host serialization and scheduling.',
    'Source preflight and snapshot persistence precede the extraction timer and are excluded. This is one reference machine, not a cross-platform performance claim.'];
  report.ok = report.results.every(item => item.failures.length === 0);
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ ok: report.ok, out, maximumMs: Math.max(...report.results.map(item => item.totalMs.max)) }) + '\n');
}
if (require.main === module) main(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { sample, main };
