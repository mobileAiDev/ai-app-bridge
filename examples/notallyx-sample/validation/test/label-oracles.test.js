'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { collectSnapshot, PACKAGE } = require('../collector');
const { readSnapshot, compareCanonical } = require('../oracles');
const { checkLabelTransition } = require('../label-oracles');
const { checkLabelAssignment } = require('../assignment-oracles');

// Fixtures traverse the real collector/SQLite/WAL reader; only its device command port is simulated.
const CREATE = String.raw`
import json,pathlib,sqlite3,shutil,sys
s=json.load(sys.stdin);d=pathlib.Path(s['dir']);db=d/'live.sqlite'
c=sqlite3.connect(db);c.execute('PRAGMA journal_mode=WAL')
schema=json.load(open(s['schemaPath']))['database']
for e in schema['entities']:c.execute(e['createSql'].replace(chr(36)+'{TABLE_NAME}',e['tableName']))
for q in schema['setupQueries']:c.execute(q)
c.execute('PRAGMA user_version=11');c.commit();c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
for note in s['data']['notes']:
 n=dict(note)
 for k in ['labels','spans','items','images','files','audios','reminders']:n[k]=json.dumps(n[k],ensure_ascii=False)
 c.execute('INSERT INTO BaseNote ('+','.join('"'+k+'"' for k in n)+') VALUES ('+','.join('?' for k in n)+')',list(n.values()))
for label in s['data']['labels']:c.execute('INSERT INTO Label(value,"order") VALUES (?,?)',(label['value'],label['order']))
c.commit()
for suffix in ['','-wal','-shm']:
 f=pathlib.Path(str(db)+suffix)
 if f.exists():shutil.copyfile(f,d/('NotallyDatabase'+suffix))
c.close()
`;
const A = 'AAB-label-a', AB = 'AAB-label-ab', NEW = 'AAB-renamed';
const clone = value => structuredClone(value);
const note = (id, extra = {}) => ({ id, type: 'NOTE', folder: 'NOTES', color: '#123456', title: `note-${id}`, pinned: true,
  timestamp: 100, modifiedTimestamp: 200, labels: [], body: 'Literal AAB-label-a / AAB-label-ab in body is unchanged',
  spans: [], items: [], images: [], files: [], audios: [], reminders: [], viewMode: 'EDIT', isPinnedToStatus: false, ...extra });
const ATTACHMENTS = [{ kind: 'Files', name: 'one.txt', body: 'unchanged file bytes' }, { kind: 'Images', name: 'photo.jpg', body: 'image bytes' },
  { kind: 'Audios', name: 'audio.m4a', body: 'audio bytes' }];
function original() {
  return { notes: [
    note(11, { labels: ['Project'], files: [{ localName: 'one.txt', originalName: 'original.txt', mimeType: 'text/plain' }] }),
    note(12, { type: 'LIST', items: [{ body: 'Parent A', checked: true, isChild: false, order: 0, checkedTimestamp: 180 },
      { body: 'Child', checked: false, isChild: true, order: 1 }] }),
    note(13, { folder: 'ARCHIVED', labels: ['Project', 'Else'], images: [{ localName: 'photo.jpg', originalName: 'camera.jpg', mimeType: 'image/jpeg' }] }),
    note(14, { folder: 'DELETED', labels: ['Else'], audios: [{ name: 'audio.m4a', timestamp: 140 }],
      reminders: [{ id: 1, dateTime: 500, isNotificationVisible: false }] }),
  ], labels: [{ value: 'Project', order: 4 }, { value: 'Else', order: 9 }], preferences: { dataSchemaId: 2, theme: 'DARK' } };
}
function prepared() {
  const data = original();
  data.labels.push({ value: A, order: 10 }, { value: AB, order: 11 });
  data.notes[0].labels = ['Project', A]; data.notes[1].labels = [AB];
  data.notes[0].modifiedTimestamp = 300; data.notes[1].modifiedTimestamp = 310;
  return data;
}
function assigned() {
  const data = prepared();
  [data.notes[0].labels, data.notes[1].labels, data.notes[2].labels, data.notes[3].labels] = [['Project', A, AB], [AB, A], [A, 'Else'], [AB, A]];
  data.preferences.labelsHiddenInNavigation = ['Else', A]; data.preferences.startView = A;
  return data;
}
function renamed() {
  const data = assigned(); data.labels.find(label => label.value === A).value = NEW;
  [data.notes[0].labels, data.notes[1].labels, data.notes[2].labels, data.notes[3].labels] = [['Project', NEW, AB], [AB, NEW], [NEW, 'Else'], [AB, NEW]];
  data.preferences.labelsHiddenInNavigation = ['Else', NEW]; data.preferences.startView = NEW;
  return data;
}
function deleted() {
  const data = assigned(); data.labels = data.labels.filter(label => label.value !== A);
  [data.notes[0].labels, data.notes[1].labels, data.notes[2].labels, data.notes[3].labels] = [['Project', AB], [AB], ['Else'], [AB]];
  data.preferences.labelsHiddenInNavigation = ['Else']; data.preferences.startView = '';
  return data;
}
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function prefsXml(preferences) {
  return `<map>${Object.entries(preferences).map(([key, value]) => {
    const name = xml(key);
    if (Array.isArray(value)) return `<set name="${name}">${value.map(item => `<string>${xml(item)}</string>`).join('')}</set>`;
    if (typeof value === 'boolean') return `<boolean name="${name}" value="${value}"/>`;
    if (typeof value === 'number') return `<long name="${name}" value="${value}"/>`;
    return `<string name="${name}">${xml(value)}</string>`;
  }).join('')}</map>`;
}
function fixture(t, data, { start = 1000, sequence = 1, runId = 'labels-run', serial = 'offline-labels', apkSha256 = 'a'.repeat(64), attach = ATTACHMENTS } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notallyx-label-oracle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const create = spawnSync('python3', ['-c', CREATE], { input: JSON.stringify({ dir, data,
    schemaPath: path.resolve(__dirname, '../../app/schemas/com.philkes.notallyx.data.NotallyDatabase/11.json') }), encoding: 'utf8' });
  assert.equal(create.status, 0, create.stderr);
  const remote = new Map();
  for (const suffix of ['', '-wal', '-shm']) { const file = path.join(dir, `NotallyDatabase${suffix}`); if (fs.existsSync(file)) remote.set(`databases/NotallyDatabase${suffix}`, fs.readFileSync(file)); }
  remote.set(`shared_prefs/${PACKAGE}_preferences.xml`, Buffer.from(prefsXml(data.preferences)));
  for (const file of attach) remote.set(`files/attachments/${file.kind}/${file.name}`, Buffer.from(file.body));
  let clock = start;
  const runCommand = (_program, argv) => {
    const a = argv.slice(2);
    if (a[0] === 'shell') return { status: a[1] === 'pidof' ? 1 : 0, stdout: '', stderr: '' };
    const cmd = a[3], arg = a[4];
    if (cmd === 'test') { const present = arg === '-f' ? remote.has(a[5]) : [...remote.keys()].some(file => file.startsWith(`${a[5]}/`)); return { status: present ? 0 : 1, stdout: '', stderr: '' }; }
    if (cmd === 'cat') return { status: 0, stdout: remote.get(arg), stderr: '' };
    if (cmd === 'find') return { status: 0, stdout: Buffer.from([...remote.keys()].filter(file => file.startsWith(`${arg}/`)).join('\0') + '\0'), stderr: '' };
    throw new Error(`Unexpected simulated command ${argv}`);
  };
  const manifest = collectSnapshot({ serial, packageName: PACKAGE, out: path.join(dir, 'evidence'), runId, sequence, apkSha256 }, { runCommand, now: () => ++clock });
  const snapshot = readSnapshot(manifest, { expectedTarget: manifest.target, expectedApkSha256: apkSha256, runId, afterSequence: sequence, minCapturedAtMs: start });
  assert.equal(snapshot.ok, true, snapshot.reason);
  return snapshot;
}
const after = (t, data, options) => fixture(t, data, { start: 10000, sequence: 2, ...options });

test('assignment checks exact selected arrays and every other field from real SQLite and files', t => {
  const before = fixture(t, prepared()), expected = prepared();
  expected.notes[0].labels = ['Project', AB]; expected.notes[1].labels = [AB];
  const spec = { id: 'batch', before, expectedLabelsById: { 11: ['Project', AB], 12: [AB] } };
  assert.equal(checkLabelAssignment({ ...spec, after: after(t, expected) }).verdict, 'passed');
  for (const mutate of [
    data => { data.notes[0].labels = [AB]; }, // dropped PARTIAL label
    data => { data.notes[0].labels = ['Project', A, AB]; }, // failed exact removal
    data => { data.notes[2].labels = [AB]; }, // unselected row
    data => { data.notes[1].modifiedTimestamp++; },
    data => { data.notes[1].body = 'changed'; },
    data => { data.notes[1].items[0] = { body: 'changed', checked: false, isChild: false, order: 0 }; },
    data => { data.preferences.theme = 'LIGHT'; },
    data => { data.labels.pop(); },
  ]) {
    const damaged = clone(expected); mutate(damaged);
    assert.equal(checkLabelAssignment({ ...spec, after: after(t, damaged) }).verdict, 'failed');
  }
  assert.equal(checkLabelAssignment({ ...spec, after: after(t, expected, { attach: ATTACHMENTS.map(file => ({ ...file, body: 'changed bytes' })) }) }).verdict, 'failed');
});

test('single editor removal permits only a bounded monotonic modified timestamp', t => {
  const before = fixture(t, prepared()), expected = prepared();
  expected.notes[1].labels = []; expected.notes[1].modifiedTimestamp = 500;
  const spec = { id: 'single', before, expectedLabelsById: { 12: [] }, editorSave: true };
  assert.equal(checkLabelAssignment({ ...spec, after: after(t, expected) }).verdict, 'passed');
  for (const time of [0, 999999]) {
    expected.notes[1].modifiedTimestamp = time;
    assert.equal(checkLabelAssignment({ ...spec, after: after(t, expected) }).verdict, 'inconclusive');
  }
});

test('assignment rejects unverified, stale, wrong-target and unbounded caller expectations', t => {
  const before = fixture(t, prepared()), good = after(t, prepared());
  const spec = { id: 'invalid', before, after: good, expectedLabelsById: { 11: ['Project', A] } };
  for (const change of [
    { before: clone(before) }, { after: before }, { after: after(t, prepared(), { serial: 'other' }) },
    { after: after(t, prepared(), { apkSha256: 'b'.repeat(64) }) }, { expectedLabelsById: {} },
    { expectedLabelsById: { 11: ['absent-label'] } }, { expectedLabelsById: { 11: [A, A] } },
    { expectedLabelsById: { 999: [A] } }, { expectedLabelsById: { 11: [A], 12: [AB] }, editorSave: true },
  ]) assert.equal(checkLabelAssignment({ ...spec, ...change }).verdict, 'inconclusive');
});
const check = (before, after, transition) => checkLabelTransition({ id: 'labels-contract', before, after, transition });
const PREPARE = { type: 'prepare', noteIds: [11, 12], labelA: A, labelAb: AB };
const RENAME = { type: 'rename', old: A, new: NEW };
const DELETE = { type: 'delete', value: A };

test('prepare creates A then Ab and assigns one exact label to each selected NOTE/LIST; every other value is retained', t => {
  const before = fixture(t, original()); const saved = after(t, prepared());
  const result = check(before, saved, PREPARE);
  assert.equal(result.verdict, 'passed', JSON.stringify(result)); assert.equal(result.source, 'independent-host-business-oracle');
  assert.equal(result.before.snapshotId, before.snapshotId); assert.equal(result.after.snapshotId, saved.snapshotId);
  const equalTimestamp = prepared(); equalTimestamp.notes[0].modifiedTimestamp = 200; equalTimestamp.notes[1].modifiedTimestamp = 200;
  assert.equal(check(before, after(t, equalTimestamp), PREPARE).verdict, 'passed', 'Nondecreasing, not necessarily strictly increasing, timestamps');
});

test('prepare rejects partial save, stale timestamp, wrong note, extra label, wrong order and unrelated side effects', t => {
  const before = fixture(t, original());
  const mutations = [
    data => { data.notes[1].labels = []; },
    data => { data.notes[0].modifiedTimestamp = 199; },
    data => { data.notes[2].modifiedTimestamp += 1; },
    data => { data.notes[2].labels.push(A); },
    data => { data.notes[0].labels = [A, 'Project']; },
    data => { data.notes[1].labels = [A, AB]; },
    data => { data.labels.find(label => label.value === AB).order = 10; },
    data => { data.notes[0].body = 'lost body'; },
    data => { data.notes.pop(); },
    data => { data.preferences.startView = A; },
  ];
  for (const mutate of mutations) { const data = prepared(); mutate(data); assert.equal(check(before, after(t, data), PREPARE).verdict, 'failed'); }
});

test('rename replaces exact references in all folders, preserves Ab/order/timestamps/attachments and updates matching preferences', t => {
  const result = check(fixture(t, assigned()), after(t, renamed()), RENAME);
  assert.equal(result.verdict, 'passed', JSON.stringify(result));
});

test('rename cannot pass missing archived/deleted references, substring replacement, timestamp/order or preference corruption', t => {
  const before = fixture(t, assigned());
  for (const mutate of [
    data => { data.notes[2].labels = [A, 'Else']; },
    data => { data.notes[3].labels = [AB, A]; },
    data => { data.notes[1].labels[0] = `${NEW}b`; },
    data => { data.notes[0].modifiedTimestamp += 1; },
    data => { data.labels.find(label => label.value === NEW).order += 1; },
    data => { data.preferences.startView = A; },
    data => { data.preferences.labelsHiddenInNavigation = ['Else', A]; },
    data => { data.notes[0].body = data.notes[0].body.replace(A, NEW); },
  ]) { const data = renamed(); mutate(data); assert.equal(check(before, after(t, data), RENAME).verdict, 'failed'); }
});

test('rename does not invent absent preferences or alter nonmatching hidden/startView values', t => {
  for (const preferences of [{ dataSchemaId: 2 }, { labelsHiddenInNavigation: [AB], startView: AB }]) {
    const before = assigned(), saved = renamed(); before.preferences = clone(preferences); saved.preferences = clone(preferences);
    assert.equal(check(fixture(t, before), after(t, saved), RENAME).verdict, 'passed');
    saved.preferences.labelsHiddenInNavigation = [];
    assert.equal(check(fixture(t, before), after(t, saved), RENAME).verdict, 'failed');
  }
});

test('delete removes only the exact label across every folder and resets matching hidden/startView without changing timestamps', t => {
  assert.equal(check(fixture(t, assigned()), after(t, deleted()), DELETE).verdict, 'passed');
  const before = assigned(), saved = deleted(); before.preferences = { dataSchemaId: 2 }; saved.preferences = { dataSchemaId: 2, labelsHiddenInNavigation: [] };
  assert.equal(check(fixture(t, before), after(t, saved), DELETE).verdict, 'passed', 'Absent hidden key must become persisted empty set');
  delete saved.preferences.labelsHiddenInNavigation;
  assert.equal(check(fixture(t, before), after(t, saved), DELETE).verdict, 'failed', 'Missing persisted default cannot pass');
});

test('delete rejects substring deletion, lost note, missed reference, changed timestamp and unexpected preference changes', t => {
  const before = fixture(t, assigned());
  for (const mutate of [
    data => { data.notes[0].labels = ['Project']; },
    data => { data.labels = data.labels.filter(label => label.value !== AB); },
    data => { data.notes.pop(); },
    data => { data.notes[2].labels.push(A); },
    data => { data.notes[3].modifiedTimestamp += 1; },
    data => { data.preferences.startView = A; },
    data => { data.preferences.theme = 'LIGHT'; },
  ]) { const data = deleted(); mutate(data); assert.equal(check(before, after(t, data), DELETE).verdict, 'failed'); }
});

test('delete detects the inherited minus-first behavior when an imported note contains duplicate references', t => {
  const input = assigned(); input.notes[0].labels = ['Project', A, A, AB];
  const before = fixture(t, input);
  const minusFirst = deleted(); minusFirst.notes[0].labels = ['Project', A, AB];
  assert.equal(check(before, after(t, minusFirst), DELETE).verdict, 'failed', 'A deleted Label must not leave a dangling second exact reference');
  assert.equal(check(before, after(t, deleted()), DELETE).verdict, 'passed', 'The business requirement removes every exact occurrence and preserves Ab');
});

test('missing/caller-copied snapshots and stale time or sequence cannot count as evidence', t => {
  const before = fixture(t, assigned()); const saved = after(t, renamed());
  for (const [a, b] of [[null, saved], [before, null], [clone(before), saved], [before, clone(saved)], [before, before]]) {
    assert.equal(check(a, b, RENAME).verdict, 'inconclusive');
  }
  for (const options of [{ start: 1000 }, { start: 500 }, { sequence: 1 }, { sequence: 0 }]) {
    assert.equal(check(before, after(t, renamed(), options), RENAME).reason, 'fresh_after_snapshot_required');
  }
});

test('different run, target or APK cannot be reused for this in-run label transition', t => {
  const before = fixture(t, assigned());
  for (const [options, reason] of [[{ runId: 'old-run' }, 'label_transition_run_mismatch'], [{ serial: 'other-device' }, 'label_transition_target_mismatch'],
    [{ apkSha256: 'b'.repeat(64) }, 'label_transition_identity_mismatch']]) {
    assert.equal(check(before, after(t, renamed(), options), RENAME).reason, reason);
  }
});

test('missing targets, conflicts, same-name rename and invalid or ignored transition fields never pass', t => {
  const before = fixture(t, assigned()), saved = after(t, assigned());
  for (const transition of [null, {}, { type: 'cancel' }, { ...RENAME, unexpected: true }, { ...RENAME, old: 'missing' }, { ...RENAME, new: AB },
    { ...RENAME, new: A }, { ...DELETE, value: 'missing' }, PREPARE]) assert.equal(check(before, saved, transition).verdict, 'inconclusive');
  const clean = fixture(t, original()), ready = after(t, prepared());
  for (const transition of [{ ...PREPARE, noteIds: [11, 11] }, { ...PREPARE, noteIds: [12, 11] }, { ...PREPARE, noteIds: [11, 999] },
    { ...PREPARE, labelAb: A }, { ...PREPARE, labelA: '' }]) assert.equal(check(clean, ready, transition).verdict, 'inconclusive');
});

test('unchanged data cannot prove rename/delete; a cancelled action that mutated data fails the independent no-change oracle', t => {
  const before = fixture(t, assigned()), unchanged = after(t, assigned()), mutated = after(t, renamed());
  assert.equal(check(before, unchanged, RENAME).verdict, 'failed');
  assert.equal(check(before, unchanged, DELETE).verdict, 'failed');
  assert.equal(compareCanonical(before, mutated, { id: 'rename-cancelled' }).verdict, 'failed');
});

test('attachment references require actual file evidence and all original byte hashes must remain', t => {
  const before = fixture(t, assigned());
  assert.equal(check(before, after(t, renamed(), { attach: [] }), RENAME).reason, 'label_attachment_evidence_missing');
  assert.equal(check(fixture(t, assigned(), { attach: [] }), after(t, renamed()), RENAME).reason, 'label_attachment_evidence_missing');
  const changedFiles = clone(ATTACHMENTS); changedFiles[0].body = 'unexpectedly changed attachment bytes';
  assert.equal(check(before, after(t, renamed(), { attach: changedFiles }), RENAME).verdict, 'failed');
});
