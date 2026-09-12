#!/usr/bin/env node
'use strict';

// Compose existing business Scripts without changing their source or verdicts.
// One live runtime owns all cases; archive verification runs offline without it.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { runCli } = require('../../desktop/ai-app-bridge-cli/test-support/cli-client');
const { createNoPeerFixture } = require('./no-peer-fixture');

const ROOT = path.resolve(__dirname, '../..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const terminal = state => ['completed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(state.status);
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const settingsExpected = {
  'settings-dark': { 'flutter.ls_theme': 'dark', 'flutter.ls_color': 'system' },
  'settings-dark-english': { 'flutter.ls_theme': 'dark', 'flutter.ls_color': 'system', 'flutter.ls_locale': 'en' },
  'settings-restored': { 'flutter.ls_theme': 'system', 'flutter.ls_color': 'system' },
};

async function main(out, serial, selectedCase) {
  assert(['b46093e6', 'FYZLAU49X8OVQGJ7'].includes(serial), 'An explicitly authorized OPPO serial is required');
  fs.mkdirSync(out);
  const suitePath = path.join(__dirname, 'android-business-suite.v1.json');
  const suite = read(suitePath);
  if (selectedCase) assert(suite.cases.some(entry => entry.id === selectedCase), 'Unknown declared case');
  const selectedCases = selectedCase ? suite.cases.filter(entry => entry.id === selectedCase) : suite.cases;
  const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_RUNTIME_HOME: path.join(out, 'runtimes'),
    AI_APP_BRIDGE_FACT_CACHE_PROFILE: '1gb' };
  const offlineEnv = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'offline-facts'), AI_APP_BRIDGE_RUNTIME_HOME: path.join(out, 'offline-runtimes'),
    AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb', ADB: '/offline-no-adb' };
  const began = Date.now();
  const report = { schemaVersion: 'aab.android-business-suite-result/v1', startedAtMs: began, serial,
    suite, suiteSha256: hash(suitePath), controllerSha256: hash(__filename), cases: [],
    completeAcceptance: 'incomplete', selectedCases: selectedCases.map(entry => entry.id),
    notExecuted: [...suite.notExecuted, ...suite.cases.filter(entry => !selectedCases.includes(entry))
      .map(entry => ({ id: entry.id, status: 'not_selected', reason: 'Explicit focused rerun; earlier results are not current passes.' }))] };
  fs.copyFileSync(__filename, path.join(out, 'controller.js'));
  fs.copyFileSync(suitePath, path.join(out, 'suite.json'));
  fs.writeFileSync(path.join(out, 'runtime-env.json'), JSON.stringify(env, null, 2) + '\n');
  const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  let callSequence = 0;
  async function run(command, args, selectedEnv = env) {
    const response = await runCli(command, args, { cwd: ROOT, env: selectedEnv, timeoutMs: 90000 });
    write(path.join(out, `${String(++callSequence).padStart(4, '0')}-${command}.json`), { command, args, ...response });
    assert.equal(response.value.ok, true, JSON.stringify(response.value));
    return response.value;
  }
  const adb = args => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 30000 }).trim();
  const python = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim();
  function oracle(entry, name) {
    const file = path.join(entry.directory, name + '.json');
    if (entry.id === 'localsend') {
      execFileSync(python, [entry.oraclePath, '--serial', serial, '--out', file], { timeout: 30000 });
    } else {
      write(file, JSON.parse(execFileSync(python, [entry.oraclePath, serial], { encoding: 'utf8', timeout: 30000 })));
    }
    return read(file);
  }
  function requireRestored(entry, observed) {
    assert.equal(observed.serial, serial);
    assert.equal(observed.packageName, entry.target.packageName);
    if (entry.id === 'vlc') assert.equal(observed.preferences.values.app_theme.value, '-1');
    if (entry.id === 'organic-maps') {
      assert.deepEqual(observed.placemarks, []);
      assert.equal(observed.settings.Units, 'Metric');
      assert.equal(observed.settings.AutoDownloadEnabled, 'false');
    }
    if (entry.id === 'localsend') assert.deepEqual(observed.settings, settingsExpected['settings-restored']);
  }
  function collect(entry, state) {
    let cursor = entry.events.at(-1)?.sequence || 0;
    for (const event of state.events) {
      if (event.sequence <= cursor) {
        assert.deepEqual(event, entry.events[event.sequence - 1], 'Earlier progress event changed');
        continue;
      }
      assert.equal(event.sequence, cursor + 1, 'Missing Script progress event');
      entry.events.push(event); cursor = event.sequence;
    }
    assert.equal(cursor, state.eventSequence, 'Incomplete Script progress');
    const stage = state.rollingSummary.stage;
    if (stage && stage !== entry.stage) {
      entry.stage = stage;
      console.log(JSON.stringify({ app: entry.id, stage, status: state.status }));
    }
    save();
  }
  function auditArchive(entry) {
    const counts = { calls: 0, mobilePages: 0, assertions: { passed: 0, failed: 0, inconclusive: 0 } };
    const allowedPackages = new Set([entry.target.packageName, ...(entry.id === 'localsend' ? ['com.coloros.filemanager'] : [])]);
    for (const attachment of entry.archive.recordedPayloads.attachments) {
      if (!attachment.path.endsWith('.json')) continue;
      const document = read(path.join(entry.archive.archiveDir, attachment.path));
      if (document.kind !== 'script-call') continue;
      const call = document.data.envelope;
      assert.equal(call.execution.executionId, entry.operationId, 'Call belongs to another execution');
      assert.equal(call.execution.target.serial, serial, 'Call belongs to another device');
      assert(allowedPackages.has(call.execution.target.packageName), 'Call belongs to another app');
      counts.calls++;
      if (call.evidence.capture) {
        assert.equal(call.evidence.capture.targetKey, entry.target.packageName, 'Mobile evidence belongs to another app');
        counts.mobilePages++;
      }
    }
    for (const event of entry.events) {
      if (event.type.startsWith('assertion_')) counts.assertions[event.verdict]++;
    }
    assert.equal(counts.calls, entry.events.filter(event => event.type === 'call_started').length);
    assert.deepEqual(counts.assertions, entry.archive.recordedPayloads.counts.assertions);
    write(path.join(entry.directory, 'target-audit.json'), counts);
    return counts;
  }
  save();
  try {
    assert.equal(adb(['get-state']), 'device');
    report.locale = adb(['shell', 'getprop', 'persist.sys.locale']);
    assert.equal(report.locale, suite.deviceLocale);
    adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
    adb(['shell', 'wm', 'dismiss-keyguard']);
    report.runtime = await run('runtime', { operation: 'start' });
    for (const definition of selectedCases) {
      const entry = { id: definition.id, target: { platform: 'android', serial, packageName: definition.packageName },
        directory: path.join(out, definition.id), events: [], externalOracles: [], verdict: 'pending', startedAtMs: Date.now() };
      report.cases.push(entry); fs.mkdirSync(entry.directory); save();
      let state, noPeer, wikipediaOracle;
      try {
        const manifestPath = path.join(ROOT, definition.manifest), manifest = read(manifestPath);
        assert.equal(manifest.target.packageName, definition.packageName);
        const sourcePath = path.join(ROOT, definition.source);
        entry.sourceSha256 = hash(sourcePath);
        const expectedScriptHash = entry.id === 'wikipedia' ? manifest.sourceHashes.script
          : entry.id === 'localsend' ? manifest.source.sha256 : manifest.scriptSha256;
        assert.equal(entry.sourceSha256, expectedScriptHash);
        fs.copyFileSync(sourcePath, path.join(entry.directory, 'script.js'));
        assert.equal(hash(path.join(entry.directory, 'script.js')), expectedScriptHash);
        fs.copyFileSync(manifestPath, path.join(entry.directory, 'scenario-manifest.json'));
        if (entry.id === 'localsend') {
          const fixturePath = path.join(__dirname, 'no-peer-fixture.js');
          entry.networkFixtureSha256 = hash(fixturePath);
          assert.equal(entry.networkFixtureSha256, definition.networkFixtureSha256);
          fs.copyFileSync(fixturePath, path.join(entry.directory, 'no-peer-fixture.js'));
          noPeer = createNoPeerFixture({ serial, directory: entry.directory });
        }
        if (entry.id === 'wikipedia') {
          const sources = {};
          for (const key of ['databaseReader', 'preferencesReader']) {
            sources[key] = path.join(entry.directory, path.basename(definition[key]));
            fs.copyFileSync(path.join(ROOT, definition[key]), sources[key]);
            assert.equal(hash(sources[key]), manifest.sourceHashes[key]);
          }
          const factoryPath = path.join(entry.directory, 'business-oracle.js');
          fs.copyFileSync(path.join(ROOT, definition.oracleFactory), factoryPath);
          entry.oracleFactorySha256 = hash(factoryPath);
          assert.equal(entry.oracleFactorySha256, definition.oracleFactorySha256);
          entry.inputs = { serial, outputDir: path.join(entry.directory, 'device'), listName: manifest.listName,
            cancelledListName: manifest.cancelledListName, listDescription: manifest.listDescription };
          wikipediaOracle = require(factoryPath).createBusinessOracle({ directory: entry.directory, serial, run, python,
            sources, sourceSha256: entry.sourceSha256, inputs: entry.inputs, getOperationId: () => entry.operationId });
        } else {
          entry.oraclePath = path.join(entry.directory, 'oracle.py');
          fs.copyFileSync(path.join(ROOT, definition.oracle), entry.oraclePath);
          entry.oracleSha256 = hash(entry.oraclePath);
          assert.equal(entry.oracleSha256, entry.id === 'localsend' ? definition.oracleSha256 : manifest.oracleSha256);
        }
        const apkPaths = adb(['shell', 'pm', 'path', definition.packageName]).split('\n');
        assert.equal(apkPaths.length, 1); assert(apkPaths[0].startsWith('package:/data/app/'));
        entry.apkSha256 = adb(['shell', 'sha256sum', quote(apkPaths[0].slice(8))]).split(/\s/)[0];
        assert.equal(entry.apkSha256, definition.id === 'localsend' ? definition.apkSha256 : manifest.apkSha256);
        if (entry.id === 'vlc') {
          assert.deepEqual(read(path.join(ROOT, 'examples/vlc-sample/build/media/manifest.json')), manifest.media);
          entry.files = manifest.media.files.map(file => {
            const devicePath = manifest.media.phoneDirectory + '/' + file.name;
            const actual = adb(['shell', 'sha256sum', quote(devicePath)]).split(/\s/)[0];
            assert.equal(actual, file.sha256); return { devicePath, sha256: actual };
          });
          assert.equal(adb(['shell', 'ls', '-A', manifest.media.emptyDirectory]), '');
        }
        if (entry.id === 'organic-maps') {
          assert.equal(report.locale, manifest.target.locale);
          const folder = `/storage/emulated/0/Android/data/${definition.packageName}/files/${manifest.maps.dataVersion}`;
          assert.deepEqual(adb(['shell', 'ls', '-1', folder]).split('\n').sort(), manifest.maps.files.map(file => file.name).sort());
          entry.files = manifest.maps.files.map(file => {
            const actual = adb(['shell', 'sha256sum', quote(folder + '/' + file.name)]).split(/\s/)[0];
            assert.equal(actual, file.sha256); return { name: file.name, sha256: actual };
          });
        }
        if (entry.id !== 'wikipedia') {
          entry.before = oracle(entry, 'before'); requireRestored(entry, entry.before);
        }
        const runtime = await run('runtime', { operation: 'status' });
        assert.equal(runtime.runtimeId, report.runtime.runtimeId, 'Runtime changed between apps');
        assert.equal(runtime.pid, report.runtime.pid, 'Runtime process changed between apps');
        entry.runtimeId = runtime.runtimeId;
        if (entry.id !== 'wikipedia') await run('launch-app', { serial, packageName: definition.packageName,
          ...(definition.activity ? { activity: definition.activity } : {}) });
        const inputs = entry.id === 'wikipedia' ? entry.inputs : { serial, python, oraclePath: entry.oraclePath,
          ...(entry.id === 'organic-maps' ? { expectedRouteText: manifest.expectedRouteText } : {}),
          ...(entry.id === 'localsend' ? { outputDir: entry.directory, scenario: 'acceptance', expectedDeviceName: '好的椰子' } : {}) };
        entry.executionStartedAtMs = Date.now();
        state = await run('script', { operation: 'start', recordingDir: path.join(entry.directory, 'recording'), script: {
          schemaVersion: 'aab.code-script/v1', language: 'javascript', sourcePath: path.join(entry.directory, 'script.js'),
          target: entry.target, inputs, permissions: ['app.read', 'app.interact', 'capture.read'],
          policy: { timeoutMs: 660000, restartPolicy: 'none' } } });
        entry.operationId = state.operationId; collect(entry, state);
        while (!terminal(state)) {
          if (state.status === 'waiting_for_agent') {
            const question = entry.events.findLast(event => event.type === 'agent_question_created');
            const context = question.request.context;
            let decision;
            if (entry.id === 'wikipedia') {
              decision = await wikipediaOracle.answer(context);
            } else if (entry.id === 'localsend' && context.kind === 'localsend.settings-oracle/v1') {
              assert(Object.hasOwn(settingsExpected, context.checkpoint));
              assert.deepEqual(context.expectedSettings, settingsExpected[context.checkpoint]);
              const actual = oracle(entry, context.checkpoint);
              const verdict = isDeepStrictEqual(actual.settings, settingsExpected[context.checkpoint]) ? 'passed' : 'failed';
              const artifact = path.join(entry.directory, context.checkpoint + '.json');
              decision = { kind: 'localsend.settings-oracle-result/v1', checkpoint: context.checkpoint, verdict,
                artifact: { path: artifact, sha256: hash(artifact) }, observedSettings: actual.settings };
            } else {
              assert.equal(entry.id, 'localsend', 'Unexpected controller decision requested');
              assert.equal(context.kind, 'localsend.no-peer-fixture/v1', 'Unexpected LocalSend controller request');
              assert.equal(context.serial, serial);
              assert(['before-picker', 'final-send'].includes(context.checkpoint));
              assert(['isolate', 'verify', 'restore'].includes(context.phase));
              decision = await noPeer[context.phase](context.checkpoint);
            }
            entry.externalOracles.push(decision);
            state = await run('script', { operation: 'decide', operationId: entry.operationId, requestId: question.requestId,
              revision: question.revision, decision, afterSequence: state.eventSequence, limit: 500 });
          } else {
            state = await run('script', { operation: 'wait', operationId: entry.operationId,
              afterSequence: state.eventSequence, waitMs: 1000, limit: 500 });
          }
          collect(entry, state);
        }
        entry.executionWallMs = Date.now() - entry.executionStartedAtMs; entry.status = state.status;
        assert.equal(state.status, 'completed', JSON.stringify(entry.events.find(event => event.type === 'script_failed') || state.error));
        const resultEnvelope = await run('script', { operation: 'result', operationId: entry.operationId });
        assert.equal(resultEnvelope.ok, true, JSON.stringify(resultEnvelope)); assert.equal(resultEnvelope.persisted, true);
        entry.result = resultEnvelope.result;
        if (entry.id === 'wikipedia') {
          wikipediaOracle.verifyComplete();
          entry.before = wikipediaOracle.baseline;
          assert.equal(hash(sourcePath), entry.sourceSha256, 'Original Wikipedia Script changed');
          assert.equal(hash(path.join(entry.directory, 'script.js')), entry.sourceSha256, 'Copied Wikipedia Script changed');
          assert.equal(hash(path.join(ROOT, definition.oracleFactory)), entry.oracleFactorySha256, 'Original Wikipedia oracle changed');
          assert.equal(hash(path.join(entry.directory, 'business-oracle.js')), entry.oracleFactorySha256, 'Copied Wikipedia oracle changed');
          for (const artifact of entry.result.artifacts) assert.equal(hash(artifact.path), artifact.sha256);
          assert(entry.executionWallMs <= manifest.timing.acceptanceMaximumMs);
        } else {
          entry.after = oracle(entry, 'after'); requireRestored(entry, entry.after);
        }
        if (entry.id === 'localsend') {
          assert(['passed', 'failed', 'inconclusive'].includes(entry.result.businessVerdict));
          entry.scriptVerdict = entry.result.businessVerdict;
          entry.verdict = entry.scriptVerdict;
          entry.finalFixtureEqual = isDeepStrictEqual(entry.before.settings, entry.after.settings);
          // A deliberate incomplete result stays inconclusive. Returning from
          // main is execution completion, not business acceptance.
          if (entry.verdict === 'passed') {
            assert.equal(entry.result.flowCompleted, true);
            assert.equal(entry.result.uiVerdict, 'passed');
          }
        } else {
          assert.equal(entry.result.gate, 'passed');
          assert(entry.result.coreElapsedMs <= 300000 && entry.result.acceptanceElapsedMs <= 600000);
          entry.verdict = 'passed';
        }
      } catch (error) {
        entry.error = error.stack; entry.verdict = 'failed';
      } finally {
        try {
          if (entry.operationId && (!state || !terminal(state))) {
            state = await run('script', { operation: 'cancel', operationId: entry.operationId });
            collect(entry, state);
            while (!terminal(state)) {
              state = await run('script', { operation: 'wait', operationId: entry.operationId,
                afterSequence: state.eventSequence, waitMs: 1000, limit: 500 });
              collect(entry, state);
            }
          }
        } finally {
          if (noPeer) {
            try { entry.networkCleanup = await noPeer.cleanup(); }
            catch (error) { entry.networkCleanupError = error.stack; entry.verdict = 'failed'; }
          }
        }
        if (state) {
          entry.status = state.status;
          entry.executionWallMs ??= Date.now() - entry.executionStartedAtMs;
          entry.failure = entry.events.findLast(event => event.type === 'script_failed');
        }
        if (entry.operationId) {
          entry.archive = await run('evidence', { operation: 'export', namespace: 'script', operationId: entry.operationId,
            outputDir: path.join(entry.directory, 'archive'), includeRecordedPayloads: true });
          entry.targetAudit = auditArchive(entry);
        }
        entry.runtimeAfter = await run('runtime', { operation: 'status' });
        assert.equal(entry.runtimeAfter.runtimeId, report.runtime.runtimeId, 'Runtime changed during the App case');
        assert.equal(entry.runtimeAfter.pid, report.runtime.pid, 'Runtime process changed during the App case');
        assert.deepEqual(entry.runtimeAfter.identity, report.runtime.identity, 'Runtime identity changed during the App case');
        entry.wallMs = Date.now() - entry.startedAtMs; save();
      }
      console.log(JSON.stringify({ app: entry.id, verdict: entry.verdict, status: entry.status,
        executionWallMs: entry.executionWallMs, wallMs: entry.wallMs, error: entry.error }));
      if (entry.verdict === 'failed') {
        report.notExecuted.push(...selectedCases.slice(report.cases.length).map(item => ({ id: item.id,
          status: 'not_run_after_failure', reason: `The sequence stopped after ${entry.id}; later cases have no current result.` })));
        break;
      }
    }
    report.liveWallMs = Date.now() - began;
  } catch (error) { report.error = error.stack; }
  finally {
    report.runtimeStop = await run('runtime', { operation: 'stop' });
    save();
    try {
      for (const entry of report.cases.filter(entry => entry.archive)) {
        entry.offlineVerification = await run('evidence', { operation: 'verify', archiveDir: entry.archive.archiveDir,
          manifestSha256: entry.archive.manifestSha256 }, offlineEnv);
        assert.equal(entry.offlineVerification.integrity, 'verified');
        if (entry.id === 'localsend' && entry.result && !entry.error && !entry.networkCleanupError) {
          const manifest = read(path.join(entry.directory, 'scenario-manifest.json'));
          const phases = entry.externalOracles.filter(item => item.kind === 'localsend.no-peer-fixture-result/v1');
          const noPeerVerified = phases.length === 6 && ['before-picker', 'final-send'].every(checkpoint =>
            ['isolate', 'verify', 'restore'].every(phase => phases.filter(item => item.checkpoint === checkpoint
              && item.phase === phase && item.verdict === 'passed' && hash(item.artifact.path) === item.artifact.sha256).length === 1));
          const resolved = { 'controlled-no-peer-fixture': noPeerVerified,
            'final-independent-fixture-equality': entry.finalFixtureEqual };
          entry.finalAssessment = {
            scope: 'This fixed LocalSend navigation scenario only; original Script result is preserved.',
            resolvedExternalGates: manifest.requiredExternalGates.map(gate => ({ id: gate.id, resolved: resolved[gate.id] === true })),
            unresolvedScriptGates: entry.result.openGates.filter(gate => resolved[gate.id] !== true),
            timingPassed: entry.executionWallMs <= manifest.timing.wallGateMs,
            archiveVerified: true,
          };
          const requiredCaptureGates = manifest.requiredScriptGates.every(gate => gate.id === 'required-mobile-business-evidence');
          if (entry.result.flowCompleted && entry.result.uiVerdict === 'passed' && entry.result.stop === null
            && entry.result.assertions.length > 0 && entry.result.assertions.every(item => item.verdict === 'passed')
            && entry.result.externalOracles.every(item => item.verdict === 'passed') && requiredCaptureGates
            && entry.finalAssessment.resolvedExternalGates.every(gate => gate.resolved)
            && entry.finalAssessment.unresolvedScriptGates.length === 0 && entry.finalAssessment.timingPassed) entry.verdict = 'passed';
          entry.finalAssessment.verdict = entry.verdict;
        }
      }
    } catch (error) { report.offlineError = error.stack; }
    finally {
      report.offlineRuntimeStop = await run('runtime', { operation: 'stop' }, offlineEnv);
      report.totalWallMs = Date.now() - began;
      report.executedCasesPassed = report.cases.length === selectedCases.length && report.cases.every(entry => entry.verdict === 'passed')
        && !report.error && !report.offlineError;
      report.fixedFourAppAssessment = {
        scope: suite.scope,
        allFourExecuted: !selectedCase && isDeepStrictEqual(report.cases.map(entry => entry.id).sort(),
          ['localsend', 'organic-maps', 'vlc', 'wikipedia']),
        timingPassed: Number.isSafeInteger(report.liveWallMs) && report.liveWallMs <= suite.timing.maximumLiveWallMs,
      };
      report.fixedFourAppAssessment.verdict = report.executedCasesPassed && report.fixedFourAppAssessment.allFourExecuted
        && report.fixedFourAppAssessment.timingPassed ? 'passed' : 'incomplete';
      save();
    }
  }
  console.log(JSON.stringify({ report: path.join(out, 'report.json'), executedCasesPassed: report.executedCasesPassed,
    fixedFourAppAssessment: report.fixedFourAppAssessment, completeAcceptance: report.completeAcceptance,
    liveWallMs: report.liveWallMs, totalWallMs: report.totalWallMs }));
  const passed = selectedCase ? report.executedCasesPassed : report.fixedFourAppAssessment.verdict === 'passed';
  if (!passed) process.exitCode = 1;
  return report;
}

if (require.main === module) {
  const [out, serial, selectedCase] = process.argv.slice(2);
  if (!out || !serial) throw Error('Usage: run-android-suite.js NEW_OUTPUT_DIR AUTHORIZED_OPPO_SERIAL [CASE_ID]');
  main(path.resolve(out), serial, selectedCase).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { main };
