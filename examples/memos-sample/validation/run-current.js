#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const [browserDir, dataDir, outputDir, mode = 'javascript'] = process.argv.slice(2);
if (!browserDir || !dataDir || !outputDir || !['signup', 'javascript', 'python'].includes(mode)) {
  throw new Error('usage: run-current.js BROWSER_DIRECTORY MEMOS_DATA NEW_OUTPUT_DIRECTORY [signup|javascript|python]');
}
fs.mkdirSync(outputDir, { mode: 0o700 });
const root = path.resolve(__dirname, '../../..');
const target = JSON.parse(fs.readFileSync(path.join(browserDir, 'target.json'), 'utf8'));
const credentialsPath = path.join(browserDir, 'credentials.json');
const env = { ...process.env, AI_APP_BRIDGE_FACT_STORE_DIR: path.join(browserDir, 'facts') };
let rpcCount = 0, responseBytes = 0;
async function call(command, args) {
  const flags = Object.entries(args).flatMap(([key, value]) => [
    `--${key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}`,
    typeof value === 'object' ? JSON.stringify(value) : String(value),
  ]);
  const startedAtMs = Date.now();
  let stdout;
  try { ({ stdout } = await execFile(process.execPath, [path.join(root, 'desktop/ai-app-bridge-cli/bin/ai-app-bridge.js'), command, ...flags], { env, maxBuffer: 16 * 1024 * 1024 })); }
  catch (error) { if (!error.stdout) throw error; stdout = error.stdout; }
  const result = JSON.parse(stdout);
  rpcCount++; responseBytes += Buffer.byteLength(stdout);
  fs.appendFileSync(path.join(outputDir, 'replies.jsonl'), JSON.stringify({ command, startedAtMs, completedAtMs: Date.now(), result }) + '\n', { mode: 0o600 });
  return result;
}

async function baseline() {
  const script = `import sqlite3,json,sys\ndb=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\ndb.row_factory=sqlite3.Row\nrows=[dict(r) for r in db.execute('SELECT memo.id,uid,creator_id,content,visibility,memo.row_status,memo.created_ts,memo.updated_ts,payload,username FROM memo JOIN user ON memo.creator_id=user.id ORDER BY memo.id')]\nprint(json.dumps({'rows':rows}))`;
  const { stdout } = await execFile('python3', ['-c', script, path.join(dataDir, 'memos_prod.db')]);
  fs.writeFileSync(path.join(outputDir, 'baseline.json'), stdout, { mode: 0o600 });
}

async function main() {
  await baseline();
  const run = `BridgeCurrent${mode}${Date.now()}`;
  const sample = { marker: run, tag: run.toLowerCase(),
    content: `${run}\n\n买菜与发版计划。\n- [ ] 牛奶 2 瓶\n- [ ] 验证富文本编辑器\n#${run.toLowerCase()}`,
    editedContent: `${run}\n\n买菜与发版计划。\n- [x] 牛奶 2 瓶\n- [ ] 验证富文本编辑器与保存结果\n#${run.toLowerCase()}\n编辑完成：Script edit verified.` };
  fs.writeFileSync(path.join(outputDir, 'case.json'), JSON.stringify(sample, null, 2), { mode: 0o600 });
  const startedAtMs = Date.now();
  let result;
  if (mode === 'signup') {
    result = await call('intent', { operation: 'start', target, provider: 'h5', mode: 'autonomous',
      goal: JSON.stringify({ task: 'Create the first admin in the isolated Memos test instance', credentialsPath }),
      agentModule: path.join(__dirname, 'signup-agent.js'), timeoutMs: 20000,
      recordingDir: path.join(outputDir, 'recording') });
  } else {
    result = await call('script', { operation: 'start', waitMs: 60000,
      recordingDir: path.join(outputDir, 'recording'),
      script: { schemaVersion: 'aab.code-script/v1', language: mode,
        sourcePath: path.join(__dirname, mode === 'python' ? 'memos-flow.py' : 'memos-flow.js'), target,
        inputs: { ...sample, credentialsPath }, policy: { timeoutMs: 60000 } } });
  }
  const finishedAtMs = Date.now();
  const report = { ok: result.execution.ok === true && result.control.status === 'completed', mode, startedAtMs, finishedAtMs,
    elapsedMs: finishedAtMs - startedAtMs, operationId: result.control.operationId, status: result.control.status,
    error: result.execution.error, rpcCount, responseBytes, target };
  fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  if (report.ok && mode !== 'signup') {
    const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    try {
      const { stdout } = await execFile('python3', [path.join(__dirname, 'read-memo.py'),
        '--database', path.join(dataDir, 'memos_prod.db'), '--case', path.join(outputDir, 'case.json'),
        '--baseline', path.join(outputDir, 'baseline.json'), '--output', path.join(outputDir, 'oracle'),
        '--username', credentials.username, '--started-at-ms', String(startedAtMs), '--finished-at-ms', String(finishedAtMs)]);
      report.oracle = JSON.parse(stdout);
      report.ok = report.ok && report.oracle.ok;
    } catch (error) { report.ok = false; report.oracleError = error.stdout || error.message; }
  }
  report.totalIncludingOracleMs = Date.now() - startedAtMs;
  fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
