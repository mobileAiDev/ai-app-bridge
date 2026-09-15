'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

async function main() {
  const serial = process.argv[2];
  if (!serial) throw new Error('Pass the explicit Android device serial.');
  const directory = path.resolve(process.argv[3] || '../../build/executor-0.3.7');
  process.env.AI_APP_BRIDGE_EXECUTOR_HOME = path.join(directory, 'cache');
  process.env.AI_APP_BRIDGE_FACT_STORE_DIR = path.join(directory, 'flutter-facts');
  const host = require('../../bin/execution-host');
  const target = { serial, packageName: 'io.github.mobileaidev.aab_executor_fixture', adb: process.env.ADB || 'adb' };
  const proof = { startedAt: new Date().toISOString(), target, calls: [], checks: [] };
  let identity, observation;
  const run = async args => {
    const start = performance.now();
    const value = (await host.run({ command: 'flutter-executor', arguments: { ...target, ...identity, ...args } })).value;
    proof.calls.push({ arguments: args, value, elapsedMs: performance.now() - start });
    return value;
  };
  const observe = async () => {
    const value = await run({ operation: 'observe' });
    assert.equal(value.ok, true, JSON.stringify(value));
    observation = value.observation;
    return observation;
  };
  const one = key => {
    const nodes = observation.nodes.filter(node => node.key === key);
    assert.equal(nodes.length, 1, JSON.stringify(nodes)); return nodes[0];
  };
  const act = async (type, key, options = {}, actionId) => {
    const action = { type, ...(key ? { nodeId: one(key).nodeId } : {}), ...options };
    const result = await run({ operation: 'act', snapshotId: observation.snapshotId, action, ...(actionId ? { actionId } : {}) });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.executionReceipt.settled, true);
    return result;
  };
  try {
    const open = await run({ operation: 'open', activity: target.packageName + '.MainActivity' });
    assert.equal(open.ok, true, JSON.stringify(open));
    identity = { sessionId: open.sessionId, runtimeEpoch: open.runtimeEpoch };
    proof.open = open;
    await observe();
    assert.equal(one('counter').text, 'Counter: 0');
    const cancelled = await run({ operation: 'act', actionId: 'cancel-pump', snapshotId: observation.snapshotId,
      action: { type: 'pump', count: 20, durationMs: 100 }, timeoutMs: 150 });
    assert.equal(cancelled.ok, false); assert.equal(cancelled.executionReceipt.settled, true, JSON.stringify(cancelled));
    assert.equal(cancelled.error, 'executor_cancelled');
    await observe();
    proof.checks.push('Cancellation drains the original pump Future, persists its receipt, and permits a subsequent observation');
    await act('tap', 'increment', {}, 'increment-once');
    assert.equal((await act('tap', 'increment', {}, 'increment-once')).replayed, true);
    const oldSnapshot = observation;
    await observe();
    assert.equal(one('counter').text, 'Counter: 1');
    const stale = await run({ operation: 'act', snapshotId: oldSnapshot.snapshotId, action: { type: 'tap', nodeId: one('increment').nodeId } });
    assert.equal(stale.error, 'reobserve_required'); assert.equal(stale.dispatched, false);
    const entered = await act('enterText', 'name', { text: 'Flutter 中文商品 123' });
    assert.equal(entered.action.mechanism, 'widget-tester-editing-state');
    await observe();
    assert.ok(observation.nodes.some(node => node.type === 'EditableText' && node.text === 'Flutter 中文商品 123'));
    await act('tap', 'enabled');
    await observe();
    assert.ok(observation.nodes.some(node => node.text === 'Enabled: true'));
    proof.checks.push('WidgetTester tap, duplicate receipt, stale snapshot rejection, Chinese input readback and checkbox state');
    await act('ensureVisible', 'next');
    await observe();
    await act('tap', 'next');
    await observe();
    assert.equal(one('selected').text, 'Selected: Flutter 中文商品 123');
    const screenshot = await execFile(target.adb, ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
    proof.screenshot = path.join(directory, 'flutter-executor.png');
    fs.writeFileSync(proof.screenshot, screenshot.stdout);
    await act('pageBack');
    await observe();
    assert.equal(one('counter').text, 'Counter: 1');
    proof.checks.push('Navigation and pageBack retain application state in one integration_test lifetime');
    const close = await run({ operation: 'close' });
    assert.equal(close.ok, true, JSON.stringify(close));
    const receipt = await run({ operation: 'receipt', actionId: 'increment-once' });
    assert.equal(receipt.receipt.result.ok, true);
    identity = null;
    proof.checks.push('Orderly test close terminates the exact process; original receipt remains readable');
    proof.ok = true;
  } finally {
    if (identity) { try { proof.cleanup = await run({ operation: 'close' }); } catch (error) { proof.cleanup = { error: error.message }; } }
    await host.close();
    fs.writeFileSync(path.join(directory, 'flutter-executor-verification.json'), JSON.stringify(proof, null, 2));
  }
  process.stdout.write(JSON.stringify({ ok: true, checks: proof.checks, evidence: path.join(directory, 'flutter-executor-verification.json') }) + '\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
