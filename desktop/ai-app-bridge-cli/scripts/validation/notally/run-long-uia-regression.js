#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const [serial, output, mode = 'normal'] = process.argv.slice(2);
if (!output || !['normal', 'crash'].includes(mode)) throw new Error('usage: run-long-uia-regression.js SERIAL NEW_OUT_DIR [normal|crash]');
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
  fs.appendFileSync(path.join(outDir, 'replies.jsonl'), JSON.stringify({ operation: args.operation, reply }) + '\n');
  assert(reply.execution.ok, JSON.stringify(reply.execution));
  return reply;
}
async function settle(reply) {
  while (!['completed', 'failed', 'cancelled'].includes(reply.control.status)) {
    assert(!reply.control.status.startsWith('paused') && reply.control.status !== 'waiting_for_agent', 'Needs an explicit decision');
    reply = await call({ operation: 'wait', operationId: reply.control.operationId,
      afterSequence: reply.control.eventSequence, waitMs: 60000, eventLimit: 1 });
  }
  if (reply.control.status === 'completed' && reply.value?.result === undefined) {
    reply = await call({ operation: 'result', operationId: reply.control.operationId });
  }
  return reply;
}
async function main() {
  const hashes = {};
  for (const name of ['uia-regression.js', 'long-uia-regression.js', 'run-long-uia-regression.js']) {
    const source = fs.readFileSync(path.join(__dirname, name));
    fs.writeFileSync(path.join(sourceDir, name), source);
    hashes[name] = require('node:crypto').createHash('sha256').update(source).digest('hex');
  }
  fs.writeFileSync(path.join(outDir, 'source-manifest.json'), JSON.stringify(hashes, null, 2));
  const runId = String(Date.now()), cases = Array.from({ length: 3 }, (_, i) => ({
    outDir: path.join(outDir, `note-${i + 1}`), runId: `${runId}-${i + 1}`,
  }));
  for (const fixture of cases) fs.mkdirSync(fixture.outDir);
  const spec = { schemaVersion: 'aab.code-script/v1', language: 'javascript', sourcePath: path.join(sourceDir, 'long-uia-regression.js'),
    target: { platform: 'android', serial, packageName: 'io.github.mobileaidev.notallyx.sample.uia' },
    inputs: { sourceDir, outDir, cases, ...(mode === 'crash' ? { crashAfterCase: 1 } : {}) },
    policy: { restartPolicy: 'checkpoint', timeoutMs: 300000 } };
  fs.writeFileSync(path.join(outDir, 'scenario.json'), JSON.stringify(spec, null, 2));
  const began = Date.now();
  let reply = await settle(await call({ operation: 'start', waitMs: 60000, script: spec }));
  const operationId = reply.control.operationId;
  let recovery;
  if (mode === 'crash') {
    assert.equal(reply.control.status, 'failed', JSON.stringify(reply));
    assert.equal(reply.value.error, 'child_crashed', JSON.stringify(reply));
    const checkpoint = JSON.parse(fs.readFileSync(path.join(outDir, 'last-checkpoint.json')));
    assert.equal(checkpoint.completed, 1);
    const resumedAt = Date.now();
    reply = await settle(await call({ operation: 'resume', operationId, waitMs: 60000 }));
    recovery = { type: 'same-operation-checkpoint-reentry', continuationMs: Date.now() - resumedAt };
  }
  const uiMs = Date.now() - began, result = reply.value?.result;
  const report = { ...result, mode, operationId, status: reply.control.status, uiMs, rpcCount, responseBytes, recovery,
    ok: reply.control.status === 'completed' && result?.ok === true };
  if (report.ok) {
    report.databases = [];
    for (let i = 0; i < cases.length; i++) {
      const fixture = cases[i], dbDir = path.join(fixture.outDir, 'db');
      fs.mkdirSync(dbDir);
      await execFile('tar', ['-xf', path.join(fixture.outDir, 'databases.tar'), '-C', dbDir]);
      const expected = result.reports.slice(0, i + 1).map(row => [row.title, row.body, 'NOTES', 1]);
      const { stdout } = await execFile('python3', ['-c',
        'import json,sqlite3,sys\nc=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)\nrows=[]\nfor title in json.loads(sys.argv[2]): rows.extend(c.execute("SELECT title,body,folder,pinned FROM BaseNote WHERE title=?",(title,)).fetchall())\nprint(json.dumps(rows))',
        path.join(dbDir, 'databases/NotallyDatabase'), JSON.stringify(expected.map(row => row[0]))]);
      const rows = JSON.parse(stdout);
      assert.deepEqual(rows, expected);
      report.databases.push({ snapshot: i + 1, rows, ok: true });
    }
  }
  report.totalWithOracleMs = Date.now() - began;
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
main().catch(error => { fs.writeFileSync(path.join(outDir, 'failure.txt'), error.stack); console.error(error.stack); process.exitCode = 1; });
