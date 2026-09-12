#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');

async function main({ out, serverPath, serial, packageName }) {
  fs.mkdirSync(out); fs.copyFileSync(__filename, path.join(out, 'controller.js'));
  const target = { serial, packageName }, report = { ok: false, target, serverPath, cases: [] };
  const client = createMcpClient({ serverPath, transcriptPath: path.join(out, 'mcp.jsonl'), stderrPath: path.join(out, 'stderr.log'),
    env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts') } });
  const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2));
  let sequence = 0, observerPort;
  async function run(command, args) {
    const result = payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
    write(`${String(++sequence).padStart(3, '0')}-${command}.json`, result); return result;
  }
  const check = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
  async function stable(predicate) {
    const deadline = Date.now() + 8000; let prior;
    for (;;) {
      const tree = check(await run('flutter-nodes', target));
      assert.equal(tree.executionSchema, 'aab.flutter-execution/v1');
      const key = JSON.stringify(tree.nodes);
      if (predicate(tree) && key === prior) return tree;
      assert.ok(Date.now() < deadline, 'Flutter fixture did not settle'); prior = key; await delay(180);
    }
  }
  const has = (tree, text) => tree.nodes.some(n => n.text === text);
  const editor = tree => tree.nodes.filter(n => n.role === 'input' && !n.input.readOnly);
  const tap = selector => run('tap-flutter', { ...target, selector, feedback: 'off' }).then(check);
  async function rawGet(route) {
    const response = await fetch(`http://127.0.0.1:${observerPort}${route}`, { signal: AbortSignal.timeout(2500) });
    assert.equal(response.status, 200); return response.json();
  }
  try {
    await client.initialize();
    const initial = await stable(t => has(t, '通过链接接收'));
    const portState = JSON.parse(execFileSync('adb', ['-s', serial, 'exec-out', 'run-as', packageName, 'cat', 'files/ai_app_bridge_port.json'], { encoding: 'utf8' }));
    assert.equal(portState.packageName, packageName);
    observerPort = execFileSync('adb', ['-s', serial, 'forward', 'tcp:0', `tcp:${portState.port}`], { encoding: 'utf8' }).trim();
    write('observer.json', { portState, observerPort, purpose: 'Independent read-only witness; all actions and cancellation use public MCP.' });
    await tap({ text: '发送' }); await stable(t => has(t, '选择'));
    for (const name of ['intent', 'javascript', 'python']) {
      await tap({ text: '文本' });
      const before = await stable(t => has(t, '输入消息') && editor(t).length === 1 && !editor(t)[0].value);
      const selector = { nodeId: editor(before)[0].id };
      let boundary = check(await run('events', { ...target, view: 'decision-window', limit: 100 }));
      boundary = check(await run('events', { ...target, view: 'decision-window', limit: 100,
        factCursor: boundary.watermarkCursor, runtimeEpoch: boundary.runtimeEpoch }));
      assert.equal(boundary.coverage.status, 'complete');
      const record = { name, beforeEditor: editor(before)[0], attempts: 1 };
      report.cases.push(record);
      let state, actionPending;
      if (name === 'intent') {
        state = check(await run('intent', { operation: 'start', operationId: `flutter-cancel-${Date.now()}`, provider: 'flutter', target: { platform: 'android', ...target },
          goal: 'Cancel the bound message input after its first phone effect. Verify no text write follows cancellation.',
          timeoutMs: 20000, recordingDir: path.join(out, `${name}-recording`), require: { streams: ['events'], view: 'decision-window', limit: 100 } }));
        actionPending = run('intent', { operation: 'decide', operationId: state.operationId, decision: {
          decisionId: 'cancelled-input', basedOnRevision: state.revision, agentDecision: 'act',
          action: { provider: 'flutter', action: 'inputText', selector, value: 'MUST NOT APPEAR' } } });
      } else {
        const source = name === 'javascript'
          ? `module.exports.main = async ctx => ctx.call('input-flutter-text', {selector: ctx.inputs.selector, text: 'MUST NOT APPEAR'});`
          : `def main(ctx):\n    return ctx.call('input-flutter-text', {'selector': ctx.inputs['selector'], 'text': 'MUST NOT APPEAR'})\n`;
        const script = { schemaVersion: 'aab.code-script/v1', language: name, source, target: { platform: 'android', ...target }, inputs: { selector }, permissions: ['app.interact'], policy: { timeoutMs: 20000 } };
        write(`${name}-script.json`, script);
        state = check(await run('script', { operation: 'start', script, recordingDir: path.join(out, `${name}-recording`) }));
      }
      const namespace = name === 'intent' ? 'intent' : 'script', operationId = state.operationId;
      record.operationId = operationId;
      const query = new URLSearchParams({ view: 'decision-window', limit: '100', factCursor: boundary.watermarkCursor, runtimeEpoch: boundary.runtimeEpoch });
      let page, started; const deadline = Date.now() + 8000;
      for (;;) {
        page = await rawGet(`/v1/events?${query}`);
        started = page.items.find(e => e.actionId?.startsWith(operationId + ':') && e.name === 'flutter.action.started');
        if (started) break;
        assert.ok(Date.now() < deadline, 'No confirmed phone execution start'); await delay(3);
      }
      write(`${name}-started.json`, page); assert.equal(page.coverage.status, 'complete'); assert.equal(page.gap, false);
      record.actionId = started.actionId; record.cancelRequestedAtMs = Date.now();
      state = await run(namespace, { operation: 'cancel', operationId });
      assert.equal(state.operationId, operationId);
      if (actionPending) await actionPending;
      const stopDeadline = Date.now() + 8000;
      while (!['cancelled', 'failed', 'completed'].includes(state.status)) {
        assert.ok(Date.now() < stopDeadline, 'Cancellation did not settle'); await delay(30);
        state = await run(namespace, { operation: 'status', operationId });
        assert.equal(state.operationId, operationId);
      }
      record.cancelSettledAtMs = Date.now(); record.status = state.status;
      assert.equal(state.status, 'cancelled', JSON.stringify(state));
      await delay(1500);
      page = check(await run('events', { ...target, view: 'decision-window', limit: 100,
        factCursor: boundary.watermarkCursor, runtimeEpoch: boundary.runtimeEpoch, afterActionId: started.actionId }));
      assert.equal(page.coverage.status, 'complete'); assert.equal(page.gap, false);
      const own = page.items.filter(e => e.actionId === started.actionId);
      record.phoneEvents = own; record.eventRefs = page.refs;
      const pointerCancelled = own.some(e => e.name === 'flutter.pointer.cancel');
      const pointerEnded = own.some(e => e.name === 'pointer.tap');
      assert.ok(pointerCancelled || pointerEnded, 'The admitted pointer sequence has no terminal event');
      record.stopPhase = pointerCancelled ? 'pointer-cancelled' : 'tap-ended-before-text-write';
      assert.ok(own.some(e => e.name === 'flutter.action.settled' && e.data.stopReason === 'flutter_action_cancelled'));
      assert.equal(own.some(e => e.name === 'input.changed'), false, 'The cancelled action wrote text');
      const after = await stable(t => t.updatedAtMs >= record.cancelSettledAtMs && editor(t).length === 1 && !editor(t)[0].value);
      assert.equal(editor(after)[0].id, selector.nodeId);
      record.afterEditor = editor(after)[0];
      const status = await rawGet('/v1/status'); write(`${name}-settled-status.json`, status);
      assert.equal(status.debugBridge.flutterAction, null);
      check(await run('screenshot', { ...target, outFile: path.join(out, `${name}-cancelled.png`), feedback: 'off' }));
      record.archive = check(await run('evidence', { operation: 'export', namespace, operationId,
        outputDir: path.join(out, `${name}-archive`), includeRecordedPayloads: true }));
      record.passed = true;
      await tap({ text: '取消' }); await stable(t => has(t, '选择') && !has(t, '输入消息'));
    }
    const current = await stable(t => has(t, '选择'));
    const receive = current.nodes.filter(n => n.text === '接收' && n.widgetType === 'NavigationDestination');
    assert.equal(receive.length, 1); await tap({ nodeId: receive[0].id });
    await stable(t => has(t, '通过链接接收'));
    check(await run('screenshot', { ...target, outFile: path.join(out, 'restored.png'), feedback: 'off' }));
    report.flutterRuntimeEpoch = initial.runtimeEpoch; report.ok = true;
  } catch (error) { report.error = error.stack; throw error; }
  finally {
    report.mcpExit = await client.close({ stdinEof: true });
    if (observerPort) execFileSync('adb', ['-s', serial, 'forward', '--remove', `tcp:${observerPort}`]);
    write('report.json', report);
  }
  return report;
}

if (require.main === module) {
  const [out, serverPath, serial, packageName] = process.argv.slice(2);
  main({ out: path.resolve(out), serverPath: path.resolve(serverPath), serial, packageName })
    .then(report => console.log(JSON.stringify({ ok: report.ok, cases: report.cases.map(({ name, status, passed }) => ({ name, status, passed })) })))
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { main };
