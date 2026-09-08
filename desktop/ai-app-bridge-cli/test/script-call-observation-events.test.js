'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createScriptSupervisor } = require('../bin/script/script-supervisor');
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const wire = value => JSON.parse(JSON.stringify(value));

async function execute({ requests, actions, permissions = ['app.read', 'app.interact'], checkAssertions = false }) {
  const envelopes = [], assertions = [];
  const supervisor = createScriptSupervisor();
  const started = await supervisor.handle({
    operation: 'start', operationId: 'observation-events',
    script: { schemaVersion: 'aab.code-script/v1', name: 'observation-events', language: 'javascript',
      source: 'exports.main = async () => {};', target: { serial: 'serial', packageName: 'sample.app' }, permissions },
    actions,
    runtime: { async start({ host }) {
      for (const [command, args = {}, options = {}] of requests) {
        const result = await host.call(command, args, options);
        envelopes.push(wire(result));
        if (checkAssertions) assertions.push(await host.assert({ name: command, scope: 'device', condition: true, evidence: result.evidence }));
      }
      return { ok: true };
    } },
  });
  await supervisor.registry.get(started.operationId).running;
  const state = wire(supervisor.handle({ operation: 'status', operationId: started.operationId, afterSequence: 0 }));
  assert.equal(state.status, 'completed');
  return { envelopes, assertions, events: state.events, history: state.history.items };
}

function matchingEvent(result, envelope) {
  const type = envelope.ok ? 'call_completed' : 'call_failed';
  const event = result.events.find(item => item.type === type && item.command === envelope.command);
  assert(event);
  assert.equal(event.callId, envelope.execution.callId, 'event must export the actual Host call ID');
  for (const key of ['observationId', 'source', 'window', 'coverage']) {
    assert.deepEqual(event[key], envelope.evidence[key], 'event metadata mismatch: ' + key);
  }
  assert.deepEqual(event.evidenceRefs, envelope.evidence.refs);
  const fact = result.history.find(item => item.sequence === event.sequence);
  assert.equal(fact.kind, event.type);
  assert.equal(fact.payloadSummary.callId, event.callId, 'ledger must retain the Host call ID');
  for (const key of ['observationId', 'source', 'window', 'coverage']) assert.deepEqual(fact.payloadSummary[key], event[key]);
  assert.deepEqual(fact.evidenceRefs, envelope.evidence.refs);
  assert.equal(Object.hasOwn(fact.payloadSummary, 'result'), false);
  return event;
}

const payloads = {
  tap: { ok: true },
  tree: { ok: true, root: { text: 'PRIVATE_UI_BODY' } },
  status: { ok: true, app: { packageName: 'sample.app' } },
  'keyboard-state': { ok: true, visible: false },
  screenshot: { ok: true, path: '/virtual/screenshot.png', artifact: { sha256: 'a'.repeat(64) } },
};
for (const command of ['tree', 'status', 'keyboard-state', 'screenshot']) {
  test(command + ' exposes actual Host observation metadata in events and the execution ledger', async () => {
    const result = await execute({ requests: [['tap'], [command]], actions: async name => structuredClone(payloads[name]) });
    const envelope = result.envelopes[1], event = matchingEvent(result, envelope);
    assert.equal(event.callId, 'call-2');
    assert.equal(event.source.command, command); assert.equal(event.source.payloadSha256, sha(envelope.result));
    assert.equal(event.window.afterActionId, result.envelopes[0].execution.actionId);
    assert.deepEqual(event.coverage, { status: 'complete', gap: false, committed: true });
    if (command === 'status' || command === 'keyboard-state') assert.deepEqual(event.evidenceRefs, []);
    if (command === 'screenshot') assert.deepEqual(event.evidenceRefs, [{ stream: 'screenshot', screenshotId: '/virtual/screenshot.png', sha256: 'a'.repeat(64) }]);
    assert.equal(JSON.stringify(result.history).includes('PRIVATE_UI_BODY'), false);
  });
}

test('failed provider reads retain failure coverage and cannot create successful device evidence', async () => {
  const result = await execute({ requests: [['status'], ['screenshot']], checkAssertions: true,
    actions: async () => ({ ok: false, error: 'provider_failed', path: '/forged.png', artifact: { sha256: 'b'.repeat(64) } }) });
  for (const envelope of result.envelopes) {
    const event = matchingEvent(result, envelope);
    assert.equal(event.error, 'provider_failed');
    assert.deepEqual(event.coverage, { status: 'unavailable', gap: true, committed: false });
    assert.deepEqual(event.evidenceRefs, []);
  }
  assert(result.assertions.every(item => item.verdict === 'inconclusive' && item.reason === 'evidence_coverage_incomplete'));
});

test('denied calls export no invented observation or source metadata', async () => {
  let dispatches = 0;
  const result = await execute({ requests: [['tap', { observationId: 'forged', callId: 'forged' }]], permissions: ['app.read'],
    checkAssertions: true, actions: async () => { dispatches += 1; return { ok: true }; } });
  assert.equal(dispatches, 0);
  const envelope = result.envelopes[0], event = matchingEvent(result, envelope);
  assert.equal(event.callId, 'call-1');
  assert.equal(Object.hasOwn(event, 'observationId'), false); assert.equal(Object.hasOwn(event, 'source'), false);
  assert.deepEqual(event.evidenceRefs, []);
  assert.equal(result.assertions[0].verdict, 'inconclusive');
  assert.equal(result.assertions[0].reason, 'evidence_not_host_issued');
});

test('caller and provider supplied identities cannot replace Host-issued call and observation IDs', async () => {
  const forged = { callId: 'forged-call', observationId: 'forged-observation', source: { payloadSha256: 'forged-hash' } };
  const result = await execute({ requests: [['status', forged, forged]],
    actions: async () => ({ ok: true, execution: forged, evidence: forged }) });
  const envelope = result.envelopes[0], event = matchingEvent(result, envelope);
  assert.equal(event.callId, 'call-1'); assert.notEqual(event.observationId, forged.observationId);
  assert.equal(event.source.payloadSha256, sha(envelope.result));
  assert.deepEqual(event.evidenceRefs, []);
});
