'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createFileEvidenceAdapter, createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { createScriptSupervisor } = require('../bin/script/script-supervisor');
const { createProductionHost, handle } = require('../bin/script/script-entry');
const { readScriptInventory } = require('../bin/script/script-inventory');

test('fresh Host inventories real crashed and completed Scripts without starting or replaying them', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reopen = () => createScriptEvidenceStore({ adapter: createFileEvidenceAdapter({ dir: root }) });
  const supervisor = createScriptSupervisor({ createHost: createProductionHost });
  const effects = [];
  for (const [operationId, crash] of [['crash-a', true], ['finished-b', false], ['crash-c', true]]) {
    const started = await handle({ supervisor, store: reopen(), operation: 'start', operationId,
      actions: async () => { effects.push(operationId); return { ok: true, dispatched: true }; },
      script: { schemaVersion: 'aab.code-script/v1', language: 'javascript',
        target: { platform: 'android', serial: operationId }, policy: { restartPolicy: 'checkpoint' },
        source: `exports.main=async ctx=>{await ctx.call('keyevent',{keyCode:4}); ${crash ? 'process.exit(31);' : 'return true;'}};` } });
    assert.equal(started.ok, true, JSON.stringify(started));
    await supervisor.registry.get(operationId).running;
  }
  const reader = createScriptSupervisor({ createHost() { assert.fail('Inventory must not create an execution Host'); } });
  const result = await handle({ supervisor: reader, store: reopen(), operation: 'inventory' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.items.map(row => row.operationId), ['crash-a', 'crash-c']);
  assert(result.items.every(row => row.liveStatus === null && row.durableStatus === 'failed'));
  assert.deepEqual(effects, ['crash-a', 'finished-b', 'crash-c']);
  assert.equal(reader.registry.size, 0);
  assert.equal((await handle({ supervisor: reader, store: reopen(), operation: 'inventory', view: 'all' })).items.length, 3);
});

test('inventory freezes durable pagination, isolates corrupt operations, and exposes retention scope', async () => {
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const append = async (operationId, status = 'running') => {
    const result = await store.persist('checkpoint', { operationId, revision: 1, stepId: 'start', status });
    assert.equal(result.ok, true); return result.evidenceId;
  };
  await append('a'); await append('b'); await append('c');
  const first = readScriptInventory({ store, limit: 1 });
  assert.deepEqual(first.items.map(row => row.operationId), ['a']);
  await append('aa'); await append('b', 'completed');
  const second = readScriptInventory({ store, cursor: first.cursor });
  assert.deepEqual(second.items.map(row => row.operationId), ['b', 'c']);
  assert.equal(second.items[0].durableStatus, 'running');
  assert.equal(second.coverage.completeHistory, false);
  const corrupt = { list: () => store.list().map(row => row.operationId === 'a' ? { ...row, status: 'tampered' } : row) };
  const isolated = readScriptInventory({ store: corrupt });
  assert.equal(isolated.ok, true); assert.equal(isolated.items[0].error, 'checksum_mismatch');
  assert(isolated.items.some(row => row.operationId === 'c'));
  const expired = { list: () => store.list().filter(row => row.evidenceId !== first.throughId) };
  assert.equal(readScriptInventory({ store: expired, cursor: first.cursor }).error, 'inventory_cursor_expired');
  assert.equal(readScriptInventory({ store, cursor: first.cursor, view: 'all' }).error, 'invalid_inventory_cursor');
});

test('completed program with an unresolved effect stays in attention with original identities', async () => {
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  for (const [kind, row] of [
    ['dispatch-marker', { actionId: 'original', actionSequence: 1, planStepId: 'one', actionSpecHash: 'hash', state: 'prepared', target: { platform: 'android', serial: 'phone' }, command: 'tap', label: 'submit' }],
    ['checkpoint', { stepId: 'end', status: 'completed', actionSequence: 1 }],
  ]) assert.equal((await store.persist(kind, { operationId: 'ambiguous', revision: 1, ...row })).ok, true);
  const result = readScriptInventory({ store });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].unsettledCount, 1);
  assert.equal(result.items[0].unsettled[0].actionId, 'original');
  assert.equal(result.items[0].nextAction.arguments.operation, 'recovery');
});

test('retained ambiguous receipt stays in attention when its dispatch marker has expired', async () => {
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const original = { operationId: 'retained-receipt', revision: 1, actionId: 'original-action', actionSequence: 1,
    startedAtMs: 1, completedAtMs: 2, command: 'tap', label: 'submit', mechanicalStatus: 'failed',
    dispatched: true, ambiguous: true };
  assert.equal((await store.persist('action-receipt', original)).ok, true);
  assert.equal((await store.persist('checkpoint', { operationId: original.operationId, revision: 2,
    stepId: 'end', status: 'completed', actionSequence: 1 })).ok, true);
  for (const view of ['attention', 'all']) {
    const result = readScriptInventory({ store, view });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].needsInspection, true);
    assert.equal(result.items[0].unsettledCount, 1);
    assert.equal(result.items[0].unsettled[0].actionId, original.actionId);
    assert.equal(result.items[0].unsettled[0].markerMissing, true);
    assert.equal(result.items[0].nextAction.arguments.operation, 'recovery');
  }
  // A later conclusive original receipt resolves the retained uncertainty.
  assert.equal((await store.persist('action-receipt', { ...original, completedAtMs: 3,
    mechanicalStatus: 'ok', ambiguous: false })).ok, true);
  assert.deepEqual(readScriptInventory({ store }).items, []);
});
