'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLiveCaptureQuery } = require('../bin/shared-kernel/live-capture-query');
const { createDeviceMutationLease } = require('../bin/shared-kernel/device-mutation-lease');
const { createScriptHostPort } = require('../bin/script/script-host-port');

function completePage(stream, extra = {}) {
  const request = extra.request || {};
  return {
    runtimeEpoch: 'epoch-1', targetKey: 'pkg', watermarkCursor: 'cursor-current', hasMore: false,
    window: { afterActionId: request.afterActionId ?? null, factCursor: request.factCursor ?? null,
      sinceId: request.sinceId ?? null, sinceMs: request.sinceMs ?? null,
      runtimeEpoch: 'epoch-1', targetKey: 'pkg', filterApplied: true },
    ok: true,
    coverage: { status: 'complete', gap: false, committed: true },
    refs: [{ mobileFactId: `mf1:1:1:${stream}`, stream, captureId: 1, runtimeEpoch: 'epoch-1', targetKey: 'pkg' }],
    items: extra.items || [{ id: 1, stream, ...extra.item }],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('P4 ScriptHostPort stamps target and Host actionId onto dispatch', async () => {
  let seen = null;
  const host = createScriptHostPort({
    executionId: 'script-p4',
    target: { serial: 's1', packageName: 'pkg' },
    runner: async () => completePage('network'),
    actions: async (command, args) => {
      seen = { command, args };
      return { ok: true, command, args };
    },
  });
  const tap = await host.call('tap-text', { text: 'Login' });
  assert.equal(tap.ok, true);
  assert.equal(tap.execution.actionId, 'script-p4:action-1');
  assert.equal(seen.command, 'tap-text');
  assert.equal(seen.args.text, 'Login');
  assert.equal(seen.args.serial, 's1');
  assert.equal(seen.args.packageName, 'pkg');
  assert.equal(seen.args.requestId, 'script-p4:action-1');
});

test('P4 ScriptHostPort login network uses live query and mutation actionId', async () => {
  const afterActionIds = [];
  const seen = [];
  const host = createScriptHostPort({
    executionId: 'script-p4',
    target: { serial: 's1', packageName: 'pkg' },
    runner: async (command, args) => {
      afterActionIds.push(args.afterActionId);
      seen.push(args);
      return completePage('network', { request: args, item: { statusCode: 200 } });
    },
    actions: async (command, args) => ({ ok: true, command, args }),
  });
  const before = await host.call('network');
  const tap = await host.call('tap-text', { text: 'Login' });
  assert.equal(tap.ok, true);
  assert.equal(tap.execution.actionId, 'script-p4:action-2');
  const network = await host.call('network', { afterActionId: tap.execution.actionId, factCursor: before.evidence.capture.watermarkCursor });
  assert.equal(afterActionIds[1], 'script-p4:action-2');
  assert.equal(seen[0].serial, 's1');
  assert.equal(seen[0].packageName, 'pkg');
  assert.equal(network.result.items[0].statusCode, 200);
  const verdict = await host.assert({
    name: 'login-status',
    predicateSummary: 'login returned 200',
    requireCoverage: 'complete',
    requiredEvidence: ['network'],
    condition: network.result.items[0].statusCode === 200,
    evidence: JSON.parse(JSON.stringify(network.evidence)),
  });
  assert.equal(verdict.verdict, 'passed');
});

test('P4 ScriptHostPort does not invent complete from a container body', async () => {
  const host = createScriptHostPort({
    target: { serial: 's1' },
    runner: async () => ({ ok: true, items: [{ statusCode: 200 }] }),
    actions: async () => ({ ok: true }),
  });
  const window = await host.call('network', { afterActionId: 'a1' });
  assert.equal(window.evidence.coverage.status, 'unavailable');
  assert.equal(window.result.items.length, 0);
});

test('P4 same serial mutations are busy; different serials run', async () => {
  const lease = createDeviceMutationLease();
  const gate = deferred();
  let starts = 0;
  const firstHost = createScriptHostPort({
    mutationLease: lease,
    target: { serial: 'phone-1' },
    actions: async () => {
      starts += 1;
      await gate.promise;
      return { ok: true };
    },
    runner: async () => completePage('logs'),
  });
  const secondHost = createScriptHostPort({
    mutationLease: lease,
    target: { serial: 'phone-1' },
    actions: async () => ({ ok: true }),
    runner: async () => completePage('logs'),
  });
  const otherHost = createScriptHostPort({
    mutationLease: lease,
    target: { serial: 'phone-2' },
    actions: async () => ({ ok: true }),
    runner: async () => completePage('logs'),
  });
  const first = firstHost.call('tap', { text: 'A' });
  await nextTurn();
  const busy = await secondHost.call('tap', { text: 'B' });
  const other = await otherHost.call('tap', { text: 'C' });
  assert.equal(busy.error, 'target_busy');
  assertScriptCallEnvelope(busy, {
    command: 'tap',
    callId: 'call-1',
    coverage: 'unavailable',
  });
  assert.equal(other.ok, true);
  assert.equal(starts, 1);
  gate.resolve();
  assert.equal((await first).ok, true);
});

test('P4 capture and tree reads do not take the mutation lease', async () => {
  const lease = createDeviceMutationLease();
  const held = lease.acquire('phone-1');
  const host = createScriptHostPort({
    mutationLease: lease,
    target: { serial: 'phone-1' },
    runner: async () => completePage('logs', { item: { message: 'ready' } }),
    actions: async (command) => ({ ok: true, command }),
  });
  const logs = await host.call('logs', { afterActionId: 'a1' });
  const tree = await host.call('tree', {});
  assert.equal(logs.evidence.coverage.status, 'complete');
  assert.equal(tree.ok, true);
  assert.equal(lease.status('phone-1').active, 1);
  held.release();
});

test('P4 Intent-style hold on the shared lease blocks Script mutation', async () => {
  const lease = createDeviceMutationLease();
  const intentHold = lease.acquire('phone-1');
  const host = createScriptHostPort({
    mutationLease: lease,
    target: { serial: 'phone-1' },
    actions: async () => ({ ok: true }),
    runner: async () => completePage('logs'),
  });
  const tap = await host.call('tap', { text: 'Home' });
  assert.equal(tap.error, 'target_busy');
  assert.equal(host.actionCallCount, 0);
  intentHold.release();
  const after = await host.call('tap', { text: 'Home' });
  assert.equal(after.ok, true);
});

test('P4 screenshot stamps path as screenshotId when refs are absent', async () => {
  const host = createScriptHostPort({
    executionId: 'script-p4',
    target: { serial: 's1', packageName: 'pkg' },
    actions: async () => ({
      ok: true,
      path: '/tmp/shot.png',
      artifact: { path: '/tmp/shot.png' },
    }),
  });
  const shot = await host.call('screenshot', {});
  assert.equal(shot.ok, true);
  assert.deepEqual(shot.evidence.refs, [{ stream: 'screenshot', screenshotId: '/tmp/shot.png' }]);
});

test('P4 page-summary is a pure transform and does not call actions', async () => {
  let actionCalls = 0;
  const host = createScriptHostPort({
    target: { serial: 's1' },
    actions: async () => {
      actionCalls += 1;
      return { ok: true };
    },
    runner: async () => completePage('logs'),
  });
  const summary = await host.call('page-summary', {
    provider: 'native',
    rawTreeId: 'tree-1',
    rawTree: { root: { id: 'home', className: 'Button', text: 'Home', clickable: true, children: [] } },
    refs: [{ stream: 'tree', rawTreeId: 'tree-1' }],
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.result.ok, true);
  assert.equal(summary.result.nodes[0].text, 'Home');
  assert.equal(actionCalls, 0);
  assert.equal(host.actionCallCount, 0);
});

test('P4 denied catalog commands stay denied', async () => {
  const host = createScriptHostPort({
    target: { serial: 's1' },
    actions: async () => ({ ok: true }),
    runner: async () => completePage('logs'),
  });
  const denied = await host.call('clear-app-data', {});
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'command_not_in_default_allowlist');
  assertScriptCallEnvelope(denied, {
    command: 'clear-app-data',
    callId: 'call-1',
    coverage: 'unavailable',
  });
  assert.equal(host.actionCallCount, 0);
});

test('P4 transport error and ambiguous action do not retry', async () => {
  let throws = 0;
  const throwing = createScriptHostPort({
    target: { serial: 's1' },
    actions: async () => {
      throws += 1;
      throw new Error('transport_timeout');
    },
    runner: async () => completePage('logs'),
  });
  const failed = await throwing.call('tap', { text: 'Go' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'transport_timeout');
  assert.equal(throws, 1);

  let ambiguousCalls = 0;
  const ambiguous = createScriptHostPort({
    target: { serial: 's1' },
    actions: async () => {
      ambiguousCalls += 1;
      return { ok: false, ambiguous: true, error: 'ambiguous' };
    },
    runner: async () => completePage('logs'),
  });
  const once = await ambiguous.call('tap', { text: 'Go' });
  assert.equal(once.ambiguous, true);
  assert.equal(ambiguousCalls, 1);
});

test('P4 live throw is unavailable and never calls readHistory', async () => {
  let readHistory = 0;
  const host = createScriptHostPort({
    target: { serial: 's1' },
    query: createLiveCaptureQuery({
      runner: async () => {
        throw new Error('target_disconnected');
      },
    }),
    actions: async () => ({ ok: true }),
  });
  const window = await host.call('network', { afterActionId: 'a1' });
  assert.equal(window.evidence.coverage.status, 'unavailable');
  assert.equal(window.result.items.length, 0);
  assert.equal(readHistory, 0);
});

test('P4 assert rejects a screenshot ref this execution did not produce', async () => {
  const host = createScriptHostPort({
    target: { serial: 's1' },
    actions: async () => ({ ok: true, path: '/tmp/this-round.png' }),
    runner: async () => completePage('logs'),
  });
  const shot = await host.call('screenshot', {});
  assert.equal(shot.ok, true);
  const stale = await host.assert({
    name: 'old-shot',
    condition: true,
    requiredEvidence: [],
    evidence: {
      coverage: { status: 'complete', gap: false, committed: true },
      refs: [{ stream: 'screenshot', screenshotId: '/tmp/other-round.png' }],
    },
  });
  assert.equal(stale.verdict, 'inconclusive');
  const fresh = await host.assert({
    name: 'this-shot',
    condition: true,
    requiredEvidence: [],
    evidence: shot.evidence,
  });
  assert.equal(fresh.verdict, 'passed');
});

test('P4 page-summary cannot launder a foreign evidence ref into this execution', async () => {
  const host = createScriptHostPort({
    executionId: 'script-p4',
    target: { serial: 's1' },
    actions: async () => ({ ok: true, path: '/tmp/this-round.png' }),
  });
  const foreignRef = { stream: 'screenshot', screenshotId: '/tmp/other-round.png' };
  const foreignSummary = await host.call('page-summary', {
    provider: 'native',
    rawTreeId: 'tree-old',
    rawTree: { root: { id: 'old', text: 'Old', children: [] } },
    refs: [foreignRef],
  });
  const stale = await host.assert({
    name: 'laundered-shot',
    condition: true,
    requiredEvidence: ['screenshot'],
    evidence: foreignSummary.evidence,
  });
  assert.equal(stale.verdict, 'inconclusive');

  const shot = await host.call('screenshot', {});
  const freshSummary = await host.call('page-summary', {
    provider: 'native',
    rawTreeId: 'tree-current',
    rawTree: { root: { id: 'current', text: 'Current', children: [] } },
    refs: shot.evidence.refs,
  });
  const fresh = await host.assert({
    name: 'current-shot',
    condition: true,
    requiredEvidence: ['screenshot'],
    evidence: freshSummary.evidence,
  });
  assert.equal(fresh.verdict, 'inconclusive');
  assert.equal((await host.assert({ condition: true, evidence: shot.evidence })).verdict, 'passed');
});

function assertScriptCallEnvelope(result, { command, callId, coverage }) {
  assert.equal(result.command, command);
  assert.deepEqual(result.execution, { executionId: undefined, callId, actionId: null });
  assert.deepEqual(result.evidence.window, { afterActionId: null, closedAtMs: 0 });
  assert.equal(result.evidence.coverage.status, coverage);
  assert.deepEqual(result.evidence.refs, []);
  assert.deepEqual(result.timings, {});
}

test('P4 ScriptHostPort stays off Intent Legacy and MCP', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../bin/script/script-host-port.js'),
    'utf8',
  );
  assert.equal(/intent\/|legacy\/|runBatch|runBridgeChecked|mcp-server|readHistory|ai-app-bridge\.js|target-execution/.test(source), false);
});

test('device assertion needs Host evidence, while code assertion has explicit scope', async () => {
  const host = createScriptHostPort({ actions: async () => { throw new Error('must_not_call'); } });
  const assertion = {
    condition: true,
    evidence: { coverage: { status: 'complete', gap: false, committed: true }, refs: [] },
  };
  assert.equal((await host.assert(assertion)).verdict, 'inconclusive');
  assert.deepEqual(await host.assert({ scope: 'code', condition: 2 + 2 === 4 }), {
    name: null, verdict: 'passed', scope: 'code',
  });
  assert.equal((await host.assert({ ...assertion, scope: 'code' })).verdict, 'inconclusive');
  assert.equal(host.actionCallCount, 0);
});

test('Host issuance survives JSON transport but rejects coverage and refs tampering', async () => {
  const host = createScriptHostPort({
    actions: async () => ({ ok: true }),
    query: async () => ({ ...completePage('state'), coverage: { status: 'partial', gap: true, committed: false } }),
  });
  const result = await host.call('state');
  const evidence = JSON.parse(JSON.stringify(result.evidence));
  assert.equal((await host.assert({ condition: true, evidence })).reason, 'evidence_coverage_incomplete');
  evidence.coverage = { status: 'complete', gap: false, committed: true };
  assert.equal((await host.assert({ condition: true, evidence })).reason, 'evidence_not_host_issued');
  assert.equal((await host.assert({ condition: false, evidence: result.evidence })).verdict, 'inconclusive');
  result.evidence.refs[0].stream = 'network';
  assert.equal((await host.assert({ condition: true, evidence: result.evidence })).reason, 'evidence_not_host_issued');
});

test('pre-mutation tree and same-path screenshot cannot certify a subsequent mutation', async () => {
  const host = createScriptHostPort({
    target: { serial: 'freshness-device' },
    actions: async (command) => command === 'screenshot'
      ? { ok: true, path: '/tmp/reused.png' }
      : { ok: true, root: { text: 'Saved' } },
  });
  const oldTree = await host.call('tree');
  const oldShot = await host.call('screenshot');
  assert.equal((await host.assert({ condition: true, evidence: oldTree.evidence })).verdict, 'passed');
  const action = await host.call('tap', { text: 'Save' });
  const freshShot = await host.call('screenshot');
  assert.equal((await host.assert({ condition: true, evidence: oldShot.evidence })).reason, 'evidence_action_window_stale');
  assert.equal((await host.assert({ condition: true, evidence: oldTree.evidence })).verdict, 'inconclusive');
  assert.equal((await host.assert({ condition: true, evidence: freshShot.evidence })).verdict, 'passed');
  assert.equal(freshShot.evidence.window.afterActionId, action.execution.actionId);
  const freshTree = await host.call('tree');
  assert.equal(freshTree.evidence.refs[0].hostObservationId, freshTree.evidence.observationId);
  assert.equal(freshTree.evidence.refs[0].scope, 'execution');
  assert.equal(freshTree.evidence.refs[0].rawTreeId, undefined);
  assert.equal((await host.assert({ condition: false, evidence: freshTree.evidence })).verdict, 'failed');
});

test('capture after an unknown or older action cannot satisfy current action evidence', async () => {
  const host = createScriptHostPort({
    target: { serial: 'capture-window-device' },
    actions: async () => ({ ok: true }), query: async (request) => completePage('network', { request }),
  });
  const first = await host.call('tap', {});
  const before = await host.call('network');
  const second = await host.call('tap', {});
  for (const afterActionId of [null, 'caller-invented-action', first.execution.actionId]) {
    const evidence = (await host.call('network', {}, { evidenceWindow: { afterActionId } })).evidence;
    assert.equal((await host.assert({ condition: true, evidence })).reason, 'capture_boundary_not_host_observed');
  }
  const evidence = (await host.call('network', { factCursor: before.evidence.capture.watermarkCursor }, { evidenceWindow: { afterActionId: second.execution.actionId } })).evidence;
  assert.equal((await host.assert({ condition: true, requiredEvidence: ['network'], evidence })).verdict, 'passed');
  assert.equal((await host.assert({ condition: true, requiredEvidence: ['state'], evidence })).verdict, 'inconclusive');
});

test('observations overlapping a mutation and mutation receipts are not postconditions', async () => {
  const pending = deferred();
  const host = createScriptHostPort({
    target: { serial: 'pending-device' },
    actions: async (command) => {
      if (command === 'tap') await pending.promise;
      return { ok: true, path: '/tmp/pending.png', refs: [{ stream: 'state', mobileFactId: 'f1' }] };
    },
  });
  const actionPromise = host.call('tap', {});
  await nextTurn();
  const during = await host.call('screenshot');
  assert.equal((await host.assert({ condition: true, evidence: during.evidence })).verdict, 'inconclusive');
  pending.resolve();
  const receipt = await actionPromise;
  assert.equal((await host.assert({ condition: true, evidence: during.evidence })).verdict, 'inconclusive');
  assert.equal((await host.assert({ condition: true, evidence: receipt.evidence })).reason, 'evidence_not_host_issued');
});

test('failed provider observations and reference-free replies cannot pass device assertions', async () => {
  for (const raw of [{ ok: false, refs: [{ stream: 'tree', rawTreeId: 't1' }] }, { ok: true, items: [] }]) {
    const host = createScriptHostPort({ actions: async () => raw });
    const evidence = (await host.call('status')).evidence;
    assert.equal((await host.assert({ condition: true, evidence })).verdict, 'inconclusive');
  }
});

test('post-action capture requires the Host-observed pre-action watermark and matching epoch/target/filter', async () => {
  let reply = null;
  const host = createScriptHostPort({ target: { serial: 'watermark-device', packageName: 'pkg' }, actions: async () => ({ ok: true }),
    query: async (request) => {
      const page = completePage('network', { request });
      return reply ? reply(page) : page;
    },
  });
  const before = await host.call('network');
  const action = await host.call('tap');
  const request = { afterActionId: action.execution.actionId, factCursor: before.evidence.capture.watermarkCursor };
  for (const change of [
    (page) => ({ ...page, window: { ...page.window, filterApplied: false } }),
    (page) => ({ ...page, window: { ...page.window, factCursor: 'different-returned-cursor' } }),
    (page) => ({ ...page, runtimeEpoch: 'epoch-2', window: { ...page.window, runtimeEpoch: 'epoch-2' }, refs: page.refs.map((ref) => ({ ...ref, runtimeEpoch: 'epoch-2' })) }),
    (page) => ({ ...page, targetKey: 'foreign', window: { ...page.window, targetKey: 'foreign' }, refs: page.refs.map((ref) => ({ ...ref, targetKey: 'foreign' })) }),
  ]) {
    reply = change;
    const result = await host.call('network', request);
    assert.equal((await host.assert({ condition: true, evidence: result.evidence })).verdict, 'inconclusive');
  }
  reply = null;
  const invented = await host.call('network', { ...request, factCursor: 'caller-invented-cursor' });
  assert.equal((await host.assert({ condition: true, evidence: invented.evidence })).reason, 'capture_boundary_not_host_observed');
  const valid = await host.call('network', request);
  assert.equal((await host.assert({ condition: true, evidence: valid.evidence })).verdict, 'passed');
  await host.call('tap');
  const second = await host.call('tap');
  const stale = await host.call('network', { ...request, afterActionId: second.execution.actionId });
  assert.equal((await host.assert({ condition: true, evidence: stale.evidence })).reason, 'capture_boundary_not_host_observed');
});

test('a serialized observation from another Host execution cannot be reused', async () => {
  const actions = async () => ({ ok: true, path: '/tmp/shared.png' });
  const first = createScriptHostPort({ actions, executionId: 'one' });
  const next = createScriptHostPort({ actions, executionId: 'two' });
  const old = JSON.parse(JSON.stringify((await first.call('screenshot')).evidence));
  await next.call('screenshot');
  assert.equal((await next.assert({ condition: true, evidence: old })).reason, 'evidence_not_host_issued');
});

test('an unread capture page cannot turn absence on one page into a failed assertion', async () => {
  const host = createScriptHostPort({ actions: async () => ({ ok: true }),
    query: async (request) => ({ ...completePage('network', { request }), hasMore: true, nextCursor: 'next-page' }),
  });
  const result = await host.call('network');
  assert.equal((await host.assert({ condition: false, evidence: result.evidence })).verdict, 'inconclusive');
});

test('capture errors survive the Script envelope and successful store identity remains visible', async () => {
  const missing = createScriptHostPort({ actions: async () => ({ ok: true }) });
  const absent = await missing.call('network');
  assert.equal(absent.ok, false);
  assert.equal(absent.error, 'capture_unavailable');
  const failed = createScriptHostPort({ actions: async () => ({ ok: true }), query: async () => ({ ok: false, reason: 'runtime_epoch_changed' }) });
  const failure = await failed.call('network');
  assert.equal(failure.ok, false);
  assert.equal(failure.error, 'runtime_epoch_changed');
  const good = createScriptHostPort({ actions: async () => ({ ok: true }), query: async (request) => ({ ...completePage('network', { request }), storeGeneration: 7, throughWatermark: 19 }) });
  const result = await good.call('network');
  assert.equal(result.ok, true);
  assert.equal(result.evidence.capture.storeGeneration, 7);
  assert.equal(result.evidence.capture.throughWatermark, 19);
});

test('Host-observed watermark proves the window for asynchronous untagged network facts', async () => {
  const host = createScriptHostPort({ target: { serial: 'async-network', packageName: 'pkg' },
    actions: async () => ({ ok: true }), query: async (request) => completePage('network', { request }),
  });
  const before = await host.call('network');
  await host.call('tap', { text: 'Save' });
  const after = await host.call('network', { factCursor: before.evidence.capture.watermarkCursor });
  assert.equal(after.evidence.window.afterActionId, null);
  const result = await host.assert({ condition: true, evidence: after.evidence, requiredEvidence: ['network'] });
  assert.equal(result.verdict, 'passed');
});

test('the bounded Host registry evicts old metadata and retains no mobile payload copy', async () => {
  const { createObservationRegistry, issueObservation, judgeAssertion } = require('../bin/script/script-assert');
  const registry = createObservationRegistry({ maxCount: 2, maxBytes: 2048 });
  const issue = (ref) => {
    const evidence = { coverage: { status: 'complete', gap: false, committed: true }, refs: [ref], window: { afterActionId: null } };
    issueObservation(registry, evidence, { afterActionId: null, mutationRevision: 0, pendingMutation: false }, { command: 'state', payload: { body: 'mobile-payload-must-not-be-retained' } });
    return evidence;
  };
  const oldest = issue({ stream: 'state', mobileFactId: 'first' });
  assert.equal(registry.get(oldest.observationId).payload, undefined);
  issue({ stream: 'state', mobileFactId: 'second' });
  const current = issue({ stream: 'state', mobileFactId: 'third' });
  assert.equal(registry.retainedCount, 2);
  assert.equal(judgeAssertion({ condition: true, evidence: oldest }, registry).verdict, 'inconclusive');
  assert.equal(judgeAssertion({ condition: true, evidence: current }, registry).verdict, 'passed');
  const oversized = issue({ stream: 'state', mobileFactId: 'x'.repeat(3000) });
  assert.equal(judgeAssertion({ condition: true, evidence: oversized }, registry).verdict, 'inconclusive');
  assert(registry.retainedBytes <= 2048);
});

test('replacing evidence metadata updates its LRU position without growing accounted bytes', () => {
  const { createObservationRegistry } = require('../bin/script/script-assert');
  const registry = createObservationRegistry({ maxCount: 2, maxBytes: 256 });
  registry.set('a', { cursor: 'a' });
  registry.set('b', { cursor: 'b' });
  const bytes = registry.retainedBytes;
  registry.set('a', { cursor: 'a' });
  assert.equal(registry.retainedBytes, bytes);
  registry.set('c', { cursor: 'c' });
  assert.equal(registry.get('b'), undefined);
  assert.deepEqual(registry.entries().map(([key]) => key), ['a', 'c']);
});
