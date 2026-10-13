#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const [serial, serverDirectory, output, mode = 'probe'] = process.argv.slice(2);
if (!output || !['probe', 'recover', 'full'].includes(mode)) throw new Error('usage: run-payment-interruption.js SERIAL SERVER_DIR EVIDENCE_DIR [probe|recover|full]');
const outDir = path.resolve(output), cli = path.resolve(__dirname, '../../bin/ai-app-bridge.js');
let rpcCount = 0, responseBytes = 0;
async function call(args) {
  const flags = Object.entries(args).flatMap(([key, value]) => [`--${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}`,
    typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  let stdout;
  try { ({ stdout } = await execFile(process.execPath, [cli, 'script', ...flags], { maxBuffer: 8 * 1024 * 1024 })); }
  catch (error) { if (!error.stdout) throw error; stdout = error.stdout; }
  rpcCount++; responseBytes += Buffer.byteLength(stdout);
  const reply = JSON.parse(stdout);
  fs.appendFileSync(path.join(outDir, `${mode}-replies.jsonl`), JSON.stringify({ operation: args.operation, reply }) + '\n');
  return reply;
}
async function settle(reply) {
  while (!['completed', 'failed', 'cancelled'].includes(reply.control?.status)) {
    assert(reply.execution.ok, JSON.stringify(reply.execution));
    assert(!reply.control.status.startsWith('paused') && reply.control.status !== 'waiting_for_agent', 'Needs an explicit decision');
    reply = await call({ operation: 'wait', operationId: reply.control.operationId,
      afterSequence: reply.control.eventSequence, waitMs: 60000, eventLimit: 1 });
  }
  return reply;
}
async function state(spec, file) {
  const response = await fetch(`${spec.inputs.hostBase}/__state?run=${encodeURIComponent(spec.inputs.runId)}`);
  assert(response.ok); const value = await response.json();
  fs.writeFileSync(path.join(outDir, file), JSON.stringify(value, null, 2)); return value;
}
async function main() {
  const began = Date.now();
  let spec, operationId;
  if (mode !== 'recover') {
    fs.mkdirSync(outDir); const sources = path.join(outDir, 'sources'); fs.mkdirSync(sources);
    const manifest = {};
    for (const name of ['payment-interruption.js', 'city-flow.js', 'lab-client.js', 'permission-probe.js', 'run-payment-interruption.js']) {
      const source = fs.readFileSync(path.join(__dirname, name)); fs.writeFileSync(path.join(sources, name), source);
      manifest[name] = require('node:crypto').createHash('sha256').update(source).digest('hex');
    }
    fs.writeFileSync(path.join(outDir, 'source-manifest.json'), JSON.stringify(manifest, null, 2));
    const { port } = JSON.parse(fs.readFileSync(path.join(serverDirectory, 'endpoint.json')));
    const hostBase = `http://127.0.0.1:${port}`, runId = `interrupted-payment-${Date.now()}`;
    const config = { focusInputs: false, delayMs: 200, paymentResponseLostOnce: true };
    const response = await fetch(`${hostBase}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId, config }) });
    assert(response.ok);
    spec = { schemaVersion: 'aab.code-script/v1', language: 'javascript', sourcePath: path.join(sources, 'payment-interruption.js'),
      target: { platform: 'android', serial, packageName: 'io.github.mobileaidev.bridge_workflow_lab' },
      inputs: { runId, hostBase, deviceBase: `http://10.0.2.2:${port}`, outDir, config, helperPath: path.join(sources, 'lab-client.js') },
      policy: { restartPolicy: 'checkpoint', timeoutMs: 180000 } };
    fs.writeFileSync(path.join(outDir, 'scenario.json'), JSON.stringify(spec, null, 2));
    const failed = await settle(await call({ operation: 'start', waitMs: 60000, script: spec }));
    operationId = failed.control.operationId;
    fs.writeFileSync(path.join(outDir, 'original-operation.json'), JSON.stringify({ operationId, began }, null, 2));
    assert.equal(failed.control.status, 'failed'); assert.equal(failed.value.error, 'child_crashed');
    const blocked = await call({ operation: 'resume', operationId, waitMs: 60000 });
    assert.equal(blocked.execution.ok, false); assert.equal(blocked.execution.error, 'ambiguous');
    // The worker exits while the App's HTTP request is still in flight. Poll
    // only the independent server observation; never resend the payment.
    const deadline = Date.now() + 5000;
    let remote;
    do {
      const response = await fetch(`${hostBase}/__state?run=${encodeURIComponent(runId)}`);
      assert(response.ok); remote = await response.json();
      if (remote.commerce.paymentAttempts === 1) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    fs.writeFileSync(path.join(outDir, 'state-after-interruption.json'), JSON.stringify(remote, null, 2));
    assert.equal(remote.commerce.paymentAttempts, 1); assert.equal(remote.commerce.orders.BUY1.status, 'paid');
    const report = { ok: false, ordinaryResumeRequiresDecision: true, operationId, runId,
      error: 'checkpoint_precedes_action', totalMs: Date.now() - began, rpcCount, responseBytes,
      paymentAttempts: remote.commerce.paymentAttempts, orderStatus: remote.commerce.orders.BUY1.status };
    fs.writeFileSync(path.join(outDir, 'probe-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    if (mode === 'probe') return;
  }
  const recoveryBegan = Date.now();
  spec = JSON.parse(fs.readFileSync(path.join(outDir, 'scenario.json')));
  const original = JSON.parse(fs.readFileSync(path.join(outDir, 'original-operation.json'))); operationId = original.operationId;
  assert.equal(spec.target.serial, serial);
  let reply = await call({ operation: 'resume', operationId, waitMs: 60000,
    recovery: { checkpoint: { name: 'query-interrupted-payment', state: { phase: 'query-payment', runId: spec.inputs.runId } },
      reason: 'Continue at the original order query; the old payment receipt and server commit are retained, and payment must not be replayed.' } });
  assert(reply.execution.ok, JSON.stringify(reply.execution)); reply = await settle(reply);
  if (reply.value?.result === undefined && reply.control.resultRef) reply = await call({ operation: 'result', operationId });
  assert.equal(reply.control.status, 'completed'); assert.equal(reply.value.result.ok, true);
  const remote = await state(spec, 'state-after-recovery.json');
  assert.equal(remote.commerce.paymentAttempts, 1); assert.equal(remote.commerce.orderAttempts, 1); assert.equal(remote.commerce.orders.BUY1.status, 'refunded');
  const report = { ...reply.value.result, operationId, runId: spec.inputs.runId, recoveryMs: Date.now() - recoveryBegan,
    firstAttemptThroughRecoveryMs: Date.now() - original.began, rpcCount, responseBytes,
    totalCommands: fs.readFileSync(path.join(outDir, 'command-observations.jsonl'), 'utf8').trim().split('\n').length,
    paymentAttempts: remote.commerce.paymentAttempts, ledger: remote.commerce.ledger };
  fs.writeFileSync(path.join(outDir, 'recovery-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
main().catch(error => { fs.writeFileSync(path.join(outDir, `${mode}-failure.txt`), error.stack); console.error(error.stack); process.exitCode = 1; });
