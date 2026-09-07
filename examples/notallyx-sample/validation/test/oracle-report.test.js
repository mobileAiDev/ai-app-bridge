'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { collectSnapshot, PACKAGE } = require('../collector');
const { readSnapshot, checkSnapshot, compareCanonical, hashFile } = require('../oracles');
const { buildReport, writeReport } = require('../report');

const CREATE = String.raw`
import json,pathlib,sqlite3,shutil,sys
s=json.load(sys.stdin); d=pathlib.Path(s['dir']); db=d/'live.sqlite'
c=sqlite3.connect(db); c.execute('PRAGMA journal_mode=WAL')
schema=json.load(open(s['schemaPath']))['database']
for e in schema['entities']: c.execute(e['createSql'].replace(chr(36)+'{TABLE_NAME}',e['tableName']))
for q in schema['setupQueries']: c.execute(q)
c.execute('PRAGMA user_version=11');c.commit();c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
for note in s['notes']:
 n=dict(note)
 for k in ['labels','spans','items','images','files','audios','reminders']: n[k]=json.dumps(n[k],ensure_ascii=False)
 c.execute('INSERT INTO BaseNote ('+','.join('"'+k+'"' for k in n)+') VALUES ('+','.join('?' for k in n)+')',list(n.values()))
for label in s['labels']: c.execute('INSERT INTO Label(value,"order") VALUES (?,?)',(label['value'],label['order']))
c.commit()
for suffix in ['', '-wal','-shm']:
 f=pathlib.Path(str(db)+suffix)
 if f.exists(): shutil.copyfile(f,d/('NotallyDatabase'+suffix))
c.close()
`;
function baseNote(extra = {}) { return { id: 1, type: 'NOTE', folder: 'NOTES', color: 'DEFAULT', title: 'AAB unique', pinned: false, timestamp: 100, modifiedTimestamp: 200,
  labels: ['Project'], body: '原始正文', spans: [], items: [], images: [], files: [], audios: [], reminders: [], viewMode: 'EDIT', isPinnedToStatus: false, ...extra }; }
function fixture(t, { note = baseNote(), labels = [{ value: 'Project', order: 0 }], start = 1000, runId = 'run-1', sequence = 5, attach = [], publicStore = false, expectedFailure = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notallyx-oracle-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const create = spawnSync('python3', ['-c', CREATE], { input: JSON.stringify({ dir, notes: note ? [note] : [], labels, schemaPath: path.resolve(__dirname, '../../app/schemas/com.philkes.notallyx.data.NotallyDatabase/11.json') }), encoding: 'utf8' });
  assert.equal(create.status, 0, create.stderr);
  const remote = new Map();
  for (const suffix of ['', '-wal', '-shm']) { const p = path.join(dir, `NotallyDatabase${suffix}`); if (fs.existsSync(p)) remote.set(`databases/NotallyDatabase${suffix}`, fs.readFileSync(p)); }
  remote.set(`shared_prefs/${PACKAGE}_preferences.xml`, Buffer.from(`<map><string name="theme">DARK</string><boolean name="dataOnExternalStorage" value="${publicStore}"/></map>`));
  for (const file of attach) remote.set(`files/attachments/${file.kind}/${file.name}`, Buffer.from(file.body));
  let clock = start; const seen = [];
  const runCommand = (program, argv) => {
    seen.push({ program, argv }); const a = argv.slice(2);
    if (a[0] === 'shell') return { status: a[1] === 'pidof' ? 1 : 0, stdout: '', stderr: '' };
    const cmd = a[3], arg = a[4];
    if (cmd === 'test') { const present = arg === '-f' ? remote.has(a[5]) : [...remote.keys()].some((p) => p.startsWith(`${a[5]}/`)); return { status: present ? 0 : 1, stdout: '', stderr: '' }; }
    if (cmd === 'cat') return { status: 0, stdout: remote.get(arg), stderr: '' };
    if (cmd === 'find') return { status: 0, stdout: Buffer.from([...remote.keys()].filter((p) => p.startsWith(`${arg}/`)).join('\0') + '\0'), stderr: '' };
    throw new Error(`Unexpected simulated command ${argv}`);
  };
  const manifest = collectSnapshot({ serial: 'simulation', packageName: PACKAGE, out: path.join(dir, 'evidence'), runId, sequence, apkSha256: 'a'.repeat(64) }, { runCommand, now: () => ++clock });
  const context = { expectedTarget: manifest.target, runId, afterSequence: sequence, minCapturedAtMs: start };
  const snapshot = readSnapshot(manifest, context);
  if (expectedFailure) assert.equal(snapshot.reason, expectedFailure);
  else assert.equal(snapshot.ok, true, snapshot.reason);
  return { dir, manifest, context, snapshot, seen };
}

test('reads committed WAL state and exact notes/list/label/folder/pin/color/reminder/prefs values', (t) => {
  const note = baseNote({ type: 'LIST', folder: 'ARCHIVED', pinned: true, color: '#123456', items: [{ body: 'Buy milk', checked: true, isChild: false, order: 0, checkedTimestamp: 150 }], reminders: [{ id: 9, dateTime: 2000000, isNotificationVisible: false, repetition: { value: 1, unit: 'DAYS' } }] });
  const { snapshot, manifest } = fixture(t, { note });
  assert(manifest.files.wal); assert.equal(snapshot.data.notes.length, 1);
  const result = checkSnapshot(snapshot, { id: 'saved', noteCount: 1, notes: [{ where: { title: 'AAB unique' }, fields: note }], labels: [{ value: 'Project', order: 0 }], preferences: { theme: 'DARK' } });
  assert.equal(result.verdict, 'passed');
});
test('not saved, wrong body, wrong folder and failed restoration cannot pass', (t) => {
  const { snapshot } = fixture(t);
  for (const fields of [{ body: 'expected edited value' }, { folder: 'DELETED' }, { pinned: true }, { color: '#FFFFFF' }]) assert.equal(checkSnapshot(snapshot, { id: 'wrong', notes: [{ where: { title: 'AAB unique' }, fields }] }).verdict, 'failed');
  assert.equal(checkSnapshot(snapshot, { id: 'missing-save', notes: [{ where: { title: 'new but not saved' }, fields: { body: 'x' } }] }).verdict, 'failed');
  assert.equal(checkSnapshot(snapshot, { id: 'not-restored', preferences: { theme: 'FOLLOW_SYSTEM' } }).verdict, 'failed');
});
test('missing, stale, wrong-run, altered hash and active-writer evidence are inconclusive', (t) => {
  const { snapshot, manifest, context } = fixture(t);
  assert.equal(checkSnapshot(JSON.parse(JSON.stringify(snapshot)), { id: 'forged', noteCount: 1 }).verdict, 'inconclusive');
  assert.equal(readSnapshot(manifest, { ...context, afterSequence: 6 }).reason, 'snapshot_before_action');
  assert.equal(readSnapshot(manifest, { ...context, runId: 'other' }).reason, 'snapshot_wrong_run');
  assert.equal(readSnapshot(manifest, { ...context, minCapturedAtMs: 999999 }).reason, 'snapshot_time_before_action');
  const changed = structuredClone(manifest); changed.files.database.sha256 = 'b'.repeat(64);
  assert.equal(readSnapshot(changed, context).verdict, 'inconclusive');
  const running = structuredClone(manifest); running.acquisition.pidof.stdout = '1234';
  assert.equal(readSnapshot(running, context).reason, 'writer_not_quiesced');
  const absent = structuredClone(manifest); delete absent.files.wal;
  assert.equal(readSnapshot(absent, context).reason, 'explicit_file_presence_required:wal');
});
test('attachment refs and actual file bytes survive comparison, missing files cannot pass existence', (t) => {
  const note = baseNote({ files: [{ localName: 'one.txt', originalName: 'document.txt', mimeType: 'text/plain' }] });
  const missing = fixture(t, { note });
  assert.equal(checkSnapshot(missing.snapshot, { id: 'attachment', notes: [{ where: { id: 1 }, fields: { files: note.files }, attachmentFiles: true }] }).verdict, 'inconclusive');
  const present = fixture(t, { note, attach: [{ kind: 'Files', name: 'one.txt', body: 'real bytes' }] });
  assert.equal(checkSnapshot(present.snapshot, { id: 'attachment', notes: [{ where: { id: 1 }, fields: { files: note.files }, attachmentFiles: true }] }).verdict, 'passed');
});
test('upgrade canonical allows different run IDs but preserves all business values and order', (t) => {
  const before = fixture(t, { runId: 'before', start: 1000 }).snapshot;
  const after = fixture(t, { runId: 'after', start: 10000 }).snapshot;
  assert.equal(compareCanonical(before, after).verdict, 'passed');
  assert.equal(compareCanonical(before, before).verdict, 'inconclusive');
  const changed = fixture(t, { runId: 'after', start: 10000, note: baseNote({ body: 'silently truncated' }) }).snapshot;
  assert.equal(compareCanonical(before, changed).verdict, 'failed');
  assert.equal(compareCanonical(before, changed, { ignoreFields: ['notes.body'] }).reason, 'business_field_cannot_be_ignored');
  const timestamp = fixture(t, { runId: 'after', start: 10000, note: baseNote({ modifiedTimestamp: 300 }) }).snapshot;
  assert.equal(compareCanonical(before, timestamp).verdict, 'failed');
  assert.equal(compareCanonical(before, timestamp, { ignoreFields: ['notes.modifiedTimestamp'] }).verdict, 'passed');
});
test('collector rejects nonisolated targets before running any command', () => {
  let calls = 0;
  assert.throws(() => collectSnapshot({ packageName: 'com.philkes.notallyx' }, { runCommand: () => { calls++; } }), /isolated_sample_package_required/);
  assert.equal(calls, 0);
});
test('external-storage preference rejects an otherwise valid old private database snapshot', (t) => {
  const { snapshot } = fixture(t, { publicStore: true, expectedFailure: 'external_storage_snapshot_unsupported' });
  assert.equal(snapshot.ok, false);
  assert.equal(checkSnapshot(snapshot, { id: 'wrong-active-db', noteCount: 1 }).verdict, 'inconclusive');
});

function reportInput(t, variant = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notallyx-report-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inventory = { features: [{ id: 'notes', name: 'Notes', scenarioIds: ['save', 'restore'] }] };
  const scenarios = { scenarios: ['save', 'restore'].map((id) => ({ id, featureId: 'notes', name: id, oracles: [{ id: `${id}-oracle`, kind: 'database' }] })) };
  if (variant) scenarios.variantMatrix = [{ id: 'save:v:a', scenarioId: 'save', variant: 'a' }, { id: 'save:v:b', scenarioId: 'save', variant: 'b' }];
  const artifacts = []; const identity = {};
  for (const [role, bytes] of [['apk', 'apk'], ['script', 'source'], ['inventory', JSON.stringify(inventory)], ['scenarios', JSON.stringify(scenarios)]]) {
    const file = path.join(dir, role); fs.writeFileSync(file, bytes); artifacts.push({ role, path: file, sha256: hashFile(file) }); identity[`${role}Sha256`] = hashFile(file);
  }
  return { dir, inventory, scenarios, artifacts, identity, timing: { construction: [{ startedAtMs: 0, finishedAtMs: 5000 }], installation: [{ startedAtMs: 5000, finishedAtMs: 10000 }], regression: { startedAtMs: 10000, finishedAtMs: 11000 } } };
}
test('report retains unexecuted denominator and ignores script.passed/completed as acceptance', (t) => {
  const input = reportInput(t);
  const report = buildReport({ ...input, executions: [{ scenarioId: 'save', attempt: 1, executionStatus: 'completed', passed: true }] });
  assert.equal(report.ok, false); assert.equal(report.coverage.scenarios.total, 2); assert.equal(report.coverage.scenarios.passed, 0); assert.equal(report.coverage.scenarios.not_run, 1); assert.equal(report.coverage.scenarios.inconclusive, 1);
  assert.equal(report.timing.regression.wallMs, 1000); assert.equal(report.timing.model.wallMs, null);
});
test('independent all-case oracle results pass and changed frozen inventory is rejected', (t) => {
  const input = reportInput(t);
  const executions = ['save', 'restore'].map((id) => ({ scenarioId: id, attempt: 1, executionStatus: 'completed' }));
  const oracleResults = ['save', 'restore'].map((id) => ({ scenarioId: id, attempt: 1, id: `${id}-oracle`, verdict: 'passed', source: 'independent-host-business-oracle' }));
  const report = buildReport({ ...input, executions, oracleResults }); assert.equal(report.ok, true);
  const paths = writeReport(report, path.join(input.dir, 'report')); assert(fs.readFileSync(paths.htmlPath, 'utf8').includes('2/2')); assert.throws(() => writeReport(report, path.join(input.dir, 'report')), /EEXIST/);
  const changed = structuredClone(input.inventory); changed.features[0].name = 'Changed after freeze';
  assert.equal(buildReport({ ...input, inventory: changed, executions, oracleResults }).ok, false);
});
test('one template pass cannot satisfy frozen variants', (t) => {
  const input = reportInput(t, true);
  const report = buildReport({ ...input, executions: [{ scenarioId: 'save', attempt: 1, executionStatus: 'completed' }], oracleResults: [{ scenarioId: 'save', attempt: 1, id: 'save-oracle', source: 'independent-host-business-oracle', verdict: 'passed' }] });
  assert.equal(report.coverage.variants.total, 2); assert.equal(report.coverage.variants.not_run, 2); assert.equal(report.coverage.scenarios.passed, 0); assert.equal(report.ok, false);
  assert.equal(report.coverage.atomicCases.total, 3); assert.equal(report.coverage.atomicCases.not_run, 3);
  assert.throws(() => buildReport({ ...input, executions: [{ scenarioId: 'save', variantId: 'invented', attempt: 1, executionStatus: 'completed' }] }), /result_outside_frozen_variant_scope/);
});

test('complete persisted list sequence rejects loss, duplication, wrong hierarchy, unchecked state and old checkedTimestamp', (t) => {
  const items = [{ body: 'Parent-A', checked: false, isChild: false, order: 0 }, { body: 'Child-A1', checked: false, isChild: true, order: 1 },
    { body: 'Child-A2-edited', checked: false, isChild: true, order: 2 }, { body: 'Parent-B', checked: true, isChild: false, order: 3, checkedTimestamp: 150 }];
  const { snapshot } = fixture(t, { note: baseNote({ type: 'LIST', items }) });
  const query = (expected) => checkSnapshot(snapshot, { id: 'list-sequence', notes: [{ where: { id: 1 }, fields: { type: 'LIST', items: expected } }] });
  assert.equal(query(items).verdict, 'passed');
  assert.equal(query(items.slice(0, 3)).verdict, 'failed');
  assert.equal(query([...items, items[3]]).verdict, 'failed');
  for (const [index, value] of [[1, { isChild: false }], [2, { body: 'Child-A2' }], [3, { checked: false }], [3, { checkedTimestamp: 99 }]]) {
    const expected = structuredClone(items); Object.assign(expected[index], value); assert.equal(query(expected).verdict, 'failed');
  }
  const wrongOrder = structuredClone(items); [wrongOrder[1], wrongOrder[2]] = [wrongOrder[2], wrongOrder[1]];
  assert.equal(query(wrongOrder).verdict, 'failed');
});
