'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createIOSRuntimeFixture } = require('../test-support/ios-runtime-fixture');
const { createMcpClient, payloadOf } = require('../scripts/validation/mcp-jsonrpc-client');
const { createIOSIntentDeviceAdapter } = require('../bin/intent/ios-intent-adapter');

function node(id, text, action, value) {
  return { id, text, value, visible: true, enabled: true,
    role: action === 'scroll' ? 'scrollable' : action === 'input' ? 'input' : 'button',
    [action]: { bounds: { left: 10, top: 10, right: 100, bottom: 60 } },
    targetRef: { schemaVersion: 'aab.flutter-target/v1', runtimeEpoch: 'engine-1', elementId: id, guard: `guard-${id}` } };
}

// This is the public MCP -> production iOS adapter -> HTTP/child-process seam.
// It verifies execution contracts, not LocalSend or physical-device acceptance.
async function fixture(t) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-ios-intent-script-'));
  let page = 'Receive', name = '', scroll = 0, tick = 0, keyboardVisible = false;
  const actions = [];
  function tree() {
    const nodes = page === 'Receive' ? [node('settings', 'Settings', 'tap')]
      : [node('name', 'Device name', 'input', name), node('settings-list', 'Preferences', 'scroll')];
    return { nodes, count: nodes.length, truncated: false, updatedAtMs: ++tick,
      runtimeEpoch: 'engine-1', viewport: { logicalWidth: 390, logicalHeight: 844 }, page, scroll, keyboardVisible };
  }
  const server = http.createServer(async (req, res) => {
    let bytes = ''; for await (const chunk of req) bytes += chunk;
    const send = value => res.end(JSON.stringify({ ...value, runtimeBinding: device.binding }));
    if (['/v1/status', '/v1/flutter/snapshot'].includes(req.url)) return send({ ok: true,
      debugBridge: { flutterExecutionSchema: 'aab.flutter-execution/v1' }, flutter: { layout: { operable: tree() } } });
    if (req.url === '/v1/flutter/action') {
      const body = JSON.parse(bytes);
      if (!['back', 'hideKeyboard'].includes(body.action)) {
        const selected = tree().nodes.find(item => item.id === body.targetRef?.elementId);
        if (!selected || selected.targetRef.guard !== body.targetRef.guard) {
          return send({ ok: false, error: 'flutter_target_changed', dispatched: false, ambiguous: false });
        }
      }
      actions.push(body);
      if (body.action === 'tapTarget') page = 'Settings';
      else if (body.action === 'inputText') { name = body.text; keyboardVisible = true; }
      else if (body.action === 'hideKeyboard') keyboardVisible = false;
      else if (body.action === 'scrollBy') scroll += body.delta;
      else if (body.action === 'back') page = 'Receive';
      const { timeoutMs, ...identity } = body.execution;
      return send({ ok: true, handled: true, actionId: body.actionId, runtimeEpoch: identity.runtimeEpoch,
        settled: true, dispatched: true, ambiguous: false, execution: { ...identity, settled: true } });
    }
    res.statusCode = 404; send({ ok: false, error: 'unsupported_fixture_route' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const device = createIOSRuntimeFixture(out, { deviceId: path.basename(out), bundleId: 'sample.flutter', port: server.address().port });
  const target = { platform: 'ios', ...device.args };
  const client = createMcpClient({ serverPath: path.resolve(__dirname, '../bin/mcp-server.js'),
    transcriptPath: path.join(out, 'mcp.jsonl'), stderrPath: path.join(out, 'stderr.log'),
    env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR: path.join(out, 'ownership'),
      AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb', ADB: path.join(out, 'forbidden-adb') } });
  t.after(async () => {
    await client.close({ stdinEof: true });
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    fs.rmSync(out, { recursive: true, force: true });
  });
  await client.initialize();
  const run = async (command, args) => payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
  return { target, run, actions, tree };
}

test('public iOS Intent observes, taps, replaces input, scrolls and returns with original action IDs', async t => {
  const h = await fixture(t);
  let result = await h.run('intent', { operation: 'start', goal: 'Change and verify the sample name', target: h.target,
    provider: 'flutter', timeoutMs: 30000 });
  assert.equal(result.ok, true, JSON.stringify(result));
  const operationId = result.operationId;
  const steps = [
    { action: 'tap', selector: { text: 'Settings' } },
    { action: 'inputText', selector: { text: 'Device name' }, value: '收发设备' },
    { action: 'hideKeyboard' },
    { action: 'scrollBy', selector: { nodeId: 'settings-list' }, delta: 250 },
    { action: 'back' },
  ];
  for (const [index, action] of steps.entries()) {
    result = await h.run('intent', { operation: 'decide', operationId, decision: { decisionId: `step-${index}`,
      basedOnRevision: result.revision, agentDecision: 'act', action } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(h.actions[index].actionId, `${operationId}:step-${index}`);
    assert.equal(h.actions[index].execution.runtimeEpoch, 'engine-1');
    if (action.action === 'inputText') assert.equal(h.tree().keyboardVisible, true);
    if (action.action === 'hideKeyboard') assert.equal(h.tree().keyboardVisible, false);
  }
  assert.equal(h.tree().page, 'Receive');
  assert.equal(h.tree().scroll, 250);
  result = await h.run('intent', { operation: 'decide', operationId, decision: { decisionId: 'done',
    basedOnRevision: result.revision, agentDecision: 'complete' } });
  assert.equal(result.status, 'completed', JSON.stringify(result));
});

for (const language of ['javascript', 'python']) {
  test(`public ${language} Script uses iOS controls and fresh device assertions without Android admission`, async t => {
    const h = await fixture(t);
    const js = `module.exports.main = async ctx => {
      const first = await ctx.call('ios-flutter-nodes', {feedback:'off'});
      await ctx.assert({name:'receive', condition:first.result.page==='Receive', requiredEvidence:['tree'], evidence:first.evidence});
      for (const [command,args] of [
        ['ios-tap-flutter',{selector:{text:'Settings'}}],
        ['ios-input-flutter-text',{selector:{text:'Device name'},text:'收发设备'}],
        ['ios-flutter-hide-keyboard',{}],
        ['ios-scroll-flutter',{selector:{nodeId:'settings-list'},delta:250}]
      ]) { const result = await ctx.call(command,{...args,feedback:'off'}); if(!result.ok) throw new Error(JSON.stringify(result)); }
      const edited = await ctx.call('ios-flutter-nodes', {feedback:'off'});
      await ctx.assert({name:'edited',condition:edited.result.nodes.some(n=>n.value==='收发设备')&&edited.result.scroll===250&&edited.result.keyboardVisible===false,requiredEvidence:['tree'],evidence:edited.evidence});
      const back = await ctx.call('ios-flutter-back',{feedback:'off'}); if(!back.ok) throw new Error(JSON.stringify(back));
      const last = await ctx.call('ios-flutter-nodes',{feedback:'off'});
      await ctx.assert({name:'returned',condition:last.result.page==='Receive',requiredEvidence:['tree'],evidence:last.evidence});
      return {page:last.result.page};
    };`;
    const py = `def main(ctx):
    first = ctx.call('ios-flutter-nodes', {'feedback':'off'})
    ctx.assert_({'name':'receive','condition':first['result']['page']=='Receive','requiredEvidence':['tree'],'evidence':first['evidence']})
    for command,args in [
        ('ios-tap-flutter',{'selector':{'text':'Settings'}}),
        ('ios-input-flutter-text',{'selector':{'text':'Device name'},'text':'收发设备'}),
        ('ios-flutter-hide-keyboard',{}),
        ('ios-scroll-flutter',{'selector':{'nodeId':'settings-list'},'delta':250})
    ]:
        result = ctx.call(command, dict(args, feedback='off'))
        if not result['ok']: raise RuntimeError(str(result))
    edited = ctx.call('ios-flutter-nodes', {'feedback':'off'})
    ctx.assert_({'name':'edited','condition':any(n.get('value')=='收发设备' for n in edited['result']['nodes']) and edited['result']['scroll']==250 and edited['result']['keyboardVisible']==False,'requiredEvidence':['tree'],'evidence':edited['evidence']})
    back = ctx.call('ios-flutter-back', {'feedback':'off'})
    if not back['ok']: raise RuntimeError(str(back))
    last = ctx.call('ios-flutter-nodes', {'feedback':'off'})
    ctx.assert_({'name':'returned','condition':last['result']['page']=='Receive','requiredEvidence':['tree'],'evidence':last['evidence']})
    return {'page':last['result']['page']}
`;
    let result = await h.run('script', { operation: 'start', script: { schemaVersion: 'aab.code-script/v1',
      name: 'iOS controls', language, source: language === 'javascript' ? js : py, target: h.target } });
    assert.equal(result.ok, true, JSON.stringify(result));
    const operationId = result.operationId;
    const deadline = Date.now() + 30000;
    do {
      assert.ok(Date.now() < deadline, JSON.stringify(result));
      result = await h.run('script', { operation: 'wait', operationId, waitMs: 1000 });
    } while (!['completed', 'failed', 'cancelled'].includes(result.status));
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.deepEqual(result.rollingSummary.assertions, { passed: 3, failed: 0, inconclusive: 0 });
    assert.equal(h.actions.length, 5);
    assert.equal(h.actions[2].action, 'hideKeyboard');
    assert.equal(h.actions[2].targetRef, undefined);
    assert.equal(h.tree().keyboardVisible, false);
    assert.equal(h.tree().page, 'Receive');
    assert.equal(h.tree().scroll, 250);
    for (const action of h.actions) assert.ok(action.actionId.startsWith(`${operationId}:`), action.actionId);
  });
}

test('iOS Intent rejects a replaced Flutter Element without dispatching to the new element', async () => {
  const original = { ok: true, nodes: [node('original', 'Settings', 'tap')] };
  let dispatched = false;
  const adapter = createIOSIntentDeviceAdapter({ provider: { async run(command) {
    if (command === 'ios-flutter-nodes') return { ok: true, nodes: [node('replacement', 'Settings', 'tap')] };
    dispatched = true; return { ok: true };
  } } });
  const result = await adapter.action({ deviceId: 'phone', bundleId: 'sample.flutter', actionId: 'intent:one',
    rawTree: original, spec: { provider: 'flutter', action: 'tap', selector: { text: 'Settings' } } });
  assert.equal(result.error, 'reobserve_required');
  assert.equal(dispatched, false);
});

test('iOS typed control rejects a missing target before executing', async t => {
  const h = await fixture(t);
  const { platform, ...args } = h.target;
  const missing = await h.run('ios-tap-flutter', { ...args, selector: { text: 'Absent' }, feedback: 'off' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'flutter_selector_not_found');
  assert.equal(h.actions.length, 0);
});
