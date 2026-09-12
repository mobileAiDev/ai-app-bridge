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

const home = 'example.notes', picker = 'com.coloros.filemanager';
const filename = 'NotallyX Backup\n2026-09-07.zip';
const xml = uiaXml(`<hierarchy><node package="${picker}" class="android.widget.FrameLayout" bounds="[0,0][400,800]"><node package="${picker}" text="NotallyX Backup&#10;2026-09-07.zip" resource-id="${picker}:id/file_name" class="android.widget.TextView" enabled="true" clickable="true" bounds="[20,100][380,180]"/></node></hierarchy>`);
const native = { activity: `${home}.MainActivity`, root: { targetRef: nativeTargetRef(), visible: true, effectiveVisible: true, enabled: true,
  className: 'android.widget.Button', text: '导入', bounds: { left: 0, top: 0, right: 400, bottom: 800 }, children: [] } };

function harness(extra = {}) {
  let foregroundPackage = home;
  const calls = [];
  const ports = {
    createBridgeContext: options => options,
    foregroundWindow: async () => ({ ok: true, packageName: foregroundPackage, activity: `${foregroundPackage}.MainActivity`,
      component: `${foregroundPackage}/${foregroundPackage}.MainActivity`, source: 'mCurrentFocus' }),
    bridgeTree: async ctx => { calls.push(['native', ctx.packageName]); return native; },
    uiaTreeOnce: async ctx => { calls.push(['uia', ctx.packageName]); return xml; },
    tap: async (ctx, x, y, options) => { calls.push(['tap', ctx.packageName, x, y, options]); foregroundPackage = foregroundPackage === home ? picker : home; return { ok: true }; },
    uiaTap: async (ctx, binding) => { calls.push(['uiaTap', ctx.packageName, binding, ctx.runtimeActionId]); foregroundPackage = home; return { ok: true }; },
    findUiaNodeByAny: bridge.findUiaNodeByAny,
    ...extra,
  };
  const adapter = createProductionIntentDeviceAdapter({ ports });
  const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const target = { platform: 'android', serial: 'foreground-test', packageName: home, foregroundPackages: [picker] };
  const worker = createIntentWorker({ operationId: `foreground-${Math.random()}`, goal: '导入后返回笔记', target, provider: 'native', adapter, store });
  return { adapter, worker, target, calls, setForeground: value => { foregroundPackage = value; } };
}

test('UIA lookup, compact tree and Intent summary decode numeric XML entities exactly once', () => {
  assert.equal(bridge.findUiaNodeByAny(xml, { texts: [filename], exact: true })?.matched.text, filename);
  assert.equal(bridge.compactUiaTree(xml).nodes.find(n => n.text)?.text, filename);
  assert.equal(summarizeTree({ provider: 'uia', rawTree: xml, rawTreeId: 'xml' }).nodes.find(n => n.text)?.text, filename);
  const escaped = xml.replace('NotallyX Backup&#10;2026-09-07.zip', 'A&#x1F4C4;&#xA;&amp;#10;&quot;&lt;');
  assert.equal(bridge.findUiaNodeByAny(escaped, { texts: ['A📄\n&#10;"<'], exact: true })?.matched.text, 'A📄\n&#10;"<');
});

test('one supervised Intent observes native -> allowed system UIA -> native and attributes actions to the observed package', async () => {
  const h = harness();
  let state = await h.worker.start();
  assert.equal(state.ok, true);
  state = await h.worker.decide({ decisionId: 'open', basedOnRevision: state.revision, agentDecision: 'act', action: { action: 'tap', selector: { text: '导入' } } });
  assert.equal(state.ok, true);
  assert.equal(state.summary.provider, 'uia');
  assert.equal(state.summary.foreground.packageName, picker);
  assert.equal(state.summary.nodes.find(n => n.text)?.text, filename);
  state = await h.worker.decide({ decisionId: 'file', basedOnRevision: state.revision, agentDecision: 'act',
    action: { action: 'tap', selector: { text: filename } } });
  assert.equal(state.ok, true);
  assert.equal(state.summary.provider, 'native');
  assert.equal(state.summary.foreground.packageName, home);
  assert.deepEqual(h.calls.filter(c => c[0] === 'tap' || c[0] === 'uiaTap').map(c => c[1]), [home, picker]);
  const uia = h.calls.find(c => c[0] === 'uiaTap');
  assert.deepEqual(uia[2].target.selector, { kind: 'text', value: filename, exact: true, packageName: picker });
  assert.match(uia[3], /:file$/, 'the original Intent action ID reaches the node runtime');
  assert.equal(h.calls.filter(c => c[0] === 'tap').length, 1, 'only the native action uses the native tap port');
  assert.equal(h.worker.context.target.packageName, home, 'the business/capture target stays the original app');
});

test('foreground changes after observation require reobserve and dispatch no tap', async () => {
  const h = harness();
  const state = await h.worker.start();
  h.setForeground(picker);
  const result = await h.worker.decide({ decisionId: 'stale', basedOnRevision: state.revision, agentDecision: 'act', action: { action: 'tap', selector: { text: '导入' } } });
  assert.equal(result.ok, false); assert.equal(result.error, 'reobserve_required');
  assert.equal(h.calls.filter(c => c[0] === 'tap').length, 0);
  assert.equal((await h.worker.observe()).summary.provider, 'uia');
});

test('unlisted foreground package is explicit failure and no provider tree is read', async () => {
  const h = harness(); h.setForeground('other.app');
  const result = await h.worker.start();
  assert.equal(result.ok, false); assert.equal(result.error, 'foreground_package_not_allowed');
  assert.deepEqual(h.calls, []);
});

test('foreground transition during tree capture does not publish the old tree', async () => {
  let h;
  h = harness({ bridgeTree: async () => { h.setForeground(picker); return native; } });
  const result = await h.worker.start();
  assert.equal(result.ok, false); assert.equal(result.error, 'foreground_changed_during_observation');
  assert.equal(result.summary, null);
  assert.equal(result.status, 'waiting_for_observation');
  assert.equal((await h.worker.decide({ decisionId: 'stale', agentDecision: 'complete' })).error, 'not_waiting_for_decision');
  const refreshed = await h.worker.observe();
  assert.equal(refreshed.ok, true); assert.equal(refreshed.summary.provider, 'uia'); assert.equal(refreshed.error, null);
});

test('a UIA dump from a different package cannot be published under the foreground identity', async () => {
  const h = harness({ uiaTreeOnce: async () => xml.replaceAll(picker, 'other.app') }); h.setForeground(picker);
  const result = await h.worker.start();
  assert.equal(result.ok, false); assert.equal(result.error, 'observed_foreground_package_mismatch');
  assert.equal(result.summary, null);
});

test('invalid XML character references fail before selection', () => {
  for (const reference of ['&#0;', '&#xD800;', '&#1114112;']) {
    assert.throws(() => bridge.findUiaNodeByAny(xml.replace('&#10;', reference), { texts: [filename], exact: true }), /invalid_xml_character_reference/);
  }
});

test('a provider override cannot apply native coordinates to a UIA observation', async () => {
  const h = harness(); h.setForeground(picker);
  const state = await h.worker.start();
  const result = await h.worker.decide({ decisionId: 'wrong-provider', basedOnRevision: state.revision, agentDecision: 'act',
    action: { action: 'tap', provider: 'native', selector: { text: filename } } });
  assert.equal(result.ok, false); assert.equal(result.error, 'invalid_argument');
  assert.equal(result.field, 'decision.action.provider');
  assert.equal(h.calls.filter(c => c[0] === 'tap').length, 0);
});

test('duplicate exact UIA text cannot silently pick the first file', async () => {
  const duplicate = uiaXml(`<hierarchy><node package="${picker}" class="android.widget.FrameLayout" bounds="[0,0][400,800]"><node package="${picker}" text="NotallyX Backup&#10;2026-09-07.zip" resource-id="${picker}:id/file_name" class="android.widget.TextView" enabled="true" clickable="true" bounds="[20,100][380,180]"/><node package="${picker}" text="NotallyX Backup&#10;2026-09-07.zip" resource-id="${picker}:id/file_name" class="android.widget.TextView" enabled="true" clickable="true" bounds="[20,200][380,280]"/></node></hierarchy>`);
  const h = harness({ uiaTreeOnce: async () => duplicate }); h.setForeground(picker);
  const state = await h.worker.start();
  assert.equal(state.ok, true, JSON.stringify(state));
  const result = await h.worker.decide({ decisionId: 'ambiguous-file', basedOnRevision: state.revision, agentDecision: 'act', action: { action: 'tap', selector: { text: filename } } });
  assert.equal(result.ok, false); assert.equal(result.error, 'uia_selector_not_unique');
  assert.equal(h.calls.filter(c => c[0] === 'tap').length, 0);
});
