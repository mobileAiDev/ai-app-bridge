#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');

async function main({ out, serverPath, serial, packageName }) {
  fs.mkdirSync(out);
  fs.copyFileSync(__filename, path.join(out, 'controller.js'));
  const write = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + '\n');
  const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
  const adb = args => execFileSync('adb', ['-s', serial, ...args], { timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
  const device = { serial, model: adb(['shell', 'getprop', 'ro.product.model']).toString().trim(),
    brand: adb(['shell', 'getprop', 'ro.product.brand']).toString().trim() };
  write('device.json', device);
  assert.equal(serial, 'b46093e6'); assert.equal(device.model, 'PKR110');
  const target = { serial, packageName };
  const report = { ok: false, target, serverPath, controllerSha256: sha(fs.readFileSync(__filename)), cases: [] };
  const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' };
  const create = (name, overrides = {}) => createMcpClient({ serverPath, env: { ...env, ...overrides },
    transcriptPath: path.join(out, `${name}.jsonl`), stderrPath: path.join(out, `${name}.log`) });
  const clients = [];
  const ownedClient = async name => { const client = create(name); clients.push(client); await client.initialize(); return client; };
  let sequence = 0;
  const runWith = client => async (command, args) => {
    const result = payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
    write(`${String(++sequence).padStart(3, '0')}-${command}.json`, result); return result;
  };
  const check = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
  const processes = client => execFileSync('ps', ['-axo', 'pid,ppid,command'], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match && Number(match[2]) === client.pid && match[3].includes(`adb -s ${serial} `)
      ? [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] }] : [];
  });
  function independentState(label) {
    const dir = path.join(out, label); fs.mkdirSync(dir);
    const preferences = adb(['exec-out', 'run-as', packageName, 'cat', `shared_prefs/${packageName}_preferences.xml`]);
    fs.writeFileSync(path.join(dir, 'preferences.xml'), preferences);
    for (const file of ['NotallyDatabase', 'NotallyDatabase-wal']) {
      fs.writeFileSync(path.join(dir, file), adb(['exec-out', 'run-as', packageName, 'cat', `databases/${file}`]));
    }
    const contents = execFileSync('python3', ['-c', `import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
quote = lambda value: '"' + value.replace('"', '""') + '"'
data = {table: sorted([list(row) for row in db.execute('SELECT * FROM ' + quote(table))], key=lambda row: json.dumps(row, sort_keys=True, default=lambda x: x.hex())) for table in tables}
print(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(',', ':'), default=lambda x: x.hex()))
db.close()
`, path.join(dir, 'NotallyDatabase')]);
    fs.writeFileSync(path.join(dir, 'business-tables.json'), contents);
    return { preferencesSha256: sha(preferences), businessTablesSha256: sha(contents),
      tableRows: Object.fromEntries(Object.entries(JSON.parse(contents)).map(([name, rows]) => [name, rows.length])) };
  }
  async function startPendingObservation(client, name) {
    const operationId = `${name}-${Date.now()}`;
    const pending = runWith(client)('intent', { operation: 'start', operationId, goal: 'Read the real foreground without taking any action',
      target: { platform: 'android', ...target }, provider: 'uia', timeoutMs: 20000 });
    const settled = pending.then(value => ({ value }), error => ({ error: error.message }));
    let inflight;
    const deadline = Date.now() + 5000;
    while (!inflight && Date.now() < deadline) {
      inflight = processes(client).find(item => item.command.includes('shell uiautomator dump'));
      if (!inflight) await delay(10);
    }
    assert.ok(inflight, 'a real UIAutomator subprocess owned by this MCP must be running');
    write(`${name}-inflight.json`, inflight);
    return { operationId, inflight, settled };
  }
  try {
    report.before = independentState('before');
    const apkPaths = adb(['shell', 'pm', 'path', packageName]).toString().trim().split('\n');
    assert.equal(apkPaths.length, 1); assert.ok(apkPaths[0].startsWith('package:'));
    report.apkSha256 = adb(['shell', 'sha256sum', apkPaths[0].slice(8)]).toString().trim().split(/\s+/)[0];
    let client = await ownedClient('mcp'); let run = runWith(client);
    check(await run('screenshot', { ...target, outFile: path.join(out, 'before.png'), feedback: 'off' }));

    let state = check(await run('intent', { operation: 'start', operationId: `lifetime-normal-${Date.now()}`,
      goal: 'Confirm that a fresh native observation is available without changing the App', target, provider: 'native', timeoutMs: 10000 }));
    assert.equal(state.status, 'waiting_for_decision');
    state = check(await run('intent', { operation: 'decide', operationId: state.operationId,
      decision: { decisionId: 'observed', basedOnRevision: state.revision, agentDecision: 'complete', reason: 'Fresh native observation received; no action requested.' } }));
    assert.equal(state.status, 'completed'); assert.ok(state.terminalEvidenceId); assert.equal(state.lastAction, null);
    assert.equal((await run('intent', { operation: 'cancel', operationId: state.operationId })).status, 'completed');
    report.cases.push({ name: 'normal', operationId: state.operationId, status: state.status, terminalEvidenceId: state.terminalEvidenceId });

    const pending = await startPendingObservation(client, 'cancel');
    const cancellationAt = Date.now();
    state = await run('intent', { operation: 'cancel', operationId: pending.operationId });
    assert.equal(state.status, 'cancelled'); assert.equal(state.pendingOperations, 0);
    assert.equal((await pending.settled).value.status, 'cancelled');
    assert.throws(() => process.kill(pending.inflight.pid, 0), { code: 'ESRCH' });
    report.cases.push({ name: 'cancel-initial-observation', operationId: state.operationId, status: state.status,
      terminalEvidenceId: state.terminalEvidenceId, cancellationMs: Date.now() - cancellationAt, providerPid: pending.inflight.pid, providerClosed: true });

    const startedAt = Date.now();
    state = check(await run('intent', { operation: 'start', operationId: `lifetime-idle-${startedAt}`,
      goal: 'Verify the total deadline while waiting for a decision', target, provider: 'native', timeoutMs: 1500 }));
    assert.equal(state.status, 'waiting_for_decision');
    await delay(Math.max(1, state.deadlineMs - Date.now() + 100));
    state = await run('intent', { operation: 'status', operationId: state.operationId });
    assert.equal(state.status, 'timeout'); assert.equal(state.error, 'deadline_exceeded'); assert.equal(state.lastAction, null);
    report.cases.push({ name: 'idle-deadline', operationId: state.operationId, status: state.status, error: state.error,
      elapsedMs: Date.now() - startedAt, terminalEvidenceId: state.terminalEvidenceId });

    const shutdown = await startPendingObservation(client, 'shutdown');
    assert.deepEqual(await client.close({ stdinEof: true }), { code: 0, signal: null });
    await shutdown.settled;
    assert.throws(() => process.kill(shutdown.inflight.pid, 0), { code: 'ESRCH' });
    report.cases.push({ name: 'shutdown-initial-observation', operationId: shutdown.operationId, status: 'cancelled',
      providerPid: shutdown.inflight.pid, providerClosed: true });

    client = await ownedClient('restarted'); run = runWith(client);
    for (const item of report.cases) {
      const recovered = await run('intent', { operation: 'status', operationId: item.operationId });
      assert.equal(recovered.status, item.status); assert.equal(recovered.live, false); assert.equal(recovered.recovered, true);
      assert.equal(recovered.restartPolicy, 'none'); assert.ok(recovered.terminalEvidenceId);
      item.terminalEvidenceId = recovered.terminalEvidenceId;
      item.archive = check(await run('evidence', { operation: 'export', namespace: 'intent', operationId: item.operationId,
        outputDir: path.join(out, `${item.name}-archive`) }));
      const records = JSON.parse(fs.readFileSync(path.join(item.archive.archiveDir, 'records.json'))).map(row => row.payload).filter(row => row.namespace === 'intent');
      assert.equal(records.some(row => row.kind === 'action-receipt' || row.kind === 'dispatch-marker'), false);
      if (item.providerPid) assert.equal(records.some(row => row.kind === 'observation'), false);
      assert.equal(records.at(-1).evidenceId, recovered.terminalEvidenceId);
      assert.equal((await run('intent', { operation: 'start', operationId: item.operationId, goal: 'Do not replay', target: { platform: 'android', ...target } })).error, 'operation_exists');
    }
    check(await run('screenshot', { ...target, outFile: path.join(out, 'after.png'), feedback: 'off' }));
    assert.deepEqual(processes(client), []);
    report.after = independentState('after'); assert.deepEqual(report.after, report.before);
    await client.close();
    const unusableStore = path.join(out, 'unusable-store'); fs.writeFileSync(unusableStore, 'not a directory');
    const offline = create('offline', { AI_APP_BRIDGE_FACT_STORE_DIR: unusableStore, ADB: path.join(out, 'no-adb') });
    clients.push(offline); await offline.initialize();
    for (const item of report.cases) {
      const archiveDir = path.join(out, `${item.name}-moved-archive`); fs.cpSync(item.archive.archiveDir, archiveDir, { recursive: true });
      item.offline = check(await runWith(offline)('evidence', { operation: 'verify', archiveDir, manifestSha256: item.archive.manifestSha256 }));
    }
    report.ok = true;
    return report;
  } catch (error) { report.error = error.stack || String(error); throw error; }
  finally { for (const client of clients) await client.close(); write('report.json', report); }
}

if (require.main === module) main({ out: path.resolve(process.argv[2]), serverPath: path.resolve(process.argv[3]), serial: process.argv[4], packageName: process.argv[5] })
  .then(report => process.stdout.write(JSON.stringify(report, null, 2) + '\n'))
  .catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
module.exports = { main };
