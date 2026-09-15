'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const serial = process.argv[2];
  if (!serial) throw new Error('Pass the explicit validation-device serial.');
  const directory = path.resolve(process.argv[3] || '../../build/executor-0.3.6');
  process.env.AI_APP_BRIDGE_EXECUTOR_HOME = path.join(directory, 'cache');
  process.env.AI_APP_BRIDGE_FACT_STORE_DIR = path.join(directory, 'benchmark-facts');
  const host = require('../../bin/execution-host');
  const target = { serial, packageName: 'io.github.mobileaidev.aiappbridge.sample', adb: process.env.ADB || 'adb' };
  const proof = { startedAt: new Date().toISOString(), target, samples: [],
    scope: 'Same device, installed APK, Activity, JUnit lifetime and counter button. Alternate Espresso system touch and existing SDK touch. Every sample uses the same Espresso before/after observation and independent counter assertion. Host command and receipt persistence included; model, CLI startup and screenshot excluded.' };
  let identity;
  const run = async (command, args) => {
    const started = performance.now();
    const value = (await host.run({ command, arguments: { ...target, ...args, feedback: 'off' } })).value;
    assert.equal(value.ok, true, JSON.stringify(value));
    return { value, elapsedMs: performance.now() - started };
  };
  const observe = () => run('android-executor', { ...identity, operation: 'observe', engine: 'espresso' });
  const one = (observation, predicate) => { const nodes = observation.nodes.filter(predicate); assert.equal(nodes.length, 1); return nodes[0]; };
  try {
    const opened = await run('android-executor', { operation: 'open', instrumentation: target.packageName + '.test/androidx.test.runner.AndroidJUnitRunner',
      testClass: target.packageName + '.BridgeSessionTest', activity: target.packageName + '.debugbridge.DebugBridgeNativeTestActivity' });
    identity = { sessionId: opened.value.sessionId, runtimeEpoch: opened.value.runtimeEpoch }; proof.open = opened;
    proof.sdkPreparation = await run('tree', { compact: false });
    for (let round = 0; round < 22; round++) {
      for (const engine of round % 2 === 0 ? ['espresso', 'sdk'] : ['sdk', 'espresso']) {
        const before = await observe(), observation = before.value.observation;
        const count = one(observation, node => node.description === 'native_counter_status').text;
        const button = one(observation, node => node.text === 'Native Increment');
        let action;
        if (engine === 'espresso') action = await run('android-executor', { ...identity, operation: 'act', snapshotId: observation.snapshotId,
          action: { type: 'click', nodeId: button.nodeId } });
        else action = await run('tap', { tapX: Math.round((button.bounds[0] + button.bounds[2]) / 2), tapY: Math.round((button.bounds[1] + button.bounds[3]) / 2) });
        const after = await observe();
        const current = one(after.value.observation, node => node.description === 'native_counter_status').text;
        assert.equal(Number(current.split(': ')[1]), Number(count.split(': ')[1]) + 1);
        proof.samples.push({ engine, round, warmup: round < 2, actionMs: action.elapsedMs, beforeMs: before.elapsedMs, afterMs: after.elapsedMs,
          loopMs: action.elapsedMs + before.elapsedMs + after.elapsedMs, before: count, after: current, action: action.value });
      }
    }
    const distribution = values => {
      values.sort((a, b) => a - b);
      return { n: values.length, min: values[0], median: (values[(values.length - 1) >> 1] + values[values.length >> 1]) / 2,
        p95: values[Math.ceil(values.length * .95) - 1], max: values.at(-1) };
    };
    proof.summary = Object.fromEntries(['espresso', 'sdk'].map(engine => {
      const samples = proof.samples.filter(sample => sample.engine === engine && !sample.warmup);
      return [engine, Object.fromEntries(['actionMs', 'beforeMs', 'afterMs', 'loopMs'].map(metric => [metric, distribution(samples.map(sample => sample[metric]))]))];
    }));
    proof.close = await run('android-executor', { ...identity, operation: 'close' }); identity = null; proof.ok = true;
  } finally {
    if (identity) { try { proof.cleanup = await run('android-executor', { ...identity, operation: 'close' }); } catch (error) { proof.cleanup = error.message; } }
    await host.close();
    fs.writeFileSync(path.join(directory, 'android-executor-benchmark.json'), JSON.stringify(proof, null, 2));
  }
  process.stdout.write(JSON.stringify({ ok: proof.ok, summary: proof.summary }) + '\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
