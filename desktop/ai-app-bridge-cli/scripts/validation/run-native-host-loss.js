#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const [serial, output] = process.argv.slice(2);
if (!output || !process.env.AI_APP_BRIDGE_FACT_STORE_DIR) throw new Error('usage: AI_APP_BRIDGE_FACT_STORE_DIR=ISOLATED_FACTS run-native-host-loss.js SERIAL NEW_EVIDENCE_DIR');
const outDir = path.resolve(output), cli = path.resolve(__dirname, '../../bin/ai-app-bridge.js');
const target = { serial, packageName: 'io.github.mobileaidev.aiappbridge.sample' };
fs.mkdirSync(outDir);
let rpcCount = 0, responseBytes = 0;
async function call(command, args) {
  const flags = Object.entries({ ...args, extract: null }).flatMap(([key, value]) => [`--${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}`,
    typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  let stdout;
  try { ({ stdout } = await execFile(process.execPath, [cli, command, ...flags], { maxBuffer: 8 * 1024 * 1024 })); }
  catch (error) { if (!error.stdout) throw error; stdout = error.stdout; }
  rpcCount++; responseBytes += Buffer.byteLength(stdout);
  const reply = JSON.parse(stdout);
  fs.appendFileSync(path.join(outDir, 'replies.jsonl'), JSON.stringify({ atMs: Date.now(), command, args, reply }) + '\n');
  return reply;
}
async function main() {
  const began = Date.now();
  const originalRuntime = (await call('runtime', { operation: 'status' })).value;
  assert.equal(originalRuntime.status, 'running'); assert.equal(originalRuntime.compatible, true);
  assert.equal(path.resolve(originalRuntime.facts), path.resolve(process.env.AI_APP_BRIDGE_FACT_STORE_DIR));
  const processInfo = (await execFile('ps', ['-p', String(originalRuntime.pid), '-o', 'command='])).stdout.trim();
  assert(processInfo.includes(path.resolve(__dirname, '../../bin/execution-runtime.js')));
  assert.equal((await call('device-ownership', { operation: 'status', serial })).value.active, 0);
  fs.writeFileSync(path.join(outDir, 'runtime-before.json'), JSON.stringify({ ...originalRuntime, processInfo }, null, 2));
  const sourcePath = path.join(outDir, 'native-host-loss.js'); fs.copyFileSync(path.join(__dirname, 'native-host-loss.js'), sourcePath);
  fs.copyFileSync(__filename, path.join(outDir, 'runner.js'));
  const initialStatus = await call('status', target);
  assert(initialStatus.execution.ok, JSON.stringify(initialStatus.execution));
  const deviceSinceMs = initialStatus.value.updatedAtMs;
  assert(Number.isFinite(deviceSinceMs), 'Device capture time unavailable');
  const spec = { schemaVersion: 'aab.code-script/v1', language: 'javascript', sourcePath,
    target: { platform: 'android', ...target }, inputs: { outDir, deviceSinceMs }, policy: { restartPolicy: 'checkpoint', timeoutMs: 60000 } };
  fs.writeFileSync(path.join(outDir, 'scenario.json'), JSON.stringify(spec, null, 2));
  const start = await call('script', { operation: 'start', script: spec });
  assert(start.execution.ok); const operationId = start.control.operationId;
  fs.writeFileSync(path.join(outDir, 'original-operation.json'), JSON.stringify({ operationId, began }, null, 2));
  const deadline = Date.now() + 30000;
  let active;
  do {
    const status = await call('status', { ...target, full: true });
    assert(status.execution.ok, JSON.stringify(status.execution));
    const current = status.value.debugBridge.nativeAction;
    if (current?.kind === 'gesture' && current.actionId.startsWith(operationId + ':')) { active = current; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert(active && active.settled === false, 'The SDK never exposed the original admitted gesture');
  const owned = (await call('device-ownership', { operation: 'status', serial })).value;
  assert.equal(owned.ownership.owner.pid, originalRuntime.pid);
  assert.equal(owned.ownership.pending.actionId, active.actionId);
  fs.writeFileSync(path.join(outDir, 'admitted-before-kill.json'), JSON.stringify({ observedAtMs: Date.now(), active, owned }, null, 2));
  process.kill(originalRuntime.pid, 'SIGKILL');
  const killedAtMs = Date.now();
  let alive = true;
  for (let i = 0; i < 200 && alive; i++) {
    try { process.kill(originalRuntime.pid, 0); await new Promise(resolve => setTimeout(resolve, 10)); }
    catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
  }
  assert.equal(alive, false, 'Old Host is still present');
  const lost = await call('script', { operation: 'status', operationId, limit: 20 });
  assert.equal(lost.execution.ok, true);
  assert.equal(lost.control.status, 'failed');
  assert.equal(lost.value.recovery.error, 'ambiguous');
  assert(lost.value.recovery.actions.some(action => action.actionId === active.actionId && action.ambiguous === true));
  const replacement = (await call('runtime', { operation: 'status' })).value;
  assert.notEqual(replacement.runtimeId, originalRuntime.runtimeId); assert.equal(replacement.compatible, true);
  const pending = (await call('device-ownership', { operation: 'status', serial })).value;
  assert.equal(pending.unresolved, true); assert.equal(pending.ownership.pending.actionId, active.actionId);
  const afterLossStatus = await call('status', { ...target, full: true });
  assert(afterLossStatus.execution.ok, JSON.stringify(afterLossStatus.execution));
  assert.equal(afterLossStatus.value.debugBridge.nativeAction?.actionId, active.actionId,
    'The original action must still be active after Host loss to establish the fault timing');
  assert.equal(afterLossStatus.value.debugBridge.nativeAction?.settled, false);
  const deviceAfterLossMs = afterLossStatus.value.updatedAtMs;
  assert(Number.isFinite(deviceAfterLossMs), 'Device capture time unavailable');
  fs.writeFileSync(path.join(outDir, 'active-after-host-loss.json'), JSON.stringify(afterLossStatus.value, null, 2));
  const waited = await call('wait-text', { ...target, provider: 'native', targetText: 'Native counter: 1', timeoutMs: 12000, intervalMs: 50 });
  assert(waited.execution.ok, JSON.stringify(waited.execution));
  const finished = (await call('status', { ...target, full: true })).value;
  assert.equal(finished.debugBridge.nativeAction, null);
  // Reconcile is potentially cancelling while active. Here the preceding SDK
  // status and exact UI effect establish completion before querying its receipt.
  const reconciled = await call('device-ownership', { operation: 'reconcile', serial });
  assert(reconciled.execution.ok, JSON.stringify(reconciled.execution));
  const settled = (await call('device-ownership', { operation: 'status', serial })).value;
  assert.equal(settled.unresolved, false);
  const proof = settled.ownership.lastSettlement.proof;
  assert.equal(proof.actionId, active.actionId); assert.equal(proof.runtimeEpoch, active.runtimeEpoch);
  assert.equal(proof.dispatched, true); assert.equal(proof.ambiguous, false); assert.equal(proof.error, null);
  const continuationAtMs = Date.now();
  const resumed = await call('script', { operation: 'resume', operationId, waitMs: 60000,
    recovery: { checkpoint: { name: 'original-gesture-queried', state: { phase: 'verified-original-gesture' } },
      reason: 'The original phone gesture completed after Host death. Its receipt and counter=1 are verified; perform one new increment.' } });
  assert(resumed.execution.ok, JSON.stringify(resumed.execution)); assert.equal(resumed.control.status, 'completed');
  assert.equal(resumed.value.result.finalCounter, 2);
  const recorded = JSON.parse(fs.readFileSync(path.join(outDir, 'state-records.json'))).items
    .filter(item => item.namespace === 'native_test' && item.value.action === 'increment');
  assert.deepEqual(recorded.map(item => item.value.counter), [1, 2]);
  assert(recorded[0].timestampMs >= deviceAfterLossMs, 'Original effect must finish after the same-device observation following Host death');
  assert.equal(fs.existsSync(path.join(outDir, 'unexpected-original-return.json')), false);
  const report = { ok: true, operationId, originalAction: active, proof,
    hostBefore: { pid: originalRuntime.pid, runtimeId: originalRuntime.runtimeId },
    hostAfter: { pid: replacement.pid, runtimeId: replacement.runtimeId },
    killedAtMs, deviceAfterLossMs, deviceSinceMs, continuationMs: Date.now() - continuationAtMs, totalMs: Date.now() - began,
    rpcCount, responseBytes, injectedGestureMs: 8000, originalCounter: 1, finalCounter: 2,
    originalEffectAtMs: recorded[0].timestampMs, stateCounters: recorded.map(item => item.value.counter), result: resumed.value.result };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
main().catch(error => { fs.writeFileSync(path.join(outDir, 'failure.txt'), error.stack); console.error(error.stack); process.exitCode = 1; });
