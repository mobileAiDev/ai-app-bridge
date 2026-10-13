#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const [serial, outDir, resumeRunId] = process.argv.slice(2);
if (!outDir) throw new Error('usage: run-uia-regression.js SERIAL OUT_DIR [EXISTING_RUN_ID_AFTER_EDIT]');
const cli = path.resolve(__dirname, '../../../bin/ai-app-bridge.js');
fs.mkdirSync(outDir);
let rpcCount = 0, responseBytes = 0;
async function call(args) {
  const flags = Object.entries(args).flatMap(([key, value]) => [`--${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}`, typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  let stdout;
  try { ({ stdout } = await execFile(process.execPath, [cli, 'script', ...flags], { maxBuffer: 8 * 1024 * 1024 })); }
  catch (error) { if (!error.stdout) throw error; stdout = error.stdout; }
  rpcCount++; responseBytes += Buffer.byteLength(stdout);
  const reply = JSON.parse(stdout);
  fs.appendFileSync(path.join(outDir, 'replies.jsonl'), JSON.stringify(reply) + '\n');
  assert(reply.execution.ok, JSON.stringify(reply.execution));
  return reply;
}
async function main() {
  const spec = { schemaVersion: 'aab.code-script/v1', language: 'javascript', sourcePath: path.join(__dirname, 'uia-regression.js'),
    target: { platform: 'android', serial, packageName: 'io.github.mobileaidev.notallyx.sample.uia' },
    inputs: { outDir, runId: resumeRunId || String(Date.now()), resumeAfterEdit: Boolean(resumeRunId) }, policy: { timeoutMs: 120000 } };
  fs.copyFileSync(spec.sourcePath, path.join(outDir, 'program.js'));
  spec.sourcePath = path.join(outDir, 'program.js');
  fs.writeFileSync(path.join(outDir, 'scenario.json'), JSON.stringify(spec, null, 2));
  const began = Date.now();
  let reply = await call({ operation: 'start', waitMs: 60000, script: spec });
  while (!['completed', 'failed', 'cancelled'].includes(reply.control.status)) {
    if (reply.control.status === 'waiting_for_agent' || reply.control.status.startsWith('paused')) throw new Error(`Needs decision: ${reply.control.operationId}`);
    reply = await call({ operation: 'wait', operationId: reply.control.operationId, afterSequence: reply.control.eventSequence, waitMs: 60000, eventLimit: 1 });
  }
  if (reply.value?.result === undefined && reply.control.resultRef) reply = await call({ operation: 'result', operationId: reply.control.operationId });
  const uiMs = Date.now() - began;
  const result = reply.value?.result;
  const report = { ...result, status: reply.control.status, operationId: reply.control.operationId, uiMs, rpcCount, responseBytes,
    ok: reply.control.status === 'completed' && result?.ok === true };
  if (report.ok) {
    const dbDir = path.join(outDir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    await execFile('tar', ['-xf', path.join(outDir, 'databases.tar'), '-C', dbDir]);
    const { stdout } = await execFile('python3', ['-c',
      'import json,sqlite3,sys\nc=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)\nprint(json.dumps(c.execute("SELECT title,body,folder,pinned FROM BaseNote WHERE title=?",(sys.argv[2],)).fetchall()))',
      path.join(dbDir, 'databases/NotallyDatabase'), result.title]);
    const rows = JSON.parse(stdout);
    assert.deepEqual(rows, [[result.title, result.body, 'NOTES', 1]]);
    report.database = { ok: true, rows, method: 'read-only SQLite query after process stop' };
  }
  report.totalWithOracleMs = Date.now() - began;
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
main().catch(error => { fs.writeFileSync(path.join(outDir, 'failure.txt'), error.stack); console.error(error.stack); process.exitCode = 1; });
