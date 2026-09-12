'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createWDAFixture } = require('../test-support/ios-wda-fixture');
const { createMcpClient, payloadOf } = require('../scripts/validation/mcp-jsonrpc-client');
const { schema, selectNativeNode } = require('../bin/shared-kernel/ios-native-target');
const { intentDecisionSchema } = require('../bin/shared-kernel/execution-contracts');
const { validateValue } = require('../bin/shared-kernel/argument-schema');

const ownership = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-native-test-'));
process.env.AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR = ownership;
test.after(() => fs.rmSync(ownership, { recursive: true, force: true }));
function node(elementId, type, identifier, label, value = null) {
  return { elementId, type, rawIdentifier: identifier, label, value,
    isVisible: '1', isEnabled: '1', rect: { x: 20, y: 40, width: 120, height: 50 } };
}
function nativeFixture(h) {
  h.state.nativeTargetSchema = schema;
  h.state.orientationSchema = 'aab.ios-orientation/v1';
  h.state.tree = { type: 'Application', children: [node('save-1', 'Button', 'save', 'Save'),
    node('editor-1', 'TextField', 'title', null, '')] };
  return { bundleId: 'sample.app', wdaSessionId: 'session-1' };
}

test('native selectors reject duplicate visible labels, hidden controls and stale observed identities before dispatch', async t => {
  const h = await createWDAFixture(t), args = nativeFixture(h);
  const first = await h.run('ios-uia-tree', args);
  const selected = selectNativeNode(first, { accessibilityId: 'save' });
  assert.equal(selected.ok, true);
  h.state.tree.children.push(node('save-2', 'Button', 'other', 'Save'));
  assert.equal((await h.run('ios-tap-native', { ...args, selector: { label: 'Save' } })).error, 'ios_native_selector_ambiguous');
  h.state.tree.children[1].isVisible = '0';
  assert.equal((await h.run('ios-input-native-text', { ...args, selector: { accessibilityId: 'title' }, text: 'wrong' })).error, 'ios_native_selector_not_found');
  h.state.tree.children[0].elementId = 'replacement';
  const changed = await h.run('ios-tap-native', { ...args, selector: { accessibilityId: 'save' }, expectedTarget: selected.targetRef });
  assert.equal(changed.error, 'reobserve_required');
  assert.equal(changed.dispatched, false);
  assert.deepEqual(h.readEffects(), []);
});

test('native controls require the Runner target contract and preserve one exact managed action', async t => {
  const h = await createWDAFixture(t), args = nativeFixture(h);
  h.state.nativeTargetSchema = undefined;
  assert.equal((await h.run('ios-tap-native', { ...args, selector: { accessibilityId: 'save' } })).error, 'ios_native_target_schema_required');
  assert.deepEqual(h.readEffects(), []);
  h.state.nativeTargetSchema = schema;
  const result = await h.run('ios-input-native-text', { ...args, selector: { accessibilityId: 'title' }, text: '真实输入' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const body = h.state.actions[0];
  assert.equal(body.operation, 'native-input');
  assert.equal(body.payload.targetRef.elementId, 'editor-1');
  assert.equal(body.payload.clearFirst, true);
  assert.equal(body.payload.text, '真实输入');
  assert.equal(h.readEffects().length, 1);
});

test('public native iOS Intent publishes real iOS selectors and binds original action IDs; Script reuses the same typed controls', async t => {
  const h = await createWDAFixture(t), args = nativeFixture(h);
  const target = { platform: 'ios', ...h.args, ...args };
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-native-mcp-'));
  const client = createMcpClient({ serverPath: path.resolve(__dirname, '../bin/mcp-server.js'),
    transcriptPath: path.join(out, 'mcp.jsonl'), stderrPath: path.join(out, 'stderr.log'),
    env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(out, 'facts'), AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR: path.join(out, 'ownership'),
      AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb', ADB: path.join(out, 'forbidden-adb') } });
  t.after(async () => { await client.close({ stdinEof: true }); fs.rmSync(out, { recursive: true, force: true }); });
  h.state.onAction = body => {
    if (body.operation === 'native-input') h.state.tree.children[1].value = body.payload.text;
    if (body.operation === 'native-tap') h.state.tree.children[0].label = 'Saved';
  };
  await client.initialize();
  const run = async (command, arguments_) => payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: arguments_ } }));
  let result = await run('intent', { operation: 'start', goal: 'Edit and save a record', target, provider: 'native' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const operationId = result.operationId;
  assert.ok(result.summary.nodes.some(n => n.accessibilityId === 'title' && n.elementId === 'editor-1'));
  for (const [index, action] of [
    { action: 'inputText', selector: { accessibilityId: 'title' }, value: '新记录' },
    { action: 'tap', selector: { label: 'Save', type: 'Button' } },
    { action: 'setOrientation', orientation: 'landscapeLeft' },
  ].entries()) {
    result = await run('intent', { operation: 'decide', operationId, decision: { decisionId: `step-${index}`,
      basedOnRevision: result.revision, agentDecision: 'act', action } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(h.state.actions[index].actionId, `${operationId}:step-${index}`);
  }
  assert.ok(result.summary.nodes.some(n => n.text === '新记录'));
  assert.ok(result.summary.nodes.some(n => n.label === 'Saved'));
  result = await run('intent', { operation: 'decide', operationId, decision: { decisionId: 'done', basedOnRevision: result.revision, agentDecision: 'complete' } });
  assert.equal(result.status, 'completed');
  const script = { schemaVersion: 'aab.code-script/v1', language: 'javascript', target, source: `module.exports.main = async ctx => {
    const rotated = await ctx.call('ios-set-orientation',{orientation:'portrait',feedback:'off'});
    if (!rotated.ok) throw new Error(JSON.stringify(rotated));
    const edited = await ctx.call('ios-input-native-text',{selector:{accessibilityId:'title'},text:'Script record',feedback:'off'});
    if (!edited.ok) throw new Error(JSON.stringify(edited));
    const observed = await ctx.call('ios-uia-tree',{feedback:'off'});
    await ctx.assert({name:'record value',condition:observed.result.source.children.some(n=>n.value==='Script record'),requiredEvidence:['tree'],evidence:observed.evidence});
  };` };
  result = await run('script', { operation: 'start', script });
  const scriptId = result.operationId;
  const deadline = Date.now() + 30000;
  while (['running', 'starting', 'created'].includes(result.status)) {
    assert.ok(Date.now() < deadline, JSON.stringify(result));
    result = await run('script', { operation: 'wait', operationId: scriptId, waitMs: 1000 });
  }
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.deepEqual(result.rollingSummary.assertions, { passed: 1, failed: 0, inconclusive: 0 });
  assert.deepEqual(h.state.actions.filter(a => a.operation === 'set-orientation').map(a => a.payload),
    [{ orientation: 'landscapeLeft' }, { orientation: 'portrait' }]);
});

test('native iOS decisions reject Android selectors and key events before execution', () => {
  const base = { decisionId: 'd', basedOnRevision: 1, agentDecision: 'act' };
  for (const action of [{ action: 'tap', selector: { resourceName: 'android:id/button' } }, { action: 'keyevent', keyCode: 4 }, { action: 'back' }]) {
    assert.throws(() => validateValue({ ...base, action }, intentDecisionSchema('native', 'ios'), 'decision'));
  }
});

test('managed native input can outlast the five-second read budget without cancelling the original action', async t => {
  const h = await createWDAFixture(t), args = nativeFixture(h);
  h.state.responseDelayMs = 5100;
  const result = await h.run('ios-input-native-text', { ...args, selector: { accessibilityId: 'title' }, text: 'longer native input' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.readEffects().length, 1);
  assert.ok(!h.state.calls.some(call => call.route === '/aab/execution/cancel'));
});
