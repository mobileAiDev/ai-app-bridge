#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

// Use the actual CLI/shared Runtime, retaining full replies outside model context.
const [serial, outDir, scenario = 'complex', mode = 'script', cli = path.resolve(__dirname, '../../bin/ai-app-bridge.js')] = process.argv.slice(2);
if (!serial || !outDir) throw new Error('usage: node run-complex-workflow.js SERIAL OUT_DIR [login|complex] [script|intent|python] [CLI_ENTRY]');
fs.mkdirSync(outDir, { recursive: true });
const target = { platform: 'android', serial, packageName: 'io.github.mobileaidev.aiappbridge.sample' };
let rpcCount = 0, bytes = 0;
async function call(command, args = {}) {
  const flags = Object.entries(args).flatMap(([key, value]) => [`--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`,
    typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  const started = Date.now();
  let stdout;
  try { ({ stdout } = await execFile(process.execPath, [cli, command, ...flags], { maxBuffer: 4 * 1024 * 1024 })); }
  catch (e) { if (!e.stdout) throw e; stdout = e.stdout; }
  const reply = JSON.parse(stdout);
  rpcCount++; bytes += Buffer.byteLength(stdout);
  fs.appendFileSync(path.join(outDir, 'replies.jsonl'), JSON.stringify({ command, ms: Date.now() - started, reply }) + '\n');
  if (reply.execution.ok !== true) throw new Error(`${command}: ${reply.execution.error}: ${reply.execution.message || ''}`);
  return reply;
}
async function main() {
  const began = Date.now();
  let report;
  if (scenario === 'login' || scenario === 'login-warm') {
    if (scenario === 'login') await call('adb-exec', { serial, argv: ['shell', 'am', 'force-stop', target.packageName] });
    await call('launch-activity', { serial, packageName: target.packageName, activity: '.intentfixture.IntentLoginFixtureActivity', clearTask: true });
    const intentBegan = Date.now();
    const r = await call('intent', { operation: 'start', goal: `login fixture ${began}`, target, provider: 'native', mode: 'autonomous',
      agentModule: path.join(__dirname, 'login-agent.js'), timeoutMs: 30000, recordingDir: path.join(outDir, 'intent') });
    const intentElapsedMs = Date.now() - intentBegan;
    report = { ok: r.control.status === 'completed', scenario, elapsedMs: Date.now() - began, intentElapsedMs,
      status: r.control.status, operationId: r.control.operationId, revision: r.control.revision,
      rpcCount, bytes, timings: r.value?.timings || null };
  } else {
    const r = await call('script', { operation: 'start', ...(process.env.AAB_ASYNC_BASELINE === '1' ? {} : { waitMs: 60000 }), script: { schemaVersion: 'aab.code-script/v1',
      language: mode === 'python' ? 'python' : 'javascript', sourcePath: path.join(__dirname, mode === 'python' ? 'complex-workflow.py' : 'complex-workflow.js'),
      target, inputs: { mode, outDir }, policy: { timeoutMs: 120000 } } });
    let s = r;
    while (!['completed', 'failed', 'cancelled'].includes(s.control.status)) {
      s = await call('script', { operation: 'wait', operationId: r.control.operationId,
        afterSequence: s.control.eventSequence, waitMs: 60000, eventLimit: 1, limit: 1 });
      if (s.control.status?.startsWith('paused') || s.control.status === 'waiting_for_agent') throw new Error('Script needs an Agent decision; inspect the retained reply.');
    }
    const result = r.value?.result !== undefined ? r : await call('script', { operation: 'result', operationId: r.control.operationId });
    report = { ...result.value.result, scenario, totalMs: Date.now() - began, rpcCount, bytes, operationId: r.control.operationId };
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
