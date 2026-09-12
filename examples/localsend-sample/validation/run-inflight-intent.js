#!/usr/bin/env node
'use strict';
// These Agent-authored decisions use the controls observed in the first live
// Intent. Keeping the calls consecutive avoids completing the transfer while
// the Agent is inspecting an intermediate page.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { runCli } = require('../../../desktop/ai-app-bridge-cli/test-support/cli-client');
const { OfficialPeer } = require('./run-transfer-receive');
const ROOT = path.resolve(__dirname, '../../..');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const [fixtureArg, outArg, name] = process.argv.slice(2);
  assert(fixtureArg && outArg && /^BridgeInFlight[A-Za-z0-9]+\.bin$/.test(name));
  const fixture = path.resolve(fixtureArg), out = path.resolve(outArg); fs.mkdirSync(out);
  const config = read(path.join(fixture, 'script-fixture.json'));
  const file = { ...read(path.join(fixture, 'transfer-files.json'))[0], name };
  const source = path.join(fixture, 'send', name), manifest = path.join(out, 'file.json');
  assert.equal(fs.statSync(source).size, file.bytes); write(manifest, file);
  execFileSync('adb', ['-s', config.serial, 'shell', `test ! -e /storage/emulated/0/Download/${name}`]);
  const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(fixture, 'facts'),
    AI_APP_BRIDGE_RUNTIME_HOME: path.join(fixture, 'runtimes'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' };
  let state, peer, number = 0, active = null;
  const startedAtMs = Date.now();
  const run = async (command, args) => {
    const value = (await runCli(command, args, { cwd: ROOT, env, timeoutMs: 35000 })).value;
    write(path.join(out, `${String(++number).padStart(3, '0')}-${command}.json`), { command, args, value });
    assert.equal(value.ok, true, JSON.stringify({ command, error: value.error, status: value.status }));
    return value;
  };
  const has = (value, label) => value.summary.nodes.some(node => node.text === label);
  async function observe(predicate, stage) {
    const deadline = Date.now() + 15000;
    do {
      state = await run('intent', { operation: 'observe', operationId: active, provider: 'flutter' });
      if (predicate(state)) return;
      await sleep(150);
    } while (Date.now() < deadline);
    throw Error('expected_UI_missing:' + stage);
  }
  async function tap(text) {
    assert.equal(state.summary.nodes.filter(node => node.text === text).length, 1);
    state = await run('intent', { operation: 'decide', operationId: active, decision: {
      decisionId: `${path.basename(out)}-${number}`, basedOnRevision: state.revision, agentDecision: 'act',
      action: { action: 'tap', selector: { text } }
    } });
  }
  const screenshot = label => run('screenshot', { serial: config.serial, packageName: 'org.localsend.localsend_app.bridge_sample',
    outFile: path.join(out, label + '.png') });
  const oracle = mode => {
    const result = path.join(out, mode + '-oracle.json');
    execFileSync('python3', [path.join(__dirname, 'partial-transfer-oracle.py'), '--serial', config.serial,
      '--manifest', manifest, '--source', source, '--mode', mode, '--out', result], { timeout: 60000 });
    return read(result);
  };
  try {
    state = await run('intent', { operation: 'start', operationId: path.basename(out), provider: 'flutter',
      goal: 'Cancel an actual in-progress LocalSend reception and verify the remaining file independently.',
      target: { platform: 'android', serial: config.serial, packageName: 'org.localsend.localsend_app.bridge_sample' },
      timeoutMs: 180000, recordingDir: path.join(out, 'recording') });
    active = state.operationId;
    assert(has(state, '通过链接接收'));
    peer = new OfficialPeer(fixture, out, config, [file]); await peer.offer(config);
    await observe(value => has(value, config.peerAlias) && has(value, '接受'), 'offer');
    await tap('接受');
    const progress = oracle('progress');
    await observe(value => has(value, '正在接收文件') && has(value, '取消') && !has(value, '已完成'), 'progress');
    await screenshot('in-progress');
    await tap('取消');
    await observe(value => has(value, '要取消文件传输吗？') && has(value, '继续') && has(value, '取消'), 'confirmation');
    await screenshot('cancel-confirmation');
    await tap('取消');
    await observe(value => has(value, '通过链接接收'), 'Receive');
    await screenshot('returned-to-receive');
    await peer.until(text => text.includes('Cancelled by receiver'), 'receiver_cancelled');
    const partial = oracle('partial');
    assert(partial.bytes >= progress.samples.at(-1).bytes && partial.bytes < file.bytes);
    state = await run('intent', { operation: 'decide', operationId: active, decision: {
      decisionId: `${path.basename(out)}-verified`, basedOnRevision: state.revision, agentDecision: 'complete',
      reason: 'Independent bytes grew before cancellation, then stabilized below the source size and match the source prefix. The official peer confirms receiver cancellation; the App returned to Receive.' } });
    write(path.join(out, 'report.json'), { ok: state.status === 'completed', operationId: active,
      startedAtMs, completedAtMs: Date.now(), progress, partial, file, status: state.status });
    active = null;
    console.log(JSON.stringify({ ok: true, elapsedMs: Date.now() - startedAtMs, bytes: partial.bytes, total: file.bytes }));
  } catch (error) {
    write(path.join(out, 'failure.json'), { error: error.message, operationId: active, status: state?.status }); throw error;
  } finally {
    if (active) {
      const cancelled = (await runCli('intent', { operation: 'cancel', operationId: active }, { cwd: ROOT, env })).value;
      write(path.join(out, 'cancel.json'), cancelled);
    }
    if (peer) await peer.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
