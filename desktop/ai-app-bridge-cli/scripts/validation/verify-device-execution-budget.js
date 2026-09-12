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
  const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
  fs.copyFileSync(__filename, path.join(out, 'controller.js'));
  const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' };
  const create = (name, overrides = {}) => createMcpClient({ serverPath, env: { ...env, ...overrides },
    transcriptPath: path.join(out, `${name}.jsonl`), stderrPath: path.join(out, `${name}.log`) });
  const client = create('mcp');
  const runWith = current => async (command, args) => payloadOf(await current.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
  const run = runWith(client);
  const target = { serial, packageName };
  const report = { ok: false, target, serverPath, controllerSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), cases: [] };
  const adbProcesses = () => execFileSync('ps', ['-axo', 'pid,ppid,command'], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match || !match[3].includes(`adb -s ${serial} `)) return [];
    return [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] }];
  });
  try {
    await client.initialize();
    const launched = await run('launch-app', { ...target, timeoutMs: 45000, adbTimeoutMs: 30000, feedback: 'off' });
    write('launch.json', launched); assert.equal(launched.ok, true, JSON.stringify(launched));
    write('before-screenshot.json', await run('screenshot', { ...target, outFile: path.join(out, 'before.png'), feedback: 'off' }));
    for (const scenario of ['normal', 'cancel', 'timeout']) {
      for (const language of ['javascript', 'python']) {
        const name = `${scenario}-${language}`;
        const source = scenario === 'timeout'
          ? (language === 'javascript' ? 'module.exports.main = async ctx => { while (true) await ctx.call("uia-tree"); };'
            : 'def main(ctx):\n    while True: ctx.call("uia-tree")\n')
          : (language === 'javascript' ? 'module.exports.main = async ctx => { const tree = await ctx.call("uia-tree"); if (!tree.ok) throw new Error(tree.error); return ctx.call("keyevent", {keyCode: 0}); };'
            : 'def main(ctx):\n    tree = ctx.call("uia-tree")\n    if not tree["ok"]: raise Exception(tree["error"])\n    return ctx.call("keyevent", {"keyCode": 0})\n');
        const spec = { schemaVersion: 'aab.code-script/v1', language, source, target: { platform: 'android', ...target }, policy: { timeoutMs: scenario === 'timeout' ? 700 : 20000 } };
        write(`${name}-source.json`, spec);
        const startedAt = Date.now();
        let state = await run('script', { operation: 'start', script: spec });
        assert.equal(state.ok, true, JSON.stringify(state));
        const operationId = state.operationId;
        let cancelledPid = null;
        if (scenario === 'cancel') {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const process = adbProcesses().find(row => row.command.includes('shell uiautomator dump'));
            if (process) { cancelledPid = process.pid; write(`${name}-inflight-process.json`, process); break; }
            await delay(10);
          }
          assert.ok(cancelledPid, 'a real UIAutomator Host subprocess must be active at cancellation');
          const cancellationAt = Date.now();
          state = await run('script', { operation: 'cancel', operationId });
          report.lastCancellationMs = Date.now() - cancellationAt;
          assert.throws(() => process.kill(cancelledPid, 0), { code: 'ESRCH' });
        }
        const deadline = Date.now() + 25000;
        while (!['completed', 'failed', 'cancelled'].includes(state.status) && Date.now() < deadline) {
          state = await run('script', { operation: 'wait', operationId, afterSequence: state.eventSequence, waitMs: 1000 });
        }
        state = await run('script', { operation: 'status', operationId });
        write(`${name}-result.json`, state);
        assert.equal(state.status, scenario === 'normal' ? 'completed' : scenario === 'cancel' ? 'cancelled' : 'failed');
        assert.equal(state.error, scenario === 'timeout' ? 'timeout' : null);
        const actions = state.events.filter(event => event.type === 'action_receipt');
        assert.equal(actions.length, scenario === 'normal' ? 1 : 0);
        if (scenario === 'normal') {
          assert.equal(actions[0].payloadSummary.dispatched, true);
          assert.equal(actions[0].payloadSummary.ambiguous, false);
        } else {
          const failed = state.events.find(event => event.type === 'call_failed');
          assert.equal(failed?.error, scenario === 'cancel' ? 'cancelled' : 'deadline_exceeded');
        }
        const residual = adbProcesses(); write(`${name}-residual-processes.json`, residual);
        assert.deepEqual(residual, []);
        const archive = await run('evidence', { operation: 'export', namespace: 'script', operationId, outputDir: path.join(out, `${name}-archive`) });
        assert.equal(archive.ok, true, JSON.stringify(archive));
        report.cases.push({ name, operationId, status: state.status, error: state.error, elapsedMs: Date.now() - startedAt,
          actionCount: actions.length, cancelledPid, residualProcesses: 0,
          ...(scenario === 'cancel' ? { cancellationMs: report.lastCancellationMs } : {}), archive });
      }
    }
    write('after-screenshot.json', await run('screenshot', { ...target, outFile: path.join(out, 'after.png'), feedback: 'off' }));
    await client.close();
    const unusableStore = path.join(out, 'unusable-store'); fs.writeFileSync(unusableStore, 'not a directory');
    const offline = create('offline', { AI_APP_BRIDGE_FACT_STORE_DIR: unusableStore, ADB: path.join(out, 'no-adb') });
    try {
      await offline.initialize();
      for (const item of report.cases) {
        const copy = path.join(out, `${item.name}-moved-archive`); fs.cpSync(item.archive.archiveDir, copy, { recursive: true });
        item.offline = await runWith(offline)('evidence', { operation: 'verify', archiveDir: copy, manifestSha256: item.archive.manifestSha256 });
        assert.equal(item.offline.ok, true, JSON.stringify(item.offline));
      }
    } finally { await offline.close(); }
    delete report.lastCancellationMs;
    report.ok = true;
    return report;
  } catch (error) { report.error = error.stack || String(error); throw error; }
  finally { await client.close(); write('report.json', report); }
}

if (require.main === module) main({ out: path.resolve(process.argv[2]), serverPath: path.resolve(process.argv[3]), serial: process.argv[4], packageName: process.argv[5] })
  .then(report => process.stdout.write(JSON.stringify(report, null, 2) + '\n'))
  .catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
module.exports = { main };
