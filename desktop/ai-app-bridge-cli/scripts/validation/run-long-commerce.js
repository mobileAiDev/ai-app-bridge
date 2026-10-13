#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const [serial, serverDir, outDir, mode = 'normal', targetKind = 'native'] = process.argv.slice(2);
if (!outDir || !['normal', 'crash', 'cancel'].includes(mode) || !['native', 'mixed'].includes(targetKind)) {
  throw new Error('usage: run-long-commerce.js SERIAL SERVER_DIR NEW_OUT_DIR [normal|crash|cancel] [native|mixed]');
}
const endpoint = JSON.parse(fs.readFileSync(path.join(serverDir, 'endpoint.json')));
const hostBase = `http://127.0.0.1:${endpoint.port}`, deviceBase = `http://10.0.2.2:${endpoint.port}`;
const cli = path.resolve(__dirname, '../../bin/ai-app-bridge.js'), sourceDir = path.resolve(outDir, 'sources');
fs.mkdirSync(outDir);
fs.mkdirSync(sourceDir);
const flowSource = targetKind === 'mixed' ? 'city-flow.js' : 'native-city-flow.js';
const sources = ['run-long-commerce.js', 'long-native-commerce.js', flowSource, 'lab-client.js', 'permission-probe.js'];
const sourceHashes = {};
for (const name of sources) {
  const source = fs.readFileSync(path.join(__dirname, name));
  fs.writeFileSync(path.join(sourceDir, name), source);
  sourceHashes[name] = require('node:crypto').createHash('sha256').update(source).digest('hex');
}
fs.writeFileSync(path.join(outDir, 'source-manifest.json'), JSON.stringify(sourceHashes, null, 2));
let rpcCount = 0, responseBytes = 0;
async function call(args) {
  const flags = Object.entries(args).flatMap(([key, value]) => [`--${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}`, typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  let stdout;
  try { ({ stdout } = await execFile(process.execPath, [cli, 'script', ...flags], { maxBuffer: 8 * 1024 * 1024 })); }
  catch (error) { if (!error.stdout) throw error; stdout = error.stdout; }
  rpcCount++; responseBytes += Buffer.byteLength(stdout);
  const reply = JSON.parse(stdout);
  fs.appendFileSync(path.join(outDir, 'replies.jsonl'), JSON.stringify({ operation: args.operation, reply }) + '\n');
  return reply;
}
async function settle(reply) {
  while (!['completed', 'failed', 'cancelled', 'waiting_for_agent'].includes(reply.control.status)) {
    assert(reply.execution.ok, JSON.stringify(reply.execution));
    reply = await call({ operation: 'wait', operationId: reply.control.operationId, afterSequence: reply.control.eventSequence, waitMs: 60000, eventLimit: 1 });
  }
  if (reply.control.status === 'completed' && reply.value?.result === undefined) reply = await call({ operation: 'result', operationId: reply.control.operationId });
  return reply;
}
async function main() {
  const id = `${mode}-${Date.now()}`;
  const second = targetKind === 'mixed'
    ? { name: 'expired-session', config: { expireSessionOnceAt: '/api/shop/quote' } }
    : { name: 'price-changed', config: { stalePriceOnce: true } };
  const cases = [ { name: 'normal', config: {} }, second,
    { name: 'payment-response-lost', config: { paymentResponseLostOnce: true } } ].map((c, i) => ({ ...c,
    config: { delayMs: 200, ...(targetKind === 'mixed' ? { focusInputs: false } : {}), ...c.config },
    runId: `${id}-${i}`, outDir: path.join(outDir, c.name) }));
  for (const c of cases) {
    fs.mkdirSync(c.outDir, { recursive: true });
    const response = await fetch(`${hostBase}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: c.runId, config: c.config }) });
    assert(response.ok);
  }
  const spec = { schemaVersion: 'aab.code-script/v1', language: 'javascript', sourcePath: path.join(sourceDir, 'long-native-commerce.js'),
    target: { platform: 'android', serial, packageName: targetKind === 'mixed'
      ? 'io.github.mobileaidev.bridge_workflow_lab' : 'io.github.mobileaidev.aiappbridge.sample' },
    inputs: { hostBase, deviceBase, sourceDir, flowSource, outDir, cases, ...(mode === 'crash' ? { crashAfterCase: 1 } : {}), ...(mode === 'cancel' ? { pauseAfterCase: 1 } : {}) },
    policy: { restartPolicy: 'checkpoint', timeoutMs: 180000 } };
  fs.writeFileSync(path.join(outDir, 'scenario.json'), JSON.stringify({ mode, spec }, null, 2));
  const began = Date.now(), operationIds = [];
  let result = await call({ operation: 'start', waitMs: 60000, script: spec });
  operationIds.push(result.control.operationId);
  result = await settle(result);
  let recovery;
  if (mode === 'crash') {
    assert.equal(result.control.status, 'failed', JSON.stringify(result));
    assert.equal(result.value.error, 'child_crashed', JSON.stringify(result));
    const resumedAt = Date.now();
    result = await settle(await call({ operation: 'resume', operationId: operationIds[0], waitMs: 60000 }));
    recovery = { type: 'same-operation-checkpoint-reentry', continuationMs: Date.now() - resumedAt };
  } else if (mode === 'cancel') {
    assert.equal(result.control.status, 'waiting_for_agent', JSON.stringify(result));
    const cancelledAt = Date.now();
    const cancelled = await settle(await call({ operation: 'cancel', operationId: operationIds[0] }));
    assert.equal(cancelled.control.status, 'cancelled', JSON.stringify(cancelled));
    const afterCancel = [];
    for (const c of cases) {
      const state = await (await fetch(`${hostBase}/__state?run=${encodeURIComponent(c.runId)}`)).json();
      afterCancel.push({ runId: c.runId, orders: Object.keys(state.commerce.orders).length, payments: state.commerce.paymentAttempts });
    }
    assert.deepEqual(afterCancel.map(s => [s.orders, s.payments]), [[1, 1], [0, 0], [0, 0]]);
    fs.writeFileSync(path.join(outDir, 'cancel-oracle.json'), JSON.stringify(afterCancel, null, 2));
    recovery = { type: 'explicit-new-operation-from-verified-program-state', cancelMs: Date.now() - cancelledAt, afterCancel };
    const initialCheckpoint = JSON.parse(fs.readFileSync(path.join(outDir, 'last-checkpoint.json')));
    assert.equal(initialCheckpoint.completed, 1);
    result = await call({ operation: 'start', waitMs: 60000, script: { ...spec, inputs: { ...spec.inputs, initialCheckpoint } } });
    operationIds.push(result.control.operationId);
    result = await settle(result);
  }
  const uiMs = Date.now() - began;
  assert.equal(result.control.status, 'completed', JSON.stringify(result));
  assert.equal(result.value.result.ok, true, JSON.stringify(result.value.result));
  const server = [];
  for (const c of cases) {
    const state = await (await fetch(`${hostBase}/__state?run=${encodeURIComponent(c.runId)}`)).json();
    fs.writeFileSync(path.join(c.outDir, 'server-state.json'), JSON.stringify(state, null, 2));
    assert.equal(Object.keys(state.commerce.orders).length, 1);
    assert.equal(state.sessions, c.config.expireSessionOnceAt ? 2 : 1);
    assert.equal(state.commerce.paymentAttempts, 1); assert.equal(state.commerce.orders.BUY1.status, 'refunded');
    server.push({ case: c.name, sessions: state.sessions, orders: 1, orderAttempts: state.commerce.orderAttempts,
      paymentAttempts: state.commerce.paymentAttempts, ledger: state.commerce.ledger, stock: state.commerce.products[0].variants[0].stock });
  }
  const report = { ...result.value.result, mode, targetKind, uiMs, totalWithOracleMs: Date.now() - began, rpcCount, responseBytes, operationIds, recovery, server };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch(error => { fs.writeFileSync(path.join(outDir, 'failure.txt'), error.stack); console.error(error.stack); process.exitCode = 1; });
