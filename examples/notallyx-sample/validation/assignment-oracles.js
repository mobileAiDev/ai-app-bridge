'use strict';

const { isDeepStrictEqual } = require('node:util');
const { canonical } = require('./oracles');
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

// The host supplies exact expected arrays for selected IDs. Every other field is compared.
// Batch assignment does not edit modifiedTimestamp; the single-note editor does.
function checkLabelAssignment({ id, before, after, expectedLabelsById, editorSave = false }) {
  const source = 'independent-host-business-oracle';
  try {
    const original = canonical(before), actual = canonical(after);
    requireThat(before.snapshotId !== after.snapshotId && after.capturedAtMs > before.capturedAtMs
      && after.capturedAfterSequence > before.capturedAfterSequence, 'fresh_assignment_snapshot_required');
    requireThat(before.runId === after.runId && isDeepStrictEqual(before.target, after.target)
      && isDeepStrictEqual(before.identity, after.identity), 'assignment_identity_mismatch');
    requireThat(typeof id === 'string' && id && expectedLabelsById && typeof expectedLabelsById === 'object'
      && !Array.isArray(expectedLabelsById) && Object.keys(expectedLabelsById).length > 0, 'exact_assignment_expectation_required');
    requireThat(typeof editorSave === 'boolean' && (!editorSave || Object.keys(expectedLabelsById).length === 1), 'single_editor_save_required');
    const expected = structuredClone(original), differences = [];
    for (const [key, labels] of Object.entries(expectedLabelsById)) {
      requireThat(/^[1-9]\d*$/.test(key) && Number.isSafeInteger(Number(key)), 'exact_note_id_required');
      requireThat(Array.isArray(labels) && labels.every(value => typeof value === 'string' && value
        && original.labels.some(label => label.value === value)) && new Set(labels).size === labels.length, 'existing_distinct_labels_required');
      const note = expected.notes.find(note => note.id === Number(key));
      requireThat(note, 'selected_note_missing');
      note.labels = [...labels];
      if (editorSave) {
        const saved = actual.notes.find(candidate => candidate.id === note.id);
        requireThat(saved && Number.isSafeInteger(saved.modifiedTimestamp) && saved.modifiedTimestamp >= note.modifiedTimestamp
          && saved.modifiedTimestamp <= after.capturedAtMs, 'editor_modified_timestamp_invalid');
        note.modifiedTimestamp = saved.modifiedTimestamp;
      }
    }
    for (const field of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (!isDeepStrictEqual(expected[field], actual[field])) differences.push({ field, expected: expected[field], actual: actual[field] });
    }
    return { id, source, verdict: differences.length ? 'failed' : 'passed', ok: !differences.length,
      beforeSnapshotId: before.snapshotId, afterSnapshotId: after.snapshotId,
      expectedLabelsById: structuredClone(expectedLabelsById), editorSave, differences };
  } catch (error) { return { id, source, verdict: 'inconclusive', ok: false, reason: error.message }; }
}

module.exports = { checkLabelAssignment };
