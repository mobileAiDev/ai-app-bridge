'use strict';

// Executed by the real Node Script child. This file contains no Intent/batch path.
module.exports.main = async function main(ctx) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { out, runId, phase, title, originalBody, editedBody, label, listTitle, labelA, labelAb, labelRenamed, assignmentCommon, assignmentMembers } = ctx.inputs;
  const pkg = 'io.github.mobileaidev.notallyx.sample';
  const logPath = path.join(out, 'calls.jsonl');
  const result = { runId, phase, checkpoints: [], mutations: 0, lastActionId: null, status: 'running' };
  fs.mkdirSync(out, { recursive: true });
  const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  const visible = (node) => node && node.enabled !== false && node.visible !== false && node.effectiveVisible !== false
    && (node.visible === true || node.effectiveVisible === true) && node.alpha !== 0;
  const explicitlyHidden = (node) => node && (node.visible === false || node.effectiveVisible === false || node.alpha === 0);
  const foregroundWindow = (tree) => Array.isArray(tree.windows) && tree.windows.length
    ? [...tree.windows].reverse().find((window) => !explicitlyHidden(window?.root)) : null;
  function nodes(tree) {
    const windows = Array.isArray(tree.windows) ? tree.windows : [];
    // Choose the foreground first. An unknown/disabled foreground cannot expose a usable background.
    const root = windows.length ? foregroundWindow(tree)?.root : tree.root;
    const found = [];
    const walk = (node) => { if (!visible(node)) return; found.push(node); (node.children || []).forEach(walk); };
    walk(root); return found;
  }
  const call = async (command, args = {}) => {
    const response = await ctx.call(command, { feedback: 'off', ...args });
    fs.appendFileSync(logPath, `${JSON.stringify({ runId, phase, atMs: Date.now(), command, args, response })}\n`);
    if (!response?.ok) throw new Error(`${command}:${response?.error || 'not_ok'}`);
    if (response.execution?.actionId) { result.mutations++; result.lastActionId = response.execution.actionId; result.lastMutationAtMs = Date.now(); }
    return response;
  };
  const observe = async (predicate, label) => {
    const deadline = Date.now() + 20000;
    do {
      const response = await call('tree');
      if (predicate(nodes(response.result), response.result)) return response;
      await new Promise((resolve) => setTimeout(resolve, 150));
    } while (Date.now() < deadline);
    throw new Error(`postcondition_timeout:${label}`);
  };
  const resource = (name) => `${pkg}:id/${name}`;
  const find = (all, selector) => {
    const { withinLabel, ...properties } = selector;
    let scoped = all;
    if (withinLabel !== undefined) {
      const containers = all.filter((node) => node.resourceName === resource('MainListView'));
      if (containers.length !== 1) return [];
      const rows = (containers[0].children || []).filter((node) => visible(node) && node.className === 'android.widget.LinearLayout'
        && nodes({ root: node }).filter((child) => child.resourceName === resource('LabelText') && child.text === withinLabel).length === 1);
      if (rows.length !== 1) return [];
      scoped = nodes({ root: rows[0] });
    }
    return scoped.filter((node) => Object.entries(properties).every(([key, value]) => node[key] === value));
  };
  const stateKey = (tree) => {
    const foreground = foregroundWindow(tree);
    return JSON.stringify({ activity: tree.activity, window: foreground ? { index: foreground.index, type: foreground.type, activityDecor: foreground.activityDecor, bounds: foreground.bounds } : null,
      nodes: nodes(tree).map((node) => ({ className: node.className, resourceName: node.resourceName, contentDescription: node.contentDescription, text: node.text, bounds: node.bounds,
        editable: node.editable, focusable: node.focusable, alpha: node.alpha })) });
  };
  const target = async (selector, editable = false) => {
    let previous;
    const observed = await observe((all, tree) => {
      const current = stateKey(tree); const stable = current === previous; previous = current;
      return find(all, selector).length === 1 && stable;
    }, JSON.stringify(selector));
    const node = find(nodes(observed.result), selector)[0];
    if (editable && node.editable !== true) throw new Error('sdk_editable_fact_required');
    const b = node.bounds;
    if (!b || !(b.right > b.left && b.bottom > b.top)) throw new Error('observed_bounds_required');
    const tree = observed.result;
    const foreground = foregroundWindow(tree);
    let viewport = foreground?.bounds || foreground?.root?.bounds || tree.root?.bounds;
    if (selector.withinLabel !== undefined) {
      const list = find(nodes(tree), { resourceName: resource('MainListView') });
      if (list.length !== 1 || !list[0].bounds) throw new Error('label_list_viewport_required');
      viewport = { left: Math.max(viewport.left, list[0].bounds.left), top: Math.max(viewport.top, list[0].bounds.top),
        right: Math.min(viewport.right, list[0].bounds.right), bottom: Math.min(viewport.bottom, list[0].bounds.bottom) };
    }
    const tapX = (b.left + b.right) / 2, tapY = (b.top + b.bottom) / 2;
    if (!viewport || tapX < viewport.left || tapX >= viewport.right || tapY < viewport.top || tapY >= viewport.bottom) throw new Error('target_center_outside_current_viewport');
    return { tapX, tapY, viewport };
  };
  const tap = async (selector) => {
    if (selector.text && [title, listTitle].includes(selector.text)) await revealOverview(selector.text);
    const { tapX, tapY } = await target(selector); return call('tap', { tapX, tapY, appLocalAction: true });
  };
  const inputSelector = async (selector, text) => { const { tapX, tapY } = await target(selector, true); return call('input-text', { tapX, tapY, text, appLocalAction: true }); };
  const input = async (name, text) => inputSelector({ resourceName: resource(name) }, text);
  const checkboxClasses = ['android.widget.CheckBox', 'androidx.appcompat.widget.AppCompatCheckBox', 'com.google.android.material.checkbox.MaterialCheckBox'];
  async function createAndAssignLabel(value) {
    if (typeof value !== 'string' || !value) throw new Error('exact_new_label_required');
    await tap({ contentDescription: '轻按查看更多选项' });
    await tap({ text: '标签' });
    await tap({ contentDescription: '添加标签' });
    await input('EditText', value);
    await call('keyevent', { keyCode: 111 });
    await tap({ text: '保存' });
    const ready = await observe((all, tree) => tree.activity === 'com.philkes.notallyx.presentation.activity.note.SelectLabelsActivity'
      && find(all, { resourceName: resource('EditText') }).length === 0
      && all.filter((node) => node.text === value && checkboxClasses.includes(node.className)).length === 1, 'new-label-checkbox-visible');
    const selected = nodes(ready.result).find((node) => node.text === value && checkboxClasses.includes(node.className));
    await tap({ text: value, className: selected.className });
    await call('keyevent', { keyCode: 4 });
  }
  const indent = async (text, deltaX) => {
    const { tapX, tapY, viewport } = await target({ text }, true);
    if (tapX + deltaX < viewport.left || tapX + deltaX >= viewport.right) throw new Error('swipe_endpoint_outside_current_viewport');
    return call('swipe', { startX: tapX, startY: tapY, endX: tapX + deltaX, endY: tapY, durationMs: 500 });
  };
  const editorMatches = (all, body) => find(all, { resourceName: resource('EnterTitle'), text: title }).length === 1
    && find(all, { resourceName: resource('EnterBody'), text: body }).length === 1;
  const overviewCard = (all, noteTitle = title) => {
    if (find(all, { resourceName: resource('Title'), text: noteTitle }).length !== 1) return [];
    const matches = all.filter((node) => node.className === 'com.google.android.material.card.MaterialCardView'
      && find(nodes({ root: node }), { resourceName: resource('Title'), text: noteTitle }).length === 1);
    return matches.length === 1 ? nodes({ root: matches[0] }) : [];
  };
  const overviewMatches = (all, body) => find(all, { resourceName: resource('TakeNote') }).length === 1
    && find(overviewCard(all), { resourceName: resource('Note'), text: body }).length === 1;
  async function revealOverview(noteTitle) {
    let previousOverview;
    let observed = await observe((all, tree) => { const current = stateKey(tree), stable = current === previousOverview; previousOverview = current;
      return stable && find(all, { resourceName: resource('TakeNote') }).length === 1
        && find(all, { resourceName: resource('Title'), text: noteTitle }).length <= 1;
    }, 'stable-overview-before-reveal');
    for (const direction of [-1, 1]) {
      for (let step = 0; step < 8; step++) {
        const all = nodes(observed.result);
        const viewport = find(all, { resourceName: resource('MainListView'), className: 'androidx.recyclerview.widget.RecyclerView' });
        const card = overviewCard(all, noteTitle)[0];
        if (viewport.length !== 1) throw new Error('unique_observed_overview_recycler_required');
        const b = viewport[0].bounds;
        if (!b || !(b.right > b.left && b.bottom > b.top)) throw new Error('overview_recycler_bounds_required');
        if (card?.bounds?.top >= b.top && card.bounds.bottom <= b.bottom) return;
        const x = (b.left + b.right) / 2, mid = (b.top + b.bottom) / 2, distance = Math.min(700, (b.bottom - b.top) * 0.4);
        const previous = stateKey(observed.result);
        await call('swipe', { startX: x, startY: mid - direction * distance / 2, endX: x, endY: mid + direction * distance / 2, durationMs: 400 });
        let last;
        observed = await observe((all, tree) => { const current = stateKey(tree), stable = current === last; last = current;
          return stable && find(all, { resourceName: resource('Title'), text: noteTitle }).length <= 1;
        }, 'overview-after-scroll');
        if (stateKey(observed.result) === previous) break;
      }
    }
    throw new Error(`overview_card_not_revealed:${noteTitle}`);
  }
  const listItems = (edited = false, child1 = false, child2 = false, checked = true) => [
    { body: 'Parent-A', isChild: false, checked: false }, { body: 'Child-A1', isChild: child1, checked: false },
    { body: edited ? 'Child-A2-edited' : 'Child-A2', isChild: child2, checked: false }, { body: 'Parent-B', isChild: false, checked },
  ];
  const listMatches = (all, screen, items) => {
    const scoped = screen === 'list-overview' ? overviewCard(all, listTitle) : all;
    if (find(scoped, { resourceName: resource(screen === 'list-editor' ? 'EnterTitle' : 'Title'), text: listTitle }).length !== 1) return false;
    const tasks = items.map((item) => find(scoped, { text: item.body, ...(screen === 'list-editor' ? { resourceName: resource('EditText'), editable: !item.checked } : {}) }));
    if (tasks.some((matches) => matches.length !== 1)) return false;
    if (screen === 'list-overview') return true;
    // EditText indices restart in the checked section; business markers are unique instead.
    if (scoped.filter((node) => node.resourceName === resource('EditText') && /^EditText\d+$/.test(node.contentDescription || '') && node.text).length !== 4) return false;
    for (const item of items) {
      const sections = find(scoped, { resourceName: resource(item.checked ? 'CheckedListView' : 'MainListView') });
      if (sections.length !== 1) return false;
      const section = nodes({ root: sections[0] });
      const task = find(section, { resourceName: resource('EditText'), text: item.body, editable: !item.checked });
      if (task.length !== 1 || task[0].focusable !== !item.checked || task[0].alpha !== (item.checked ? 0.5 : 1)) return false;
      const rows = section.filter((node) => node.resourceName === resource('Content') && find(nodes({ root: node }), { resourceName: resource('EditText'), text: item.body }).length === 1);
      if (rows.length !== 1 || find(nodes({ root: rows[0] }), { resourceName: resource('CheckBox'), className: 'com.google.android.material.checkbox.MaterialCheckBox' }).length !== 1) return false;
    }
    const parentLeft = tasks[0][0].bounds.left;
    return tasks.every(([node], index) => (items[index].isChild ? node.bounds.left > parentLeft : node.bounds.left === parentLeft)
      && (index === 0 || node.bounds.top > tasks[index - 1][0].bounds.top));
  };
  const labelsMatch = (all, expected) => {
    const lists = find(all, { resourceName: resource('MainListView') });
    if (lists.length !== 1 || find(all, { resourceName: resource('EditText') }).length || find(all, { contentDescription: '添加标签' }).length !== 1) return false;
    const listed = nodes({ root: lists[0] });
    return expected.present.every((value) => find(listed, { resourceName: resource('LabelText'), text: value }).length === 1
      && ['EditButton', 'DeleteButton'].every((control) => find(all, { resourceName: resource(control), withinLabel: value }).length === 1))
      && (expected.absent || []).every((value) => find(listed, { resourceName: resource('LabelText'), text: value }).length === 0);
  };
  const navigationMatches = (all, expected) => find(all, { resourceName: resource('Labels') }).filter(node =>
    find(nodes({ root: node }), { resourceName: resource('design_menu_item_text'), text: '标签' }).length === 1).length === 1
    && expected.present.every((value) => find(all, { resourceName: resource('design_menu_item_text'), text: value }).length === 1)
    && (expected.absent || []).every((value) => find(all, { resourceName: resource('design_menu_item_text'), text: value }).length === 0);
  const deleteDialogMatches = (all) => find(all, { resourceName: resource('alertTitle'), text: '删除标签？' }).length === 1
    && find(all, { resourceName: 'android:id/message', text: '不会删除与此标签相关联的笔记' }).length === 1
    && find(all, { resourceName: 'android:id/button2', text: '取消' }).length === 1
    && find(all, { resourceName: 'android:id/button1', text: '删除' }).length === 1
    && find(all, { resourceName: resource('LabelText') }).length === 0;
  const inputDialogMatches = (all, expected) => find(all, { resourceName: resource('alertTitle'), text: expected.title }).length === 1
    && find(all, { resourceName: resource('EditText'), text: expected.value, editable: true }).length === 1
    && find(all, { resourceName: 'android:id/button1', text: '保存' }).length === 1
    && find(all, { resourceName: 'android:id/button2', text: '取消' }).length === 1
    && find(all, { resourceName: resource('LabelText') }).length === 0;
  async function openLabelManagement() {
    await tap({ contentDescription: '打开抽屉式导航栏' });
    await tap({ resourceName: resource('design_menu_item_text'), text: '标签' });
    await observe((all, tree) => tree.activity === 'com.philkes.notallyx.presentation.activity.main.MainActivity'
      && find(all, { contentDescription: '添加标签' }).length === 1, 'label-management-visible');
  }
  async function checkpoint(name, screen, body, requiredSelectors = [], absentSelectors = []) {
    if (screen === 'overview' || screen === 'list-overview') await revealOverview(screen === 'overview' ? title : listTitle);
    const startedAtMs = Date.now();
    const scoped = (all) => screen.endsWith('overview') ? overviewCard(all, screen === 'list-overview' ? listTitle : title) : all;
    const predicate = (all, tree) => (screen === 'assignment-dialog' ? assignmentDialog(all, body) : screen === 'membership' ? membership(all, body)
      : screen === 'labels' ? labelsMatch(all, body) : screen === 'label-navigation' ? navigationMatches(all, body) : screen === 'label-delete-dialog' ? deleteDialogMatches(all)
      : screen === 'label-input-dialog' ? inputDialogMatches(all, body)
      : screen.startsWith('list-') ? listMatches(all, screen, body) : screen === 'editor' ? editorMatches(all, body) : overviewMatches(all, body))
      && (!['labels', 'label-navigation', 'label-delete-dialog', 'label-input-dialog', 'assignment-dialog', 'membership'].includes(screen) || tree.activity === 'com.philkes.notallyx.presentation.activity.main.MainActivity')
      && requiredSelectors.every((selector) => find(scoped(all), selector).length === 1)
      && absentSelectors.every((selector) => find(scoped(all), selector).length === 0);
    let previous;
    const observed = await observe((all, tree) => {
      const current = stateKey(tree); const stable = current === previous; previous = current;
      return predicate(all, tree) && stable;
    }, name);
    const treePath = path.join(out, `${name}.tree.json`);
    fs.writeFileSync(treePath, JSON.stringify(observed, null, 2));
    const assertion = await ctx.assert({ name, scope: 'device', condition: predicate(nodes(observed.result), observed.result),
      evidence: observed.evidence, requiredEvidence: ['tree'], requireCoverage: 'complete' });
    if (assertion.verdict !== 'passed') throw new Error(`strong_ui_assertion:${name}:${assertion.verdict}`);
    const screenshotPath = path.join(out, `${name}.png`);
    const screenshot = await call('screenshot', { outFile: screenshotPath });
    const screenshotResponsePath = path.join(out, `${name}.screenshot.json`);
    fs.writeFileSync(screenshotResponsePath, JSON.stringify(screenshot, null, 2));
    const screenshotAssertion = await ctx.assert({ name: `${name}-screenshot`, scope: 'device', condition: screenshot.result.foregroundMatchesPackage === true,
      evidence: screenshot.evidence, requiredEvidence: ['screenshot'], requireCoverage: 'complete' });
    if (screenshotAssertion.verdict !== 'passed') throw new Error(`screenshot_evidence_invalid:${name}`);
    const after = await call('tree');
    const afterTreePath = path.join(out, `${name}.after-tree.json`);
    fs.writeFileSync(afterTreePath, JSON.stringify(after, null, 2));
    const stableAssertion = await ctx.assert({ name: `${name}-after-screenshot`, scope: 'device', condition: predicate(nodes(after.result), after.result) && stateKey(observed.result) === stateKey(after.result),
      evidence: after.evidence, requiredEvidence: ['tree'], requireCoverage: 'complete' });
    result.checkpoints.push({ name, screen, body, treePath, afterTreePath, screenshotPath, screenshotResponsePath, startedAtMs, finishedAtMs: Date.now(),
      afterActionId: result.lastActionId, mutationSequence: result.mutations, assertion });
    if (stableAssertion.verdict !== 'passed') { save(); throw new Error(`ui_changed_during_screenshot:${name}`); }
    save();
  }
  function assignmentDialog(all, expected) {
    return find(all, { resourceName: resource('alertTitle'), text: '标签' }).length === 1
      && ['取消', '保存'].every(text => find(all, { text }).length === 1)
      && expected.labels.every(text => find(all, { resourceName: resource('Text'), text }).length === 1);
  }
  function membership(all, expected) {
    const toolbar = find(all, { resourceName: resource('Toolbar') });
    const titles = all.filter(n => n.resourceName === resource('Title')).map(n => n.text).sort();
    return toolbar.length === 1 && find(nodes({ root: toolbar[0] }), { text: expected.title }).length === 1
      && find(all, { resourceName: resource('MainListView') }).length === 1
      && JSON.stringify(titles) === JSON.stringify([...expected.titles].sort());
  }
  async function openAssignment() {
    await revealOverview(title);
    const { tapX, tapY } = await target({ resourceName: resource('Title'), text: title });
    // Android's mechanical long press is a stationary swipe, as used by Intent's longPress port.
    await call('swipe', { startX: tapX, startY: tapY, endX: tapX, endY: tapY, durationMs: 700 });
    await observe(all => find(all, { text: '1' }).length === 1 && find(all, { contentDescription: '全选' }).length === 1, 'one-selected');
    await tap({ resourceName: resource('Title'), text: listTitle });
    await observe(all => find(all, { text: '2' }).length === 1 && find(all, { contentDescription: '全选' }).length === 1, 'two-selected');
    await tap({ contentDescription: '标签' });
  }
  async function visitAssignmentMembership(prefix) {
    for (const [name, pageTitle, titles] of [
      ['common', assignmentCommon, assignmentMembers.common], ['unlabeled', '未加标签', assignmentMembers.unlabeled],
    ]) {
      await tap({ contentDescription: '打开抽屉式导航栏' });
      await tap({ resourceName: resource('design_menu_item_text'), text: pageTitle });
      await checkpoint(`${prefix}-${name}-members`, 'membership', { title: pageTitle, titles });
    }
    await tap({ contentDescription: '打开抽屉式导航栏' });
    await tap({ resourceName: resource('design_menu_item_text'), text: '笔记' });
  }
  try {
    if (phase.startsWith('assignment-')) {
      if (!assignmentCommon || [label, labelAb].includes(assignmentCommon)) throw new Error('distinct_assignment_common_label_required');
      if (phase === 'assignment-cancel' || phase === 'assignment-apply') {
        await openAssignment();
        await checkpoint(`${phase}-initial`, 'assignment-dialog', { labels: [label, labelAb, assignmentCommon] });
        await tap({ resourceName: resource('Text'), text: labelAb });
        await tap({ resourceName: resource('Text'), text: assignmentCommon });
        await checkpoint(`${phase}-changed`, 'assignment-dialog', { labels: [label, labelAb, assignmentCommon] });
        await tap({ text: phase === 'assignment-cancel' ? '取消' : '保存' });
        if (phase === 'assignment-cancel') await call('keyevent', { keyCode: 4 });
        const common = phase === 'assignment-apply' ? assignmentCommon : null;
        await checkpoint(`${phase}-text`, 'overview', editedBody, [{ text: label }, ...(common ? [{ text: common }] : [])], [{ text: labelAb }, ...(!common ? [{ text: assignmentCommon }] : [])]);
        await checkpoint(`${phase}-list`, 'list-overview', listItems(true, true, true), [{ text: common || labelAb }], [{ text: label }, { text: common ? labelAb : assignmentCommon }]);
      } else if (phase === 'assignment-remove') {
        await tap({ resourceName: resource('Title'), text: listTitle });
        await checkpoint('assignment-before-remove', 'list-editor', listItems(true, true, true), [{ text: assignmentCommon }], [{ text: labelAb }]);
        await tap({ contentDescription: '轻按查看更多选项' }); await tap({ text: '标签' });
        await tap({ text: assignmentCommon }); await call('keyevent', { keyCode: 4 });
        await checkpoint('assignment-removed-editor', 'list-editor', listItems(true, true, true), [], [label, labelAb, assignmentCommon].map(text => ({ text })));
        await call('keyevent', { keyCode: 4 });
        await checkpoint('assignment-removed-overview', 'list-overview', listItems(true, true, true), [], [label, labelAb, assignmentCommon].map(text => ({ text })));
        await visitAssignmentMembership('assignment');
      } else if (phase === 'assignment-restart') {
        await checkpoint('assignment-restart-text', 'overview', editedBody, [{ text: label }, { text: assignmentCommon }], [{ text: labelAb }]);
        await checkpoint('assignment-restart-list', 'list-overview', listItems(true, true, true), [], [label, labelAb, assignmentCommon].map(text => ({ text })));
        await visitAssignmentMembership('assignment-restart');
      } else throw new Error(`unknown_assignment_phase:${phase}`);
    } else if (phase === 'create') {
      await tap({ resourceName: resource('TakeNote') });
      await input('EnterTitle', title); await input('EnterBody', originalBody);
      await checkpoint('created-editor', 'editor', originalBody);
      await call('keyevent', { keyCode: 111 }); await call('keyevent', { keyCode: 4 });
      await checkpoint('created-overview', 'overview', originalBody);
    } else if (phase === 'edit') {
      await tap({ text: title });
      await checkpoint('reopened-editor', 'editor', originalBody);
      await input('EnterBody', editedBody);
      await checkpoint('edited-editor', 'editor', editedBody);
      await call('keyevent', { keyCode: 111 }); await call('keyevent', { keyCode: 4 });
      await checkpoint('edited-overview', 'overview', editedBody);
    } else if (phase === 'restart') {
      await checkpoint('restart-overview', 'overview', editedBody);
      await tap({ text: title });
      await checkpoint('restart-editor', 'editor', editedBody);
      await call('keyevent', { keyCode: 111 }); await call('keyevent', { keyCode: 4 });
      await checkpoint('restart-returned', 'overview', editedBody);
    } else if (phase === 'organize') {
      if (typeof label !== 'string' || !label) throw new Error('unique_label_required');
      await tap({ text: title });
      await tap({ contentDescription: '置于顶部' });
      await tap({ contentDescription: '轻按查看更多选项' });
      await tap({ text: '标签' });
      await tap({ contentDescription: '添加标签' });
      await input('EditText', label);
      await call('keyevent', { keyCode: 111 });
      await tap({ text: '保存' });
      const checkboxClasses = ['android.widget.CheckBox', 'androidx.appcompat.widget.AppCompatCheckBox', 'com.google.android.material.checkbox.MaterialCheckBox'];
      const savedLabels = await observe((all, tree) => tree.activity === 'com.philkes.notallyx.presentation.activity.note.SelectLabelsActivity'
        && find(all, { resourceName: resource('EditText') }).length === 0
        && all.filter((node) => node.text === label && checkboxClasses.includes(node.className)).length === 1, 'label-dialog-closed-and-checkbox-visible');
      const labelCheckbox = nodes(savedLabels.result).find((node) => node.text === label && checkboxClasses.includes(node.className));
      await tap({ text: label, className: labelCheckbox.className });
      await call('keyevent', { keyCode: 4 });
      await checkpoint('label-pinned-editor', 'editor', editedBody, [{ text: label }, { contentDescription: '取消固定' }]);
      await tap({ contentDescription: '轻按查看更多选项' });
      await tap({ text: '更改色彩' });
      const choices = await observe((all) => find(all, { contentDescription: '#AFCCDC' }).length === 1 || find(all, { contentDescription: 'NEW' }).length === 1, 'color-choices');
      if (find(nodes(choices.result), { contentDescription: '#AFCCDC' }).length === 1) {
        result.colorBranch = 'existing-palette-color';
        await tap({ contentDescription: '#AFCCDC' });
      } else {
        result.colorBranch = 'new-palette-color';
        await tap({ contentDescription: 'NEW' });
        await tap({ contentDescription: '#AFCCDC' });
        await observe((all) => find(all, { resourceName: resource('ColorCode'), text: 'AFCCDC' }).length === 1, 'selected-color-code');
        await tap({ text: '保存' });
      }
      await checkpoint('organized-editor', 'editor', editedBody, [{ text: label }, { contentDescription: '取消固定' }]);
      await call('keyevent', { keyCode: 4 });
      await checkpoint('organized-overview', 'overview', editedBody, [{ text: label }]);
    } else if (phase === 'list-create') {
      if (typeof listTitle !== 'string' || !listTitle) throw new Error('unique_list_title_required');
      await tap({ resourceName: resource('MakeList') });
      await input('EnterTitle', listTitle);
      for (const [index, text] of ['Parent-A', 'Child-A1', 'Child-A2', 'Parent-B'].entries()) {
        if (index) await tap({ text: '添加项目' });
        await inputSelector({ contentDescription: `EditText${index}` }, text);
        await call('keyevent', { keyCode: 111 });
      }
      await checkpoint('list-created-flat-editor', 'list-editor', listItems(false, false, false, false));
      await call('keyevent', { keyCode: 4 });
      await checkpoint('list-created-flat-overview', 'list-overview', listItems(false, false, false, false));
      await tap({ resourceName: resource('Title'), text: listTitle });
      await checkpoint('list-reopened-flat-editor', 'list-editor', listItems(false, false, false, false));
      await tap({ contentDescription: 'CheckBox3' });
      await checkpoint('list-checked-editor', 'list-editor', listItems());
      await call('keyevent', { keyCode: 4 });
      await checkpoint('list-checked-overview', 'list-overview', listItems());
    } else if (phase === 'list-hierarchy') {
      await tap({ resourceName: resource('Title'), text: listTitle });
      await indent('Child-A1', 300);
      await checkpoint('list-first-child', 'list-editor', listItems(false, true, false));
      await indent('Child-A2', 300);
      await checkpoint('list-two-children', 'list-editor', listItems(false, true, true));
      await inputSelector({ text: 'Child-A2' }, 'Child-A2-edited');
      await call('keyevent', { keyCode: 111 });
      await checkpoint('list-child-edited', 'list-editor', listItems(true, true, true));
      await indent('Child-A1', -300);
      await checkpoint('list-child-outdented', 'list-editor', listItems(true, false, true));
      await indent('Child-A1', 300);
      await checkpoint('list-child-restored', 'list-editor', listItems(true, true, true));
      await call('keyevent', { keyCode: 4 });
      await checkpoint('list-hierarchy-overview', 'list-overview', listItems(true, true, true));
      await tap({ resourceName: resource('Title'), text: listTitle });
      await checkpoint('list-hierarchy-reopened', 'list-editor', listItems(true, true, true));
      await call('keyevent', { keyCode: 4 });
      await checkpoint('list-hierarchy-returned', 'list-overview', listItems(true, true, true));
    } else if (phase === 'list-restart') {
      await checkpoint('list-restart-overview', 'list-overview', listItems(true, true, true));
      await tap({ resourceName: resource('Title'), text: listTitle });
      await checkpoint('list-restart-editor', 'list-editor', listItems(true, true, true));
      await call('keyevent', { keyCode: 4 });
      await checkpoint('list-restart-returned', 'list-overview', listItems(true, true, true));
    } else if (phase === 'labels-prepare') {
      if (!labelA || !labelAb || labelA === labelAb) throw new Error('two_distinct_exact_labels_required');
      await tap({ resourceName: resource('Title'), text: title });
      await createAndAssignLabel(labelA);
      await checkpoint('labels-text-assigned-editor', 'editor', editedBody, [{ text: label }, { text: labelA }]);
      await call('keyevent', { keyCode: 4 });
      await checkpoint('labels-text-assigned-overview', 'overview', editedBody, [{ text: label }, { text: labelA }]);
      await tap({ resourceName: resource('Title'), text: listTitle });
      await createAndAssignLabel(labelAb);
      await checkpoint('labels-list-assigned-editor', 'list-editor', listItems(true, true, true), [{ text: labelAb }]);
      await call('keyevent', { keyCode: 4 });
      await checkpoint('labels-list-assigned-overview', 'list-overview', listItems(true, true, true), [{ text: labelAb }]);
    } else if (phase === 'labels-duplicate') {
      await openLabelManagement();
      await checkpoint('labels-before-duplicate', 'labels', { present: [label, labelA, labelAb] });
      await tap({ contentDescription: '添加标签' });
      await input('EditText', labelA); await call('keyevent', { keyCode: 111 });
      await checkpoint('labels-duplicate-input', 'label-input-dialog', { title: '添加标签', value: labelA });
      await tap({ text: '保存' });
      await checkpoint('labels-duplicate-rejected', 'labels', { present: [label, labelA, labelAb] });
    } else if (phase === 'labels-conflict') {
      await openLabelManagement();
      await checkpoint('labels-before-conflict', 'labels', { present: [label, labelA, labelAb] });
      await tap({ resourceName: resource('EditButton'), withinLabel: labelA });
      await checkpoint('labels-conflict-original-dialog', 'label-input-dialog', { title: '编辑标签', value: labelA });
      await input('EditText', labelAb); await call('keyevent', { keyCode: 111 });
      await checkpoint('labels-conflict-input', 'label-input-dialog', { title: '编辑标签', value: labelAb });
      await tap({ text: '保存' });
      await checkpoint('labels-rename-conflict-rejected', 'labels', { present: [label, labelA, labelAb] });
    } else if (phase === 'labels-rename') {
      if (!labelRenamed || [labelA, labelAb, label].includes(labelRenamed)) throw new Error('distinct_new_label_name_required');
      await openLabelManagement();
      await tap({ resourceName: resource('EditButton'), withinLabel: labelA });
      await observe((all) => find(all, { resourceName: resource('EditText'), text: labelA, editable: true }).length === 1, 'rename-dialog-original-a');
      await input('EditText', labelRenamed); await call('keyevent', { keyCode: 111 });
      await tap({ text: '保存' });
      await checkpoint('labels-renamed-manager', 'labels', { present: [label, labelRenamed, labelAb], absent: [labelA] });
      await tap({ contentDescription: '打开抽屉式导航栏' });
      await checkpoint('labels-renamed-navigation', 'label-navigation', { present: [label, labelRenamed, labelAb], absent: [labelA] });
      await tap({ resourceName: resource('Notes') });
      await tap({ resourceName: resource('Title'), text: title });
      await checkpoint('labels-renamed-text', 'editor', editedBody, [{ text: label }, { text: labelRenamed }], [{ text: labelA }, { text: labelAb }]);
      await call('keyevent', { keyCode: 4 });
      await tap({ resourceName: resource('Title'), text: listTitle });
      await checkpoint('labels-renamed-list', 'list-editor', listItems(true, true, true), [{ text: labelAb }], [{ text: labelA }, { text: labelRenamed }]);
      await call('keyevent', { keyCode: 4 });
    } else if (phase === 'labels-cancel-delete') {
      await openLabelManagement();
      await checkpoint('labels-before-cancel', 'labels', { present: [label, labelRenamed, labelAb], absent: [labelA] });
      await tap({ resourceName: resource('DeleteButton'), withinLabel: labelRenamed });
      await checkpoint('labels-cancel-dialog', 'label-delete-dialog', 'delete-label-confirmation');
      await tap({ resourceName: 'android:id/button2', text: '取消' });
      await checkpoint('labels-delete-cancelled', 'labels', { present: [label, labelRenamed, labelAb], absent: [labelA] });
    } else if (phase === 'labels-delete') {
      await openLabelManagement();
      await checkpoint('labels-before-delete', 'labels', { present: [label, labelRenamed, labelAb], absent: [labelA] });
      await tap({ resourceName: resource('DeleteButton'), withinLabel: labelRenamed });
      await checkpoint('labels-confirm-delete-dialog', 'label-delete-dialog', 'delete-label-confirmation');
      await tap({ resourceName: 'android:id/button1', text: '删除' });
      await checkpoint('labels-deleted-manager', 'labels', { present: [label, labelAb], absent: [labelA, labelRenamed] });
      await tap({ contentDescription: '打开抽屉式导航栏' });
      await checkpoint('labels-deleted-navigation', 'label-navigation', { present: [label, labelAb], absent: [labelA, labelRenamed] });
      await tap({ resourceName: resource('Notes') });
      // Actual Intent found transient duplicate Recycler rows here. Wait for exact current card state before dispatch.
      await checkpoint('labels-deleted-text-overview', 'overview', editedBody, [{ text: label }], [{ text: labelA }, { text: labelRenamed }, { text: labelAb }]);
      await tap({ resourceName: resource('Title'), text: title });
      await checkpoint('labels-deleted-text', 'editor', editedBody, [{ text: label }], [{ text: labelA }, { text: labelRenamed }, { text: labelAb }]);
      await call('keyevent', { keyCode: 4 });
      await checkpoint('labels-deleted-list-overview', 'list-overview', listItems(true, true, true), [{ text: labelAb }], [{ text: labelA }, { text: labelRenamed }, { text: label }]);
      await tap({ resourceName: resource('Title'), text: listTitle });
      await checkpoint('labels-deleted-list', 'list-editor', listItems(true, true, true), [{ text: labelAb }], [{ text: labelA }, { text: labelRenamed }, { text: label }]);
      await call('keyevent', { keyCode: 4 });
    } else if (phase === 'labels-restart') {
      await checkpoint('labels-restart-text-overview', 'overview', editedBody, [{ text: label }], [{ text: labelA }, { text: labelRenamed }, { text: labelAb }]);
      await checkpoint('labels-restart-list-overview', 'list-overview', listItems(true, true, true), [{ text: labelAb }], [{ text: labelA }, { text: labelRenamed }, { text: label }]);
      await openLabelManagement();
      await checkpoint('labels-restart-manager', 'labels', { present: [label, labelAb], absent: [labelA, labelRenamed] });
      await tap({ contentDescription: '打开抽屉式导航栏' });
      await checkpoint('labels-restart-navigation', 'label-navigation', { present: [label, labelAb], absent: [labelA, labelRenamed] });
      await tap({ resourceName: resource('Notes') });
      await tap({ resourceName: resource('Title'), text: title });
      await checkpoint('labels-restart-text', 'editor', editedBody, [{ text: label }], [{ text: labelA }, { text: labelRenamed }, { text: labelAb }]);
      await call('keyevent', { keyCode: 4 });
      await tap({ resourceName: resource('Title'), text: listTitle });
      await checkpoint('labels-restart-list', 'list-editor', listItems(true, true, true), [{ text: labelAb }], [{ text: labelA }, { text: labelRenamed }, { text: label }]);
      await call('keyevent', { keyCode: 4 });
    } else throw new Error(`unsupported_phase:${phase}`);
    result.status = 'completed'; result.finishedAtMs = Date.now(); save(); return result;
  } catch (error) { result.status = 'failed'; result.error = error.message; result.finishedAtMs = Date.now(); save(); throw error; }
};
