'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProductionIntentDeviceAdapter } = require('../bin/intent/intent-production-adapter');
const { createIntentWorker } = require('../bin/intent/intent-worker');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const bridge = require('../bin/device-provider');
const { summarizeTree } = require('../bin/shared-kernel/summary-transformer');
const { nativeTargetRef } = require('../test-support/native-target-fixture');
const { uiaXml } = require('../test-support/uia-target-fixture');
const { androidForegroundFixture } = require('../test-support/android-foreground-fixture');

const home = 'example.notes', picker = 'com.coloros.filemanager';
const filename = 'NotallyX Backup\n2026-09-07.zip';
const xml = uiaXml(`<hierarchy><node package="${picker}" class="android.widget.FrameLayout" bounds="[0,0][400,800]"><node package="${picker}" text="NotallyX Backup&#10;2026-09-07.zip" resource-id="${picker}:id/file_name" class="android.widget.TextView" enabled="true" clickable="true" bounds="[20,100][380,180]"/></node></hierarchy>`);
const native = { activity: `${home}.MainActivity`, root: { targetRef: nativeTargetRef(), visible: true, effectiveVisible: true, enabled: true,
  className: 'android.widget.Button', text: '导入', bounds: { left: 0, top: 0, right: 400, bottom: 800 }, children: [] } };

function ownedWindow(packageName, extra = {}) {
  return { ok: true, packageName, activity: `${packageName}.MainActivity`,
    component: `${packageName}/${packageName}.MainActivity`, source: 'mCurrentFocus',
    windowKind: 'activity', windowType: 1, ownershipVerified: true,
    windowIdentity: `window:${packageName}:token1:pid100:start1000`,
    ownerUid: 10123, ownerPid: 100, bootId: 'test-boot', processStartTicks: '1000', ...extra };
}

function harness(extra = {}, { provider = 'native', foregroundPackages = [picker] } = {}) {
  let foregroundPackage = home;
  let windowFields = {};
  const calls = [];
  const ports = {
    createBridgeContext: options => options,
    foregroundWindow: async () => ownedWindow(foregroundPackage, windowFields),
    bridgeTree: async ctx => { calls.push(['native', ctx.packageName]); return native; },
    uiaTreeOnce: async ctx => { calls.push(['uia', ctx.packageName]); return xml; },
    tap: async (ctx, x, y, options) => { calls.push(['tap', ctx.packageName, x, y, options]); foregroundPackage = foregroundPackage === home ? picker : home; return { ok: true, dispatched: true, ambiguous: false }; },
    uiaTap: async (ctx, binding) => { calls.push(['uiaTap', ctx.packageName, binding, ctx.runtimeActionId]); foregroundPackage = home; return { ok: true, dispatched: true, ambiguous: false }; },
    findUiaNodeByAny: bridge.findUiaNodeByAny,
    ...extra,
  };
  const adapter = createProductionIntentDeviceAdapter({ ports });
  const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const target = { platform: 'android', serial: 'foreground-test', packageName: home, foregroundPackages };
  const worker = createIntentWorker({ operationId: `foreground-${Math.random()}`, goal: '导入后返回笔记', target, provider, adapter, store });
  return { adapter, worker, target, calls, setForeground: value => { foregroundPackage = value; },
    setWindow: value => { windowFields = value; } };
}

test('UIA lookup, compact tree and Intent summary decode numeric XML entities exactly once', () => {
  assert.equal(bridge.findUiaNodeByAny(xml, { texts: [filename], exact: true })?.matched.text, filename);
  assert.equal(bridge.compactUiaTree(xml).nodes.find(n => n.text)?.text, filename);
  assert.equal(summarizeTree({ provider: 'uia', rawTree: xml, rawTreeId: 'xml' }).nodes.find(n => n.text)?.text, filename);
  const escaped = xml.replace('NotallyX Backup&#10;2026-09-07.zip', 'A&#x1F4C4;&#xA;&amp;#10;&quot;&lt;');
  assert.equal(bridge.findUiaNodeByAny(escaped, { texts: ['A📄\n&#10;"<'], exact: true })?.matched.text, 'A📄\n&#10;"<');
});

test('Intent keeps the explicit provider and package until the agent changes the observation target', async () => {
  const h = harness();
  let state = await h.worker.start();
  state = await h.worker.decide({ decisionId: 'open', basedOnRevision: state.revision, agentDecision: 'act', action: { action: 'tap', selector: { text: '导入' } } });
  assert.equal(state.ok, true);
  assert.equal(state.summary.provider, 'native');
  assert.equal(state.summary.foreground.packageName, picker);
  assert.equal(state.summary.executionTarget.packageName, home);
  assert.equal(state.summary.warnings[0].code, 'foreground_package_mismatch');
  assert.equal(h.calls.some(c => c[0] === 'uia'), false);
  state = await h.worker.observe({ provider: 'uia', observationTarget: { packageName: picker } });
  assert.equal(state.ok, true, JSON.stringify(state));
  assert.equal(state.summary.provider, 'uia');
  state = await h.worker.decide({ decisionId: 'file', basedOnRevision: state.revision, agentDecision: 'act', action: { action: 'tap', selector: { text: filename } } });
  assert.equal(state.ok, true, JSON.stringify(state));
  assert.deepEqual(h.calls.filter(c => c[0] === 'tap' || c[0] === 'uiaTap').map(c => c[1]), [home, picker]);
  assert.equal(h.worker.context.target.packageName, home);
});

for (const [name, fields] of [
  ['probe failure', { ok: false, error: 'foreground_window_type_missing', ownershipVerified: false, evidence: { window: 'mAttrs=unknown' } }],
  ['window change', { windowIdentity: 'different-window' }],
  ['missing identity', { ok: false, error: 'foreground_window_identity_missing', windowIdentity: undefined, ownershipVerified: false }],
]) test(`Intent returns ${name} without blocking a bound action or later observation`, async () => {
  const h = harness();
  let state = await h.worker.start();
  h.setWindow(fields);
  state = await h.worker.decide({ decisionId: name, basedOnRevision: state.revision, agentDecision: 'act', action: { action: 'tap', selector: { text: '导入' } } });
  assert.equal(state.ok, true, JSON.stringify(state));
  assert.equal(h.calls.filter(c => c[0] === 'tap').length, 1);
  assert.ok(state.lastAction.warnings.length);
  assert.equal(state.lastAction.dispatched, true);
  const observed = await h.worker.observe();
  assert.equal(observed.ok, true);
  if (fields.ok === false) {
    assert.equal(observed.summary.foreground.ok, false);
    assert.equal(observed.summary.foreground.ownershipVerified, false);
    assert.equal(observed.summary.warnings[0].code, fields.error);
  }
});

test('unlisted actual foreground remains a warning, with the original app tree and no guessed ownership', async () => {
  const h = harness(); h.setForeground('other.app');
  const state = await h.worker.start();
  assert.equal(state.ok, true);
  assert.equal(state.summary.foreground.packageName, 'other.app');
  assert.equal(state.summary.executionTarget.packageName, home);
  assert.equal(state.summary.warnings[0].status, 'mismatch');
  assert.deepEqual(h.calls, [['native', home]]);
});

test('a foreground change during capture returns the tree with both observations and a warning', async () => {
  let h;
  h = harness({ bridgeTree: async () => { h.setForeground(picker); return native; } });
  const result = await h.worker.start();
  assert.equal(result.ok, true);
  assert.equal(result.status, 'waiting_for_decision');
  assert.equal(result.summary.provider, 'native');
  assert.ok(result.summary.warnings.some(w => w.code === 'foreground_changed'));
  assert.equal(result.summary.foregroundObservations[0].actual.packageName, home);
  assert.equal(result.summary.foregroundObservations[1].actual.packageName, picker);
});

test('a UIA tree belonging to another app is reported as observed; the explicit target selector does not migrate', async () => {
  const h = harness({}, { provider: 'uia' });
  const state = await h.worker.start();
  const action = await h.worker.decide({ decisionId: 'foreign-tree', basedOnRevision: state.revision,
    agentDecision: 'act', action: { action: 'tap', selector: { text: filename } } });
  assert.equal(action.ok, false);
  assert.equal(action.error, 'uia_selector_not_found');
  assert.equal(action.lastAction.dispatched, false);
  assert.equal(h.calls.some(c => c[0] === 'uiaTap'), false);
  assert.equal((await h.worker.observe()).ok, true);
});

test('node replacement is still an action failure; fresh observation can continue the same Intent', async () => {
  let reads = 0;
  const changed = structuredClone(native); changed.root.targetRef.viewId = 'replacement';
  const h = harness({ bridgeTree: async () => ++reads === 1 ? native : changed });
  const state = await h.worker.start();
  const result = await h.worker.decide({ decisionId: 'replaced', basedOnRevision: state.revision, agentDecision: 'act', action: { action: 'tap', selector: { text: '导入' } } });
  assert.equal(result.error, 'reobserve_required');
  assert.equal(result.lastAction.dispatched, false);
  assert.equal(h.calls.some(c => c[0] === 'tap'), false);
  assert.equal((await h.worker.observe()).ok, true);
});

test('a failed node action retains foreground warnings and leaves later commands available', async () => {
  const h = harness({ tap: async () => ({ ok: false, error: 'native_target_not_operable', dispatched: false, ambiguous: false }) });
  let state = await h.worker.start(); h.setForeground(picker);
  state = await h.worker.decide({ decisionId: 'failed-node', basedOnRevision: state.revision, agentDecision: 'act', action: { action: 'tap', selector: { text: '导入' } } });
  assert.equal(state.error, 'native_target_not_operable');
  assert.equal(state.lastAction.dispatched, false);
  assert.equal(state.lastAction.ambiguous, false);
  assert.equal(state.lastAction.warnings[0].code, 'foreground_package_mismatch');
  assert.equal((await h.worker.observe()).ok, true);
});

test('provider override requires an explicit new observation', async () => {
  const h = harness(); const state = await h.worker.start();
  const result = await h.worker.decide({ decisionId: 'wrong-provider', basedOnRevision: state.revision,
    agentDecision: 'act', action: { action: 'tap', provider: 'uia', selector: { text: filename } } });
  assert.equal(result.error, 'invalid_argument'); assert.equal(result.field, 'decision.action.provider');
  assert.equal(h.calls.some(c => c[0] === 'tap' || c[0] === 'uiaTap'), false);
});

test('duplicate exact UIA text never chooses the first match', async () => {
  const duplicate = uiaXml(`<hierarchy><node package="${picker}" class="android.widget.FrameLayout" bounds="[0,0][400,800]">${[100, 200].map(top => `<node package="${picker}" class="android.widget.TextView" text="NotallyX Backup&#10;2026-09-07.zip" enabled="true" clickable="true" bounds="[20,${top}][380,${top + 80}]"/>`).join('')}</node></hierarchy>`);
  const h = harness({ uiaTreeOnce: async () => duplicate }, { provider: 'uia' });
  const started = await h.worker.start();
  assert.equal(started.ok, true, JSON.stringify(started));
  const state = await h.worker.observe({ provider: 'uia', observationTarget: { packageName: picker } });
  assert.equal(state.ok, true, JSON.stringify(state));
  const result = await h.worker.decide({ decisionId: 'duplicate', basedOnRevision: state.revision, agentDecision: 'act', action: { action: 'tap', selector: { text: filename } } });
  assert.equal(result.error, 'uia_selector_not_unique');
  assert.equal(result.lastAction.dispatched, false);
});

test('the production parser and Intent adapter preserve actual owner independently of explicit target', async () => {
  const fixture = androidForegroundFixture(picker, { apiLevel: 25, title: `${home}/.Projected` });
  fixture.windowDump = fixture.windowDump.replace('mAttrs={', 'mAttrs=WM.LayoutParams{');
  const h = harness({ foregroundWindow: ctx => bridge.foregroundWindow(ctx, { adb: async (_ctx, args) => {
    if (args.join(' ') === 'shell dumpsys window -a') return { stdout: fixture.windowDump };
    if (args.join(' ') === `shell dumpsys package ${picker}`) return { stdout: fixture.packageDump };
    return { stdout: fixture.processDump };
  } }) });
  const state = await h.worker.start();
  assert.equal(state.ok, true, JSON.stringify(state));
  assert.equal(state.summary.foreground.packageName, picker);
  assert.equal(state.summary.foreground.ownershipVerified, true);
  assert.equal(state.summary.foreground.ownerUid, fixture.uid);
  assert.equal(state.summary.executionTarget.packageName, home);
  assert.equal(state.summary.warnings[0].code, 'foreground_package_mismatch');
});
