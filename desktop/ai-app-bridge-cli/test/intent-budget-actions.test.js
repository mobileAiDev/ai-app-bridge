'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCommandArguments } = require('../bin/command-registry');
const { intentActionSchema, intentBudget } = require('../bin/shared-kernel/execution-contracts');
const { createIntentWorker } = require('../bin/intent/intent-worker');
const { createIntentBudget, createAutonomousAgentAdapter } = require('../bin/intent/intent-autonomous-adapter');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');

const webTarget = { platform: 'web', sessionId: 'budget-browser', runtimeEpoch: 'document', targetId: 'main' };
const iosTarget = { platform: 'ios', deviceId: 'budget-iphone', bundleId: 'example.app',
  wdaRunnerBundleId: 'example.runner', wdaSessionId: 'session-1' };
const scenarios = [
  { name: 'Web pressKey', target: webTarget, provider: 'h5',
    action: { action: 'pressKey', selector: { elementId: 'query' }, key: 'Enter' } },
  { name: 'iOS setOrientation', target: iosTarget, provider: 'native',
    action: { action: 'setOrientation', orientation: 'landscapeLeft' } },
];

function startArguments({ target = webTarget, provider = 'h5', allowlist } = {}) {
  return { operation: 'start', target, provider, goal: 'Exercise the configured action budget', mode: 'autonomous',
    agentModule: '/agent.js', budget: { maxSteps: 2, maxAgentCalls: 1, ...(allowlist === undefined ? {} : { allowlist }) } };
}

function snapshot(target) {
  if (target.platform === 'ios') return { nativeTargetSchema: 'aab.ios-native-target/v1',
    source: { type: 'Application', children: [{ elementId: 'save', type: 'Button', rawIdentifier: 'save', label: 'Save',
      value: null, isVisible: '1', isEnabled: '1', rect: { x: 20, y: 40, width: 120, height: 50 } }] } };
  const schema = 'aab.web-dom-target/v1';
  const pageRef = { schemaVersion: schema, sessionId: target.sessionId, runtimeEpoch: target.runtimeEpoch,
    targetId: target.targetId, navigationId: 'navigation', url: 'https://example.test/' };
  return { ok: true, webTargetSchema: schema, pageRef, dom: { ok: true, targetSchema: schema, pageRef,
    url: pageRef.url, title: 'Search', bodyText: '', bodyTextTruncated: false, truncated: false, controlCount: 1,
    controls: [{ elementId: 'query', tag: 'input', id: 'query', name: '', type: 'text', role: '', ariaLabel: '',
      placeholder: 'Search', href: '', text: '', visible: true, disabled: false, editable: true, checked: null,
      bounds: { left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 } }] } };
}

function autonomous(t, scenario, allowlist) {
  const args = validateCommandArguments('intent', startArguments({ ...scenario, allowlist }));
  const effects = [];
  let calls = 0;
  const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const worker = createIntentWorker({ ...args, operationId: `budget-${scenario.target.platform}-${allowlist ? 'explicit' : 'default'}`,
    timeoutMs: 1000, store, budget: createIntentBudget(args.budget),
    agent: createAutonomousAgentAdapter({ decide: ({ revision }) => {
      calls++;
      return { decisionId: 'act-once', basedOnRevision: revision, agentDecision: 'act', action: scenario.action };
    } }),
    adapter: {
      observe: async ({ provider, rawTreeId }) => ({ ok: true, provider, rawTreeId, rawTree: snapshot(scenario.target) }),
      action: async ({ spec }) => { effects.push(spec); return { ok: true, dispatched: true }; },
    } });
  t.after(async () => { if (!worker.isFinished()) await worker.cancel(); });
  return { worker, store, effects, get calls() { return calls; } };
}

test('public autonomous budget accepts the complete advertised action vocabulary', () => {
  const names = intentActionSchema().properties.action.enum;
  assert.ok(names.includes('pressKey'));
  assert.ok(names.includes('setOrientation'));
  const args = startArguments({ allowlist: names });
  assert.deepEqual(validateCommandArguments('intent', args), args);
  assert.deepEqual(intentBudget.properties.allowlist.default, ['tap']);
});

test('public autonomous budget rejects unknown and duplicate action names', () => {
  for (const allowlist of [['submitForm'], ['pressKey', 'pressKey']]) {
    assert.throws(() => validateCommandArguments('intent', startArguments({ allowlist })), error => {
      assert.equal(error.code, 'invalid_argument');
      assert.match(error.field, /^budget\.allowlist(?:\[0\])?$/);
      return true;
    });
  }
});

for (const scenario of scenarios) {
  test(`${scenario.name} reaches the worker adapter only when explicitly budgeted`, async t => {
    const h = autonomous(t, scenario, [scenario.action.action]);
    const result = await h.worker.start();
    assert.equal(result.status, 'intervention_required', JSON.stringify(result));
    assert.equal(result.error, 'max_agent_calls');
    assert.equal(h.calls, 1);
    assert.deepEqual(h.effects, [{ ...scenario.action, provider: scenario.provider }]);
    const receipt = h.store.latest(h.worker.operationId, 'action-receipt');
    assert.equal(receipt.dispatched, true);
    assert.deepEqual(receipt.action, scenario.action);
  });

  test(`${scenario.name} remains denied by the default budget before decision persistence`, async t => {
    const h = autonomous(t, scenario);
    const result = await h.worker.start();
    assert.equal(result.status, 'intervention_required', JSON.stringify(result));
    assert.equal(result.error, 'action_not_allowed');
    assert.equal(h.calls, 1);
    assert.deepEqual(h.effects, []);
    for (const kind of ['decision', 'dispatch-marker', 'action-receipt']) assert.equal(h.store.latest(h.worker.operationId, kind), null);
  });

  test(`${scenario.name} budget does not authorize that action on another platform`, async t => {
    const other = scenarios.find(item => item !== scenario);
    const h = autonomous(t, { ...other, action: scenario.action }, [scenario.action.action]);
    const result = await h.worker.start();
    assert.equal(result.ok, false);
    assert.equal(result.status, 'waiting_for_decision');
    assert.equal(result.error, 'invalid_argument');
    assert.equal(h.calls, 1);
    assert.deepEqual(h.effects, []);
    for (const kind of ['decision', 'dispatch-marker', 'action-receipt']) assert.equal(h.store.latest(h.worker.operationId, kind), null);
  });
}
