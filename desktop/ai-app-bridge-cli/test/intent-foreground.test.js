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
    tap: async (ctx, x, y, options) => { calls.push(['tap', ctx.packageName, x, y, options]); foregroundPackage = foregroundPackage === home ? picker : home; return { ok: true }; },
    uiaTap: async (ctx, binding) => { calls.push(['uiaTap', ctx.packageName, binding, ctx.runtimeActionId]); foregroundPackage = home; return { ok: true }; },
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

for (const [name, changedIdentity] of [
  ['window token', `window:${home}:token2:pid100:start1000`],
  ['owner process', `window:${home}:token1:pid101:start1001`],
  ['reused owner PID', `window:${home}:token1:pid100:start2000`],
]) {
  test(`same component with a different ${name} invalidates observation and dispatch`, async () => {
    const h = harness();
    const state = await h.worker.start();
    assert.equal(state.ok, true);
    h.setWindow({ windowIdentity: changedIdentity });
    const result = await h.worker.decide({ decisionId: 'changed-identity', basedOnRevision: state.revision,
      agentDecision: 'act', action: { action: 'tap', selector: { text: '导入' } } });
    assert.equal(result.error, 'reobserve_required');
    assert.equal(h.calls.some(call => call[0] === 'tap' || call[0] === 'uiaTap'), false);
  });
}

test('same component changing its window during tree capture is not committed', async () => {
  let h;
  h = harness({ bridgeTree: async () => {
    h.setWindow({ windowIdentity: `window:${home}:token2:pid100:start1000` });
    return native;
  } });
  const result = await h.worker.start();
  assert.equal(result.error, 'foreground_changed_during_observation');
  assert.equal(result.status, 'waiting_for_observation');
  assert.equal(result.summary, null);
});

test('a window replaced during native node revalidation is rejected immediately before the action port', async () => {
  let h, reads = 0;
  h = harness({ bridgeTree: async () => {
    if (++reads === 2) h.setWindow({ windowIdentity: `window:${home}:token2:pid100:start1000` });
    return native;
  } });
  const state = await h.worker.start();
  const result = await h.worker.decide({ decisionId: 'late-replacement', basedOnRevision: state.revision,
    agentDecision: 'act', action: { action: 'tap', selector: { text: '导入' } } });
  assert.equal(result.error, 'reobserve_required');
  assert.equal(h.calls.some(call => call[0] === 'tap'), false);
});

test('UIA dispatch rechecks the canonical identity after action admission', async () => {
  let reads = 0;
  const h = harness({
    foregroundWindow: async () => ownedWindow(home, ++reads < 4 ? {} : {
      windowIdentity: `window:${home}:token2:pid100:start1000`,
    }),
    uiaTreeOnce: async () => xml.replaceAll(picker, home),
  }, { provider: 'uia', foregroundPackages: [] });
  const observed = await h.worker.start();
  assert.equal(observed.ok, true);
  const result = await h.worker.decide({ decisionId: 'late-uia-replacement', basedOnRevision: observed.revision,
    agentDecision: 'act', action: { action: 'tap', selector: { text: filename } } });
  assert.equal(result.error, 'reobserve_required');
  assert.equal(h.calls.some(call => call[0] === 'uiaTap'), false);
});

test('missing canonical identity cannot pass through equal undefined fields', async () => {
  const h = harness({ foregroundWindow: async () => ownedWindow(home, { windowIdentity: undefined }) });
  const result = await h.worker.start();
  assert.equal(result.error, 'foreground_identity_required');
  assert.deepEqual(h.calls, []);
});

test('an old route without a window identity cannot dispatch against a fresh observation', async () => {
  const h = harness();
  const observation = await h.adapter.observe({ ...h.target, provider: 'native', rawTreeId: 'route-upgrade' });
  const { windowIdentity, ...oldRoute } = observation.route;
  const result = await h.adapter.action({ ...h.target, primaryProvider: 'native', rawTree: observation.rawTree,
    actionId: 'old-route', route: oldRoute, spec: { provider: 'native', action: 'tap', selector: { text: '导入' } } });
  assert.equal(result.error, 'reobserve_required');
  assert.equal(result.dispatched, false);
  assert.equal(h.calls.some(call => call[0] === 'tap'), false);
});

test('a verified non-Activity SystemUI window routes through UIA with a nullable component', async () => {
  const system = 'com.android.systemui';
  let h;
  h = harness({
    uiaTreeOnce: async () => xml.replaceAll(picker, system),
    uiaTap: async (ctx, binding) => {
      h.calls.push(['uiaTap', ctx.packageName, binding]);
      h.setForeground(home); h.setWindow({});
      return { ok: true };
    },
  }, { foregroundPackages: [system] });
  h.setForeground(system);
  h.setWindow({ windowKind: 'non-activity', windowType: 2014, component: null, activity: null,
    windowIdentity: 'system-panel:token3:pid200:start3000' });
  const observed = await h.worker.start();
  assert.equal(observed.ok, true, JSON.stringify(observed));
  assert.equal(observed.summary.provider, 'uia');
  assert.equal(observed.summary.foreground.component, null);
  assert.equal(observed.summary.foreground.windowIdentity, 'system-panel:token3:pid200:start3000');
  const acted = await h.worker.decide({ decisionId: 'system-node', basedOnRevision: observed.revision,
    agentDecision: 'act', action: { action: 'tap', selector: { text: filename } } });
  assert.equal(acted.ok, true, JSON.stringify(acted));
  assert.equal(h.calls.filter(call => call[0] === 'uiaTap').length, 1);
  assert.equal(acted.summary.foreground.packageName, home);
});

test('a guest title on a host-owned window observes and acts using the canonical host owner', async () => {
  const guest = 'com.baidu.searchbox.tomas';
  const h = harness({ uiaTreeOnce: async () => xml.replaceAll(picker, home) },
    { provider: 'uia', foregroundPackages: [home, guest] });
  h.setWindow({ projectedComponent: `${guest}/com.baidu.perf.safemode.SafeModeActivity` });
  const observed = await h.worker.start();
  assert.equal(observed.ok, true, JSON.stringify(observed));
  assert.equal(observed.summary.foreground.packageName, home);
  assert.equal(observed.summary.foreground.ownershipVerified, true);
  assert.equal(observed.summary.foreground.ownerPid, 100);
  const acted = await h.worker.decide({ decisionId: 'host-node', basedOnRevision: observed.revision,
    agentDecision: 'act', action: { action: 'tap', selector: { text: filename } } });
  assert.equal(acted.ok, true, JSON.stringify(acted));
  const call = h.calls.find(value => value[0] === 'uiaTap');
  assert.equal(call[1], home);
  assert.equal(call[2].target.selector.packageName, home);
});

test('a non-Activity overlay owned by the primary app uses UIA rather than its Activity SDK', async () => {
  const h = harness({
    bridgeTree: async () => assert.fail('An app-owned overlay must not query an Activity SDK tree'),
    uiaTreeOnce: async () => xml.replaceAll(picker, home),
  }, { foregroundPackages: [] });
  h.setWindow({ windowKind: 'non-activity', windowType: 2038, component: null, activity: null,
    windowIdentity: 'app-overlay:token3:pid100:start1000' });
  const observed = await h.worker.start();
  assert.equal(observed.ok, true, JSON.stringify(observed));
  assert.equal(observed.summary.provider, 'uia');
  const acted = await h.worker.decide({ decisionId: 'owned-overlay', basedOnRevision: observed.revision,
    agentDecision: 'act', action: { action: 'tap', selector: { text: filename } } });
  assert.equal(acted.ok, true, JSON.stringify(acted));
  assert.equal(h.calls.filter(call => call[0] === 'uiaTap').length, 1);
});

// Retain the saved owner patch's integration boundary: replace only the OS read
// transport, so the owner parser, process/PM checks, route and node binding all run.
test('the production foreground query and Intent adapter agree on projected titles and actual owners', async t => {
  const guest = 'com.baidu.searchbox.tomas';
  for (const scenario of [
    { name: 'host-owned guest projection', owner: home, title: `${guest}/.GuestActivity`, root: home, allowed: [home, guest] },
    { name: 'original guest with a host title', owner: guest, title: `${home}/.MainActivity`, root: guest, allowed: [], error: 'foreground_package_not_allowed' },
    { name: 'verified host with a genuinely different UIA root', owner: home, title: `${guest}/.GuestActivity`, root: guest, allowed: [guest], error: 'observed_foreground_package_mismatch' },
  ]) await t.test(scenario.name, async () => {
    const fixture = androidForegroundFixture(scenario.owner, { title: scenario.title });
    const reads = [], trees = [], taps = [];
    const ports = {
      createBridgeContext: value => value,
      foregroundWindow: ctx => bridge.foregroundWindow(ctx, { adb: async (_ctx, args) => {
        reads.push(args);
        if (args.join(' ') === 'shell dumpsys window -a') return { stdout: fixture.windowDump };
        if (args.join(' ') === `shell dumpsys package ${scenario.owner}`) return { stdout: fixture.packageDump };
        assert.deepEqual(args, ['shell', 'cat', '/proc/sys/kernel/random/boot_id', `/proc/${fixture.pid}/stat`, `/proc/${fixture.pid}/status`]);
        return { stdout: fixture.processDump };
      } }),
      uiaTreeOnce: async ctx => { trees.push(ctx.packageName); return xml.replaceAll(picker, scenario.root); },
      uiaTap: async (ctx, binding) => { taps.push({ packageName: ctx.packageName, binding }); return { ok: true }; },
    };
    const adapter = createProductionIntentDeviceAdapter({ ports,
      lease: { acquire: () => ({ ok: true, release() {} }) } });
    const target = { serial: 'recorded-owner-integration', packageName: home, foregroundPackages: scenario.allowed };
    const observation = await adapter.observe({ ...target, provider: 'uia', rawTreeId: 'production-owner-tree' });
    if (scenario.error) {
      assert.equal(observation.error, scenario.error);
      assert.deepEqual(taps, []);
      if (scenario.error === 'foreground_package_not_allowed') assert.deepEqual(trees, []);
    } else {
      assert.equal(observation.ok, true, JSON.stringify(observation));
      assert.equal(observation.route.packageName, home);
      assert.equal(observation.route.ownerUid, fixture.uid);
      assert.equal(observation.route.ownerPid, fixture.pid);
      assert.equal(observation.route.ownershipVerified, true);
      const acted = await adapter.action({ ...target, route: observation.route, rawTree: observation.rawTree,
        primaryProvider: 'uia', actionId: 'production-owner-tap',
        spec: { action: 'tap', provider: 'uia', selector: { text: filename } } });
      assert.equal(acted.ok, true, JSON.stringify(acted));
      assert.equal(taps.length, 1);
      assert.equal(taps[0].packageName, home);
      assert.equal(taps[0].binding.target.selector.packageName, home);
    }
    assert.equal(reads.some(args => args.includes('input')), false);
  });
});
