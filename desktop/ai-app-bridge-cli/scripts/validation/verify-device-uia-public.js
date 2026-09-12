#!/usr/bin/env node
'use strict';

// Public packaged Host -> real OPPO UIA -> independent sample SDK observation.
// The SIGKILL case injects a Host crash on receipt of start response headers;
// it does not claim that the Android callback was still pending at that moment.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');

async function javascriptFlow(ctx) {
  const action = await ctx.call('tap-uia-text', { targetText: 'Native Increment', feedback: 'off' });
  if (!action.ok || action.result.executionReceipt?.kind !== 'uia-node') throw new Error(JSON.stringify(action));
  const read = await ctx.call('tree', { compact: true });
  if (!read.ok) throw new Error(JSON.stringify(read));
  const values = [...new Set([...JSON.stringify(read.result).matchAll(/Native counter: (\d+)/g)].map(m => Number(m[1])))];
  const checked = await ctx.assert({ name: 'independent SDK counter after UIA node click',
    condition: values.length === 1 && values[0] === ctx.inputs.expected,
    requiredEvidence: ['tree'], evidence: read.evidence });
  const picture = await ctx.call('screenshot', { outFile: ctx.inputs.screenshot, feedback: 'off' });
  if (!picture.ok) throw new Error(JSON.stringify(picture));
  return { values, assertions: [checked], executionReceipt: action.result.executionReceipt };
}

const pythonSource = String.raw`import json, re
def main(ctx):
    action = ctx.call('tap-uia-text', {'targetText': 'Native Increment', 'feedback': 'off'})
    if not action['ok'] or action['result']['executionReceipt']['kind'] != 'uia-node': raise Exception(str(action))
    read = ctx.call('tree', {'compact': True})
    if not read['ok']: raise Exception(str(read))
    values = sorted(set(int(n) for n in re.findall(r'Native counter: (\d+)', json.dumps(read['result']))))
    checked = ctx.assert_({'name': 'independent SDK counter after UIA node click',
        'condition': values == [ctx.inputs['expected']], 'requiredEvidence': ['tree'], 'evidence': read['evidence']})
    picture = ctx.call('screenshot', {'outFile': ctx.inputs['screenshot'], 'feedback': 'off'})
    if not picture['ok']: raise Exception(str(picture))
    return {'values': values, 'assertions': [checked], 'executionReceipt': action['result']['executionReceipt']}
`;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function proofs(value, collected = new Map()) {
  if (value && typeof value === 'object') {
    if (value.kind === 'uia-node' && value.settled === true && typeof value.receiptJson === 'string') {
      assert.equal(sha256(value.receiptJson), value.responseSha256);
      const receipt = JSON.parse(value.receiptJson);
      assert.equal(receipt.actionId, value.actionId); assert.equal(receipt.requestSha256, value.requestSha256);
      collected.set(value.actionId, value);
    }
    for (const child of Object.values(value)) proofs(child, collected);
  }
  return collected;
}

async function main({ out, serverPath, serial }) {
  assert.ok(['FYZLAU49X8OVQGJ7', 'b46093e6'].includes(serial), 'Only the authorized OPPO serials are supported by this validator');
  fs.mkdirSync(out); fs.copyFileSync(__filename, path.join(out, 'controller.js'));
  const packageName = 'io.github.mobileaidev.aiappbridge.sample', target = { serial, packageName };
  const save = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
  const adb = args => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  const { device, apkSha256 } = require('./uia-sample-target').verifyUiaSampleTarget(adb, serial);
  const env = { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' };
  const clients = [];
  const open = async (name, overrides = {}) => {
    const client = createMcpClient({ serverPath, env: { ...env, ...overrides },
      transcriptPath: path.join(out, `${name}.jsonl`), stderrPath: path.join(out, `${name}.stderr`) });
    clients.push(client); await client.initialize(); return client;
  };
  let sequence = 0;
  const withClient = client => async (command, args) => {
    const result = payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
    save(`${String(++sequence).padStart(3, '0')}-${command}.json`, result); return result;
  };
  const good = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
  const report = { ok: false, target, device, apkSha256, serverPath, controllerSha256: sha256(fs.readFileSync(__filename)), cases: [] };
  let run;
  async function counter(expected) {
    const deadline = Date.now() + 5000;
    for (;;) {
      const tree = good(await run('tree', { ...target, compact: true, feedback: 'off' }));
      const values = [...new Set([...JSON.stringify(tree).matchAll(/Native counter: (\d+)/g)].map(m => Number(m[1])))];
      assert.equal(values.length, 1, JSON.stringify(values));
      if (expected === undefined || values[0] === expected) return values[0];
      assert.ok(Date.now() < deadline, `Expected counter ${expected}, observed ${values[0]}`); await delay(100);
    }
  }
  async function archive(namespace, operationId, name, actionId) {
    const exported = good(await run('evidence', { operation: 'export', namespace, operationId,
      outputDir: path.join(out, `${name}-archive`), includeRecordedPayloads: true }));
    const records = JSON.parse(fs.readFileSync(path.join(exported.archiveDir, 'records.json')));
    assert.ok(proofs(records).has(actionId), 'The original UIA completion must survive export');
    return exported;
  }
  try {
    const client = await open('public-mcp'); run = withClient(client);
    assert.equal(good(await run('device-ownership', { operation: 'status', serial })).active, 0);
    const status = good(await run('status', { ...target, full: true, feedback: 'off' }));
    assert.ok(JSON.stringify(status).includes('DebugBridgeNativeTestActivity'));
    report.before = await counter(); let expected = report.before;
    good(await run('screenshot', { ...target, outFile: path.join(out, 'before.png'), feedback: 'off' }));
    const direct = good(await run('tap-uia-text', { ...target, targetText: 'Native Increment', requestId: `public-mcp:${Date.now()}`, feedback: 'off' }));
    assert.equal(direct.executionReceipt.kind, 'uia-node'); await counter(++expected);
    report.cases.push({ name: 'ordinary-mcp', actionId: direct.actionId, executionReceipt: direct.executionReceipt, counter: expected, history: direct._history });

    let intent = good(await run('intent', { operation: 'start', operationId: `public-uia-intent-${Date.now()}`, target: { platform: 'android', ...target }, provider: 'uia',
      goal: 'Click the observed Native Increment node once; compare the independent SDK counter.', timeoutMs: 30000, recordingDir: path.join(out, 'intent-recording') }));
    assert.equal(intent.status, 'waiting_for_decision');
    intent = good(await run('intent', { operation: 'decide', operationId: intent.operationId, decision: {
      decisionId: 'observed-increment', basedOnRevision: intent.revision, agentDecision: 'act',
      action: { provider: 'uia', action: 'tap', selector: { text: 'Native Increment' } } } }));
    await counter(++expected);
    intent = good(await run('intent', { operation: 'decide', operationId: intent.operationId, decision: {
      decisionId: 'done', basedOnRevision: intent.revision, agentDecision: 'complete' } }));
    assert.equal(intent.status, 'completed');
    const intentId = `${intent.operationId}:observed-increment`;
    report.cases.push({ name: 'intent', namespace: 'intent', operationId: intent.operationId, status: intent.status, actionId: intentId, counter: expected,
      archive: await archive('intent', intent.operationId, 'intent', intentId) });

    for (const [name, language, negative] of [['javascript', 'javascript', false], ['python', 'python', false], ['wrong-expectation', 'javascript', true]]) {
      const script = { schemaVersion: 'aab.code-script/v1', language, target: { platform: 'android', ...target },
        source: language === 'javascript' ? `module.exports.main = ${javascriptFlow.toString()};` : pythonSource,
        inputs: { expected: expected + (negative ? 2 : 1), screenshot: path.join(out, `${name}.png`) },
        permissions: ['app.read', 'app.interact'], policy: { timeoutMs: 20000 } };
      save(`${name}-spec.json`, script);
      const startedAt = Date.now();
      let state = good(await run('script', { operation: 'start', script, recordingDir: path.join(out, `${name}-recording`) }));
      const deadline = Date.now() + 25000;
      while (!['completed', 'failed', 'cancelled'].includes(state.status)) {
        assert.ok(Date.now() < deadline); state = await run('script', { operation: 'wait', operationId: state.operationId, afterSequence: state.eventSequence, waitMs: 1000 });
      }
      state = await run('script', { operation: 'status', operationId: state.operationId });
      assert.equal(state.status, 'completed', JSON.stringify(state));
      const resultEnvelope = await run('script', { operation: 'result', operationId: state.operationId });
      assert.equal(resultEnvelope.ok, true, JSON.stringify(resultEnvelope)); assert.equal(resultEnvelope.persisted, true);
      const result = resultEnvelope.result;
      assert.equal(result.assertions[0].verdict, negative ? 'failed' : 'passed');
      await counter(++expected); assert.deepEqual(result.values, [expected]);
      const actionId = result.executionReceipt.actionId;
      assert.ok(actionId.includes(state.operationId));
      report.cases.push({ name, namespace: 'script', operationId: state.operationId, status: state.status, elapsedMs: Date.now() - startedAt,
        actionId, assertion: result.assertions[0].verdict, counter: expected,
        archive: await archive('script', state.operationId, name, actionId) });
    }

    const crashId = `public-uia-killed:${Date.now()}`, marker = path.join(out, 'crash-point.json');
    const injector = path.join(out, 'host-start-response-kill.cjs');
    fs.writeFileSync(injector, `const http = require('node:http');
const original = http.request;
http.request = function(url, options, callback) {
  let identity;
  const request = original.call(this, url, options, response => {
    if (identity) {
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ point: 'original start HTTP response headers, before Host parsing', ...identity, statusCode: response.statusCode }));
      process.kill(process.pid, 'SIGKILL'); return;
    }
    callback(response);
  });
  const end = request.end;
  request.end = function(body, ...rest) {
    if (typeof body === 'string') { const payload = JSON.parse(body);
      if (payload.op === 'start' && payload.requestJson) { const action = JSON.parse(payload.requestJson);
        if (action.actionId === ${JSON.stringify(crashId)}) identity = { actionId: action.actionId, requestSha256: payload.requestSha256, runtimeEpoch: action.runtimeEpoch };
      }
    }
    return end.call(this, body, ...rest);
  };
  return request;
};
`);
    const stdout = fs.openSync(path.join(out, 'killed-cli.stdout'), 'w'), stderr = fs.openSync(path.join(out, 'killed-cli.stderr'), 'w');
    const child = spawn(process.execPath, [path.join(path.dirname(serverPath), 'ai-app-bridge.js'), 'tap-uia-text', '--serial', serial,
      '--package-name', packageName, '--target-text', 'Native Increment', '--request-id', crashId, '--feedback', 'off'],
    { env: { ...process.env, ...env, NODE_OPTIONS: `--require=${injector}` }, stdio: ['ignore', stdout, stderr] });
    const [code, signal] = await once(child, 'close'); fs.closeSync(stdout); fs.closeSync(stderr);
    assert.equal(code, null); assert.equal(signal, 'SIGKILL'); assert.equal(JSON.parse(fs.readFileSync(marker)).actionId, crashId);
    const ownership = good(await run('device-ownership', { operation: 'status', serial }));
    assert.equal(ownership.phase, 'unresolved'); assert.equal(ownership.ownership.pending.actionId, crashId);
    const blocked = await run('tap-uia-text', { ...target, targetText: 'Native Increment', feedback: 'off' });
    assert.equal(blocked.error, 'device_ownership_unresolved');
    await counter(++expected);
    const recovered = good(await run('device-ownership', { operation: 'reconcile', serial }));
    assert.equal(recovered.executionReceipt.actionId, crashId); assert.equal(recovered.executionReceipt.dispatched, true);
    await counter(expected); assert.equal(good(await run('device-ownership', { operation: 'status', serial })).active, 0);
    report.cases.push({ name: 'host-killed-before-start-response-parsing', actionId: crashId, signal, blocked: blocked.error,
      executionReceipt: recovered.executionReceipt, counter: expected, admissionPendingAtSignal: 'not independently established' });
    good(await run('screenshot', { ...target, outFile: path.join(out, 'after.png'), feedback: 'off' }));
    report.runtime = good(await run('uia-runtime', { operation: 'status', serial }));
    assert.equal(report.runtime.pending, 0);
    report.after = expected;
    report.runtimeStop = good(await run('uia-runtime', { operation: 'stop', serial }));
    assert.equal(report.runtimeStop.running, false);
    assert.deepEqual(await client.close({ stdinEof: true }), { code: 0, signal: null });

    const reopened = await open('reopened'); run = withClient(reopened);
    for (const item of report.cases.filter(item => item.namespace)) {
      const state = await run(item.namespace, { operation: 'status', operationId: item.operationId });
      assert.equal(state.status, item.status);
      if (item.namespace === 'intent') {
        assert.equal(state.recovered, true); assert.equal(state.live, false); assert.equal(state.restartPolicy, 'none');
      } else {
        assert.equal(state.restored, true); assert.equal(state.persisted, true); assert.equal(state.resumable, false);
      }
      item.recovered = true;
    }
    await reopened.close();
    const unusable = path.join(out, 'no-fact-store'); fs.writeFileSync(unusable, 'not a directory');
    const offline = await open('offline', { AI_APP_BRIDGE_FACT_STORE_DIR: unusable, ADB: path.join(out, 'no-adb') }); run = withClient(offline);
    for (const item of report.cases.filter(item => item.archive)) {
      const moved = path.join(out, `${item.name}-moved-archive`); fs.cpSync(item.archive.archiveDir, moved, { recursive: true });
      item.offline = good(await run('evidence', { operation: 'verify', archiveDir: moved, manifestSha256: item.archive.manifestSha256 }));
    }
    report.ok = true; return report;
  } catch (error) { report.error = error.stack; throw error; }
  finally {
    for (const client of clients) await client.close();
    save('report.json', report);
  }
}

if (require.main === module) main({ out: path.resolve(process.argv[2]), serverPath: path.resolve(process.argv[3]), serial: process.argv[4] })
  .then(report => process.stdout.write(JSON.stringify({ ok: report.ok, before: report.before, after: report.after, cases: report.cases.map(c => ({ name: c.name, counter: c.counter })) }) + '\n'))
  .catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
module.exports = { main };
