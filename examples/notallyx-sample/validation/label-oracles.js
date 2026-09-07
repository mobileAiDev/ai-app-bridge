'use strict';

const { isDeepStrictEqual } = require('node:util');
const { canonical } = require('./oracles');

const SOURCE = 'independent-host-business-oracle';
const HIDDEN = 'labelsHiddenInNavigation';
const requireThat = (condition, reason) => { if (!condition) throw new Error(reason); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
// SQLite BINARY text ordering and Python's sorted strings agree on valid Unicode code points.
const textOrder = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const metadata = snapshot => ({ snapshotId: snapshot.snapshotId, runId: snapshot.runId, identity: snapshot.identity,
  capturedAfterSequence: snapshot.capturedAfterSequence, capturedAtMs: snapshot.capturedAtMs });

function validateBusinessData(data) {
  requireThat(data.labels.every(label => nonempty(label.value) && Number.isSafeInteger(label.order)), 'invalid_label_rows');
  requireThat(new Set(data.labels.map(label => label.value)).size === data.labels.length, 'duplicate_label_rows');
  if (Object.hasOwn(data.preferences, HIDDEN)) {
    const hidden = data.preferences[HIDDEN];
    requireThat(Array.isArray(hidden) && hidden.every(value => typeof value === 'string')
      && new Set(hidden).size === hidden.length, 'invalid_hidden_labels_preference');
  }
  requireThat(!Object.hasOwn(data.preferences, 'startView') || typeof data.preferences.startView === 'string', 'invalid_start_view_preference');
  for (const note of data.notes) {
    const refs = [...note.images.map(file => ['Images', file.localName]), ...note.files.map(file => ['Files', file.localName]),
      ...note.audios.map(file => ['Audios', file.name])];
    for (const [kind, name] of refs) requireThat(data.attachments.some(file => file.kind === kind && file.name === name), 'label_attachment_evidence_missing');
  }
}

/** Compares only reader-verified snapshots. The caller binds each read to the actual phase's last action.
 * Delete requires no remaining exact references, including duplicates in imported arrays. The current
 * App's List.minus(value) removes only the first duplicate; this oracle must detect that partial deletion.
 */
function checkLabelTransition({ id, before, after, transition } = {}) {
  try {
    requireThat(nonempty(id), 'oracle_id_required');
    // canonical enforces the private WeakSet; caller-provided JSON cannot become evidence here.
    const original = canonical(before);
    const actual = canonical(after);
    requireThat(before.snapshotId !== after.snapshotId && after.capturedAtMs > before.capturedAtMs
      && after.capturedAfterSequence > before.capturedAfterSequence, 'fresh_after_snapshot_required');
    requireThat(nonempty(before.runId) && before.runId === after.runId, 'label_transition_run_mismatch');
    requireThat(isDeepStrictEqual(before.target, after.target), 'label_transition_target_mismatch');
    requireThat(isDeepStrictEqual(before.identity, after.identity), 'label_transition_identity_mismatch');
    validateBusinessData(original);
    validateBusinessData(actual);
    requireThat(transition && typeof transition === 'object' && !Array.isArray(transition), 'label_transition_required');
    const keys = { prepare: ['type', 'noteIds', 'labelA', 'labelAb'], rename: ['type', 'old', 'new'], delete: ['type', 'value'] }[transition.type];
    requireThat(keys && isDeepStrictEqual(Object.keys(transition).sort(), [...keys].sort()), 'invalid_label_transition');

    const expected = structuredClone(original);
    const differences = [];
    const labelExists = value => original.labels.some(label => label.value === value);
    if (transition.type === 'prepare') {
      const { noteIds, labelA, labelAb } = transition;
      requireThat(Array.isArray(noteIds) && noteIds.length === 2 && noteIds.every(id => Number.isSafeInteger(id) && id > 0)
        && noteIds[0] !== noteIds[1], 'prepare_note_ids_required');
      requireThat(nonempty(labelA) && nonempty(labelAb) && labelA !== labelAb, 'prepare_distinct_labels_required');
      requireThat(!labelExists(labelA) && !labelExists(labelAb), 'prepare_labels_already_exist');
      requireThat(!original.notes.some(note => note.labels.includes(labelA) || note.labels.includes(labelAb)), 'prepare_dangling_label_reference');
      const selected = noteIds.map(id => expected.notes.find(note => note.id === id));
      requireThat(selected[0]?.type === 'NOTE' && selected[1]?.type === 'LIST', 'prepare_text_and_list_required');
      const maxOrder = original.labels.length ? original.labels.reduce((max, label) => Math.max(max, label.order), original.labels[0].order) : -1;
      requireThat(Number.isSafeInteger(maxOrder + 2), 'label_order_overflow');
      expected.labels.push({ value: labelA, order: maxOrder + 1 }, { value: labelAb, order: maxOrder + 2 });
      selected.forEach((note, index) => {
        note.labels.push(index === 0 ? labelA : labelAb);
        const saved = actual.notes.find(candidate => candidate.id === note.id);
        if (saved) {
          if (saved.modifiedTimestamp < note.modifiedTimestamp) differences.push({ field: `notes[${note.id}].modifiedTimestamp`,
            reason: 'modified_timestamp_decreased', minimum: note.modifiedTimestamp, actual: saved.modifiedTimestamp });
          // Only this explicitly permitted field is taken from after, after checking monotonicity.
          note.modifiedTimestamp = saved.modifiedTimestamp;
        }
      });
    } else {
      const value = transition.type === 'rename' ? transition.old : transition.value;
      requireThat(nonempty(value) && labelExists(value), 'transition_label_missing');
      if (transition.type === 'rename') {
        requireThat(nonempty(transition.new) && transition.new !== value, 'rename_new_label_required');
        requireThat(!labelExists(transition.new), 'rename_label_conflict');
        expected.labels = expected.labels.map(label => label.value === value ? { ...label, value: transition.new } : label);
        expected.notes.forEach(note => { note.labels = note.labels.map(label => label === value ? transition.new : label); });
        const hidden = expected.preferences[HIDDEN];
        if (hidden?.includes(value)) expected.preferences[HIDDEN] = [...new Set([...hidden.filter(label => label !== value), transition.new])].sort(textOrder);
        if (expected.preferences.startView === value) expected.preferences.startView = transition.new;
      } else {
        expected.labels = expected.labels.filter(label => label.value !== value);
        expected.notes.forEach(note => { note.labels = note.labels.filter(label => label !== value); });
        // deleteLabel always saves this preference, including absent -> explicit empty set.
        expected.preferences[HIDDEN] = (expected.preferences[HIDDEN] || []).filter(label => label !== value).sort(textOrder);
        if (expected.preferences.startView === value) expected.preferences.startView = '';
      }
    }
    expected.labels.sort((a, b) => textOrder(a.value, b.value));
    for (const field of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (!isDeepStrictEqual(expected[field], actual[field])) differences.push({ field, expected: expected[field], actual: actual[field] });
    }
    const verdict = differences.length ? 'failed' : 'passed';
    return { id, verdict, ok: verdict === 'passed', source: SOURCE, transition: structuredClone(transition),
      before: metadata(before), after: metadata(after), differences };
  } catch (error) {
    return { id, verdict: 'inconclusive', ok: false, source: SOURCE, reason: error.message };
  }
}

module.exports = { checkLabelTransition };
