#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { runCli } = require('../../../desktop/ai-app-bridge-cli/test-support/cli-client');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx' });

async function main(config) {
  const out = path.resolve(config.outputDir), target = config.target;
  assert.equal(target.platform, 'ios');
  assert.equal(target.bundleId, 'io.github.mobileaidev.kiwix.sample');
  assert(target.wdaSessionId && target.wdaRunnerBundleId && target.deviceId);
  fs.mkdirSync(out, { recursive: false });
  write(path.join(out, 'config.json'), config);
  const sources = { script: path.resolve(__dirname, '../scripts/h5-course-submission.js'),
    oracle: path.join(__dirname, 'read-course-result.js'), fixture: path.resolve(__dirname, '../fixtures/freecodecamp-viewport.js') };
  for (const [name, file] of Object.entries(sources)) fs.copyFileSync(file, path.join(out, name + '.js'), fs.constants.COPYFILE_EXCL);
  const sourceHashes = Object.fromEntries(Object.entries(sources).map(([name, file]) => [name, hash(file)]));
  write(path.join(out, 'source-hashes.json'), sourceHashes);
  let sequence = 0;
  async function run(command, args, env = config.env) {
    const response = await runCli(command, args, { env, timeoutMs: 90000 });
    write(path.join(out, `${String(++sequence).padStart(3, '0')}-${command}.json`), { command, args, ...response });
    assert.equal(response.value.ok, true, JSON.stringify(response.value));
    return response.value;
  }
  const app = { deviceId: target.deviceId, bundleId: target.bundleId };
  const prepared = read(config.fixtureReceiptPath);
  assert.equal(prepared.command, 'ios-h5-eval');
  assert.equal(prepared.value.ok, true);
  assert.equal(prepared.args.script, fs.readFileSync(sources.fixture, 'utf8'));
  fs.copyFileSync(config.fixtureReceiptPath, path.join(out, 'fixture-receipt.json'));
  const baseline = await run('ios-h5-dom', app);
  assert.deepEqual(baseline.pageRef, prepared.args.expectedPage, 'Fixture must belong to this live document');
  assert(baseline.dom.controls.some(n => n.tag === 'button' && n.text === 'Run' && n.interaction.status === 'ready'));
  const events = [], oracles = [];
  function collect(state) {
    let cursor = events.at(-1)?.sequence || 0;
    for (const event of state.events) {
      if (event.sequence <= cursor) { assert.deepEqual(events[event.sequence - 1], event); continue; }
      assert.equal(event.sequence, cursor + 1, 'Script progress gap'); events.push(event); cursor = event.sequence;
    }
    assert.equal(cursor, state.eventSequence, 'Incomplete Script progress');
  }
  const startedAtMs = Date.now();
  let state = await run('script', { operation: 'start', recordingDir: path.join(out, 'recording'), script: {
    schemaVersion: 'aab.code-script/v1', name: 'Kiwix course submission', language: 'javascript',
    sourcePath: path.join(out, 'script.js'), target, inputs: { outputDir: path.join(out, 'device') },
    permissions: ['app.read', 'app.interact'], policy: { timeoutMs: 180000, restartPolicy: 'none' } } });
  const operationId = state.operationId;
  collect(state);
  while (!['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(state.status)) {
    assert(Date.now() - startedAtMs < 210000, 'Controller deadline exceeded');
    if (state.status === 'waiting_for_agent') {
      const question = events.findLast(e => e.type === 'agent_question_created'), context = question.request.context;
      assert.equal(context.kind, 'kiwix.course-oracle/v1');
      assert(['wrong', 'correct'].includes(context.phase));
      assert.equal(oracles.some(o => o.phase === context.phase), false);
      assert.equal(typeof context.runActionId, 'string');
      const h5 = await run('ios-h5-dom', app);
      assert.deepEqual(h5.pageRef, context.pageRef, 'Grading must belong to the submitted document');
      const result = await run('ios-h5-eval', { ...app, expectedPage: h5.pageRef, script: fs.readFileSync(sources.oracle, 'utf8') });
      assert.equal(typeof result.result, 'string');
      const actual = JSON.parse(result.result), correct = context.phase === 'correct';
      const marker = `script-${context.phase}-20260912`, expression = correct ? '12 + 8' : '9 + 10';
      const checks = [actual.schemaVersion === 'kiwix.course-result/v1', actual.url === h5.pageRef.url,
        actual.solution === `const sum = ${expression};\nconsole.log('${marker}', sum);`, actual.cheatMode === false,
        actual.passedDialog === correct, JSON.stringify(actual.graded?.logs) === JSON.stringify([marker, correct ? 20 : 19]),
        JSON.stringify(actual.graded?.hints?.map(h => h.passed)) === JSON.stringify([correct, true])];
      const artifact = path.join(out, context.phase + '-grader.json');
      write(artifact, { operationId, sourceSha256: sourceHashes.script, context, pageRef: h5.pageRef, actual, checks,
        evidenceScope: 'External read of original App grading state; not a durable progress or device ctx.assert claim' });
      const decision = { kind: 'kiwix.course-oracle-result/v1', phase: context.phase,
        verdict: checks.every(Boolean) ? 'passed' : 'failed', artifact: { path: artifact, sha256: hash(artifact) } };
      oracles.push(decision);
      console.log(JSON.stringify({ phase: context.phase, verdict: decision.verdict, hints: actual.graded?.hints?.map(h => h.passed) }));
      state = await run('script', { operation: 'decide', operationId, requestId: question.requestId,
        revision: question.revision, decision, afterSequence: state.eventSequence, limit: 500 });
    } else {
      state = await run('script', { operation: 'wait', operationId, afterSequence: state.eventSequence, waitMs: 1000, limit: 500 });
    }
    collect(state);
  }
  const durationMs = Date.now() - startedAtMs;
  write(path.join(out, 'events.json'), events);
  const archive = await run('evidence', { operation: 'export', namespace: 'script', operationId,
    outputDir: path.join(out, 'archive'), includeRecordedPayloads: true });
  const offlineEnv = { AI_APP_BRIDGE_RUNTIME_HOME: path.join(out, 'offline-runtime'), AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'offline-facts'),
    AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb', ADB: '/offline-no-adb', AI_APP_BRIDGE_DEVICECTL: '/offline-no-devicectl' };
  const verified = await run('evidence', { operation: 'verify', archiveDir: archive.archiveDir, manifestSha256: archive.manifestSha256 }, offlineEnv);
  const resultEnvelope = state.status === 'completed' ? await run('script', { operation: 'result', operationId }) : null;
  if (resultEnvelope) { assert.equal(resultEnvelope.ok, true, JSON.stringify(resultEnvelope)); assert.equal(resultEnvelope.persisted, true); }
  const result = resultEnvelope?.result;
  const report = { operationId, status: state.status, durationMs, sourceHashes, assertions: state.rollingSummary.assertions,
    eventCount: events.length, result, oracles, manifestSha256: archive.manifestSha256, archiveVerified: verified.ok,
    failure: events.findLast(e => e.type === 'script_failed') };
  write(path.join(out, 'report.json'), report);
  console.log(JSON.stringify({ status: state.status, durationMs, assertions: report.assertions, reportPath: path.join(out, 'report.json') }));
  assert.equal(state.status, 'completed'); assert.equal(result?.businessVerdict, 'passed');
  assert.equal(oracles.length, 2); assert(oracles.every(o => o.verdict === 'passed'));
  for (const artifact of result.artifacts) assert.equal(hash(artifact.path), artifact.sha256);
  for (const [name, file] of Object.entries(sources)) assert.equal(hash(file), sourceHashes[name]);
}

main(read(process.argv[2])).catch(error => { console.error(error); process.exitCode = 1; });
