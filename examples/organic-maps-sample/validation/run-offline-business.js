#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { runCli } = require('../../../desktop/ai-app-bridge-cli/test-support/cli-client');
const PACKAGE = 'app.organicmaps.bridge_sample.web.debug';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const terminal = state => ['completed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(state.status);

async function main(directory, serial, trials) {
  const root = path.resolve(__dirname, '../../..'), target = { platform: 'android', serial, packageName: PACKAGE };
  fs.mkdirSync(directory);
  const source = fs.readFileSync(path.join(__dirname, 'offline-business.v1.js'), 'utf8');
  const manifestPath = path.join(__dirname, 'offline-business.manifest.v1.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.target.packageName, PACKAGE); assert.equal(sha(source), manifest.scriptSha256);
  assert.equal(sha(fs.readFileSync(__filename)), manifest.controllerSha256);
  assert.ok(manifest.frozen === true || trials === 1, 'Authoring is one run; repeated acceptance requires a frozen manifest');
  assert.equal(manifest.hostProfile, '1gb');
  const inputs = { serial, python: execFileSync('which', ['python3'], { encoding: 'utf8' }).trim(),
    oraclePath: path.join(directory, 'independent-oracle.py'), expectedRouteText: manifest.expectedRouteText };
  fs.copyFileSync(path.join(__dirname, 'independent-oracle.py'), inputs.oraclePath);
  assert.equal(sha(fs.readFileSync(inputs.oraclePath)), manifest.oracleSha256);
  fs.writeFileSync(path.join(directory, 'script.js'), source, { flag: 'wx' });
  fs.copyFileSync(manifestPath, path.join(directory, 'scenario-manifest.json'));
  fs.copyFileSync(__filename, path.join(directory, 'controller.js'));
  const report = { target, manifest, trials: [] };
  const adb = args => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 30000 }).trim();
  const readOracle = () => JSON.parse(execFileSync(inputs.python, [inputs.oraclePath, serial], { encoding: 'utf8', timeout: 20000 }));
  try {
    for (let trial = 1; trial <= trials; trial++) {
      const out = path.join(directory, `trial-${trial}`); fs.mkdirSync(out);
      const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_RUNTIME_HOME: path.join(out, 'runtimes'),
        AI_APP_BRIDGE_FACT_CACHE_PROFILE: manifest.hostProfile };
      const entry = { trial, events: [] }; report.trials.push(entry);
      let sequence = 0, state, began;
      const write = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
      async function run(command, args, selectedEnv = env) {
        const result = (await runCli(command, args, { cwd: root, env: selectedEnv, timeoutMs: 90000 })).value;
        write(`${String(++sequence).padStart(3, '0')}-${command}.json`, { command, args, result }); return result;
      }
      function remember(next) {
        state = next;
        assert.equal(state.ok, true, JSON.stringify({ error: state.error, status: state.status }));
        // history.gap describes eviction from the bounded history ring, not
        // whether this controller missed an event while reading incrementally.
        let after = entry.events.at(-1)?.sequence || 0;
        for (const event of state.events) {
          if (event.sequence <= after) continue;
          assert.equal(event.sequence, after + 1, 'Script progress event missing');
          entry.events.push(event); after = event.sequence;
        }
        assert.equal(after, state.eventSequence, 'Script progress is incomplete');
        const stage = state.rollingSummary.stage;
        if (stage && stage !== entry.lastStage) {
          entry.lastStage = stage;
          console.log(JSON.stringify({ trial, stage, message: state.rollingSummary.message }));
        }
      }
      try {
        const beforePreflight = Date.now();
        const apkPaths = adb(['shell', 'pm', 'path', PACKAGE]).split('\n'); assert.equal(apkPaths.length, 1);
        entry.installedApkSha256 = adb(['shell', 'sha256sum', quote(apkPaths[0].slice('package:'.length))]).split(/\s/)[0];
        assert.equal(entry.installedApkSha256, manifest.apkSha256);
        assert.equal(adb(['shell', 'getprop', 'persist.sys.locale']), manifest.target.locale);
        const folder = `/storage/emulated/0/Android/data/${PACKAGE}/files/${manifest.maps.dataVersion}`;
        assert.deepEqual(adb(['shell', 'ls', '-1', folder]).split('\n').sort(), manifest.maps.files.map(f => f.name).sort());
        entry.mapChecks = manifest.maps.files.map(file => {
          const actual = adb(['shell', 'sha256sum', quote(folder + '/' + file.name)]).split(/\s/)[0];
          assert.equal(actual, file.sha256); return { name: file.name, sha256: actual };
        });
        entry.baseline = readOracle(); assert.deepEqual(entry.baseline.placemarks, []);
        assert.equal(entry.baseline.settings.Units, 'Metric'); assert.equal(entry.baseline.settings.AutoDownloadEnabled, 'false');
        entry.preflightMs = Date.now() - beforePreflight; write('preflight.json', entry);
        adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']); adb(['shell', 'wm', 'dismiss-keyguard']);
        const launched = await run('launch-app', { serial, packageName: PACKAGE, activity: 'app.organicmaps.SplashActivity' });
        assert.equal(launched.ok, true, JSON.stringify(launched));
        began = Date.now();
        state = await run('script', { operation: 'start', script: { schemaVersion: 'aab.code-script/v1', language: 'javascript', source,
          target, inputs, permissions: ['app.read', 'app.interact', 'capture.read'], policy: { timeoutMs: 600000 } },
          recordingDir: path.join(out, 'recording') });
        assert.equal(state.ok, true, JSON.stringify(state)); entry.operationId = state.operationId; remember(state);
        while (!terminal(state)) remember(await run('script', { operation: 'wait', operationId: entry.operationId,
          afterSequence: state.eventSequence, waitMs: 5000 }));
        entry.executionWallMs = Date.now() - began; entry.status = state.status;
        assert.equal(state.status, 'completed', JSON.stringify(entry.events.find(e => e.type === 'script_failed')
          || { status: state.status, error: state.error }));
        const resultEnvelope = await run('script', { operation: 'result', operationId: entry.operationId });
        assert.equal(resultEnvelope.ok, true, JSON.stringify(resultEnvelope)); assert.equal(resultEnvelope.persisted, true);
        entry.result = resultEnvelope.result;
        assert.equal(entry.result.gate, 'passed');
        assert.ok(entry.result.coreElapsedMs <= 300000); assert.ok(entry.result.acceptanceElapsedMs <= 600000);
        entry.final = readOracle(); assert.deepEqual(entry.final.placemarks, []);
        assert.equal(entry.final.settings.Units, 'Metric'); assert.equal(entry.final.settings.AutoDownloadEnabled, 'false');
      } catch (error) {
        entry.error = error.stack; throw error;
      } finally {
        try {
          if (entry.operationId) {
            if (state && !terminal(state)) {
              state = await run('script', { operation: 'cancel', operationId: entry.operationId });
              assert.equal(state.ok, true, 'Script cancellation failed');
              while (!terminal(state)) {
                state = await run('script', { operation: 'wait', operationId: entry.operationId,
                  afterSequence: state.eventSequence, waitMs: 5000 });
                assert.equal(state.ok, true, 'Script cancellation wait failed');
              }
              entry.cleanupTerminal = { status: state.status, eventSequence: state.eventSequence };
            }
            entry.archive = await run('evidence', { operation: 'export', namespace: 'script', operationId: entry.operationId,
              outputDir: path.join(out, 'archive'), includeRecordedPayloads: true });
            assert.equal(entry.archive.ok, true, JSON.stringify(entry.archive));
          }
        } finally {
          entry.runtime = await run('runtime', { operation: 'stop' });
          if (entry.archive?.ok) {
            const offline = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'offline-facts'), AI_APP_BRIDGE_RUNTIME_HOME: path.join(out, 'offline-runtimes'),
              AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb', ADB: '/offline-no-adb' };
            try {
              entry.verified = await run('evidence', { operation: 'verify', archiveDir: entry.archive.archiveDir,
                manifestSha256: entry.archive.manifestSha256 }, offline);
              assert.equal(entry.verified.integrity, 'verified', JSON.stringify(entry.verified));
            } finally { await run('runtime', { operation: 'stop' }, offline); }
          }
          if (began) entry.throughOfflineVerifyMs = Date.now() - began;
          write('result.json', entry);
        }
      }
      console.log(JSON.stringify({ trial, operationId: entry.operationId, status: entry.status, executionWallMs: entry.executionWallMs,
        throughOfflineVerifyMs: entry.throughOfflineVerifyMs, coreElapsedMs: entry.result.coreElapsedMs,
        assertions: entry.result.assertions.length, actions: entry.result.actions.length }));
    }
    report.ok = true;
  } catch (error) { report.error = error.stack; }
  finally { fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
  if (!report.ok) throw Error(report.error);
}

if (require.main === module) {
  const [directory, serial, count = '3'] = process.argv.slice(2);
  if (!directory || !serial || !/^[1-3]$/.test(count)) throw Error('Usage: run-offline-business.js NEW_OUTPUT_DIR SERIAL [1..3]');
  main(path.resolve(directory), serial, Number(count)).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { main };
