#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const [serial, output] = process.argv.slice(2);
if (!serial || !output || !process.env.AI_APP_BRIDGE_FACT_STORE_DIR)
  throw new Error('usage: AI_APP_BRIDGE_FACT_STORE_DIR=ISOLATED_FACTS run-python-module-recovery.js SERIAL NEW_OUT_DIR');
const outDir = path.resolve(output), sourceDir = path.join(outDir, 'sources'), cwd = path.join(outDir, 'work');
const cli = path.resolve(__dirname, '../../bin/ai-app-bridge.js');
fs.mkdirSync(outDir); fs.mkdirSync(sourceDir); fs.mkdirSync(cwd);
let rpcCount = 0, responseBytes = 0;
async function call(command, args) {
  const flags = Object.entries(args).flatMap(([key, value]) => [`--${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}`,
    typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  const atMs = Date.now();
  let stdout;
  try { ({ stdout } = await execFile(process.execPath, [cli, command, ...flags], { maxBuffer: 8 * 1024 * 1024 })); }
  catch (error) { if (!error.stdout) throw error; stdout = error.stdout; }
  rpcCount++; responseBytes += Buffer.byteLength(stdout);
  const reply = JSON.parse(stdout);
  fs.appendFileSync(path.join(outDir, 'replies.jsonl'), JSON.stringify({ atMs, ms: Date.now() - atMs, command, args, reply }) + '\n');
  assert(reply.execution.ok, JSON.stringify(reply.execution));
  return reply;
}
async function settle(reply) {
  const operationId = reply.control.operationId;
  while (['starting', 'running', 'finishing'].includes(reply.control.status))
    reply = await call('script', { operation: 'wait', operationId, afterSequence: reply.control.eventSequence, waitMs: 60000, eventLimit: 1 });
  if (reply.control.status === 'completed' && reply.value?.result === undefined)
    reply = await call('script', { operation: 'result', operationId });
  return reply;
}
async function main() {
  const entry = `import os
from pathlib import Path
from complex_workflow import main as workflow

def main(ctx):
    if ctx.resume() is None:
        ctx.checkpoint("before-native-flow", {"phase": "run-native-flow"})
        os._exit(31)
    if ctx.resume()["phase"] != "run-native-flow":
        raise RuntimeError("Unexpected continuation")
    report = workflow(ctx)
    report["entryFrozen"] = True
    report["moduleSource"] = str(Path(__file__).with_name("complex_workflow.py"))
    report["cwd"] = os.getcwd()
    return report
`;
  const sourcePath = path.join(sourceDir, 'entry.py');
  fs.writeFileSync(sourcePath, entry); fs.writeFileSync(path.join(sourceDir, 'entry.original.py'), entry);
  fs.copyFileSync(path.join(__dirname, 'complex-workflow.py'), path.join(sourceDir, 'complex_workflow.py'));
  fs.copyFileSync(__filename, path.join(sourceDir, 'runner.js'));
  const hashes = Object.fromEntries(fs.readdirSync(sourceDir).map(name => [name,
    createHash('sha256').update(fs.readFileSync(path.join(sourceDir, name))).digest('hex')]));
  fs.writeFileSync(path.join(outDir, 'source-manifest.json'), JSON.stringify(hashes, null, 2));
  const spec = { schemaVersion: 'aab.code-script/v1', language: 'python', sourcePath, cwd,
    target: { platform: 'android', serial, packageName: 'io.github.mobileaidev.aiappbridge.sample' },
    inputs: { outDir }, policy: { restartPolicy: 'checkpoint', timeoutMs: 120000 } };
  fs.writeFileSync(path.join(outDir, 'scenario.json'), JSON.stringify(spec, null, 2));
  const began = Date.now();
  const originalHost = (await call('runtime', { operation: 'status' })).value;
  assert.equal(originalHost.status, 'running'); assert.equal(originalHost.compatible, true);
  assert.equal(path.resolve(originalHost.facts), path.resolve(process.env.AI_APP_BRIDGE_FACT_STORE_DIR));
  const interrupted = await settle(await call('script', { operation: 'start', waitMs: 60000, script: spec }));
  const operationId = interrupted.control.operationId;
  assert.equal(interrupted.control.status, 'failed', JSON.stringify(interrupted));
  assert.equal(interrupted.value.error, 'child_crashed');
  // Recovery must use the saved entry while importing the unchanged helper
  // beside its original declared path, even though this file now differs.
  fs.writeFileSync(sourcePath, 'raise RuntimeError("Changed entry must never execute on resume")\n');
  const resumedAtMs = Date.now();
  const stopped = await call('runtime', { operation: 'stop' });
  assert.equal(stopped.value.runtimeId, originalHost.runtimeId); assert.equal(stopped.value.status, 'stopped');
  const replacementHost = (await call('runtime', { operation: 'start' })).value;
  assert.equal(replacementHost.status, 'running'); assert.notEqual(replacementHost.runtimeId, originalHost.runtimeId);
  const restored = await call('script', { operation: 'status', operationId });
  assert.equal(restored.value.restored, true); assert.equal(restored.value.error, 'child_crashed');
  const resumed = await settle(await call('script', { operation: 'resume', operationId, waitMs: 60000 }));
  const result = resumed.value?.result;
  const report = { ...result, operationId, status: resumed.control.status,
    totalMs: Date.now() - began, continuationMs: Date.now() - resumedAtMs, rpcCount, responseBytes,
    hostBefore: originalHost.runtimeId, hostAfter: replacementHost.runtimeId, restoredFromDisk: true,
    originalEntryReplacedAfterCheckpoint: true,
    ok: resumed.control.status === 'completed' && result?.ok === true && result?.entryFrozen === true && result?.cwd === cwd };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
main().catch(error => { fs.writeFileSync(path.join(outDir, 'failure.txt'), error.stack); console.error(error.stack); process.exitCode = 1; });
