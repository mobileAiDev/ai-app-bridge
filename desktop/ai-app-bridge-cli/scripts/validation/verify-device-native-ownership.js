#!/usr/bin/env node
'use strict';

// Real NotallyX Native SDK, with an explicit Host HTTP fault proxy.
// The ADB adapter changes only forward discovery for that proxy; all other
// device reads delegate to real ADB. No App fault hook or business edit is used.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');

async function main({ out, serverPath, serial, packageName, searchDescription }) {
  fs.mkdirSync(out); fs.copyFileSync(__filename, path.join(out, 'controller.js'));
  const write = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + '\n');
  const target = { serial, packageName }, ownershipDirectory = path.join(out, 'ownership');
  const report = { ok: false, target, serverPath, scope: 'Real Native Android SDK and UI, controlled Host HTTP response loss and SIGKILL; business SQL is checked independently outside this controller', blocked: [] };
  const adb = (args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000 });
  const businessHash = () => createHash('sha256').update(adb(['exec-out', 'run-as', packageName, 'cat', `shared_prefs/${packageName}_preferences.xml`])).digest('hex');
  let observerPort, proxy, allowCancel = false, owner, reader, recovery;
  const clients = [];
  const client = name => {
    const c = createMcpClient({ serverPath, transcriptPath: path.join(out, `${name}-mcp.jsonl`), stderrPath: path.join(out, `${name}-stderr.log`),
      env: { AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR: ownershipDirectory, AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, `${name}-facts`) } });
    clients.push(c); return c;
  };
  let sequence = 0;
  const run = async (c, command, args) => {
    const result = payloadOf(await c.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
    write(`${String(++sequence).padStart(3, '0')}-${command}.json`, result); return result;
  };
  const check = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
  async function tree(c, predicate) {
    const deadline = Date.now() + 8000;
    for (;;) {
      const value = check(await run(c, 'tree', { ...target, compact: false }));
      if (predicate(value)) return value;
      assert(Date.now() < deadline, 'Expected NotallyX page is absent'); await delay(150);
    }
  }
  const nativeNodes = value => {
    const nodes = []; const walk = n => { if (!n.visible) return; nodes.push(n); for (const child of n.children || []) walk(child); };
    walk(value.windows.at(-1).root); return nodes;
  };
  const editorVisible = value => nativeNodes(value).some(n => n.resourceName === `${packageName}:id/EnterSearchKeyword`);
  const listVisible = value => !editorVisible(value) && nativeNodes(value).some(n => n.contentDescription === searchDescription);
  async function restore(c) {
    for (let i = 0; i < 3; i++) {
      const current = check(await run(c, 'tree', { ...target, compact: false }));
      if (listVisible(current)) return;
      assert(editorVisible(current), 'Unexpected page during restoration');
      check(await run(c, 'keyevent', { ...target, keyCode: 4, feedback: 'off' })); await delay(200);
    }
    await tree(c, listVisible);
  }
  async function blocked(c, command, args, expected, label) {
    const result = await run(c, command, args);
    assert.equal(result.error, expected, JSON.stringify(result));
    assert.equal(result.dispatched, false);
    report.blocked.push({ label, error: result.error, dispatched: result.dispatched });
  }
  try {
    report.preferencesBefore = businessHash();
    const portState = JSON.parse(adb(['exec-out', 'run-as', packageName, 'cat', 'files/ai_app_bridge_port.json']));
    assert.equal(portState.packageName, packageName);
    observerPort = adb(['forward', 'tcp:0', `tcp:${portState.port}`]).trim();
    let accepted;
    const effectReceived = new Promise(resolve => { accepted = resolve; });
    let wireSequence = 0;
    proxy = http.createServer(async (req, res) => {
      try {
        let body = ''; for await (const part of req) body += part;
        const response = await fetch(`http://127.0.0.1:${observerPort}${req.url}`, { method: req.method,
          ...(body ? { body, headers: { 'content-type': 'application/json' } } : {}), signal: AbortSignal.timeout(30000) });
        const text = await response.text();
        const item = { path: req.url, request: body ? JSON.parse(body) : null, status: response.status, response: JSON.parse(text) };
        write(`wire-${String(++wireSequence).padStart(3, '0')}.json`, item);
        if (req.url === '/v1/action/tap') { accepted(item); return; }
        if (req.url === '/v1/action/cancel' && !allowCancel) { res.destroy(); return; }
        res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(text);
      } catch (error) { res.destroy(error); }
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyPort = proxy.address().port;
    const faultAdb = path.join(out, 'fault-adb');
    const mapping = `${serial} tcp:${proxyPort} tcp:${portState.port}\n`;
    fs.writeFileSync(faultAdb, `#!${process.execPath}\nconst args=process.argv.slice(2);\nrequire('node:fs').appendFileSync(${JSON.stringify(path.join(out, 'fault-adb.jsonl'))}, JSON.stringify(args)+'\\n');\nif(args.includes('forward')&&args.includes('tcp:0')) process.stdout.write(${JSON.stringify(String(proxyPort)+'\n')});\nelse if(args.includes('forward')&&args.includes('--list')) process.stdout.write(${JSON.stringify(mapping)});\nelse {const r=require('node:child_process').spawnSync('adb',args,{stdio:'inherit'});process.exitCode=r.status??1;}\n`, { mode: 0o755 });
    write('transport.json', { portState, observerPort, proxyPort, faultAdb, ownershipDirectory });
    owner = client('owner'); reader = client('reader'); await owner.initialize(); await reader.initialize();
    const initial = await tree(reader, listVisible);
    const search = nativeNodes(initial).filter(n => n.contentDescription === searchDescription); assert.equal(search.length, 1);
    const point = { tapX: Math.round((search[0].bounds.left + search[0].bounds.right) / 2), tapY: Math.round((search[0].bounds.top + search[0].bounds.bottom) / 2) };
    const boundary = check(await run(reader, 'events', { ...target, view: 'decision-window', limit: 100 }));
    const actionId = `ownership-${Date.now()}`;
    const pending = run(owner, 'tap', { ...target, adb: faultAdb, ...point, requestId: actionId,
      timeoutMs: 30000, feedback: 'off' }).then(value => ({ value }), error => ({ error: error.message }));
    const effect = await Promise.race([effectReceived,
      pending.then(result => { throw new Error(`Original call ended before response loss: ${result.value?.error || result.error}`); }),
      delay(12000).then(() => { throw new Error('No actual SDK completion reached the fault proxy'); })]);
    assert.equal(effect.response.ok, true); assert.equal(effect.response.actionId, actionId); assert.equal(effect.response.settled, true);
    report.action = { actionId, runtimeEpoch: effect.response.runtimeEpoch, observedTarget: search[0], point, actualSdkReceipt: effect.response, hostResponseDelivered: false };
    await blocked(reader, 'keyevent', { serial, packageName: 'example.other.package', keyCode: 0, feedback: 'off' }, 'target_busy', 'another package and Host while original Host is alive');
    process.kill(owner.pid, 'SIGKILL');
    report.killedOwner = await owner.close(); report.originalCall = await pending;
    assert.deepEqual(report.killedOwner, { code: null, signal: 'SIGKILL' });
    await blocked(reader, 'keyevent', { serial, keyCode: 0, feedback: 'off' }, 'device_ownership_unresolved', 'same reader after owner SIGKILL');
    report.readerExit = await reader.close({ stdinEof: true });
    recovery = client('recovery'); await recovery.initialize();
    const status = check(await run(recovery, 'device-ownership', { operation: 'status', serial }));
    assert.equal(status.phase, 'unresolved'); assert.equal(status.ownership.pending.actionId, actionId);
    const cli = spawnSync(process.execPath, [path.join(path.dirname(serverPath), 'ai-app-bridge.js'), 'keyevent', '--serial', serial, '--key-code', '0', '--feedback', 'off'],
      { encoding: 'utf8', env: { ...process.env, AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR: ownershipDirectory }, timeout: 5000 });
    write('blocked-cli.json', { status: cli.status, result: JSON.parse(cli.stdout), stderr: cli.stderr });
    assert.equal(JSON.parse(cli.stdout).error, 'device_ownership_unresolved'); assert.equal(cli.status, 1);
    const intent = check(await run(recovery, 'intent', { operation: 'start', provider: 'native', goal: 'Ownership denial probe; must not dispatch.', target: { platform: 'android', ...target } }));
    const decided = await run(recovery, 'intent', { operation: 'decide', operationId: intent.operationId, decision: {
      decisionId: 'blocked', basedOnRevision: intent.revision, agentDecision: 'act', action: { provider: 'native', action: 'tap', selector: { contentDescription: searchDescription } } } });
    assert.equal(decided.error, 'device_ownership_unresolved');
    report.blocked.push({ label: 'Intent after Host restart', error: decided.error, operationId: intent.operationId });
    for (const language of ['javascript', 'python']) {
      const source = language === 'javascript'
        ? `module.exports.main=async ctx=>{const r=await ctx.call('keyevent',{keyCode:0});if(r.error!=='device_ownership_unresolved'||r.dispatched!==false)throw Error(JSON.stringify(r));return r.error;};`
        : `def main(ctx):\n    r=ctx.call('keyevent',{'keyCode':0})\n    if r['error']!='device_ownership_unresolved' or r['dispatched'] is not False: raise Exception(str(r))\n    return r['error']\n`;
      const script = check(await run(recovery, 'script', { operation: 'start', script: { schemaVersion: 'aab.code-script/v1', language, source, target: { platform: 'android', ...target } } }));
      let state = script; const deadline = Date.now() + 10000;
      while (!['completed', 'failed', 'cancelled'].includes(state.status)) {
        assert(Date.now() < deadline, 'Blocked Script did not finish');
        state = await run(recovery, 'script', { operation: 'wait', operationId: script.operationId, afterSequence: state.eventSequence, waitMs: 1000 });
      }
      assert.equal(state.status, 'completed');
      const resultEnvelope = await run(recovery, 'script', { operation: 'result', operationId: script.operationId });
      assert.equal(resultEnvelope.ok, true, JSON.stringify(resultEnvelope)); assert.equal(resultEnvelope.persisted, true);
      assert.equal(resultEnvelope.result, 'device_ownership_unresolved');
      report.blocked.push({ label: language, error: 'device_ownership_unresolved', operationId: script.operationId });
    }
    const unknown = await run(recovery, 'device-ownership', { operation: 'reconcile', serial });
    assert.equal(unknown.error, 'device_ownership_unresolved');
    await blocked(recovery, 'keyevent', { serial, keyCode: 0, feedback: 'off' }, 'device_ownership_unresolved', 'failed reconciliation cannot release device');
    const observed = check(await run(recovery, 'events', { ...target, view: 'decision-window', limit: 100,
      factCursor: boundary.watermarkCursor, runtimeEpoch: boundary.runtimeEpoch, afterActionId: actionId }));
    assert.equal(observed.coverage.status, 'complete'); assert.equal(observed.gap, false);
    assert(observed.items.some(e => e.actionId === actionId && e.name === 'native.action.settled'));
    report.phoneEvidence = { events: observed.items.filter(e => e.actionId === actionId), refs: observed.refs };
    await tree(recovery, editorVisible);
    check(await run(recovery, 'screenshot', { ...target, outFile: path.join(out, 'search-after-owner-crash.png'), feedback: 'off' }));
    allowCancel = true;
    const reconciled = check(await run(recovery, 'device-ownership', { operation: 'reconcile', serial }));
    assert.equal(reconciled.recovered, true); assert.equal(reconciled.settlement.proof.actionId, actionId);
    report.reconciliation = reconciled;
    assert.equal(reconciled.executionReceipt.actionId, actionId);
    assert.equal(reconciled.executionReceipt.execution.schemaVersion, 'aab.native-execution/v1');
    await restore(recovery);
    check(await run(recovery, 'screenshot', { ...target, outFile: path.join(out, 'restored.png'), feedback: 'off' }));
    assert.equal(check(await run(recovery, 'device-ownership', { operation: 'status', serial })).active, 0);
    report.preferencesAfter = businessHash(); assert.equal(report.preferencesAfter, report.preferencesBefore);
    const wires = fs.readdirSync(out).filter(n => /^wire-.*\.json$/.test(n)).map(n => JSON.parse(fs.readFileSync(path.join(out, n))));
    report.nativeDispatchCount = wires.filter(w => w.path === '/v1/action/tap').length;
    assert.equal(report.nativeDispatchCount, 1, 'Original Native tap must not be replayed');
    report.ok = true;
  } catch (error) { report.error = error.stack; throw error; }
  finally {
    allowCancel = true;
    if (!report.ok && recovery) {
      try {
        report.cleanupRecovery = await run(recovery, 'device-ownership', { operation: 'reconcile', serial });
        if (report.cleanupRecovery.ok) {
          await restore(recovery); report.cleanupRestored = true;
        }
      } catch (error) { report.cleanupError = error.message; }
    }
    report.exits = await Promise.all(clients.map(c => c.close({ stdinEof: true })));
    proxy?.closeAllConnections(); if (proxy) await new Promise(resolve => proxy.close(resolve));
    if (observerPort) adb(['forward', '--remove', `tcp:${observerPort}`]);
    write('report.json', report);
  }
  return report;
}

if (require.main === module) {
  const [out, serverPath, serial, packageName, searchDescription] = process.argv.slice(2);
  main({ out: path.resolve(out), serverPath: path.resolve(serverPath), serial, packageName, searchDescription })
    .then(r => console.log(JSON.stringify({ ok: r.ok, blocked: r.blocked, reconciled: r.reconciliation.recovered })))
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { main };
