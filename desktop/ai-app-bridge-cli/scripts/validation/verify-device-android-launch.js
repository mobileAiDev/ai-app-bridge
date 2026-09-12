#!/usr/bin/env node
'use strict';

// Reproduces launch from Home after 30 seconds with a fresh packaged MCP Host.
// No preload, observer override, provider substitution, or timeout extension.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');
const { verifyUiaSampleTarget } = require('./uia-sample-target');

async function main({ out, serverPath, serial }) {
  assert.equal(process.env.NODE_OPTIONS || '', '', 'Validation must run without injected Node hooks');
  fs.mkdirSync(out);
  fs.copyFileSync(__filename, path.join(out, 'controller.js'));
  const save = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
  const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const adb = args => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  const baseline = verifyUiaSampleTarget(adb, serial);
  const target = { serial, packageName: baseline.packageName };
  const activity = `${target.packageName}.debugbridge.DebugBridgeNativeTestActivity`;
  const cliPath = path.join(path.dirname(serverPath), 'ai-app-bridge.js');
  const foreground = () => adb(['shell', 'dumpsys', 'activity', 'activities']).split('\n').filter(line => line.includes('topResumedActivity'));
  const good = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
  const report = { ok: false, ...baseline, serverPath, serverSha256: sha256(serverPath),
    observerSha256: sha256(path.join(path.dirname(serverPath), 'observation-collector.js')),
    controllerSha256: sha256(__filename), backgroundMs: 30000, cases: [] };
  try {
    for (const [index, feedback] of ['off', 'full', 'off'].entries()) {
      const name = `case-${index + 1}`;
      const directory = path.join(out, name);
      fs.mkdirSync(directory);
      const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' };
      const home = JSON.parse(execFileSync(process.execPath, [cliPath, 'keyevent', '--serial', serial,
        '--key-code', '3', '--feedback', 'off'], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20000 }));
      save(`${name}/home.json`, home);
      good(home);
      const before = foreground();
      save(`${name}/before.json`, before);
      assert.ok(before.some(line => line.includes('com.android.launcher')), JSON.stringify(before));
      const client = createMcpClient({ serverPath, env, transcriptPath: path.join(directory, 'mcp.jsonl'),
        stderrPath: path.join(directory, 'mcp.stderr') });
      const result = { name, feedback, ok: false, before, explicitReads: [] };
      report.cases.push(result);
      const run = async (command, args) => {
        const value = payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
        save(`${name}/${command}.json`, value);
        return good(value);
      };
      try {
        process.stdout.write(JSON.stringify({ name, stage: 'background', waitMs: report.backgroundMs }) + '\n');
        await delay(report.backgroundMs);
        await client.initialize();
        if (index === 0) {
          const readStart = performance.now();
          const read = payloadOf(await client.request('tools/call', { name: 'run', arguments: {
            command: 'status', arguments: { ...target, full: true, feedback: 'off' },
          } }));
          save(`${name}/background-status.json`, read);
          result.backgroundRead = { ok: read.ok, error: read.error, elapsedMs: performance.now() - readStart };
          assert.ok(read.ok === true || read.error === 'provider_timeout', JSON.stringify(read));
          assert.ok(result.backgroundRead.elapsedMs < 12000, 'Background read must release the Host at its deadline');
        }
        const started = performance.now();
        const launched = await run('launch-activity', { ...target, activity, feedback });
        result.launchMs = performance.now() - started;
        assert.equal(launched.dispatched, true);
        result.executionReceipt = launched.executionReceipt;
        result.history = launched._history;
        assert.equal(result.history.status, 'stored');
        result.after = foreground();
        save(`${name}/after.json`, result.after);
        assert.ok(result.after.some(line => line.includes(target.packageName) && line.includes('DebugBridgeNativeTestActivity')));
        const status = await run('status', { ...target, full: true });
        assert.ok(JSON.stringify(status).includes('DebugBridgeNativeTestActivity'));
        assert.equal(status._feedback.observer.target.backgroundPolling, false);
        assert.equal(status._feedback.observer.target.lastSuccessAtMs, null);
        assert.equal(status._history.status, 'stored');
        const endpoint = JSON.parse(adb(['shell', 'run-as', target.packageName, 'cat', 'files/ai_app_bridge_endpoint.json']));
        assert.equal(endpoint.ok, true);
        assert.equal(endpoint.packageName, target.packageName);
        assert.equal(endpoint.transport, 'localabstract');
        assert.equal(status.debugBridge.runtimeEpoch, endpoint.runtimeEpoch);
        assert.equal(status.debugBridge.socketName, endpoint.socketName);
        result.endpoint = endpoint;
        result.observer = status._feedback.observer;
        const tree = await run('tree', { ...target, compact: true, feedback: 'off' });
        const values = [...new Set([...JSON.stringify(tree).matchAll(/Native counter: (\d+)/g)].map(match => Number(match[1])))];
        assert.equal(values.length, 1);
        result.counter = values[0];
        for (const command of ['logs', 'network', 'state', 'events']) {
          const page = await run(command, { ...target, limit: 5, feedback: 'off' });
          assert.ok(Array.isArray(page.items), `${command} must return the actual device page`);
          result.explicitReads.push({ command, items: page.items.length, runtimeEpoch: page.runtimeEpoch,
            coverage: page.coverage, history: page._history.status });
        }
        await run('screenshot', { ...target, outFile: path.join(directory, 'after.png'), feedback: 'off' });
        result.ownership = await run('device-ownership', { operation: 'status', serial });
        assert.equal(result.ownership.active, 0);
        result.ok = true;
        process.stdout.write(JSON.stringify({ name, launchMs: result.launchMs, counter: result.counter, ok: true }) + '\n');
      } finally {
        result.hostExit = await client.close({ stdinEof: true });
        save('report.json', report);
      }
      assert.deepEqual(result.hostExit, { code: 0, signal: null });
    }
    report.ok = true;
  } catch (error) { report.error = error.stack || String(error); throw error; }
  finally { save('report.json', report); }
  process.stdout.write(JSON.stringify({ ok: report.ok, launchMs: report.cases.map(item => item.launchMs) }) + '\n');
}

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).map(value => {
    const separator = value.indexOf('=');
    assert.ok(separator > 0, 'Expected out=, server= and serial=');
    return [value.slice(0, separator), value.slice(separator + 1)];
  }));
  main({ out: path.resolve(args.out), serverPath: path.resolve(args.server), serial: args.serial })
    .catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
}
module.exports = { main };
