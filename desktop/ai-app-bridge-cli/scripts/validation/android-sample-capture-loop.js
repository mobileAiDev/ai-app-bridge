#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');

const PACKAGE = 'io.github.mobileaidev.aiappbridge.sample';
const ACTIVITY = `${PACKAGE}.debugbridge.DebugBridgeNativeTestActivity`;

// This function is serialized into a real Script child. All mobile data written by
// it is an explicitly requested validation artifact, never a Host capture cache.
async function sampleMain(ctx) {
  const fs = require('node:fs');
  const path = require('node:path');
  const out = ctx.inputs.out;
  const packageName = 'io.github.mobileaidev.aiappbridge.sample';
  const results = { positive: {}, negative: {}, references: {}, refs: {} };
  const write = () => fs.writeFileSync(path.join(out, 'script-results.json'), `${JSON.stringify(results, null, 2)}\n`);
  const log = (kind, value) => fs.appendFileSync(path.join(out, 'script-observations.jsonl'), `${JSON.stringify({ at: Date.now(), kind, value })}\n`);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const call = async (command, args = {}, options = {}) => {
    const response = await ctx.call(command, { feedback: 'off', ...args }, options);
    log(command, response);
    if (!response || response.ok !== true) throw new Error(`${command}:${response?.error || 'provider_not_ok'}`);
    return response;
  };
  const texts = (tree) => {
    const found = [];
    const visit = (value) => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (value == null || typeof value !== 'object') return;
      if (typeof value.text === 'string') found.push(value.text);
      Object.values(value).forEach(visit);
    };
    visit(tree);
    return found;
  };
  const stateItem = (response, counter) => response.result.items.find((item) => item.namespace === 'native_test'
    && item.key === 'screen' && item.value?.action === 'increment' && item.value.counter === counter);
  const complete = (response) => response.evidence.coverage.status === 'complete'
    && response.evidence.coverage.gap === false && response.evidence.coverage.committed === true
    && response.evidence.capture.hasMore === false;
  const poll = async (label, command, args, predicate, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    do {
      last = await call(command, args);
      if (predicate(last)) return last;
      await sleep(250);
    } while (Date.now() < deadline);
    throw new Error(`${label}:postcondition_timeout`);
  };
  const verdict = async (group, name, condition, evidence, requiredEvidence, expected) => {
    const assertion = { name, scope: 'device', condition, evidence, requiredEvidence, requireCoverage: 'complete' };
    const result = await ctx.assert(assertion);
    results[group][name] = result;
    log('assertion', { assertion, result, expected });
    write();
    if (result.verdict !== expected) throw new Error(`${name}:expected_${expected}_got_${result.verdict}`);
    return result;
  };
  const boundary = (response) => {
    if (!complete(response) || !response.evidence.capture.watermarkCursor || !response.evidence.capture.runtimeEpoch) {
      throw new Error('complete_pre_action_boundary_unavailable');
    }
    if (!Number.isFinite(response.evidence.window.sinceMs)) throw new Error('device_time_boundary_missing');
    return { factCursor: response.evidence.capture.watermarkCursor, runtimeEpoch: response.evidence.capture.runtimeEpoch, sinceMs: response.evidence.window.sinceMs, limit: 200 };
  };
  const concreteRef = (response, record, stream) => {
    const matches = response.evidence.refs.filter((ref) => ref.stream === stream && ref.captureId === record.id
      && ref.runtimeEpoch === response.evidence.capture.runtimeEpoch && ref.targetKey === packageName);
    if (matches.length !== 1 || typeof matches[0].mobileFactId !== 'string') throw new Error(`${stream}:record_ref_identity_missing`);
    return matches[0];
  };
  try {
    const beforeTree = await call('tree');
    const counterTexts = texts(beforeTree.result).filter((text) => /^Native counter: \d+$/.test(text));
    const counters = [...new Set(counterTexts)];
    if (counters.length !== 1) throw new Error('native_counter_baseline_not_unique');
    const initialCounter = Number(counters[0].slice('Native counter: '.length));
    const status = await call('status');
    if (status.result.app?.packageName !== packageName || !Number.isFinite(status.result.updatedAtMs)
      || !Number.isInteger(status.result.debugBridge?.port) || typeof status.result.debugBridge.runtimeEpoch !== 'string') throw new Error('sample_status_identity_missing');
    if (status.result.capturePersistence?.persistent !== true || status.result.capturePersistence?.lifecycleState !== 'OPEN'
      || status.result.debugBridge.version !== ctx.inputs.expectedSdkVersion) throw new Error('current_persistent_sample_required');
    const deviceSinceMs = status.result.updatedAtMs;
    const expectedUrl = `http://127.0.0.1:${status.result.debugBridge.port}/v1/logs?limit=1`;
    results.initialCounter = initialCounter;
    results.expectedCounter = initialCounter + 1;
    results.expectedUrl = expectedUrl;
    results.deviceSinceMs = deviceSinceMs;
    results.beforeEpoch = status.result.debugBridge.runtimeEpoch;
    write();

    const beforeState = await poll('state-baseline', 'state', { sinceMs: deviceSinceMs, runtimeEpoch: results.beforeEpoch, limit: 200 }, complete);
    const stateQuery = boundary(beforeState);
    results.references.stateBoundary = beforeState.evidence;
    const increment = await call('tap-text', { targetText: 'Native Increment', appLocalAction: true });
    results.increment = increment.execution;
    const afterState = await poll('counter-state', 'state', stateQuery,
      (response) => complete(response) && Boolean(stateItem(response, initialCounter + 1)));
    results.references.state = afterState.evidence;
    results.stateRecord = stateItem(afterState, initialCounter + 1);
    results.refs.state = concreteRef(afterState, results.stateRecord, 'state');
    const afterTree = await call('tree');
    results.references.tree = afterTree.evidence;
    await verdict('positive', 'counter-state-incremented', Boolean(stateItem(afterState, initialCounter + 1)), afterState.evidence, ['state'], 'passed');
    await verdict('positive', 'counter-tree-incremented', texts(afterTree.result).includes(`Native counter: ${initialCounter + 1}`), afterTree.evidence, ['tree'], 'passed');
    await verdict('negative', 'old-tree-rejected', true, beforeTree.evidence, ['tree'], 'inconclusive');
    await verdict('negative', 'missing-evidence-rejected', true, { coverage: { status: 'complete', gap: false, committed: true }, refs: [] }, ['state'], 'inconclusive');
    await verdict('negative', 'wrong-counter-expectation', Boolean(stateItem(afterState, initialCounter + 1000)), afterState.evidence, ['state'], 'failed');
    results.counterScreenshot = await call('screenshot', { outFile: path.join(out, 'counter-after.png') });
    write();

    // A device timestamp bounds the fresh network baseline; no Host/device clock equivalence is assumed.
    const networkClock = await call('status');
    if (networkClock.result.debugBridge?.runtimeEpoch !== results.beforeEpoch) throw new Error('runtime_epoch_changed_during_flow');
    const beforeNetwork = await poll('network-baseline', 'network', { sinceMs: networkClock.result.updatedAtMs, runtimeEpoch: results.beforeEpoch, limit: 200 }, complete);
    const networkQuery = boundary(beforeNetwork);
    results.references.networkBoundary = beforeNetwork.evidence;
    const networkAction = await call('tap-text', { targetText: 'Run OkHttp Auto Capture', appLocalAction: true });
    results.networkAction = networkAction.execution;
    const networkUi = await poll('network-ui', 'tree', {}, (response) => texts(response.result).includes('OkHttp auto capture: HTTP 200'));
    const networkItem = (response) => response.result.items.find((item) => item.source === 'okhttp-auto'
      && item.method === 'GET' && item.url === expectedUrl && item.statusCode === 200 && item.error == null);
    const afterNetwork = await poll('automatic-http-200', 'network', networkQuery,
      (response) => complete(response) && Boolean(networkItem(response)));
    results.references.network = afterNetwork.evidence;
    results.networkRecord = networkItem(afterNetwork);
    results.refs.network = concreteRef(afterNetwork, results.networkRecord, 'network');
    results.afterEpoch = afterNetwork.evidence.capture.runtimeEpoch;
    results.references.networkTree = networkUi.evidence;
    await verdict('positive', 'network-ui-http-200', texts(networkUi.result).includes('OkHttp auto capture: HTTP 200'), networkUi.evidence, ['tree'], 'passed');
    await verdict('positive', 'automatic-own-app-http-200', Boolean(networkItem(afterNetwork)), afterNetwork.evidence, ['network'], 'passed');
    results.networkScreenshot = await call('screenshot', { outFile: path.join(out, 'network-after.png') });
    results.status = 'verified';
    write();
    return { outputPath: path.join(out, 'script-results.json'), positive: results.positive, negative: results.negative };
  } catch (error) {
    results.status = 'failed'; results.error = error.message || String(error); write(); throw error;
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--serial', '--out'].includes(argv[index]) || !argv[index + 1]) throw new Error('usage: android-sample-capture-loop.js --serial <serial> --out <new-directory>');
    options[argv[index].slice(2)] = argv[index + 1];
  }
  if (!options.serial || !options.out) throw new Error('--serial and --out are required');
  options.out = path.resolve(options.out);
  return options;
}

async function main(options) {
  if (fs.existsSync(options.out) && fs.readdirSync(options.out).length > 0) throw new Error('output_directory_not_empty');
  fs.mkdirSync(options.out, { recursive: true });
  const write = (name, value) => fs.writeFileSync(path.join(options.out, name), `${JSON.stringify(value, null, 2)}\n`);
  const client = createMcpClient({ serverPath: path.resolve(__dirname, '../../bin/mcp-server.js'),
    transcriptPath: path.join(options.out, 'mcp-transcript.jsonl'), stderrPath: path.join(options.out, 'mcp-stderr.log'),
    env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(options.out, 'host-facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' } });
  const report = { ok: false, status: 'running', scope: 'android-native-sample-ui-state-network', target: { serial: options.serial, packageName: PACKAGE }, startedAt: new Date().toISOString() };
  write('report.json', report);
  let operationId;
  const run = async (command, args) => payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
  try {
    await client.initialize();
    const status = await run('status', { ...report.target, feedback: 'off' });
    write('preflight-status.json', status);
    if (status.ok !== true || status.app?.packageName !== PACKAGE || status.activity?.current !== ACTIVITY) {
      throw new Error('sample_native_test_activity_required');
    }
    if (status.capturePersistence?.persistent !== true || status.capturePersistence?.lifecycleState !== 'OPEN'
      || status.debugBridge?.version !== require('../../package.json').version) throw new Error('current_persistent_sample_required');
    const sourcePath = path.join(options.out, 'script.js');
    fs.writeFileSync(sourcePath, `'use strict';\nmodule.exports.main = ${sampleMain.toString()};\n`);
    const start = await run('script', { operation: 'start', script: { schemaVersion: 'aab.code-script/v1', name: 'native-sample-capture-loop', language: 'javascript', sourcePath,
      target: { platform: 'android', ...report.target }, inputs: { out: options.out, expectedSdkVersion: require('../../package.json').version }, policy: { timeoutMs: 120000, restartPolicy: 'none' } } });
    write('script-start.json', start);
    if (start.ok !== true) throw new Error(`script_start:${start.error}`);
    operationId = start.operationId;
    let current = start;
    const deadline = Date.now() + 150000;
    while (!['completed', 'failed', 'cancelled'].includes(current.status)) {
      if (Date.now() > deadline) throw new Error('script_observation_deadline');
      current = await run('script', { operation: 'wait', operationId, waitMs: 1000, afterSequence: current.eventSequence || 0 });
      if (current.ok !== true) throw new Error(`script_wait:${current.error}`);
      if (['paused', 'intervention_required'].includes(current.status)) throw new Error(`script_needs_attention:${current.status}`);
    }
    const full = await run('script', { operation: 'status', operationId, afterSequence: 0, limit: 4096 });
    write('script-final.json', full);
    report.executionStatus = current.status;
    const resultsPath = path.join(options.out, 'script-results.json');
    const results = fs.existsSync(resultsPath) ? JSON.parse(fs.readFileSync(resultsPath, 'utf8')) : null;
    report.results = results;
    if (results) {
      report.refs = results.refs;
      report.beforeEpoch = results.beforeEpoch;
      report.afterEpoch = results.afterEpoch;
      report.expectedStateCounter = results.expectedCounter;
      report.expectedNetworkUrl = results.expectedUrl;
      report.positiveAssertions = results.positive;
      report.negativeAssertions = results.negative;
    }
    const expectedPositive = ['counter-state-incremented', 'counter-tree-incremented', 'network-ui-http-200', 'automatic-own-app-http-200'];
    const verified = current.status === 'completed' && results?.status === 'verified'
      && expectedPositive.every((name) => results.positive[name]?.verdict === 'passed')
      && results.negative['old-tree-rejected']?.verdict === 'inconclusive'
      && results.negative['missing-evidence-rejected']?.verdict === 'inconclusive'
      && results.negative['wrong-counter-expectation']?.verdict === 'failed';
    report.status = verified ? 'passed' : 'failed';
    report.ok = verified;
    report.note = 'The expected negative failed assertion is recorded separately and must not be counted as a positive acceptance failure.';
    report.completedAt = new Date().toISOString();
    write('report.json', report);
    return report;
  } catch (error) {
    if (operationId) {
      try { write('cancel-response.json', await run('script', { operation: 'cancel', operationId })); } catch (cancelError) { report.cancelError = cancelError.message; }
    }
    report.status = 'failed'; report.error = error.message || String(error); write('report.json', report); throw error;
  } finally { await client.close(); }
}

if (require.main === module) Promise.resolve().then(() => main(parseArguments(process.argv.slice(2))))
  .then((report) => { console.log(JSON.stringify({ status: report.status, target: report.target })); process.exitCode = report.status === 'passed' ? 0 : 1; })
  .catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { main, sampleMain, parseArguments };
