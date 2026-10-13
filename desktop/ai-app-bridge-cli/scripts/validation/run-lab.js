#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

const [serial, serverDirectory, outDir, scenario = 'commerce', configText = '{}'] = process.argv.slice(2);
if (!serial || !serverDirectory || !outDir || !['commerce', 'city', 'native-city', 'native-h5-flutter', 'keyboard-visibility'].includes(scenario)) throw new Error('usage: run-lab.js SERIAL SERVER_DIR NEW_OUT_DIR [commerce|city|native-city|native-h5-flutter|keyboard-visibility] [CONFIG_JSON]');
const endpoint = JSON.parse(fs.readFileSync(path.join(serverDirectory, 'endpoint.json')));
const runId = `${scenario}-${Date.now()}`;
const hostBase = `http://127.0.0.1:${endpoint.port}`, deviceBase = `http://10.0.2.2:${endpoint.port}`;
const cli = path.resolve(__dirname, '../../bin/ai-app-bridge.js');
fs.mkdirSync(outDir);
const sourceDirectory = path.join(outDir, 'script-source');
fs.mkdirSync(sourceDirectory);
for (const file of [`${scenario}-flow.js`, 'lab-client.js', 'permission-probe.js']) {
  fs.copyFileSync(path.join(__dirname, file), path.join(sourceDirectory, file));
}
let rpcCount = 0, bytes = 0;
async function call(command, args) {
  const flags = Object.entries(args).flatMap(([name, value]) => [`--${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  let stdout;
  try { ({ stdout } = await execFile(process.execPath, [cli, command, ...flags], { maxBuffer: 8 * 1024 * 1024 })); }
  catch (error) { if (!error.stdout) throw error; stdout = error.stdout; }
  rpcCount++; bytes += Buffer.byteLength(stdout);
  const reply = JSON.parse(stdout);
  fs.appendFileSync(path.join(outDir, 'replies.jsonl'), JSON.stringify({ command, reply }) + '\n');
  if (!reply.execution.ok) throw new Error(JSON.stringify(reply.execution));
  return reply;
}
async function main() {
  const config = JSON.parse(configText);
  const setup = await fetch(`${hostBase}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId, config }) });
  if (!setup.ok) throw new Error('Server fixture setup failed');
  const target = { platform: 'android', serial, packageName: ['commerce', 'city', 'keyboard-visibility'].includes(scenario) ? 'io.github.mobileaidev.bridge_workflow_lab' : 'io.github.mobileaidev.aiappbridge.sample' };
  fs.writeFileSync(path.join(outDir, 'scenario.json'), JSON.stringify({ runId, scenario, config, target, deviceBase, hostBase }, null, 2));
  const began = Date.now();
  const started = await call('script', { operation: 'start', waitMs: 60000, script: { schemaVersion: 'aab.code-script/v1', language: 'javascript',
    sourcePath: path.join(sourceDirectory, `${scenario}-flow.js`), target,
    inputs: { runId, deviceBase, hostBase, config, outDir, helperPath: path.join(sourceDirectory, 'lab-client.js') }, policy: { timeoutMs: 180000 } } });
  let result = started;
  while (!['completed', 'failed', 'cancelled'].includes(result.control.status)) {
    if (result.control.status === 'waiting_for_agent' || result.control.status.startsWith('paused')) throw new Error(`Needs decision: ${result.control.operationId}`);
    result = await call('script', { operation: 'wait', operationId: started.control.operationId, afterSequence: result.control.eventSequence, waitMs: 60000, eventLimit: 1 });
  }
  if (result.value?.result === undefined && result.control.resultRef) result = await call('script', { operation: 'result', operationId: started.control.operationId });
  const uiMs = Date.now() - began;
  const state = await (await fetch(`${hostBase}/__state?run=${encodeURIComponent(runId)}`)).json();
  fs.writeFileSync(path.join(outDir, 'server-state.json'), JSON.stringify(state, null, 2));
  const localDetails = path.join(outDir, 'details.json');
  const programResult = result.value?.result ?? (fs.existsSync(localDetails) ? JSON.parse(fs.readFileSync(localDetails)).report : undefined);
  const report = { ...programResult, ok: result.control.status === 'completed' && programResult?.ok === true,
    reportSource: result.value?.result === undefined ? 'script-local-diagnostics' : 'persisted-script-result',
    executionError: result.value?.executionError || null, status: result.control.status, operationId: started.control.operationId, runId,
    uiMs, totalWithOracleMs: Date.now() - began, rpcCount, bytes, server: { sessions: state.sessions, orders: Object.keys(state.orders).length,
      saveAttempts: state.saveAttempts, approvals: state.approvals, flutterUpdates: state.flutterUpdates,
      purchases: Object.keys(state.commerce.orders).length, paymentAttempts: state.commerce.paymentAttempts, ledger: state.commerce.ledger } };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
