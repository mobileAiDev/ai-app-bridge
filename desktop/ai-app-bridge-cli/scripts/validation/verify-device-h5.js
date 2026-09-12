#!/usr/bin/env node
'use strict';

// Controlled real-WebView workflow. Build/install the SDK instrumentation APK,
// then run this controller with an explicit OPPO serial and a fresh output directory.
// Business App acceptance is a separate gate. Witness state comes from Android,
// outside the SDK HTTP snapshot/action decoder.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { runCli } = require('../../test-support/cli-client');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');
const packageName = 'io.github.mobileaidev.aiappbridge.android.test';

async function main({ out, serial, serverPath = path.resolve(__dirname, '../../bin/mcp-server.js') }) {
  assert(serial, 'An explicit device serial is required');
  fs.mkdirSync(out);
  const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const adb = args => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000 });
  const target = { platform: 'android', serial, packageName };
  const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_RUNTIME_HOME: path.join(out, 'runtimes'),
    AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' };
  const cliPath = path.join(path.dirname(serverPath), 'ai-app-bridge.js');
  let sequence = 0, client;
  const operations = [], report = { scope: 'Controlled Android WebView; not complex business acceptance', target, operations, scripts: [] };
  async function run(command, args, options = {}) {
    const result = (await runCli(command, args, { env, cliPath, timeoutMs: 90000, ...options })).value;
    write(`${String(++sequence).padStart(3, '0')}-${command}.json`, { command, args, result });
    assert.equal(result.ok, true, JSON.stringify(result)); return result;
  }
  const oracle = () => JSON.parse(adb(['exec-out', 'run-as', packageName, 'cat', 'files/h5-public/oracle.json']));
  // The marker belongs only to this fixture. Preserve any preceding witness before resetting it.
  adb(['shell', 'run-as', packageName, 'mkdir', '-p', 'files/h5-public']);
  const previous = adb(['shell', 'run-as', packageName, 'ls', 'files/h5-public']);
  if (previous.includes('final-oracle.json')) write('previous-oracle.json', JSON.parse(adb(['exec-out', 'run-as', packageName, 'cat', 'files/h5-public/final-oracle.json'])));
  adb(['shell', 'run-as', packageName, 'rm', '-f', 'files/h5-public/done', 'files/h5-public/ready.json']);
  const log = fs.openSync(path.join(out, 'instrumentation.log'), 'w');
  const child = spawn('adb', ['-s', serial, 'shell', 'am', 'instrument', '-w', '-r', '-e', 'class',
    'io.github.mobileaidev.aiappbridge.android.H5ExecutionFaultTest#publicIntentAndScriptWindow', '-e', 'publicH5', 'true',
    packageName + '/androidx.test.runner.AndroidJUnitRunner'], { stdio: ['ignore', log, log] });
  const exited = new Promise(resolve => child.once('exit', code => { fs.closeSync(log); resolve(code); }));
  try {
    // This wait belongs to fixture setup, not to a business action or recovery path.
    const deadline = Date.now() + 10000;
    let ready = false;
    while (Date.now() < deadline) {
      try { adb(['shell', 'run-as', packageName, 'test', '-f', 'files/h5-public/ready.json']); ready = true; break; }
      catch (error) { if (error.status !== 1) throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, 'The controlled WebView did not become ready');
    let state = await run('intent', { operation: 'start', provider: 'h5', target,
      goal: 'Clear and type into the observed H5 editor, then click once and verify the independent Android witness.',
      timeoutMs: 120000, recordingDir: path.join(out, 'intent-recording') });
    operations.push({ namespace: 'intent', operationId: state.operationId });
    async function decide(action, decisionId) {
      state = await run('intent', { operation: 'decide', operationId: state.operationId,
        decision: { decisionId, basedOnRevision: state.revision, agentDecision: 'act', action } });
    }
    assert.equal(state.summary.nodes.filter(n => n.label === 'Editor label' && n.editable).length, 1);
    await decide({ action: 'inputText', selector: { ariaLabel: 'Editor label' }, value: '' }, 'clear-observed-editor');
    client = createMcpClient({ serverPath, env, transcriptPath: path.join(out, 'mcp.jsonl'), stderrPath: path.join(out, 'mcp-stderr.log') });
    await client.initialize();
    state = payloadOf(await client.request('tools/call', { name: 'run', arguments: { command: 'intent',
      arguments: { operation: 'observe', operationId: state.operationId, provider: 'h5' } } }));
    write('mcp-observe.json', state); assert(state.ok);
    await client.close({ stdinEof: true, stopRuntime: false }); client = null;
    await decide({ action: 'inputText', selector: { ariaLabel: 'Editor label' }, value: 'Android H5 回归 café 🧪' }, 'type-observed-editor');
    await decide({ action: 'tap', selector: { text: 'Count' } }, 'click-observed-counter');
    await run('screenshot', { serial, packageName, outFile: path.join(out, 'intent-finished.png') });
    report.intentOracle = oracle(); assert.equal(report.intentOracle.writes, 1);
    assert.equal(report.intentOracle.changedText, 'Android H5 回归 café 🧪');
    await run('intent', { operation: 'decide', operationId: state.operationId,
      decision: { decisionId: 'witness-confirmed', basedOnRevision: state.revision, agentDecision: 'complete',
        reason: 'Independent Android witness confirms exactly one click and the exact Unicode text.' } });
    const source = fs.readFileSync(path.join(__dirname, 'android-h5-regression.js'), 'utf8');
    fs.writeFileSync(path.join(out, 'script.js'), source); report.sourceSha256 = createHash('sha256').update(source).digest('hex');
    for (let index = 1; index <= 3; index++) {
      const began = Date.now();
      state = await run('script', { operation: 'start', script: { schemaVersion: 'aab.code-script/v1', language: 'javascript', source, target,
        inputs: { text: 'Android H5 回归 café 🧪' }, permissions: ['app.read', 'app.interact'], policy: { timeoutMs: 60000 } },
      recordingDir: path.join(out, `script-${index}-recording`) });
      operations.push({ namespace: 'script', operationId: state.operationId });
      const events = [...(state.events || [])];
      while (!['completed', 'failed', 'cancelled'].includes(state.status)) {
        state = await run('script', { operation: 'wait', operationId: state.operationId, afterSequence: state.eventSequence, waitMs: 1000 });
        events.push(...(state.events || []));
      }
      assert.equal(state.status, 'completed', JSON.stringify(events));
      const resultEnvelope = await run('script', { operation: 'result', operationId: state.operationId });
      assert.equal(resultEnvelope.ok, true, JSON.stringify(resultEnvelope)); assert.equal(resultEnvelope.persisted, true);
      const result = resultEnvelope.result;
      assert.equal(result.gate, 'passed'); assert.equal(result.after, index + 1);
      const independent = oracle(); assert.equal(independent.writes, index + 1);
      assert.equal(independent.changedText, 'Android H5 回归 café 🧪');
      report.scripts.push({ operationId: state.operationId, elapsedMs: Date.now() - began, result, independent });
    }
    adb(['shell', 'run-as', packageName, 'touch', 'files/h5-public/done']); await exited;
    assert.match(fs.readFileSync(path.join(out, 'instrumentation.log'), 'utf8'), /OK \(1 test\)/);
    report.finalOracle = JSON.parse(adb(['exec-out', 'run-as', packageName, 'cat', 'files/h5-public/final-oracle.json']));
    for (const operation of operations) {
      const archiveDir = path.join(out, operation.operationId + '-archive');
      operation.archive = await run('evidence', { operation: 'export', ...operation, outputDir: archiveDir, includeRecordedPayloads: true });
      operation.verified = await run('evidence', { operation: 'verify', archiveDir, manifestSha256: operation.archive.manifestSha256 },
        { env: { ...env, ADB: '/offline/no-adb' } });
      assert.equal(operation.verified.integrity, 'verified');
    }
    report.ok = true;
  } catch (error) { report.error = error.stack; throw error; }
  finally {
    if (client) await client.close({ stdinEof: true, stopRuntime: false });
    report.runtime = await run('runtime', { operation: 'stop' });
    if (child.exitCode === null) {
      // All shared runtime work has drained before ending this owned fixture.
      adb(['shell', 'run-as', packageName, 'touch', 'files/h5-public/done']); await exited;
    }
    write('report.json', report);
  }
  return report;
}
if (require.main === module) {
  const [out, serial, serverPath] = process.argv.slice(2);
  main({ out: path.resolve(out), serial, ...(serverPath ? { serverPath: path.resolve(serverPath) } : {}) })
    .then(report => console.log(JSON.stringify({ ok: report.ok, scripts: report.scripts.map(s => s.elapsedMs), sourceSha256: report.sourceSha256 })))
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { main };
