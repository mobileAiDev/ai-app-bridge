#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');

async function main(serial, apkPath, destination) {
  assert.match(serial, /^emulator-\d+$/, 'Provision an explicit disposable emulator first.');
  const out = path.resolve(destination); fs.mkdirSync(out);
  const adb = '/Users/macbook/Library/Android/sdk/platform-tools/adb';
  const packageName = 'io.github.mobileaidev.aiappbridge.sample';
  const root = path.resolve(__dirname, '../..');
  const client = createMcpClient({ serverPath: path.join(root, 'bin/mcp-server.js'), env: {
    ADB: adb, AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_RUNTIME_HOME: path.join(out, 'runtimes'),
    AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR: path.join(out, 'ownership'),
  }, transcriptPath: path.join(out, 'mcp.jsonl'), stderrPath: path.join(out, 'mcp.stderr') });
  const write = (name, value) => fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
  const run = async (command, args) => payloadOf(await client.request('tools/call', { name: 'run', arguments: {
    command, arguments: args, extract: null, output: { maxBytes: 262144 },
  } }));
  const waitScript = async started => {
    let state = started;
    const deadline = Date.now() + 120000;
    while (!['completed', 'failed', 'cancelled'].includes(state.status) && Date.now() < deadline) {
      state = await run('script', { operation: 'wait', operationId: started.operationId,
        afterSequence: state.eventSequence ?? 0, waitMs: 1000, limit: 20 });
    }
    write(`${started.operationId}-terminal`, state);
    assert.equal(state.status, 'completed', JSON.stringify(state));
    return run('script', { operation: 'result', operationId: started.operationId });
  };
  const report = { ok: false, serial, physicalDevicesTouched: false, checks: {}, efficiency: {} };
  try {
    await client.initialize();
    // Exercise managed installation from Script, not only raw adb install.
    const setup = await run('script', { operation: 'start', script: {
      schemaVersion: 'aab.code-script/v1', language: 'javascript', target: { platform: 'android', serial, adb },
      inputs: { apkPath: path.resolve(apkPath), packageName }, policy: { timeoutMs: 120000 },
      source: `module.exports.main = async ctx => {
        const installed = await ctx.call('install-apk', { apkPath: ctx.inputs.apkPath });
        if (!installed.result?.operationId) throw new Error(JSON.stringify(installed));
        let status = installed.result;
        while (!['completed','failed','cancelled','ambiguous','timeout','blocked_evidence_store'].includes(status.status)) {
          status = (await ctx.call('intent', { operation: 'wait', operationId: status.operationId,
            afterEventSequence: status.eventSequence, waitMs: 1000, limit: 5 })).result;
        }
        if (status.installation?.verified !== true) throw new Error(JSON.stringify(status));
        const launched = await ctx.call('adb-exec', { argv: ['shell','am','start','-n',ctx.inputs.packageName+'/.AgentChoiceFixtureActivity'] });
        if (!launched.ok) throw new Error(JSON.stringify(launched));
        const ready = await ctx.call('wait-text', { packageName: ctx.inputs.packageName, provider: 'uia', targetText: '个人账户', timeoutMs: 30000 });
        if (!ready.ok) throw new Error(JSON.stringify(ready));
        const intent = await ctx.call('intent', { operation: 'start', provider: 'native', goal: 'Compose commands on the test fixture',
          target: { ...ctx.target, packageName: ctx.inputs.packageName } });
        return { installation: status.installation, intent: intent.result };
      };`,
    } });
    assert.equal(setup.ok, true, JSON.stringify(setup));
    const prepared = await waitScript(setup); write('prepared', prepared);
    assert.equal(prepared.result.installation.verified, true);
    report.checks.scriptManagedInstall = true;
    report.checks.scriptToIntent = prepared.result.intent.background === true;
    let state = prepared.result.intent;
    const deadline = Date.now() + 30000;
    while (state.status === 'observing' && Date.now() < deadline) {
      state = await run('intent', { operation: 'wait', operationId: state.operationId, afterEventSequence: state.eventSequence, waitMs: 1000, limit: 5 });
    }
    assert.equal(state.status, 'waiting_for_decision', JSON.stringify(state));
    const command = async (name, args, extra = {}) => {
      state = await run('intent', { operation: 'decide', operationId: state.operationId, decision: {
        decisionId: randomUUID(), basedOnRevision: state.revision, agentDecision: 'act',
        action: { action: 'command', command: name, arguments: args, ...extra },
      } });
      return state;
    };
    const before = state.revision;
    const samples = [];
    for (const observeAfter of [false, true, false, true, false, true]) {
      const revision = state.revision;
      const started = performance.now();
      const value = await command('adb-exec', { argv: ['shell', 'getprop', 'sys.boot_completed'], readOnly: true }, { observeAfter });
      samples.push({ observeAfter, wallMs: performance.now() - started, revisionBefore: revision, revisionAfter: value.revision });
      assert.equal(value.ok, true, JSON.stringify(value));
      assert.equal(value.lastAction.result.stdout.trim(), '1');
      assert.equal(value.revision, revision + (observeAfter ? 1 : 0));
    }
    report.efficiency = { samples, commandCount: 6, explicitExtraObservations: 3,
      implicitExtraObservations: 0, revisionBefore: before, revisionAfter: state.revision };
    // An Intent starts a Script that performs a Bridge action, reads its actual
    // UI result, and sends a device command through the same Bridge entry.
    const child = await command('script', { operation: 'start', script: {
      schemaVersion: 'aab.code-script/v1', language: 'javascript', policy: { timeoutMs: 20000 },
      source: `module.exports.main = async ctx => {
        const tap = await ctx.call('tap-native', { selector: { contentDescription: '同意按钮2' }, feedback: 'off' });
        const observed = await ctx.call('wait-text', { targetText: '选择结果：按钮2', provider: 'native', timeoutMs: 10000 });
        const adb = await ctx.call('adb-exec', { argv: ['shell','getprop','sys.boot_completed'], readOnly: true });
        return { ok: tap.ok && observed.ok && adb.ok, tap, observed, adb };
      };`,
    } });
    assert.equal(child.ok, true, JSON.stringify(child));
    const childStarted = child.lastAction.result;
    const childResult = await waitScript(childStarted); write('child-result', childResult);
    assert.equal(childResult.result.ok, true, JSON.stringify(childResult));
    const childRead = await command('script', { operation: 'result', operationId: childStarted.operationId });
    assert.equal(childRead.lastAction.result.result.ok, true);
    assert.equal(childRead.uiObservation.stale, true);
    report.checks.intentToScriptToBridgeAndAdb = true;
    // Known command failure is a step result; the original Intent continues.
    const failed = await command('adb-exec', { argv: ['shell', 'exit', '7'] });
    write('known-failure', failed);
    assert.equal(failed.status, 'waiting_for_decision');
    assert.equal(failed.lastAction.result.exitCode, 7);
    assert.equal(failed.lastAction.ambiguous, false);
    const recovered = await command('adb-exec', { argv: ['shell', 'getprop', 'sys.boot_completed'], readOnly: true });
    assert.equal(recovered.ok, true); report.checks.failureContinuesWithoutReplay = true;
    state = await run('intent', { operation: 'observe', operationId: state.operationId });
    assert.ok(state.summary.nodes.some(node => JSON.stringify(node).includes('选择结果：按钮2')));
    write('final-observation', state);
    const finished = await run('intent', { operation: 'decide', operationId: state.operationId,
      decision: { decisionId: randomUUID(), basedOnRevision: state.revision, agentDecision: 'complete' } });
    assert.equal(finished.status, 'completed');
    report.ok = true;
  } catch (error) { report.error = error.message; throw error; }
  finally { await client.close(); write('report', report); }
  process.stdout.write(JSON.stringify(report) + '\n');
}

if (require.main === module) main(...process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
