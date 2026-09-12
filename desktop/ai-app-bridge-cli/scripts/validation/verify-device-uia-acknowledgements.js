#!/usr/bin/env node
'use strict';

// Real public CLI/MCP, original Android receipts and independent in-app counter.
// Fault injection kills only the Host at exact acknowledgement protocol boundaries.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');
const { verifyUiaSampleTarget } = require('./uia-sample-target');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function main({ out, serverPath, serial }) {
  fs.mkdirSync(out); fs.copyFileSync(__filename, path.join(out, 'controller.js'));
  fs.copyFileSync(require.resolve('./uia-sample-target'), path.join(out, 'uia-sample-target.js'));
  const adb = args => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  const baseline = verifyUiaSampleTarget(adb, serial), target = { serial, packageName: baseline.packageName };
  const root = '/data/local/tmp/ai-app-bridge-uia/v1';
  const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' };
  const save = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
  const good = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
  const report = { ok: false, ...baseline, serverPath, controllerSha256: hash(fs.readFileSync(__filename)), cases: [] };
  let client, sequence = 0, opens = 0;
  const open = async () => {
    assert.equal(client, undefined);
    client = createMcpClient({ serverPath, env, transcriptPath: path.join(out, `mcp-${++opens}.jsonl`), stderrPath: path.join(out, `mcp-${opens}.stderr`) });
    await client.initialize();
  };
  const close = async () => { if (client) { await client.close({ stdinEof: true }); client = undefined; } };
  const run = async (command, args) => {
    const result = payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
    save(`${String(++sequence).padStart(3, '0')}-${command}.json`, result); return result;
  };
  const counter = async expected => {
    const tree = good(await run('tree', { ...target, compact: true, feedback: 'off' }));
    const values = [...new Set([...JSON.stringify(tree).matchAll(/Native counter: (\d+)/g)].map(m => Number(m[1])))];
    assert.equal(values.length, 1); if (expected !== undefined) assert.equal(values[0], expected); return values[0];
  };
  const runtime = async operation => good(await run('uia-runtime', { operation, serial }));
  const readRecord = pending => {
    const file = `${pending.target.sessionPath}/actions/${hash(pending.actionId)}.json`;
    const raw = adb(['shell', 'cat', file]);
    const record = JSON.parse(raw); assert.equal(hash(record.receiptJson), record.receiptSha256);
    return { file, rawSha256: hash(raw), record };
  };
  const absent = file => adb(['shell', 'sh', '-c', quote(`if [ -e ${quote(file)} ]; then printf present; else printf absent; fi`)]).trim() === 'absent';
  try {
    await open();
    assert.equal(good(await run('device-ownership', { operation: 'status', serial })).active, 0);
    assert.equal(good(await run('device-ownership', { operation: 'reconcile', serial })).pendingAcknowledgements, 0);
    const prior = await runtime('status');
    if (prior.running) { assert.equal(prior.pending, 0); await runtime('stop'); }
    report.started = await runtime('start'); assert.equal(report.started.count, 0);
    report.before = await counter(); let expected = report.before;
    good(await run('screenshot', { ...target, outFile: path.join(out, 'before.png'), feedback: 'off' }));
    for (const point of ['before-phone-ack', 'after-phone-ack']) {
      await close(); // A fresh Host owns the same native FactStore during the injected crash.
      const actionId = `uia-ack:${point}:${Date.now()}`, marker = path.join(out, `${point}-crash.json`);
      const injector = path.join(out, `${point}.cjs`);
      fs.writeFileSync(injector, `const http = require('node:http'), fs = require('node:fs');
const original = http.request;
const crash = identity => { fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ point: ${JSON.stringify(point)}, ...identity })); process.kill(process.pid, 'SIGKILL'); };
http.request = function(url, options, callback) {
  let identity;
  const request = original.call(this, url, options, response => {
    if (identity && ${JSON.stringify(point)} === 'after-phone-ack') { crash({ ...identity, statusCode: response.statusCode }); return; }
    callback(response);
  });
  const end = request.end;
  request.end = function(body, ...rest) {
    if (typeof body === 'string') { const payload = JSON.parse(body);
      if (payload.op === 'acknowledge' && payload.requestJson) { const action = JSON.parse(payload.requestJson);
        if (action.actionId === ${JSON.stringify(actionId)}) identity = { actionId: action.actionId, runtimeEpoch: action.runtimeEpoch, receiptSha256: payload.receiptSha256 };
      }
    }
    if (identity && ${JSON.stringify(point)} === 'before-phone-ack') { crash(identity); return request; }
    return end.call(this, body, ...rest);
  };
  return request;
};
`);
      const stdout = fs.openSync(path.join(out, `${point}.stdout`), 'w'), stderr = fs.openSync(path.join(out, `${point}.stderr`), 'w');
      const child = spawn(process.execPath, [path.join(path.dirname(serverPath), 'ai-app-bridge.js'), 'tap-uia-text', '--serial', serial,
        '--package-name', baseline.packageName, '--target-text', 'Native Increment', '--request-id', actionId, '--feedback', 'off'],
      { env: { ...process.env, ...env, NODE_OPTIONS: `--require=${injector}` }, stdio: ['ignore', stdout, stderr] });
      const [code, signal] = await once(child, 'close'); fs.closeSync(stdout); fs.closeSync(stderr);
      assert.equal(code, null); assert.equal(signal, 'SIGKILL'); assert.equal(JSON.parse(fs.readFileSync(marker)).actionId, actionId);
      await open(); await counter(++expected);
      const owned = good(await run('device-ownership', { operation: 'status', serial }));
      assert.equal(owned.active, 0); assert.equal(owned.ownership.pending, null); assert.equal(owned.ownership.pendingAcknowledgements.length, 1);
      const entry = owned.ownership.pendingAcknowledgements[0]; assert.equal(entry.pending.actionId, actionId);
      const original = readRecord(entry.pending); assert.equal(original.record.receiptJson, entry.proof.receiptJson);
      assert.equal(original.record.acknowledged, point === 'after-phone-ack');
      save(`${point}-original-record.json`, original);
      const receipt = good(await run('device-ownership', { operation: 'receipt', serial, runtimeEpoch: entry.pending.runtimeEpoch, actionId }));
      assert.equal(receipt.originalCompletionAvailable, true); assert.equal(receipt.record.completion.json, entry.proof.receiptJson);
      await runtime('stop');
      if (point === 'after-phone-ack') {
        assert.equal((await runtime('start')).count, 0); assert.equal(absent(entry.pending.target.sessionPath), true);
      }
      const recovered = good(await run('device-ownership', { operation: 'reconcile', serial }));
      assert.equal(recovered.recovered, false); assert.equal(recovered.pendingAcknowledgements, 0); assert.equal(recovered.cleanupErrors, undefined);
      assert.equal(recovered.acknowledgements[0].actionId, actionId);
      assert.equal(recovered.acknowledgements[0].disposition, point === 'before-phone-ack' ? 'acknowledged' : 'not_retained');
      if (point === 'before-phone-ack') {
        const stopped = await runtime('status'); assert.equal(stopped.running, false); assert.equal(stopped.runtimeEpoch, entry.pending.runtimeEpoch);
        const acked = readRecord(entry.pending); assert.equal(acked.record.acknowledged, true); assert.equal(acked.record.receiptJson, entry.proof.receiptJson);
        save(`${point}-acknowledged-record.json`, acked);
        assert.equal((await runtime('start')).count, 0); assert.equal(absent(entry.pending.target.sessionPath), true);
      }
      await counter(expected); assert.equal((await runtime('status')).count, 0);
      report.cases.push({ point, actionId, runtimeEpoch: entry.pending.runtimeEpoch, receiptSha256: entry.proof.responseSha256,
        counter: expected, disposition: recovered.acknowledgements[0].disposition, receiptGlobalSeq: receipt.globalSeq, phoneSessionRetired: true });
      process.stdout.write(JSON.stringify({ point, ok: true, counter: expected }) + '\n');
    }
    const finalAction = good(await run('tap-uia-text', { ...target, targetText: 'Native Increment', feedback: 'off' }));
    assert.equal(finalAction.cleanupError, undefined); await counter(++expected);
    report.after = expected; report.finalAction = finalAction.executionReceipt;
    good(await run('screenshot', { ...target, outFile: path.join(out, 'after.png'), feedback: 'off' }));
    await runtime('stop'); report.finalOwnership = good(await run('device-ownership', { operation: 'status', serial }));
    assert.equal(report.finalOwnership.active, 0); assert.equal(report.finalOwnership.ownership.pendingAcknowledgements.length, 0);
    await close(); await open();
    // Query after a later action has overwritten lastSettlement, with a new Host
    // and both old phone sessions gone. Only retained FactStore records can answer.
    for (const item of report.cases) {
      const receipt = good(await run('device-ownership', { operation: 'receipt', serial, runtimeEpoch: item.runtimeEpoch, actionId: item.actionId }));
      assert.equal(receipt.globalSeq, item.receiptGlobalSeq); assert.equal(hash(receipt.record.completion.json), item.receiptSha256);
    }
    report.ok = true;
  } catch (error) { report.failure = { message: error.message, code: error.code, stack: error.stack }; throw error; }
  finally { await close(); save('report.json', report); }
  return report;
}

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); return [arg.slice(0, at), arg.slice(at + 1)]; }));
  main({ out: path.resolve(args.out), serverPath: path.resolve(args.server), serial: args.serial }).then(report =>
    process.stdout.write(JSON.stringify({ ok: report.ok, before: report.before, after: report.after, cases: report.cases }) + '\n')).catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { main };
