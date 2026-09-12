'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { validateCommandArguments } = require('../bin/command-registry');
const { authorizeCommand, catalogPayload } = require('../bin/script/script-catalog');
const { intentProviderError } = require('../bin/intent/intent-provider');
const { createWebIntentDeviceAdapter } = require('../bin/intent/web-intent-adapter');
const { createIntentWorker } = require('../bin/intent/intent-worker');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { schema, validateSnapshot } = require('../bin/shared-kernel/web-dom-target');

const target = { platform: 'web', sessionId: 'browser', runtimeEpoch: 'document', targetId: 'main' };
function snapshot() {
  const pageRef = { schemaVersion: schema, sessionId: target.sessionId, runtimeEpoch: target.runtimeEpoch,
    targetId: target.targetId, navigationId: 'navigation', url: 'https://example.test/' };
  const node = { elementId: 'e1', tag: 'input', id: 'query', name: '', type: 'text', role: '',
    ariaLabel: '', placeholder: 'Search', href: '', text: 'note', visible: true, disabled: false, editable: true, checked: null,
    bounds: { left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 } };
  return { ok: true, webTargetSchema: schema, pageRef,
    dom: { ok: true, targetSchema: schema, pageRef, url: pageRef.url, title: 'Notes', bodyText: 'note',
      bodyTextTruncated: false, truncated: false, controlCount: 1, controls: [node] } };
}

test('Web controls publish exact selectors and mode-specific arguments', () => {
  const bound = { sessionId: target.sessionId, runtimeEpoch: target.runtimeEpoch };
  for (const [command, args] of [
    ['web-click', { selector: { text: 'Save', tag: 'button' } }],
    ['web-input', { selector: { elementId: 'e1' }, value: '' }],
    ['web-key', { selector: { elementId: 'e1' }, key: 'Enter' }],
    ['web-scroll', { selector: { elementId: 'e1' }, mode: 'into-view' }],
    ['web-scroll', { mode: 'by', deltaY: 200 }],
  ]) assert.deepEqual(validateCommandArguments(command, { ...bound, ...args }), { ...bound, ...args });
  for (const [command, args] of [
    ['web-click', { selector: '#save' }],
    ['web-click', { selector: { text: 'Save', css: '#save' } }],
    ['web-click', { targetText: 'Save' }],
    ['web-input', { selector: { elementId: 'e1' }, value: 7 }],
    ['web-key', { selector: { elementId: 'e1' }, key: 'Tab' }],
    ['web-scroll', { selector: { elementId: 'e1' }, deltaY: 200 }],
    ['web-scroll', { mode: 'into-view', selector: { elementId: 'e1' }, deltaY: 200 }],
    ['web-scroll', { mode: 'by' }],
  ]) assert.throws(() => validateCommandArguments(command, { ...bound, ...args }));
});

test('only the serving h5 Web adapter and typed Script controls are admitted', () => {
  assert.equal(intentProviderError(target, 'h5'), null);
  assert.equal(intentProviderError(target, 'native').error, 'unsupported_web_intent_provider');
  assert.throws(() => createWebIntentDeviceAdapter(), /serving Web provider/);
  assert.equal(authorizeCommand('web-dom', ['app.read']).ok, true);
  assert.equal(authorizeCommand('web-key', ['app.interact']).ok, true);
  assert.equal(authorizeCommand('web-key', ['app.read']).error, 'permission_not_granted');
  assert.equal(authorizeCommand('web-command', ['app.interact']).error, 'command_permanently_denied');
  assert.equal(catalogPayload().executablePlatforms.includes('web'), true);
});

test('Web observations reject a different document or ambiguous element identity', () => {
  const original = snapshot();
  assert.doesNotThrow(() => validateSnapshot(original.dom, target));
  const another = structuredClone(original.dom); another.pageRef.runtimeEpoch = 'other';
  assert.throws(() => validateSnapshot(another, target), /invalid_web_dom_target/);
  const duplicated = structuredClone(original.dom); duplicated.controls.push(duplicated.controls[0]); duplicated.controlCount++;
  assert.throws(() => validateSnapshot(duplicated, target), /invalid_web_dom_control/);
  for (const checked of [undefined, 'false', 0, 'yes']) {
    const invalid = structuredClone(original.dom); invalid.controls[0].checked = checked;
    assert.throws(() => validateSnapshot(invalid, target), /invalid_web_dom_control/);
  }
});

test('Intent retains a textless ARIA checkbox and its mixed/unchecked/checked states through the actual adapter', async t => {
  const raw = snapshot();
  Object.assign(raw.dom.controls[0], { tag: 'span', type: '', role: 'checkbox', editable: false, text: '', checked: 'mixed' });
  const calls = [];
  const adapter = createWebIntentDeviceAdapter({ provider: { run: async (command, args) => {
    calls.push({ command, args });
    if (command === 'web-dom') return structuredClone(raw);
    raw.dom.controls[0].checked = true;
    return { ok: true, dispatched: true, ambiguous: false, settled: true };
  } } });
  const worker = createIntentWorker({ operationId: 'checkbox-intent', target, provider: 'h5', goal: 'Toggle the observed task',
    adapter, store: createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() }) });
  t.after(async () => { if (!worker.isFinished()) await worker.cancel(); });
  const first = await worker.start();
  assert.equal(first.summary.nodes[0].role, 'checkbox');
  assert.equal(first.summary.nodes[0].checked, 'mixed');
  assert.equal(first.summary.nodes[0].clickable, true);
  raw.dom.controls[0].checked = false;
  const observed = await worker.observe();
  assert.equal(observed.summary.nodes[0].checked, false);
  const acted = await worker.decide({ decisionId: 'toggle', basedOnRevision: observed.revision, agentDecision: 'act',
    action: { action: 'tap', selector: { elementId: 'e1', role: 'checkbox' } } });
  assert.equal(acted.ok, true, JSON.stringify(acted));
  assert.equal(acted.summary.nodes[0].checked, true);
  assert.deepEqual(calls.find(call => call.command === 'web-click').args.expectedTarget.pageRef, raw.pageRef);
});

test('Web Intent dispatch retains the observed page, node and original action ID', async t => {
  const calls = [], raw = snapshot();
  const adapter = createWebIntentDeviceAdapter({ provider: { run: async (command, args) => {
    calls.push({ command, args });
    return command === 'web-dom' ? structuredClone(raw) : { ok: true, dispatched: true, ambiguous: false, settled: true };
  } } });
  const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const worker = createIntentWorker({ operationId: 'web-key-intent', target, provider: 'h5', goal: 'Submit observed search', adapter, store });
  t.after(async () => { if (!worker.isFinished()) await worker.cancel(); });
  const first = await worker.start();
  assert.equal(first.summary.provider, 'h5'); assert.equal(first.summary.nodes[0].role, 'input');
  const stale = await worker.decide({ decisionId: 'stale', basedOnRevision: first.revision + 1, agentDecision: 'act',
    action: { action: 'pressKey', selector: { elementId: 'e1' }, key: 'Enter' } });
  assert.equal(stale.error, 'reobserve_required'); assert.equal(calls.length, 1);
  const acted = await worker.decide({ decisionId: 'submit', basedOnRevision: first.revision, agentDecision: 'act',
    action: { action: 'pressKey', selector: { elementId: 'e1' }, key: 'Enter' } });
  assert.equal(acted.ok, true, acted.error);
  const dispatched = calls.find(call => call.command === 'web-key').args;
  assert.equal(dispatched.runtimeActionId, 'web-key-intent:submit');
  assert.deepEqual(dispatched.expectedTarget.pageRef, raw.pageRef);
  assert.equal(dispatched.expectedTarget.element.elementId, 'e1');
  assert.deepEqual(dispatched.selector, { elementId: 'e1' });
  assert.equal(dispatched.key, 'Enter');
  const completed = await worker.decide({ decisionId: 'done', basedOnRevision: acted.revision, agentDecision: 'complete' });
  assert.equal(completed.status, 'completed');
  assert.ok(store.list(worker.operationId).some(record => record.kind === 'action-receipt'));
});
