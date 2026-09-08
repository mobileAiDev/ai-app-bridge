'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { reviewTrialRecords } = require('../review-search-durable');
const { createScriptSupervisor } = require('../../../../desktop/ai-app-bridge-cli/bin/script/script-supervisor');
const { createScriptEvidenceStore } = require('../../../../desktop/ai-app-bridge-cli/bin/script/script-evidence-store');
const { createMemoryEvidenceAdapter } = require('../../../../desktop/ai-app-bridge-cli/bin/shared-kernel/evidence-adapters');
const { compileScriptSpec } = require('../../../../desktop/ai-app-bridge-cli/bin/script/script-spec');
const { checksumOf, verifyChecksum } = require('../../../../desktop/ai-app-bridge-cli/bin/shared-kernel/evidence-schema');

// Exercise the real supervisor's persistence contract with a device-free action port.
async function recordTrial(status = 'completed', checkpoint = false) {
  const facts = [], adapter = createMemoryEvidenceAdapter(), record = adapter.record;
  adapter.record = envelope => {
    const receipt = record(envelope);
    // Other targets may occupy the intervening FactStore sequence numbers.
    facts.push({ globalSeq: receipt.globalSeq * 3, payload: structuredClone(envelope) });
    return receipt;
  };
  const store = createScriptEvidenceStore({ adapter });
  const target = { serial: 'durable-test-device', packageName: 'durable.test.app' };
  const spec = { schemaVersion: 'aab.code-script/v1', name: 'durable-contract', language: 'javascript',
    source: 'exports.main = async () => {};', target, inputs: { expected: { title: ['fixture-title'] } },
    permissions: ['app.read', 'app.interact'], policy: { restartPolicy: 'none' } };
  const compiled = compileScriptSpec(spec);
  let release;
  const stopped = new Promise(resolve => { release = resolve; });
  const runtime = {
    async start({ host, agent, emit }) {
      await host.call('tap', { x: 10, y: 20 });
      if (checkpoint) await emit('checkpoint', { name: 'after-tap', state: { phase: 'title' } });
      await host.call('input-text', { text: 'fixture-title' });
      if (status === 'cancelled') {
        await Promise.race([agent.askAgent({ question: 'cancellation checkpoint' }), stopped]);
      }
      return status === 'failed' ? { ok: false, error: 'expected_assertion_failure' } : { ok: true };
    },
    stop() { release(); },
  };
  const supervisor = createScriptSupervisor();
  let state = await supervisor.handle({ operation: 'start', operationId: 'durable-trial', script: spec, store, runtime,
    actions: async () => ({ ok: true }) });
  for (let polls = 0; !['completed', 'failed', 'cancelled'].includes(state.status); polls += 1) {
    assert(polls < 100, 'mock_runtime_did_not_finish');
    if (state.status === 'waiting_for_agent') state = await supervisor.handle({ operation: 'cancel', operationId: state.operationId });
    else {
      await new Promise(resolve => setImmediate(resolve));
      state = supervisor.handle({ operation: 'status', operationId: state.operationId });
    }
  }
  const events = structuredClone(state.events);
  await store.close();
  assert.equal(state.status, status, JSON.stringify(events));
  return { facts, events, target, compiled,
    trial: { operationId: state.operationId, scriptHash: state.hash, executionStatus: state.status } };
}

const review = fixture => reviewTrialRecords({ ...fixture, verifyChecksum, checksumOf });
function rehash(fixture) {
  for (const { payload } of fixture.facts) {
    const { checksum, persisted, ...body } = payload;
    payload.checksum = checksumOf(body);
  }
}
const terminal = fixture => fixture.facts.at(-1).payload;
const find = (fixture, kind) => fixture.facts.find(fact => fact.payload.kind === kind).payload;
let baseline;
before(async () => { baseline = await recordTrial(); });

for (const status of ['completed', 'failed', 'cancelled']) {
  test('accepts the real supervisor ' + status + ' persistence sequence', async () => {
    const fixture = await recordTrial(status);
    assert.deepEqual(review(fixture), { actions: 2, terminalStatus: status });
    assert.deepEqual(fixture.facts.map(fact => fact.globalSeq), [3, 6, 9, 12, 15, 18]);
  });
}

test('accepts a persisted named checkpoint between actions', async () => {
  const fixture = await recordTrial('completed', true);
  assert.deepEqual(review(fixture), { actions: 2, terminalStatus: 'completed' });
  assert.equal(terminal(fixture).checkpointActionSequence, 1);
});

const corruptions = [
  ['missing initial checkpoint', fixture => fixture.facts.shift(), /start_and_terminal_checkpoints_required/],
  ['terminal persisted before the actions', fixture => {
    const facts = fixture.facts;
    [facts[1].payload, facts.at(-1).payload] = [facts.at(-1).payload, facts[1].payload];
  }, /terminal_checkpoint_not_last/],
  ['receipt persisted before its marker', fixture => {
    [fixture.facts[1].payload, fixture.facts[2].payload] = [fixture.facts[2].payload, fixture.facts[1].payload];
  }, /receipt_before_marker/],
  ['terminal action progress reset to zero', fixture => { terminal(fixture).actionSequence = 0; }, /checkpoint_action_sequence_mismatch/],
  ['terminal checkpoint boundary invented', fixture => { terminal(fixture).checkpointActionSequence = 1; }, /checkpoint_boundary_mismatch/],
  ['checkpoint revision skipped', fixture => { terminal(fixture).revision = 3; }, /checkpoint_revision_gap/],
  ['marker action number changed', fixture => { find(fixture, 'dispatch-marker').actionSequence = 2; }, /marker_action_sequence_mismatch/],
  ['receipt action number changed', fixture => { find(fixture, 'action-receipt').actionSequence = 2; }, /receipt_action_sequence_mismatch/],
  ['marker assigned to another checkpoint', fixture => { find(fixture, 'dispatch-marker').revision = 2; }, /marker_checkpoint_revision_mismatch/],
  ['receipt assigned to another checkpoint', fixture => { find(fixture, 'action-receipt').revision = 2; }, /receipt_checkpoint_revision_mismatch/],
  ['duplicate FactStore sequence', fixture => { fixture.facts[1].globalSeq = fixture.facts[0].globalSeq; }, /durable_sequence_invalid/],
  ['missing action receipt', fixture => { fixture.facts.splice(2, 1); }, /action_receipt_count_mismatch/],
  ['changed dispatch command hash', fixture => { find(fixture, 'dispatch-marker').actionSpecHash = '0'.repeat(64); }, /AssertionError/],
  ['unpersisted terminal event', fixture => { fixture.events.at(-1).persisted = false; }, /terminal_event_not_persisted/],
  ['receipt event contradicts the durable result', fixture => {
    fixture.events.find(event => event.type === 'action_receipt').payloadSummary.ambiguous = true;
  }, /receipt_event_mismatch:ambiguous/],
];
for (const [name, mutate, error] of corruptions) {
  test('rejects ' + name + ' even with valid record checksums', () => {
    const fixture = structuredClone(baseline);
    mutate(fixture); rehash(fixture);
    assert(fixture.facts.every(fact => verifyChecksum(fact.payload).ok));
    assert.throws(() => review(fixture), error);
  });
}

for (const [field, value] of Object.entries({
  name: 'another-script', language: 'python', sourcePath: '/other/source.js', entrypoint: 'other',
  inputs: { expected: { title: ['wrong-title'] } }, policy: { restartPolicy: 'checkpoint' },
  permissions: ['app.read'], target: { serial: 'other-device', packageName: 'durable.test.app' },
})) {
  test('rejects changed checkpoint ' + field + ' despite an unchanged script hash', () => {
    const fixture = structuredClone(baseline);
    terminal(fixture)[field] = value; rehash(fixture);
    assert.equal(terminal(fixture).hash, fixture.compiled.hash);
    assert.throws(() => review(fixture), new RegExp('checkpoint_spec_mismatch:' + field));
  });
}

test('rejects a named checkpoint that precedes an unfinished action receipt', async () => {
  const fixture = await recordTrial('completed', true);
  // Start, marker 1, named checkpoint, receipt 1, marker 2, receipt 2, terminal.
  [fixture.facts[2].payload, fixture.facts[3].payload] = [fixture.facts[3].payload, fixture.facts[2].payload];
  assert.throws(() => review(fixture), /checkpoint_precedes_action_receipt/);
});

test('rejects payload damage without a replacement checksum', () => {
  const fixture = structuredClone(baseline);
  terminal(fixture).actionSequence = 0;
  assert.throws(() => review(fixture), /AssertionError/);
});
