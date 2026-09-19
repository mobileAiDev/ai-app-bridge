'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { publicReply } = require('../bin/public-reply');
const { createResponseStore, freezeResponse, MAX_SNAPSHOT_BYTES } = require('../bin/response-store');
const { createMemoryEvidenceAdapter, createSegmentedEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createFactStore } = require('../bin/fact-store');
const archive = require('../bin/shared-kernel/evidence-archive');
const host = require('../bin/execution-host');
test.after(() => host.close());

function frozen(value) { return freezeResponse(publicReply({ command: 'tree', reply: { value }, completed: true })); }

test('response bytes retain original fields, final feedback, text, null and canonical ordering', async () => {
  const adapter = createMemoryEvidenceAdapter();
  const store = createResponseStore({ adapter });
  for (const value of [null, '<node text="unchanged"/>\n中文', { ok: false, password: 'fixture-value',
    authorization: 'Bearer fixture-only', _feedback: { evidence: { complete: false } },
    nested: { z: [null, false, 0], a: '中文' } }]) {
    const input = frozen(value);
    const source = await store.save(input);
    assert.equal(source.persisted, true, JSON.stringify(source));
    const loaded = store.read(source.ref);
    assert.deepEqual(loaded.bytes, input.bytes);
    assert.deepEqual(loaded.snapshot.value, value);
    assert.equal(loaded.snapshot.control.source, undefined);
    assert.equal(loaded.snapshot.delivery, undefined);
    assert.equal(adapter.readById(source.ref.evidenceId).checksum, source.ref.checksum);
  }
});

test('the public read reports current read success and original execution separately, without providers or nested snapshots', async () => {
  const adapter = createMemoryEvidenceAdapter();
  const store = createResponseStore({ adapter });
  const input = frozen({ ok: false, error: 'original_failure', dispatched: true, ambiguous: true, data: [1, 2] });
  const source = await store.save(input);
  for (let i = 0; i < 3; i++) {
    const { value } = await host.run({ command: 'response', extract: null, arguments: { operation: 'read', ref: source.ref } }, {
      responseStore: store, rawRunner() { throw new Error('read must not execute a provider'); },
    });
    assert.equal(value.execution.ok, true);
    assert.equal(value.control.origin.execution.ok, false);
    assert.equal(value.control.origin.execution.ambiguous, true);
    assert.deepEqual(value.control.source, source);
    assert.deepEqual(value.value, input.snapshot.value);
  }
  assert.equal(adapter.list().length, 1);
});

test('save failures and the original-byte size limit never generate fake refs', async () => {
  const input = frozen({ ok: true, text: 'x' });
  for (const fault of ['enospc', 'throw']) {
    const store = createResponseStore({ adapter: createMemoryEvidenceAdapter({ fault }) });
    const source = await store.save(input);
    assert.equal(source.persisted, false);
    assert.equal(source.ref, undefined);
    assert(source.error);
  }
  const adapter = createMemoryEvidenceAdapter();
  const store = createResponseStore({ adapter });
  const exact = frozen({ ok: true, text: '' });
  exact.snapshot.value.text = 'x'.repeat(MAX_SNAPSHOT_BYTES - exact.bytes.length);
  exact.bytes = Buffer.from(require('../bin/shared-kernel/evidence-schema').canonicalJson(exact.snapshot));
  assert.equal(exact.bytes.length, MAX_SNAPSHOT_BYTES);
  assert.equal((await store.save(exact)).persisted, true, 'base64 overhead is not counted as source bytes');
  const tooLarge = await store.save({ snapshot: exact.snapshot, bytes: Buffer.concat([exact.bytes, Buffer.from(' ')]) });
  assert.equal(tooLarge.error, 'snapshot_too_large');
  assert.equal(tooLarge.ref, undefined);
  assert.equal((await store.save(frozen(Buffer.from([1, 2])))).error, 'binary_snapshot_unsupported');
});

test('missing, mismatched and corrupted response refs fail without returning unverified data', async () => {
  const adapter = createMemoryEvidenceAdapter();
  const store = createResponseStore({ adapter });
  const source = await store.save(frozen({ ok: true }));
  assert.throws(() => store.read({ ...source.ref, evidenceId: 'missing' }), { code: 'response_not_found' });
  assert.throws(() => store.read({ ...source.ref, operationId: 'wrong' }), { code: 'response_identity_mismatch' });
  assert.throws(() => store.read({ ...source.ref, checksum: '0'.repeat(64) }), { code: 'response_checksum_mismatch' });
  adapter.readById(source.ref.evidenceId).snapshotBase64 = Buffer.from('{}').toString('base64');
  assert.throws(() => store.read(source.ref), { code: 'response_checksum_mismatch' });
  adapter.close();
  assert.throws(() => store.read(source.ref), { code: 'response_not_found' });
});

test('real FactStore survives a new process and exports/verifies exactly the saved response bytes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-response-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const factsDir = path.join(directory, 'facts');
  const facts = createFactStore({ directory: factsDir, profile: '64mb' });
  t.after(() => facts.close());
  const store = createResponseStore({ adapter: createSegmentedEvidenceAdapter(facts) });
  const input = frozen({ ok: true, password: 'fixture-only', _feedback: { appended: 'last' }, text: '原始文本' });
  const source = await store.save(input);
  assert.equal(source.persisted, true, JSON.stringify(source));
  assert.deepEqual(store.read(source.ref).bytes, input.bytes);
  const outputDir = path.join(directory, 'archive');
  const exported = await archive.handle({ operation: 'export', namespace: 'response', operationId: source.ref.operationId,
    outputDir }, { getFactStore: () => facts });
  assert.equal(exported.ok, true, JSON.stringify(exported));
  const verified = await archive.handle({ operation: 'verify', archiveDir: outputDir, manifestSha256: exported.manifestSha256 });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  const [record] = JSON.parse(fs.readFileSync(path.join(outputDir, 'records.json')));
  assert.deepEqual(Buffer.from(record.payload.snapshotBase64, 'base64'), input.bytes);
  facts.close();
  const result = execFileSync(process.execPath, ['-e', `
    const h = require(${JSON.stringify(require.resolve('../bin/execution-host'))});
    h.run({command:'response',extract:null,arguments:{operation:'read',ref:JSON.parse(process.argv[1])}})
      .then(async result => { await h.close(); process.stdout.write(JSON.stringify(result.value)); });
  `, JSON.stringify(source.ref)], { encoding: 'utf8', env: { ...process.env, AI_APP_BRIDGE_FACT_STORE_DIR: factsDir } });
  const reply = JSON.parse(result);
  assert.equal(reply.execution.ok, true, result);
  assert.deepEqual(reply.value, input.snapshot.value);
  assert.deepEqual(reply.control.source, source);
});

test('8 MiB source bytes survive real segmented storage including base64 and record overhead', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-response-max-'));
  const facts = createFactStore({ directory, profile: '256mb' });
  t.after(() => { facts.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const store = createResponseStore({ adapter: createSegmentedEvidenceAdapter(facts) });
  const input = frozen({ ok: true, text: '' });
  input.snapshot.value.text = 'x'.repeat(MAX_SNAPSHOT_BYTES - input.bytes.length);
  input.bytes = Buffer.from(require('../bin/shared-kernel/evidence-schema').canonicalJson(input.snapshot));
  const source = await store.save(input);
  assert.equal(source.persisted, true, JSON.stringify(source));
  assert.deepEqual(store.read(source.ref).bytes, input.bytes);
});
