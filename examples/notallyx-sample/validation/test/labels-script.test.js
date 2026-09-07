'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createScriptSupervisor } = require('../../../../desktop/ai-app-bridge-cli/bin/script/script-supervisor');
const { hashFile } = require('../oracles');
const pkg = 'io.github.mobileaidev.notallyx.sample';
const visible = { visible: true, effectiveVisible: true, enabled: true, alpha: 1 };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7G8AAAAASUVORK5CYII=', 'base64');

test('all seven label phases execute through real Node Script children against an explicit UI state machine', async (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'notallyx-label-script-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const names = { title: 'Text Unique', listTitle: 'List Unique', label: 'Project', labelA: 'Prefix-a', labelAb: 'Prefix-ab', labelRenamed: 'Prefix-renamed', editedBody: '正文-edited' };
  const state = { scene: 'overview', active: 0, labels: ['Project'], notes: [['Project'], []], input: '', dialog: null, returnTo: null, keyboard: false, row: null };
  const commands = [], checkpoints = [], selectedRows = [], phases = ['labels-prepare', 'labels-duplicate', 'labels-conflict', 'labels-rename', 'labels-cancel-delete', 'labels-delete', 'labels-restart'];
  let noopInput = false, saves = 0; const attemptedInputs = [];
  const bounds = (left, top, right = 1000, bottom = top + 100) => ({ left, top, right, bottom });
  const n = (props, b = bounds(0, 0)) => ({ ...visible, bounds: b, ...props });
  const res = (name) => `${pkg}:id/${name}`;
  const control = (fixtureAction, props, b) => n({ ...props, fixtureAction, clickable: true }, b);
  const chips = (which, top) => state.notes[which].map((text, index) => n({ text }, bounds(50, top + index * 70, 900, top + index * 70 + 60)));
  const itemNames = ['Parent-A', 'Child-A1', 'Child-A2-edited', 'Parent-B'];
  const tasks = () => itemNames.map((text, index) => n({ resourceName: res('EditText'), className: 'EditTextAutoClearFocus', text, contentDescription: `EditText${index === 3 ? 0 : index}`,
    editable: index !== 3, focusable: index !== 3, alpha: index === 3 ? 0.5 : 1 }, bounds(index === 1 || index === 2 ? 360 : 300, 650 + index * 150)));
  function tree() {
    let children, activity = 'com.philkes.notallyx.presentation.activity.main.MainActivity';
    if (state.scene === 'delete-dialog') children = [n({ resourceName: res('alertTitle'), text: '删除标签？' }),
      n({ resourceName: 'android:id/message', text: '不会删除与此标签相关联的笔记' }),
      control('cancel-delete', { resourceName: 'android:id/button2', text: '取消' }, bounds(100, 900, 300)), control('confirm-delete', { resourceName: 'android:id/button1', text: '删除' }, bounds(600, 900, 800))];
    else if (state.scene === 'input-dialog') children = [n({ resourceName: res('alertTitle'), text: state.dialog === 'create' ? '添加标签' : '编辑标签' }),
      n({ resourceName: res('EditText'), text: state.input, editable: true }, bounds(100, 300, 900)),
      n({ resourceName: 'android:id/button2', text: '取消' }, bounds(100, state.keyboard ? 650 : 1100, 300)),
      control('save-label', { resourceName: 'android:id/button1', text: '保存' }, bounds(700, state.keyboard ? 650 : 1100, 900))];
    else if (state.scene === 'menu') { activity = state.active ? 'com.philkes.notallyx.presentation.activity.note.EditListActivity' : 'com.philkes.notallyx.presentation.activity.note.EditNoteActivity';
      children = [control('select-labels', { text: '标签' }, bounds(100, 1100, 800))]; }
    else if (state.scene === 'select') { activity = 'com.philkes.notallyx.presentation.activity.note.SelectLabelsActivity';
      children = [control('add-label', { contentDescription: '添加标签' }, bounds(900, 0, 1000)), ...[...state.labels].sort().map((text, index) => control(`toggle:${text}`,
        { text, className: 'android.widget.CheckBox' }, bounds(50, 200 + index * 140, 1000)))]; }
    else if (state.scene === 'editor') {
      activity = state.active ? 'com.philkes.notallyx.presentation.activity.note.EditListActivity' : 'com.philkes.notallyx.presentation.activity.note.EditNoteActivity';
      children = [n({ resourceName: res('EnterTitle'), text: state.active ? names.listTitle : names.title, editable: true }, bounds(0, 100)), ...chips(state.active, 250),
        control('menu', { contentDescription: '轻按查看更多选项' }, bounds(950, 2250, 1050))];
      if (!state.active) children.push(n({ resourceName: res('EnterBody'), text: names.editedBody, editable: true }, bounds(0, 600)));
      else for (const checked of [false, true]) children.push(n({ resourceName: res(checked ? 'CheckedListView' : 'MainListView'), children: tasks().filter((ignored, i) => (i === 3) === checked).map((task) => n({ resourceName: res('Content'), children: [task,
        n({ resourceName: res('CheckBox'), className: 'com.google.android.material.checkbox.MaterialCheckBox' })] })) }));
    } else if (state.scene === 'drawer') children = [control('home', { resourceName: res('Notes') }, bounds(0, 100, 900)), control('management', { resourceName: res('Labels'), children: [n({ resourceName: res('design_menu_item_text'), text: '标签' }, bounds(0, 250, 900))] }, bounds(0, 250, 900)),
      control('wrong-more-entry', { resourceName: res('Labels'), children: [n({ resourceName: res('design_menu_item_text'), text: '另 2 个' }, bounds(0, 1600, 900))] }, bounds(0, 1600, 900)),
      ...state.labels.map((text, index) => n({ resourceName: res('design_menu_item_text'), text }, bounds(0, 400 + index * 140, 900)))];
    else if (state.scene === 'management') children = [control('drawer', { contentDescription: '打开抽屉式导航栏' }, bounds(0, 0, 100)), control('add-label', { contentDescription: '添加标签' }, bounds(900, 0, 1000)),
      n({ resourceName: res('MainListView'), children: state.labels.map((text, index) => n({ className: 'android.widget.LinearLayout', children: [n({ resourceName: res('LabelText'), text }, bounds(0, 200 + index * 150, 650)),
        control(`edit:${text}`, { resourceName: res('EditButton') }, bounds(700, 200 + index * 150, 800)), control(`delete:${text}`, { resourceName: res('DeleteButton') }, bounds(850, 200 + index * 150, 1000))] }, bounds(0, 200 + index * 150))) }, bounds(0, 150, 1080, 2100))];
    else children = [control('drawer', { contentDescription: '打开抽屉式导航栏' }, bounds(0, 0, 100)), n({ resourceName: res('TakeNote') }, bounds(950, 2250, 1050)),
      n({ resourceName: res('MainListView'), className: 'androidx.recyclerview.widget.RecyclerView' }, bounds(0, 150, 1080, 2200)),
      n({ className: 'com.google.android.material.card.MaterialCardView', children: [control('open-text', { resourceName: res('Title'), text: names.title }, bounds(0, 200)),
        n({ resourceName: res('Note'), text: names.editedBody }, bounds(0, 330)), ...chips(0, 440)] }, bounds(0, 180, 1080, 700)),
      n({ className: 'com.google.android.material.card.MaterialCardView', children: [control('open-list', { resourceName: res('Title'), text: names.listTitle }, bounds(0, 850)),
        ...itemNames.map((text, index) => n({ text }, bounds(index === 1 || index === 2 ? 160 : 100, 970 + index * 70))), ...chips(1, 1300)] }, bounds(0, 800, 1080, 1450))];
    return { activity, root: n({ children }, bounds(0, 0, 1080, 2400)) };
  }
  function dispatch(action) {
    if (action === 'drawer') state.scene = 'drawer';
    else if (action === 'management') state.scene = 'management';
    else if (action === 'home') state.scene = 'overview';
    else if (action === 'open-text' || action === 'open-list') { state.active = action === 'open-text' ? 0 : 1; state.scene = 'editor'; }
    else if (action === 'menu') state.scene = 'menu';
    else if (action === 'select-labels') state.scene = 'select';
    else if (action === 'add-label') { state.returnTo = state.scene; state.scene = 'input-dialog'; state.dialog = 'create'; state.input = ''; }
    else if (action.startsWith('toggle:')) { const value = action.slice(7), labels = state.notes[state.active]; state.notes[state.active] = labels.includes(value) ? labels.filter((x) => x !== value) : [...labels, value]; }
    else if (action.startsWith('edit:')) { state.row = action.slice(5); selectedRows.push(state.row); state.returnTo = state.scene; state.scene = 'input-dialog'; state.dialog = 'rename'; state.input = state.row; }
    else if (action === 'save-label') { saves++; assert.equal(state.keyboard, false, 'keyboard geometry must settle before Save'); if (!state.labels.includes(state.input)) {
      if (state.dialog === 'create') state.labels.push(state.input);
      else { state.labels = state.labels.map((x) => x === state.row ? state.input : x); state.notes = state.notes.map((labels) => labels.map((x) => x === state.row ? state.input : x)); }
    } state.scene = state.returnTo; }
    else if (action.startsWith('delete:')) { state.row = action.slice(7); selectedRows.push(state.row); state.scene = 'delete-dialog'; }
    else if (action === 'cancel-delete') state.scene = 'management';
    else if (action === 'confirm-delete') { state.labels = state.labels.filter((x) => x !== state.row); state.notes = state.notes.map((labels) => labels.filter((x) => x !== state.row)); state.scene = 'management'; }
    else throw new Error(`unsupported simulated UI control:${action}`);
  }
  const actions = async (command, args) => {
    commands.push(command);
    if (command === 'tree') return tree();
    if (command === 'screenshot') { fs.writeFileSync(args.outFile, PNG); return { ok: true, path: args.outFile, foregroundMatchesPackage: true, artifact: { sha256: hashFile(args.outFile) } }; }
    if (command === 'input-text') { assert.equal(state.scene, 'input-dialog'); attemptedInputs.push({ requested: args.text, before: state.input, noopInput }); if (!noopInput) state.input = args.text; state.keyboard = true; return { ok: true }; }
    if (command === 'keyevent') { if (args.keyCode === 111) state.keyboard = false; else { assert.equal(args.keyCode, 4); state.scene = state.scene === 'select' ? 'editor' : 'overview'; } return { ok: true }; }
    if (command === 'tap') {
      const found = []; const walk = (node) => { if (node.fixtureAction && args.tapX >= node.bounds.left && args.tapX < node.bounds.right && args.tapY >= node.bounds.top && args.tapY < node.bounds.bottom) found.push(node); (node.children || []).forEach(walk); };
      walk(tree().root); assert.equal(found.length, 1, `current unique control at ${args.tapX},${args.tapY}`); dispatch(found[0].fixtureAction); return { ok: true };
    }
    throw new Error(`unexpected mechanical command:${command}`);
  };
  for (const phase of phases) {
    state.scene = 'overview'; // Explicit simulated controller launch; business state remains intact.
    const directory = path.join(out, phase); fs.mkdirSync(directory);
    const supervisor = createScriptSupervisor();
    let current = await supervisor.handle({ operation: 'start', actions, script: { schemaVersion: 'aab.code-script/v1', language: 'javascript', name: 'labels-ui-state-machine',
      sourcePath: path.resolve(__dirname, '../regression-script.js'), target: { serial: 'simulation', packageName: pkg },
      inputs: { out: directory, runId: 'offline-seven-label-phases', phase, ...names }, policy: { timeoutMs: 12000, onFailure: 'fail', restartPolicy: 'none' } } });
    const deadline = Date.now() + 15000;
    while (!['completed', 'failed', 'cancelled'].includes(current.status) && Date.now() < deadline) current = await supervisor.handle({ operation: 'wait', operationId: current.operationId, waitMs: 100, afterSequence: current.eventSequence });
    assert.equal(current.status, 'completed', JSON.stringify({ phase, status: current.status, error: current.error }));
    checkpoints.push(...JSON.parse(fs.readFileSync(path.join(directory, 'result.json'))).checkpoints);
  }
  assert.equal(checkpoints.length, 32);
  assert.deepEqual(state.labels, ['Project', 'Prefix-ab']); assert.deepEqual(state.notes, [['Project'], ['Prefix-ab']]);
  assert.deepEqual(selectedRows, ['Prefix-a', 'Prefix-a', 'Prefix-renamed', 'Prefix-renamed']);
  assert(!commands.includes('intent') && !commands.includes('batch'));
  // A mechanical success receipt must not turn A->A same-name save into a successful A->Ab rejection.
  for (const phase of ['labels-duplicate', 'labels-conflict']) {
    Object.assign(state, { scene: 'overview', labels: ['Project', 'Prefix-a', 'Prefix-ab'], notes: [['Project', 'Prefix-a'], ['Prefix-ab']], keyboard: false });
    noopInput = true; const previousSaves = saves, previousInputs = attemptedInputs.length, directory = path.join(out, `${phase}-noop`); fs.mkdirSync(directory);
    const supervisor = createScriptSupervisor();
    let current = await supervisor.handle({ operation: 'start', actions, script: { schemaVersion: 'aab.code-script/v1', language: 'javascript', name: 'input-noop-negative',
      sourcePath: path.resolve(__dirname, '../regression-script.js'), target: { serial: 'simulation', packageName: pkg },
      inputs: { out: directory, runId: 'offline-input-noop', phase, ...names }, policy: { timeoutMs: 2500, onFailure: 'fail', restartPolicy: 'none' } } });
    const deadline = Date.now() + 5000;
    while (!['completed', 'failed', 'cancelled'].includes(current.status) && Date.now() < deadline) current = await supervisor.handle({ operation: 'wait', operationId: current.operationId, waitMs: 100, afterSequence: current.eventSequence });
    assert.equal(current.status, 'failed', `${phase} must not pass when input did not change`); assert.equal(saves, previousSaves, 'Save must never dispatch with unverified input text');
    assert.equal(attemptedInputs.length, previousInputs + 1, 'the successful noop input receipt was actually exercised');
    assert.deepEqual(attemptedInputs.at(-1), { requested: phase === 'labels-conflict' ? names.labelAb : names.labelA, before: phase === 'labels-conflict' ? names.labelA : '', noopInput: true });
  }
  for (const foreground of [{ visible: true, effectiveVisible: true, enabled: false }, { enabled: true }]) {
    state.scene = 'overview'; let dispatched = 0;
    const blockedActions = async (command) => { if (command === 'tree') { const background = tree(); return { activity: background.activity, windows: [{ index: 0, root: background.root }, { index: 1, root: foreground }] }; }
      dispatched++; throw new Error('must not dispatch against background'); };
    const directory = fs.mkdtempSync(path.join(out, 'blocked-top-')), supervisor = createScriptSupervisor();
    let current = await supervisor.handle({ operation: 'start', actions: blockedActions, script: { schemaVersion: 'aab.code-script/v1', language: 'javascript', name: 'blocked-foreground',
      sourcePath: path.resolve(__dirname, '../regression-script.js'), target: { serial: 'simulation', packageName: pkg }, inputs: { out: directory, runId: 'blocked-top', phase: 'labels-duplicate', ...names },
      policy: { timeoutMs: 700, onFailure: 'fail', restartPolicy: 'none' } } });
    const deadline = Date.now() + 2000;
    while (!['completed', 'failed', 'cancelled'].includes(current.status) && Date.now() < deadline) current = await supervisor.handle({ operation: 'wait', operationId: current.operationId, waitMs: 100, afterSequence: current.eventSequence });
    assert.equal(current.status, 'failed'); assert.equal(dispatched, 0);
  }
});
