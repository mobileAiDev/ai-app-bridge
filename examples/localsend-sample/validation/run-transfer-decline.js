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
  const [fixtureArg, outArg, outcome] = process.argv.slice(2);
  assert(fixtureArg && outArg && ['reject', 'sender-cancel'].includes(outcome),
    'usage: run-transfer-decline.js FIXTURE_DIR NEW_OUT_DIR reject|sender-cancel');
  const fixture = path.resolve(fixtureArg), out = path.resolve(outArg);
  fs.mkdirSync(out, { recursive: false });
  const config = read(path.join(fixture, 'script-fixture.json'));
  const name = outcome === 'reject' ? 'BridgeReject20260911.txt' : 'BridgeCancel20260911.txt';
  const bytes = fs.readFileSync(path.join(fixture, 'send', name));
  const file = { name, bytes: bytes.length, sha256: sha(bytes) };
  const source = path.join(out, 'script.js');
  fs.copyFileSync(path.join(__dirname, 'localsend-transfer-decline.v1.js'), source);
  const sourceSha256 = sha(fs.readFileSync(source));
  const adb = args => execFileSync('adb', ['-s', config.serial, ...args], { timeout: 60000, encoding: 'utf8' }).trim();
  const installedPaths = adb(['shell', 'pm', 'path', 'org.localsend.localsend_app.bridge_sample']).split(/\r?\n/);
  assert.equal(installedPaths.length, 1); assert(installedPaths[0].startsWith('package:/data/app/'));
  assert.equal(adb(['shell', 'sha256sum', installedPaths[0].slice(8)]).split(/\s+/)[0], config.apkSha256);
  assert.equal(sha(fs.readFileSync(path.join(fixture, 'peer/localsend-cli'))), read(path.join(fixture, 'peer-manifest.json')).binarySha256);
  const absent = () => {
    const output = adb(['shell', `find /storage/emulated/0/Download -maxdepth 1 -name '${name.slice(0, -4)}*' -print`]);
    return output === '' ? [] : output.split(/\r?\n/);
  };
  assert.deepEqual(absent(), []);
  write(path.join(out, 'fixture.json'), { ...config, file, outcome, sourceSha256, initiallyAbsent: true });
  for (const helper of ['run-transfer-decline.js', 'run-transfer-receive.js', 'official-peer-pty.py'])
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
    }
  };
  const startedAtMs = Date.now();
  try {
    state = await run({ operation: 'start', recordingDir: path.join(out, 'recording'), script: {
      schemaVersion: 'aab.code-script/v1', name: path.basename(out), language: 'javascript', sourcePath: source,
      target: { platform: 'android', serial: config.serial, packageName: 'org.localsend.localsend_app.bridge_sample' },
      inputs: { serial: config.serial, peerAlias: config.peerAlias, file, outcome },
      permissions: ['app.read', 'app.interact'], policy: { timeoutMs: 180000, restartPolicy: 'none' }
    } });
    activeId = state.operationId; collect(state);
    while (!['completed', 'failed', 'cancelled'].includes(state.status)) {
      assert(Date.now() - startedAtMs < 200000, 'controller_deadline');
      if (state.status === 'waiting_for_agent') {
        const question = events.findLast(event => event.type === 'agent_question_created');
        const context = question.request.context;
        assert.equal(context.kind, 'localsend.transfer-decline/v1');
        assert.deepEqual(context.file, file); assert.equal(context.outcome, outcome);
        let decision;
        if (context.operation === 'offer') {
          assert.equal(peer, undefined);
          peer = new OfficialPeer(fixture, out, config, [file]);
          await peer.offer(config); decision = { ok: true };
        } else if (context.operation === 'cancel-pending-request') {
          assert.equal(outcome, 'sender-cancel');
          peer.key('\x03'); await peer.until(text => text.includes(': Cancelled'), 'cancelled_request');
          decision = { ok: true };
        } else if (context.operation === 'verify-absent') {
          const expected = outcome === 'reject' ? ': Declined' : ': Cancelled';
          await peer.until(text => text.includes(expected), 'expected_nonreceipt');
          const matches = absent();
          assert.equal(peer.text.includes('Sent 1 file'), false, 'unexpected_file_transferred');
          decision = { ok: matches.length === 0, fileName: name, matches, peerOutcome: outcome,
            method: 'independent adb directory scan and official peer transcript', capturedAtMs: Date.now() };
          write(path.join(out, 'independent-nonreceipt.json'), decision);
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
      executionStatus: state.status, outcome, sourceSha256, startedAtMs, completedAtMs: Date.now(),
      rollingSummary: state.rollingSummary, result, humanInterventions: 0 };
    activeId = null;
    write(path.join(out, 'events.json'), events); write(path.join(out, 'report.json'), report);
    console.log(JSON.stringify({ ok: report.ok, outcome, operationId: report.operationId,
      elapsedMs: report.completedAtMs - startedAtMs, error: result?.error, assertions: result?.assertions?.length }));
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
