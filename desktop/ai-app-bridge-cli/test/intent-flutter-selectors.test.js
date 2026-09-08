'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createProductionIntentDeviceAdapter } = require('../bin/intent/intent-production-adapter');
const { createTargetLease } = require('../bin/shared-kernel/target-lease-protocol');

function fixture() {
  const taps = [];
  const adapter = createProductionIntentDeviceAdapter({
    lease: createTargetLease(),
    ports: {
      createBridgeContext: options => options,
      flutterNodes: async () => { throw new Error('must use the committed observation'); },
      flutterAction: async (_ctx, payload) => { taps.push(payload); return { ok: true }; },
    },
  });
  const rawTree = { nodes: [
    { id: 5, text: 'System', tap: { bounds: { left: 200, top: 200, right: 380, bottom: 240 } } },
    { id: 9, text: 'System', tap: { bounds: { left: 200, top: 260, right: 380, bottom: 300 } } },
    { id: 15, text: 'System', tap: { bounds: { left: 200, top: 320, right: 380, bottom: 360 } } },
    { id: 17, text: 'Hidden', bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
  ] };
  const act = spec => adapter.action({
    serial: 'test-device', packageName: 'test.app', actionId: 'intent:language', rawTree,
    spec: { provider: 'flutter', action: 'tap', ...spec },
  });
  return { act, taps, rawTree };
}

test('ambiguous Flutter text never dispatches; an observed node ID picks the intended row', async () => {
  const { act, taps } = fixture();
  const ambiguous = await act({ text: 'System' });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error, 'flutter_selector_not_unique');
  assert.equal(ambiguous.dispatched, false);
  assert.deepEqual(taps, []);

  const selected = await act({ selector: { nodeId: '15' } });
  assert.equal(selected.ok, true);
  assert.deepEqual(taps, [{ action: 'tapAt', x: 290, y: 340, actionId: 'intent:language' }]);
});

test('Flutter selectors reject missing, non-operable and malformed targets before dispatch', async () => {
  const { act, taps, rawTree } = fixture();
  for (const [spec, error] of [
    [{ selector: { nodeId: '999' } }, 'flutter_selector_not_found'],
    [{ selector: { nodeId: '17' } }, 'flutter_node_not_operable'],
    [{ selector: { nodeId: 15 } }, 'explicit_exact_flutter_selector_required'],
    [{ selector: { nodeId: '15', text: 'System' } }, 'explicit_exact_flutter_selector_required'],
    [{ selector: { text: 'System' }, text: 'System' }, 'explicit_exact_flutter_selector_required'],
    [{ selector: { text: 'System' }, exact: false }, 'explicit_exact_flutter_selector_required'],
  ]) {
    const result = await act(spec);
    assert.equal(result.error, error);
    assert.equal(result.dispatched, false);
  }
  rawTree.nodes[2].tap.bounds.right = Infinity;
  assert.equal((await act({ selector: { nodeId: '15' } })).error, 'flutter_node_not_operable');
  assert.deepEqual(taps, []);
});

test('exact Flutter text matches one actionable target while ignoring offstage text', async () => {
  const { act, taps, rawTree } = fixture();
  rawTree.nodes[1].text = 'Color';
  rawTree.nodes[2].text = 'Language';
  rawTree.nodes.push({ id: 20, text: 'Language' });
  assert.equal((await act({ selector: { text: 'Language' } })).ok, true);
  assert.deepEqual(taps, [{ action: 'tapAt', x: 290, y: 340, actionId: 'intent:language' }]);
});
