#!/usr/bin/env node
'use strict';

// Packaged public Script -> 257 real node actions -> independent SDK counters.
// SIGKILL is deliberately AFTER verified terminal acknowledgement, not during
// an unknown action. JVM/Host negative tests cover refusing unresolved history.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function regression(ctx) {
  const epochs = [], assertions = [];
  let lastBinding;
  for (let index = 1; index <= ctx.inputs.count; index++) {
    const action = await ctx.call('tap-uia-text', { targetText: 'Native Increment', feedback: 'off' });
    if (!action.ok || action.result.cleanupError || action.result.executionReceipt?.kind !== 'uia-node') throw new Error(JSON.stringify(action));
    const proof = action.result.executionReceipt, receipt = JSON.parse(proof.receiptJson);
    if (!receipt.ok || !receipt.dispatched || receipt.completion !== 'original_callback') throw new Error(JSON.stringify(receipt));
    let epoch = epochs.at(-1);
    if (!epoch || epoch.runtimeEpoch !== proof.runtimeEpoch) {
      epoch = { runtimeEpoch: proof.runtimeEpoch, first: index, count: 0 }; epochs.push(epoch);
    }
    epoch.count++;
    lastBinding = { bootId: proof.bootId, runtimeEpoch: proof.runtimeEpoch,
      target: { snapshotId: receipt.binding.snapshotId, ref: receipt.binding.ref, selector: receipt.binding.selector } };
    if ([1, 64, 128, 192, 255, 256, ctx.inputs.count].includes(index)) {
      const read = await ctx.call('tree', { compact: true, feedback: 'off' });
      if (!read.ok) throw new Error(JSON.stringify(read));
      const values = [...new Set([...JSON.stringify(read.result).matchAll(/Native counter: (\d+)/g)].map(match => Number(match[1])))];
      const checked = await ctx.assert({ name: `independent SDK counter after ${index} UIA actions`,
        condition: values.length === 1 && values[0] === ctx.inputs.before + index,
        requiredEvidence: ['tree'], evidence: read.evidence });
      assertions.push({ index, values, verdict: checked.verdict });
      if (checked.verdict !== 'passed') throw new Error(JSON.stringify(checked));
      await ctx.progress({ completed: index, total: ctx.inputs.count, runtimeEpoch: epoch.runtimeEpoch });
    }
  }
  const picture = await ctx.call('screenshot', { outFile: ctx.inputs.screenshot, feedback: 'off' });
  if (!picture.ok) throw new Error(JSON.stringify(picture));
  return { count: ctx.inputs.count, epochs, assertions, lastBinding };
}

function proofs(value, found = new Map()) {
  if (value && typeof value === 'object') {
    if (value.kind === 'uia-node' && value.settled === true && typeof value.receiptJson === 'string') {
      assert.equal(sha256(value.receiptJson), value.responseSha256);
      const receipt = JSON.parse(value.receiptJson);
      assert.equal(receipt.actionId, value.actionId); assert.equal(receipt.requestSha256, value.requestSha256);
      found.set(value.actionId, value);
    }
    for (const child of Object.values(value)) proofs(child, found);
  }
  return found;
}

async function main({ out, serverPath, serial }) {
  assert.ok(['FYZLAU49X8OVQGJ7', 'b46093e6'].includes(serial), 'An authorized OPPO serial is required');
  fs.mkdirSync(out); fs.copyFileSync(__filename, path.join(out, 'controller.js'));
  const save = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2) + '\n');
  const adb = args => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  const root = '/data/local/tmp/ai-app-bridge-uia/v1';
  const packageName = 'io.github.mobileaidev.aiappbridge.sample', target = { serial, packageName };
  const { device, apkSha256 } = require('./uia-sample-target').verifyUiaSampleTarget(adb, serial);
  const clients = [], env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' };
  const open = async (name, overrides = {}) => {
    const client = createMcpClient({ serverPath, env: { ...env, ...overrides },
      transcriptPath: path.join(out, `${name}.jsonl`), stderrPath: path.join(out, `${name}.stderr`) });
    clients.push(client); await client.initialize(); return client;
  };
  let sequence = 0, client;
  const run = async (command, args) => {
    const result = payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
    save(`${String(++sequence).padStart(3, '0')}-${command}.json`, result); return result;
  };
  const good = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
  const counter = async expected => {
    const read = good(await run('tree', { ...target, compact: true, feedback: 'off' }));
    const values = [...new Set([...JSON.stringify(read).matchAll(/Native counter: (\d+)/g)].map(match => Number(match[1])))];
    assert.equal(values.length, 1); if (expected !== undefined) assert.equal(values[0], expected); return values[0];
  };
  const snapshot = label => {
    const files = adb(['shell', 'find', root, '-type', 'f']).trim().split(/\r?\n/).filter(Boolean);
    const summary = { files: [], sessions: new Set(), records: 0, jars: 0 };
    for (const file of files.sort()) {
      assert.ok(file.startsWith(root + '/'));
      const relative = file.slice(root.length + 1);
      const entry = { path: relative };
      if (/^sessions\/[^/]+\/actions\/[0-9a-f]{64}\.json$/.test(relative)) {
        const raw = adb(['shell', 'cat', file]), record = JSON.parse(raw);
        const destination = path.join(out, label, relative); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, raw);
        entry.sha256 = sha256(raw); entry.phase = record.phase; entry.acknowledged = record.acknowledged;
        summary.records++; summary.sessions.add(relative.split('/')[1]);
      } else if (relative === 'runtime.json' || /^sessions\/[^/]+\/runtime\.json$/.test(relative)) {
        const { token, ...descriptor } = JSON.parse(adb(['shell', 'cat', file]));
        assert.equal(typeof token, 'string'); entry.descriptor = descriptor;
        if (relative.startsWith('sessions/')) summary.sessions.add(relative.split('/')[1]);
      } else if (/^runtime-[0-9a-f]{64}\.jar$/.test(relative)) summary.jars++;
      summary.files.push(entry);
    }
    summary.sessions = [...summary.sessions]; summary.diskUsage = adb(['shell', 'du', '-sk', root]).trim();
    save(`${label}.json`, summary); return summary;
  };
  const report = { ok: false, target, device, apkSha256, serverPath, controllerSha256: sha256(fs.readFileSync(__filename)) };
  try {
    client = await open('public-mcp');
    assert.equal(good(await run('device-ownership', { operation: 'status', serial })).active, 0);
    const status = good(await run('status', { ...target, full: true, feedback: 'off' }));
    assert.ok(JSON.stringify(status).includes('DebugBridgeNativeTestActivity'));
    report.before = await counter(); snapshot('phone-before');
    const initial = good(await run('uia-runtime', { operation: 'status', serial }));
    if (initial.running) {
      assert.equal(initial.pending, 0); assert.equal(initial.acknowledged, initial.count);
      good(await run('uia-runtime', { operation: 'stop', serial }));
    }
    report.started = good(await run('uia-runtime', { operation: 'start', serial })); assert.equal(report.started.count, 0);
    good(await run('screenshot', { ...target, outFile: path.join(out, 'before.png'), feedback: 'off' }));
    const spec = { schemaVersion: 'aab.code-script/v1', name: 'UIA continuous epoch rotation', language: 'javascript', target: { platform: 'android', ...target },
      source: `module.exports.main = ${regression.toString()};`, inputs: { count: 257, before: report.before, screenshot: path.join(out, 'script-after.png') },
      permissions: ['app.read', 'app.interact'], policy: { timeoutMs: 600000 } };
    save('script-spec.json', spec);
    const startedAt = Date.now();
    let state = good(await run('script', { operation: 'start', script: spec, recordingDir: path.join(out, 'recording') }));
    report.operationId = state.operationId;
    while (!['completed', 'failed', 'cancelled'].includes(state.status)) {
      assert.ok(Date.now() - startedAt < 610000);
      state = await run('script', { operation: 'wait', operationId: state.operationId, afterSequence: state.eventSequence, waitMs: 10000 });
      const progress = state.events?.filter(event => event.type === 'progress').at(-1);
      if (progress || state.status !== 'running') process.stdout.write(JSON.stringify({ status: state.status, sequence: state.eventSequence, progress }) + '\n');
    }
    report.elapsedMs = Date.now() - startedAt;
    state = await run('script', { operation: 'status', operationId: state.operationId });
    assert.equal(state.status, 'completed', JSON.stringify(state));
    const resultEnvelope = await run('script', { operation: 'result', operationId: state.operationId });
    assert.equal(resultEnvelope.ok, true, JSON.stringify(resultEnvelope)); assert.equal(resultEnvelope.persisted, true);
    report.script = resultEnvelope.result;
    assert.deepEqual(report.script.epochs.map(epoch => epoch.count), [256, 1]);
    assert.equal(report.script.assertions.length, 7); assert.ok(report.script.assertions.every(item => item.verdict === 'passed'));
    await counter(report.before + 257);
    report.rotated = good(await run('uia-runtime', { operation: 'status', serial }));
    assert.equal(report.rotated.runtimeEpoch, report.script.epochs[1].runtimeEpoch);
    assert.equal(report.rotated.count, 1); assert.equal(report.rotated.pending, 0); assert.equal(report.rotated.acknowledged, 1);
    report.phoneAfterRotation = snapshot('phone-after-rotation');
    assert.deepEqual(report.phoneAfterRotation.sessions, [report.rotated.runtimeEpoch]);
    assert.equal(report.phoneAfterRotation.records, 1); assert.equal(report.phoneAfterRotation.jars, 1);
    assert.equal(good(await run('device-ownership', { operation: 'status', serial })).active, 0);

    report.archive = good(await run('evidence', { operation: 'export', namespace: 'script', operationId: report.operationId,
      outputDir: path.join(out, 'archive'), includeRecordedPayloads: true }));
    const originals = proofs(JSON.parse(fs.readFileSync(path.join(report.archive.archiveDir, 'records.json'))));
    assert.equal(originals.size, 257); report.originalReceipts = originals.size;
    save('original-proofs.json', [...originals.values()]);

    const peer = JSON.parse(adb(['shell', 'cat', root + '/runtime.json']));
    assert.equal(peer.runtimeEpoch, report.rotated.runtimeEpoch); assert.ok(Number.isInteger(peer.pid) && peer.pid > 0);
    const command = adb(['shell', 'cat', `/proc/${peer.pid}/cmdline`]);
    assert.ok(command.includes('io.github.mobileaidev.aiappbridge.uia.UiaRuntime') && command.includes(root));
    report.kill = { pid: peer.pid, runtimeEpoch: peer.runtimeEpoch, at: new Date().toISOString(), pending: 0, acknowledged: 1 };
    adb(['shell', 'kill', '-KILL', String(peer.pid)]); await delay(150);
    const deadRead = await run('uia-tree', { serial, packageName, feedback: 'off' });
    assert.equal(deadRead.ok, false); assert.equal(deadRead.error, 'uia_runtime_unreachable'); report.deadRead = { error: deadRead.error };
    const stillOriginal = JSON.parse(adb(['shell', 'cat', root + '/runtime.json']));
    assert.equal(stillOriginal.runtimeEpoch, peer.runtimeEpoch); assert.equal(stillOriginal.running, true);
    report.reopened = good(await run('uia-runtime', { operation: 'start', serial }));
    assert.notEqual(report.reopened.runtimeEpoch, peer.runtimeEpoch); assert.equal(report.reopened.count, 0);
    await counter(report.before + 257);

    const installedBin = path.dirname(serverPath);
    const { executeUiaAction } = require(path.join(installedBin, 'shared-kernel/uia-execution'));
    report.stale = await executeUiaAction({ adb: 'adb', serial, binding: report.script.lastBinding, actionId: 'stale-after-runtime-reopen' });
    assert.equal(report.stale.error, 'uia_stale_runtime'); assert.equal(report.stale.dispatched, false);
    good(await run('tap-uia-text', { ...target, targetText: 'Native Increment', feedback: 'off' }));
    report.after = await counter(report.before + 258);
    good(await run('screenshot', { ...target, outFile: path.join(out, 'after.png'), feedback: 'off' }));
    report.final = good(await run('uia-runtime', { operation: 'status', serial }));
    assert.equal(report.final.pending, 0); assert.equal(report.final.count, report.final.acknowledged);
    report.stopped = good(await run('uia-runtime', { operation: 'stop', serial })); assert.equal(report.stopped.running, false);
    report.phoneFinal = snapshot('phone-final');
    assert.equal(report.phoneFinal.records, 1); assert.equal(report.phoneFinal.sessions.length, 1);
    assert.equal(good(await run('device-ownership', { operation: 'status', serial })).active, 0);
    assert.deepEqual(await client.close({ stdinEof: true }), { code: 0, signal: null });
    client = await open('reopened-mcp');
    const restored = good(await run('script', { operation: 'status', operationId: report.operationId }));
    assert.equal(restored.status, 'completed'); assert.equal(restored.restored, true); assert.equal(restored.persisted, true); assert.equal(restored.resumable, false);
    report.restored = { status: restored.status, persisted: true, resumable: false }; await client.close();
    const unavailable = path.join(out, 'unavailable-store'); fs.writeFileSync(unavailable, 'not a directory');
    client = await open('offline', { AI_APP_BRIDGE_FACT_STORE_DIR: unavailable, ADB: path.join(out, 'unavailable-adb') });
    const moved = path.join(out, 'moved-archive'); fs.cpSync(report.archive.archiveDir, moved, { recursive: true });
    report.offline = good(await run('evidence', { operation: 'verify', archiveDir: moved, manifestSha256: report.archive.manifestSha256 }));
    report.ok = true; return report;
  } catch (error) { report.error = error.stack; throw error; }
  finally { for (const opened of clients) await opened.close(); save('report.json', report); }
}

if (require.main === module) main({ out: path.resolve(process.argv[2]), serverPath: path.resolve(process.argv[3]), serial: process.argv[4] })
  .then(report => process.stdout.write(JSON.stringify({ ok: report.ok, before: report.before, after: report.after, elapsedMs: report.elapsedMs,
    receipts: report.originalReceipts, epochs: report.script.epochs, recordsOnPhone: report.phoneFinal.records }) + '\n'))
  .catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
module.exports = { main };
