#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const [serial, output, recoveryMode = 'start', businessMode = 'fixture'] = process.argv.slice(2);
if (!serial || !output || !['start', 'force-reset'].includes(recoveryMode)
  || !['fixture', 'business'].includes(businessMode) || !process.env.AI_APP_BRIDGE_FACT_STORE_DIR)
  throw new Error('usage: AI_APP_BRIDGE_FACT_STORE_DIR=ISOLATED_FACTS run-uia-executor-loss.js SERIAL NEW_OUT_DIR [start|force-reset] [fixture|business]');
const outDir = path.resolve(output), sourceDir = path.join(outDir, 'sources');
const cli = path.resolve(__dirname, '../../../bin/ai-app-bridge.js');
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
  for (const name of ['uia-regression.js', 'uia-executor-loss.js', 'run-uia-executor-loss.js']) {
    const source = fs.readFileSync(path.join(__dirname, name));
    fs.writeFileSync(path.join(sourceDir, name), source);
    hashes[name] = createHash('sha256').update(source).digest('hex');
  }
  fs.writeFileSync(path.join(outDir, 'source-manifest.json'), JSON.stringify(hashes, null, 2));
  const runId = randomUUID();
  const spec = { schemaVersion: 'aab.code-script/v1', language: 'javascript', sourcePath: path.join(sourceDir, 'uia-executor-loss.js'),
    target: { platform: 'android', serial, packageName: 'io.github.mobileaidev.notallyx.sample.uia' },
    inputs: { outDir, runId, recoveryMode, business: businessMode === 'business' },
    policy: { restartPolicy: 'checkpoint', timeoutMs: 180000 } };
  fs.writeFileSync(path.join(outDir, 'scenario.json'), JSON.stringify(spec, null, 2));
  const began = Date.now();
  let reply = await call({ operation: 'start', waitMs: 60000, script: spec });
  const operationId = reply.control.operationId;
  while (['starting', 'running', 'finishing'].includes(reply.control.status)) {
    reply = await call({ operation: 'wait', operationId, afterSequence: reply.control.eventSequence, waitMs: 60000, eventLimit: 1 });
  }
  if (reply.control.status === 'completed' && reply.value?.result === undefined)
    reply = await call({ operation: 'result', operationId });
  const uiMs = Date.now() - began, result = reply.value?.result;
  const report = { ...result, runId, operationId, status: reply.control.status, uiMs, rpcCount, responseBytes,
    ok: reply.control.status === 'completed' && result?.ok === true,
    ...(reply.control.status !== 'completed' ? { failure: reply.value } : {}) };
  // Keep the workflow result even if its independent database assertion fails.
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  if (report.ok && businessMode === 'business') {
    const dbDir = path.join(outDir, 'business', 'db'); fs.mkdirSync(dbDir);
    await execFile('tar', ['-xf', path.join(outDir, 'business', 'databases.tar'), '-C', dbDir]);
    const { stdout } = await execFile('python3', ['-c',
      'import json,sqlite3,sys\nc=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)\nprint(json.dumps(c.execute("SELECT title,body,folder,pinned FROM BaseNote WHERE title=?",(sys.argv[2],)).fetchall()))',
      path.join(dbDir, 'databases/NotallyDatabase'), report.business.title]);
    const rows = JSON.parse(stdout);
    const expected = [[report.business.title, report.business.body, 'NOTES', 1]];
    report.database = { rows, expected, ok: JSON.stringify(rows) === JSON.stringify(expected) };
    report.ok = report.database.ok;
  }
  report.totalWithOracleMs = Date.now() - began;
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
main().catch(error => { fs.writeFileSync(path.join(outDir, 'failure.txt'), error.stack); console.error(error.stack); process.exitCode = 1; });
