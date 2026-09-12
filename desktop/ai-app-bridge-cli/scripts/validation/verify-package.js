#!/usr/bin/env node
'use strict';

// Exercises a real tarball installation outside the checkout. The only device
// action uses a controlled ADB executable, recorded separately from real-device QA.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');
const { createUiaRuntimeFixture } = require('../../test-support/uia-runtime-fixture');
const { runCli } = require('../../test-support/cli-client');

async function main(directory) {
  const out = path.resolve(directory);
  fs.mkdirSync(out); // Refuse to overwrite a previous validation run.
  const source = path.resolve(__dirname, '../..');
  const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
  const env = { ...process.env, NODE_PATH: '', AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'host-facts'),
    AI_APP_BRIDGE_RUNTIME_HOME: path.join(out, 'runtimes'),
    AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR: path.join(out, 'ownership') };
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', out], { cwd: source, env, encoding: 'utf8' }))[0];
  write('pack.json', packed);
  const tarball = path.join(out, packed.filename);
  const install = path.join(out, 'clean-install'); fs.mkdirSync(install);
  fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({ name: 'aab-package-validation', private: true }) + '\n');
  const log = fs.openSync(path.join(out, 'install.log'), 'w');
  try { execFileSync('npm', ['install', '--foreground-scripts', '--prefer-offline', '--no-audit', '--no-fund', tarball], { cwd: install, env, stdio: ['ignore', log, log], timeout: 300000 }); }
  finally { fs.closeSync(log); }
  const installed = path.join(install, 'node_modules/@mobileaidev/ai-app-bridge');
  for (const entry of ['ai-app-bridge.js', 'mcp-server.js']) {
    const help = execFileSync(process.execPath, [path.join(installed, 'bin', entry), '--help'], { cwd: install, env, encoding: 'utf8' });
    assert.match(help, /Usage:/); fs.writeFileSync(path.join(out, `${entry}-help.txt`), help);
  }
  const installLog = fs.readFileSync(path.join(out, 'install.log'), 'utf8');
  assert.match(installLog, /@mobileaidev\/segmented-fact-store-native@[^\s]+ install/, 'native install lifecycle must actually run');
  assert.match(installLog, /gyp info ok/, 'native compilation must succeed in the fresh install');
  const calls = path.join(out, 'controlled-adb.jsonl');
  const adb = path.join(out, 'controlled-adb');
  const uia = await createUiaRuntimeFixture({ directory: path.join(out, 'controlled-uia'), serial: 'controlled-package-device',
    xml: '<hierarchy><node package="example.uia" class="android.widget.LinearLayout" text="Package UI probe" enabled="true" clickable="true" bounds="[0,0][100,100]"><node package="example.uia" class="android.widget.Button" text="Child" content-desc="Package UI probe" resource-id="example.uia:id/child" enabled="true" clickable="true" bounds="[0,0][10,10]"/></node></hierarchy>' });
  fs.writeFileSync(adb, `#!${process.execPath}
if (require(${JSON.stringify(require.resolve('../../test-support/uia-runtime-fixture'))}).handleUiaRuntimeFixture(process.argv.slice(2), { directory: ${JSON.stringify(uia.directory)} })) process.exit(0);
const call=require(${JSON.stringify(require.resolve('../../test-support/android-shell-fixture'))}).handleAndroidShellFixture(process.argv.slice(2));
if(call.handled)process.exit(0);
require('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(call.args)+'\\n');
`, { mode: 0o755 });
  const cli = async (command, args) => {
    const result = await runCli(command, args, { cliPath: path.join(installed, 'bin/ai-app-bridge.js'), cwd: install, env });
    assert.equal(result.code, 0, JSON.stringify(result));
    return result.value;
  };
  let client = createMcpClient({ serverPath: path.join(installed, 'bin/mcp-server.js'), cwd: install, env,
    transcriptPath: path.join(out, 'mcp.jsonl'), stderrPath: path.join(out, 'mcp-stderr.log') });
  const run = async (command, args) => payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
  const report = { ok: false, tarball: packed.filename, sha256: crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex'),
    installation: 'fresh npm install; native lifecycle and successful node-gyp build observed',
    npmAllowScriptsAdvisory: installLog.includes('not yet covered by allowScripts'), device: 'controlled ADB only; no real device' };
  try {
    const bundle = JSON.parse(fs.readFileSync(path.join(installed, 'runtime/uia/manifest.json')));
    assert.equal(bundle.schemaVersion, 'aab.uia.bundle.v1'); assert.equal(bundle.minApi, 33);
    assert.equal(bundle.sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(installed, 'runtime/uia/ai-app-bridge-uia.jar'))).digest('hex'));
    assert.equal(bundle.sha256, uia.peer.dexSha256); report.uiaBundle = { sha256: bundle.sha256, minApi: bundle.minApi };
    await client.initialize();
    const tools = (await client.request('tools/list', {})).result.tools.map(item => item.name);
    assert.deepEqual(tools, ['capabilities', 'run']); report.tools = tools;
    const directory = payloadOf(await client.request('tools/call', { name: 'capabilities', arguments: {} }));
    assert(Object.values(directory.domains).flat().every(item => !Object.hasOwn(item, 'inputSchema')));
    const selection = { command: 'intent', operation: 'decide', platform: 'android', provider: 'native', action: 'tap' };
    const selected = payloadOf(await client.request('tools/call', { name: 'capabilities', arguments: selection }));
    assert.equal(selected.ok, true); assert.equal(selected.inputSchema.properties.operation.const, 'decide');
    const selectedHelp = execFileSync(process.execPath, [path.join(installed, 'bin/ai-app-bridge.js'), '--help', 'intent',
      '--operation', 'decide', '--platform', 'android', '--provider', 'native', '--action', 'tap'], { cwd: install, env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(selectedHelp), selected.inputSchema);
    report.progressiveDiscovery = { selection: selected.selection, sharedCliMcpSchema: true,
      directoryBytes: Buffer.byteLength(JSON.stringify(directory)), selectedHelpBytes: Buffer.byteLength(selectedHelp) };
    write('selected-capabilities.json', selected);
    const capabilities = payloadOf(await client.request('tools/call', { name: 'capabilities', arguments: { includeOptions: true } }));
    const commands = Object.values(capabilities.domains).flat(); report.commandCount = commands.length;
    assert(commands.length > 0); assert.equal(commands.some(item => item.command === 'batch'), false);
    for (const command of commands) {
      assert.equal(command.entrypoints.cli, true, command.command);
      assert.equal(command.entrypoints.mcp, true, command.command);
    }
    assert.equal(commands.find(item => item.command === 'intent').role, 'execution');
    assert.equal(commands.find(item => item.command === 'tap-uia').entrypoints.script, true);
    write('capabilities.json', capabilities);
    const uiaArgs = { serial: 'controlled-package-device', packageName: 'example.uia', adb: uia.adb, feedback: 'off' };
    const preciseCli = await cli('tap-uia', { ...uiaArgs, selector: { contentDescription: 'Package UI probe' } });
    const preciseMcp = await run('tap-uia', { ...uiaArgs, selector: { resourceName: 'example.uia:id/child' } });
    assert.equal(preciseCli.ok, true); assert.equal(preciseMcp.ok, true);
    report.preciseUia = { cli: preciseCli.executionReceipt, mcp: preciseMcp.executionReceipt };
    report.executionContract = await require('./verify-execution-contract').verifyExecutionContract({ out, serverPath: path.join(installed, 'bin/mcp-server.js') });
    report.autonomousContract = await require('./verify-execution-contract').verifyAutonomousContract({ out, serverPath: path.join(installed, 'bin/mcp-server.js') });
    const runtime = await run('script', { operation: 'runtime-status' });
    assert.equal(runtime.ok, true); write('runtime-status.json', runtime);
    const answer = { verdict: 'passed', observedSettings: { theme: 'dark', color: 'system' } };
    const sourceText = `module.exports.main = async ctx => {
      const tree = await ctx.call('uia-tree', { adb: ${JSON.stringify(adb)}, compact: true, maxDepth: 0 });
      if (!tree.ok) throw new Error(tree.error);
      if (tree.result.nodes.length !== 1 || tree.result.nodes[0].text !== 'Package UI probe') throw new Error('UIA depth filter failed');
      const precise = await ctx.call('tap-uia', { adb: ${JSON.stringify(uia.adb)}, packageName: 'example.uia', selector: { text: 'Package UI probe' } });
      if (!precise.ok || precise.executionReceipt.actionId !== precise.execution.actionId) throw new Error('UIA original Script action identity missing');
      const action = await ctx.call('keyevent', { adb: ${JSON.stringify(adb)}, keyCode: 0 });
      if (!action.ok) throw new Error(action.error);
      const answer = await ctx.askAgent({ question: 'Return a structured result' });
      return { verified: true, answer };
    };`;
    const start = await cli('script', { operation: 'start', script: {
      schemaVersion: 'aab.code-script/v1', language: 'javascript', source: sourceText,
      target: { platform: 'android', serial: 'controlled-package-device', packageName: 'example.controlled' }, permissions: ['app.read', 'app.interact'],
      policy: { timeoutMs: 15000 },
    } });
    assert.equal(start.ok, true); let state = start;
    const deadline = Date.now() + 20000;
    while (!['completed', 'failed', 'cancelled'].includes(state.status) && Date.now() < deadline) {
      if (state.status === 'waiting_for_agent') {
        const question = state.events.findLast(event => event.type === 'agent_question_created');
        assert(question, JSON.stringify(state));
        const owner = await run('runtime', { operation: 'status' });
        await client.close({ stopRuntime: false, stdinEof: true });
        assert.equal((await cli('script', { operation: 'status', operationId: start.operationId })).status, 'waiting_for_agent');
        state = await cli('script', { operation: 'decide', operationId: start.operationId,
          requestId: question.requestId, revision: question.revision, decision: answer });
        assert.equal(state.ok, true, JSON.stringify(state));
        client = createMcpClient({ serverPath: path.join(installed, 'bin/mcp-server.js'), cwd: install, env,
          transcriptPath: path.join(out, 'reconnected-mcp.jsonl'), stderrPath: path.join(out, 'reconnected-stderr.log') });
        await client.initialize();
        assert.equal((await run('runtime', { operation: 'status' })).runtimeId, owner.runtimeId);
        report.entrypoints = { runtimeId: owner.runtimeId, cliStart: true, mcpWait: true,
          mcpDisconnectPreservedTask: true, cliDecision: true, reconnectedMcpSameRuntime: true };
      } else state = await run('script', { operation: 'wait', operationId: start.operationId, afterSequence: state.eventSequence, waitMs: 1000 });
    }
    state = await run('script', { operation: 'status', operationId: start.operationId });
    write('controlled-script.json', state); assert.equal(state.status, 'completed');
    const completedEvent = state.events.find(event => event.type === 'script_completed');
    assert.ok(completedEvent, 'Completed event must reference the separately stored result');
    assert.equal(Object.hasOwn(state, 'result'), false);
    assert.equal(Object.hasOwn(completedEvent, 'result'), false);
    const resultEnvelope = await cli('script', { operation: 'result', operationId: start.operationId });
    write('controlled-script-result.json', resultEnvelope);
    assert.equal(resultEnvelope.ok, true); assert.equal(resultEnvelope.status, 'completed'); assert.equal(resultEnvelope.persisted, true);
    assert.deepEqual(resultEnvelope.result, { verified: true, answer });
    assert.deepEqual(completedEvent.resultRef, resultEnvelope.resultRef);
    assert.deepEqual(state.resultRef, resultEnvelope.resultRef);
    const actions = fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(actions.filter(row => row.includes('input')), [['-s', 'controlled-package-device', 'shell', 'input', 'keyevent', '0']]);
    assert.equal(actions.filter(row => row.includes('uiautomator')).length, 0);
    assert.equal(uia.requests.filter(row => row.op === 'observe').length, 4);
    report.controlledScript = { operationId: start.operationId, status: state.status, adbCalls: actions.length, structuredAgentReply: 'verified' };
    report.permissionContract = await require('./verify-permission-contract').verifyPermissionContract({ out, run });
    const shutdownScripts = await require('./verify-script-shutdown').startShutdownScripts({ out, run });
    const shutdownIntents = await require('./verify-intent-shutdown').startShutdownIntents({ out, run });
    const runtimeBeforeShutdown = await run('runtime', { operation: 'status' });
    assert.equal(typeof runtimeBeforeShutdown.runtimeId, 'string'); assert.ok(runtimeBeforeShutdown.runtimeId.length > 0);
    assert.deepEqual(await client.close(), { code: 0, signal: null });
    const restarted = createMcpClient({ serverPath: path.join(installed, 'bin/mcp-server.js'), cwd: install, env,
      transcriptPath: path.join(out, 'restarted-mcp.jsonl'), stderrPath: path.join(out, 'restarted-stderr.log') });
    try {
      await restarted.initialize();
      const restartedRun = async (command, args) => payloadOf(await restarted.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
      const restoredResult = await restartedRun('script', { operation: 'result', operationId: start.operationId });
      write('restarted-script-result.json', restoredResult);
      assert.equal(restoredResult.ok, true); assert.equal(restoredResult.status, 'completed'); assert.equal(restoredResult.persisted, true);
      assert.deepEqual(restoredResult.result, resultEnvelope.result);
      assert.deepEqual(restoredResult.resultRef, resultEnvelope.resultRef);
      const runtimeAfterRestart = await restartedRun('runtime', { operation: 'status' });
      assert.equal(runtimeAfterRestart.ok, true); assert.equal(typeof runtimeAfterRestart.runtimeId, 'string'); assert.ok(runtimeAfterRestart.runtimeId.length > 0);
      assert.notEqual(runtimeAfterRestart.runtimeId, runtimeBeforeShutdown.runtimeId);
      report.persistedScriptResult = { operationId: start.operationId, resultRef: resultEnvelope.resultRef,
        cliRead: true, restartedMcpRead: true, runtimeBefore: runtimeBeforeShutdown.runtimeId, runtimeAfter: runtimeAfterRestart.runtimeId };
      report.scriptShutdown = await require('./verify-script-shutdown').verifyScriptShutdown({ out, operations: shutdownScripts,
        run: restartedRun });
      report.intentShutdown = await require('./verify-intent-shutdown').verifyIntentShutdown({ out, operations: shutdownIntents,
        run: restartedRun });
      report.permissionShutdown = await require('./verify-permission-contract').verifyPermissionShutdown({ out,
        run: restartedRun,
        operationId: report.permissionContract.shutdownOperationId });
    } finally { await restarted.close(); }
    report.ok = true;
  } catch (error) { report.error = error.stack || String(error); throw error; }
  finally { await client.close(); await uia.close(); write('report.json', report); }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

if (require.main === module) main(process.argv[2]).catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
module.exports = { main };
