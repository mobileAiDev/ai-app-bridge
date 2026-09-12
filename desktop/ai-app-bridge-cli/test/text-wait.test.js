'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { waitText } = require('../bin/device-provider');
const { visibleLabels, validateTextConditions } = require('../bin/shared-kernel/text-wait');
const { runExecution, executionSleep } = require('../bin/shared-kernel/execution-scope');
const { validateCommandArguments, parseCliOptions } = require('../bin/command-registry');

const ctx = { packageName: 'example.app', explicitPackageName: true };
const fg = { ok: true, packageName: 'example.app', component: 'example.app/.Main', activity: 'example.app.Main' };
const node = text => ({ visible: true, enabled: true, text, bounds: { left: 0, top: 0, right: 100, bottom: 200 } });
const tree = (...texts) => ({ activity: { current: 'Metadata only' }, root: { ...node(''), children: texts.map(node) } });
function ports(extra = {}) {
  return { foregroundWindow: async () => fg, bridgeTree: async () => tree('Save, draft'),
    flutterNodes: async () => ({ nodes: [] }), uiaTreeOnce: async () => '<hierarchy><node text="Other page"/></hierarchy>', ...extra };
}

test('wait-text validates units, exact arrays, conflicting conditions and explicit absence provider', () => {
  const args = { packageName: 'example.app', targetText: 'Save, draft', requireText: ['Editor, v2'], timeoutMs: 1000 };
  assert.deepEqual(validateCommandArguments('wait-text', args).requireText, ['Editor, v2']);
  assert.deepEqual(parseCliOptions('wait-text', { requireText: '["Editor, v2"]', timeoutMs: '1000' }), { requireText: ['Editor, v2'], timeoutMs: 1000 });
  for (const invalid of [
    { ...args, timeoutSec: 1 }, { ...args, requireText: 'Editor, v2' },
    { ...args, requireText: Array.from({ length: 65 }, (_, index) => `label-${index}`) },
    { ...args, absentText: ['Save, draft'] }, { packageName: 'example.app', absentText: ['Loading'] },
  ]) assert.throws(() => validateCommandArguments('wait-text', invalid));
  assert.deepEqual(validateTextConditions({ absentText: ['Loading'], provider: 'uia' }).absent, ['Loading']);
});

test('visible text excludes status metadata, background windows and hidden descendants', () => {
  const data = tree('Background');
  data.windows = [{ type: 'activity', root: data.root }, { type: 'dialog', root: { ...node('Confirm'), children: [{ ...node('Hidden'), visible: false }] } }];
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
    const result = await waitText(ctx, undefined, { provider: 'native', absentText: ['Loading'], timeoutMs: 100 }, ports({ bridgeTree: read }));
    assert.equal(result.ok, false); assert.equal(result.error, 'observation_unavailable'); assert.equal(result.dispatched, false);
  }
});

test('foreground changes invalidate the text snapshot instead of reporting success', async () => {
  let reads = 0;
  const result = await waitText(ctx, 'Save, draft', { provider: 'native', timeoutMs: 100 }, ports({
    foregroundWindow: async () => ++reads === 1 ? fg : { ...fg, component: 'example.app/.Other' },
  }));
  assert.equal(result.ok, false); assert.equal(result.failures[0].error, 'foreground_changed_during_observation');
});

test('wait cancellation interrupts an owned provider read and cannot pass absence', async () => {
  const controller = new AbortController();
  const result = runExecution({ signal: controller.signal, timeoutMs: 1000 }, () => waitText(ctx, undefined,
    { provider: 'native', absentText: ['Loading'], timeoutMs: 1000 }, ports({ bridgeTree: async () => {
      controller.abort({ code: 'cancelled' }); await executionSleep(1000); return tree();
    } })));
  await assert.rejects(result, { code: 'cancelled', dispatched: false });
});
