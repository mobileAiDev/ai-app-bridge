#!/usr/bin/env node
'use strict';

// Real device regression: node-reference receipts, orderly restart and injected
// owner death. Only the dedicated sample app's counter is changed.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');
const packageName = 'io.github.mobileaidev.aiappbridge.sample';
const devices = { b46093e6: { model: 'PKR110', api: 36 }, KM16232B40184: { model: 'K2_MINI', api: 25 } };
const root = '/data/local/tmp/ai-app-bridge-uia/v1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function nodes(value, found = []) {
  if (value && typeof value === 'object') {
    if (value.text === 'Native Increment' && value.targetRef) found.push(value);
    for (const child of Object.values(value)) nodes(child, found);
  }
  return found;
}
async function main({ out, serverPath, serial }) {
  assert.ok(Object.hasOwn(devices, serial), 'Select an explicitly authorized test device');
  fs.mkdirSync(out);
  const target = { serial, packageName };
  const adb = args => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000 });
  const device = { serial, model: adb(['shell', 'getprop', 'ro.product.model']).trim(),
    api: Number(adb(['shell', 'getprop', 'ro.build.version.sdk']).trim()), bootId: adb(['shell', 'cat', '/proc/sys/kernel/random/boot_id']).trim() };
  assert.equal(device.model, devices[serial].model); assert.equal(device.api, devices[serial].api);
  const apkPath = adb(['shell', 'pm', 'path', packageName]).trim();
  assert.ok(apkPath.startsWith('package:') && !apkPath.includes('\n'));
  const apk = execFileSync('adb', ['-s', serial, 'exec-out', 'cat', apkPath.slice(8)], { timeout: 30000, maxBuffer: 128 * 1024 * 1024 });
  const save = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
  const client = createMcpClient({ serverPath, transcriptPath: path.join(out, 'mcp.jsonl'), stderrPath: path.join(out, 'mcp.stderr'),
    env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' } });
  let sequence = 0;
  const run = async (command, args) => {
    const result = payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
    save(`${String(++sequence).padStart(3, '0')}-${command}.json`, result); return result;
  };
  const good = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
  const report = { ok: false, device, packageName, apkSha256: digest(apk), serverPath, cases: [] };
  const count = async () => {
    const tree = good(await run('tree', { ...target, compact: true, feedback: 'off' }));
    const values = [...new Set([...JSON.stringify(tree).matchAll(/Native counter: (\d+)/g)].map(m => Number(m[1])))];
    assert.equal(values.length, 1); return values[0];
  };
  const observe = async () => {
    const tree = good(await run('uia-tree', { ...target, compact: true, feedback: 'off' }));
    const matches = nodes(tree); assert.equal(matches.length, 1); return matches[0].targetRef;
  };
  try {
    await client.initialize();
    assert.equal(good(await run('device-ownership', { operation: 'status', serial })).active, 0);
    good(await run('launch-activity', { ...target, activity: '.debugbridge.DebugBridgeNativeTestActivity', feedback: 'off' }));
    report.sdk = good(await run('status', { ...target, feedback: 'off' }));
    report.initial = good(await run('uia-runtime', { operation: 'start', serial }));
    report.before = await count(); let expected = report.before, oldRef;
    for (let i = 0; i < 3; i++) {
      oldRef = await observe();
      const action = good(await run('tap-uia', { ...target, targetRef: oldRef, feedback: 'off' }));
      assert.equal(action.executionReceipt.kind, 'uia-node');
      const receipt = JSON.parse(action.executionReceipt.receiptJson);
      assert.equal(receipt.completion, 'original_callback'); assert.equal(receipt.binding.ref, oldRef.nodeRef);
      assert.equal(receipt.binding.selector.kind, 'nodeRef'); assert.equal(receipt.ok, true);
      assert.equal(await count(), ++expected);
      report.cases.push({ name: 'node-ref-click', actionId: action.actionId, expected, receipt });
    }
    report.stopped = good(await run('uia-runtime', { operation: 'stop', serial })); assert.equal(report.stopped.running, false);
    report.reopened = good(await run('uia-runtime', { operation: 'start', serial }));
    assert.notEqual(report.reopened.runtimeEpoch, report.initial.runtimeEpoch); assert.equal(await count(), expected);
    const stale = await run('tap-uia', { ...target, targetRef: oldRef, feedback: 'off' });
    assert.equal(stale.ok, false); assert.equal(stale.dispatched, false); assert.equal(stale.error, 'uia_stale_runtime');
    report.stale = stale.error;
    const ref = await observe();
    const action = good(await run('tap-uia', { ...target, targetRef: ref, feedback: 'off' }));
    assert.equal(await count(), ++expected);
    const beforeDeath = good(await run('uia-runtime', { operation: 'status', serial }));
    assert.equal(beforeDeath.pending, 0); assert.equal(beforeDeath.count, beforeDeath.acknowledged);
    const peer = JSON.parse(adb(['shell', 'cat', root + '/runtime.json']));
    assert.equal(peer.runtimeEpoch, beforeDeath.runtimeEpoch);
    assert.ok(adb(['shell', 'cat', `/proc/${peer.pid}/cmdline`]).includes('io.github.mobileaidev.aiappbridge.uia.UiaRuntime'));
    adb(['shell', 'kill', '-KILL', String(peer.pid)]);
    const dead = await run('uia-tree', { ...target, feedback: 'off' });
    assert.equal(dead.error, 'uia_runtime_unreachable');
    report.afterDeath = good(await run('uia-runtime', { operation: 'start', serial }));
    assert.notEqual(report.afterDeath.runtimeEpoch, beforeDeath.runtimeEpoch); assert.equal(await count(), expected);
    report.cases.push({ name: 'injected-owner-death', originalEpoch: beforeDeath.runtimeEpoch, reopenedEpoch: report.afterDeath.runtimeEpoch, counter: expected, priorActionId: action.actionId });
    const source = `module.exports.main = async ctx => {
      const action = await ctx.call('tap-uia', { targetRef: ctx.inputs.ref, feedback: 'off' });
      if (!action.ok) throw new Error(JSON.stringify(action));
      const tree = await ctx.call('tree', { compact: true });
      if (!tree.ok) throw new Error(JSON.stringify(tree));
      const values = [...new Set([...JSON.stringify(tree.result).matchAll(/Native counter: (\\d+)/g)].map(m => Number(m[1])))];
      const assertion = await ctx.assert({ name: 'UIA callback and independent SDK counter', condition: values.length === 1 && values[0] === ctx.inputs.expected, requiredEvidence: ['tree'], evidence: tree.evidence });
      if (assertion.verdict !== 'passed') throw new Error(JSON.stringify(assertion));
      return { values, assertion, executionReceipt: action.result.executionReceipt };
    };`;
    const script = good(await run('script', { operation: 'start', script: { schemaVersion: 'aab.code-script/v1', target: { platform: 'android', ...target }, language: 'javascript', source,
      permissions: ['app.read', 'app.interact'], policy: { timeoutMs: 20000 }, inputs: { ref: await observe(), expected: ++expected } }, recordingDir: path.join(out, 'script-recording') }));
    let status = script;
    const deadline = Date.now() + 30000;
    while (!['completed', 'failed', 'cancelled'].includes(status.status)) {
      assert.ok(Date.now() < deadline, 'Script exceeded the validation deadline');
      status = good(await run('script', { operation: 'wait', operationId: script.operationId, afterSequence: status.eventSequence, waitMs: 1000 }));
    }
    assert.equal(status.status, 'completed', JSON.stringify(status));
    report.script = good(await run('script', { operation: 'result', operationId: script.operationId }));
    assert.equal(report.script.result.assertion.verdict, 'passed');
    assert.equal(await count(), expected);
    good(await run('screenshot', { ...target, outFile: path.join(out, 'after.png'), feedback: 'off' }));
    report.final = good(await run('uia-runtime', { operation: 'status', serial }));
    assert.equal(report.final.pending, 0); assert.equal(report.final.count, report.final.acknowledged);
    assert.equal(good(await run('device-ownership', { operation: 'status', serial })).active, 0);
    report.after = expected; report.ok = true;
    return report;
  } catch (error) { report.error = error.stack; throw error; }
  finally { save('report.json', report); await client.close(); }
}
if (require.main === module) main({ out: path.resolve(process.argv[2]), serverPath: path.resolve(process.argv[3]), serial: process.argv[4] })
  .then(report => console.log(JSON.stringify({ ok: report.ok, device: report.device, before: report.before, after: report.after, script: report.script.operationId })))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
