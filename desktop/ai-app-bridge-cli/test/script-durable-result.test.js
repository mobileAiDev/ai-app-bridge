'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFactStore } = require('../bin/fact-store');
const { createSegmentedEvidenceAdapter, createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { createScriptSupervisor } = require('../bin/script/script-supervisor');
const { handle } = require('../bin/script/script-entry');
const { checksumOf } = require('../bin/shared-kernel/evidence-schema');
const { handle: archive } = require('../bin/shared-kernel/evidence-archive');
const actions = async () => { throw new Error('unexpected_device_call'); };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-script-result-'));
  const opened = [];
  t.after(() => { for (const store of opened) store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, open() {
    const facts = createFactStore({ directory: path.join(root, 'facts'), profile: '64mb' });
    opened.push(facts);
    return { facts, store: createScriptEvidenceStore({ adapter: createSegmentedEvidenceAdapter(facts) }) };
  } };
}
function spec(source, policy = {}, language = 'javascript') {
  return { schemaVersion: 'aab.code-script/v1', language, source, permissions: [],
    policy: { timeoutMs: 10000, ...policy } };
}
async function execute(store, script) {
  const supervisor = createScriptSupervisor();
  const start = await handle({ supervisor, store, operation: 'start', script, actions });
  assert.equal(start.ok, true, JSON.stringify(start));
  await supervisor.registry.get(start.operationId).running;
  const status = await handle({ supervisor, operation: 'status', operationId: start.operationId });
  return { supervisor, status, operationId: start.operationId };
}

for (const language of ['javascript', 'python']) {
  test(`${language}: full 2 MiB output outlives the event ring, native store reopen and archive export`, async t => {
    const f = fixture(t), live = f.open();
    const source = language === 'javascript'
      ? "module.exports.main = () => ({ text: '界'.repeat(699040), count: 0, accepted: false });"
      : "def main(ctx):\n    return {'text': '界' * 699040, 'count': 0, 'accepted': False}\n";
    const { supervisor, status, operationId } = await execute(live.store, spec(source, { maxOutputBytes: 3 * 1024 * 1024 }, language));
    assert.equal(status.status, 'completed', JSON.stringify(status));
    const terminal = status.events.find(e => e.type === 'script_completed');
    assert(terminal);
    assert.equal(Object.hasOwn(terminal, 'result'), false);
    assert.deepEqual(terminal.resultRef, status.resultRef);
    assert(status.resultRef.bytes > 1024 * 1024);
    assert(supervisor.registry.retainedBytes() < 16 * 1024);
    const completion = await supervisor.registry.get(operationId).running;
    assert.deepEqual(completion, { ok: true, resultRef: status.resultRef });
    const result = await handle({ supervisor, operation: 'result', operationId });
    assert.equal(result.ok, true, JSON.stringify(result.resultRef));
    assert.equal(result.result.text.length, 699040);
    assert.equal(result.result.accepted, false);
    assert.equal(checksumOf(result.result), status.resultRef.sha256);
    live.facts.close();
    const reopened = f.open(), cold = createScriptSupervisor();
    const restored = await handle({ supervisor: cold, store: reopened.store, operation: 'status', operationId });
    assert.equal(restored.status, 'completed');
    assert.deepEqual(restored.resultRef, status.resultRef);
    assert.deepEqual(await handle({ supervisor: cold, store: reopened.store, operation: 'result', operationId }), result);
    const exported = await archive({ operation: 'export', namespace: 'script', operationId,
      outputDir: path.join(f.root, 'archive') }, { getFactStore: () => reopened.facts });
    assert.equal(exported.ok, true, JSON.stringify(exported));
    assert.equal(exported.coverage.referenceClosure, 'complete');
    reopened.facts.close();
    const verified = await archive({ operation: 'verify', archiveDir: path.join(f.root, 'archive'), manifestSha256: exported.manifestSha256 });
    assert.equal(verified.ok, true, JSON.stringify(verified));
  });
}

test('default 1 MiB output boundary includes JSON bytes, with no frame envelope off-by-one', async t => {
  const f = fixture(t), { store } = f.open();
  const accepted = await execute(store, spec("module.exports.main = () => 'x'.repeat(1048574);"));
  assert.equal(accepted.status.status, 'completed');
  assert.equal(accepted.status.resultRef.bytes, 1048576);
  const rejected = await execute(store, spec("module.exports.main = () => 'x'.repeat(1048575);"));
  assert.equal(rejected.status.status, 'failed');
  assert.equal(rejected.status.error, 'output_too_large');
});

test('null, false and zero survive cold retrieval and redaction metadata hashes the stored representation', async () => {
  const store = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  for (const value of [null, false, 0, { z: '中文', password: 'fixture-secret', accepted: false }]) {
    const { operationId, status } = await execute(store, spec(`module.exports.main = () => (${JSON.stringify(value)});`));
    assert.equal(status.status, 'completed');
    const result = await handle({ supervisor: createScriptSupervisor(), store, operation: 'result', operationId });
    assert.equal(result.ok, true);
    if (value && typeof value === 'object') {
      assert.deepEqual(result.result, { z: '中文', password: '[REDACTED]', accepted: false });
      assert.equal(result.resultRef.representation, 'redacted-json');
      assert.notEqual(result.resultRef.originalSha256, result.resultRef.sha256);
    } else assert.equal(result.result, value);
  }
});

test('failed result persistence cannot publish a completed terminal', async () => {
  const backing = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const store = { ...backing, persist: (kind, value) => kind === 'result' ? { ok: false, error: 'ENOSPC' } : backing.persist(kind, value) };
  const { status, operationId } = await execute(store, spec('module.exports.main = () => true;'));
  assert.equal(status.status, 'failed');
  assert.equal(status.error, 'result_not_persisted');
  assert(!status.events.some(e => e.type === 'script_completed'));
  assert.equal(backing.latest(operationId, 'checkpoint').status, 'failed');
  const result = await handle({ store, operation: 'result', operationId });
  assert.equal(result.error, 'result_unavailable');
});

test('terminal checkpoint waits for durable result and missing/tampered outputs never pass retrieval', async () => {
  const backing = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  let release, notify;
  const writing = new Promise(resolve => { notify = resolve; });
  const store = { ...backing, persist: (kind, value) => {
    if (kind !== 'result') return backing.persist(kind, value);
    notify();
    return new Promise(resolve => { release = () => resolve(backing.persist(kind, value)); });
  } };
  const supervisor = createScriptSupervisor();
  const start = await handle({ supervisor, store, operation: 'start', actions, script: spec('module.exports.main = () => ({ ok: true });') });
  assert.equal(start.ok, true, JSON.stringify(start));
  await writing;
  const operationId = start.operationId;
  const pending = await handle({ supervisor, operation: 'status', operationId });
  assert.equal(pending.status, 'finishing');
  assert.equal((await handle({ store, operation: 'result', operationId })).error, 'result_not_ready');
  assert.equal(backing.latest(operationId, 'checkpoint').status, 'running');
  release();
  await supervisor.registry.get(operationId).running;
  const ref = backing.latest(operationId, 'checkpoint').resultRef;
  const missing = { ...store, read: id => id === ref.evidenceId ? { ok: false, error: 'not_found' } : store.read(id) };
  assert.equal((await handle({ store: missing, operation: 'result', operationId })).error, 'result_not_retained');
  const body = backing.latest(operationId, 'result');
  body.result.ok = false;
  assert.equal((await handle({ store, operation: 'result', operationId })).error, 'checksum_mismatch');
});


test('a terminal write that evicts its result is replaced by a durable failed terminal', async () => {
  const backing = createScriptEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  let evictedId;
  const store = { ...backing, persist: async (kind, record) => {
    const saved = await backing.persist(kind, record);
    if (kind === 'checkpoint' && record.status === 'completed') evictedId = record.resultRef.evidenceId;
    return saved;
  }, read: id => id === evictedId ? { ok: false, error: 'not_found' } : backing.read(id) };
  const { status, operationId } = await execute(store, spec('module.exports.main = () => true;'));
  assert.equal(status.status, 'failed');
  assert.equal(status.error, 'result_not_persisted');
  assert(!status.events.some(event => event.type === 'script_completed'));
  const checkpoint = backing.latest(operationId, 'checkpoint');
  assert.equal(checkpoint.status, 'failed');
  assert.equal(checkpoint.resultRef, null);
  assert.equal(checkpoint.resultError, 'result_not_retained');
  assert.equal((await handle({ store, operation: 'result', operationId })).error, 'result_unavailable');
});
