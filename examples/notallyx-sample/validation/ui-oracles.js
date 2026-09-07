'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { verifyFile } = require('./oracles');
const PACKAGE = 'io.github.mobileaidev.notallyx.sample';
const explicitlyHidden = (node) => node && (node.visible === false || node.effectiveVisible === false || node.alpha === 0);
const foregroundWindow = (tree) => Array.isArray(tree?.windows) && tree.windows.length
  ? [...tree.windows].reverse().find((window) => !explicitlyHidden(window?.root)) : null;

function visibleNodes(tree) {
  const shown = (node) => node && node.enabled !== false && node.visible !== false && node.effectiveVisible !== false
    && (node.visible === true || node.effectiveVisible === true) && node.alpha !== 0;
  const windows = Array.isArray(tree?.windows) ? tree.windows : [];
  const root = windows.length ? foregroundWindow(tree)?.root : tree?.root;
  const result = [];
  const walk = (node) => { if (!shown(node)) return; result.push(node); for (const child of node.children || []) walk(child); };
  walk(root); return result;
}

function noteCardNodes(all, title) {
  const titled = (nodes) => nodes.filter((node) => node.resourceName === `${PACKAGE}:id/Title` && node.text === title);
  if (titled(all).length !== 1) return [];
  const cards = all.filter((node) => node.className === 'com.google.android.material.card.MaterialCardView'
    && titled(visibleNodes({ root: node })).length === 1);
  return cards.length === 1 ? visibleNodes({ root: cards[0] }) : [];
}

function listContentMatches(all, title, screen, items) {
  if (!Array.isArray(items) || items.length !== 4 || items.some((item) => typeof item.body !== 'string' || !item.body || typeof item.isChild !== 'boolean' || typeof item.checked !== 'boolean')
    || new Set(items.map((item) => item.body)).size !== 4) throw new Error('host_list_expectation_required');
  const scoped = screen === 'list-overview' ? noteCardNodes(all, title) : all;
  const titleResource = `${PACKAGE}:id/${screen === 'list-overview' ? 'Title' : 'EnterTitle'}`;
  if (scoped.filter((node) => node.resourceName === titleResource && node.text === title).length !== 1) return false;
  const tasks = [];
  for (const item of items) {
    const matches = scoped.filter((node) => node.text === item.body && (screen !== 'list-editor' || (node.resourceName === `${PACKAGE}:id/EditText` && node.editable === !item.checked)));
    if (matches.length !== 1) return false;
    tasks.push(matches[0]);
  }
  if (screen === 'list-overview') return true;
  if (scoped.filter((node) => node.resourceName === `${PACKAGE}:id/EditText` && /^EditText\d+$/.test(node.contentDescription || '') && node.text).length !== 4) return false;
  for (const item of items) {
    const sections = scoped.filter((node) => node.resourceName === `${PACKAGE}:id/${item.checked ? 'CheckedListView' : 'MainListView'}`);
    if (sections.length !== 1) return false;
    const section = visibleNodes({ root: sections[0] });
    const task = section.filter((node) => node.resourceName === `${PACKAGE}:id/EditText` && node.text === item.body);
    if (task.length !== 1 || task[0].editable !== !item.checked || task[0].focusable !== !item.checked || task[0].alpha !== (item.checked ? 0.5 : 1)) return false;
    const rows = section.filter((node) => node.resourceName === `${PACKAGE}:id/Content`
      && visibleNodes({ root: node }).filter((child) => child.resourceName === `${PACKAGE}:id/EditText` && child.text === item.body).length === 1);
    if (rows.length !== 1 || visibleNodes({ root: rows[0] }).filter((node) => node.resourceName === `${PACKAGE}:id/CheckBox`
      && node.className === 'com.google.android.material.checkbox.MaterialCheckBox').length !== 1) return false;
  }
  const left = tasks[0].bounds?.left;
  if (!Number.isFinite(left)) return false;
  for (let index = 0; index < tasks.length; index++) {
    const bounds = tasks[index].bounds;
    if (!bounds || !(bounds.right > bounds.left && bounds.bottom > bounds.top)) return false;
    if (items[index].isChild ? bounds.left <= left : bounds.left !== left) return false;
    if (index && bounds.top <= tasks[index - 1].bounds.top) return false;
  }
  return true;
}

function labelContentMatches(all, expected) {
  if (!expected || !Array.isArray(expected.present) || expected.present.length === 0
    || !expected.present.every((value) => typeof value === 'string' && value) || new Set(expected.present).size !== expected.present.length
    || !Array.isArray(expected.absent || []) || !(expected.absent || []).every((value) => typeof value === 'string' && value)) throw new Error('host_label_expectation_required');
  const lists = all.filter((node) => node.resourceName === `${PACKAGE}:id/MainListView`);
  if (lists.length !== 1 || all.some((node) => node.resourceName === `${PACKAGE}:id/EditText`)
    || all.filter((node) => node.contentDescription === '添加标签').length !== 1) return false;
  const list = visibleNodes({ root: lists[0] });
  for (const value of expected.present) {
    if (list.filter((node) => node.resourceName === `${PACKAGE}:id/LabelText` && node.text === value).length !== 1) return false;
    const rows = (lists[0].children || []).filter((node) => node.className === 'android.widget.LinearLayout'
      && visibleNodes({ root: node }).filter((child) => child.resourceName === `${PACKAGE}:id/LabelText` && child.text === value).length === 1);
    if (rows.length !== 1 || ['EditButton', 'DeleteButton'].some((control) => visibleNodes({ root: rows[0] }).filter((node) => node.resourceName === `${PACKAGE}:id/${control}`).length !== 1)) return false;
  }
  return (expected.absent || []).every((value) => list.filter((node) => node.resourceName === `${PACKAGE}:id/LabelText` && node.text === value).length === 0);
}

function labelNavigationMatches(all, expected) {
  if (!expected || !Array.isArray(expected.present) || expected.present.length === 0
    || !expected.present.every((value) => typeof value === 'string' && value) || new Set(expected.present).size !== expected.present.length
    || !Array.isArray(expected.absent || []) || !(expected.absent || []).every((value) => typeof value === 'string' && value)) throw new Error('host_label_navigation_expectation_required');
  if (all.filter(node => node.resourceName === `${PACKAGE}:id/Labels` && visibleNodes({ root: node })
    .filter(child => child.resourceName === `${PACKAGE}:id/design_menu_item_text` && child.text === '标签').length === 1).length !== 1) return false;
  const navigation = all.filter((node) => node.resourceName === `${PACKAGE}:id/design_menu_item_text`);
  return expected.present.every((value) => navigation.filter((node) => node.text === value).length === 1)
    && (expected.absent || []).every((value) => navigation.filter((node) => node.text === value).length === 0);
}

function labelDeleteDialogMatches(all) {
  const count = (selector) => all.filter((node) => Object.entries(selector).every(([key, value]) => node[key] === value)).length;
  return count({ resourceName: `${PACKAGE}:id/alertTitle`, text: '删除标签？' }) === 1
    && count({ resourceName: 'android:id/message', text: '不会删除与此标签相关联的笔记' }) === 1
    && count({ resourceName: 'android:id/button2', text: '取消' }) === 1 && count({ resourceName: 'android:id/button1', text: '删除' }) === 1
    && count({ resourceName: `${PACKAGE}:id/LabelText` }) === 0;
}

function labelInputDialogMatches(all, expected) {
  if (!expected || !['添加标签', '编辑标签'].includes(expected.title) || typeof expected.value !== 'string' || !expected.value) throw new Error('host_label_input_expectation_required');
  const count = (selector) => all.filter((node) => Object.entries(selector).every(([key, value]) => node[key] === value)).length;
  return count({ resourceName: `${PACKAGE}:id/alertTitle`, text: expected.title }) === 1
    && count({ resourceName: `${PACKAGE}:id/EditText`, text: expected.value, editable: true }) === 1
    && count({ resourceName: 'android:id/button1', text: '保存' }) === 1 && count({ resourceName: 'android:id/button2', text: '取消' }) === 1
    && count({ resourceName: `${PACKAGE}:id/LabelText` }) === 0;
}

function assignmentDialogMatches(all, expected) {
  if (!Array.isArray(expected?.labels) || expected.labels.length !== 3 || new Set(expected.labels).size !== 3
    || !expected.labels.every(value => typeof value === 'string' && value)) throw new Error('host_assignment_labels_required');
  const count = selector => all.filter(node => Object.entries(selector).every(([key, value]) => node[key] === value)).length;
  return count({ resourceName: `${PACKAGE}:id/alertTitle`, text: '标签' }) === 1
    && count({ resourceName: 'android:id/button2', text: '取消' }) === 1
    && count({ resourceName: 'android:id/button1', text: '保存' }) === 1
    && expected.labels.every(text => count({ resourceName: `${PACKAGE}:id/Text`, text }) === 1)
    && !all.some(node => node.resourceName === `${PACKAGE}:id/Title`);
  // This checks the dialog identity, never the custom tri-state drawable's selection state.
}

function membershipMatches(all, expected) {
  if (typeof expected?.title !== 'string' || !expected.title || !Array.isArray(expected.titles)
    || !expected.titles.every(title => typeof title === 'string' && title)
    || new Set(expected.titles).size !== expected.titles.length) throw new Error('host_membership_expectation_required');
  const toolbar = all.filter(node => node.resourceName === `${PACKAGE}:id/Toolbar`);
  const lists = all.filter(node => node.resourceName === `${PACKAGE}:id/MainListView`);
  if (toolbar.length !== 1 || lists.length !== 1
    || visibleNodes({ root: toolbar[0] }).filter(node => node.text === expected.title).length !== 1) return false;
  const titles = visibleNodes({ root: lists[0] }).filter(node => node.resourceName === `${PACKAGE}:id/Title`);
  const b = lists[0].bounds;
  return b && titles.every(node => node.bounds?.top >= b.top && node.bounds.bottom <= b.bottom)
    && isDeepStrictEqual(titles.map(node => node.text).sort(), [...expected.titles].sort());
}

const payloadHash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stateKey = (tree) => {
  const foreground = foregroundWindow(tree);
  return JSON.stringify({ activity: tree.activity, window: foreground ? { index: foreground.index, type: foreground.type, activityDecor: foreground.activityDecor, bounds: foreground.bounds } : null,
    nodes: visibleNodes(tree).map((node) => ({ className: node.className, resourceName: node.resourceName, contentDescription: node.contentDescription, text: node.text, bounds: node.bounds,
      editable: node.editable, focusable: node.focusable, alpha: node.alpha })) });
};

function issuedResponse(checkpoint, descriptor, command, assertionName, phase, target) {
  verifyFile(descriptor);
  const response = JSON.parse(fs.readFileSync(descriptor.path, 'utf8'));
  const evidence = response.evidence;
  if (!phase || phase.operationId !== checkpoint.operationId || response.execution?.executionId !== checkpoint.operationId
    || response.ok !== true || !evidence?.observationId || evidence.window?.afterActionId !== checkpoint.afterActionId
    || evidence.source?.scope !== 'execution' || evidence.source.command !== command
    || evidence.coverage?.status !== 'complete' || evidence.coverage.gap !== false || evidence.coverage.committed !== true) throw new Error('ui_fresh_host_observation_required');
  if (evidence.source.payloadSha256 !== payloadHash(response.result)) throw new Error('ui_payload_changed');
  const proof = phase.events?.filter((event) => event.type === 'assertion_passed' && event.scope === 'device' && event.name === assertionName
    && event.observationId === evidence.observationId && isDeepStrictEqual(event.source, evidence.source) && isDeepStrictEqual(event.window, evidence.window)
    && isDeepStrictEqual(event.refs, evidence.refs));
  if (proof?.length !== 1) throw new Error('observation_not_bound_to_trusted_host_assertion');
  const call = phase.history?.items?.filter((event) => event.kind === 'call_completed' && event.executionId === checkpoint.operationId
    && isDeepStrictEqual(event.target, target) && event.payloadSummary?.command === command && !event.payloadSummary.error
    && isDeepStrictEqual(event.evidenceRefs, evidence.refs));
  if (call?.length !== 1) throw new Error('observation_not_bound_to_trusted_host_call');
  return response;
}

// Host reads raw tree and screenshot files; it never accepts the Script's verdict.
function checkTextUi({ id, runId, title, checkpoints, expectedCheckpoints, hostPhases, target }) {
  const checks = [];
  try {
    for (const expected of expectedCheckpoints) {
      const { name, screen, body } = expected;
      if (!['editor', 'overview', 'list-editor', 'list-overview', 'labels', 'label-navigation', 'label-delete-dialog', 'label-input-dialog', 'assignment-dialog', 'membership'].includes(screen)
        || (['labels', 'label-navigation'].includes(screen) ? !expected.labels : screen === 'label-delete-dialog' ? expected.dialog !== 'delete-label-confirmation'
          : screen === 'label-input-dialog' ? !expected.input
          : screen === 'assignment-dialog' ? !expected.assignment : screen === 'membership' ? !expected.members
          : screen.startsWith('list-') ? !Array.isArray(expected.items) : typeof body !== 'string')) throw new Error('host_ui_expectation_required');
      const matches = checkpoints.filter((row) => row.name === name);
      if (matches.length !== 1) throw new Error(`checkpoint_missing_or_duplicate:${name}`);
      const checkpoint = matches[0];
      if (checkpoint.runId !== runId) throw new Error('ui_wrong_run');
      if (target?.packageName !== PACKAGE || !target.serial) throw new Error('ui_target_required');
      verifyFile(checkpoint.screenshot);
      const png = fs.readFileSync(checkpoint.screenshot.path);
      if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(16) === 0 || png.readUInt32BE(20) === 0) throw new Error('png_evidence_required');
      const phase = hostPhases?.[checkpoint.operationId];
      const response = issuedResponse(checkpoint, checkpoint.tree, 'tree', name, phase, target);
      const shot = issuedResponse(checkpoint, checkpoint.screenshotResponse, 'screenshot', `${name}-screenshot`, phase, target);
      const after = issuedResponse(checkpoint, checkpoint.afterTree, 'tree', `${name}-after-screenshot`, phase, target);
      if ([response, after].some((observed) => visibleNodes(observed.result).length === 0)) throw new Error('current_native_window_unavailable');
      for (const tree of [response, after]) if (!tree.evidence.refs.some((ref) => ref.stream === 'tree' && ref.hostObservationId === tree.evidence.observationId)) throw new Error('host_tree_ref_required');
      if (shot.result?.path !== checkpoint.screenshot.path || shot.result?.foregroundMatchesPackage !== true
        || shot.result?.foreground?.packageName !== target.packageName || typeof response.result.activity !== 'string'
        || shot.result.foreground.activity !== response.result.activity || shot.result.foreground.activity !== after.result.activity
        || !shot.evidence.refs.some((ref) => ref.stream === 'screenshot' && ref.screenshotId === checkpoint.screenshot.path && ref.sha256 === checkpoint.screenshot.sha256)
        || shot.result.artifact?.sha256 !== checkpoint.screenshot.sha256) throw new Error('same_action_foreground_screenshot_required');
      if (shot.result.width !== png.readUInt32BE(16) || shot.result.height !== png.readUInt32BE(20)) throw new Error('screenshot_dimensions_mismatch');
      const times = [checkpoint.phaseStartedAtMs, checkpoint.startedAtMs, response.evidence.window.closedAtMs, shot.evidence.window.closedAtMs,
        after.evidence.window.closedAtMs, checkpoint.finishedAtMs, checkpoint.phaseFinishedAtMs];
      if (!times.every(Number.isFinite) || !times.every((value, index) => !index || value >= times[index - 1])) throw new Error('ui_observation_time_order_invalid');
      if (stateKey(response.result) !== stateKey(after.result)) throw new Error('ui_changed_during_screenshot');
      const good = [response, after].every((observed) => {
        const all = visibleNodes(observed.result);
        const scoped = screen.endsWith('overview') ? noteCardNodes(all, title) : all;
        const count = (selector) => scoped.filter((node) => Object.entries(selector).every(([key, value]) => node[key] === value)).length;
        const contentsMatch = ['labels', 'label-navigation', 'label-delete-dialog', 'label-input-dialog', 'assignment-dialog', 'membership'].includes(screen) ? observed.result.activity === 'com.philkes.notallyx.presentation.activity.main.MainActivity'
          && (screen === 'labels' ? labelContentMatches(all, expected.labels) : screen === 'label-navigation' ? labelNavigationMatches(all, expected.labels)
            : screen === 'assignment-dialog' ? assignmentDialogMatches(all, expected.assignment) : screen === 'membership' ? membershipMatches(all, expected.members)
            : screen === 'label-input-dialog' ? labelInputDialogMatches(all, expected.input) : labelDeleteDialogMatches(all))
          : screen.startsWith('list-') ? listContentMatches(all, title, screen, expected.items) : screen === 'editor'
          ? count({ resourceName: `${PACKAGE}:id/EnterTitle`, text: title }) === 1 && count({ resourceName: `${PACKAGE}:id/EnterBody`, text: body }) === 1
          : all.filter((node) => node.resourceName === `${PACKAGE}:id/TakeNote`).length === 1
            && count({ resourceName: `${PACKAGE}:id/Title`, text: title }) === 1 && count({ resourceName: `${PACKAGE}:id/Note`, text: body }) === 1;
        return contentsMatch && (expected.requiredSelectors || []).every((selector) => Object.keys(selector).length > 0 && count(selector) === 1)
          && (expected.absentSelectors || []).every((selector) => Object.keys(selector).length > 0 && count(selector) === 0);
      });
      checks.push({ name, verdict: good ? 'passed' : 'failed', treeSha256: checkpoint.tree.sha256, screenshotSha256: checkpoint.screenshot.sha256 });
    }
    if (!checks.length) throw new Error('ui_checks_required');
    const verdict = checks.every((row) => row.verdict === 'passed') ? 'passed' : 'failed';
    return { id, source: 'independent-host-business-oracle', verdict, ok: verdict === 'passed', runId, checks };
  } catch (error) { return { id, source: 'independent-host-business-oracle', verdict: 'inconclusive', ok: false, runId, checks, reason: error.message }; }
}
module.exports = { checkTextUi, visibleNodes, noteCardNodes, listContentMatches, labelContentMatches, labelNavigationMatches, labelDeleteDialogMatches, labelInputDialogMatches, assignmentDialogMatches, membershipMatches, issuedResponse };
