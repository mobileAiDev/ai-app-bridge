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
const PACKAGE = 'org.localsend.localsend_app.bridge_sample';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
async function hash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function main() {
  const [fixtureArg, outArg, name, previousArg, expectedPeerAliasArg] = process.argv.slice(2);
  assert(fixtureArg && outArg && /^BridgeInFlight[A-Za-z0-9]+\.bin$/.test(name),
    'usage: run-transfer-inflight.js FIXTURE_DIR NEW_OUT_DIR FILE_NAME [PREVIOUS_PARTIAL_ORACLE] [EXPECTED_PEER_ALIAS]');
  const fixture = path.resolve(fixtureArg), out = path.resolve(outArg);
  fs.mkdirSync(out);
  const config = read(path.join(fixture, 'script-fixture.json'));
  // The optional expectation affects the Script only. The official peer keeps
  // its frozen identity, allowing a deliberate wrong-target validation.
  const expectedPeerAlias = expectedPeerAliasArg === undefined ? config.peerAlias : expectedPeerAliasArg;
  assert.equal(typeof expectedPeerAlias, 'string'); assert(expectedPeerAlias.length > 0);
  const file = { ...read(path.join(fixture, 'transfer-files.json'))[0], name };
  const original = path.join(fixture, 'send', name), manifest = path.join(out, 'file.json');
  assert.equal(fs.statSync(original).size, file.bytes);
  assert.equal(await hash(original), file.sha256, 'source_bytes_changed');
  write(manifest, file);
  const source = path.join(out, 'script.js');
  fs.copyFileSync(path.join(__dirname, 'localsend-transfer-inflight.v1.js'), source);
  const sourceSha256 = await hash(source);
  const adb = args => execFileSync('adb', ['-s', config.serial, ...args], { timeout: 60000, encoding: 'utf8' }).trim();
  assert.equal(adb(['get-state']), 'device');
  const installedPaths = adb(['shell', 'pm', 'path', PACKAGE]).split(/\r?\n/);
  assert.equal(installedPaths.length, 1); assert(installedPaths[0].startsWith('package:/data/app/'));
  assert.equal(adb(['shell', 'sha256sum', installedPaths[0].slice(8)]).split(/\s+/)[0], config.apkSha256);
  const peerManifest = read(path.join(fixture, 'peer-manifest.json'));
  assert.equal(await hash(path.join(fixture, 'peer/localsend-cli')), peerManifest.binarySha256);
  const remote = '/storage/emulated/0/Download/' + name;
  let cleaned = null;
  if (previousArg) {
    // Repetitions use identical inputs. Only remove the exact preceding partial
    // after both its preserved copy and the current phone file match its oracle.
    const previous = read(path.resolve(previousArg));
    assert.equal(previous.schemaVersion, 'localsend.partial-file-oracle/v1');
    assert.equal(previous.ok, true); assert.equal(previous.mode, 'partial');
    assert.equal(previous.serial, config.serial); assert.deepEqual(previous.file, file);
    assert.equal(previous.remotePath, remote); assert.equal(previous.bytesEqualToSourcePrefix, true);
    assert.equal(await hash(previous.actualCopy), previous.sha256);
    assert.equal(Number(adb(['shell', 'stat', '-c', '%s', remote])), previous.bytes);
    assert.equal(adb(['shell', 'sha256sum', remote]).split(/\s+/)[0], previous.sha256);
    adb(['shell', 'rm', '--', remote]);
    cleaned = { previousOracle: path.resolve(previousArg), bytes: previous.bytes, sha256: previous.sha256 };
  }
  adb(['shell', 'test', '!', '-e', remote]);
  write(path.join(out, 'fixture.json'), { ...config, expectedPeerAlias, file, sourceSha256, peerManifest,
    initiallyAbsent: true, cleaned });
  for (const helper of ['run-transfer-inflight.js', 'run-transfer-receive.js',
    'official-peer-pty.py', 'partial-transfer-oracle.py'])
    fs.copyFileSync(path.join(__dirname, helper), path.join(out, helper));
  const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(fixture, 'facts'),
    AI_APP_BRIDGE_RUNTIME_HOME: path.join(fixture, 'runtimes'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' };
  const run = async args => (await runCli('script', args, { cwd: ROOT, env, timeoutMs: 35000 })).value;
  const oracle = mode => {
    const result = path.join(out, mode + '-oracle.json');
    execFileSync('python3', [path.join(__dirname, 'partial-transfer-oracle.py'), '--serial', config.serial,
      '--manifest', manifest, '--source', original, '--mode', mode, '--out', result], { timeout: 60000 });
    return read(result);
  };
  let activeId, peer, state, cursor = 0, page = 0;
  const events = [];
  const collect = value => {
    write(path.join(out, `execution-${String(++page).padStart(4, '0')}.json`), value);
    assert.equal(value.ok, true, JSON.stringify({ error: value.error, status: value.status }));
    for (const event of value.events) {
      if (event.sequence <= cursor) continue;
      assert.equal(event.sequence, cursor + 1, 'script_event_gap');
      events.push(event); cursor = event.sequence;
    }
  };
  const startedAtMs = Date.now();
  try {
    state = await run({ operation: 'start', recordingDir: path.join(out, 'recording'), script: {
      schemaVersion: 'aab.code-script/v1', name: path.basename(out), language: 'javascript', sourcePath: source,
      target: { platform: 'android', serial: config.serial, packageName: PACKAGE },
      inputs: { serial: config.serial, peerAlias: expectedPeerAlias, file },
      permissions: ['app.read', 'app.interact'], policy: { timeoutMs: 180000, restartPolicy: 'none' }
    } });
    activeId = state.operationId; collect(state);
    while (!['completed', 'failed', 'cancelled'].includes(state.status)) {
      assert(Date.now() - startedAtMs < 200000, 'controller_deadline');
      if (state.status === 'waiting_for_agent') {
        const question = events.findLast(event => event.type === 'agent_question_created');
        const context = question.request.context;
        assert.equal(context.kind, 'localsend.transfer-inflight/v1'); assert.deepEqual(context.file, file);
        let decision;
        if (context.operation === 'offer') {
          assert.equal(peer, undefined);
          peer = new OfficialPeer(fixture, out, config, [file]);
          await peer.offer(config); decision = { ok: true };
        } else if (context.operation === 'verify-growing') decision = oracle('progress');
        else if (context.operation === 'verify-cancelled-partial') {
          await peer.until(text => text.includes('Cancelled by receiver (0 file(s) sent)'), 'receiver_cancelled');
          assert.equal(peer.text.includes('Sent 1 file'), false, 'completion_won_cancellation_race');
          decision = { ...oracle('partial'), peerOutcome: 'receiver-cancelled' };
        } else throw Error('unexpected_peer_request');
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
      elapsedMs: report.completedAtMs - startedAtMs, bytes: result?.partial?.bytes,
      error: result?.error, assertions: result?.assertions?.length, actions: result?.actions?.length }));
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
