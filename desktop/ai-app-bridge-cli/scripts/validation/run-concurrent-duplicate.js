#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const [serial, serverDirectory, output, originalDirectory, observedTaskId] = process.argv.slice(2);
if (!serial || !serverDirectory || !output || !process.env.AI_APP_BRIDGE_FACT_STORE_DIR)
  throw new Error('usage: AI_APP_BRIDGE_FACT_STORE_DIR=ISOLATED_FACTS run-concurrent-duplicate.js SERIAL SERVER_DIR NEW_OUT_DIR');
const outDir = path.resolve(output), sources = path.join(outDir, 'sources');
fs.mkdirSync(outDir); fs.mkdirSync(sources);
const hashes = {};
for (const file of ['concurrent-duplicate-flow.js', 'run-concurrent-duplicate.js', 'lab-client.js']) {
  const data = fs.readFileSync(path.join(__dirname, file)); fs.writeFileSync(path.join(sources, file), data);
  hashes[file] = createHash('sha256').update(data).digest('hex');
}
fs.writeFileSync(path.join(outDir, 'source-manifest.json'), JSON.stringify(hashes, null, 2));
const { port, journalPath } = JSON.parse(fs.readFileSync(path.join(serverDirectory, 'endpoint.json')));
const original = originalDirectory ? JSON.parse(fs.readFileSync(path.join(originalDirectory, 'scenario.json'))) : null;
const hostBase = `http://127.0.0.1:${port}`, runId = original?.inputs.runId || `concurrent-duplicate-${randomUUID()}`;
const cli = path.resolve(__dirname, '../../bin/ai-app-bridge.js');
let rpcCount = 0, responseBytes = 0;
async function call(args) {
  const flags = Object.entries(args).flatMap(([key, value]) => [`--${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}`,
    typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  let stdout;
  try { ({ stdout } = await execFile(process.execPath, [cli, 'script', ...flags], { maxBuffer: 8 * 1024 * 1024 })); }
  catch (error) { if (!error.stdout) throw error; stdout = error.stdout; }
  rpcCount++; responseBytes += Buffer.byteLength(stdout); const reply = JSON.parse(stdout);
  fs.appendFileSync(path.join(outDir, 'replies.jsonl'), JSON.stringify({ atMs: Date.now(), args, reply }) + '\n');
  assert(reply.execution.ok, JSON.stringify(reply.execution)); return reply;
}
async function main() {
  const config = { firstSave: 'success', delayMs: 1000, focusInputs: false };
  if (!original) {
    const setup = await fetch(`${hostBase}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, config }) }); assert(setup.ok);
  }
  const script = { schemaVersion: 'aab.code-script/v1', language: 'javascript', sourcePath: path.join(sources, 'concurrent-duplicate-flow.js'),
    target: { platform: 'android', serial, packageName: 'io.github.mobileaidev.aiappbridge.sample' },
    inputs: { outDir, runId, hostBase, deviceBase: `http://10.0.2.2:${port}`, config,
      ...(original ? { resume: { sourceEvidence: path.resolve(originalDirectory), taskId: Number(observedTaskId) } } : {}) },
    policy: { timeoutMs: 180000 } };
  fs.writeFileSync(path.join(outDir, 'scenario.json'), JSON.stringify(script, null, 2));
  const began = Date.now(); let reply = await call({ operation: 'start', waitMs: 60000, script });
  const operationId = reply.control.operationId;
  while (['starting', 'running', 'finishing'].includes(reply.control.status))
    reply = await call({ operation: 'wait', operationId, afterSequence: reply.control.eventSequence, waitMs: 60000, eventLimit: 1 });
  if (reply.control.status === 'completed' && reply.value?.result === undefined)
    reply = await call({ operation: 'result', operationId });
  const uiMs = Date.now() - began;
  const state = await (await fetch(`${hostBase}/__state?run=${encodeURIComponent(runId)}`)).json();
  fs.writeFileSync(path.join(outDir, 'server-state.json'), JSON.stringify(state, null, 2));
  const journal = fs.readFileSync(journalPath, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.runId === runId);
  fs.writeFileSync(path.join(outDir, 'server-journal.jsonl'), journal.map(row => JSON.stringify(row)).join('\n') + '\n');
  const requests = journal.filter(row => row.type === 'request' && row.method === 'POST' && row.path.startsWith('/api/'));
  const checks = requests.filter(row => row.path.endsWith('/check'));
  const checkResponses = checks.map(row => ({ request: row,
    response: journal.find(item => item.type === 'response' && item.requestId === row.requestId) }));
  const commits = journal.filter(row => row.type === 'commit');
  const oracleOk = state.saveAttempts === 1 && state.approvals === 2 && state.flutterUpdates === 1
    && JSON.stringify(checkResponses.map(row => [row.request.body.revision, row.response?.status])) === JSON.stringify([[2, 409], [3, 200]])
    && JSON.stringify(commits.map(row => [row.operation, row.order.revision])) === JSON.stringify([['create', 1], ['approve', 2], ['approve', 3], ['check', 4]])
    && requests.every(row => ['native', 'h5', 'flutter'].includes(row.source));
  const result = reply.value?.result;
  const report = { ...result, ok: reply.control.status === 'completed' && result?.ok === true && oracleOk,
    status: reply.control.status, operationId, runId, uiMs, totalWithOracleMs: Date.now() - began, rpcCount, responseBytes,
    oracle: { ok: oracleOk, postRequests: requests.map(({ path, source, body, atMs }) => ({ path, source, body, atMs })),
      checkResponses, commits, saveAttempts: state.saveAttempts, approvals: state.approvals, flutterUpdates: state.flutterUpdates,
      finalOrder: state.orders['ORDER-1'], automaticReplay: false },
    ...(reply.control.status !== 'completed' ? { failure: reply.value } : {}) };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
main().catch(error => { fs.writeFileSync(path.join(outDir, 'failure.txt'), error.stack); console.error(error.stack); process.exitCode = 1; });
