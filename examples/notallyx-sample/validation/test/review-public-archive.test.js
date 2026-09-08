'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { reviewDurable, directoryHashes } = require('../review-search-durable');
const { createFactStore } = require('../../../../desktop/ai-app-bridge-cli/bin/fact-store');
const { createScriptSupervisor } = require('../../../../desktop/ai-app-bridge-cli/bin/script/script-supervisor');
const { createScriptEvidenceStore } = require('../../../../desktop/ai-app-bridge-cli/bin/script/script-evidence-store');
const { createSegmentedEvidenceAdapter } = require('../../../../desktop/ai-app-bridge-cli/bin/shared-kernel/evidence-adapters');
const { createMcpClient, payloadOf } = require('../../../../desktop/ai-app-bridge-cli/scripts/validation/mcp-jsonrpc-client');

const SERVER = path.resolve(__dirname, '../../../../desktop/ai-app-bridge-cli/bin/mcp-server.js');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

async function exportedTrial(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-public-archive-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, 'run'), storeDirectory = path.join(root, 'source-facts');
  const trialDirectory = path.join(out, 'positive-1');
  fs.mkdirSync(trialDirectory, { recursive: true });
  const target = { serial: 'device-free-test', packageName: 'public.archive.test' };
  const spec = {
    schemaVersion: 'aab.code-script/v1', name: 'public-archive-trial', language: 'javascript',
    source: 'exports.main = async () => {};', target, inputs: { expected: 'fixed-value' },
    permissions: ['app.read', 'app.interact'], policy: { restartPolicy: 'none' },
  };
  write(path.join(trialDirectory, 'spec.json'), spec);
  const facts = createFactStore({ directory: storeDirectory, profile: '64mb' });
  let state;
  try {
    const store = createScriptEvidenceStore({ adapter: createSegmentedEvidenceAdapter(facts) });
    const supervisor = createScriptSupervisor();
    state = await supervisor.handle({ operation: 'start', operationId: 'public-archive-trial', script: spec, store,
      runtime: { async start({ host }) {
        await host.call('tap', { x: 10, y: 20 });
        await host.call('input-text', { text: 'fixed-value' });
        return { ok: true };
      } },
      actions: async () => ({ ok: true }),
    });
    for (let polls = 0; !['completed', 'failed', 'cancelled'].includes(state.status); polls += 1) {
      assert(polls < 100, 'device_free_runtime_did_not_finish');
      await new Promise(resolve => setImmediate(resolve));
      state = supervisor.handle({ operation: 'status', operationId: state.operationId });
    }
    assert.equal(state.status, 'completed');
    await facts.drain();
  } finally { facts.close(); }
  write(path.join(trialDirectory, 'events.json'), state.events);
  const trial = { name: 'positive-1', kind: 'positive', operationId: state.operationId,
    scriptHash: state.hash, executionStatus: state.status };
  const client = createMcpClient({ serverPath: SERVER,
    transcriptPath: path.join(root, 'export-mcp.jsonl'), stderrPath: path.join(root, 'export-mcp-stderr.log'),
    env: { AI_APP_BRIDGE_FACT_STORE_DIR: storeDirectory, AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb' } });
  try {
    await client.initialize();
    trial.archive = payloadOf(await client.request('tools/call', { name: 'run', arguments: { command: 'evidence', arguments: {
      operation: 'export', namespace: 'script', operationId: trial.operationId,
      outputDir: path.join(trialDirectory, 'durable-archive'),
    } } }));
    assert.equal(trial.archive.ok, true, JSON.stringify(trial.archive));
    write(path.join(trialDirectory, 'archive-export.json'), trial.archive);
  } finally { assert.deepEqual(await client.close(), { code: 0, signal: null }); }
  // Verification must remain possible after the source store ceases to exist.
  fs.rmSync(storeDirectory, { recursive: true });
  return { out, trialDirectory, trial, report: { server: SERVER, target, trials: [trial] } };
}

test('durable review uses two new public offline verifiers and preserves action validation', async t => {
  const fixture = await exportedTrial(t);
  const before = directoryHashes(fixture.trial.archive.archiveDir);
  const result = await reviewDurable(fixture.out, fixture.report);
  assert.equal(result.ok, true);
  assert.equal(result.method, 'public-evidence-export-verify');
  assert.equal(result.freshVerifierProcesses, 2);
  assert.equal(result.offlineFactStoreUnavailable, true);
  assert.equal(result.archivesUnchanged, true);
  assert.equal(result.records, 6);
  assert.equal(result.actions, 2);
  assert.equal(result.operations[0].recordCount, 6);
  assert.equal(result.operations[0].manifestSha256, fixture.trial.archive.manifestSha256);
  assert.deepEqual(directoryHashes(fixture.trial.archive.archiveDir), before);
  const review = path.join(fixture.out, 'durable-review');
  assert.equal(fs.existsSync(path.join(review, 'facts-copy')), false);
  assert.equal(fs.statSync(path.join(review, 'fact-store-unavailable')).isFile(), true);
  for (const pass of [1, 2]) {
    const directory = path.join(review, 'verify-pass-' + pass);
    assert.equal(read(path.join(directory, 'positive-1.json')).integrity, 'verified');
    assert.deepEqual(read(path.join(directory, 'host-exit.json')), { code: 0, signal: null });
    const transcript = fs.readFileSync(path.join(directory, 'mcp.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const calls = transcript.filter(item => item.direction === 'request' && item.message.method === 'tools/call');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].message.params.arguments, {
      command: 'evidence', arguments: { operation: 'verify', archiveDir: fixture.trial.archive.archiveDir,
        manifestSha256: fixture.trial.archive.manifestSha256 },
    });
  }
});

test('durable review stops on public verification failure with no old-store fallback', async t => {
  const fixture = await exportedTrial(t);
  const records = path.join(fixture.trial.archive.archiveDir, 'records.json');
  fs.appendFileSync(records, '\n');
  await assert.rejects(reviewDurable(fixture.out, fixture.report), /public_evidence_verify_failed.*records_checksum_mismatch/);
  const review = path.join(fixture.out, 'durable-review');
  assert.equal(read(path.join(review, 'verify-pass-1', 'positive-1.json')).ok, false);
  assert.equal(fs.existsSync(path.join(review, 'verify-pass-2')), false);
  assert.equal(fs.existsSync(path.join(review, 'positive-1.json')), false);
  assert.equal(fs.existsSync(path.join(review, 'report.json')), false);
});

test('durable review requires the frozen export receipt hash', async t => {
  const fixture = await exportedTrial(t);
  delete fixture.trial.archive.manifestSha256;
  await assert.rejects(reviewDurable(fixture.out, fixture.report), /frozen_manifest_hash_required/);
  assert.equal(fs.existsSync(path.join(fixture.out, 'durable-review', 'verify-pass-1')), false);
});

test('valid public archive integrity cannot hide an inconsistent action event', async t => {
  const fixture = await exportedTrial(t);
  const eventsPath = path.join(fixture.trialDirectory, 'events.json'), events = read(eventsPath);
  events.find(event => event.type === 'action_receipt').payloadSummary.ambiguous = true;
  write(eventsPath, events);
  await assert.rejects(reviewDurable(fixture.out, fixture.report), /receipt_event_mismatch:ambiguous/);
  const review = path.join(fixture.out, 'durable-review');
  assert.equal(read(path.join(review, 'verify-pass-1', 'positive-1.json')).integrity, 'verified');
  assert.equal(fs.existsSync(path.join(review, 'verify-pass-2')), false);
  assert.equal(fs.existsSync(path.join(review, 'report.json')), false);
});

test('durable review rejects a changed report receipt before running verify', async t => {
  const fixture = await exportedTrial(t);
  fixture.trial.archive.manifestSha256 = '0'.repeat(64);
  await assert.rejects(reviewDurable(fixture.out, fixture.report), /public_archive_export_receipt_changed/);
  assert.equal(fs.existsSync(path.join(fixture.out, 'durable-review', 'verify-pass-1')), false);
});
