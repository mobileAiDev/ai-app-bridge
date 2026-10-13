#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), path = require('node:path');
const { promisify } = require('node:util'), execFile = promisify(require('node:child_process').execFile);
const [browserDir, dataDir, outDir, countText = '5'] = process.argv.slice(2);
const count = Number(countText);
if (!browserDir || !dataDir || !outDir || !Number.isInteger(count) || count < 1) throw Error('usage: run-long.js BROWSER_DIR DATA_DIR NEW_OUT_DIR [COUNT]');
fs.mkdirSync(outDir, { mode: 0o700 });
const target = JSON.parse(fs.readFileSync(path.join(browserDir, 'target.json')));
const env = { ...process.env, AI_APP_BRIDGE_FACT_STORE_DIR: path.join(browserDir, 'facts') };
async function rows() {
  const source = `import sqlite3,json,sys\ndb=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\ndb.row_factory=sqlite3.Row\nprint(json.dumps([dict(r) for r in db.execute('SELECT memo.*,user.username FROM memo JOIN user ON memo.creator_id=user.id ORDER BY memo.id')]))`;
  return JSON.parse((await execFile('python3', ['-c', source, path.join(dataDir, 'memos_prod.db')])).stdout);
}
async function main() {
  const baseline = await rows();
  fs.writeFileSync(path.join(outDir, 'baseline.json'), JSON.stringify(baseline, null, 2));
  const startedAtMs = Date.now(), marker = `BridgeLong${startedAtMs}`;
  const args = { operation: 'start', waitMs: 60000, recordingDir: path.join(outDir, 'recording'),
    script: { schemaVersion: 'aab.code-script/v1', language: 'javascript',
      sourcePath: path.join(__dirname, 'memos-long-flow.js'), target,
      inputs: { marker, count, credentialsPath: path.join(browserDir, 'credentials.json') }, policy: { timeoutMs: 60000 } } };
  fs.writeFileSync(path.join(outDir, 'start-args.json'), JSON.stringify(args, null, 2));
  const flags = Object.entries(args).flatMap(([key, value]) => [`--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`,
    typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  let stdout;
  try { ({ stdout } = await execFile(process.execPath, [path.resolve(__dirname, '../../../desktop/ai-app-bridge-cli/bin/ai-app-bridge.js'), 'script', ...flags], { env, maxBuffer: 16e6 })); }
  catch (error) { if (!error.stdout) throw error; stdout = error.stdout; }
  const finishedAtMs = Date.now(), reply = JSON.parse(stdout);
  fs.writeFileSync(path.join(outDir, 'reply.json'), stdout);
  const current = await rows();
  fs.writeFileSync(path.join(outDir, 'oracle-rows.json'), JSON.stringify(current, null, 2));
  const result = reply.value?.result;
  const checks = { completed: reply.control.status === 'completed', exactAddedCount: current.length === baseline.length + count,
    oldRecordsUnchanged: baseline.every(old => current.some(row => JSON.stringify(row) === JSON.stringify(old))) };
  const credentials = JSON.parse(fs.readFileSync(path.join(browserDir, 'credentials.json')));
  for (const sample of result?.cases || []) {
    const matches = current.filter(row => row.content.includes(sample.marker));
    const row = matches[0], payload = row && JSON.parse(row.payload);
    checks[sample.marker] = matches.length === 1 && row.content === sample.editedContent && row.visibility === 'PRIVATE'
      && row.row_status === 'NORMAL' && row.username === credentials.username
      && JSON.stringify(payload.tags) === JSON.stringify([sample.tag])
      && payload.property.hasTaskList === true && payload.property.hasIncompleteTasks === true;
  }
  const recordings = fs.existsSync(path.join(outDir, 'recording')) ? fs.readdirSync(path.join(outDir, 'recording'))
    .filter(file => /^\d+\.json$/.test(file)).map(file => JSON.parse(fs.readFileSync(path.join(outDir, 'recording', file)))) : [];
  const calls = recordings.filter(item => item.kind === 'script-call').map(item => ({ command: item.data.command,
    ms: item.data.completedAtMs - item.data.startedAtMs, ok: item.data.envelope.ok }));
  const report = { ok: Object.values(checks).every(Boolean), startedAtMs, finishedAtMs, elapsedMs: finishedAtMs - startedAtMs,
    totalIncludingOracleMs: Date.now() - startedAtMs, rpcCount: 1, responseBytes: Buffer.byteLength(stdout),
    operationId: reply.control.operationId, status: reply.control.status, error: reply.execution.error,
    count, commandCalls: calls.length, commandMs: calls.reduce((sum, item) => sum + item.ms, 0),
    assertions: recordings.filter(item => item.kind === 'script-assertion').length, caseTimings: result?.timings, checks };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'calls.json'), JSON.stringify(calls, null, 2));
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
