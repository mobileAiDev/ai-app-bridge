'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { createUiaRuntimeFixture } = require('../../test-support/uia-runtime-fixture');

// Keep actual start/decide RPCs in flight when the caller closes MCP. These
// The initial UIA descriptor read and the keyevent provider ignore SIGTERM, so
// acceptance also proves child reaping. HTTP observation cancellation has its
// own runtime transport test; there is no one-shot uiautomator dump anymore.
async function startShutdownIntents({ out, run }) {
  const operations = [];
  for (const kind of ['observation', 'action']) {
    const ready = path.join(out, `intent-shutdown-${kind}-ready`);
    const adb = path.join(out, `intent-shutdown-${kind}-adb`);
    const operationId = `intent-shutdown-${kind}`;
    const runtime = await createUiaRuntimeFixture({ directory: path.join(out, `${operationId}-uia`), serial: operationId,
      foregroundPackage: 'example.shutdown', xml: '<hierarchy><node package="example.shutdown" text="Ready" class="Button" enabled="true" bounds="[0,0][100,100]"/></hierarchy>' });
    try {
    fs.writeFileSync(adb, `#!${process.execPath}
const fs = require('node:fs');
if (!require(${JSON.stringify(require.resolve('../../test-support/uia-runtime-fixture'))}).handleUiaRuntimeFixture(process.argv.slice(2),
  ${JSON.stringify({ directory: runtime.directory, ...(kind === 'observation' ? { descriptorReady: ready } : {}) })})) {
const call = require(${JSON.stringify(require.resolve('../../test-support/android-shell-fixture'))}).handleAndroidShellFixture(process.argv.slice(2), { pending: true });
if (call.handled) process.exit(0);
const args = call.args;
fs.appendFileSync(${JSON.stringify(path.join(out, `intent-shutdown-${kind}-adb.jsonl`))}, JSON.stringify(args) + '\\n');
if (args.includes('input')) {
  process.on('SIGTERM', () => {});
  fs.writeFileSync(${JSON.stringify(ready + '.tmp')}, String(process.pid));
  fs.renameSync(${JSON.stringify(ready + '.tmp')}, ${JSON.stringify(ready)});
  setInterval(() => {}, 1000);
} else if (args.includes('dumpsys') && args.includes('window')) {
  process.stdout.write('mCurrentFocus=Window{test u0 example.shutdown/example.shutdown.MainActivity}');
}
}
`, { mode: 0o755 });
    const starting = run('intent', { operation: 'start', operationId, goal: 'Controlled shutdown lifecycle probe',
      provider: 'uia', timeoutMs: 60000, target: { platform: 'android', serial: operationId, packageName: 'example.shutdown', adb } });
    let pending = starting;
    if (kind === 'action') {
      const state = await starting;
      assert.equal(state.status, 'waiting_for_decision', JSON.stringify(state));
      pending = run('intent', { operation: 'decide', operationId, decision: {
        decisionId: 'controlled-keyevent', basedOnRevision: state.revision, agentDecision: 'act', action: { action: 'keyevent', keyCode: 0 },
      } });
    }
    // Pending RPC failures must be handled even if shutdown closes the transport.
    const settled = pending.then(value => ({ value }), error => ({ error: error.message }));
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await delay(10);
    assert.ok(fs.existsSync(ready), `${kind} provider must be running before shutdown`);
    operations.push({ kind, operationId, providerPid: Number(fs.readFileSync(ready)), settled });
    } finally { await runtime.close(); }
  }
  return operations;
}

async function verifyIntentShutdown({ out, run, operations }) {
  const results = [];
  for (const { settled, ...operation } of operations) {
    assert.ok(Number.isSafeInteger(operation.providerPid) && operation.providerPid > 0, 'ready must contain the actual child PID');
    await settled;
    assert.throws(() => process.kill(operation.providerPid, 0), { code: 'ESRCH' });
    const state = await run('intent', { operation: 'status', operationId: operation.operationId });
    assert.equal(state.status, 'cancelled', JSON.stringify(state));
    assert.equal(state.live, false); assert.equal(state.recovered, true); assert.equal(state.restartPolicy, 'none');
    assert.ok(state.terminalEvidenceId); assert.ok(state.history.items.length);
    const exported = await run('evidence', { operation: 'export', namespace: 'intent', operationId: operation.operationId,
      outputDir: path.join(out, `intent-shutdown-${operation.kind}-archive`) });
    assert.equal(exported.ok, true, JSON.stringify(exported));
    const records = JSON.parse(fs.readFileSync(path.join(exported.archiveDir, 'records.json')))
      .map(row => row.payload).filter(row => row.namespace === 'intent');
    const terminalIndex = records.findIndex(row => row.stepId === 'intent-terminal');
    const receiptIndex = records.findIndex(row => row.kind === 'action-receipt');
    assert.ok(terminalIndex >= 0, 'terminal checkpoint must be persisted');
    assert.equal(records[terminalIndex].evidenceId, state.terminalEvidenceId);
    assert.equal(records[terminalIndex].payloadSummary.status, 'cancelled');
    if (operation.kind === 'action') {
      assert.ok(receiptIndex >= 0 && receiptIndex < terminalIndex, 'receipt must precede terminal checkpoint');
      assert.equal(records[receiptIndex].error, 'cancelled');
      assert.equal(records[receiptIndex].dispatched, true); assert.equal(records[receiptIndex].ambiguous, true);
      assert.equal(state.lastAction.receiptId, records[receiptIndex].evidenceId); assert.equal(state.lastAction.ambiguous, true);
    } else {
      assert.equal(receiptIndex, -1); assert.equal(state.lastAction, null);
      assert.equal(records.some(row => row.kind === 'observation'), false, 'cancelled initial read cannot publish an observation');
    }
    const duplicate = await run('intent', { operation: 'start', operationId: operation.operationId, goal: 'Must not replay',
      target: { platform: 'android', serial: operation.operationId, packageName: 'example.shutdown' } });
    assert.equal(duplicate.error, 'operation_exists');
    const verified = await run('evidence', { operation: 'verify', archiveDir: exported.archiveDir, manifestSha256: exported.manifestSha256 });
    assert.equal(verified.ok, true, JSON.stringify(verified));
    results.push({ ...operation, providerClosed: true, status: state.status, recovered: state.recovered,
      terminalEvidenceId: state.terminalEvidenceId, lastAction: state.lastAction,
      archiveDir: exported.archiveDir, manifestSha256: exported.manifestSha256, integrity: verified.integrity });
  }
  return results;
}

module.exports = { startShutdownIntents, verifyIntentShutdown };
