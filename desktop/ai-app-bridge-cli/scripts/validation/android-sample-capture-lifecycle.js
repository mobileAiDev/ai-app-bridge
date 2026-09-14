#!/usr/bin/env node
'use strict';

// Explicit sample-only maintenance validation. Never discovered by node --test.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');
const executeFile = promisify(execFile);
const PACKAGE = 'io.github.mobileaidev.aiappbridge.sample';
const SERVER = path.resolve(__dirname, '../../bin/mcp-server.js');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--serial', '--loop-report', '--out', '--adb'].includes(argv[index]) || !argv[index + 1]) throw new Error('Require --serial, --loop-report and --out');
    options[argv[index].slice(2)] = argv[index + 1];
  }
  if (!options.serial || !options['loop-report'] || !options.out) throw new Error('Require --serial, --loop-report and --out');
  const source = JSON.parse(fs.readFileSync(options['loop-report'], 'utf8'));
  assert.equal(source.ok, true, 'A successful real sample loop is required');
  assert.equal(source.target.packageName, PACKAGE);
  assert.equal(source.target.serial, options.serial);
  assert.ok(source.refs.state.mobileFactId && source.refs.network.mobileFactId);
  const directory = path.resolve(options.out);
  fs.mkdirSync(directory, { recursive: false });
  const target = { serial: options.serial, packageName: PACKAGE, adb: options.adb || 'adb', feedback: 'off' };
  const report = { schemaVersion: 'aab.sample-capture-lifecycle/v1', target, startedAt: new Date().toISOString(), source: path.resolve(options['loop-report']), checks: [], ok: false };
  const save = () => fs.writeFileSync(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const record = (name, value) => { fs.writeFileSync(path.join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`); return value; };
  let client;
  let appStopped = false;
  let hostIndex = 0;
  async function newHost() {
    if (client) await client.close();
    hostIndex += 1;
    client = createMcpClient({ serverPath: SERVER, transcriptPath: path.join(directory, `host-${hostIndex}.jsonl`), stderrPath: path.join(directory, `host-${hostIndex}.log`), env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'host-facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' } });
    await client.initialize();
  }
  async function run(command, args = {}) {
    return payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: { ...target, ...args } } }));
  }
  async function ready() {
    const deadline = Date.now() + 20_000;
    let status;
    do {
      status = await run('status');
      if (status.ok && status.app?.packageName === PACKAGE && status.capturePersistence?.persistent === true
        && status.capturePersistence.lifecycleState === 'OPEN' && status.capturePersistence.attachmentState === 'attached') return status;
      await delay(300);
    } while (Date.now() < deadline);
    throw new Error(`Sample persistence did not become ready: ${JSON.stringify(status)}`);
  }
  async function refsAt(stage) {
    const pages = {};
    for (const stream of ['state', 'network']) {
      const page = record(`${stage}-${stream}`, await run(stream, { view: 'connected-history', mobileFactId: source.refs[stream].mobileFactId, limit: 1 }));
      assert.equal(page.ok, true, JSON.stringify(page));
      assert.equal(page.coverage.status, 'complete');
      assert.equal(page.coverage.committed, true);
      assert.equal(page.refs.length, 1);
      assert.equal(page.refs[0].mobileFactId, source.refs[stream].mobileFactId);
      assert.equal(page.refs[0].runtimeEpoch, source.refs[stream].runtimeEpoch);
      assert.equal(page.refs[0].targetKey, PACKAGE);
      if (stream === 'state') assert.equal(page.items[0].value.counter, source.expectedStateCounter);
      else { assert.equal(page.items[0].url, source.expectedNetworkUrl); assert.equal(page.items[0].statusCode, 200); }
      pages[stream] = page;
    }
    report.checks.push({ name: stage, verdict: 'passed', refs: Object.fromEntries(Object.entries(pages).map(([key, page]) => [key, page.refs[0]])) });
    save();
  }
  try {
    await newHost();
    const initial = record('initial-status', await ready());
    report.sdkVersion = initial.debugBridge.version;
    assert.equal(initial.debugBridge.runtimeEpoch, source.refs.state.runtimeEpoch, 'Use the current completed loop, not a stale report');
    assert.equal(initial.debugBridge.runtimeEpoch, source.refs.network.runtimeEpoch);
    await refsAt('fresh-host');

    // Synthetic retention pressure is explicitly separate from UI/business evidence.
    const liveBefore = record('before-pressure-legacy-state', await run('state', { limit: 500 }));
    assert.equal(liveBefore.ok, true);
    assert.ok(liveBefore.items.some((item) => item.id === source.refs.state.captureId && item.namespace === 'native_test' && item.key === 'screen' && item.value?.counter === source.expectedStateCounter), 'The original UI state must be present before testing Legacy view eviction');
    const port = initial.debugBridge.port;
    const receipts = [];
    for (let index = 0; index < 225; index += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ namespace: 'aab_lifecycle_fixture', key: `retention-${index}`, value: { fixture: true, index } }), signal: AbortSignal.timeout(5000) });
      const receipt = await response.json();
      assert.equal(response.status, 200); assert.equal(receipt.ok, true);
      receipts.push(receipt);
    }
    record('synthetic-retention-receipts', receipts);
    const bounded = record('bounded-legacy-state', await run('state', { limit: 500 }));
    assert.equal(bounded.ok, true);
    assert.ok(bounded.items.length > 0 && bounded.items.length <= 200, 'Legacy is bounded by both count and byte budgets');
    assert.ok(bounded.items.some((item) => item.namespace === 'aab_lifecycle_fixture' && item.value?.index === 224), 'The last synthetic fixture must be committed and readable');
    assert.deepEqual(bounded.items.map((item) => {
      assert.equal(item.namespace, 'aab_lifecycle_fixture');
      assert.equal(item.key, `retention-${item.value.index}`);
      return item.value.index;
    }).sort((a, b) => a - b), Array.from({ length: bounded.items.length }, (_, index) => index + 225 - bounded.items.length));
    report.pressure = { httpHandlerAcknowledgements: 225, committedLegacyTailRecords: bounded.items.length, expectedLastIndex: 224, scope: 'Synthetic count/byte-bounded Legacy view eviction; not physical disk quota exhaustion' };
    assert.equal(bounded.items.some((item) => item.id === source.refs.state.captureId), false, 'Original record must leave the bounded Legacy view');
    await refsAt('after-legacy-view-eviction');

    await executeFile(target.adb, ['-s', target.serial, 'shell', 'am', 'force-stop', PACKAGE]);
    appStopped = true;
    const unavailable = record('runtime-stopped-query', await run('state', { view: 'connected-history', mobileFactId: source.refs.state.mobileFactId }));
    assert.equal(unavailable.ok, false, JSON.stringify(unavailable));
    assert.ok(!unavailable.items || unavailable.items.length === 0, 'A disconnected runtime must not return copied phone payloads');
    report.checks.push({ name: 'runtime-stopped-no-host-fallback', verdict: 'passed', error: unavailable.error, scope: 'App process stopped; USB remained connected' }); save();

    await newHost();
    record('restart-launch', await run('launch-activity', { activity: `${PACKAGE}.debugbridge.DebugBridgeNativeTestActivity` }));
    appStopped = false;
    const restarted = record('restart-status', await ready());
    assert.notEqual(restarted.debugBridge.runtimeEpoch, initial.debugBridge.runtimeEpoch);
    await refsAt('after-app-and-host-restart');
    const stale = record('stale-epoch-query', await run('state', { view: 'decision-window', runtimeEpoch: initial.debugBridge.runtimeEpoch }));
    assert.equal(stale.ok, false);
    assert.equal(stale.error || stale.reason, 'runtime_epoch_changed');
    report.checks.push({ name: 'stale-decision-epoch-rejected', verdict: 'passed' }); save();

    const clear = record('clear-sample-data', await run('clear-app-data', { method: 'runtime' }));
    assert.equal(clear.ok, true, JSON.stringify(clear));
    assert.equal(clear.method, 'bridge-runtime', 'This check specifically validates SDK clear and persistent writer reattachment');
    const cleared = record('after-clear-status', await ready());
    for (const stream of ['state', 'network']) {
      const absent = record(`after-clear-${stream}`, await run(stream, { view: 'connected-history', mobileFactId: source.refs[stream].mobileFactId, limit: 1 }));
      assert.equal(absent.ok, false, JSON.stringify(absent));
      assert.equal(absent.error || absent.reason, 'mobile_fact_unavailable');
      assert.equal(absent.refs?.length || 0, 0);
    }
    report.checks.push({ name: 'clear-invalidates-old-mobile-refs', verdict: 'passed', persistentAfterClear: cleared.capturePersistence.persistent });
    report.ok = true;
  } catch (error) {
    report.error = error.stack || String(error);
    process.exitCode = 1;
  } finally {
    if (appStopped && client) {
      try { record('cleanup-launch', await run('launch-activity', { activity: `${PACKAGE}.debugbridge.DebugBridgeNativeTestActivity` })); } catch (error) { report.cleanupError = error.message; }
    }
    if (client) await client.close();
    report.finishedAt = new Date().toISOString(); save();
  }
  process.stdout.write(`${JSON.stringify({ ok: report.ok, checks: report.checks, error: report.error, report: path.join(directory, 'report.json') }, null, 2)}\n`);
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
module.exports = { main };
