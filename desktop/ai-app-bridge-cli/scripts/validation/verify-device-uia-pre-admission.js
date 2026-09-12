#!/usr/bin/env node
'use strict';

// Freeze the public CLI before sending start, then kill the original phone owner.
// Inspect the actual committed prepared record before and after public recovery.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');
const { verifyUiaSampleTarget } = require('./uia-sample-target');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const mainClass = 'io.github.mobileaidev.aiappbridge.uia.UiaRuntime';

async function main({ out, serverPath, serial }) {
  fs.mkdirSync(out); fs.copyFileSync(__filename, path.join(out, 'controller.js'));
  fs.copyFileSync(require.resolve('./uia-sample-target'), path.join(out, 'uia-sample-target.js'));
  const adb = args => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  const shell = script => adb(['shell', 'sh', '-c', quote(script)]);
  const baseline = verifyUiaSampleTarget(adb, serial), target = { serial, packageName: baseline.packageName };
  const root = '/data/local/tmp/ai-app-bridge-uia/v1';
  const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' };
  const bundle = JSON.parse(fs.readFileSync(path.join(path.dirname(serverPath), '../runtime/uia/manifest.json')));
  const installed = `${root}/runtime-${bundle.sha256}.jar`;
  const maintenance = (operation, identity) => shell(`CLASSPATH=${quote(installed)} app_process /system/bin ${mainClass} ${quote(root)} ${bundle.sha256} ${operation}${identity ? ' ' + quote(JSON.stringify(identity)) : ''}`);
  const save = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
  const good = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
  const report = { ok: false, ...baseline, serverPath, runtimeDexSha256: bundle.sha256, controllerSha256: hash(fs.readFileSync(__filename)) };
  let client, child, sequence = 0, opens = 0;
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
  const readOriginal = file => {
    const raw = adb(['shell', 'cat', file]); return { file, raw, sha256: hash(raw), record: JSON.parse(raw) };
  };
  try {
    await open();
    assert.equal(good(await run('device-ownership', { operation: 'status', serial })).active, 0);
    assert.equal(good(await run('device-ownership', { operation: 'reconcile', serial })).pendingAcknowledgements, 0);
    good(await run('launch-activity', { ...target, activity: `${baseline.packageName}.debugbridge.DebugBridgeNativeTestActivity`, feedback: 'off' }));
    report.before = await counter();
    good(await run('screenshot', { ...target, outFile: path.join(out, 'before.png'), feedback: 'off' }));
    const prior = await runtime('status');
    if (prior.running) { assert.equal(prior.pending, 0); await runtime('stop'); }
    report.started = await runtime('start'); assert.equal(report.started.count, 0);
    const descriptor = JSON.parse(adb(['shell', 'cat', `${root}/runtime.json`]));
    assert.equal(descriptor.runtimeEpoch, report.started.runtimeEpoch); assert.equal(descriptor.bootId, baseline.device.bootId);
    assert.equal(descriptor.dexSha256, bundle.sha256);
    await close();

    const actionId = `uia-pre-admission:${Date.now()}`, marker = path.join(out, 'before-start.json'), injector = path.join(out, 'freeze-host.cjs');
    fs.writeFileSync(injector, `const http = require('node:http'), fs = require('node:fs');
const original = http.request;
http.request = function(...args) {
  const request = original.apply(this, args), end = request.end;
  request.end = function(body, ...rest) {
    if (typeof body === 'string') { const payload = JSON.parse(body);
      if (payload.op === 'start' && payload.requestJson && JSON.parse(payload.requestJson).actionId === ${JSON.stringify(actionId)}) {
        fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ point: 'before-start-send', pid: process.pid, payload }));
        process.kill(process.pid, 'SIGSTOP');
      }
    }
    return end.call(this, body, ...rest);
  };
  return request;
};
`);
    const stdout = fs.openSync(path.join(out, 'fault-host.stdout'), 'w'), stderr = fs.openSync(path.join(out, 'fault-host.stderr'), 'w');
    child = spawn(process.execPath, [path.join(path.dirname(serverPath), 'ai-app-bridge.js'), 'tap-uia-text', '--serial', serial,
      '--package-name', baseline.packageName, '--target-text', 'Native Increment', '--request-id', actionId, '--feedback', 'off'],
    { env: { ...process.env, ...env, NODE_OPTIONS: `--require=${injector}` }, stdio: ['ignore', stdout, stderr] });
    const closed = once(child, 'close'); fs.closeSync(stdout); fs.closeSync(stderr);
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(marker)) {
      assert.equal(child.exitCode, null); assert.ok(Date.now() < deadline, 'Host did not reach the pre-start boundary'); await delay(50);
    }
    const frozen = JSON.parse(fs.readFileSync(marker)); assert.equal(frozen.pid, child.pid);
    const request = JSON.parse(frozen.payload.requestJson);
    assert.equal(request.runtimeEpoch, descriptor.runtimeEpoch); assert.equal(request.actionId, actionId);
    const file = `${descriptor.sessionPath}/actions/${hash(actionId)}.json`, original = readOriginal(file);
    assert.equal(original.record.phase, 'prepared'); assert.equal(original.record.interactionId, 0);
    assert.equal(original.record.receiptJson, null); assert.equal(original.record.requestJson, frozen.payload.requestJson);
    save('original-prepared-record.json', original);
    const identity = { bootId: request.bootId, runtimeEpoch: request.runtimeEpoch, actionSha256: hash(actionId),
      requestSha256: frozen.payload.requestSha256, originalDexSha256: descriptor.dexSha256 };
    let liveRejection;
    try { maintenance('recover-record', identity); assert.fail('Live owner must reject maintenance'); }
    catch (error) {
      assert.equal(error.status, 2); liveRejection = JSON.parse(String(error.stderr).trim().split(/\r?\n/).at(-1));
      assert.equal(liveRejection.error, 'uia_runtime_already_running');
    }
    report.liveOwnerRejection = liveRejection; assert.equal(readOriginal(file).sha256, original.sha256);
    const commandLine = adb(['shell', 'cat', `/proc/${descriptor.pid}/cmdline`]); assert.ok(commandLine.includes(mainClass));
    assert.equal(adb(['shell', 'cat', '/proc/sys/kernel/random/boot_id']).trim(), descriptor.bootId);
    adb(['shell', 'kill', '-9', String(descriptor.pid)]);
    report.phoneOwnerAfterKill = JSON.parse(maintenance('owner-status')); assert.equal(report.phoneOwnerAfterKill.owned, false);
    assert.equal(readOriginal(file).sha256, original.sha256);
    child.kill('SIGKILL'); const [code, signal] = await closed; assert.equal(code, null); assert.equal(signal, 'SIGKILL'); child = undefined;
    report.interruption = { point: frozen.point, hostSignal: signal, phoneSignal: 'SIGKILL', phonePid: descriptor.pid,
      bootId: descriptor.bootId, runtimeEpoch: descriptor.runtimeEpoch, actionId, originalRecordSha256: original.sha256 };
    process.stdout.write(JSON.stringify({ point: 'both-original-processes-exited', actionId, originalPhase: 'prepared' }) + '\n');

    await open();
    report.ownershipBeforeRecovery = good(await run('device-ownership', { operation: 'status', serial }));
    assert.equal(report.ownershipBeforeRecovery.ownership.pending.actionId, actionId);
    const blocked = await run('tap-uia-text', { ...target, targetText: 'Native Increment', feedback: 'off' });
    assert.equal(blocked.error, 'device_ownership_unresolved');
    report.recovered = good(await run('device-ownership', { operation: 'reconcile', serial, timeoutMs: 10000 }));
    assert.equal(report.recovered.recovered, true); assert.equal(report.recovered.pendingAcknowledgements, 0);
    assert.equal(report.recovered.cleanupErrors, undefined); assert.equal(report.recovered.executionReceipt.dispatched, false);
    const saved = readOriginal(file), receipt = JSON.parse(saved.record.receiptJson); save('original-recovered-record.json', saved);
    assert.equal(saved.record.acknowledged, true); assert.equal(saved.record.requestJson, original.record.requestJson);
    assert.equal(saved.record.preparedAtElapsedMs, original.record.preparedAtElapsedMs);
    assert.equal(saved.record.deadlineElapsedMs, original.record.deadlineElapsedMs);
    assert.equal(receipt.completion, 'recovered_before_admission'); assert.equal(receipt.recovery.priorRecordSha256, original.sha256);
    assert.equal(receipt.recovery.bootId, descriptor.bootId); assert.equal(Object.hasOwn(receipt, 'completedAtElapsedMs'), false);
    assert.equal(hash(saved.record.receiptJson), saved.record.receiptSha256); await counter(report.before);
    report.recoveryDidNotStartRuntime = JSON.parse(maintenance('owner-status')); assert.equal(report.recoveryDidNotStartRuntime.owned, false);
    assert.equal(JSON.parse(adb(['shell', 'cat', `${root}/runtime.json`])).runtimeEpoch, descriptor.runtimeEpoch);
    good(await run('screenshot', { ...target, outFile: path.join(out, 'after-recovery.png'), feedback: 'off' }));
    const next = await runtime('start'); assert.notEqual(next.runtimeEpoch, descriptor.runtimeEpoch); assert.equal(next.count, 0);
    assert.equal(shell(`if [ -e ${quote(descriptor.sessionPath)} ]; then printf present; else printf absent; fi`).trim(), 'absent');
    report.originalPhoneSessionRetired = true;
    report.nextAction = good(await run('tap-uia-text', { ...target, targetText: 'Native Increment', feedback: 'off' }));
    assert.equal(report.nextAction.cleanupError, undefined); report.after = await counter(report.before + 1);
    good(await run('screenshot', { ...target, outFile: path.join(out, 'after-next-action.png'), feedback: 'off' }));
    report.runtimeStop = await runtime('stop'); await close(); await open();
    const history = good(await run('device-ownership', { operation: 'receipt', serial, runtimeEpoch: descriptor.runtimeEpoch, actionId }));
    assert.equal(history.originalCompletionAvailable, true); assert.equal(history.record.completion.json, saved.record.receiptJson);
    assert.equal(history.record.request.json, original.record.requestJson); report.completionHistory = history;
    report.finalOwnership = good(await run('device-ownership', { operation: 'status', serial }));
    assert.equal(report.finalOwnership.active, 0); assert.equal(report.finalOwnership.ownership.pending, null);
    assert.deepEqual(report.finalOwnership.ownership.pendingAcknowledgements, []); report.ok = true;
  } catch (error) { report.failure = { message: error.message, code: error.code, stack: error.stack }; throw error; }
  finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await close(); save('report.json', report);
  }
  return report;
}

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); return [arg.slice(0, at), arg.slice(at + 1)]; }));
  main({ out: path.resolve(args.out), serverPath: path.resolve(args.server), serial: args.serial }).then(report =>
    process.stdout.write(JSON.stringify({ ok: report.ok, before: report.before, after: report.after, interruption: report.interruption }) + '\n'))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { main };
