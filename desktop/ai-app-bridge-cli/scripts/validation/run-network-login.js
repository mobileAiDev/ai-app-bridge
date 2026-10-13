#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path');
const { promisify } = require('node:util'), execFile = promisify(require('node:child_process').execFile);
const [serial, serverDir, outDir, deviceBaseUrl] = process.argv.slice(2);
if (!serial || !serverDir || !outDir) throw Error('usage: run-network-login.js SERIAL SERVER_DIR NEW_OUTPUT_DIR [DEVICE_BASE_URL]');
fs.mkdirSync(outDir);
const target = { platform: 'android', serial, packageName: 'io.github.mobileaidev.aiappbridge.sample' };
const port = JSON.parse(fs.readFileSync(path.join(serverDir, 'endpoint.json'))).port;
const hostBase = `http://127.0.0.1:${port}`, runId = `intent-login-${Date.now()}`;
let rpcCount = 0, bytes = 0;
async function call(command, args) {
  const flags = Object.entries(args).flatMap(([key, value]) => key === 'extra'
    ? value.flatMap(item => ['--extra', item])
    : [`--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  const started = Date.now();
  let stdout;
  try { ({ stdout } = await execFile(process.execPath, [path.resolve(__dirname, '../../bin/ai-app-bridge.js'), command, ...flags], { maxBuffer: 8e6 })); }
  catch (error) { if (!error.stdout) throw error; stdout = error.stdout; }
  const reply = JSON.parse(stdout);
  rpcCount++; bytes += Buffer.byteLength(stdout);
  fs.appendFileSync(path.join(outDir, 'replies.jsonl'), JSON.stringify({ command, ms: Date.now() - started, reply }) + '\n');
  if (!reply.execution.ok) throw Error(`${command}: ${reply.execution.error}`);
  return reply;
}
async function main() {
  const setup = await fetch(`${hostBase}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId, config: {} }) });
  if (!setup.ok) throw Error('fixture setup failed');
  const began = Date.now();
  await call('launch-activity', { serial, packageName: target.packageName, activity: '.NativeCommerceActivity', clearTask: true,
    extra: [`lab_base_url=${deviceBaseUrl ?? `http://10.0.2.2:${port}`}`, `lab_run=${runId}`] });
  await call('wait-text', { serial, packageName: target.packageName, provider: 'native', targetText: '原生账号登录', timeoutMs: 15000, intervalMs: 50 });
  const intentBegan = Date.now(), beforeBytes = bytes, beforeCalls = rpcCount;
  const result = await call('intent', { operation: 'start', target, provider: 'native', mode: 'autonomous',
    goal: `Complete the observed native HTTP login for ${runId}`, agentModule: path.join(__dirname, 'network-login-agent.js'), timeoutMs: 20000,
    recordingDir: path.join(outDir, 'intent') });
  const intentMs = Date.now() - intentBegan;
  const state = await (await fetch(`${hostBase}/__state?run=${encodeURIComponent(runId)}`)).json();
  fs.writeFileSync(path.join(outDir, 'server-state.json'), JSON.stringify(state, null, 2));
  const report = { ok: result.control.status === 'completed' && state.sessions === 1, runId, operationId: result.control.operationId,
    status: result.control.status, totalMs: Date.now() - began, intentMs, intentRpcCount: rpcCount - beforeCalls,
    rpcCount, intentBytes: bytes - beforeBytes, bytes, sessions: state.sessions, revision: result.control.revision };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
