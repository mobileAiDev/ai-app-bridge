'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createH5Page } = require('../test-support/h5-renderer-fixture');
const { createFlutterH5Port } = require('../bin/shared-kernel/flutter-h5-port');
const h5 = require('../bin/shared-kernel/flutter-h5-target');
const { validateCommandArguments, commandContract } = require('../bin/command-registry');
const renderer = fs.readFileSync(path.resolve(__dirname, '../../../shared/h5/renderer.js'), 'utf8')
  .replaceAll('__AAB_H5_STATE_KEY__', '__aabFlutterH5TargetV1').replaceAll('__AAB_H5_ERROR_PREFIX__', 'flutter_h5_');
function fixture() {
  const p = createH5Page(renderer), editor = new p.Element('editor', '', 'INPUT'), button = new p.Element('save', 'Save', 'BUTTON');
  p.hit = button;
  const snapshot = () => { const dom = p.snapshot(); return { ok: true, h5TargetSchema: h5.schema, dom,
    pageRef: { schemaVersion: h5.schema, runtimeEpoch: 'runtime', adapterId: 'article', adapterGeneration: 'g1', documentId: dom.documentId, url: dom.url } }; };
  return { p, editor, button, snapshot };
}

test('Flutter H5 public contract rejects old selectors and requires expert page binding', () => {
  const target = { serial: 'phone', packageName: 'app.h5' }, { snapshot } = fixture(), page = snapshot().pageRef;
  assert.doesNotThrow(() => validateCommandArguments('flutter-h5-input', { ...target, adapterId: 'article', selector: { ariaLabel: 'Editor' }, text: '' }));
  for (const old of [{ selector: '#editor', text: '' }, { targetText: 'Editor', value: 'x' }, { selector: { text: 'Editor' }, value: 'x' }]) {
    assert.throws(() => validateCommandArguments('flutter-h5-input', { ...target, ...old }));
  }
  assert.throws(() => validateCommandArguments('flutter-h5-eval', { ...target, script: '1' }));
  assert.doesNotThrow(() => validateCommandArguments('flutter-h5-eval', { ...target, script: '1', expectedPage: page }));
  assert.throws(() => validateCommandArguments('flutter-h5-scroll', { ...target, deltaX: 0, deltaY: 0 }));
  assert.throws(() => validateCommandArguments('flutter-h5-scroll', { ...target, selector: { text: 'Save' }, deltaX: 0, deltaY: 1 }));
  assert.doesNotThrow(() => validateCommandArguments('flutter-h5-scroll', { ...target, deltaX: 0, deltaY: 480, expectedPage: page }));
  assert.equal(commandContract('flutter-h5-wait').execution.mutation, false);
  const binding = h5.selectH5Node(snapshot(), { text: 'Save' }).targetRef;
  assert.doesNotThrow(() => validateCommandArguments('flutter-action', { ...target, payload: { action: 'h5Control', operation: 'click', expectedTarget: binding } }));
  assert.throws(() => validateCommandArguments('flutter-action', { ...target, payload: { action: 'h5Control', operation: 'click' } }));
});

test('typed port freezes the observed adapter/document/element and retains the original receipt', async () => {
  const { snapshot } = fixture(), calls = [], receipt = { kind: 'flutter', settled: true, actionId: 'original' };
  const identities = [];
  const port = createFlutterH5Port(async (payload, identity) => {
    calls.push(payload); identities.push(identity);
    return payload.action === 'h5Dom' ? snapshot() : { ok: true, dispatched: true, executionReceipt: receipt };
  }, { actionId: 'original' });
  const result = await port.control('click', { adapterId: 'article', selector: { text: 'Save' } });
  assert.equal(result.executionReceipt, receipt);
  assert.notEqual(identities[0].actionId, identities[1].actionId);
  assert.equal(identities[1].actionId, 'original');
  assert.deepEqual(calls.map(c => c.action), ['h5Dom', 'h5Control']);
  assert.equal(calls[1].expectedTarget.pageRef.adapterGeneration, 'g1');
  assert.equal(calls[1].expectedTarget.element.elementId, 'e2');
  assert.equal('script' in calls[1], false);
});

test('ambiguous/hidden adapters and stale expected page cannot dispatch a typed operation', async () => {
  for (const error of ['flutter_h5_adapter_ambiguous', 'flutter_h5_adapter_hidden', 'flutter_h5_adapter_not_found']) {
    const calls = [], port = createFlutterH5Port(async payload => { calls.push(payload); return { ok: false, error, dispatched: false, ambiguous: false }; });
    assert.equal((await port.control('click', { selector: { text: 'Save' } })).error, error);
    assert.equal(calls.length, 1);
  }
  const { snapshot } = fixture(), expected = h5.selectH5Node(snapshot(), { text: 'Save' }).targetRef;
  const calls = [], port = createFlutterH5Port(async payload => { calls.push(payload); const tree = snapshot(); tree.pageRef.adapterGeneration = 'g2'; return tree; });
  assert.equal((await port.control('click', { selector: { text: 'Save' }, expectedTarget: expected })).error, 'reobserve_required');
  assert.equal(calls.length, 1);
  assert.equal((await port.control('click', { adapterId: 'other', selector: { text: 'Save' }, expectedTarget: expected })).error, 'flutter_h5_adapter_conflict');
  assert.equal(calls.length, 1);
});

test('wait performs observations only and refuses document replacement while retaining adapter selection', async () => {
  const { snapshot } = fixture(), calls = [];
  const port = createFlutterH5Port(async payload => { calls.push(payload); const tree = snapshot(); if (calls.length > 1) tree.pageRef.documentId = tree.dom.documentId = 'replacement'; return tree; });
  assert.equal((await port.wait({ selector: { text: 'Absent' }, timeoutMs: 100, intervalMs: 1 })).error, 'reobserve_required');
  assert.deepEqual(calls, [{ action: 'h5Dom' }, { action: 'h5Dom', adapterId: 'article' }]);
});

test('Flutter renderer rejects navigation back to the same URL, replacement and changed geometry', () => {
  for (const change of ['route', 'replace', 'geometry', 'pagehide']) {
    const { p, button, snapshot } = fixture(), selected = h5.selectH5Node(snapshot(), { text: 'Save' });
    const request = { operation: 'action', action: 'click', ...selected.targetRef };
    request.geometry = p.run({ ...request, operation: 'prepare' }).geometry;
    if (change === 'route') { p.history.pushState(null, '', 'changed'); p.history.replaceState(null, '', request.pageRef.url); }
    if (change === 'replace') { button.connected = false; new p.Element('save', 'Save', 'BUTTON'); }
    if (change === 'geometry') p.setScroll(0, 10);
    if (change === 'pagehide') p.emit('pagehide');
    assert.equal(p.run(request).error, 'reobserve_required', change);
    assert.deepEqual(p.events, []);
  }
});

test('Flutter renderer rejects duplicate/hidden/disabled targets and focus replacement, accepts a real empty clear', () => {
  const { p, editor, snapshot } = fixture();
  new p.Element('save2', 'Save', 'BUTTON');
  assert.equal(h5.selectH5Node(snapshot(), { text: 'Save' }).error, 'flutter_h5_selector_ambiguous');
  p.nodes[2].style.display = 'none';
  p.hit = editor; editor.value = 'original';
  let selected = h5.selectH5Node(snapshot(), { elementId: 'e1' });
  const make = () => { const request = { operation: 'action', action: 'input', text: '', ...selected.targetRef }; request.geometry = p.run({ ...request, operation: 'prepare' }).geometry; return request; };
  editor.onfocus = () => { editor.value = 'callback'; };
  assert.equal(p.run(make()).error, 'flutter_h5_target_changed');
  assert.equal(editor.value, 'callback'); assert.deepEqual(p.events, []);
  editor.onfocus = null; selected = h5.selectH5Node(snapshot(), { elementId: 'e1' });
  assert.equal(p.run(make()).ok, true); assert.equal(editor.value, '');
  assert.deepEqual(p.events, ['input:editor', 'change:editor']);
  editor.disabled = true;
  assert.equal(h5.selectH5Node(snapshot(), { elementId: 'e1' }).error, 'flutter_h5_target_disabled');
  editor.style.display = 'none';
  assert.equal(h5.selectH5Node(snapshot(), { elementId: 'e1' }).error, 'flutter_h5_selector_not_found');
});

test('Script recognizes typed Flutter H5 DOM as this execution actual tree evidence', async () => {
  const { createScriptHostPort } = require('../bin/script/script-host-port');
  const { snapshot } = fixture();
  const host = createScriptHostPort({ executionId: 'flutter-h5-read',
    target: { platform: 'android', serial: 'fixture', packageName: 'app.h5' },
    mutationLease: {}, actions: async command => { assert.equal(command, 'flutter-h5-dom'); return snapshot(); } });
  const observed = await host.call('flutter-h5-dom', { adapterId: 'article' });
  assert.equal(observed.ok, true);
  const assertion = await host.assert({ name: 'original document', condition: observed.result.pageRef.adapterId === 'article',
    requiredEvidence: ['tree'], evidence: observed.evidence });
  assert.equal(assertion.verdict, 'passed');
  const tampered = structuredClone(observed.evidence); tampered.source.payloadSha256 = 'fake';
  assert.equal((await host.assert({ name: 'reject fake', condition: true, requiredEvidence: ['tree'], evidence: tampered })).verdict, 'inconclusive');
});
