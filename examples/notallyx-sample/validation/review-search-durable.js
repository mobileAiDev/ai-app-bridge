'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMcpClient, payloadOf } = require('../../../desktop/ai-app-bridge-cli/scripts/validation/mcp-jsonrpc-client');
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function directoryHashes(directory) {
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else { assert(entry.isFile()); files.push({ path: path.relative(directory, file), sha256: hashFile(file) }); }
    }
  }
  walk(directory);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function reviewTrialRecords({ facts, events, trial, target, compiled, verifyChecksum, checksumOf }) {
  assert.equal(compiled.ok, true, 'script_compile_failed');
  assert(facts.length > 0, 'durable_records_missing');
  const records = facts.map(fact => fact.payload);
  assert.equal(new Set(records.map(record => record.evidenceId)).size, records.length, 'duplicate_evidence_id');
  const position = new Map();
  for (const [index, fact] of facts.entries()) {
    assert(Number.isSafeInteger(fact.globalSeq) && fact.globalSeq > 0
      && (index === 0 || fact.globalSeq > facts[index - 1].globalSeq), 'durable_sequence_invalid');
    const record = fact.payload;
    position.set(record, fact.globalSeq);
    assert.equal(record.operationId, trial.operationId); assert.equal(record.namespace, 'script');
    assert.equal(record.persisted, true, 'durable_record_not_persisted');
    assert.equal(verifyChecksum(record).ok, true, record.evidenceId);
  }
  for (const [index, event] of events.entries()) assert.equal(event.sequence, index + 1, 'execution_event_gap');
  assert.equal(events[0]?.type, 'script_started', 'start_event_missing');
  assert.equal(events.filter(event => event.type === 'script_started').length, 1, 'duplicate_start_event');
  const terminalTypes = { completed: 'script_completed', failed: 'script_failed', cancelled: 'script_cancelled' };
  const terminalEvent = events.at(-1);
  assert.equal(terminalEvent?.type, terminalTypes[trial.executionStatus], 'terminal_event_missing');
  assert.equal(events.filter(event => Object.values(terminalTypes).includes(event.type)).length, 1, 'duplicate_terminal_event');
  assert.equal(terminalEvent.persisted, true, 'terminal_event_not_persisted');

  const checkpoints = records.filter(record => record.kind === 'checkpoint');
  assert(checkpoints.length >= 2, 'start_and_terminal_checkpoints_required');
  const start = checkpoints[0], terminal = checkpoints.at(-1);
  assert.equal(records[0], start, 'start_checkpoint_not_first');
  assert.equal(records.at(-1), terminal, 'terminal_checkpoint_not_last');
  assert.equal(start.stepId, 'start'); assert.equal(start.actionSequence, 0);
  assert.equal(terminal.status, trial.executionStatus);
  assert.equal(terminalEvent.status, terminal.status); assert.equal(terminalEvent.error, terminal.error);
  const specFields = ['name', 'language', 'sourcePath', 'entrypoint', 'inputs', 'policy', 'permissions', 'target'];
  for (const [index, checkpoint] of checkpoints.entries()) {
    assert.equal(checkpoint.revision, index + 1, 'checkpoint_revision_gap');
    if (checkpoint !== terminal) assert.equal(checkpoint.status, 'running', 'nonterminal_checkpoint_status');
    assert.equal(checkpoint.hash, compiled.hash); assert.equal(checkpoint.hash, trial.scriptHash);
    for (const field of specFields) assert.deepEqual(checkpoint[field], compiled.spec[field], 'checkpoint_spec_mismatch:' + field);
    assert.deepEqual(checkpoint.target, target);
  }

  const expected = events.filter(event => event.type === 'call_started' && typeof event.actionId === 'string');
  const markers = records.filter(record => record.kind === 'dispatch-marker');
  const receipts = records.filter(record => record.kind === 'action-receipt');
  const receiptEvents = events.filter(event => event.type === 'action_receipt');
  assert.equal(markers.length, expected.length, 'prepared_action_count_mismatch');
  assert.equal(receipts.length, expected.length, 'action_receipt_count_mismatch');
  assert.equal(receiptEvents.length, expected.length, 'action_receipt_event_count_mismatch');
  for (const [index, event] of expected.entries()) {
    const actionSequence = index + 1, actionId = trial.operationId + ':action-' + actionSequence;
    assert.equal(event.actionId, actionId, 'event_action_sequence_mismatch');
    const marker = markers[index], matches = receipts.filter(record => record.actionId === actionId);
    assert.equal(marker.actionId, actionId, 'marker_action_order_mismatch');
    assert.equal(matches.length, 1, 'unique_action_receipt_required');
    const receipt = matches[0];
    assert.equal(marker.actionSequence, actionSequence, 'marker_action_sequence_mismatch');
    assert.equal(receipt.actionSequence, actionSequence, 'receipt_action_sequence_mismatch');
    assert(position.get(marker) < position.get(receipt), 'receipt_before_marker');
    const previous = checkpoints.findLast(checkpoint => position.get(checkpoint) < position.get(marker));
    assert.equal(marker.revision, previous.revision, 'marker_checkpoint_revision_mismatch');
    assert.equal(receipt.revision, marker.revision, 'receipt_checkpoint_revision_mismatch');
    assert.equal(marker.state, 'prepared'); assert.equal(marker.planStepId, actionId);
    assert.deepEqual(marker.target, target);
    assert.equal(marker.actionSpecHash, checksumOf({ command: event.command, args: event.args }));
    assert.equal(receipt.dispatched, true); assert.equal(receipt.ambiguous, false);
    assert.equal(receipt.mechanicalStatus, 'ok'); assert.equal(receipt.error, null);
    assert.equal(receipt.startedAtMs, marker.startedAtMs, 'receipt_start_time_mismatch');
    const observed = receiptEvents.filter(item => item.actionId === actionId);
    assert.equal(observed.length, 1, 'unique_action_receipt_event_required');
    assert(observed[0].sequence > event.sequence, 'receipt_event_before_action');
    for (const field of ['dispatched', 'ambiguous', 'mechanicalStatus', 'error']) {
      assert.equal(observed[0].payloadSummary[field], receipt[field], 'receipt_event_mismatch:' + field);
    }
    assert.deepEqual(observed[0].payloadSummary.args, event.args, 'receipt_event_args_mismatch');
    assert.deepEqual(observed[0].evidenceRefs || [], receipt.evidenceRefs, 'receipt_event_evidence_mismatch');
  }
  let checkpointActionSequence = 0;
  for (const checkpoint of checkpoints.slice(1)) {
    const priorMarkers = markers.filter(marker => position.get(marker) < position.get(checkpoint));
    assert.equal(checkpoint.actionSequence, priorMarkers.length, 'checkpoint_action_sequence_mismatch');
    for (const marker of priorMarkers) {
      const receipt = receipts.find(record => record.actionId === marker.actionId);
      assert(position.get(receipt) < position.get(checkpoint), 'checkpoint_precedes_action_receipt');
    }
    if (checkpoint !== terminal) {
      checkpointActionSequence = checkpoint.actionSequence;
      assert.equal(checkpoint.stepId, checkpoint.checkpoint?.name, 'checkpoint_step_mismatch');
    }
    assert.equal(checkpoint.checkpointActionSequence, checkpointActionSequence, 'checkpoint_boundary_mismatch');
  }
  assert.equal(terminal.actionSequence, expected.length, 'terminal_action_count_mismatch');
  return { actions: expected.length, terminalStatus: terminal.status };
}

// Run only after the controller's MCP process has exited. Each pass uses a new
// public MCP verifier with an unusable FactStore path; no private-store fallback.
async function reviewDurable(out, report) {
  const runtime = path.dirname(report.server);
  const { verifyChecksum, checksumOf } = require(path.join(runtime, 'shared-kernel/evidence-schema'));
  const { compileScriptSpec } = require(path.join(runtime, 'script/script-spec'));
  assert(report.trials.length > 0, 'durable_trials_missing');
  const review = path.join(out, 'durable-review');
  fs.mkdirSync(review);
  const blockedStore = path.join(review, 'fact-store-unavailable');
  const blockedContents = 'Public archive verification must not open a FactStore.\n';
  fs.writeFileSync(blockedStore, blockedContents, { flag: 'wx' });
  const before = new Map();
  for (const trial of report.trials) {
    const archive = trial.archive, directory = path.join(out, trial.name, 'durable-archive');
    assert.equal(archive?.ok, true, 'public_archive_export_receipt_missing');
    assert.equal(archive.archiveDir, directory, 'public_archive_directory_mismatch');
    assert.equal(archive.manifestPath, path.join(directory, 'manifest.json'), 'public_manifest_path_mismatch');
    assert.equal(archive.namespace, 'script'); assert.equal(archive.operationId, trial.operationId);
    assert.match(archive.manifestSha256 || '', /^[a-f0-9]{64}$/, 'frozen_manifest_hash_required');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, trial.name, 'archive-export.json'))), archive,
      'public_archive_export_receipt_changed');
    before.set(trial.name, directoryHashes(directory));
  }
  let first;
  for (let pass = 0; pass < 2; pass += 1) {
    const passDirectory = path.join(review, 'verify-pass-' + (pass + 1)); fs.mkdirSync(passDirectory);
    const client = createMcpClient({ serverPath: report.server,
      transcriptPath: path.join(passDirectory, 'mcp.jsonl'), stderrPath: path.join(passDirectory, 'mcp-stderr.log'),
      env: { AI_APP_BRIDGE_FACT_STORE_DIR: blockedStore } });
    const checked = [];
    try {
      await client.initialize();
      for (const trial of report.trials) {
        const archive = trial.archive;
        const verified = payloadOf(await client.request('tools/call', { name: 'run', arguments: { command: 'evidence',
          arguments: { operation: 'verify', archiveDir: archive.archiveDir, manifestSha256: archive.manifestSha256 } } }));
        fs.writeFileSync(path.join(passDirectory, trial.name + '.json'), JSON.stringify(verified, null, 2) + '\n');
        assert.equal(verified.ok, true, 'public_evidence_verify_failed:' + JSON.stringify(verified));
        assert.equal(verified.integrity, 'verified');
        const { integrity, ...verifiedReceipt } = verified;
        assert.deepEqual(verifiedReceipt, archive, 'public_archive_identity_changed');
        assert.deepEqual(directoryHashes(archive.archiveDir), before.get(trial.name), 'archive_changed_during_verify');
        // Bind the actual bytes consumed by the independent action review to
        // the same frozen public manifest, including the gap after MCP verify.
        const manifestBytes = fs.readFileSync(archive.manifestPath);
        assert.equal(crypto.createHash('sha256').update(manifestBytes).digest('hex'), archive.manifestSha256);
        const manifest = JSON.parse(manifestBytes);
        assert.equal(manifest.records.path, 'records.json');
        const recordsBytes = fs.readFileSync(path.join(archive.archiveDir, 'records.json'));
        assert.equal(recordsBytes.length, manifest.records.bytes);
        assert.equal(crypto.createHash('sha256').update(recordsBytes).digest('hex'), manifest.records.sha256);
        const records = JSON.parse(recordsBytes);
        const events = JSON.parse(fs.readFileSync(path.join(out, trial.name, 'events.json')));
        const spec = JSON.parse(fs.readFileSync(path.join(out, trial.name, 'spec.json'))), compiled = compileScriptSpec(spec);
        const verdict = reviewTrialRecords({ facts: records, events, trial, target: report.target, compiled, verifyChecksum, checksumOf });
        checked.push({ trial: trial.name, records, manifestSha256: archive.manifestSha256, ...verdict });
        if (pass === 0) fs.writeFileSync(path.join(review, trial.name + '.json'), JSON.stringify(records, null, 2) + '\n');
      }
    } finally {
      const exit = await client.close();
      fs.writeFileSync(path.join(passDirectory, 'host-exit.json'), JSON.stringify(exit, null, 2) + '\n');
      assert.deepEqual(exit, { code: 0, signal: null }, 'public_verifier_exit_failed');
    }
    if (pass === 0) first = checked;
    else assert.deepEqual(checked, first, 'evidence_changed_between_public_verifiers');
  }
  for (const trial of report.trials) {
    assert.deepEqual(directoryHashes(trial.archive.archiveDir), before.get(trial.name), 'archive_changed_during_review');
  }
  assert.equal(fs.readFileSync(blockedStore, 'utf8'), blockedContents, 'offline_store_guard_changed');
  const result = { ok: true, method: 'public-evidence-export-verify', freshVerifierProcesses: 2, archivesUnchanged: true,
    offlineFactStoreUnavailable: true,
    records: first.reduce((sum, item) => sum + item.records.length, 0), actions: first.reduce((sum, item) => sum + item.actions, 0),
    operations: first.map(({ records, ...item }) => ({ ...item, recordCount: records.length })) };
  fs.writeFileSync(path.join(review, 'report.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

module.exports = { reviewDurable, reviewTrialRecords, directoryHashes };
