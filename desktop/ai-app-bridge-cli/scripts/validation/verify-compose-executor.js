'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

async function main() {
  const serial = process.argv[2];
  if (!serial) throw new Error('Pass the explicit Android device serial.');
  const directory = path.resolve(process.argv[3] || '../../build/executor-0.3.6');
  process.env.AI_APP_BRIDGE_EXECUTOR_HOME = path.join(directory, 'cache');
  process.env.AI_APP_BRIDGE_FACT_STORE_DIR = path.join(directory, 'compose-facts');
  const host = require('../../bin/execution-host');
  const target = { serial, packageName: 'io.github.mobileaidev.aiappbridge.sample', adb: process.env.ADB || 'adb' };
  const proof = { startedAt: new Date().toISOString(), target, calls: [], checks: [] };
  let identity, observation;
  const run = async args => {
    const started = performance.now();
    const value = (await host.run({ command: 'android-executor', arguments: { ...target, ...identity, ...args } })).value;
    proof.calls.push({ arguments: args, value, elapsedMs: performance.now() - started });
    return value;
  };
  const observe = async (engine = 'compose') => {
    const value = await run({ operation: 'observe', engine });
    assert.equal(value.ok, true, JSON.stringify(value));
    observation = value.observation;
    return observation;
  };
  const one = tag => {
    const nodes = observation.nodes.filter(node => node.tag === tag);
    assert.equal(nodes.length, 1, JSON.stringify(nodes)); return nodes[0];
  };
  const act = async (type, tag, options = {}, actionId) => {
    const action = { type, nodeId: one(tag).nodeId, ...options };
    const result = await run({ operation: 'act', snapshotId: observation.snapshotId, action, ...(actionId ? { actionId } : {}) });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.executionReceipt.settled, true); return result;
  };
  try {
    const open = await run({ operation: 'open', instrumentation: target.packageName + '.test/androidx.test.runner.AndroidJUnitRunner',
      testClass: target.packageName + '.ComposeBridgeSessionTest', activity: target.packageName + '.debugbridge.ComposeExecutorFixtureActivity' });
    assert.equal(open.ok, true, JSON.stringify(open));
    identity = { sessionId: open.sessionId, runtimeEpoch: open.runtimeEpoch };
    proof.open = open;
    assert.ok(open.capabilities.adapters.compose);
    await observe();
    assert.deepEqual(one('counter').text, ['Counter: 0']);
    const clicked = await act('click', 'increment', {}, 'compose-increment-once');
    assert.equal(clicked.action.mechanism, 'compose-touch-input');
    assert.equal((await act('click', 'increment', {}, 'compose-increment-once')).replayed, true);
    await observe();
    assert.deepEqual(one('counter').text, ['Counter: 1']);
    await act('composeReplaceText', 'name', { text: 'Compose 中文商品 123' });
    await observe();
    assert.equal(one('name').editableText, 'Compose 中文商品 123');
    assert.deepEqual(one('selected').text, ['Selected: Compose 中文商品 123']);
    const snapshot = observation;
    await observe('uiautomator');
    assert.ok(observation.nodes.some(node => node.text === 'Counter: 1'));
    assert.ok(observation.nodes.some(node => node.text === 'Selected: Compose 中文商品 123'));
    const stale = await run({ operation: 'act', snapshotId: snapshot.snapshotId, action: { type: 'click', nodeId: snapshot.nodes.find(node => node.tag === 'increment').nodeId } });
    assert.equal(stale.error, 'reobserve_required'); assert.equal(stale.dispatched, false);
    await observe();
    await act('composeClearText', 'name');
    await observe();
    assert.equal(one('name').editableText, '');
    proof.checks.push('Compose touch click and exactly-once receipt; Chinese semantics input and clear independently read back');
    proof.checks.push('UI Automator reads the same Compose application; switching adapters invalidates previous snapshot');
    const screenshot = await execFile(target.adb, ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
    proof.screenshot = path.join(directory, 'compose-executor.png'); fs.writeFileSync(proof.screenshot, screenshot.stdout);
    const close = await run({ operation: 'close' }); assert.equal(close.ok, true, JSON.stringify(close));
    const receipt = await run({ operation: 'receipt', actionId: 'compose-increment-once' });
    assert.equal(receipt.receipt.result.ok, true); identity = null;
    proof.checks.push('JUnit rule spans the entire session; original receipt remains after exact process exits');
    proof.ok = true;
  } finally {
    if (identity) { try { proof.cleanup = await run({ operation: 'close' }); } catch (error) { proof.cleanup = { error: error.message }; } }
    await host.close();
    fs.writeFileSync(path.join(directory, 'compose-executor-verification.json'), JSON.stringify(proof, null, 2));
  }
  process.stdout.write(JSON.stringify({ ok: true, checks: proof.checks, evidence: path.join(directory, 'compose-executor-verification.json') }) + '\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
