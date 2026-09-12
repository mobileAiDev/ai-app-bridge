'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

async function startShutdownScripts({ out, run }) {
  const operations = [];
  for (const language of ['javascript', 'python']) {
    const ready = path.join(out, `shutdown-${language}-ready`);
    const adb = path.join(out, `shutdown-${language}-adb`);
    fs.writeFileSync(adb, `#!${process.execPath}
const fs = require('node:fs');
const call = require(${JSON.stringify(require.resolve('../../test-support/android-shell-fixture'))}).handleAndroidShellFixture(process.argv.slice(2), { pending: true });
if (call.handled) process.exit(0);
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(ready + '.tmp')}, String(process.pid));
fs.renameSync(${JSON.stringify(ready + '.tmp')}, ${JSON.stringify(ready)});
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    const started = await run('script', { operation: 'start', script: {
      schemaVersion: 'aab.code-script/v1', language,
      target: { platform: 'android', serial: `shutdown-${language}`, packageName: 'example.shutdown' },
      policy: { timeoutMs: 60000 },
      source: language === 'javascript'
        ? `module.exports.main = ctx => ctx.call('keyevent', { keyCode: 0, adb: ${JSON.stringify(adb)} });`
        : `def main(ctx):\n    return ctx.call('keyevent', {'keyCode': 0, 'adb': ${JSON.stringify(adb)}})\n`,
    } });
    assert.equal(started.ok, true, JSON.stringify(started));
    for (let i = 0; !fs.existsSync(ready) && i < 500; i++) await delay(10);
    assert.ok(fs.existsSync(ready), 'controlled provider must have started before MCP shutdown');
    operations.push({ language, operationId: started.operationId, providerPid: Number(fs.readFileSync(ready)) });
    const waitingReady = path.join(out, `shutdown-${language}-agent-ready`);
    const waiting = await run('script', { operation: 'start', script: {
      schemaVersion: 'aab.code-script/v1', language, policy: { timeoutMs: 60000 },
      source: language === 'javascript'
        ? `module.exports.main = async ctx => {
            process.on('SIGTERM', () => {});
            require('node:fs').writeFileSync(${JSON.stringify(waitingReady)}, String(process.pid));
            return ctx.askAgent({question: 'Controlled shutdown probe'});
          };`
        : `import os, signal\ndef main(ctx):\n    signal.signal(signal.SIGTERM, lambda *args: None)\n    with open(${JSON.stringify(waitingReady)}, 'w') as f: f.write(str(os.getpid()))\n    return ctx.askAgent({'question': 'Controlled shutdown probe'})\n`,
    } });
    assert.equal(waiting.ok, true, JSON.stringify(waiting));
    let state = waiting;
    const readyDeadline = Date.now() + 5000;
    while (state.status === 'running' && Date.now() < readyDeadline) state = await run('script', { operation: 'wait', operationId: waiting.operationId, afterSequence: state.eventSequence, waitMs: 1000 });
    assert.equal(state.status, 'waiting_for_agent', JSON.stringify(state));
    operations.push({ language, waitingForAgent: true, operationId: waiting.operationId, providerPid: Number(fs.readFileSync(waitingReady)) });
  }
  return operations;
}

async function verifyScriptShutdown({ out, run, operations }) {
  const results = [];
  for (const operation of operations) {
    assert.ok(Number.isSafeInteger(operation.providerPid) && operation.providerPid > 0, 'ready must contain the actual child PID');
    assert.throws(() => process.kill(operation.providerPid, 0), { code: 'ESRCH' });
    const exported = await run('evidence', { operation: 'export', namespace: 'script', operationId: operation.operationId,
      outputDir: path.join(out, `shutdown-${operation.language}${operation.waitingForAgent ? '-agent' : ''}-archive`) });
    assert.equal(exported.ok, true, JSON.stringify(exported));
    const records = JSON.parse(fs.readFileSync(path.join(exported.archiveDir, 'records.json')))
      .map(row => row.payload).filter(row => row.namespace === 'script');
    const terminalIndex = records.findLastIndex(row => row.kind === 'checkpoint');
    const receiptIndex = records.findIndex(row => row.kind === 'action-receipt');
    assert.ok(terminalIndex >= 0, 'terminal checkpoint must be persisted');
    const terminal = records[terminalIndex];
    assert.equal(terminal.status, 'cancelled');
    if (operation.waitingForAgent) {
      assert.equal(receiptIndex, -1);
      assert.equal(terminal.error, null);
    } else {
      assert.ok(receiptIndex >= 0 && receiptIndex < terminalIndex, 'receipt must precede terminal checkpoint');
      const receipt = records[receiptIndex];
      assert.equal(terminal.error, 'ambiguous');
      assert.equal(receipt.error, 'cancelled');
      assert.equal(receipt.dispatched, null);
      assert.equal(receipt.ambiguous, true);
    }
    const verified = await run('evidence', { operation: 'verify', archiveDir: exported.archiveDir, manifestSha256: exported.manifestSha256 });
    assert.equal(verified.ok, true, JSON.stringify(verified));
    results.push({ ...operation, providerClosed: true, status: terminal.status, error: terminal.error, receiptBeforeTerminal: !operation.waitingForAgent,
      archiveDir: exported.archiveDir, manifestSha256: exported.manifestSha256, integrity: verified.integrity });
  }
  return results;
}

module.exports = { startShutdownScripts, verifyScriptShutdown };
