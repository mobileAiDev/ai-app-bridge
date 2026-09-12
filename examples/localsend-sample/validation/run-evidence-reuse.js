#!/usr/bin/env node
'use strict';

// The controller owns device fixtures and independent preference reads. The
// separately authored Script owns every measured UI action and assertion.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createMcpClient, payloadOf } = require('../../../desktop/ai-app-bridge-cli/scripts/validation/mcp-jsonrpc-client');
const { timingsFromScriptEvents } = require('../../../desktop/ai-app-bridge-cli/bin/script/p9-timings');

const ROOT = path.resolve(__dirname, '../../..');
const SAMPLE = path.dirname(__dirname);
const PACKAGE = 'org.localsend.localsend_app.bridge_sample';
const SERIAL = process.env.AAB_VALIDATION_SERIAL || 'FYZLAU49X8OVQGJ7';
const FROZEN = path.join(ROOT, 'build/ai_app_bridge_artifacts/localsend-evidence-2026-09-08');
const BASELINE = process.env.AAB_VALIDATION_BASELINE || path.join(FROZEN, 'settings-fixture-baseline.json');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hash = file => sha(fs.readFileSync(file));
const terminal = state => ['completed', 'failed', 'cancelled'].includes(state.status);
const expectedSettings = {
  'settings-dark': { 'flutter.ls_theme': 'dark', 'flutter.ls_color': 'system' },
  'settings-dark-english': { 'flutter.ls_theme': 'dark', 'flutter.ls_color': 'system', 'flutter.ls_locale': 'en' },
  'settings-restored': { 'flutter.ls_theme': 'system', 'flutter.ls_color': 'system' },
};

function directoryHashes(directory) {
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else { assert(entry.isFile()); files.push({ path: path.relative(directory, file), sha256: hash(file) }); }
    }
  }
  walk(directory);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function settings(file) {
  execFileSync('python3', [path.join(SAMPLE, 'settings-oracle.py'), '--serial', SERIAL, '--out', file], { stdio: 'pipe' });
  const result = read(file);
  assert.equal(result.serial, SERIAL); assert.equal(result.packageName, PACKAGE);
  return result;
}

function installedApk(file, expectedSha256) {
  const paths = execFileSync('adb', ['-s', SERIAL, 'shell', 'pm', 'path', PACKAGE], { encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.equal(paths.length, 1, 'single_frozen_apk_required');
  assert(paths[0].startsWith('package:/data/app/') && paths[0].endsWith('/base.apk'), 'unexpected_installed_apk_path');
  const devicePath = paths[0].slice('package:'.length);
  const digest = execFileSync('adb', ['-s', SERIAL, 'shell', 'sha256sum', devicePath], { encoding: 'utf8' }).trim().split(/\s+/)[0];
  write(file, { serial: SERIAL, packageName: PACKAGE, devicePath, sha256: digest, capturedAt: new Date().toISOString() });
  assert.equal(digest, expectedSha256, 'installed_apk_changed');
}

function archiveReview(trial, directory, events) {
  const archive = trial.archive;
  const documents = archive.recordedPayloads.attachments.map(item => read(path.join(archive.archiveDir, item.path)));
  const calls = documents.filter(doc => doc.kind === 'script-call').map(doc => doc.data.envelope);
  const assertions = documents.filter(doc => doc.kind === 'script-assertion').map(doc => doc.data);
  const counts = { passed: 0, failed: 0, inconclusive: 0 };
  const assertionEvents = events.filter(event => /^assertion_(passed|failed|inconclusive)$/.test(event.type));
  for (const event of assertionEvents) counts[event.type.slice('assertion_'.length)] += 1;
  const uiAssertions = assertionEvents.filter(event => event.requiredEvidence.every(kind => ['tree', 'screenshot'].includes(kind)));
  const mobileAssertions = assertionEvents.filter(event => !uiAssertions.includes(event));
  if (trial.kind === 'positive') {
    const executionFailure = events.findLast(event => event.type === 'script_failed');
    assert.equal(executionFailure, undefined, 'positive_script_failed:' + executionFailure?.error);
    const rejected = uiAssertions.filter(event => event.type !== 'assertion_passed');
    assert.equal(rejected.length, 0, 'positive_ui_assertions_not_passed:' + JSON.stringify(rejected.map(event => ({ name: event.name, verdict: event.verdict }))));
  }
  assert.deepEqual(archive.recordedPayloads.counts.assertions, counts, 'archived_assertion_count_mismatch');
  assert.equal(calls.length, archive.recordedPayloads.counts.scriptCalls, 'archived_call_count_mismatch');
  assert.equal(assertions.length, assertionEvents.length, 'recorded_assertions_missing');
  assert.equal(calls.length, events.filter(event => event.type === 'call_started').length, 'call_events_mismatch');
  assert(calls.length > 0, 'script_calls_missing');
  const failures = calls.filter(call => !call.ok || call.error || call.ambiguous);
  const mobileCommands = ['events', 'logs', 'state', 'network'];
  const pickerReadRecoveries = [];
  const changingPickerReads = failures.filter(call => call.command === 'uia-tree'
    && call.error === 'uia_tree_changed' && call.dispatched === false
    && call.ambiguous === false && call.execution.actionId === null);
  for (const failed of changingPickerReads) {
    const failure = events.find(event => event.type === 'call_failed' && event.callId === failed.execution.callId);
    const notice = events.find(event => event.type === 'progress' && event.stage === 'picker-tree-reobserve'
      && event.callId === failed.execution.callId && event.observationId === failed.evidence.observationId);
    assert(failure && notice && notice.sequence > failure.sequence, 'unrecorded_picker_reobservation');
    const accepted = events.find(event => event.sequence > notice.sequence && event.type === 'assertion_passed'
      && event.name === 'Actual OPPO picker has Cancel and disabled Add(0)');
    assert(accepted && accepted.atMs - failure.atMs <= 10000, 'picker_reobservation_not_completed_within_budget');
    const following = calls.slice(calls.indexOf(failed) + 1);
    const index = following.findIndex(call => call.evidence.observationId === accepted.observationId);
    assert(index >= 0, 'picker_reobservation_payload_missing');
    assert(following.slice(0, index + 1).every(call => call.command === 'uia-tree' && call.execution.actionId === null), 'action_before_picker_reobservation');
    const recovered = following[index];
    assert(recovered.ok && recovered.result.source === 'uiautomator' && recovered.result.truncated === false, 'picker_reobservation_incomplete');
    pickerReadRecoveries.push({ callId: failed.execution.callId, error: failed.error,
      observationId: failed.evidence.observationId, recoveredObservationId: accepted.observationId,
      elapsedMs: accepted.atMs - failure.atMs, failedReadRetained: true });
  }
  const uiFailures = failures.filter(call => !mobileCommands.includes(call.command) && !changingPickerReads.includes(call));
  assert.equal(uiFailures.length, 0, 'ui_call_failed:' + JSON.stringify(uiFailures.map(call => ({ command: call.command, error: call.error }))));
  const mutations = calls.filter(call => call.execution.actionId);
  assert(mutations.every(call => call.execution.executionId === trial.operationId), 'action_operation_mismatch');
  const facts = read(path.join(archive.archiveDir, 'records.json'));
  const receipts = facts.map(fact => fact.payload).filter(record => record.kind === 'action-receipt');
  assert.equal(receipts.length, mutations.length, 'action_receipts_missing');
  assert(receipts.every(receipt => receipt.dispatched && !receipt.ambiguous && receipt.mechanicalStatus === 'ok'), 'invalid_action_receipt');
  const byObservation = new Map(calls.filter(call => call.evidence.observationId)
    .map(call => [call.evidence.observationId, call]));
  const nodesAt = name => {
    const matches = assertionEvents.filter(event => event.name === name);
    assert.equal(matches.length, 1, 'unique_key_page_assertion_required:' + name);
    const call = byObservation.get(matches[0].observationId);
    assert.equal(call?.command, 'flutter-nodes', 'key_page_source_mismatch:' + name);
    assert.equal(call.result.truncated, false);
    return call.result.nodes;
  };
  const textAt = name => nodesAt(name).filter(node => node.widgetType === 'Text').map(node => node.text);
  const initial = textAt('initial-receive');
  assert(initial.includes('通过链接接收') && initial.includes('好的椰子'), 'independent_initial_receive_mismatch');
  const keyPages = { initialReceive: 'passed' };
  if (trial.kind === 'positive') {
    const final = textAt('final-receive');
    assert(final.includes('通过链接接收') && final.includes('好的椰子'), 'independent_final_receive_mismatch');
    const license = textAt('framework-license-body');
    for (const text of ['_fe_analyzer_shared', '1 份许可', 'Copyright 2019, the Dart project authors.',
      'Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:']) {
      assert(license.includes(text), 'independent_license_body_mismatch');
    }
    const before = nodesAt('settings-top-baseline');
    const after = nodesAt('restore-settings-scroll-top: destination visible');
    for (const title of ['设置', '主题', '颜色', '语言']) {
      const a = before.filter(node => node.widgetType === 'Text' && node.text === title);
      const b = after.filter(node => node.widgetType === 'Text' && node.text === title);
      assert.equal(a.length, 1); assert.equal(b.length, 1);
      for (const key of ['left', 'top', 'right', 'bottom'])
        assert(Math.abs(a[0].bounds[key] - b[0].bounds[key]) < 0.5, 'settings_scroll_geometry_not_restored:' + title);
    }
    Object.assign(keyPages, { finalReceive: 'passed', licenseBody: 'passed', settingsScrollGeometryRestored: 'passed' });
  }
  let stableSnapshotPairs = 0;
  if (trial.kind === 'positive') {
    const pairs = trial.result.stableObservations;
    assert(Array.isArray(pairs) && pairs.length > 0, 'sdk_stability_pairs_missing');
    const geometry = nodes => nodes.filter(node => node.widgetType !== 'RichText').map(node => {
      const edges = bounds => bounds && ['left', 'top', 'right', 'bottom'].map(key => bounds[key]);
      return [node.widgetType, node.text, edges(node.bounds), edges(node.tap?.bounds), edges(node.scroll?.bounds)];
    });
    for (const pair of pairs) {
      const first = byObservation.get(pair.firstObservationId), next = byObservation.get(pair.observationId);
      assert.equal(first?.command, 'flutter-nodes'); assert.equal(next?.command, 'flutter-nodes');
      assert.equal(first.result.updatedAtMs, pair.firstUpdatedAtMs);
      assert.equal(next.result.updatedAtMs, pair.updatedAtMs);
      assert(pair.updatedAtMs > pair.firstUpdatedAtMs, 'same_sdk_generation_claimed_stable');
      assert.deepEqual(first.result.viewport, next.result.viewport);
      assert.deepEqual(geometry(first.result.nodes), geometry(next.result.nodes), 'sdk_geometry_changed_between_generations');
      assert.deepEqual(first.evidence.refs, pair.firstEvidenceRefs); assert.deepEqual(next.evidence.refs, pair.evidenceRefs);
    }
    assert.equal(trial.result.actions.length, mutations.length, 'declared_actions_missing');
    for (const action of trial.result.actions.filter(action => action.command === 'tap' && action.selected.widgetType)) {
      assert(pairs.some(pair => pair.observationId === action.sourceObservationId), 'tap_without_stable_sdk_generation');
      const call = byObservation.get(action.sourceObservationId), view = call.result.viewport;
      const node = call.result.nodes.find(node => node.id === action.selected.nodeId);
      assert(node, 'tap_source_node_missing');
      assert.deepEqual(node.tap.bounds, action.selected.logicalBounds);
      for (const bounds of [node.bounds, node.tap.bounds])
        assert(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= view.logicalWidth && bounds.bottom <= view.logicalHeight,
          'tap_target_clipped_by_viewport');
    }
    stableSnapshotPairs = pairs.length;
  }
  const data = { counts, calls: calls.length, actions: mutations.length, mechanicalFailures: failures.length,
    keyPages, stableSnapshotPairs, pickerReadRecoveries,
    captureReadFailures: failures.filter(call => mobileCommands.includes(call.command))
      .map(call => ({ callId: call.execution.callId, command: call.command, error: call.error, coverage: call.evidence.coverage })),
    ui: { passed: uiAssertions.filter(event => event.verdict === 'passed').length,
      failed: uiAssertions.filter(event => event.verdict === 'failed').length,
      inconclusive: uiAssertions.filter(event => event.verdict === 'inconclusive').length },
    mobile: mobileAssertions.map(event => ({ name: event.name, verdict: event.verdict, reason: event.reason })),
    assertionNames: assertionEvents.map(event => ({ name: event.name, verdict: event.type.slice('assertion_'.length), observationId: event.observationId })),
    recordedCounts: archive.recordedPayloads.counts };
  write(path.join(directory, 'independent-archive-review.json'), data);
  return data;
}

async function verifyOffline(report, out) {
  const directory = path.join(out, 'offline-verification'); fs.mkdirSync(directory);
  const store = path.join(directory, 'fact-store-is-a-file'); fs.writeFileSync(store, 'Archive verification cannot open the live Host store.\n');
  const client = createMcpClient({ serverPath: report.server, transcriptPath: path.join(directory, 'mcp.jsonl'),
    stderrPath: path.join(directory, 'stderr.log'), env: { ADB: path.join(directory, 'adb-unavailable'), AI_APP_BRIDGE_FACT_STORE_DIR: store } });
  const checked = [];
  try {
    await client.initialize();
    for (const trial of report.trials.filter(item => item.archive?.ok)) {
      const copy = path.join(directory, trial.name); fs.cpSync(trial.archive.archiveDir, copy, { recursive: true, errorOnExist: true });
      const result = payloadOf(await client.request('tools/call', { name: 'run', arguments: { command: 'evidence', arguments: {
        operation: 'verify', archiveDir: copy, manifestSha256: trial.archive.manifestSha256,
      } } }));
      write(path.join(directory, trial.name + '.json'), result);
      assert.equal(result.ok, true, 'offline_archive_invalid:' + JSON.stringify(result));
      assert.equal(result.integrity, 'verified');
      assert.equal(hash(path.join(copy, 'manifest.json')), trial.archive.manifestSha256);
      assert.deepEqual(directoryHashes(copy), directoryHashes(trial.archive.archiveDir), 'copied_archive_changed');
      checked.push({ trial: trial.name, manifestSha256: trial.archive.manifestSha256, recordCount: result.recordCount, counts: result.recordedPayloads.counts });
    }
  } finally { write(path.join(directory, 'host-exit.json'), await client.close()); }
  const result = { ok: true, method: 'copied archives; new public MCP; unavailable ADB and Host FactStore', checked };
  write(path.join(directory, 'summary.json'), result); return result;
}

async function main({ out, mode, apkSha256 }) {
  assert(['pilot', 'pilot-core', 'matrix'].includes(mode), 'mode_must_be_pilot_pilot-core_or_matrix');
  assert(/^[a-f0-9]{64}$/.test(apkSha256), 'explicit_frozen_apk_sha256_required');
  out = path.resolve(out); fs.mkdirSync(out, { recursive: false });
  const sourceFile = path.join(SAMPLE, 'scripts/localsend-flow.v1.js');
  const frozenSource = path.join(out, 'localsend-flow.v1.js'); fs.copyFileSync(sourceFile, frozenSource);
  const sourceSha256 = hash(frozenSource);
  const server = path.join(ROOT, 'desktop/ai-app-bridge-cli/bin/mcp-server.js');
  const baseline = read(BASELINE); assert.equal(baseline.serial, SERIAL); assert.equal(baseline.packageName, PACKAGE);
  const report = { schemaVersion: 'localsend.reuse-validation/v1', ok: false, mode, target: { serial: SERIAL, packageName: PACKAGE },
    server, sourceSha256, apkSha256, startedAt: new Date().toISOString(), trials: [], runtimeFiles: directoryHashes(path.dirname(server)),
    openGates: ['Controlled peer/network fixture', 'Flutter action-linked mobile semantic evidence', 'In-flight device-action cancellation', 'File transfer and full-app coverage'] };
  fs.copyFileSync(__filename, path.join(out, 'controller.js'));
  fs.copyFileSync(path.join(SAMPLE, 'settings-oracle.py'), path.join(out, 'settings-oracle.py'));
  fs.cpSync(path.join(SAMPLE, 'scripts'), path.join(out, 'authored-bundle'), { recursive: true });
  report.authoredBundleFiles = directoryHashes(path.join(out, 'authored-bundle'));
  if (mode === 'matrix') {
    for (const scenario of ['core', 'acceptance']) {
      const manifest = read(path.join(out, 'authored-bundle', scenario + '.scenario.v1.json'));
      assert.equal(manifest.source.sha256, sourceSha256, 'scenario_source_not_frozen');
      assert.equal(manifest.scenarioInput, scenario);
      assert.equal(hash(path.join(ROOT, manifest.frozenEvidence.handoff)), manifest.frozenEvidence.handoffSha256);
      assert.equal(hash(path.join(ROOT, manifest.frozenEvidence.additional)), manifest.frozenEvidence.additionalSha256);
      const targetContract = path.join(ROOT, manifest.frozenEvidence.targetContract);
      assert.equal(hash(targetContract), manifest.frozenEvidence.targetContractSha256);
      const currentEvidence = read(targetContract);
      assert.equal(currentEvidence.schemaVersion, 'localsend.current-target-evidence/v1');
      assert.equal(currentEvidence.ok, true);
      for (const item of currentEvidence.files) {
        const file = path.resolve(ROOT, item.path);
        assert(file.startsWith(ROOT + path.sep), 'target_contract_evidence_outside_root');
        assert.equal(fs.statSync(file).size, item.bytes); assert.equal(hash(file), item.sha256);
      }
    }
  }
  const authoringContract = path.join(ROOT, 'desktop/ai-app-bridge-cli/docs/SCRIPT_AUTHORING.md');
  fs.copyFileSync(authoringContract, path.join(out, 'SCRIPT_AUTHORING.md'));
  report.authoringContractSha256 = hash(authoringContract);
  write(path.join(out, 'baseline.json'), baseline);
  const save = () => write(path.join(out, 'report.json'), report); save();
  const client = createMcpClient({ serverPath: server, transcriptPath: path.join(out, 'mcp.jsonl'), stderrPath: path.join(out, 'mcp-stderr.log'),
    env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'host-facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' } });
  const run = async (command, args) => payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
  let activeId = null;
  try {
    await client.initialize();
    const trials = mode === 'pilot' ? [['pilot-acceptance', 'positive', 'acceptance']]
      : mode === 'pilot-core' ? [['pilot-core', 'positive', 'core']] : [
      ['core-1', 'positive', 'core'],
      ['positive-1', 'positive', 'acceptance'], ['positive-2', 'positive', 'acceptance'], ['positive-3', 'positive', 'acceptance'],
      ['wrong-expectation', 'wrong-expectation', 'acceptance'], ['cancel', 'cancel', 'acceptance'],
    ];
    for (const [name, kind, scenario] of trials) {
      assert.equal(hash(sourceFile), sourceSha256, 'author_source_changed_after_freeze');
      assert.equal(hash(frozenSource), sourceSha256, 'execution_source_changed');
      const directory = path.join(out, name); fs.mkdirSync(directory);
      const outputDir = path.join(directory, 'script-output'); fs.mkdirSync(outputDir);
      const trial = { name, kind, scenario, verdict: 'pending', externalOracles: [], sourceSha256 }; report.trials.push(trial); save();
      console.log(JSON.stringify({ trial: name, stage: 'verify-frozen-fixture' }));
      installedApk(path.join(directory, 'installed-apk.json'), apkSha256);
      const pre = settings(path.join(directory, 'settings-before.json')); assert.deepEqual(pre.settings, baseline.settings, 'initial_settings_changed');
      const initial = await run('flutter-nodes', report.target); write(path.join(directory, 'initial-tree.json'), initial);
      assert.equal(initial.ok, true); assert.equal(initial.truncated, false);
      assert(initial.nodes.some(node => node.text === '通过链接接收'), 'initial_receive_page_missing');
      const screen = await run('screenshot', { ...report.target, outFile: path.join(directory, 'initial.png') });
      write(path.join(directory, 'initial-screenshot.json'), screen); assert.equal(screen.foregroundMatchesPackage, true, 'initial_foreground_mismatch');
      const inputs = { serial: SERIAL, outputDir, scenario, cancelBeforeSettings: kind === 'cancel' };
      if (kind === 'wrong-expectation') inputs.expectedDeviceName = 'AAB deliberately wrong device';
      const spec = { schemaVersion: 'aab.code-script/v1', name, language: 'javascript', sourcePath: frozenSource, target: { platform: 'android', ...report.target },
        inputs, permissions: ['app.read', 'app.interact', 'capture.read'], policy: { timeoutMs: 660000, restartPolicy: 'none' } };
      write(path.join(directory, 'spec.json'), spec);
      const events = []; let cursor = 0, page = 0;
      const collect = state => {
        write(path.join(directory, 'execution-' + String(++page).padStart(4, '0') + '.json'), state);
        assert.equal(state.ok, true, JSON.stringify(state));
        for (const event of state.events) {
          if (event.sequence <= cursor) { assert.deepEqual(events[event.sequence - 1], event, 'event_changed'); continue; }
          assert.equal(event.sequence, cursor + 1, 'execution_event_gap'); events.push(event); cursor = event.sequence;
          if (['progress', 'assertion_failed', 'assertion_inconclusive', 'agent_question_created'].includes(event.type))
            console.log(JSON.stringify({ trial: name, event }));
        }
        write(path.join(directory, 'events.json'), events);
      };
      trial.startedAtMs = Date.now();
      let state = await run('script', { operation: 'start', script: spec, recordingDir: path.join(directory, 'host-recording') });
      activeId = state.operationId; trial.operationId = activeId; trial.scriptHash = state.hash; collect(state); save();
      while (!terminal(state)) {
        assert(Date.now() - trial.startedAtMs < 690000, 'controller_execution_deadline');
        if (state.status === 'waiting_for_agent') {
          const question = events.findLast(event => event.type === 'agent_question_created');
          assert(question, 'agent_question_event_missing');
          const context = question.request.context;
          if (context.kind === 'localsend.controlled-cancel/v1') {
            assert.equal(kind, 'cancel'); assert.equal(context.checkpoint, 'before-settings-mutations');
            trial.cancelAfterSequence = cursor; trial.cancelRequestedAtMs = Date.now();
            state = await run('script', { operation: 'cancel', operationId: activeId, afterSequence: cursor, limit: 500 });
          } else {
            assert.equal(context.kind, 'localsend.settings-oracle/v1', 'unexpected_agent_question');
            assert(Object.hasOwn(expectedSettings, context.checkpoint), 'unknown_oracle_checkpoint');
            assert.deepEqual(context.expectedSettings, expectedSettings[context.checkpoint], 'script_oracle_expectation_mismatch');
            const file = path.join(directory, context.checkpoint + '.json');
            const actual = settings(file);
            let verdict = 'passed';
            try { assert.deepEqual(actual.settings, expectedSettings[context.checkpoint]); } catch { verdict = 'failed'; }
            const decision = { kind: 'localsend.settings-oracle-result/v1', checkpoint: context.checkpoint, verdict,
              artifact: { path: file, sha256: hash(file) }, observedSettings: actual.settings };
            trial.externalOracles.push(decision); write(path.join(directory, context.checkpoint + '-decision.json'), decision); save();
            state = await run('script', { operation: 'decide', operationId: activeId, requestId: question.requestId,
              revision: question.revision, decision, afterSequence: cursor, limit: 500 });
          }
        } else state = await run('script', { operation: 'wait', operationId: activeId, afterSequence: cursor, waitMs: 1000, limit: 500 });
        collect(state);
      }
      state = await run('script', { operation: 'status', operationId: activeId, afterSequence: cursor, limit: 500 }); collect(state);
      trial.executionMs = Date.now() - trial.startedAtMs; trial.executionStatus = state.status; activeId = null;
      trial.timings = timingsFromScriptEvents(events, { wallMs: trial.executionMs, rollingSummary: state.rollingSummary });
      trial.observedControllerWaitMs = events.filter(event => event.type === 'agent_question_created').reduce((total, question) => {
        const end = events.find(event => event.type === 'agent_decision' && event.requestId === question.requestId)
          || events.find(event => event.type === 'script_cancelled' && event.sequence > question.sequence);
        assert(end, 'controller_wait_terminal_missing');
        return total + end.atMs - question.atMs;
      }, 0);
      trial.timingDefinitions = 'Existing p9-timings Host event categories; active overlaps provider/evidence waits. businessWaitMs counts explicit wait commands, not JavaScript polling delays. Host decisionWaitMs is the outstanding question age, not cumulative; observedControllerWaitMs independently sums question-to-decision or cancellation intervals.';
      trial.archive = await run('evidence', { operation: 'export', namespace: 'script', operationId: trial.operationId,
        outputDir: path.join(directory, 'durable-archive'), includeRecordedPayloads: true });
      write(path.join(directory, 'archive-export.json'), trial.archive); save(); assert.equal(trial.archive.ok, true, 'archive_export_failed');
      const post = settings(path.join(directory, 'settings-after.json')); trial.settingsRestored = JSON.stringify(post.settings) === JSON.stringify(baseline.settings);
      const finalTree = await run('flutter-nodes', report.target); write(path.join(directory, 'final-tree.json'), finalTree);
      const finalScreen = await run('screenshot', { ...report.target, outFile: path.join(directory, 'final.png') }); write(path.join(directory, 'final-screenshot.json'), finalScreen);
      const resultEnvelope = state.status === 'completed' ? await run('script', { operation: 'result', operationId: trial.operationId }) : null;
      if (resultEnvelope) { assert.equal(resultEnvelope.ok, true, JSON.stringify(resultEnvelope)); assert.equal(resultEnvelope.persisted, true); }
      trial.result = resultEnvelope?.result ?? null;
      trial.review = archiveReview(trial, directory, events); save();
      assert.deepEqual(post.settings, baseline.settings, 'final_settings_changed');
      assert.equal(finalScreen.foregroundMatchesPackage, true, 'final_foreground_mismatch');
      if (kind === 'positive') {
        assert.equal(state.status, 'completed'); assert.equal(trial.result?.flowCompleted, true, 'flow_incomplete');
        assert.equal(trial.result.uiVerdict, 'passed', 'ui_verdict_not_passed');
        assert.equal(trial.review.ui.failed, 0); assert.equal(trial.review.ui.inconclusive, 0);
        assert.equal(trial.externalOracles.length, scenario === 'acceptance' ? 3 : 0);
        assert(trial.externalOracles.every(oracle => oracle.verdict === 'passed'));
        assert(finalTree.nodes.some(node => node.text === '通过链接接收'), 'final_receive_page_missing');
        assert(trial.executionMs <= (scenario === 'core' ? 300000 : 600000), 'scenario_timing_gate_failed');
      } else if (kind === 'wrong-expectation') {
        assert.equal(trial.result?.uiVerdict, 'failed'); assert(trial.review.ui.failed > 0, 'wrong_expectation_not_detected');
        assert.equal(trial.review.actions, 0, 'wrong_initial_expectation_allowed_mutation');
      } else {
        assert.equal(state.status, 'cancelled'); assert.equal(trial.externalOracles.length, 0, 'settings_mutated_before_cancel');
        assert.equal(trial.review.ui.failed, 0); assert.equal(trial.review.ui.inconclusive, 0);
        assert(!events.some(event => event.sequence > trial.cancelAfterSequence && event.type === 'call_started'), 'calls_after_cancel');
        assert(finalTree.nodes.some(node => node.text === '主题'), 'cancel_checkpoint_page_missing');
      }
      trial.verdict = 'passed'; trial.fullAcceptance = 'inconclusive'; save();
      console.log(JSON.stringify({ trial: name, verdict: trial.verdict, status: state.status, executionMs: trial.executionMs, assertions: trial.review.counts }));
    }
  } catch (error) {
    report.error = error.stack || String(error);
    if (report.trials.length) report.trials.at(-1).verdict = 'failed';
  } finally {
    if (activeId) {
      try {
        write(path.join(out, 'cleanup-cancel.json'), await run('script', { operation: 'cancel', operationId: activeId }));
        const trial = report.trials.at(-1);
        trial.archive = await run('evidence', { operation: 'export', namespace: 'script', operationId: activeId,
          outputDir: path.join(out, trial.name, 'interrupted-archive'), includeRecordedPayloads: true });
        write(path.join(out, trial.name, 'archive-export.json'), trial.archive);
      } catch (error) { report.cleanupError = error.stack || String(error); }
    }
    write(path.join(out, 'host-exit.json'), await client.close()); save();
  }
  try {
    report.offline = await verifyOffline(report, out);
    assert.deepEqual(directoryHashes(path.dirname(server)), report.runtimeFiles, 'runtime_changed_during_trials');
    assert.equal(hash(sourceFile), sourceSha256, 'author_source_changed_during_trials');
    assert.equal(hash(frozenSource), sourceSha256, 'execution_source_changed_during_trials');
    report.ok = !report.error;
  } catch (error) { report.offlineError = error.stack || String(error); }
  report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ ok: report.ok, report: path.join(out, 'report.json'), error: report.error, offlineError: report.offlineError }));
  if (!report.ok) process.exitCode = 1;
  return report;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  assert.equal(argv.length, 6); assert.equal(argv[0], '--out'); assert.equal(argv[2], '--mode'); assert.equal(argv[4], '--apk-sha256');
  main({ out: argv[1], mode: argv[3], apkSha256: argv[5] }).catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { main, archiveReview, directoryHashes };
