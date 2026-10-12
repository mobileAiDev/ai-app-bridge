#!/usr/bin/env node
'use strict';

// Run only against an explicitly provisioned disposable emulator. The public
// Script recipes themselves support ordinary Android targets.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');

async function main(serial, destination) {
  assert.match(serial, /^emulator-\d+$/);
  const out = path.resolve(destination); fs.mkdirSync(out);
  const root = path.resolve(__dirname, '../..');
  const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_RUNTIME_HOME: path.join(out, 'runtimes'),
    AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR: path.join(out, 'ownership') };
  const client = createMcpClient({ serverPath: path.join(root, 'bin/mcp-server.js'), env,
    transcriptPath: path.join(out, 'mcp.jsonl'), stderrPath: path.join(out, 'mcp.stderr') });
  const run = async (command, args) => payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args, extract: null } }));
  const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
  const target = { platform: 'android', serial }, stateFile = path.join(out, 'device-settings.json');
  const script = async (sourcePath, inputs, taskTarget = target) => {
    const started = await run('script', { operation: 'start', script: { schemaVersion: 'aab.code-script/v1', language: 'javascript',
      sourcePath, target: taskTarget, inputs, policy: { timeoutMs: 120000 } } });
    assert.equal(started.ok, true, JSON.stringify(started));
    let state = started;
    while (!['completed', 'failed', 'cancelled'].includes(state.status)) {
      state = await run('script', { operation: 'wait', operationId: started.operationId, afterSequence: state.eventSequence ?? 0, waitMs: 10000 });
      assert.equal(state.ok, true, JSON.stringify(state));
    }
    assert.equal(state.status, 'completed', JSON.stringify(state));
    const result = await run('script', { operation: 'result', operationId: started.operationId });
    assert.equal(result.persisted, true, JSON.stringify(result));
    return { operationId: started.operationId, result: result.result, resultRef: result.resultRef };
  };
  let restoreSource;
  const report = { ok: false, serial, physicalDevicesTouched: false };
  try {
    await client.initialize();
    const before = await run('doctor', { serial, timeoutMs: 10000 }); write('doctor-before.json', before);
    assert.equal(before.ok, true); assert.equal(before.checks.find(item => item.name === 'host').facts.runtime.state, 'stopped');
    assert.equal(before.checks.find(item => item.name === 'android.device').facts.properties['sys.boot_completed'], '1');
    assert.equal(before.checks.find(item => item.name === 'android.sdk').status, 'not_run');
    assert.equal(fs.existsSync(env.AI_APP_BRIDGE_FACT_STORE_DIR), false);
    const recipes = await run('script', { operation: 'recipes' });
    restoreSource = recipes.recipes.find(item => item.name === 'android-test-session').sourcePath;
    const prepared = await script(restoreSource, { operation: 'prepare', stateFile, stayAwake: true, rotation: 1, showImeWithHardware: true, wake: true });
    write('prepared.json', prepared); assert.equal(prepared.result.ok, true, JSON.stringify(prepared));
    const settingsBefore = JSON.parse(fs.readFileSync(stateFile));
    const launched = await script(recipes.recipes.find(item => item.name === 'android-launch-and-wait').sourcePath,
      { readyText: 'Network & internet', timeoutMs: 30000 }, { ...target, packageName: 'com.android.settings' });
    write('launched.json', launched); assert.equal(launched.result.ok, true, JSON.stringify(launched));
    report.launchResultBytes = Buffer.byteLength(JSON.stringify(launched.result));
    assert.ok(report.launchResultBytes < 16384, 'the ordinary flow result should fit even the minimum public budget');
    const after = await run('doctor', { serial, packageName: 'com.android.settings', timeoutMs: 10000 }); write('doctor-after.json', after);
    assert.equal(after.ok, true); assert.equal(after.checks.find(item => item.name === 'android.app').facts.installed, true);
    assert.equal(after.checks.find(item => item.name === 'android.uia').facts.running, true);
    assert.equal(after.checks.find(item => item.name === 'android.sdk').status, 'issue');
    const restored = await script(restoreSource, { operation: 'restore', stateFile }); write('restored.json', restored);
    assert.equal(restored.result.ok, true, JSON.stringify(restored));
    for (const item of settingsBefore.settings) {
      const observed = await run('adb-exec', { serial, argv: ['shell', 'settings', '--user', String(settingsBefore.userId), 'get', item.namespace, item.key], readOnly: true });
      assert.equal(observed.ok, true); assert.equal(observed.stdout.trim(), item.before === null ? 'null' : item.before, item.key);
    }
    const web = await run('doctor', { platform: 'web' }); write('doctor-web.json', web);
    assert.equal(web.checks.some(item => item.name === 'web.provider'), true);
    report.ok = true; report.checks = { doctorWithoutRuntime: true, deviceOnlyPreparation: true, actualSettingsReadback: true,
      launchOnceAndConditionWait: true, uiaAvailableWithoutAppSdk: true, explicitRestore: true,
      independentlyVerifiedOriginalValues: settingsBefore.settings.length, webReadOnlyRuntimeDiagnostics: true };
    report.operations = [prepared.operationId, launched.operationId, restored.operationId];
  } finally {
    if (!report.ok && restoreSource && fs.existsSync(stateFile)) {
      try { report.failureCleanup = await script(restoreSource, { operation: 'restore', stateFile }); }
      catch (error) { report.failureCleanup = { error: error.message }; }
    }
    await client.close(); write('report.json', report);
  }
  process.stdout.write(JSON.stringify(report) + '\n');
}

if (require.main === module) main(process.argv[2], process.argv[3]).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
