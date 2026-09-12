#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');

async function main({ out, serverPath, serial, packageName, query }) {
  fs.mkdirSync(out); fs.copyFileSync(__filename, path.join(out, 'controller.js'));
  const target = { serial, packageName }, report = { ok: false, target, serverPath };
  const client = createMcpClient({ serverPath, transcriptPath: path.join(out, 'mcp.jsonl'), stderrPath: path.join(out, 'stderr.log'),
    env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts') } });
  let sequence = 0;
  async function run(command, args) {
    const result = payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
    fs.writeFileSync(path.join(out, `${String(++sequence).padStart(3, '0')}-${command}.json`), JSON.stringify(result, null, 2)); return result;
  }
  const check = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
  const nodes = tree => {
    const all = []; function walk(n) { if (!n.visible) return; all.push(n); for (const child of n.children || []) walk(child); }
    walk(tree.windows.at(-1).root); return all;
  };
  const selected = tree => nodes(tree).some(n => n.text === '1' && n.bounds.top >= 120 && n.bounds.bottom <= 330);
  try {
    await client.initialize(); const initial = check(await run('tree', { ...target, compact: false }));
    assert.equal(selected(initial), false); assert.ok(nodes(initial).some(n => n.text === query && n.bounds.top >= 312 && n.bounds.bottom < 1000));
    const boundary = check(await run('events', { ...target, view: 'decision-window', limit: 100 }));
    assert.ok(boundary.watermarkCursor && boundary.runtimeEpoch);
    const source = `module.exports.main = async ctx => ctx.call('native-gesture', {payload: {action: 'longPress', selector: {text: ctx.inputs.query}, durationMs: 8000}});`;
    const script = { schemaVersion: 'aab.code-script/v1', language: 'javascript', source, target: { platform: 'android', ...target }, inputs: { query },
      permissions: ['app.interact'], policy: { timeoutMs: 20000 } };
    fs.writeFileSync(path.join(out, 'script.json'), JSON.stringify(script, null, 2));
    const start = check(await run('script', { operation: 'start', script, recordingDir: path.join(out, 'recording') }));
    report.operationId = start.operationId;
    const deadline = Date.now() + 6000; let actionId;
    for (;;) {
      const status = check(await run('status', { ...target, full: true })); actionId = status.debugBridge.nativeAction?.actionId;
      if (actionId) break;
      assert.ok(Date.now() < deadline, 'SDK did not reserve the gesture'); await delay(50);
    }
    assert.ok(actionId.startsWith(start.operationId + ':')); report.actionId = actionId;
    const eventArgs = { ...target, view: 'decision-window', factCursor: boundary.watermarkCursor, runtimeEpoch: boundary.runtimeEpoch, afterActionId: actionId, limit: 100 };
    for (;;) {
      const events = check(await run('events', eventArgs));
      if (events.items.some(e => e.actionId === actionId && e.name === 'ui.interaction' && e.data.completion === 'started')) break;
      assert.ok(Date.now() < deadline, 'No confirmed DOWN event before cancellation'); await delay(50);
    }
    report.cancelRequestedAtMs = Date.now();
    let state = check(await run('script', { operation: 'cancel', operationId: start.operationId }));
    const stopDeadline = Date.now() + 8000;
    while (!['cancelled', 'failed', 'completed'].includes(state.status)) {
      assert.ok(Date.now() < stopDeadline, 'Script cancellation did not settle');
      state = await run('script', { operation: 'wait', operationId: start.operationId, afterSequence: state.eventSequence, waitMs: 500 });
    }
    state = await run('script', { operation: 'status', operationId: start.operationId });
    report.cancelSettledAtMs = Date.now(); report.status = state.status; assert.equal(state.status, 'cancelled');
    assert.equal(check(await run('status', { ...target, full: true })).debugBridge.nativeAction, null);
    const events = check(await run('events', eventArgs)); assert.equal(events.coverage.status, 'complete'); assert.equal(events.gap, false);
    const terminal = events.items.filter(e => e.actionId === actionId && e.name === 'ui.interaction');
    assert.equal(terminal.some(e => e.data.completion === 'completed'), false);
    const cancelled = terminal.find(e => e.data.completion === 'cancelled'); assert.ok(cancelled);
    assert.equal(cancelled.data.error, 'native_action_cancelled'); assert.equal(cancelled.data.dispatched, true);
    assert.equal(cancelled.data.ambiguous, false); assert.ok(cancelled.data.elapsedMs < 8000);
    report.sdkCancellation = cancelled; report.eventRefs = events.refs;
    report.archive = check(await run('evidence', { operation: 'export', namespace: 'script', operationId: start.operationId,
      outputDir: path.join(out, 'archive'), includeRecordedPayloads: true }));
    const current = check(await run('tree', { ...target, compact: false })); report.selectionHadAlreadyOccurred = selected(current);
    if (selected(current)) check(await run('keyevent', { ...target, keyCode: 4, feedback: 'off' }));
    assert.equal(selected(check(await run('tree', { ...target, compact: false }))), false);
    check(await run('screenshot', { ...target, outFile: path.join(out, 'restored.png'), feedback: 'off' }));
    report.ok = true;
  } catch (error) { report.error = error.stack; throw error; }
  finally { report.mcpExit = await client.close({ stdinEof: true }); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); }
  return report;
}
if (require.main === module) {
  const [out, serverPath, serial, packageName, query] = process.argv.slice(2);
  main({ out: path.resolve(out), serverPath: path.resolve(serverPath), serial, packageName, query })
    .then(report => console.log(JSON.stringify(report))).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { main };
