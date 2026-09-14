#!/usr/bin/env node
'use strict';

// Run one frozen Wikipedia business Script. The controller reads original App
// files at declared safe points; it never writes an expected business result.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { inventory } = require('./business-oracle');
const { runCli } = require('../../../desktop/ai-app-bridge-cli/test-support/cli-client');

const ROOT = path.resolve(__dirname, '../../..');
const PACKAGE = 'org.wikipedia.dev.bridge_sample';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const terminal = state => ['completed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(state.status);
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

async function main(out, serial, scenarioPath) {
  assert(['b46093e6', 'FYZLAU49X8OVQGJ7'].includes(serial), 'An explicitly authorized OPPO serial is required');
  fs.mkdirSync(out);
  const manifestPath = scenarioPath ? path.resolve(scenarioPath)
    : path.join(__dirname, 'wikipedia-business.manifest.v1.json');
  const manifest = read(manifestPath);
  const target = { platform: 'android', serial, packageName: PACKAGE };
  const env = { AI_APP_BRIDGE_RUNTIME_HOME: path.join(out, 'runtime'),
    AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '1gb' };
  const offlineEnv = { AI_APP_BRIDGE_RUNTIME_HOME: path.join(out, 'offline-runtime'),
    AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'offline-facts'), ADB: '/unavailable/offline-adb' };
  const python = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim();
  const sources = { script: 'wikipedia-business.v1.js', databaseReader: 'read-reading-lists.py',
    preferencesReader: 'read-business-preferences.py' };
  const localSources = {};
  const sourceHashes = {};
  for (const [name, filename] of Object.entries(sources)) {
    const original = path.join(__dirname, filename);
    sourceHashes[name] = hash(original);
    assert.equal(sourceHashes[name], manifest.sourceHashes[name], 'Frozen source changed: ' + name);
    localSources[name] = path.join(out, filename);
    fs.copyFileSync(original, localSources[name], fs.constants.COPYFILE_EXCL);
  }
  const oracleFactorySource = path.join(__dirname, 'business-oracle.js');
  const oracleFactorySha256 = hash(oracleFactorySource);
  const oracleFactoryPath = path.join(out, 'business-oracle.js');
  fs.copyFileSync(oracleFactorySource, oracleFactoryPath, fs.constants.COPYFILE_EXCL);
  const { createBusinessOracle } = require(oracleFactoryPath);
  fs.copyFileSync(__filename, path.join(out, 'controller.js'), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(manifestPath, path.join(out, 'scenario.json'), fs.constants.COPYFILE_EXCL);
  write(path.join(out, 'runtime-env.json'), env);
  const inputs = { serial, outputDir: path.join(out, 'device'), listName: manifest.listName,
    cancelledListName: manifest.cancelledListName, listDescription: manifest.listDescription };
  const report = { schemaVersion: 'wikipedia-business-result/v1', target, inputs, sourceHashes,
    controllerSha256: hash(__filename), oracleFactorySha256, manifestSha256: hash(manifestPath), startedAtMs: Date.now(),
    scope: manifest.scope, status: 'preparing', businessVerdict: 'incomplete', events: [], oracles: [] };
  const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const adb = (args, options = {}) => execFileSync('adb', ['-s', serial, ...args],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 32 * 1024 * 1024, ...options });
  let sequence = 0, state;
  async function run(command, args, selectedEnv = env) {
    const response = await runCli(command, args, { cwd: ROOT, env: selectedEnv, timeoutMs: 90000 });
    write(path.join(out, `${String(++sequence).padStart(4, '0')}-${command}.json`), { command, args, ...response });
    assert.equal(response.value.ok, true, JSON.stringify(response.value));
    return response.value;
  }
  function collect(current) {
    let cursor = report.events.at(-1)?.sequence || 0;
    for (const event of current.events) {
      if (event.sequence <= cursor) { assert.deepEqual(event, report.events[event.sequence - 1]); continue; }
      assert.equal(event.sequence, cursor + 1, 'Missing Script progress event');
      report.events.push(event); cursor = event.sequence;
    }
    assert.equal(cursor, current.eventSequence, 'Incomplete Script progress');
    report.status = current.status;
    save();
  }
  const businessOracle = createBusinessOracle({ directory: out, serial, run, python,
    sources: { databaseReader: localSources.databaseReader, preferencesReader: localSources.preferencesReader },
    sourceSha256: sourceHashes.script, inputs, getOperationId: () => report.operationId });
  report.oracles = businessOracle.decisions;
  save();
  try {
    assert.equal(manifest.target.packageName, PACKAGE);
    assert.equal(adb(['get-state']).trim(), 'device');
    report.locale = adb(['shell', 'getprop', 'persist.sys.locale']).trim();
    assert.equal(report.locale, manifest.target.locale);
    const apkPaths = adb(['shell', 'pm', 'path', PACKAGE]).trim().split('\n');
    assert.equal(apkPaths.length, 1); assert(apkPaths[0].startsWith('package:/data/app/'));
    report.apkSha256 = adb(['shell', 'sha256sum', quote(apkPaths[0].slice(8))]).split(/\s/)[0];
    assert.equal(report.apkSha256, manifest.apkSha256, 'Installed Wikipedia APK differs from frozen business evidence');
    adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']); adb(['shell', 'wm', 'dismiss-keyguard']);
    report.runtime = await run('runtime', { operation: 'start' });
    report.executionStartedAtMs = Date.now();
    state = await run('script', { operation: 'start', recordingDir: path.join(out, 'recording'), script: {
      schemaVersion: 'aab.code-script/v1', language: 'javascript', sourcePath: localSources.script, target, inputs,
      permissions: ['app.read', 'app.interact', 'capture.read'], policy: { timeoutMs: 600000, restartPolicy: 'none' } } });
    report.operationId = state.operationId; collect(state);
    while (!terminal(state)) {
      assert(Date.now() - report.executionStartedAtMs < 630000, 'Controller deadline exceeded');
      if (state.status === 'waiting_for_agent') {
        const question = report.events.findLast(event => event.type === 'agent_question_created');
        const context = question.request.context;
        const decision = await businessOracle.answer(context);
        if (businessOracle.baseline !== undefined) report.baseline = businessOracle.baseline;
        save();
        state = await run('script', { operation: 'decide', operationId: report.operationId,
          requestId: question.requestId, revision: question.revision, decision, afterSequence: state.eventSequence, limit: 500 });
      } else {
        state = await run('script', { operation: 'wait', operationId: report.operationId,
          afterSequence: state.eventSequence, waitMs: 1000, limit: 500 });
      }
      collect(state);
    }
    report.executionWallMs = Date.now() - report.executionStartedAtMs;
    const resultEnvelope = state.status === 'completed' ? await run('script', { operation: 'result', operationId: report.operationId }) : null;
    if (resultEnvelope) { assert.equal(resultEnvelope.ok, true, JSON.stringify(resultEnvelope)); assert.equal(resultEnvelope.persisted, true); }
    report.result = resultEnvelope?.result;
    report.failure = report.events.findLast(event => event.type === 'script_failed');
    assert.equal(state.status, 'completed', JSON.stringify(report.failure));
    assert.equal(report.result.gate, 'passed');
    businessOracle.verifyComplete();
    for (const [name, original] of Object.entries(sources)) assert.equal(hash(path.join(__dirname, original)), sourceHashes[name]);
    assert.equal(hash(oracleFactorySource), oracleFactorySha256, 'Original oracle factory changed');
    assert.equal(hash(oracleFactoryPath), oracleFactorySha256, 'Copied oracle factory changed');
    assert(Array.isArray(report.result.artifacts) && report.result.artifacts.length > 0, 'Original Script screenshots required');
    for (const artifact of report.result.artifacts) assert.equal(hash(artifact.path), artifact.sha256, 'Original Script screenshot changed');
    assert(Number.isSafeInteger(report.result.coreElapsedMs) && report.result.coreElapsedMs >= 0);
    assert(report.result.coreElapsedMs <= manifest.timing.coreMaximumMs);
    assert(report.executionWallMs <= manifest.timing.acceptanceMaximumMs);
    report.businessVerdict = 'passed';
  } catch (error) {
    report.error = error.stack; report.businessVerdict = 'failed';
  } finally {
    try {
      if (report.operationId && state && !terminal(state)) {
        state = await run('script', { operation: 'cancel', operationId: report.operationId }); collect(state);
        while (!terminal(state)) {
          state = await run('script', { operation: 'wait', operationId: report.operationId,
            afterSequence: state.eventSequence, waitMs: 1000, limit: 500 }); collect(state);
        }
      }
      if (report.operationId) {
        report.executionWallMs = report.executionWallMs ?? Date.now() - report.executionStartedAtMs;
        report.failure = report.events.findLast(event => event.type === 'script_failed');
        report.archive = await run('evidence', { operation: 'export', namespace: 'script', operationId: report.operationId,
          outputDir: path.join(out, 'archive'), includeRecordedPayloads: true });
        const counts = { calls: 0, mobilePages: 0 };
        for (const attachment of report.archive.recordedPayloads.attachments) {
          if (!attachment.path.endsWith('.json')) continue;
          const document = read(path.join(report.archive.archiveDir, attachment.path));
          if (document.kind !== 'script-call') continue;
          const envelope = document.data.envelope;
          assert.equal(envelope.execution.executionId, report.operationId);
          assert.equal(envelope.execution.target.serial, serial); assert.equal(envelope.execution.target.packageName, PACKAGE);
          counts.calls++;
          if (envelope.evidence.capture) {
            assert.equal(envelope.evidence.capture.targetKey, PACKAGE); counts.mobilePages++;
          }
        }
        assert.equal(counts.calls, report.events.filter(event => event.type === 'call_started').length);
        report.targetAudit = counts;
      }
    } catch (error) { report.closeoutError = error.stack; report.businessVerdict = 'failed'; }
    finally {
      try {
        report.runtimeStop = await run('runtime', { operation: 'stop' });
        if (report.archive) {
          report.offlineVerification = await run('evidence', { operation: 'verify', archiveDir: report.archive.archiveDir,
            manifestSha256: report.archive.manifestSha256 }, offlineEnv);
          assert.equal(report.offlineVerification.integrity, 'verified');
        }
      } catch (error) { report.offlineError = error.stack; report.businessVerdict = 'failed'; }
      finally {
        report.offlineRuntimeStop = await run('runtime', { operation: 'stop' }, offlineEnv);
        report.totalWallMs = Date.now() - report.startedAtMs; save();
      }
    }
  }
  console.log(JSON.stringify({ reportPath: path.join(out, 'report.json'), status: report.status,
    businessVerdict: report.businessVerdict, executionWallMs: report.executionWallMs, error: report.error }));
  if (report.businessVerdict !== 'passed') process.exitCode = 1;
  return report;
}

if (require.main === module) {
  const [directory, serial, scenarioPath] = process.argv.slice(2);
  if (!directory || !serial) throw Error('Usage: run-business-script.js NEW_OUTPUT_DIR SERIAL [FROZEN_MANIFEST]');
  main(path.resolve(directory), serial, scenarioPath).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { main, inventory };
