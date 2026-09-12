#!/usr/bin/env node
'use strict';

// All phone interaction belongs to the recorded Script. This controller drives
// the real official desktop peer and reads destination bytes independently.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const { runCli } = require('../../../desktop/ai-app-bridge-cli/test-support/cli-client');

const ROOT = path.resolve(__dirname, '../../..');
const PACKAGE = 'org.localsend.localsend_app.bridge_sample';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const terminal = state => ['completed', 'failed', 'cancelled'].includes(state.status);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

class OfficialPeer {
  constructor(fixture, out, config, files) {
    const args = [path.join(__dirname, 'official-peer-pty.py'), '--log', path.join(out, 'official-peer.ansi'),
      '--', path.join(fixture, 'peer/localsend-cli'), '--alias', config.peerAlias,
      '--destination', path.join(fixture, 'received')];
    for (const file of files) args.push('--file', path.join(fixture, 'send', file.name));
    this.child = spawn('python3', args, { cwd: ROOT,
      env: { ...process.env, XDG_CONFIG_HOME: path.join(fixture, 'peer-config') }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.output = ''; this.exitCode = null; this.finished = false; this.errors = '';
    this.child.stderr.on('data', data => { this.errors += data; });
    createInterface({ input: this.child.stdout }).on('line', line => {
      const event = JSON.parse(line);
      if (event.output) this.output += event.output;
      if (Object.hasOwn(event, 'exitCode')) this.exitCode = event.exitCode;
    });
    this.closed = new Promise(resolve => this.child.on('close', code => {
      this.finished = true; this.wrapperExitCode = code; resolve();
    }));
  }
  get text() { return this.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07)/g, ''); }
  key(keys) { this.child.stdin.write(JSON.stringify({ keys }) + '\n'); }
  async until(predicate, name, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.text)) {
      if (this.finished) throw Error(`official_peer_ended_before_${name}: ${this.exitCode}; ${this.errors}`);
      if (Date.now() >= deadline) throw Error(`official_peer_timeout_${name}`);
      await sleep(100);
    }
  }
  async offer(config) {
    await this.until(text => text.includes(config.phoneAlias) && text.includes(config.phoneAddress), 'expected_device');
    // In --file mode Enter sends to the selected device. Require exactly one
    // discovered row in the current terminal frame before using that shortcut.
    const frame = this.text;
    const slots = [...frame.matchAll(/\[(\d+)\] ([^\r\n()]+) \(([^)]+)\)/g)];
    assert(slots.length > 0 && slots.every(match => match[1] === '1'
      && match[2] === config.phoneAlias && match[3].includes(config.phoneAddress)),
    'peer_picker_requires_one_observed_device');
    this.key('\r');
  }
  async sent() {
    await this.until(text => /Sent 2 files/.test(text), 'two_files_sent');
    await Promise.race([this.closed, sleep(5000).then(() => { throw Error('official_peer_did_not_exit'); })]);
    assert.equal(this.exitCode, 0); assert.equal(this.wrapperExitCode, 0);
    return { ok: true, exitCode: this.exitCode, expectedFilesSent: 2 };
  }
  async close() {
    if (!this.finished) { this.child.stdin.end(); await this.closed; }
  }
}

async function main() {
  const [fixtureArg, outArg] = process.argv.slice(2);
  assert(fixtureArg && outArg, 'usage: run-transfer-receive.js FIXTURE_DIR NEW_OUTPUT_DIR');
  const fixture = path.resolve(fixtureArg), out = path.resolve(outArg);
  fs.mkdirSync(out, { recursive: false });
  const config = read(path.join(fixture, 'script-fixture.json'));
  const manifestPath = path.join(fixture, 'transfer-files.json');
  const files = read(manifestPath), manifestSha256 = sha(fs.readFileSync(manifestPath));
  const source = path.join(__dirname, 'localsend-transfer-receive.v1.js');
  const frozen = path.join(out, 'script.js'); fs.copyFileSync(source, frozen);
  const sourceSha256 = sha(fs.readFileSync(frozen));
  const peerManifest = read(path.join(fixture, 'peer-manifest.json'));
  assert.equal(sha(fs.readFileSync(path.join(fixture, 'peer/localsend-cli'))), peerManifest.binarySha256);
  const adb = args => execFileSync('adb', ['-s', config.serial, ...args], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const paths = adb(['shell', 'pm', 'path', PACKAGE]).toString().trim().split(/\r?\n/);
  assert.equal(paths.length, 1); assert(paths[0].startsWith('package:/data/app/'));
  const installed = adb(['shell', 'sha256sum', paths[0].slice(8)]).toString().trim().split(/\s+/)[0];
  assert.equal(installed, config.apkSha256, 'installed_apk_changed');
  const cleaned = [];
  for (const file of files) {
    const original = fs.readFileSync(path.join(fixture, 'send', file.name));
    assert.equal(path.basename(file.name), file.name);
    assert.equal(sha(original), file.sha256); assert.equal(original.length, file.bytes);
    const remote = '/storage/emulated/0/Download/' + file.name;
    const actual = adb(['exec-out', 'cat', remote]);
    assert.deepEqual(actual, original, 'refuse_to_remove_nonfixture_file');
    adb(['shell', `rm -- ${quote(remote)} && test ! -e ${quote(remote)}`]);
    cleaned.push({ name: file.name, bytes: actual.length, sha256: sha(actual), absentAfterRemoval: true });
  }
  write(path.join(out, 'fixture.json'), { ...config, sourceSha256, manifestSha256, peerManifest, cleaned });
  const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(fixture, 'facts'),
    AI_APP_BRIDGE_RUNTIME_HOME: path.join(fixture, 'runtimes'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' };
  const run = async args => (await runCli('script', args, { cwd: ROOT, env, timeoutMs: 35000 })).value;
  let activeId, peer, state, cursor = 0, page = 0;
  const events = [], decisions = [];
  const collect = value => {
    write(path.join(out, `execution-${String(++page).padStart(4, '0')}.json`), value);
    assert.equal(value.ok, true, JSON.stringify(value));
    for (const event of value.events) {
      if (event.sequence <= cursor) continue;
      assert.equal(event.sequence, cursor + 1, 'script_event_gap');
      events.push(event); cursor = event.sequence;
    }
  };
  const startedAtMs = Date.now();
  try {
    state = await run({ operation: 'start', recordingDir: path.join(out, 'recording'), script: {
      schemaVersion: 'aab.code-script/v1', name: path.basename(out), language: 'javascript', sourcePath: frozen,
      target: { platform: 'android', serial: config.serial, packageName: PACKAGE },
      inputs: { serial: config.serial, peerAlias: config.peerAlias, files, manifestSha256 },
      permissions: ['app.read', 'app.interact'], policy: { timeoutMs: 180000, restartPolicy: 'none' }
    } });
    activeId = state.operationId; collect(state);
    while (!terminal(state)) {
      assert(Date.now() - startedAtMs < 200000, 'controller_deadline');
      if (state.status === 'waiting_for_agent') {
        const question = events.findLast(event => event.type === 'agent_question_created');
        const context = question.request.context;
        assert.equal(context.kind, 'localsend.transfer-peer/v1');
        assert.equal(context.manifestSha256, manifestSha256); assert.deepEqual(context.files, files);
        let decision;
        if (context.operation === 'offer') {
          assert.equal(peer, undefined, 'duplicate_offer');
          peer = new OfficialPeer(fixture, out, config, files);
          await peer.offer(config);
          decision = { ok: true, peerAlias: config.peerAlias, manifestSha256 };
        } else if (context.operation === 'verify-received') {
          const completion = await peer.sent();
          write(path.join(out, 'peer-completion.json'), completion);
          const oracleFile = path.join(out, 'independent-files.json');
          execFileSync('python3', [path.join(__dirname, 'transfer-oracle.py'), '--manifest', manifestPath,
            '--source', path.join(fixture, 'send'), '--android-directory', '/storage/emulated/0/Download',
            '--serial', config.serial, '--out', oracleFile], { timeout: 60000 });
          decision = read(oracleFile);
        } else throw Error('unsupported_peer_operation');
        decisions.push({ requestId: question.requestId, operation: context.operation, decision });
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
      rollingSummary: state.rollingSummary, result, decisions, humanInterventions: 0 };
    activeId = null;
    write(path.join(out, 'events.json'), events); write(path.join(out, 'report.json'), report);
    console.log(JSON.stringify({ ok: report.ok, operationId: report.operationId, status: report.executionStatus,
      elapsedMs: report.completedAtMs - startedAtMs, error: result?.error, actions: result?.actions?.length,
      assertions: result?.assertions?.length, report: path.join(out, 'report.json') }));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    write(path.join(out, 'controller-error.json'), { error: error.message, operationId: activeId, events, decisions });
    throw error;
  } finally {
    if (activeId) write(path.join(out, 'cancel.json'), await run({ operation: 'cancel', operationId: activeId }));
    if (peer) await peer.close();
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { OfficialPeer };
