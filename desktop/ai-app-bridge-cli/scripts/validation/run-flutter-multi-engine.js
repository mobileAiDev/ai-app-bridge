#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const [serial, serverDirectory, output, businessRunId] = process.argv.slice(2);
assert(serial && serverDirectory && output && businessRunId && process.env.AI_APP_BRIDGE_FACT_STORE_DIR,
  'usage: run-flutter-multi-engine.js SERIAL SERVER_DIR NEW_OUTPUT EXISTING_REVISION_4_RUN');
const outDir = path.resolve(output), sources = path.join(outDir, 'sources');
fs.mkdirSync(outDir); fs.mkdirSync(sources);
const manifest = {};
for (const file of ['flutter-multi-engine.js', 'run-flutter-multi-engine.js']) {
  const data = fs.readFileSync(path.join(__dirname, file)); fs.writeFileSync(path.join(sources, file), data);
  manifest[file] = createHash('sha256').update(data).digest('hex');
}
fs.writeFileSync(path.join(outDir, 'source-manifest.json'), JSON.stringify(manifest, null, 2));
const { port, journalPath } = JSON.parse(fs.readFileSync(path.join(serverDirectory, 'endpoint.json')));
const cli = process.env.AAB_VALIDATION_CLI_PATH || path.resolve(__dirname, '../../bin/ai-app-bridge.js');
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
  const script = { schemaVersion: 'aab.code-script/v1', language: 'javascript', sourcePath: path.join(sources, 'flutter-multi-engine.js'),
    target: { platform: 'android', serial, packageName: 'io.github.mobileaidev.bridge_workflow_lab' },
    inputs: { outDir, runId: `multi-engine-${randomUUID()}`, businessRunId, hostBase: `http://127.0.0.1:${port}`, deviceBase: `http://10.0.2.2:${port}` },
    policy: { timeoutMs: 180000 } };
  fs.writeFileSync(path.join(outDir, 'scenario.json'), JSON.stringify(script, null, 2));
  const began = Date.now(); let reply = await call({ operation: 'start', waitMs: 60000, script });
  const operationId = reply.control.operationId;
  while (['starting', 'running', 'finishing'].includes(reply.control.status))
    reply = await call({ operation: 'wait', operationId, afterSequence: reply.control.eventSequence, waitMs: 60000, eventLimit: 1 });
  if (reply.control.status === 'completed' && reply.value?.result === undefined) reply = await call({ operation: 'result', operationId });
  const uiMs = Date.now() - began;
  const journal = fs.readFileSync(journalPath, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.runId === businessRunId);
  fs.writeFileSync(path.join(outDir, 'server-journal.jsonl'), journal.map(row => JSON.stringify(row)).join('\n') + '\n');
  const posts = journal.filter(row => row.type === 'request' && row.method === 'POST' && row.atMs >= began);
  const result = reply.value?.result;
  const report = { ...result, ok: reply.control.status === 'completed' && result?.ok === true && posts.length === 0,
    status: reply.control.status, operationId, uiMs, totalWithOracleMs: Date.now() - began, rpcCount, responseBytes,
    newBusinessPostRequests: posts, sourceCli: cli, performanceClaim: false };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
main().catch(error => { fs.writeFileSync(path.join(outDir, 'failure.txt'), error.stack); console.error(error.stack); process.exitCode = 1; });
