'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const ownership = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-provider-switch-'));
process.env.AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR = ownership;
test.after(() => fs.rmSync(ownership, { recursive: true, force: true }));

const { createIntentWorker } = require('../bin/intent/intent-worker');
const { createIOSIntentDeviceAdapter } = require('../bin/intent/ios-intent-adapter');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { validateCommandArguments } = require('../bin/command-registry');
const { schema: nativeSchema } = require('../bin/shared-kernel/ios-native-target');
const { schema: h5Schema } = require('../bin/shared-kernel/ios-h5-target');
const entry = require('../bin/intent/intent-entry');

let sequence = 0;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t, options = {}) {
  const operationId = `provider-switch-${++sequence}`;
  const target = options.target ?? { platform: 'ios', deviceId: operationId, bundleId: 'example.hybrid',
    wdaRunnerBundleId: 'example.runner.xctrunner', wdaSessionId: 'native-session' };
  const native = { ok: true, nativeTargetSchema: nativeSchema,
    runtimeBinding: { runtimeEpoch: 'runner-epoch' },
    session: { bundleId: target.bundleId, processId: 47, sessionId: 'native-session' },
    source: { type: 'Application', children: [{ elementId: 'native-save', type: 'Button', rawIdentifier: 'save', label: 'Save',
      isVisible: '1', isEnabled: '1', rect: { x: 20, y: 40, width: 120, height: 50 } }] } };
  const pageRef = { schemaVersion: h5Schema, runtimeEpoch: 'sdk-epoch', bundleId: target.bundleId,
    processId: 47, webViewId: 'reader', documentId: 'article-1', url: 'https://example.test/article' };
  const h5 = { ok: true, h5TargetSchema: h5Schema, pageRef,
    dom: { title: 'Article', readyState: 'complete', bodyText: 'Read article', bodyTextTruncated: false, truncated: false,
      controls: [{ elementId: 'link-1', tag: 'a', id: '', name: '', type: '', text: 'Read article', ariaLabel: '',
        href: 'https://example.test/next', visible: true, disabled: false }] } };
  const calls = [];
  const provider = { run: async (command, args) => {
    calls.push({ command, args });
    if (options.run) { const result = await options.run(command, args); if (result !== undefined) return result; }
    if (command === 'ios-uia-tree') return structuredClone(native);
    if (command === 'ios-h5-dom') return structuredClone(h5);
    if (command === 'ios-h5-click' || command === 'ios-tap-native') return { ok: true, dispatched: true, settled: true };
    assert.fail(`Unexpected command: ${command}`);
  } };
  const backing = createMemoryEvidenceAdapter();
  const store = createIntentEvidenceStore({ adapter: { ...backing,
    record: envelope => options.record ? options.record(envelope, backing) : backing.record(envelope) } });
  const worker = createIntentWorker({ operationId, goal: 'Read an article and use its native toolbar', target,
    provider: options.provider ?? 'native', adapter: createIOSIntentDeviceAdapter({ provider }), store, timeoutMs: 5000 });
  t.after(async () => { if (!worker.isFinished()) await worker.cancel(); });
  const observe = args => worker.observe(validateCommandArguments('intent', { operation: 'observe', operationId, ...args }));
  const decide = (state, id, action) => worker.decide({ decisionId: id, basedOnRevision: state.revision,
    agentDecision: 'act', action: { action: 'tap', ...action } });
  return { worker, store, target, calls, observe, decide };
}

test('observe exposes provider selection without accepting a new target or WDA session', () => {
  const args = { operation: 'observe', operationId: 'intent-1', provider: 'h5' };
  assert.equal(validateCommandArguments('intent', args).provider, 'h5');
  for (const extra of [{ target: { platform: 'ios' } }, { wdaSessionId: 'replacement' }, { provider: 'auto' }]) {
    assert.throws(() => validateCommandArguments('intent', { ...args, ...extra }), error =>
      error.code === (extra.provider ? 'invalid_argument' : 'unsupported_argument') && error.field === Object.keys(extra)[0]);
  }
});

test('managed installation and permission workflows reject a provider that their UIA adapter cannot honor', async t => {
  for (const [option, moduleName, factoryName] of [
    ['install', 'install-intent', 'createInstallIntent'],
    ['permissionDialog', 'permission-intent', 'createPermissionIntent'],
  ]) {
    const module = require(`../bin/intent/${moduleName}`), original = module[factoryName];
    let reads = 0, stopped = false;
    module[factoryName] = async () => ({ isManagedWorkflow: true, isFinished: () => stopped,
      start: async () => ({ ok: true }), observe: async () => { reads++; return { ok: true }; },
      cancel: async () => { stopped = true; }, status: () => ({ status: stopped ? 'cancelled' : 'waiting_for_decision' }) });
    const operationId = `fixed-provider-${option}`;
    t.after(() => { module[factoryName] = original; });
    try {
      assert.equal((await entry.handle({ operation: 'start', operationId, [option]: {} })).ok, true);
      const rejected = await entry.handle({ operation: 'observe', operationId, provider: 'native' });
      assert.equal(rejected.error, 'managed_intent_provider_fixed'); assert.equal(rejected.dispatched, false);
      assert.equal(reads, 0);
      const selection = await entry.handle({ operation: 'observe', operationId, observationTarget: null });
      assert.equal(selection.error, 'managed_intent_observation_target_fixed'); assert.equal(selection.dispatched, false);
      assert.equal(reads, 0);
      assert.equal((await entry.handle({ operation: 'observe', operationId, provider: 'uia' })).ok, true);
      assert.equal(reads, 1);
    } finally { await entry.handle({ operation: 'cancel', operationId }); module[factoryName] = original; }
  }
});

test('explicit WebView selection follows committed observations and clears when changing provider', async t => {
  const h = fixture(t), initial = await h.worker.start();
  const invalid = await h.observe({ observationTarget: { webViewId: 'reader' } });
  assert.equal(invalid.error, 'unsupported_intent_observation_target'); assert.equal(h.calls.length, 1);
  assert.equal(invalid.revision, initial.revision);
  const web = await h.observe({ provider: 'h5', observationTarget: { webViewId: 'reader' } });
  assert.equal(web.ok, true); assert.deepEqual(web.observationTarget, { webViewId: 'reader' });
  assert.equal(h.calls.at(-1).args.webViewId, 'reader');
  await h.observe({});
  assert.equal(h.calls.at(-1).args.webViewId, 'reader');
  const native = await h.observe({ provider: 'native' });
  assert.equal(native.observationTarget, null); assert.equal(h.calls.at(-1).args.webViewId, undefined);
  await h.observe({ provider: 'h5' });
  assert.equal(h.calls.at(-1).args.webViewId, undefined, 'new provider selection has no retained hidden WebView ID');
});

test('provider failure candidates are not exposed when their evidence cannot be persisted', async t => {
  const candidates = [{ webViewId: 'reader', title: 'Article', url: 'https://example.test/article' }];
  const h = fixture(t, { run: command => command === 'ios-h5-dom'
    ? { ok: false, error: 'ios_h5_webview_ambiguous', webViews: candidates } : undefined,
  record: (envelope, backing) => envelope.stepId === 'observation-failed' ? { ok: false, error: 'ENOSPC' } : backing.record(envelope) });
  await h.worker.start();
  const failed = await h.observe({ provider: 'h5' });
  assert.equal(failed.status, 'blocked_evidence_store'); assert.equal(failed.error, 'ENOSPC');
  assert.equal(failed.provider, 'native'); assert.equal(failed.observationFailure, null);
  assert.equal(h.calls.some(call => call.command === 'ios-h5-click'), false);
});

test('cancellation drains an explicit view selection without committing its late observation', async t => {
  const entered = deferred(), release = deferred();
  const h = fixture(t, { record: async (envelope, backing) => {
    if (envelope.kind === 'summary' && envelope.revision === 2) { entered.resolve(); await release.promise; }
    return backing.record(envelope);
  } });
  await h.worker.start();
  const selecting = h.observe({ provider: 'h5', observationTarget: { webViewId: 'reader' } });
  await entered.promise;
  const cancelled = h.worker.cancel();
  release.resolve(); await selecting;
  const state = await cancelled;
  assert.equal(state.status, 'cancelled'); assert.equal(state.provider, 'native'); assert.equal(state.observationTarget, null);
  assert.equal(h.store.latest(h.worker.operationId, 'checkpoint').payloadSummary.observationTarget, null);
});

test('one Intent switches native and H5, dispatches from the new observation and recovers its final provider', async t => {
  const h = fixture(t);
  const native = await h.worker.start();
  const web = await h.observe({ provider: 'h5', basedOnRevision: native.revision });
  assert.equal(web.ok, true); assert.equal(web.summary.provider, 'h5'); assert.equal(web.revision, native.revision + 1);
  assert.equal(h.calls.length, 2, 'switch only observes');
  const stale = await h.decide(native, 'old-native', { selector: { accessibilityId: 'save' } });
  assert.equal(stale.error, 'reobserve_required'); assert.equal(stale.dispatched, false);
  const wrong = await h.decide(web, 'wrong-provider', { provider: 'native', selector: { accessibilityId: 'save' } });
  assert.equal(wrong.error, 'invalid_argument'); assert.equal(h.calls.length, 2);
  const opened = await h.decide(web, 'open-article', { selector: { text: 'Read article', tag: 'a' } });
  assert.equal(opened.ok, true); assert.equal(opened.summary.provider, 'h5');
  const click = h.calls.find(call => call.command === 'ios-h5-click');
  assert.equal(click.args.expectedTarget.pageRef.documentId, 'article-1');
  assert.equal(click.args.expectedTarget.pageRef.processId, 47);
  assert.equal(click.args.selector.elementId, 'link-1');
  assert.equal(click.args.runtimeActionId, `${h.worker.operationId}:open-article`);
  assert.equal(click.args.wdaSessionId, undefined);
  const toolbar = await h.observe({ provider: 'native', basedOnRevision: opened.revision });
  assert.equal(toolbar.summary.provider, 'native');
  const saved = await h.decide(toolbar, 'save', { selector: { accessibilityId: 'save' } });
  assert.equal(saved.ok, true);
  const tap = h.calls.find(call => call.command === 'ios-tap-native');
  assert.equal(tap.args.wdaSessionId, h.target.wdaSessionId);
  assert.equal(tap.args.expectedTarget.element.elementId, 'native-save');
  assert.equal(tap.args.expectedTarget.runnerEpoch, 'runner-epoch');
  const finalPage = await h.observe({ provider: 'h5' });
  const done = await h.worker.decide({ decisionId: 'done', basedOnRevision: finalPage.revision, agentDecision: 'complete' });
  assert.equal(done.status, 'completed');
  const records = h.store.list(h.worker.operationId);
  assert.deepEqual(records.filter(r => r.kind === 'observation').map(r => r.provider), ['native', 'h5', 'h5', 'native', 'native', 'h5']);
  assert.ok(records.every(r => r.operationId === h.worker.operationId));
  for (const record of records) assert.deepEqual(record.target, h.target);
  for (const receipt of records.filter(r => r.kind === 'action-receipt')) {
    const observation = records.find(r => r.evidenceId === receipt.parentFactId);
    assert.equal(receipt.rawTreeId, observation.rawTreeId);
    assert.equal(receipt.revision, observation.revision);
  }
  const recovered = entry.handle({ operation: 'status', operationId: h.worker.operationId, store: h.store });
  assert.equal(recovered.recovered, true); assert.equal(recovered.status, 'completed'); assert.equal(recovered.provider, 'h5');
});

test('failed provider selection blocks old actions; an omitted selection explicitly reobserves the last committed provider', async t => {
  let unavailable = true;
  const h = fixture(t, { run: command => command === 'ios-h5-dom' && unavailable ? { ok: false, error: 'ios_h5_no_webview' } : undefined });
  const native = await h.worker.start();
  const failed = await h.observe({ provider: 'h5' });
  assert.equal(failed.status, 'waiting_for_observation'); assert.equal(failed.error, 'ios_h5_no_webview');
  assert.equal(failed.summary.provider, 'native');
  const blocked = await h.decide(native, 'old', { selector: { accessibilityId: 'save' } });
  assert.equal(blocked.error, 'not_waiting_for_decision');
  const restored = await h.observe({});
  assert.equal(restored.status, 'waiting_for_decision'); assert.equal(restored.summary.provider, 'native');
  assert.equal(h.calls.at(-1).command, 'ios-uia-tree');
  unavailable = false;
  const web = await h.observe({ provider: 'h5' });
  assert.equal(web.ok, true); assert.equal(web.summary.provider, 'h5');
  assert.equal(h.calls.some(c => ['ios-h5-click', 'ios-tap-native'].includes(c.command)), false);
});

test('unsupported selection and stale observation requests leave the committed revision usable without provider I/O', async t => {
  const h = fixture(t), native = await h.worker.start();
  const malformed = await h.worker.decide(null);
  assert.equal(malformed.error, 'invalid_argument'); assert.equal(malformed.status, 'waiting_for_decision');
  const invalid = await h.observe({ provider: 'uia' });
  assert.equal(invalid.error, 'unsupported_ios_intent_provider');
  assert.equal(invalid.revision, native.revision); assert.equal(invalid.status, 'waiting_for_decision');
  const stale = await h.observe({ provider: 'h5', basedOnRevision: native.revision + 1 });
  assert.equal(stale.error, 'reobserve_required'); assert.equal(h.calls.length, 1);
  assert.equal((await h.decide(native, 'save', { selector: { accessibilityId: 'save' } })).ok, true);
});

test('H5 cannot switch to native without the WDA binding in its original target', async t => {
  const h = fixture(t, { provider: 'h5', target: { platform: 'ios', deviceId: 'h5-only-phone', bundleId: 'example.hybrid' } });
  const started = await h.worker.start();
  assert.equal(started.ok, true);
  const rejected = await h.observe({ provider: 'native' });
  assert.equal(rejected.error, 'ios_wda_session_required'); assert.equal(rejected.dispatched, false);
  assert.equal(rejected.revision, started.revision); assert.equal(rejected.summary.provider, 'h5');
  assert.equal(h.calls.length, 1);
});

for (const kind of ['observation', 'summary']) test(`failed ${kind} persistence never commits the selected provider`, async t => {
  const h = fixture(t, { record: (envelope, backing) => envelope.kind === kind && envelope.revision === 2
    ? { ok: false, error: 'ENOSPC' } : backing.record(envelope) });
  await h.worker.start();
  const failed = await h.observe({ provider: 'h5' });
  assert.equal(failed.status, 'blocked_evidence_store'); assert.equal(failed.summary.provider, 'native');
  assert.equal(h.store.latest(h.worker.operationId, 'checkpoint').payloadSummary.provider, 'native');
  assert.equal(h.calls.some(c => c.command === 'ios-h5-click'), false);
});

test('cancellation drains a pending provider switch and prevents exposing its late summary', async t => {
  const entered = deferred(), release = deferred();
  const h = fixture(t, { record: async (envelope, backing) => {
    if (envelope.kind === 'summary' && envelope.revision === 2) { entered.resolve(); await release.promise; }
    return backing.record(envelope);
  } });
  const initial = await h.worker.start();
  const switching = h.observe({ provider: 'h5' }); await entered.promise;
  try {
    assert.equal(h.worker.status().status, 'observing');
    assert.equal(h.worker.status().summary.provider, 'native');
    assert.equal((await h.observe({ provider: 'native' })).error, 'not_waiting_for_decision');
    assert.equal((await h.decide(initial, 'busy', { selector: { accessibilityId: 'save' } })).error, 'not_waiting_for_decision');
    const cancellation = h.worker.cancel();
    assert.equal(h.worker.status().status, 'cancelling');
    release.resolve(); await switching;
    const stopped = await cancellation;
    assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.summary.provider, 'native');
    assert.equal(h.store.latest(h.worker.operationId, 'checkpoint').payloadSummary.provider, 'native');
    assert.equal(stopped.pendingOperations, 0);
  } finally { release.resolve(); }
});
