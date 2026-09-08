#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createMcpClient, payloadOf } = require('../../../desktop/ai-app-bridge-cli/scripts/validation/mcp-jsonrpc-client');

const ROOT = path.resolve(__dirname, '../../..');
const SAMPLE = path.dirname(__dirname);
const TARGET = { serial: 'FYZLAU49X8OVQGJ7', packageName: 'org.localsend.localsend_app.bridge_sample' };
const BASELINE = { 'flutter.ls_theme': 'system', 'flutter.ls_color': 'system' };
const EXPECTED = { dark: { ...BASELINE, 'flutter.ls_theme': 'dark' }, restored: BASELINE };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const terminal = state => ['completed', 'failed', 'cancelled'].includes(state.status);

async function main(out, apkSha256, pilot = false) {
  assert.match(apkSha256, /^[a-f0-9]{64}$/);
  fs.mkdirSync(out);
  const source = path.join(__dirname, 'localsend-action-scope.v1.js');
  const frozenSource = path.join(out, 'script.js'); fs.copyFileSync(source, frozenSource);
  fs.copyFileSync(__filename, path.join(out, 'controller.js'));
  const sourceSha256 = hash(frozenSource);
  const hostFiles = ['bin/ai-app-bridge.js', 'bin/mcp-server.js', 'bin/script/script-catalog.js', 'bin/script/script-host-port.js'];
  const hostHashes = Object.fromEntries(hostFiles.map(file => [file, hash(path.join(ROOT, 'desktop/ai-app-bridge-cli', file))]));
  const server = path.join(ROOT, 'desktop/ai-app-bridge-cli/bin/mcp-server.js');
  const report = { ok: false, gate: 'Flutter typed action to real route facts and independent settings',
    authorship: 'root-authored focused diagnostic; separate frozen v1.0.5 reuse remains unchanged',
    target: TARGET, apkSha256, sourceSha256, hostHashes, fullAppAcceptance: 'inconclusive', trials: [] };
  const save = () => write(path.join(out, 'report.json'), report);
  const client = createMcpClient({ serverPath: server, transcriptPath: path.join(out, 'mcp.jsonl'),
    stderrPath: path.join(out, 'stderr.log'), env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'host-facts') } });
  const run = async (command, args) => payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
  const settings = file => {
    execFileSync('python3', [path.join(SAMPLE, 'settings-oracle.py'), '--serial', TARGET.serial, '--out', file]);
    const value = read(file); assert.equal(value.serial, TARGET.serial); assert.equal(value.packageName, TARGET.packageName);
    return value;
  };
  let activeId;
  try {
    await client.initialize();
    for (const name of pilot ? ['positive-1'] : ['positive-1', 'positive-2', 'positive-3', 'wrong-expectation', 'cancel']) {
      const dir = path.join(out, name); fs.mkdirSync(dir);
      const trial = { name, oracles: [] }; report.trials.push(trial); save();
      assert.equal(hash(frozenSource), sourceSha256); assert.equal(hash(source), sourceSha256);
      for (const file of hostFiles) assert.equal(hash(path.join(ROOT, 'desktop/ai-app-bridge-cli', file)), hostHashes[file]);
      const devicePath = execFileSync('adb', ['-s', TARGET.serial, 'shell', 'pm', 'path', TARGET.packageName], { encoding: 'utf8' }).trim().slice(8);
      assert(devicePath.startsWith('/data/app/') && devicePath.endsWith('/base.apk') && !devicePath.includes('\n'));
      const installedHash = execFileSync('adb', ['-s', TARGET.serial, 'shell', 'sha256sum', devicePath], { encoding: 'utf8' }).trim().split(/\s+/)[0];
      assert.equal(installedHash, apkSha256); write(path.join(dir, 'installed-apk.json'), { ...TARGET, devicePath, sha256: installedHash });
      assert.deepEqual(settings(path.join(dir, 'before-settings.json')).settings, BASELINE);
      const initial = await run('flutter-nodes', TARGET); write(path.join(dir, 'initial-tree.json'), initial);
      assert(initial.nodes.some(node => node.text === '通过链接接收'));
      const initialScreen = await run('screenshot', { ...TARGET, outFile: path.join(dir, 'initial.png') });
      write(path.join(dir, 'initial-screenshot.json'), initialScreen); assert.equal(initialScreen.foregroundMatchesPackage, true);
      const spec = { schemaVersion: 'aab.code-script/v1', name, language: 'javascript', sourcePath: frozenSource,
        target: TARGET, inputs: { serial: TARGET.serial, wrongExpectation: name === 'wrong-expectation', cancelBeforeMutation: name === 'cancel' },
        permissions: ['app.read', 'app.interact', 'capture.read'], policy: { timeoutMs: 120000, restartPolicy: 'none' } };
      write(path.join(dir, 'spec.json'), spec);
      const events = []; let cursor = 0, page = 0;
      const collect = state => {
        write(path.join(dir, `execution-${++page}.json`), state); assert.equal(state.ok, true, JSON.stringify(state));
        for (const event of state.events) {
          if (event.sequence <= cursor) { assert.deepEqual(events[event.sequence - 1], event); continue; }
          assert.equal(event.sequence, cursor + 1); events.push(event); cursor = event.sequence;
        }
        write(path.join(dir, 'events.json'), events);
      };
      console.log(JSON.stringify({ name, stage: 'start' }));
      const startedAt = Date.now();
      let state = await run('script', { operation: 'start', script: spec, recordingDir: path.join(dir, 'recording') });
      activeId = state.operationId; trial.operationId = activeId; collect(state); save();
      while (!terminal(state)) {
        assert(Date.now() - startedAt < 135000, 'controller timeout');
        if (state.status === 'waiting_for_agent') {
          const q = events.findLast(event => event.type === 'agent_question_created');
          if (q.request.context.kind === 'localsend.action-scope-cancel/v1') {
            assert.equal(name, 'cancel'); trial.cancelAfterSequence = cursor;
            state = await run('script', { operation: 'cancel', operationId: activeId, afterSequence: cursor, limit: 500 });
          } else {
            const context = q.request.context;
            assert.equal(context.kind, 'localsend.action-scope-oracle/v1');
            assert.deepEqual(context.expectedSettings, EXPECTED[context.checkpoint]);
            const file = path.join(dir, `${context.checkpoint}-settings.json`);
            const observed = settings(file);
            let verdict = 'passed';
            try { assert.deepEqual(observed.settings, EXPECTED[context.checkpoint]); } catch { verdict = 'failed'; }
            const decision = { checkpoint: context.checkpoint, verdict, observedSettings: observed.settings,
              artifact: { path: file, sha256: hash(file) } };
            trial.oracles.push(decision); save();
            state = await run('script', { operation: 'decide', operationId: activeId, requestId: q.requestId,
              revision: q.revision, decision, afterSequence: cursor, limit: 500 });
          }
        } else state = await run('script', { operation: 'wait', operationId: activeId, afterSequence: cursor, waitMs: 1000, limit: 500 });
        collect(state);
      }
      trial.durationMs = Date.now() - startedAt; trial.status = state.status;
      trial.result = events.findLast(event => event.type === 'script_completed')?.result;
      trial.archive = await run('evidence', { operation: 'export', namespace: 'script', operationId: activeId,
        outputDir: path.join(dir, 'archive'), includeRecordedPayloads: true });
      write(path.join(dir, 'export.json'), trial.archive); assert.equal(trial.archive.ok, true); activeId = null;
      const docs = trial.archive.recordedPayloads.attachments.map(item => read(path.join(trial.archive.archiveDir, item.path)));
      const calls = docs.filter(doc => doc.kind === 'script-call').map(doc => doc.data.envelope);
      const actions = calls.filter(call => call.execution.actionId);
      assert.equal(calls.length, events.filter(event => event.type === 'call_started').length);
      trial.actionCount = actions.length;
      assert.deepEqual(settings(path.join(dir, 'after-settings.json')).settings, BASELINE);
      const final = await run('flutter-nodes', TARGET); write(path.join(dir, 'final-tree.json'), final);
      assert(final.nodes.some(node => node.text === '通过链接接收'));
      const screen = await run('screenshot', { ...TARGET, outFile: path.join(dir, 'final.png') });
      write(path.join(dir, 'final-screenshot.json'), screen); assert.equal(screen.foregroundMatchesPackage, true);
      if (name.startsWith('positive')) {
        assert.equal(state.status, 'completed'); assert.equal(trial.result?.gate, 'passed', JSON.stringify(trial.result));
        assert.equal(actions.length, 6); assert.equal(trial.result.routes.length, 4); assert.equal(trial.oracles.length, 2);
        assert(trial.oracles.every(oracle => oracle.verdict === 'passed'));
        assert(trial.result.assertions.every(a => a.verdict === 'passed'));
        for (const route of trial.result.routes) {
          const action = actions.find(call => call.execution.actionId === route.actionId); assert(action);
          assert.equal(action.result.request.actionId, route.actionId);
          const page = calls.find(call => call.evidence.observationId === route.evidence.observationId); assert(page);
          assert.equal(page.evidence.coverage.status, 'complete'); assert.equal(page.evidence.coverage.gap, false);
          assert.equal(page.evidence.coverage.committed, true); assert.equal(page.evidence.capture.hasMore, false);
          assert.equal(page.evidence.window.afterActionId, route.actionId);
          const fact = page.result.items.find(item => item.id === route.route.id); assert.deepEqual(fact, route.route);
          assert.equal(fact.source, 'flutter-sdk'); assert.equal(fact.name, 'ui.route.changed'); assert.equal(fact.data.semanticChanged, true);
          assert(page.evidence.refs.length > 0);
        }
      } else if (name === 'wrong-expectation') {
        assert.equal(trial.result.gate, 'failed'); assert.equal(actions.length, 0);
        assert(events.some(e => e.type === 'assertion_failed' && e.name === 'expected device name'));
      } else {
        assert.equal(state.status, 'cancelled'); assert.equal(actions.length, 0);
        assert(!events.some(e => e.sequence > trial.cancelAfterSequence && e.type === 'call_started'));
      }
      trial.ok = true; save(); console.log(JSON.stringify({ name, status: trial.status, durationMs: trial.durationMs, actions: actions.length, routes: trial.result?.routes.length }));
    }
    report.ok = true;
  } catch (error) { report.error = error.stack; }
  finally {
    if (activeId) write(path.join(out, 'cleanup-cancel.json'), await run('script', { operation: 'cancel', operationId: activeId }));
    write(path.join(out, 'source-host-exit.json'), await client.close()); save();
  }
  const offline = path.join(out, 'offline'); fs.mkdirSync(offline);
  const storeFile = path.join(offline, 'unusable-store'); fs.writeFileSync(storeFile, 'not a live store');
  const reader = createMcpClient({ serverPath: server, transcriptPath: path.join(offline, 'mcp.jsonl'),
    stderrPath: path.join(offline, 'stderr.log'), env: { ADB: path.join(offline, 'adb-absent'), AI_APP_BRIDGE_FACT_STORE_DIR: storeFile } });
  try {
    await reader.initialize();
    for (const trial of report.trials.filter(t => t.archive?.ok)) {
      const copy = path.join(offline, trial.name); fs.cpSync(trial.archive.archiveDir, copy, { recursive: true, errorOnExist: true });
      const result = payloadOf(await reader.request('tools/call', { name: 'run', arguments: { command: 'evidence', arguments: {
        operation: 'verify', archiveDir: copy, manifestSha256: trial.archive.manifestSha256 } } }));
      write(path.join(offline, `${trial.name}.json`), result);
      assert.equal(result.ok, true); assert.equal(result.integrity, 'verified');
      assert.equal(hash(path.join(copy, 'manifest.json')), trial.archive.manifestSha256);
      trial.offlineVerified = true;
    }
  } finally { write(path.join(offline, 'host-exit.json'), await reader.close()); save(); }
  console.log(JSON.stringify({ ok: report.ok, error: report.error, out }));
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) main(path.resolve(process.argv[2]), process.argv[3], process.argv.includes('--pilot'))
  .catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { main };
