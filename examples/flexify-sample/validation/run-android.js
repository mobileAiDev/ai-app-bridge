#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), path = require('node:path');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const [serial, output, mode = 'workout', option] = process.argv.slice(2);
const provider = mode === 'startup' ? option ?? 'flutter' : undefined;
const observationFreeMs = mode === 'startup-passive' ? Number(option ?? 45000) : undefined;
if (!serial || !output || !['workout', 'discovery', 'snapshot', 'reads', 'startup', 'startup-passive'].includes(mode)
    || mode === 'startup' && !['flutter', 'uia'].includes(provider)
    || mode === 'startup-passive' && (!Number.isInteger(observationFreeMs) || observationFreeMs <= 0)
    || !['startup', 'startup-passive'].includes(mode) && option !== undefined || process.argv.length > 6) {
  throw new Error('usage: run-android.js SERIAL NEW_OUTPUT_DIRECTORY [workout|discovery|snapshot|reads|startup|startup-passive] [flutter|uia for startup, passive milliseconds for startup-passive]');
}
const outDir = path.resolve(output), cli = process.env.AAB_VALIDATION_CLI_PATH
  ? path.resolve(process.env.AAB_VALIDATION_CLI_PATH)
  : path.resolve(__dirname, '../../../desktop/ai-app-bridge-cli/bin/ai-app-bridge.js');
fs.mkdirSync(outDir);
const sourcePath = path.join(outDir, 'program.js');
fs.copyFileSync(path.join(__dirname, `android-${mode}.js`), sourcePath);
const spec = { schemaVersion: 'aab.code-script/v1', language: 'javascript', sourcePath,
  target: { platform: 'android', serial, packageName: 'com.presley.flexify.bridge_sample' },
  inputs: { outDir, ...(mode === 'workout' ? { planTitle: `Bridge-${Date.now()}` } : {}),
    ...(mode === 'startup' ? { provider } : {}),
    ...(mode === 'startup-passive' ? { observationFreeMs } : {}) },
  policy: { timeoutMs: mode === 'startup-passive' ? Math.max(120000, observationFreeMs + 30000) : 120000 } };
fs.writeFileSync(path.join(outDir, 'scenario.json'), JSON.stringify(spec, null, 2));
let rpcCount = 0, responseBytes = 0;
async function call(args) {
  const flags = Object.entries(args).flatMap(([key, value]) => [`--${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}`,
    typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  let stdout;
  try { ({ stdout } = await execFile(process.execPath, [cli, 'script', ...flags], { maxBuffer: 8 * 1024 * 1024 })); }
  catch (error) { if (!error.stdout) throw error; stdout = error.stdout; }
  rpcCount++; responseBytes += Buffer.byteLength(stdout);
  const reply = JSON.parse(stdout);
  fs.appendFileSync(path.join(outDir, 'replies.jsonl'), JSON.stringify(reply) + '\n');
  if (!reply.execution.ok) throw new Error(JSON.stringify(reply.execution));
  return reply;
}
async function main() {
  const began = Date.now();
  let reply = await call({ operation: 'start', waitMs: 60000, script: spec });
  const operationId = reply.control.operationId;
  while (!['completed', 'failed', 'cancelled'].includes(reply.control.status)) {
    if (reply.control.status.startsWith('paused') || reply.control.status === 'waiting_for_agent') {
      throw new Error(`Continue the original Script ${operationId}: ${reply.control.status}`);
    }
    reply = await call({ operation: 'wait', operationId, afterSequence: reply.control.eventSequence, waitMs: 60000, eventLimit: 1 });
  }
  if (reply.value?.result === undefined && reply.control.resultRef) reply = await call({ operation: 'result', operationId });
  const result = reply.value?.result;
  const report = { ...result, mode, operationId, status: reply.control.status,
    ok: reply.control.status === 'completed' && result?.ok === true,
    totalMs: Date.now() - began, rpcCount, responseBytes };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, ...(report.nodes ? { nodes: report.nodes.length } : {}) }));
  if (!report.ok) process.exitCode = 1;
}
main().catch(error => { fs.writeFileSync(path.join(outDir, 'failure.txt'), error.stack); console.error(error.message); process.exitCode = 1; });
