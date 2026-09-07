#!/usr/bin/env node
'use strict';

// Read-only independent re-evaluation of archived UI evidence. No adb or MCP calls.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function rerunUiOracles(runDirectory) {
  const directory = path.resolve(runDirectory);
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const report = read(path.join(directory, 'report/report.json'));
  const coveredFile = (file) => {
    const real = fs.realpathSync(file), relative = path.relative(directory, real);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('run_evidence_path_outside_directory');
    const sha256 = hash(file);
    if (!report.artifacts.some((row) => row.path === file && row.sha256 === sha256 && row.verified === true)) throw new Error(`run_manifest_file_mismatch:${relative}`);
    return file;
  };
  const oraclePath = coveredFile(path.join(directory, 'frozen/ui-oracles.js'));
  // Verify each dependency loaded by the frozen UI oracle before requiring it.
  coveredFile(path.join(directory, 'frozen/oracles.js'));
  const sourcePath = coveredFile(path.join(directory, 'frozen/regression-script.js'));
  if (hash(sourcePath) !== report.identity.scriptSha256) throw new Error('frozen_script_identity_mismatch');
  const records = read(coveredFile(path.join(directory, 'execution-records.json')));
  const { checkTextUi } = require(oraclePath);
  const runId = report.identity.runId, target = report.identity.target;
  const title = `AAB-TEXT-${runId}`, listTitle = `AAB-LIST-${runId}`, label = `AAB项目-${runId}`;
  const original = '第一行中文\nsecond line & <tag>', edited = `${original}-edited`;
  const phaseNames = ['create', 'edit', 'restart', 'organize', 'list-create', 'list-hierarchy', 'list-restart',
    'labels-prepare', 'labels-duplicate', 'labels-conflict', 'labels-rename', 'labels-cancel-delete', 'labels-delete', 'labels-restart', 'assignment-cancel', 'assignment-apply', 'assignment-remove', 'assignment-restart'];
  const hostPhases = {}, checkpoints = [];
  for (const phase of records.phases) {
    if (!phaseNames.includes(phase.phase) || typeof phase.operationId !== 'string') throw new Error('unknown_archived_phase');
    const final = read(coveredFile(path.join(directory, phase.phase, 'final.json')));
    if (final.operationId !== phase.operationId) throw new Error('host_phase_operation_mismatch');
    hostPhases[phase.operationId] = final;
    for (const point of phase.checkpoints || []) {
      for (const key of ['tree', 'afterTree', 'screenshot', 'screenshotResponse']) coveredFile(point[key].path);
      checkpoints.push(point);
    }
  }
  const groups = [
    { id: 'rerun.text.normal', title, expectedCheckpoints: [
      { name: 'created-editor', screen: 'editor', body: original }, { name: 'created-overview', screen: 'overview', body: original },
      { name: 'reopened-editor', screen: 'editor', body: original }, { name: 'edited-editor', screen: 'editor', body: edited }, { name: 'edited-overview', screen: 'overview', body: edited },
    ] },
    { id: 'rerun.text.restart', title, expectedCheckpoints: ['restart-overview', 'restart-editor', 'restart-returned'].map((name) => ({ name, screen: name === 'restart-editor' ? 'editor' : 'overview', body: edited })) },
    { id: 'rerun.organization.partial', title, expectedCheckpoints: ['label-pinned-editor', 'organized-editor'].map((name) =>
      ({ name, screen: 'editor', body: edited, requiredSelectors: [{ text: label }, { contentDescription: '取消固定' }] }))
      .concat([{ name: 'organized-overview', screen: 'overview', body: edited, requiredSelectors: [{ text: label }] }]) },
  ];
  const labelScope = report.core.scope === 'text-list-label-management-restart-candidate';
  const listScope = labelScope || report.core.scope === 'text-organize-list-hierarchy-restart-candidate';
  if (!listScope && report.core.scope !== 'text-create-edit-restart-and-organize-candidate') throw new Error('unsupported_frozen_regression_scope');
  if (listScope) {
    const items = (edit = false, first = false, second = false, checked = true) => [
      { body: 'Parent-A', isChild: false, checked: false }, { body: 'Child-A1', isChild: first, checked: false },
      { body: edit ? 'Child-A2-edited' : 'Child-A2', isChild: second, checked: false }, { body: 'Parent-B', isChild: false, checked },
    ];
    groups.push({ id: 'rerun.list.normal', title: listTitle, expectedCheckpoints: [
      ...['list-created-flat-editor', 'list-reopened-flat-editor', 'list-checked-editor'].map((name) => ({ name, screen: 'list-editor', items: items(false, false, false, name === 'list-checked-editor') })),
      ...['list-created-flat-overview', 'list-checked-overview'].map((name) => ({ name, screen: 'list-overview', items: items(false, false, false, name === 'list-checked-overview') })),
      { name: 'list-first-child', screen: 'list-editor', items: items(false, true, false) },
      { name: 'list-two-children', screen: 'list-editor', items: items(false, true, true) },
      { name: 'list-child-edited', screen: 'list-editor', items: items(true, true, true) },
      { name: 'list-child-outdented', screen: 'list-editor', items: items(true, false, true) },
      ...['list-child-restored', 'list-hierarchy-reopened'].map((name) => ({ name, screen: 'list-editor', items: items(true, true, true) })),
      ...['list-hierarchy-overview', 'list-hierarchy-returned'].map((name) => ({ name, screen: 'list-overview', items: items(true, true, true) })),
    ] });
    groups.push({ id: 'rerun.list.restart', title: listTitle, expectedCheckpoints: ['list-restart-overview', 'list-restart-editor', 'list-restart-returned'].map((name) =>
      ({ name, screen: name === 'list-restart-editor' ? 'list-editor' : 'list-overview', items: items(true, true, true) })) });
    if (labelScope) {
      const a = `AAB-label-${runId}-a`, ab = `AAB-label-${runId}-ab`, renamed = `AAB-label-${runId}-renamed`;
      const management = (name, present, absent = []) => ({ name, screen: name.endsWith('navigation') ? 'label-navigation' : 'labels', labels: { present, absent } });
      const notes = (prefix, isList, required, absent, overview = true) => ({ id: `rerun.${prefix}.${isList ? 'list' : 'text'}`, title: isList ? listTitle : title,
        expectedCheckpoints: [...(overview ? [`${prefix}-${isList ? 'list' : 'text'}-overview`] : []), `${prefix}-${isList ? 'list' : 'text'}`].map((name) => ({ name,
          screen: `${isList ? 'list-' : ''}${name.endsWith('overview') ? 'overview' : 'editor'}`, ...(isList ? { items: items(true, true, true) } : { body: edited }),
          requiredSelectors: required.map((text) => ({ text })), absentSelectors: absent.map((text) => ({ text })) })) });
      groups.push({ id: 'rerun.labels.prepare.text', title, expectedCheckpoints: ['labels-text-assigned-editor', 'labels-text-assigned-overview'].map((name) => ({ name,
        screen: name.endsWith('editor') ? 'editor' : 'overview', body: edited, requiredSelectors: [{ text: label }, { text: a }] })) });
      groups.push({ id: 'rerun.labels.prepare.list', title: listTitle, expectedCheckpoints: ['labels-list-assigned-editor', 'labels-list-assigned-overview'].map((name) => ({ name,
        screen: name.endsWith('editor') ? 'list-editor' : 'list-overview', items: items(true, true, true), requiredSelectors: [{ text: ab }] })) });
      groups.push({ id: 'rerun.labels.rejections', title, expectedCheckpoints: ['labels-before-duplicate', 'labels-duplicate-rejected', 'labels-before-conflict', 'labels-rename-conflict-rejected']
        .map((name) => management(name, [label, a, ab])).concat([
          { name: 'labels-duplicate-input', screen: 'label-input-dialog', input: { title: '添加标签', value: a } },
          { name: 'labels-conflict-original-dialog', screen: 'label-input-dialog', input: { title: '编辑标签', value: a } },
          { name: 'labels-conflict-input', screen: 'label-input-dialog', input: { title: '编辑标签', value: ab } },
        ]) });
      groups.push({ id: 'rerun.labels.rename.management', title, expectedCheckpoints: ['labels-renamed-manager', 'labels-renamed-navigation'].map((name) => management(name, [label, renamed, ab], [a])) });
      groups.push(notes('labels-renamed', false, [label, renamed], [a, ab], false), notes('labels-renamed', true, [ab], [a, renamed], false));
      groups.push({ id: 'rerun.labels.cancel', title, expectedCheckpoints: [management('labels-before-cancel', [label, renamed, ab], [a]),
        { name: 'labels-cancel-dialog', screen: 'label-delete-dialog', dialog: 'delete-label-confirmation' }, management('labels-delete-cancelled', [label, renamed, ab], [a])] });
      groups.push({ id: 'rerun.labels.delete.management', title, expectedCheckpoints: [management('labels-before-delete', [label, renamed, ab], [a]),
        { name: 'labels-confirm-delete-dialog', screen: 'label-delete-dialog', dialog: 'delete-label-confirmation' },
        ...['labels-deleted-manager', 'labels-deleted-navigation'].map((name) => management(name, [label, ab], [a, renamed]))] });
      groups.push(notes('labels-deleted', false, [label], [a, renamed, ab]), notes('labels-deleted', true, [ab], [a, renamed, label]));
      groups.push({ id: 'rerun.labels.restart.management', title, expectedCheckpoints: ['labels-restart-manager', 'labels-restart-navigation'].map((name) => management(name, [label, ab], [a, renamed])) });
      groups.push(notes('labels-restart', false, [label], [a, renamed, ab]), notes('labels-restart', true, [ab], [a, renamed, label]));
    }
  }
  if (records.assignmentCommon) {
    if (records.assignmentCommon !== report.identity.assignmentCommon) throw new Error('assignment_input_identity_mismatch');
    coveredFile(path.join(directory, 'frozen/read_snapshot.py'));
    const { readSnapshot } = require(path.join(directory, 'frozen/oracles.js'));
    const manifest = read(coveredFile(path.join(directory, 'labels-restarted-db/snapshot.json')));
    const baseline = readSnapshot(manifest, { expectedTarget: target, runId, afterSequence: manifest.capturedAfterSequence, expectedApkSha256: report.identity.apkSha256 });
    if (!baseline.ok) throw new Error(baseline.reason);
    const common = report.identity.assignmentCommon, ab = `AAB-label-${runId}-ab`;
    const textNote = baseline.data.notes.filter(n => n.title === title), listNote = baseline.data.notes.filter(n => n.title === listTitle);
    if (textNote.length !== 1 || listNote.length !== 1) throw new Error('unique_assignment_note_ids_required');
    const members = {
      common: baseline.data.notes.filter(n => n.folder === 'NOTES' && n.id !== listNote[0].id && (n.id === textNote[0].id || n.labels.includes(common))).map(n => n.title),
      unlabeled: baseline.data.notes.filter(n => n.folder === 'NOTES' && (n.id === listNote[0].id || (n.id !== textNote[0].id && n.labels.length === 0))).map(n => n.title),
    };
    const selectors = values => values.map(text => ({ text }));
    const itemArray = [
      { body: 'Parent-A', checked: false, isChild: false }, { body: 'Child-A1', checked: false, isChild: true },
      { body: 'Child-A2-edited', checked: false, isChild: true }, { body: 'Parent-B', checked: true, isChild: false },
    ];
    const textPoint = (name, present, absent) => ({ name, screen: 'overview', body: edited, requiredSelectors: selectors(present), absentSelectors: selectors(absent) });
    const listPoint = (name, screen, present, absent) => ({ name, screen, items: itemArray, requiredSelectors: selectors(present), absentSelectors: selectors(absent) });
    for (const kind of ['cancel', 'apply']) {
      const phase = `assignment-${kind}`, applied = kind === 'apply';
      groups.push({ id: `rerun.${phase}.text`, title, expectedCheckpoints: [
        ...['initial', 'changed'].map(suffix => ({ name: `${phase}-${suffix}`, screen: 'assignment-dialog', assignment: { labels: [label, ab, common] } })),
        textPoint(`${phase}-text`, applied ? [label, common] : [label], applied ? [ab] : [ab, common]),
      ] });
      groups.push({ id: `rerun.${phase}.list`, title: listTitle, expectedCheckpoints: [listPoint(`${phase}-list`, 'list-overview', applied ? [common] : [ab], applied ? [label, ab] : [label, common])] });
    }
    const memberPoints = prefix => ['common', 'unlabeled'].map(name => ({ name: `${prefix}-${name}-members`, screen: 'membership', members: { title: name === 'common' ? common : '未加标签', titles: members[name] } }));
    groups.push({ id: 'rerun.assignment.remove', title: listTitle, expectedCheckpoints: [
      listPoint('assignment-before-remove', 'list-editor', [common], [ab]), listPoint('assignment-removed-editor', 'list-editor', [], [label, ab, common]),
      listPoint('assignment-removed-overview', 'list-overview', [], [label, ab, common]), ...memberPoints('assignment'),
    ] });
    groups.push({ id: 'rerun.assignment.restart.text', title, expectedCheckpoints: [textPoint('assignment-restart-text', [label, common], [ab])] });
    groups.push({ id: 'rerun.assignment.restart.list', title: listTitle, expectedCheckpoints: [listPoint('assignment-restart-list', 'list-overview', [], [label, ab, common]), ...memberPoints('assignment-restart')] });
  }
  const results = groups.map((group) => checkTextUi({ ...group, runId, target, hostPhases, checkpoints }));
  return { schemaVersion: 'aab.notallyx.ui-rerun/v1', scope: 'archived-ui-only', fullAppClaim: false, databaseRerun: false,
    runId, target, scriptSha256: report.identity.scriptSha256, oracleSha256: hash(oraclePath), expectedCheckpointCount: groups.reduce((sum, group) => sum + group.expectedCheckpoints.length, 0),
    evaluatedCheckpointCount: results.reduce((count, result) => count + result.checks.length, 0),
    ok: results.every((result) => result.verdict === 'passed'), results };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--run-dir') throw new Error('usage: node rerun-ui-oracles.js --run-dir /absolute/archived/run');
    const result = rerunUiOracles(process.argv[3]); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ok ? 0 : 1;
  } catch (error) { console.error(JSON.stringify({ ok: false, scope: 'archived-ui-only', error: error.message })); process.exitCode = 1; }
}
module.exports = { rerunUiOracles };
