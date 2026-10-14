'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { selectFlutterNode, bindFlutterAction } = require('../bin/shared-kernel/flutter-target');
const { withActionGuidance } = require('../bin/shared-kernel/action-guidance');

test('UIA visibleOnly follows each window and provider visibility instead of the first status bar', () => {
  const { compactUiaTree, parseUiaViewport } = require('../bin/device-provider');
  const xml = '<hierarchy><node package="system" bounds="[0,0][100,10]" visible-to-user="true"><node text="Time" bounds="[1,1][10,9]"/></node>'
    + '<node package="app" bounds="[0,0][100,200]" visible-to-user="true"><node text="Covered" visible-to-user="false" bounds="[0,1][100,9]"/>'
    + '<node text="Button" visible-to-user="true" bounds="[0,100][100,140]"/>'
    + '<node visible-to-user="false" bounds="[0,140][100,200]"><node text="Hidden child" visible-to-user="true" bounds="[0,150][100,190]"/></node></node></hierarchy>';
  assert.equal(parseUiaViewport(xml).bottom, 200);
  const visible = compactUiaTree(xml, { visibleOnly: true });
  assert.deepEqual(visible.nodes.map(n => n.text).filter(Boolean), ['Time', 'Button']);
  const all = compactUiaTree(xml, { visibleOnly: false });
  assert.equal(all.nodes.find(n => n.text === 'Covered').visible, false);
  assert.equal(all.nodes.find(n => n.text === 'Hidden child').effectiveVisible, false);
  const classTags = '<hierarchy><android.widget.FrameLayout bounds="[0,0][100,200]"><android.widget.Button text="Button" displayed="true" bounds="[0,100][100,140]"/></android.widget.FrameLayout></hierarchy>';
  assert.equal(compactUiaTree(classTags, { textFilter: 'button', visibleOnly: true }).nodes[0].className, 'android.widget.Button');
});

test('compaction retains provider failure instead of reporting a successful empty tree', () => {
  const failure = { ok: false, error: 'no_current_activity', message: 'Activity is starting' };
  const compact = require('../bin/device-provider').compactBridgeTree(failure);
  assert.equal(compact.ok, false); assert.equal(compact.error, failure.error); assert.equal(compact.message, failure.message);
  const { observationCoverage } = require('../bin/shared-kernel/observation-coverage');
  assert.equal(observationCoverage('uia', '<hierarchy aab-truncated="false" aab-warnings="{}"><node/></hierarchy>').status, 'complete');
});

test('compact Native/UIA observations preserve source coverage, projection limits and actionable references', () => {
  const { compactBridgeTree, compactUiaTree } = require('../bin/device-provider');
  const child = { text: 'prefix', textTruncated: true, textLength: 500, targetRef: { viewId: 'child' }, checked: false };
  const root = { text: 'Parent', targetRef: { viewId: 'root' }, children: [child] };
  const tree = { root: structuredClone(root), windows: [{ root }], coverage: { status: 'partial' }, nodeCount: 2 };
  const all = compactBridgeTree(tree);
  assert.equal(all.scannedNodes, 2); assert.equal(all.nodes.length, 2, 'legacy root is not emitted a second time');
  assert.equal(all.truncated, true); assert.equal(all.coverage.projection.truncated, false);
  assert.deepEqual(all.nodes[1].selector, { viewId: 'child' }); assert.equal(all.nodes[1].textTruncated, true);
  assert.equal(all.nodes[1].textLength, 500); assert.equal(all.nodes[1].checked, false);
  const depth = compactBridgeTree(tree, { maxDepth: 0 });
  assert.equal(depth.nodes.length, 1); assert.equal(depth.coverage.projection.reason, 'max_depth');
  const uia = compactUiaTree('<hierarchy aab-truncated="true"><node text="Parent"><node text="Child"/></node></hierarchy>', { maxDepth: 0, visibleOnly: false });
  assert.equal(uia.nodes.length, 1); assert.equal(uia.coverage.source.status, 'partial');
  assert.equal(uia.coverage.projection.reason, 'max_depth');
});

test('Flutter partial semantic matches return selectable IDs, including one observed candidate', () => {
  const bounds = { left: 0, top: 0, right: 100, bottom: 100 };
  const node = { id: 'one', text: 'Agree', tap: { bounds },
    targetRef: { schemaVersion: 'aab.flutter-target/v1', runtimeEpoch: 'epoch', elementId: 'one', guard: 'guard' } };
  const tree = { nodes: [node], truncated: true };
  for (const result of [selectFlutterNode(tree, { text: 'Agree' }), bindFlutterAction(tree, { action: 'tapText', text: 'Agree' })]) {
    assert.equal(result.error, 'flutter_observation_incomplete');
    assert.equal(result.selectionRequired, true); assert.equal(result.candidates.length, 1);
    const guided = withActionGuidance('tap-flutter-text', { serial: 'd', packageName: 'app.test', text: 'Agree' }, result);
    const next = guided.guidance.nextActions[0];
    assert.equal(next.command, 'tap-flutter'); assert.deepEqual(next.arguments.selector, { nodeId: 'one' });
    assert.equal(bindFlutterAction(tree, { action: 'tapTarget', selector: next.arguments.selector }).ok, true);
  }
  assert.equal(selectFlutterNode({ ...tree, truncated: false, nodes: [{ ...node, textTruncated: true }] }, { text: 'Agree' }).ok, false);
});

test('a thrown controller failure is recorded as terminal unknown instead of leaving requested forever', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-control-error-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'control.json');
  const request = { command: 'runtime', arguments: { operation: 'stop' } };
  fs.writeFileSync(file, JSON.stringify({ controlId: 'control', state: 'requested', request }));
  let calls = 0;
  await require('../bin/shared-kernel/composed-control').control(file, async actual => {
    assert.deepEqual(actual, request); calls++;
    throw Object.assign(new Error('Transport closed after dispatch'), { code: 'connection_lost' });
  });
  const result = JSON.parse(fs.readFileSync(file));
  assert.equal(calls, 1); assert.equal(result.state, 'failed'); assert.equal(result.outcome, 'unknown');
  assert.equal(result.error, 'connection_lost'); assert.deepEqual(result.request, request);
  assert.ok(result.completedAtMs); assert.ok(result.guidance);
});
