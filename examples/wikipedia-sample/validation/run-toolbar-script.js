#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { runCli } = require('../../../desktop/ai-app-bridge-cli/test-support/cli-client');

async function main(out, serial) {
  fs.mkdirSync(out);
  const root = path.resolve(__dirname, '../../..'), packageName = 'org.wikipedia.dev.bridge_sample';
  const target = { platform: 'android', serial, packageName };
  const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_RUNTIME_HOME: path.join(out, 'runtimes'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' };
  const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const source = fs.readFileSync(path.join(__dirname, 'wikipedia-toolbar.v1.js'), 'utf8');
  fs.writeFileSync(path.join(out, 'script.js'), source, { flag: 'wx' });
  const inputs = { serial, python: execFileSync('which', ['python3'], { encoding: 'utf8' }).trim(), oraclePath: path.join(__dirname, 'preferences-oracle.py') };
  const report = { target, sourceSha256: createHash('sha256').update(source).digest('hex'), inputs, scripts: [] };
  let sequence = 0;
  async function run(command, args, options = {}) {
    const result = (await runCli(command, args, { cwd: root, env, timeoutMs: 90000, ...options })).value;
    write(`${String(++sequence).padStart(3, '0')}-${command}.json`, { command, args, result });
    return result;
  }
  const oracle = () => JSON.parse(execFileSync(inputs.python, [inputs.oraclePath, serial], { encoding: 'utf8', timeout: 25000 }));
  try {
    for (let trial = 1; trial <= 3; trial++) {
      const baseline = oracle(); write(`trial-${trial}-baseline.json`, baseline);
      assert.deepEqual(baseline.values.customizeToolbarOrder.value, [0, 1, 2, 3, 4], 'Explicit default toolbar baseline required');
      assert.deepEqual(baseline.values.customizeToolbarMenuOrder.value, [5, 6, 7, 8, 13, 9, 10, 11, 12]);
      const prepared = JSON.parse(execFileSync(inputs.python, [path.join(__dirname, 'prepare-popup-fixture.py'), serial], { encoding: 'utf8', timeout: 30000 }));
      write(`trial-${trial}-fixture.json`, prepared);
      execFileSync('adb', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { timeout: 10000 });
      execFileSync('adb', ['-s', serial, 'shell', 'wm', 'dismiss-keyguard'], { timeout: 10000 });
      const launched = await run('launch-activity', { serial, packageName, activity: 'org.wikipedia.page.PageActivity', action: 'android.intent.action.VIEW', data: 'https://zh.wikipedia.org/wiki/%E6%9C%88%E7%90%83' });
      assert.equal(launched.ok, true, JSON.stringify(launched));
      const began = Date.now();
      let state = await run('script', { operation: 'start', script: { schemaVersion: 'aab.code-script/v1', language: 'javascript', source, target, inputs,
        permissions: ['app.read', 'app.interact'], policy: { timeoutMs: 90000 } }, recordingDir: path.join(out, `trial-${trial}-recording`) });
      assert.equal(state.ok, true, JSON.stringify(state));
      const entry = { trial, operationId: state.operationId, events: [...(state.events || [])] }; report.scripts.push(entry);
      while (!['completed', 'failed', 'cancelled', 'timeout'].includes(state.status)) {
        state = await run('script', { operation: 'wait', operationId: state.operationId, afterSequence: state.eventSequence, waitMs: 1000 });
        entry.events.push(...(state.events || []));
      }
      entry.elapsedMs = Date.now() - began; entry.status = state.status;
      entry.independent = oracle();
      assert.equal(state.status, 'completed', JSON.stringify(entry.events.find(e => e.type === 'script_failed') || { status: state.status }));
      const resultEnvelope = await run('script', { operation: 'result', operationId: entry.operationId });
      assert.equal(resultEnvelope.ok, true, JSON.stringify(resultEnvelope)); assert.equal(resultEnvelope.persisted, true);
      entry.result = resultEnvelope.result;
      assert.equal(entry.result.gate, 'passed');
      assert.deepEqual(entry.independent.values.customizeToolbarOrder.value, [0, 1, 2, 3, 4]);
      assert.equal(entry.independent.values.showCustomizeToolbarTooltip.value, false);
      write(`trial-${trial}-result.json`, entry);
      console.log(JSON.stringify({ trial, operationId: entry.operationId, status: entry.status, elapsedMs: entry.elapsedMs, assertions: entry.result.assertions.length }));
    }
    report.ok = true;
  } catch (error) {
    report.error = error.stack;
  } finally {
    report.runtimeBeforeExport = await run('runtime', { operation: 'stop' });
    try {
      for (const entry of report.scripts) {
        const archiveDir = path.join(out, entry.operationId + '-archive');
        entry.archive = await run('evidence', { operation: 'export', namespace: 'script', operationId: entry.operationId, outputDir: archiveDir, includeRecordedPayloads: true });
        assert.equal(entry.archive.ok, true, JSON.stringify(entry.archive));
        entry.verified = await run('evidence', { operation: 'verify', archiveDir, manifestSha256: entry.archive.manifestSha256 }, { env: { ...env, ADB: '/offline/no-adb' } });
        assert.equal(entry.verified.integrity, 'verified');
      }
    } finally {
      // Evidence commands also use the shared runtime; stop it after archiving.
      report.runtime = await run('runtime', { operation: 'stop' });
      write('report.json', report);
    }
  }
  if (!report.ok) throw Error(report.error);
  return report;
}

if (require.main === module) {
  const [directory, serial] = process.argv.slice(2);
  if (!directory || !serial) throw Error('Usage: run-toolbar-script.js NEW_OUTPUT_DIR SERIAL');
  main(path.resolve(directory), serial).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { main };
