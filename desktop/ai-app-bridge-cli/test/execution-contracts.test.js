'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateCommandArguments, parseCliOptions } = require('../bin/command-registry');
const { variants, intentActionSchema } = require('../bin/shared-kernel/execution-contracts');
const { compileScriptSpec } = require('../bin/script/script-spec');
const { createIntentWorker } = require('../bin/intent/intent-worker');
const { createIntentBudget, createAutonomousAgentAdapter } = require('../bin/intent/intent-autonomous-adapter');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { invalidCases, verifyExecutionContract, verifyAutonomousContract } = require('../scripts/validation/verify-execution-contract');

test('Intent discovery keeps repeated provider rules in one distinct union', () => {
  const schema = intentActionSchema();
  assert.deepEqual(schema.properties.provider, {
    anyOf: ['native', 'uia', 'flutter', 'h5'].map(provider => ({ const: provider })),
  });
  assert.deepEqual(intentActionSchema('native', 'android').properties.provider, { const: 'native' });
  const selectorRules = schema.properties.selector.anyOf;
  assert.equal(selectorRules.length, new Set(selectorRules.map(rule => JSON.stringify(rule))).size);
  assert.equal(selectorRules.some(rule => Object.keys(rule).length === 1 && rule.anyOf), false);
});

test('variant aggregation preserves original rule constraints and branch validation', () => {
  const { validateValue, object } = require('../bin/shared-kernel/argument-schema');
  const constrained = { type: 'integer', minimum: 1, anyOf: [{ const: 0 }, { const: 1 }] };
  const other = { type: 'string', minLength: 1 };
  const branches = [
    object({ operation: { const: 'first' }, value: constrained }, ['operation', 'value']),
    object({ operation: { const: 'second' }, value: other }, ['operation', 'value']),
    object({ operation: { const: 'third' }, value: constrained }, ['operation', 'value']),
  ];
  const snapshot = structuredClone(branches);
  const schema = variants('operation', branches);
  assert.deepEqual(schema.properties.value, { anyOf: [constrained, other] });
  assert.deepEqual(schema.anyOf, snapshot);
  assert.deepEqual(branches, snapshot);
  for (const value of [{ operation: 'first', value: 1 }, { operation: 'second', value: 'other' }, { operation: 'third', value: 1 }]) {
    assert.doesNotThrow(() => validateValue(value, schema));
  }
  for (const value of [{ operation: 'first', value: 0 }, { operation: 'second', value: 1 }, { operation: 'third', value: 'other' }]) {
    assert.throws(() => validateValue(value, schema), { code: 'invalid_argument', field: 'value' });
  }
});

for (const item of invalidCases()) {
  test(`command contract rejects ${item.name} with an actionable field`, () => {
    assert.throws(() => validateCommandArguments(item.command, item.args), { code: item.error, field: item.field });
  });
}

test('all canonical execution operations preserve their permitted input', () => {
  const target = { platform: 'android', serial: 'probe', packageName: 'example.app' };
  const script = { schemaVersion: 'aab.code-script/v1', language: 'javascript', source: 'module.exports.main=()=>true;' };
  const cases = [
    ['intent', { operation: 'start', goal: 'Observe', target }],
    ['intent', { operation: 'start', goal: 'Observe', target, mode: 'autonomous', agentModule: '/agent.js', budget: { maxSteps: 1, maxAgentCalls: 1, maxDurationMs: 5, allowlist: [] } }],
    ['intent', { operation: 'start', goal: 'Observe', target, require: { streams: ['events', 'state'], limit: 5, view: 'decision-window' } }],
    ...['status', 'observe', 'pause', 'resume', 'cancel'].map(operation => ['intent', { operation, operationId: 'x' }]),
    ['intent', { operation: 'intervene', operationId: 'x', reason: 'Manual reconciliation required' }],
    ['intent', { operation: 'decide', operationId: 'x', decision: { decisionId: 'd', basedOnRevision: 1, agentDecision: 'complete' } }],
    ['script', { operation: 'start', script }],
    ['script', { operation: 'start', script: { ...script, language: 'python', source: 'def main(ctx): return True' }, pythonPath: '/python' }],
    ...['status', 'wait', 'pause', 'resume', 'cancel'].map(operation => ['script', { operation, operationId: 'x' }]),
    ['script', { operation: 'decide', operationId: 'x', requestId: 'r', revision: 1, decision: null }],
    ['script', { operation: 'runtime-status' }],
    ['evidence', { operation: 'export', namespace: 'script', operationId: 'x', outputDir: '/export' }],
    ['evidence', { operation: 'verify', archiveDir: '/export', manifestSha256: 'a'.repeat(64) }],
  ];
  for (const [command, args] of cases) assert.deepEqual(validateCommandArguments(command, args), args);
});

test('provider-specific Intent actions accept exact selectors and zero values', () => {
  for (const action of [
    { action: 'tap', provider: 'native', selector: { text: 'Save', within: { text: 'Note', ancestor: { className: 'Row', parent: { resourceName: 'list' } } } } },
    { action: 'tap', provider: 'uia', selector: { resourceName: 'android:id/button1' } },
    { action: 'tap', provider: 'flutter', selector: { nodeId: '7' } },
    { action: 'inputText', provider: 'native', selector: { contentDescription: 'Title' }, value: '' },
    { action: 'longPress', provider: 'native', selector: { text: 'Note' }, durationMs: 500 },
    { action: 'swipe', provider: 'native', selector: { text: 'Note' }, durationMs: 1, deltaX: 0, deltaY: -50 },
    { action: 'scroll', provider: 'native', selector: { resourceName: 'id/list' }, direction: 'down' },
    { action: 'scroll', provider: 'uia', direction: 'up' },
    { action: 'inputText', provider: 'flutter', selector: { nodeId: 'editor' }, value: '' },
    { action: 'scrollBy', provider: 'flutter', selector: { nodeId: 'list' }, delta: 0 },
    { action: 'keyevent', keyCode: 0 }, { action: 'back' },
  ]) {
    const args = { operation: 'decide', operationId: 'x', decision: { decisionId: 'd', basedOnRevision: 1, agentDecision: 'act', action } };
    assert.deepEqual(validateCommandArguments('intent', args), args);
  }
});

test('Native scroll needs an explicit container while UIA scroll uses its viewport', () => {
  const args = { operation: 'decide', operationId: 'x', decision: { decisionId: 'd', basedOnRevision: 1,
    agentDecision: 'act', action: { provider: 'native', action: 'scroll', direction: 'down' } } };
  assert.throws(() => validateCommandArguments('intent', args), { code: 'missing_argument', field: 'decision.action.selector' });
  args.decision.action.provider = 'uia';
  assert.deepEqual(validateCommandArguments('intent', args), args);
});

test('Script compilation preserves JSON data and isolates it from later caller edits', () => {
  const data = JSON.parse('{"nullable":null,"false":false,"zero":0,"empty":"","nested":[1,{"key":"value"}],"__proto__":{"safe":true}}');
  const input = { schemaVersion: 'aab.code-script/v1', language: 'javascript', source: 'module.exports.main=ctx=>ctx.inputs;', inputs: data,
    target: { platform: 'android', serial: 's', packageName: 'example.app' }, permissions: ['app.read'], policy: { timeoutMs: 50 } };
  const result = compileScriptSpec(input); assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.spec.inputs, data);
  input.inputs.nested[1].key = 'changed'; input.target.serial = 'other'; input.permissions.push('app.interact'); input.policy.timeoutMs = 99;
  assert.equal(result.spec.inputs.nested[1].key, 'value'); assert.equal(result.spec.target.serial, 's');
  assert.deepEqual(result.spec.permissions, ['app.read']); assert.equal(result.spec.policy.timeoutMs, 50);
  for (const bad of [undefined, NaN, Infinity, new Date(), () => true, 1n]) {
    assert.equal(compileScriptSpec({ ...input, inputs: { bad } }).error, 'invalid_argument');
  }
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(compileScriptSpec({ ...input, inputs: cyclic }).error, 'invalid_argument');
});

test('Flutter CLI alone decodes JSON and Web App actions preserve their business data', () => {
  const args = { serial: 's', packageName: 'example.app', payload: '{"action":"scrollBy","delta":0}' };
  const parsed = parseCliOptions('flutter-action', args);
  assert.deepEqual(validateCommandArguments('flutter-action', parsed).payload, { action: 'scrollBy', delta: 0 });
  assert.throws(() => parseCliOptions('flutter-action', { ...args, payload: '{' }), { code: 'invalid_argument', field: 'payload' });
  const command = { sessionId: 'session', runtimeEpoch: 'epoch-1', name: 'action', arguments: { name: 'cart.submit', arguments: { items: [{ id: 0, selected: false }], metadata: null } } };
  assert.deepEqual(validateCommandArguments('web-command', command), command);
});

function autonomous(reply, budget = {}) {
  let calls = 0, effects = 0;
  const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const worker = createIntentWorker({ operationId: `autonomous-${Math.random()}`, target: { platform: 'android', serial: 'test', packageName: 'example.app' },
    goal: 'Check the decision boundary', timeoutMs: 1000, mode: 'autonomous', store,
    budget: createIntentBudget({ maxSteps: 10, maxAgentCalls: 1, ...budget }),
    agent: createAutonomousAgentAdapter({ decide: input => { calls++; return reply(input); } }),
    adapter: { observe: async ({ provider, rawTreeId }) => ({ ok: true, provider, rawTreeId, rawTree: { root: { className: 'Button', text: 'Save', clickable: true } } }),
      action: async () => { effects++; return { ok: true, dispatched: true }; } } });
  return { worker, store, get calls() { return calls; }, get effects() { return effects; } };
}

test('malformed autonomous replies stop for correction without decision persistence or another Agent call', async () => {
  for (const reply of [() => null, () => [], () => 'complete', ({ revision }) => ({ decisionId: 'bad', basedOnRevision: revision, agentDecision: 'complete', action: { action: 'back' } }),
    ({ revision }) => ({ decisionId: 'bad', basedOnRevision: revision, agentDecision: 'act', action: { action: 'tap', selector: { text: 'Save', guessed: true } } })]) {
    const h = autonomous(reply);
    try {
      const result = await h.worker.start();
      assert.equal(result.ok, false); assert.match(result.error, /^(invalid_argument|unsupported_argument)$/);
      assert.equal(result.status, 'waiting_for_decision'); assert.equal(h.calls, 1); assert.equal(h.effects, 0);
      assert.equal(h.store.latest(h.worker.operationId, 'decision'), null);
      assert.equal(h.store.latest(h.worker.operationId, 'dispatch-marker'), null);
    } finally { await h.worker.cancel(); }
  }
});

test('the last allowed Agent reply may complete or act, and cannot open another Agent call', async () => {
  const complete = autonomous(({ revision }) => ({ decisionId: 'done', basedOnRevision: revision, agentDecision: 'complete' }));
  assert.equal((await complete.worker.start()).status, 'completed'); assert.equal(complete.calls, 1);
  const act = autonomous(({ revision }) => ({ decisionId: 'save', basedOnRevision: revision, agentDecision: 'act', action: { action: 'tap', selector: { text: 'Save' } } }));
  const result = await act.worker.start();
  assert.equal(result.status, 'intervention_required'); assert.equal(result.error, 'max_agent_calls');
  assert.equal(act.calls, 1); assert.equal(act.effects, 1);
  assert.equal(act.store.latest(act.worker.operationId, 'action-receipt').dispatched, true);
});

test('actual MCP rejects invalid contracts before opening storage, invoking providers or running a Script', async t => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-contract-mcp-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  await verifyExecutionContract({ out, serverPath: path.join(__dirname, '../bin/mcp-server.js') });
});

test('public autonomous MCP accepts the last allowed reply and exposes malformed reply correction', async t => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-contract-mcp-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  await verifyAutonomousContract({ out, serverPath: path.join(__dirname, '../bin/mcp-server.js') });
});
