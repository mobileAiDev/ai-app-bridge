'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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

// Run only after the controller's MCP process has exited. Read a verified copy.
async function reviewDurable(out, report) {
  const runtime = path.dirname(report.server);
  const { createFactStore } = require(path.join(runtime, 'fact-store'));
  const { verifyChecksum, checksumOf } = require(path.join(runtime, 'shared-kernel/evidence-schema'));
  const { compileScriptSpec } = require(path.join(runtime, 'script/script-spec'));
  const original = path.join(out, 'host-facts'), review = path.join(out, 'durable-review');
  fs.mkdirSync(review);
  const before = directoryHashes(original), copy = path.join(review, 'facts-copy');
  fs.cpSync(original, copy, { recursive: true });
  assert.deepEqual(directoryHashes(copy), before);
  let first;
  for (let pass = 0; pass < 2; pass += 1) {
    const store = createFactStore({ directory: copy }), checked = [];
    try {
      for (const trial of report.trials) {
        const records = []; let cursor;
        do {
          const page = store.read({ targetKey: 'evidence:script:' + trial.operationId, limit: 1000, ...(cursor ? { cursor } : {}) });
          assert.equal(page.ok, true, JSON.stringify(page));
          records.push(...page.items.map(({ globalSeq, payload }) => ({ globalSeq, payload })));
          if (!page.hasMore) break;
          assert(page.cursor); assert.notEqual(page.cursor, cursor); cursor = page.cursor;
        } while (true);
        const events = JSON.parse(fs.readFileSync(path.join(out, trial.name, 'events.json')));
        const spec = JSON.parse(fs.readFileSync(path.join(out, trial.name, 'spec.json'))), compiled = compileScriptSpec(spec);
        const verdict = reviewTrialRecords({ facts: records, events, trial, target: report.target, compiled, verifyChecksum, checksumOf });
        checked.push({ trial: trial.name, records, ...verdict });
        if (pass === 0) fs.writeFileSync(path.join(review, trial.name + '.json'), JSON.stringify(records, null, 2) + '\n');
      }
    } finally { await store.close(); }
    if (pass === 0) first = checked;
    else assert.deepEqual(checked, first, 'evidence_changed_after_reopen');
  }
  assert.deepEqual(directoryHashes(original), before, 'original_store_changed_during_review');
  const result = { ok: true, reopenPasses: 2, originalUnchanged: true,
    records: first.reduce((sum, item) => sum + item.records.length, 0), actions: first.reduce((sum, item) => sum + item.actions, 0),
    operations: first.map(({ records, ...item }) => ({ ...item, recordCount: records.length })) };
  fs.writeFileSync(path.join(review, 'report.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

module.exports = { reviewDurable, reviewTrialRecords, directoryHashes };
