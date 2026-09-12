'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const WebSocket = require('ws');
const { createFactStore } = require('../bin/fact-store');
const { WebSessionStore } = require('../bin/web/session-store');
const { WebBridgeProvider } = require('../bin/web-provider');
const { createScriptHostPort } = require('../bin/script/script-host-port');
const { createIntentCapturePort } = require('../bin/intent/intent-capture-port');
const { createLiveCaptureQuery } = require('../bin/shared-kernel/live-capture-query');
const { createDeviceMutationLease } = require('../bin/shared-kernel/device-mutation-lease');
const { validateCommandArguments } = require('../bin/command-registry');

async function fixture(t, { fetch = () => Promise.resolve(new Response('ok')) } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-web-capture-'));
  const facts = createFactStore({ directory: path.join(directory, 'facts'), profile: '64mb' });
  const store = new WebSessionStore(() => facts);
  const lease = createDeviceMutationLease({ directory: path.join(directory, 'ownership') });
  const provider = new WebBridgeProvider({ store, lease });
  let bridge;
  t.after(async () => { bridge?.stop(); await provider.close(); facts.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const server = await provider.start({ webPort: 0 });
  const window = { fetch };
  const sandbox = vm.createContext({ window, WebSocket, setTimeout, clearTimeout, performance,
    TextDecoder, TextEncoder, URL, URLSearchParams, Request, Response, btoa, crypto: require('node:crypto').webcrypto,
    location: new URL('http://example.test/memos'), document: { title: 'Memos fixture' } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../web/ai-app-bridge-web/src/index.js'), 'utf8'), sandbox);
  bridge = sandbox.AiAppBridgeWeb.createAiAppBridge({ endpoint: server.endpoint, token: server.token,
    sessionId: 'capture-fixture', appName: 'Capture fixture', WebSocket, reconnect: false, capture: { fetch: true } }).start();
  const deadline = Date.now() + 2000;
  while (!bridge.isConnected()) {
    if (Date.now() >= deadline) throw new Error('fixture handshake timeout');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  const target = { platform: 'web', sessionId: bridge.sessionId(), runtimeEpoch: bridge.runtimeEpoch(), targetId: 'main' };
  const query = args => provider.run('web-network', { ...target, platform: undefined, ...args });
  const liveQuery = createLiveCaptureQuery({ runner: (command, args) => {
    validateCommandArguments(command, args);
    return provider.run(command, args);
  } });
  const host = createScriptHostPort({ target, executionId: 'capture-script', mutationLease: lease,
    query: liveQuery, actions: async (_command, args) => {
      bridge.recordNetwork({ url: '/save', method: 'POST', statusCode: 201, responseBody: '{"saved":true}' }, { actionId: args.requestId });
      return { ok: true, dispatched: true, ambiguous: false, settled: true };
    } });
  return { provider, bridge, target, query, host, facts, store, window, liveQuery, lease };
}

test('Script capture uses a persisted pre-action watermark and the exact action identity', async t => {
  const f = await fixture(t);
  const before = await f.host.call('web-network', {});
  assert.equal(before.ok, true, JSON.stringify(before));
  assert.equal(before.evidence.coverage.status, 'complete');
  const action = await f.host.call('web-click', { selector: { elementId: 'save-fixture' } });
  const after = await f.host.call('web-network', { factCursor: before.evidence.capture.watermarkCursor,
    afterActionId: action.execution.actionId });
  assert.equal(after.ok, true);
  assert.equal(after.result.items.length, 1);
  assert.equal(after.result.items[0].actionId, action.execution.actionId);
  assert.equal(after.result.items[0].association, 'explicit');
  assert.equal(after.evidence.capture.barrier.upper.sdk.sequence, 1);
  assert.equal(after.evidence.capture.barrier.upper.host.accepted, 1);
  assert.equal(after.evidence.capture.barrier.lower.sdk.sequence, 0);
  const check = condition => f.host.assert({ name: 'server saved', condition, requiredEvidence: ['network'], evidence: after.evidence });
  assert.equal((await check(after.result.items[0].statusCode === 201)).verdict, 'passed');
  assert.equal((await check(after.result.items[0].statusCode === 200)).verdict, 'failed');
  const invalid = await f.host.call('web-network', { factCursor: 'made-up', afterActionId: action.execution.actionId });
  assert.equal(invalid.ok, false);
  assert.equal((await f.host.assert({ condition: true, evidence: invalid.evidence })).verdict, 'inconclusive');
});

test('the fixed upper barrier excludes later records across pagination', async t => {
  const f = await fixture(t);
  const before = await f.query({});
  for (let index = 0; index < 17; index++) f.bridge.recordNetwork({ url: `/record/${index}`, statusCode: 200 });
  const first = await f.query({ factCursor: before.watermarkCursor });
  assert.equal(first.items.length, 16);
  assert.equal(first.hasMore, true);
  f.bridge.recordNetwork({ url: '/too-late', statusCode: 200 });
  const last = await f.query({ factCursor: before.watermarkCursor, cursor: first.nextCursor, throughCursor: first.throughCursor });
  assert.equal(last.hasMore, false);
  assert.deepEqual(last.items.map(item => item.url), ['/record/16']);
  assert.equal(last.watermarkCursor, first.watermarkCursor);
  assert.equal(last.coverage.status, 'complete');
  const wrongStream = await f.provider.run('web-events', { ...f.target, factCursor: first.watermarkCursor });
  assert.equal(wrongStream.error, 'web_capture_cursor_mismatch');
  const wrongEpoch = await f.query({ runtimeEpoch: 'another-document', factCursor: first.watermarkCursor });
  assert.equal(wrongEpoch.error, 'web_target_changed');
});

test('pending requests and missing capture sequences cannot form a passing assertion', async t => {
  let finish;
  const f = await fixture(t, { fetch: () => new Promise(resolve => { finish = resolve; }) });
  const response = f.window.fetch('/pending');
  const pending = await f.host.call('web-network', {});
  assert.equal(pending.evidence.coverage.status, 'partial', JSON.stringify(pending));
  assert.equal(pending.evidence.coverage.reasons.includes('web_capture_pending'), true);
  finish(new Response('ok')); await response;
  const cyclic = {}; cyclic.self = cyclic;
  f.bridge.recordEvent('fixture', 'invalid', cyclic);
  const lost = await f.provider.run('web-events', f.target);
  assert.equal(lost.coverage.status, 'partial');
  assert.equal(lost.coverage.gap, true);
  assert.equal((await f.host.assert({ condition: true, evidence: pending.evidence })).verdict, 'inconclusive');
});

test('Intent uses the same Web capture contract and cannot substitute a different target', async t => {
  const f = await fixture(t);
  const port = createIntentCapturePort({ query: f.liveQuery });
  const before = await port.observe({ stream: 'network' }, { target: f.target });
  f.bridge.recordNetwork({ url: '/intent-save', statusCode: 200 }, { actionId: 'intent:save' });
  const after = await port.observe({ stream: 'network', factCursor: before.watermarkCursor },
    { target: f.target, actionId: 'intent:save' });
  assert.equal(after.coverage.status, 'complete', JSON.stringify({ before, after }));
  assert.equal(after.items[0].actionId, 'intent:save');
  assert.equal(after.refs[0].source, 'host-fact-store');
  f.bridge.recordNetwork({ url: '/async-source-unknown', statusCode: 200 });
  const unfiltered = await port.observe({ stream: 'network', factCursor: before.watermarkCursor, afterActionId: null },
    { target: f.target, actionId: 'intent:save' });
  assert.equal(unfiltered.items.length, 2);
  assert.equal(unfiltered.items[1].actionId, null);
  assert.equal(unfiltered.window.afterActionId, null);
  assert.equal((await port.observe({ stream: 'network', sessionId: 'other' }, { target: f.target })).error, 'capture_target_mismatch');
});

test('explicit history remains readable after disconnect but cannot claim live completeness', async t => {
  const f = await fixture(t);
  f.bridge.recordNetwork({ url: '/saved', statusCode: 200 });
  assert.equal((await f.query({})).items.length, 1);
  f.bridge.stop();
  while (f.provider.listSessions().sessions[0].connected) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal((await f.query({})).error, 'web_target_disconnected');
  const history = await f.query({ history: true });
  assert.equal(history.items[0].url, '/saved');
  assert.equal(history.coverage.status, 'partial');
});

test('a continuation page alone cannot prove the full Script capture window', async t => {
  const f = await fixture(t);
  const before = await f.host.call('web-network', {});
  await f.host.call('web-click', { selector: { elementId: 'save-fixture' } });
  for (let index = 0; index < 17; index++) f.bridge.recordNetwork({ url: `/background/${index}` });
  const first = await f.host.call('web-network', { factCursor: before.evidence.capture.watermarkCursor });
  assert.equal(first.evidence.capture.hasMore, true);
  const last = await f.host.call('web-network', { factCursor: before.evidence.capture.watermarkCursor,
    cursor: first.evidence.capture.nextCursor, throughCursor: first.evidence.capture.watermarkCursor });
  assert.equal(last.evidence.capture.hasMore, false);
  assert.equal((await f.host.assert({ condition: true, requiredEvidence: ['network'], evidence: last.evidence })).verdict, 'inconclusive');
});

test('the production Script dispatcher preserves its action identity at the provider seam', async t => {
  const f = await fixture(t);
  const { dispatchProviderCommand } = require('../bin/execution-host');
  let dispatched;
  t.mock.method(WebBridgeProvider.prototype, 'run', async (_command, args) => {
    dispatched = args;
    return { ok: true, dispatched: true, ambiguous: false, settled: true };
  });
  const host = createScriptHostPort({ target: f.target, executionId: 'provider-identity',
    mutationLease: f.lease, actions: dispatchProviderCommand });
  const result = await host.call('web-click', { selector: { elementId: 'save-fixture' } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(dispatched.requestId, result.execution.actionId);
  assert.equal(dispatched.runtimeActionId, result.execution.actionId);
});
