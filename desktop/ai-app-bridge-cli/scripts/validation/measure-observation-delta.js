#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const { decode } = require('./response-delta-consumer');
const [command, argumentsText, outDir, changeText] = process.argv.slice(2);
if (!outDir) throw new Error('usage: measure-observation-delta.js COMMAND ARGUMENTS_JSON OUT_DIR [CHANGE_JSON]');
fs.mkdirSync(outDir, { recursive: true });
const cli = path.resolve(__dirname, '../../bin/ai-app-bridge.js'), args = JSON.parse(argumentsText);
async function call(command, args, name) {
  const flags = Object.entries(args).flatMap(([key, value]) => [`--${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}`,
    typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  const began = Date.now();
  let stdout;
  try { ({ stdout } = await execFile(process.execPath, [cli, command, ...flags], { maxBuffer: 8 * 1024 * 1024 })); }
  catch (error) { if (!error.stdout) throw error; stdout = error.stdout; }
  fs.writeFileSync(path.join(outDir, name + '.json'), stdout);
  const reply = JSON.parse(stdout);
  assert.equal(reply.execution.ok, true, JSON.stringify(reply.execution));
  return { reply, ms: Date.now() - began, bytes: Buffer.byteLength(stdout) };
}
async function main() {
  const samples = [], mutations = []; let previous, base;
  for (let i = 0; i < (changeText ? 3 : 2); i++) {
    if (i === 2) {
      const change = JSON.parse(changeText);
      if (change.targetRefFrom) {
        assert.equal(change.command, 'tap-uia');
        const matches = samples.at(-1).decoded.value.nodes.filter(node => Object.entries(change.targetRefFrom).every(([key, value]) => node[key] === value));
        assert.equal(matches.length, 1); assert(matches[0].targetRef);
        change.arguments.targetRef = matches[0].targetRef;
      }
      const result = await call(change.command, change.arguments, 'change');
      mutations.push({ command: change.command, ms: result.ms, bytes: result.bytes });
    }
    const sample = await call(command, { ...args, extract: { mode: 'delta', ...(base ? { base } : {}) } }, 'sample-' + i);
    const decoded = decode(sample.reply.value, previous);
    samples.push({ ...sample, decoded });
    previous = decoded.data; base = sample.reply.control.source.ref;
  }
  const report = { command, arguments: args, measurementCalls: samples.length, mutationCalls: mutations.length, mutations, oracleCalls: 0, samples: [] };
  // These saved-response reads are an independent validation oracle, outside
  // the observation measurement. They never collect another tree.
  for (const [i, sample] of samples.entries()) {
    const oracle = await call('response', { operation: 'read', ref: sample.reply.control.source.ref,
      extract: null, output: { maxBytes: 262144 } }, 'oracle-' + i);
    report.oracleCalls++;
    assert.equal(oracle.reply.delivery.status, 'inline');
    assert.deepEqual(sample.decoded.value, oracle.reply.value);
    report.samples.push({ ms: sample.ms, bytes: sample.bytes, mode: sample.reply.value.mode, exactReconstruction: true,
      originalValueBytes: Buffer.byteLength(JSON.stringify(oracle.reply.value)), operations: sample.reply.value.operations?.length || 0 });
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'latest-value.json'), JSON.stringify(samples.at(-1).decoded.value, null, 2));
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
