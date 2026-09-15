'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const serial = process.argv[2];
  if (!serial) throw new Error('Pass the explicit Android device serial.');
  const directory = path.resolve(process.argv[3] || '../../build/executor-0.3.7');
  process.env.AI_APP_BRIDGE_EXECUTOR_HOME = path.join(directory, 'cache');
  process.env.AI_APP_BRIDGE_FACT_STORE_DIR = path.join(directory, 'cancellation-facts');
  const host = require('../../bin/execution-host');
  const target = { serial, packageName: 'io.github.mobileaidev.aiappbridge.sample', adb: process.env.ADB || 'adb' };
  const proof = { startedAt: new Date().toISOString(), target, calls: [] };
  let identity;
  const run = async args => {
    const value = (await host.run({ command: 'android-executor', arguments: { ...target, ...identity, ...args } })).value;
    proof.calls.push({ arguments: args, value });
    return value;
  };
  const observe = async () => {
    const value = await run({ operation: 'observe', engine: 'espresso' });
    assert.equal(value.ok, true, JSON.stringify(value));
    return value.observation;
  };
  const one = (observation, predicate) => {
    const found = observation.nodes.filter(predicate);
    assert.equal(found.length, 1, JSON.stringify(found));
    return found[0];
  };
  try {
    const open = await run({ operation: 'open', instrumentation: target.packageName + '.test/androidx.test.runner.AndroidJUnitRunner',
      testClass: target.packageName + '.BridgeSessionTest', activity: target.packageName + '.debugbridge.DebugBridgeNativeTestActivity' });
    assert.equal(open.ok, true, JSON.stringify(open));
    identity = { sessionId: open.sessionId, runtimeEpoch: open.runtimeEpoch };
    const before = await observe();
    assert.match(one(before, node => node.description === 'native_counter_status').text, /0$/);
    const button = one(before, node => node.text === 'Native Increment');
    const original = { operation: 'act', snapshotId: before.snapshotId, actionId: 'deadline-click', action: { type: 'click', nodeId: button.nodeId } };
    const result = await run({ ...original, timeoutMs: 150 });
    // Espresso has already injected the touch. Cancellation waits for that exact
    // action and reports its successful receipt; it cannot roll the click back.
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.recovered, true, JSON.stringify(result));
    assert.equal(result.cancelRequested, true);
    assert.equal(result.executionReceipt.settled, true);
    assert.equal((await run(original)).replayed, true);
    const after = await observe();
    assert.match(one(after, node => node.description === 'native_counter_status').text, /1$/);
    const close = await run({ operation: 'close' });
    assert.equal(close.ok, true, JSON.stringify(close));
    const retained = await run({ operation: 'receipt', actionId: original.actionId });
    assert.equal(retained.receipt.result.ok, true);
    assert.equal(retained.receipt.result.cancelRequested, true);
    identity = null;
    proof.ok = true;
    proof.conclusion = 'Deadline cancellation retained the original successful touch receipt; duplicate request did not click twice; subsequent observation and close succeeded.';
  } finally {
    if (identity) proof.cleanup = await run({ operation: 'close' }).catch(error => ({ error: error.message }));
    await host.close();
    fs.writeFileSync(path.join(directory, 'android-executor-cancellation.json'), JSON.stringify(proof, null, 2));
  }
  process.stdout.write(JSON.stringify({ ok: proof.ok, conclusion: proof.conclusion }) + '\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
