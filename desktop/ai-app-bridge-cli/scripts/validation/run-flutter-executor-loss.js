#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const [serial, serverDirectory, output, mode = 'business'] = process.argv.slice(2);
if (!serial || !serverDirectory || !output || !['fixture', 'business'].includes(mode) || !process.env.AI_APP_BRIDGE_FACT_STORE_DIR)
  throw new Error('usage: AI_APP_BRIDGE_FACT_STORE_DIR=ISOLATED_FACTS run-flutter-executor-loss.js SERIAL SERVER_DIR NEW_OUT_DIR [fixture|business]');
const outDir = path.resolve(output), sourceDir = path.join(outDir, 'sources');
const cli = process.env.AAB_VALIDATION_CLI_PATH
  ? path.resolve(process.env.AAB_VALIDATION_CLI_PATH) : path.resolve(__dirname, '../../bin/ai-app-bridge.js');
fs.mkdirSync(outDir); fs.mkdirSync(sourceDir);
let rpcCount = 0, responseBytes = 0;
async function call(args) {
  const flags = Object.entries(args).flatMap(([key, value]) => [`--${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}`,
    typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  let stdout;
  try { ({ stdout } = await execFile(process.execPath, [cli, 'script', ...flags], { maxBuffer: 8 * 1024 * 1024 })); }
  catch (error) { if (!error.stdout) throw error; stdout = error.stdout; }
  rpcCount++; responseBytes += Buffer.byteLength(stdout);
  const reply = JSON.parse(stdout);
  fs.appendFileSync(path.join(outDir, 'replies.jsonl'), JSON.stringify({ atMs: Date.now(), args, reply }) + '\n');
  assert(reply.execution.ok, JSON.stringify(reply.execution));
  return reply;
}
async function main() {
  const hashes = {};
  for (const name of ['flutter-executor-loss.js', 'run-flutter-executor-loss.js', 'city-flow.js', 'lab-client.js', 'permission-probe.js']) {
    const source = fs.readFileSync(path.join(__dirname, name));
    fs.writeFileSync(path.join(sourceDir, name), source);
    hashes[name] = createHash('sha256').update(source).digest('hex');
  }
  fs.writeFileSync(path.join(outDir, 'source-manifest.json'), JSON.stringify(hashes, null, 2));
  const { port } = JSON.parse(fs.readFileSync(path.join(serverDirectory, 'endpoint.json')));
  const hostBase = `http://127.0.0.1:${port}`, runId = randomUUID();
  const config = { focusInputs: false, delayMs: 200, paymentResponseLostOnce: true };
  if (mode === 'business') {
    const setup = await fetch(`${hostBase}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: `${runId}-business`, config }) });
    assert(setup.ok);
  }
  const spec = { schemaVersion: 'aab.code-script/v1', language: 'javascript', sourcePath: path.join(sourceDir, 'flutter-executor-loss.js'),
    target: { platform: 'android', serial, packageName: 'io.github.mobileaidev.bridge_workflow_lab' },
    inputs: { outDir, runId, business: mode === 'business', hostBase, deviceBase: `http://10.0.2.2:${port}`, config },
    policy: { restartPolicy: 'checkpoint', timeoutMs: 240000 } };
  fs.writeFileSync(path.join(outDir, 'scenario.json'), JSON.stringify(spec, null, 2));
  const began = Date.now();
  let reply = await call({ operation: 'start', waitMs: 60000, script: spec });
  const operationId = reply.control.operationId;
  while (['starting', 'running', 'finishing'].includes(reply.control.status))
    reply = await call({ operation: 'wait', operationId, afterSequence: reply.control.eventSequence, waitMs: 60000, eventLimit: 1 });
  if (reply.control.status === 'completed' && reply.value?.result === undefined)
    reply = await call({ operation: 'result', operationId });
  const uiMs = Date.now() - began, result = reply.value?.result;
  const report = { ...result, runId, operationId, status: reply.control.status, uiMs, rpcCount, responseBytes,
    ok: reply.control.status === 'completed' && result?.ok === true,
    ...(reply.control.status !== 'completed' ? { failure: reply.value } : {}) };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  if (report.ok && mode === 'business') {
    const response = await fetch(`${hostBase}/__state?run=${encodeURIComponent(runId + '-business')}`);
    assert(response.ok); const state = await response.json();
    fs.writeFileSync(path.join(outDir, 'server-state.json'), JSON.stringify(state, null, 2));
    const order = state.commerce.orders.BUY1;
    report.server = { sessions: state.sessions, orderAttempts: state.commerce.orderAttempts,
      paymentAttempts: state.commerce.paymentAttempts, orderStatus: order.status, ledger: state.commerce.ledger,
      stock: state.commerce.products[0].variants[0].stock, faults: state.commerce.faults };
    report.server.ok = state.sessions === 1 && state.commerce.orderAttempts === 1 && state.commerce.paymentAttempts === 1
      && order.status === 'refunded' && report.server.stock === 12
      && JSON.stringify(state.commerce.ledger.map(item => [item.type, item.amount])) === JSON.stringify([['payment', 4100], ['refund', 4100]])
      && state.commerce.faults.includes('payment_response_lost');
    report.ok = report.server.ok;
  }
  report.totalWithOracleMs = Date.now() - began;
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
main().catch(error => { fs.writeFileSync(path.join(outDir, 'failure.txt'), error.stack); console.error(error.stack); process.exitCode = 1; });
