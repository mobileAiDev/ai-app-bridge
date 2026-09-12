#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { runCli } = require('../../../desktop/ai-app-bridge-cli/test-support/cli-client');
const PACKAGE = 'org.videolan.vlc.bridge_sample.debug';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

async function main(directory, serial, trials) {
  const root = path.resolve(__dirname, '../../..'), target = { platform: 'android', serial, packageName: PACKAGE };
  fs.mkdirSync(directory);
  const source = fs.readFileSync(path.join(__dirname, 'vlc-local-media.v1.js'), 'utf8');
  const manifestPath = path.join(__dirname, 'vlc-local-media.manifest.v1.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.frozen, true); assert.equal(manifest.target.packageName, PACKAGE);
  assert.equal(sha(source), manifest.scriptSha256);
  const APK_SHA256 = manifest.apkSha256;
  const media = JSON.parse(fs.readFileSync(path.join(__dirname, '../build/media/manifest.json'), 'utf8'));
  assert.deepEqual(media, manifest.media);
  const inputs = { serial, python: execFileSync('which', ['python3'], { encoding: 'utf8' }).trim(), oraclePath: path.join(directory, 'independent-oracle.py') };
  fs.copyFileSync(path.join(__dirname, 'independent-oracle.py'), inputs.oraclePath);
  assert.equal(sha(fs.readFileSync(inputs.oraclePath)), manifest.oracleSha256);
  const report = { target, sourceSha256: sha(source), oracleSha256: manifest.oracleSha256, apkSha256: APK_SHA256, manifest, media, trials: [] };
  fs.writeFileSync(path.join(directory, 'script.js'), source, { flag: 'wx' });
  fs.copyFileSync(manifestPath, path.join(directory, 'scenario-manifest.json'));
  fs.copyFileSync(__filename, path.join(directory, 'controller.js'));
  inputs.oraclePath = path.join(directory, 'independent-oracle.py');
  const adb = args => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 30000 }).trim();
  try {
    for (let trial = 1; trial <= trials; trial++) {
      const out = path.join(directory, `trial-${trial}`); fs.mkdirSync(out);
      const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_RUNTIME_HOME: path.join(out, 'runtimes'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' };
      let sequence = 0, state;
      const entry = { trial, events: [] }; report.trials.push(entry);
      const write = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
      async function run(command, args, options = {}) {
        const result = (await runCli(command, args, { cwd: root, env, timeoutMs: 90000, ...options })).value;
        write(`${String(++sequence).padStart(3, '0')}-${command}.json`, { command, args, result });
        return result;
      }
      try {
        const apkPaths = adb(['shell', 'pm', 'path', PACKAGE]).split('\n'); assert.equal(apkPaths.length, 1);
        entry.installedApkSha256 = adb(['shell', 'sha256sum', quote(apkPaths[0].slice('package:'.length))]).split(/\s/)[0];
        assert.equal(entry.installedApkSha256, APK_SHA256);
        entry.fixtureChecks = media.files.map(file => {
          const devicePath = media.phoneDirectory + '/' + file.name;
          const actual = adb(['shell', 'sha256sum', quote(devicePath)]).split(/\s/)[0];
          assert.equal(actual, file.sha256); return { devicePath, sha256: actual };
        });
        assert.equal(adb(['shell', 'ls', '-A', media.emptyDirectory]), '');
        entry.baseline = JSON.parse(execFileSync(inputs.python, [inputs.oraclePath, serial], { encoding: 'utf8', timeout: 25000 }));
        assert.equal(entry.baseline.preferences.values.app_theme.value, '-1');
        write('preflight.json', entry);
        adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']); adb(['shell', 'wm', 'dismiss-keyguard']);
        const launched = await run('launch-activity', { serial, packageName: PACKAGE, activity: 'org.videolan.vlc.StartActivity' });
        assert.equal(launched.ok, true, JSON.stringify(launched));
        const began = Date.now();
        state = await run('script', { operation: 'start', script: { schemaVersion: 'aab.code-script/v1', language: 'javascript', source,
          target, inputs, permissions: ['app.read', 'app.interact', 'capture.read'], policy: { timeoutMs: 180000 } }, recordingDir: path.join(out, 'recording') });
        assert.equal(state.ok, true, JSON.stringify(state));
        entry.operationId = state.operationId; entry.events.push(...(state.events || []));
        while (!['completed', 'failed', 'cancelled', 'timeout'].includes(state.status)) {
          state = await run('script', { operation: 'wait', operationId: entry.operationId, afterSequence: state.eventSequence, waitMs: 1000 });
          entry.events.push(...(state.events || []));
        }
        entry.elapsedMs = Date.now() - began; entry.status = state.status;
        assert.equal(state.status, 'completed', JSON.stringify(entry.events.find(e => e.type === 'script_failed') || state));
        const resultEnvelope = await run('script', { operation: 'result', operationId: entry.operationId });
        assert.equal(resultEnvelope.ok, true, JSON.stringify(resultEnvelope)); assert.equal(resultEnvelope.persisted, true);
        entry.result = resultEnvelope.result;
        assert.equal(entry.result.gate, 'passed');
        assert.ok(entry.result.coreElapsedMs <= 300000); assert.ok(entry.result.acceptanceElapsedMs <= 600000);
        entry.final = JSON.parse(execFileSync(inputs.python, [inputs.oraclePath, serial], { encoding: 'utf8', timeout: 25000 }));
        assert.equal(entry.final.preferences.values.app_theme.value, '-1');
        console.log(JSON.stringify({ trial, operationId: entry.operationId, elapsedMs: entry.elapsedMs,
          coreElapsedMs: entry.result.coreElapsedMs, assertions: entry.result.assertions.length }));
      } catch (error) {
        entry.error = error.stack; throw error;
      } finally {
        try {
          if (entry.operationId) {
            if (state && !['completed', 'failed', 'cancelled', 'timeout'].includes(state.status))
              await run('script', { operation: 'cancel', operationId: entry.operationId });
            const archiveDir = path.join(out, entry.operationId + '-archive');
            entry.archive = await run('evidence', { operation: 'export', namespace: 'script', operationId: entry.operationId, outputDir: archiveDir, includeRecordedPayloads: true });
            assert.equal(entry.archive.ok, true, JSON.stringify(entry.archive));
            entry.verified = await run('evidence', { operation: 'verify', archiveDir, manifestSha256: entry.archive.manifestSha256 }, { env: { ...env, ADB: '/offline/no-adb' } });
            assert.equal(entry.verified.integrity, 'verified');
          }
        } finally {
          entry.runtime = await run('runtime', { operation: 'stop' }); write('result.json', entry);
        }
      }
    }
    report.ok = true;
  } catch (error) {
    report.error = error.stack;
  } finally {
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
  if (!report.ok) throw Error(report.error);
}

if (require.main === module) {
  const [directory, serial, count = '3'] = process.argv.slice(2);
  if (!directory || !serial || !/^[1-3]$/.test(count)) throw Error('Usage: run-local-media.js NEW_OUTPUT_DIR SERIAL [1..3]');
  main(path.resolve(directory), serial, Number(count)).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { main };
