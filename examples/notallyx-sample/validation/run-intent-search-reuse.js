#!/usr/bin/env node
'use strict';

// Explicit controller for the frozen NotallyX search evidence-reuse experiment.
// Loading this file performs no device or process operations.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createMcpClient, payloadOf } = require('../../../desktop/ai-app-bridge-cli/scripts/validation/mcp-jsonrpc-client');
const { captureFixture, verifyFixture } = require('./fixed-fixture');
const { collectSnapshot, PACKAGE } = require('./collector');
const { readSnapshot, compareCanonical } = require('./oracles');
const { screen, verifyForegroundXml, readOutputEnvelopes, evaluateTrial } = require('./intent-search-oracles');
const { reviewDurable, directoryHashes } = require('./review-search-durable');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const terminal = state => ['completed', 'failed', 'cancelled'].includes(state.status);

function optionsOf(argv) {
  const required = ['server', 'serial', 'apk', 'fixture', 'source', 'bundle', 'out'];
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].slice(2);
    assert(argv[i].startsWith('--') && required.includes(key) && argv[i + 1] && !Object.hasOwn(result, key), 'explicit_unique_arguments_required');
    result[key] = argv[i + 1];
  }
  required.forEach(key => assert(result[key], 'missing_argument:' + key));
  return result;
}

function verifyBundle(directory) {
  const manifest = read(path.join(directory, 'manifest.json'));
  assert.equal(manifest.fileCount, manifest.files.length);
  for (const item of manifest.files) {
    const file = path.resolve(directory, item.path);
    assert(file.startsWith(directory + path.sep), 'bundle_path_outside_root');
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.length, item.bytes); assert.equal(sha(bytes), item.sha256, item.path);
  }
  return sha(fs.readFileSync(path.join(directory, 'manifest.json')));
}

async function main(options) {
  const out = path.resolve(options.out), bundle = path.resolve(options.bundle);
  const bundleSha256 = verifyBundle(bundle), fixtureSummary = read(path.join(bundle, 'fixture-summary.json'));
  const target = { serial: options.serial, packageName: PACKAGE };
  assert.deepEqual(fixtureSummary.target, target);
  const apkSha256 = sha(fs.readFileSync(options.apk)); assert.equal(apkSha256, fixtureSummary.apkSha256);
  const baseline = verifyFixture(path.resolve(options.fixture), target, apkSha256);
  const source = fs.readFileSync(options.source, 'utf8'), sourceSha256 = sha(source);
  const baseInputs = read(path.join(bundle, 'inputs.json'));
  fs.mkdirSync(out, { recursive: false });
  const frozenSource = path.join(out, 'search-regression.js'); fs.writeFileSync(frozenSource, source);
  const controllerSource = path.join(out, 'controller-source'); fs.mkdirSync(controllerSource);
  for (const file of [__filename, ...['intent-search-oracles.js', 'review-search-durable.js', 'fixed-fixture.js', 'collector.js', 'oracles.js', 'read_snapshot.py'].map(name => path.join(__dirname, name))]) {
    fs.copyFileSync(file, path.join(controllerSource, path.basename(file)));
  }
  const report = { ok: false, target, server: fs.realpathSync(options.server), apkSha256, bundleSha256, sourceSha256,
    fixtureSha256: baseline.fixtureSha256, node: process.version, startedAtMs: Date.now(), trials: [] };
  report.runtimeFiles = directoryHashes(path.dirname(report.server));
  const save = () => write(path.join(out, 'report.json'), report);
  save();
  const client = createMcpClient({ serverPath: report.server, transcriptPath: path.join(out, 'mcp.jsonl'),
    stderrPath: path.join(out, 'mcp-stderr.log'), env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'host-facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' } });
  const run = async (command, args) => payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
  let activeId = null;
  try {
    await client.initialize();
    for (const [name, kind] of [['positive-1', 'positive'], ['positive-2', 'positive'], ['positive-3', 'positive'], ['wrong-expectation', 'wrong-expectation'], ['cancel', 'cancel']]) {
      assert.equal(sha(fs.readFileSync(options.source)), sourceSha256, 'author_source_changed_after_freeze');
      assert.equal(sha(fs.readFileSync(frozenSource)), sourceSha256, 'execution_source_changed');
      const directory = path.join(out, name); fs.mkdirSync(directory);
      const scriptOut = path.join(directory, 'script-output'); fs.mkdirSync(scriptOut);
      const trial = { name, kind, startedAtMs: Date.now(), verdict: 'pending' }; report.trials.push(trial); save();
      console.log(JSON.stringify({ trial: name, stage: 'verify-fixed-initial-state' }));
      const pre = captureFixture({ serial: target.serial, apk: options.apk, out: path.join(directory, 'before'), assignmentLabel: baseline.fixture.assignmentLabel });
      const current = verifyFixture(pre.fixtureFile, target, apkSha256);
      trial.before = compareCanonical(baseline.snapshot, current.snapshot, { id: name + '-initial-fixture', ignoreFields: [] });
      write(path.join(directory, 'initial-data-oracle.json'), trial.before); assert.equal(trial.before.ok, true, 'initial_fixture_changed');
      const launch = await run('launch-app', target); write(path.join(directory, 'launch.json'), launch); assert.equal(launch.ok, true);
      const readyDeadline = Date.now() + 30000;
      let initial, probe = 0;
      do {
        initial = await run('tree', { ...target, compact: false });
        write(path.join(directory, 'initial-tree-' + (++probe) + '.json'), initial);
        if (initial.ok && initial.activity === 'com.philkes.notallyx.presentation.activity.main.MainActivity'
          && initial.windows?.length === 1 && initial.windows[0].type === 'activity' && screen(initial).home) break;
        assert(Date.now() < readyDeadline, 'home_precondition_timeout');
        await new Promise(resolve => setTimeout(resolve, 150));
      } while (true);
      // UIA is XML on the public MCP surface. The SDK tree alone can miss system overlays.
      const foregroundResponse = await client.request('tools/call', { name: 'run', arguments: { command: 'uia-tree', arguments: { serial: target.serial } } });
      write(path.join(directory, 'initial-uia-response.json'), foregroundResponse);
      assert.notEqual(foregroundResponse.result?.isError, true, 'uia_read_failed');
      const xml = foregroundResponse.result?.content?.find(item => item.type === 'text')?.text;
      trial.foreground = verifyForegroundXml(xml);
      fs.writeFileSync(path.join(directory, 'initial-uia.xml'), xml);
      const keyboard = await run('keyboard-state', { serial: target.serial });
      write(path.join(directory, 'initial-keyboard.json'), keyboard); assert.equal(keyboard.ok, true); assert.equal(keyboard.visible, false, 'initial_keyboard_visible');
      const status = await run('status', target); write(path.join(directory, 'initial-status.json'), status);
      assert.equal(status.ok, true); assert.equal(status.app.packageName, PACKAGE); assert.equal(status._feedback.target.serial, target.serial);
      const inputs = structuredClone(baseInputs); inputs.out = scriptOut; inputs.cancelAfterTitle = kind === 'cancel';
      if (kind === 'wrong-expectation') inputs.expected.title.titles = ['AAB-INTENTIONALLY-WRONG-EXPECTED-TITLE'];
      const spec = { schemaVersion: 'aab.code-script/v1', name, language: 'javascript', sourcePath: frozenSource, target, inputs,
        permissions: ['app.read', 'app.interact'], policy: { timeoutMs: 180000, restartPolicy: 'none' } };
      write(path.join(directory, 'spec.json'), spec);
      const events = []; let cursor = 0, page = 0;
      const collect = state => {
        write(path.join(directory, 'execution-' + String(++page).padStart(4, '0') + '.json'), state);
        assert.equal(state.ok, true, JSON.stringify(state));
        for (const event of state.events) {
          if (event.sequence <= cursor) { assert.deepEqual(events[event.sequence - 1], event, 'event_changed'); continue; }
          assert.equal(event.sequence, cursor + 1, 'execution_event_gap'); events.push(event); cursor = event.sequence;
          if (event.type === 'progress' || event.type === 'assertion_failed' || event.type === 'assertion_inconclusive') console.log(JSON.stringify({ trial: name, event }));
        }
        write(path.join(directory, 'events.json'), events);
      };
      trial.executionStartedAtMs = Date.now();
      let state = await run('script', { operation: 'start', script: spec });
      activeId = state.operationId; trial.operationId = activeId; trial.scriptHash = state.hash; collect(state); save();
      const deadline = Date.now() + 200000;
      while (!terminal(state)) {
        assert(Date.now() < deadline, 'execution_deadline');
        if (state.status === 'waiting_for_agent') {
          assert.equal(kind, 'cancel', 'unexpected_agent_intervention');
          assert(events.some(e => e.type === 'agent_question_created' && e.request.question === 'intent-reuse cancellation checkpoint'));
          trial.cancelRequestedAtMs = Date.now();
          state = await run('script', { operation: 'cancel', operationId: activeId, afterSequence: cursor, limit: 500 });
        } else state = await run('script', { operation: 'wait', operationId: activeId, afterSequence: cursor, waitMs: 1000, limit: 500 });
        collect(state);
      }
      // Read once more after durable terminal commit to retain its final event/summary.
      state = await run('script', { operation: 'status', operationId: activeId, afterSequence: cursor, limit: 500 }); collect(state);
      trial.executionFinishedAtMs = Date.now(); trial.executionMs = trial.executionFinishedAtMs - trial.executionStartedAtMs;
      trial.executionStatus = state.status; activeId = null;
      // Freeze the public archive receipt while this Host still owns FactStore.
      // Offline review must use this returned root hash, never a hash reconstructed later.
      trial.archive = await run('evidence', { operation: 'export', namespace: 'script', operationId: trial.operationId,
        outputDir: path.join(directory, 'durable-archive') });
      write(path.join(directory, 'archive-export.json'), trial.archive); save();
      assert.equal(trial.archive.ok, true, 'public_evidence_export_failed:' + JSON.stringify(trial.archive));
      assert.equal(trial.archive.namespace, 'script'); assert.equal(trial.archive.operationId, trial.operationId);
      assert.match(trial.archive.manifestSha256, /^[a-f0-9]{64}$/);
      const manifest = collectSnapshot({ ...target, out: path.join(directory, 'after'), runId: trial.operationId, sequence: cursor, apkSha256 });
      const after = readSnapshot(manifest, { expectedTarget: target, expectedApkSha256: apkSha256, runId: trial.operationId,
        afterSequence: cursor, minCapturedAtMs: trial.executionFinishedAtMs });
      trial.data = compareCanonical(baseline.snapshot, after, { id: name + '-preserves-fixture', ignoreFields: [] });
      write(path.join(directory, 'final-data-oracle.json'), trial.data); assert.equal(trial.data.ok, true, 'business_data_changed');
      const evidence = readOutputEnvelopes(scriptOut, trial.operationId, events);
      write(path.join(directory, 'artifacts.json'), evidence.artifacts);
      trial.ui = evaluateTrial({ kind, status: state.status, evidence, expected: baseInputs.expected,
        baselineTitles: fixtureSummary.notes.filter(note => note.folder === 'NOTES').map(note => note.title), events });
      write(path.join(directory, 'independent-ui-oracle.json'), trial.ui);
      trial.verdict = trial.ui.verdict; trial.finishedAtMs = Date.now(); save();
      assert.equal(trial.verdict, 'passed');
      console.log(JSON.stringify({ trial: name, verdict: trial.verdict, executionStatus: trial.executionStatus, executionMs: trial.executionMs, assertions: trial.ui.assertions }));
    }
    report.trialsComplete = true;
  } catch (error) {
    report.error = error.stack || String(error);
    if (report.trials.length) report.trials.at(-1).verdict = 'failed';
    throw error;
  } finally {
    if (activeId) {
      try { write(path.join(out, 'cleanup-cancel.json'), await run('script', { operation: 'cancel', operationId: activeId })); }
      catch (error) { report.cleanupError = error.message; }
    }
    write(path.join(out, 'host-exit.json'), await client.close());
    report.finishedAtMs = Date.now(); save();
  }
  try {
    report.durable = await reviewDurable(out, report);
    assert.deepEqual(directoryHashes(path.dirname(report.server)), report.runtimeFiles, 'runtime_files_changed_during_trials');
    report.ok = true;
  } catch (error) { report.error = error.stack || String(error); throw error; }
  finally { report.finishedAtMs = Date.now(); save(); }
  return report;
}

if (require.main === module) main(optionsOf(process.argv.slice(2))).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main, optionsOf, verifyBundle };
