#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { runCli } = require('../../../desktop/ai-app-bridge-cli/test-support/cli-client');
const { OfficialPeer } = require('./run-transfer-receive');
const ROOT = path.resolve(__dirname, '../../..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

async function main() {
  const [fixtureArg, outArg, destinationState] = process.argv.slice(2);
  assert(fixtureArg && outArg && ['empty', 'previous-received'].includes(destinationState),
    'usage: run-transfer-send.js FIXTURE_DIR NEW_OUTPUT_DIR empty|previous-received');
  const fixture = path.resolve(fixtureArg), out = path.resolve(outArg);
  fs.mkdirSync(out, { recursive: false });
  const config = read(path.join(fixture, 'script-fixture.json'));
  const manifest = path.join(fixture, 'transfer-files.json');
  const files = read(manifest), manifestSha256 = sha(fs.readFileSync(manifest));
  const source = path.join(out, 'script.js');
  fs.copyFileSync(path.join(__dirname, 'localsend-transfer-send.v1.js'), source);
  const sourceSha256 = sha(fs.readFileSync(source));
  const adb = args => execFileSync('adb', ['-s', config.serial, ...args], { timeout: 60000, encoding: 'utf8' }).trim();
  const paths = adb(['shell', 'pm', 'path', 'org.localsend.localsend_app.bridge_sample']).split(/\r?\n/);
  assert.equal(paths.length, 1); assert(paths[0].startsWith('package:/data/app/'));
  assert.equal(adb(['shell', 'sha256sum', paths[0].slice(8)]).split(/\s+/)[0], config.apkSha256);
  assert.equal(sha(fs.readFileSync(path.join(fixture, 'peer/localsend-cli'))), read(path.join(fixture, 'peer-manifest.json')).binarySha256);
  execFileSync('python3', [path.join(__dirname, 'transfer-oracle.py'), '--manifest', manifest,
    '--source', path.join(fixture, 'send'), '--android-directory', '/storage/emulated/0/Download',
    '--serial', config.serial, '--out', path.join(out, 'phone-source-before.json')], { timeout: 60000 });
  const cleaned = [];
  for (const file of files) {
    assert.equal(path.basename(file.name), file.name);
    const destination = path.join(fixture, 'received', file.name);
    const original = fs.readFileSync(path.join(fixture, 'send', file.name));
    assert.equal(sha(original), file.sha256); assert.equal(original.length, file.bytes);
    if (destinationState === 'previous-received') {
      const previous = fs.readFileSync(destination);
      assert.deepEqual(previous, original, 'refuse_to_remove_nonfixture_destination');
      fs.unlinkSync(destination); cleaned.push({ name: file.name, bytes: previous.length, sha256: sha(previous) });
    } else assert.equal(fs.existsSync(destination), false, 'destination_must_be_empty');
  }
  write(path.join(out, 'fixture.json'), { ...config, sourceSha256, manifestSha256, destinationState, cleaned });
  for (const helper of ['run-transfer-send.js', 'run-transfer-receive.js', 'official-peer-pty.py', 'transfer-oracle.py'])
    fs.copyFileSync(path.join(__dirname, helper), path.join(out, helper));
  const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(fixture, 'facts'),
    AI_APP_BRIDGE_RUNTIME_HOME: path.join(fixture, 'runtimes'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' };
  const run = async args => (await runCli('script', args, { cwd: ROOT, env, timeoutMs: 35000 })).value;
  let activeId, peer, state, cursor = 0, page = 0;
  const events = [];
  const collect = state => {
    write(path.join(out, `execution-${String(++page).padStart(4, '0')}.json`), state);
    assert.equal(state.ok, true, JSON.stringify(state));
    for (const event of state.events) {
      if (event.sequence <= cursor) continue;
      assert.equal(event.sequence, cursor + 1, 'script_event_gap');
      events.push(event); cursor = event.sequence;
      if (['assertion_failed', 'assertion_inconclusive', 'progress'].includes(event.type))
        console.log(JSON.stringify({ event: event.type, name: event.name, stage: event.stage, error: event.error }));
    }
  };
  const startedAtMs = Date.now();
  try {
    state = await run({ operation: 'start', recordingDir: path.join(out, 'recording'), script: {
      schemaVersion: 'aab.code-script/v1', name: path.basename(out), language: 'javascript', sourcePath: source,
      target: { platform: 'android', serial: config.serial, packageName: 'org.localsend.localsend_app.bridge_sample' },
      inputs: { serial: config.serial, peerAlias: config.peerAlias, files, manifestSha256 },
      permissions: ['app.read', 'app.interact'], policy: { timeoutMs: 240000, restartPolicy: 'none' }
    } });
    activeId = state.operationId; collect(state);
    while (!['completed', 'failed', 'cancelled'].includes(state.status)) {
      assert(Date.now() - startedAtMs < 260000, 'controller_deadline');
      if (state.status === 'waiting_for_agent') {
        const question = events.findLast(event => event.type === 'agent_question_created');
        const context = question.request.context;
        assert.equal(context.kind, 'localsend.transfer-send/v1');
        assert.deepEqual(context.files, files); assert.equal(context.manifestSha256, manifestSha256);
        let decision;
        if (context.operation === 'start-receiver') {
          assert.equal(peer, undefined);
          peer = new OfficialPeer(fixture, out, config, []);
          await peer.until(text => text.includes('Ready to accept requests.'), 'receiver_ready');
          decision = { ok: true };
        } else if (context.operation === 'accept-exact-files') {
          await peer.until(text => text.includes('Accept? Y/N/P'), 'incoming_request');
          assert(peer.text.includes(`R ${config.phoneAlias}`) && peer.text.includes('Files (2,')
            && files.every(file => peer.text.includes(file.name)), 'unexpected_incoming_file_set');
          peer.key('y'); decision = { ok: true };
        } else if (context.operation === 'verify-received') {
          await peer.until(text => text.includes('Received 2 files'), 'two_files_received');
          const oracle = path.join(out, 'independent-files.json');
          execFileSync('python3', [path.join(__dirname, 'transfer-oracle.py'), '--manifest', manifest,
            '--source', path.join(fixture, 'send'), '--local', path.join(fixture, 'received'), '--out', oracle], { timeout: 60000 });
          decision = read(oracle);
        } else throw Error('unexpected_peer_request');
        console.log(JSON.stringify({ stage: context.operation, ok: decision.ok }));
        state = await run({ operation: 'decide', operationId: activeId, requestId: question.requestId,
          revision: question.revision, decision, afterSequence: cursor, limit: 500 });
      } else state = await run({ operation: 'wait', operationId: activeId, afterSequence: cursor, waitMs: 1000, limit: 500 });
      collect(state);
    }
    const resultEnvelope = state.status === 'completed' ? await run({ operation: 'result', operationId: activeId }) : null;
    if (resultEnvelope) { assert.equal(resultEnvelope.ok, true, JSON.stringify(resultEnvelope)); assert.equal(resultEnvelope.persisted, true); }
    const result = resultEnvelope?.result;
    const report = { ok: state.status === 'completed' && result?.gate === 'passed', operationId: activeId,
      executionStatus: state.status, sourceSha256, startedAtMs, completedAtMs: Date.now(),
      rollingSummary: state.rollingSummary, result, humanInterventions: 0 };
    activeId = null;
    write(path.join(out, 'events.json'), events); write(path.join(out, 'report.json'), report);
    console.log(JSON.stringify({ ok: report.ok, operationId: report.operationId,
      elapsedMs: report.completedAtMs - startedAtMs, error: result?.error,
      assertions: result?.assertions?.length, actions: result?.actions?.length }));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    write(path.join(out, 'controller-error.json'), { error: error.message, operationId: activeId, events });
    throw error;
  } finally {
    if (activeId) write(path.join(out, 'cancel.json'), await run({ operation: 'cancel', operationId: activeId }));
    if (peer) await peer.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
