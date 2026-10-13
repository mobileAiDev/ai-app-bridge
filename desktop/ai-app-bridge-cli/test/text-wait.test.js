'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { waitText } = require('../bin/device-provider');
const { visibleLabels, validateTextConditions } = require('../bin/shared-kernel/text-wait');
const { runExecution, executionSleep } = require('../bin/shared-kernel/execution-scope');
const { validateCommandArguments, parseCliOptions } = require('../bin/command-registry');

const ctx = { packageName: 'example.app', explicitPackageName: true };
const fg = { ok: true, packageName: 'example.app', component: 'example.app/.Main', activity: 'example.app.Main',
  windowKind: 'activity', windowType: 1, ownershipVerified: true, windowIdentity: 'window:token1:pid100:start1000' };
const node = text => ({ visible: true, enabled: true, text, bounds: { left: 0, top: 0, right: 100, bottom: 200 } });
const tree = (...texts) => ({ coverage: { status: 'complete' }, activity: { current: 'Metadata only' }, root: { ...node(''), children: texts.map(node) } });
function ports(extra = {}) {
  return { foregroundWindow: async () => fg, bridgeTree: async () => tree('Save, draft'),
    flutterNodes: async () => ({ nodes: [] }), uiaTreeOnce: async () => '<hierarchy><node text="Other page"/></hierarchy>', ...extra };
}

test('one wait returns whichever visible network outcome arrives, without waiting for success after failure', async () => {
  const args = { packageName: 'example.app', provider: 'native', anyText: ['Login successful', 'Network unavailable', 'Verification required'],
    timeoutMs: 1000, intervalMs: 2 };
  validateCommandArguments('wait-text', args);
  let reads = 0;
  const result = await waitText(ctx, undefined, args, ports({ bridgeTree: async () => tree(++reads === 1 ? 'Signing in…' : 'Network unavailable') }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.matched.anyMatched, ['Network unavailable']);
  assert.equal(reads, 2);
  assert.ok(result.elapsedMs < 500);
});

test('wait-text validates units, exact arrays, conflicting conditions and explicit absence provider', () => {
  const args = { packageName: 'example.app', targetText: 'Save, draft', requireText: ['Editor, v2'], timeoutMs: 1000 };
  assert.deepEqual(validateCommandArguments('wait-text', args).requireText, ['Editor, v2']);
  assert.deepEqual(parseCliOptions('wait-text', { requireText: '["Editor, v2"]', timeoutMs: '1000' }), { requireText: ['Editor, v2'], timeoutMs: 1000 });
  for (const invalid of [
    { ...args, timeoutSec: 1 }, { ...args, requireText: 'Editor, v2' },
    { ...args, requireText: Array.from({ length: 65 }, (_, index) => `label-${index}`) },
    { ...args, absentText: ['Save, draft'] }, { packageName: 'example.app', absentText: ['Loading'], provider: 'auto' },
  ]) assert.throws(() => validateCommandArguments('wait-text', invalid));
  assert.deepEqual(validateTextConditions({ absentText: ['Loading'], provider: 'uia' }).absent, ['Loading']);
});

test('visible text excludes status metadata, background windows and hidden descendants', () => {
  const data = tree('Background');
  data.foregroundWindowId = 'dialog';
  data.windows = [{ windowId: 'activity', type: 'activity', root: data.root }, { windowId: 'dialog', type: 'dialog', root: { ...node('Confirm'), children: [{ ...node('Hidden'), visible: false }] } }];
  assert.deepEqual([...visibleLabels('native', data)], ['Confirm']);
  assert.deepEqual([...visibleLabels('flutter', { widgetDump: { text: 'Old page' }, nodes: [{ text: 'Current' }, { text: 'Offstage', offstage: true }] })], ['Current']);
  assert.deepEqual([...visibleLabels('uia', '<hierarchy><node text="Hidden" visible-to-user="false"><node text="Child"/></node><node text="Current"/></hierarchy>')], ['Current']);
});

test('an exact label containing a comma and required Activity matches in one fresh snapshot', async () => {
  const result = await waitText(ctx, 'Save, draft', { provider: 'native', timeoutMs: 100,
    requireText: ['Editor, v2'], requireActivity: 'example.app.Main', absentText: ['Loading'] },
  ports({ bridgeTree: async () => tree('Save, draft', 'Editor, v2') }));
  assert.equal(result.ok, true); assert.equal(result.matched.provider, 'native');
  assert.ok(result.matched.observedAtMs > 0);
});

test('wait-text cannot assemble a passing condition from different providers or partial labels', async () => {
  for (const [targetText, options, dependencies] of [
    ['Save', { provider: 'native' }, ports()],
    ['Save, draft', { provider: 'auto', requireText: ['Other page'] }, ports()],
    ['Metadata only', { provider: 'native' }, ports()],
  ]) {
    const result = await waitText(ctx, targetText, { timeoutMs: 35, intervalMs: 5, ...options }, dependencies);
    assert.equal(result.ok, false); assert.equal(result.error, 'deadline_exceeded');
  }
});

test('pure absence cannot pass when observation fails or returns invalid material', async () => {
  for (const read of [async () => { throw new Error('SDK disconnected'); }, async () => ({ ok: false, error: 'timeout' }), async () => ({ root: {} })]) {
    const result = await waitText(ctx, undefined, { provider: 'native', absentText: ['Loading'], timeoutMs: 40, intervalMs: 5 }, ports({ bridgeTree: read }));
    assert.equal(result.ok, false); assert.equal(result.error, 'observation_unavailable'); assert.equal(result.dispatched, false);
    assert.equal(result.deadlineExceeded, true); assert.ok(result.attempts > 1); assert.ok(result.elapsedMs >= 35);
  }
});

test('transient observation failures recover within one deadline without repeated foreground dumps', async () => {
  let reads = 0, probes = 0;
  const result = await waitText(ctx, 'Ready', { provider: 'native', timeoutMs: 500, intervalMs: 2 }, ports({
    foregroundWindow: async () => { probes++; return fg; },
    bridgeTree: async () => {
      if (++reads === 1) throw Object.assign(new Error('Connection restarting'), { code: 'bridge_connection_refused' });
      if (reads === 2) return { ok: false, error: 'no_current_activity', message: 'Activity is starting' };
      if (reads === 3) return tree('Loading');
      return tree('Ready');
    },
  }));
  assert.equal(result.ok, true); assert.equal(result.attempts, 4); assert.equal(result.failedReads, 2);
  assert.equal(result.successfulReads, 2); assert.equal(probes, 2);
  assert.equal(result.failures[0].error, 'no_current_activity');
  assert.equal(result.failures[0].message, 'Activity is starting');
  assert.equal(result.foregroundObservations.length, 2);
});

test('Flutter wait retains the provider timeout phase without requiring another diagnostic read', async () => {
  for (const phase of ['android-main-queue', 'flutter-channel', 'frame']) {
    const observation = { phase, timeoutMs: 2000 };
    let reads = 0;
    const result = await waitText(ctx, 'Ready', { provider: 'flutter', timeoutMs: 500, intervalMs: 1 }, ports({
      flutterNodes: async () => ++reads === 1
        ? { ok: false, error: 'flutter_observation_timeout', observation }
        : { nodes: [{ text: 'Ready' }] },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.failedReads, 1);
    assert.equal(reads, 2);
    assert.deepEqual(result.failures[0].observation, observation);
  }
});

test('a system ANR dialog is visible in bounded wait diagnostics without another device read', async () => {
  const { withActionGuidance } = require('../bin/shared-kernel/action-guidance');
  const args = { serial: 'phone', packageName: 'example.app', provider: 'uia', targetText: 'Take note', timeoutMs: 35, intervalMs: 5 };
  let reads = 0;
  const result = await waitText(ctx, args.targetText, args, ports({ uiaTreeOnce: async () => {
    reads++;
    return '<hierarchy><node text="Example app isn&apos;t responding"/><node text="Close app"/><node text="Wait"/></hierarchy>';
  } }));
  assert.equal(result.error, 'deadline_exceeded');
  assert.deepEqual(result.observedText, { labels: ["Example app isn't responding", 'Close app', 'Wait'], truncated: false });
  assert.equal(reads, result.successfulReads);
  const guided = withActionGuidance('wait-text', args, result);
  const inspect = guided.guidance.nextActions.find(call => call.command === 'uia-tree');
  assert(inspect); validateCommandArguments(inspect.command, inspect.arguments);
  assert.equal(inspect.arguments.serial, 'phone');
  assert.equal(inspect.arguments.packageFilter, undefined, 'system overlays must remain observable');
  assert.equal(reads, result.successfulReads, 'guidance never runs recovery commands');
});

test('wait failure previews bound long text without changing exact matching', async () => {
  const labels = Array.from({ length: 20 }, (_, i) => `${i}:` + 'x'.repeat(1000));
  const result = await waitText(ctx, 'x', { provider: 'native', timeoutMs: 30, intervalMs: 5 }, ports({ bridgeTree: async () => tree(...labels) }));
  assert.equal(result.ok, false);
  assert.equal(result.observedText.labels.length, 12);
  assert(result.observedText.labels.every(label => label.length === 160));
  assert.equal(result.observedText.truncated, true);
  const success = await waitText(ctx, labels[0], { provider: 'native', timeoutMs: 100 }, ports({ bridgeTree: async () => tree(...labels) }));
  assert.equal(success.ok, true);
  assert.equal(success.observedText, undefined, 'successful waits remain concise');
});

test('an optional foreground probe cannot consume the entire text deadline', async () => {
  let reads = 0;
  const result = await waitText(ctx, 'Ready', { provider: 'native', timeoutMs: 240 }, ports({
    bridgeTree: async () => { reads++; return tree('Ready'); },
    foregroundWindow: async () => { await executionSleep(10000); return fg; },
  }));
  assert.equal(result.ok, true); assert.equal(reads, 1);
  assert.equal(result.foregroundObservations.at(-1).status, 'unknown');
  assert.ok(result.warnings.some(warning => warning.code === 'deadline_exceeded'));
});

test('partial/unknown coverage permits positive evidence and explicit observed absence, but cannot prove complete absence', async () => {
  const { withActionGuidance } = require('../bin/shared-kernel/action-guidance');
  for (const coverage of [{ status: 'partial' }, undefined]) {
    const rawTree = { ...tree('Ready'), coverage };
    const deps = ports({ bridgeTree: async () => rawTree });
    assert.equal((await waitText(ctx, 'Ready', { timeoutMs: 100 }, deps)).ok, true);
    const args = { packageName: 'example.app', provider: 'native', absentText: ['Loading'], timeoutMs: 30, intervalMs: 4 };
    const strict = await waitText(ctx, undefined, args, deps);
    assert.equal(strict.ok, false); assert.equal(strict.lastCheck.absenceProven, false);
    assert.deepEqual(strict.lastCheck.unexpected, []);
    const guided = withActionGuidance('wait-text', args, strict);
    const choice = guided.guidance.nextActions.find(call => call.command === 'wait-text');
    validateCommandArguments(choice.command, choice.arguments);
    assert.equal(choice.arguments.absenceScope, 'observed');
    const observed = await waitText(ctx, undefined, choice.arguments, deps);
    assert.equal(observed.ok, true); assert.equal(observed.matched.absenceScope, 'observed');
    assert.equal(observed.matched.coverage.status, coverage?.status || 'unknown');
  }
});

test('a complete later capture establishes absence, and background coverage does not contaminate the foreground', async () => {
  let reads = 0;
  const result = await waitText(ctx, undefined, { provider: 'native', absentText: ['Loading'], timeoutMs: 200, intervalMs: 2 }, ports({
    bridgeTree: async () => ({ foregroundWindowId: 'dialog', windows: [
      { windowId: 'activity', coverage: { status: 'partial' }, root: tree('Loading').root },
      { windowId: 'dialog', coverage: { status: ++reads === 1 ? 'partial' : 'complete' }, root: tree('Ready').root },
    ] }),
  }));
  assert.equal(result.ok, true); assert.equal(reads, 2); assert.equal(result.matched.coverage.status, 'complete');
});

test('a known truncated label cannot match its prefix as a whole label in Native or Flutter', async () => {
  for (const provider of ['native', 'flutter']) {
    const item = { ...node('prefix'), textTruncated: true };
    const rawTree = provider === 'native' ? { ...tree(), root: item } : { truncated: false, nodes: [item] };
    assert.deepEqual([...visibleLabels(provider, rawTree)], []);
    const deps = ports({ bridgeTree: async () => rawTree, flutterNodes: async () => rawTree });
    const result = await waitText(ctx, 'prefix', { provider, timeoutMs: 25, intervalMs: 3 }, deps);
    assert.equal(result.ok, false); assert.equal(result.lastCheck.coverage.status, 'partial');
  }
});

test('UIA coverage retains missing-root warnings even from an older incorrect truncated:false envelope', async () => {
  const xml = '<hierarchy aab-truncated="false" aab-warnings="[{&quot;code&quot;:&quot;uia_window_root_unavailable&quot;}]"><node text="Ready"/></hierarchy>';
  const deps = ports({ uiaTreeOnce: async () => xml });
  const positive = await waitText(ctx, 'Ready', { provider: 'uia', timeoutMs: 100 }, deps);
  assert.equal(positive.ok, true); assert.equal(positive.matched.coverage.status, 'partial');
  const absent = await waitText(ctx, undefined, { provider: 'uia', absentText: ['Loading'], timeoutMs: 25, intervalMs: 3 }, deps);
  assert.equal(absent.ok, false); assert.equal(absent.lastCheck.absenceProven, false);
});

test('foreground changes are warnings independent of the text predicate', async () => {
  let reads = 0;
  const result = await waitText(ctx, 'Save, draft', { provider: 'native', timeoutMs: 100 }, ports({
    foregroundWindow: async () => ++reads === 1 ? fg : { ...fg, component: 'example.app/.Other' },
  }));
  assert.equal(result.ok, true); assert.equal(result.warnings[0].code, 'foreground_changed');
});

for (const identity of ['window:token2:pid100:start1000', 'window:token1:pid101:start1001', 'window:token1:pid100:start2000']) {
  test(`text matches retain a warning for changed canonical identity ${identity}`, async () => {
    let reads = 0;
    const result = await waitText(ctx, 'Save, draft', { provider: 'native', timeoutMs: 100 }, ports({
      foregroundWindow: async () => ++reads === 1 ? fg : { ...fg, windowIdentity: identity },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.warnings[0].code, 'foreground_changed');
  });
}

test('a failed foreground probe does not replace successful provider text evidence', async () => {
  const result = await waitText(ctx, 'Save, draft', { provider: 'native', timeoutMs: 100 }, ports({
    foregroundWindow: async () => ({ ok: false, error: 'foreground_window_identity_missing' }),
  }));
  assert.equal(result.ok, true);
  assert.equal(result.warnings[0].code, 'foreground_window_identity_missing');
  assert.equal(result.matched.activity, null);
});

test('UIA text can match a verified non-Activity window without inventing an Activity', async () => {
  const foreground = { ...fg, windowKind: 'non-activity', windowType: 2014, component: null, activity: null };
  const result = await waitText(ctx, 'Other page', { provider: 'uia', timeoutMs: 100 }, ports({
    foregroundWindow: async () => foreground,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.matched.activity, null);
});

test('wait cancellation interrupts an owned provider read and cannot pass absence', async () => {
  const controller = new AbortController();
  const result = runExecution({ signal: controller.signal, timeoutMs: 1000 }, () => waitText(ctx, undefined,
    { provider: 'native', absentText: ['Loading'], timeoutMs: 1000 }, ports({ bridgeTree: async () => {
      controller.abort({ code: 'cancelled' }); await executionSleep(1000); return tree();
    } })));
  await assert.rejects(result, { code: 'cancelled', dispatched: false });
});
