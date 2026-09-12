'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { summarizeTree } = require('../bin/shared-kernel/summary-transformer');
const { selectUiaNode } = require('../bin/shared-kernel/uia-target');
const protocol = require('../bin/shared-kernel/uia-protocol');
const { uiaXml } = require('../test-support/uia-target-fixture');
const { createUiaRuntimeFixture } = require('../test-support/uia-runtime-fixture');
const { runCli } = require('../test-support/cli-client');
const { stopRuntime } = require('../test-support/runtime-control');

const xml = '<hierarchy>' + [20, 100].map(top => `<node package="example.uia" class="android.widget.Button"
  text="月球" enabled="true" visible-to-user="true" clickable="true" bounds="[0,${top}][100,${top + 50}]"/>`).join('') + '</hierarchy>';

test('duplicate UIA labels retain distinct snapshot references without making a text selector ambiguous-success', () => {
  const rawTree = uiaXml(xml);
  const summary = summarizeTree({ provider: 'uia', rawTree, rawTreeId: 'observed-1' });
  const nodes = summary.nodes.filter(n => n.text === '月球');
  assert.equal(nodes.length, 2);
  assert.notEqual(nodes[0].targetRef.nodeRef, nodes[1].targetRef.nodeRef);
  assert.equal(nodes[0].targetRef.snapshotId, nodes[1].targetRef.snapshotId);
  assert.equal(selectUiaNode(rawTree, { selector: { text: '月球' } }, 'example.uia').error, 'uia_selector_not_unique');
  const selected = selectUiaNode(rawTree, { selector: { nodeRef: nodes[1].targetRef.nodeRef } }, 'example.uia');
  assert.equal(selected.ok, true); assert.equal(selected.node.bounds, '[0,100][100,150]');
  assert.equal(selectUiaNode(rawTree, { selector: { nodeRef: nodes[1].targetRef.nodeRef } }, 'other.app').ok, false);
  assert.equal(selectUiaNode(uiaXml(xml), { selector: { nodeRef: nodes[1].targetRef.nodeRef } }, 'example.uia').ok, false);
  assert.equal(summarizeTree({ provider: 'uia', rawTree: xml, rawTreeId: 'unbound' }).nodes[0].targetRef, undefined);
});

test('reference wire requires exact original ref and explicit package, and rejects malformed reference objects', () => {
  const ref = { schemaVersion: 'aab.uia.target/v1', bootId: randomUUID(), runtimeEpoch: randomUUID(), snapshotId: randomUUID(), nodeRef: randomUUID() };
  const request = protocol.actionRequest(protocol.bindingFromTargetRef(ref, 'example.uia'), { timeoutMs: 1000 }).request;
  assert.equal(protocol.validRequest(request), true);
  for (const change of [{ exact: false }, { value: randomUUID() }, { packageName: null }]) {
    const changed = structuredClone(request); Object.assign(changed.target.selector, change);
    assert.equal(protocol.validRequest(changed), false);
  }
  assert.throws(() => protocol.bindingFromTargetRef({ ...ref, unexpected: true }, 'example.uia'), /complete targetRef/);
});

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-uia-ref-'));
  const peer = await createUiaRuntimeFixture({ directory, xml });
  const env = { AI_APP_BRIDGE_RUNTIME_HOME: path.join(directory, 'host'), AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'facts') };
  t.after(async () => { await stopRuntime({ env }); await peer.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = async (command, args) => (await runCli(command, args, { env })).value;
  const target = { platform: 'android', serial: peer.serial, packageName: 'example.uia', adb: peer.adb };
  return { peer, target, call };
}

test('public CLI executes the exact observed UIA reference without replacing it with another snapshot', async t => {
  const { peer, target, call } = await fixture(t);
  const { platform, ...app } = target;
  const tree = await call('uia-tree', { ...app, compact: true });
  assert.equal(tree.ok, true, JSON.stringify(tree));
  const targetRef = tree.nodes[1].targetRef;
  const value = await call('tap-uia', { ...app, targetRef });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.binding.ref, targetRef.nodeRef);
  assert.equal(value.binding.snapshotId, targetRef.snapshotId);
  assert.equal(value.request.target.selector.kind, 'nodeRef');
  assert.equal(peer.requests.filter(r => r.op === 'observe').length, 1);
  const old = await call('tap-uia', { ...app, targetRef: { ...targetRef, runtimeEpoch: randomUUID() } });
  assert.equal(old.error, 'uia_stale_runtime'); assert.equal(old.dispatched, false);
  const mixed = await call('tap-uia', { ...app, targetRef, selector: { text: '月球' } });
  assert.equal(mixed.ok, false); assert.equal(mixed.dispatched, false);
  assert.equal(peer.dispatches.length, 1);
});

test('public Intent and Script preserve the selected UIA node identity through their shared runtime', async t => {
  const { peer, target, call } = await fixture(t);
  let intent = await call('intent', { operation: 'start', target, provider: 'uia', goal: 'Select the second observed duplicate result' });
  assert.equal(intent.ok, true, JSON.stringify(intent));
  const reference = intent.summary.nodes.filter(n => n.text === '月球')[1].targetRef;
  intent = await call('intent', { operation: 'decide', operationId: intent.operationId, decision: {
    decisionId: 'second-result', basedOnRevision: intent.revision, agentDecision: 'act',
    action: { provider: 'uia', action: 'tap', selector: { nodeRef: reference.nodeRef } } } });
  assert.equal(intent.ok, true, JSON.stringify(intent));
  const prepared = peer.requests.find(r => r.op === 'prepare');
  assert.equal(JSON.parse(prepared.requestJson).target.ref, reference.nodeRef);
  await call('intent', { operation: 'decide', operationId: intent.operationId, decision: {
    decisionId: 'done', basedOnRevision: intent.revision, agentDecision: 'complete' } });
  let script = await call('script', { operation: 'start', script: { schemaVersion: 'aab.code-script/v1', language: 'javascript', target,
    permissions: ['app.read', 'app.interact'], source: `module.exports.main = async ctx => {
      const observation = await ctx.call('uia-tree', {compact:true});
      const node = observation.result.nodes.filter(n => n.text === '月球')[1];
      const action = await ctx.call('tap-uia', {targetRef:node.targetRef});
      if (!action.ok) throw Error(action.error);
      return {nodeRef:node.targetRef.nodeRef};
    };` } });
  const events = [...script.events];
  while (!['completed', 'failed', 'cancelled', 'timeout'].includes(script.status)) {
    script = await call('script', { operation: 'wait', operationId: script.operationId, afterSequence: script.eventSequence, waitMs: 1000 });
    events.push(...script.events);
  }
  assert.equal(script.status, 'completed', JSON.stringify(events.find(e => e.type === 'script_failed')));
  const completed = (await call('script', { operation: 'result', operationId: script.operationId })).result;
  assert.equal(JSON.parse(peer.requests.findLast(r => r.op === 'prepare').requestJson).target.ref, completed.nodeRef);
  assert.equal(peer.dispatches.length, 2);
});
