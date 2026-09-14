'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ROOT = path.resolve(__dirname, '../../../..');
const validation = path.join(ROOT, 'examples/notallyx-sample/validation');
const { checkTextUi, visibleNodes, noteCardNodes, listContentMatches, labelContentMatches } = require(path.join(validation, 'ui-oracles'));
const { hashFile } = require(path.join(validation, 'oracles'));
const { createScriptHostPort } = require(path.join(ROOT, 'desktop/ai-app-bridge-cli/bin/script/script-host-port'));
const { parseArguments, apkPackage } = require(path.join(validation, 'run-regression'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7G8AAAAASUVORK5CYII=', 'base64');
const pkg = 'io.github.mobileaidev.notallyx.sample';
const visible = { visible: true, effectiveVisible: true, enabled: true };
const makeNode = (resourceName, text) => ({ ...visible, resourceName: `${pkg}:id/${resourceName}`, text, editable: true, bounds: { left: 0, top: 0, right: 100, bottom: 100 } });
async function fixture(t, suppliedTree, { screenshotActivity, afterTree } = {}) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-ui-oracle-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const png = path.join(out, 'screen.png'); fs.writeFileSync(png, PNG);
  const tree = suppliedTree || { root: { ...visible, children: [makeNode('EnterTitle', 'Unique'), makeNode('EnterBody', '正确正文')] } };
  tree.activity ||= 'example.EditorActivity';
  const target = { platform: 'android', serial: 'simulation', packageName: pkg };
  const phaseStartedAtMs = Date.now();
  let treeReads = 0;
  const host = createScriptHostPort({ target: { platform: 'android', serial: 'simulation', packageName: pkg }, executionId: 'script-simulation', actions: async (command) => {
    if (command === 'tree') return ++treeReads > 1 && afterTree ? afterTree : tree;
    if (command === 'screenshot') return { ok: true, path: png, foregroundMatchesPackage: true, artifact: { sha256: hashFile(png) }, width: 1, height: 1, foreground: { packageName: pkg, activity: screenshotActivity || tree.activity } };
    throw new Error('No device mutation allowed in fixture');
  } });
  const response = await host.call('tree');
  const screenshot = await host.call('screenshot');
  const after = await host.call('tree');
  const events = [], history = [];
  for (const [name, command, observed] of [['editor', 'tree', response], ['editor-screenshot', 'screenshot', screenshot], ['editor-after-screenshot', 'tree', after]]) {
    assert.equal((await host.assert({ name, scope: 'device', condition: true, evidence: observed.evidence })).verdict, 'passed');
    events.push({ type: 'assertion_passed', scope: 'device', name, observationId: observed.evidence.observationId, source: structuredClone(observed.evidence.source), window: structuredClone(observed.evidence.window), refs: structuredClone(observed.evidence.refs) });
    history.push({ kind: 'call_completed', executionId: 'script-simulation', target, payloadSummary: { command, error: null }, evidenceRefs: structuredClone(observed.evidence.refs) });
  }
  const write = (name, value) => { const p = path.join(out, name); fs.writeFileSync(p, JSON.stringify(value)); return { path: p, sha256: hashFile(p) }; };
  const checkpoint = { name: 'editor', runId: 'current-run', operationId: 'script-simulation', afterActionId: null,
    phaseStartedAtMs, startedAtMs: phaseStartedAtMs, finishedAtMs: Date.now(), phaseFinishedAtMs: Date.now(),
    screen: 'editor', body: 'Self-reported incorrect expectation is ignored', tree: write('tree.json', response), afterTree: write('after-tree.json', after), screenshot: { path: png, sha256: hashFile(png) }, screenshotResponse: write('screenshot.json', screenshot) };
  return { checkpoint, args: { id: 'text:ui', runId: 'current-run', title: 'Unique', target, hostPhases: { 'script-simulation': { operationId: 'script-simulation', events, history: { items: history } } }, checkpoints: [checkpoint], expectedCheckpoints: [{ name: 'editor', screen: 'editor', body: '正确正文' }] } };
}
test('UI oracle reads Host-issued payload, current operation and PNG rather than Script passed/body', async (t) => {
  const { args } = await fixture(t);
  assert.equal(checkTextUi(args).verdict, 'passed');
  args.expectedCheckpoints[0].body = 'wrong expected persisted text';
  args.checkpoints[0].assertion = { verdict: 'passed' };
  assert.equal(checkTextUi(args).verdict, 'failed');
});
test('UI old operation/action, missing screenshot, altered payload and absent checkpoint reject', async (t) => {
  const { args } = await fixture(t);
  for (const change of [
    (x) => { x.runId = 'old-run'; }, (x) => { x.operationId = 'old-script'; },
    (x) => { x.afterActionId = 'new-action'; }, (x) => { x.screenshot = null; },
  ]) { const copy = structuredClone(args); change(copy.checkpoints[0]); assert.equal(checkTextUi(copy).verdict, 'inconclusive'); }
  assert.equal(checkTextUi({ ...args, checkpoints: [] }).verdict, 'inconclusive');
  const payload = JSON.parse(fs.readFileSync(args.checkpoints[0].tree.path)); payload.result.root.children[1].text = 'forged';
  fs.writeFileSync(args.checkpoints[0].tree.path, JSON.stringify(payload)); args.checkpoints[0].tree.sha256 = hashFile(args.checkpoints[0].tree.path);
  assert.equal(checkTextUi(args).reason, 'ui_payload_changed');
});
test('unissued observations, self-rehashed source metadata and swapped PNG cannot satisfy Host evidence', async (t) => {
  const one = await fixture(t);
  const tree = JSON.parse(fs.readFileSync(one.checkpoint.tree.path));
  tree.evidence.observationId = 'not-issued'; tree.evidence.refs[0].hostObservationId = 'not-issued';
  fs.writeFileSync(one.checkpoint.tree.path, JSON.stringify(tree)); one.checkpoint.tree.sha256 = hashFile(one.checkpoint.tree.path);
  assert.equal(checkTextUi(one.args).reason, 'observation_not_bound_to_trusted_host_assertion');
  const two = await fixture(t);
  const shot = JSON.parse(fs.readFileSync(two.checkpoint.screenshotResponse.path));
  shot.result.foreground.activity = 'WrongActivity'; shot.evidence.source.payloadSha256 = require('node:crypto').createHash('sha256').update(JSON.stringify(shot.result)).digest('hex');
  fs.writeFileSync(two.checkpoint.screenshotResponse.path, JSON.stringify(shot)); two.checkpoint.screenshotResponse.sha256 = hashFile(two.checkpoint.screenshotResponse.path);
  assert.equal(checkTextUi(two.args).reason, 'observation_not_bound_to_trusted_host_assertion');
  const three = await fixture(t);
  const png = fs.readFileSync(three.checkpoint.screenshot.path); png[png.length - 1] ^= 1; fs.writeFileSync(three.checkpoint.screenshot.path, png); three.checkpoint.screenshot.sha256 = hashFile(three.checkpoint.screenshot.path);
  assert.equal(checkTextUi(three.args).reason, 'same_action_foreground_screenshot_required');
});
test('genuine Host observations from different Activity, changing UI or outside phase cannot pass', async (t) => {
  const wrongActivity = await fixture(t, undefined, { screenshotActivity: 'example.OtherActivity' });
  assert.equal(checkTextUi(wrongActivity.args).reason, 'same_action_foreground_screenshot_required');
  const afterTree = { activity: 'example.EditorActivity', root: { ...visible, children: [makeNode('EnterTitle', 'Unique'), makeNode('EnterBody', 'changed during capture')] } };
  const changed = await fixture(t, undefined, { afterTree });
  assert.equal(checkTextUi(changed.args).reason, 'ui_changed_during_screenshot');
  const wrongTime = await fixture(t);
  wrongTime.checkpoint.startedAtMs = wrongTime.checkpoint.finishedAtMs + 600000;
  assert.equal(checkTextUi(wrongTime.args).reason, 'ui_observation_time_order_invalid');
});
test('runner requires explicit serial/APK/output and source is Script-only', () => {
  assert.throws(() => parseArguments(['--serial', 'one']), /required/);
  assert.throws(() => parseArguments(['--serial', 'one;bad', '--out', '/tmp/x', '--apk', '/tmp/apk']), /required/);
  const args = parseArguments(['--serial', 'test-1', '--out', '/tmp/x', '--apk', '/tmp/apk']);
  assert.equal(args.serial, 'test-1'); assert.equal(args.apk, '/tmp/apk');
  const source = fs.readFileSync(path.join(validation, 'regression-script.js'), 'utf8');
  assert.equal(/ctx\.call\(/.test(source), true);
  assert.equal(/ctx\.call\(['"](?:intent|batch)['"]/.test(source), false);
  assert.equal(source.includes("requiredEvidence: ['tree']"), true);
});
test('real r1 duplicate-body tree binds overview body and labels to the uniquely titled card', async (t) => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/r1-duplicate-body.tree.json')));
  const all = visibleNodes(raw);
  const title = all.find((node) => node.text?.startsWith('AAB-TEXT-script-')).text;
  const body = '第一行中文\nsecond line & <tag>-edited';
  assert(all.filter((node) => node.text === body).length > 1, 'actual r1 has identical body text in multiple cards');
  const accepted = await fixture(t, raw); accepted.args.title = title;
  accepted.args.expectedCheckpoints[0] = { name: 'editor', screen: 'overview', body };
  assert.equal(checkTextUi(accepted.args).verdict, 'passed');
  const wrong = structuredClone(raw);
  noteCardNodes(visibleNodes(wrong), title).find((node) => node.resourceName === `${pkg}:id/Note`).text = 'Wrong target body';
  const rejected = await fixture(t, wrong); rejected.args.title = title; rejected.args.expectedCheckpoints = accepted.args.expectedCheckpoints;
  assert.equal(checkTextUi(rejected.args).verdict, 'failed', 'another card with the expected body cannot satisfy the target');
  accepted.args.expectedCheckpoints[0].requiredSelectors = [{ text: 'AAB项目' }];
  assert(visibleNodes(raw).some((node) => node.text === 'AAB项目'));
  assert.equal(checkTextUi(accepted.args).verdict, 'failed', 'another card label cannot satisfy the target');
});
test('APK metadata preflight accepts only the isolated package before install', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-apk-metadata-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tool = path.join(dir, 'aapt2'); const apk = path.join(dir, 'manifest-fixture.txt');
  fs.writeFileSync(tool, `#!${process.execPath}\nprocess.stdout.write(require('node:fs').readFileSync(process.argv.at(-1),'utf8'))`); fs.chmodSync(tool, 0o755);
  fs.writeFileSync(apk, `package: name='${pkg}' versionCode='1'`);
  assert.equal(apkPackage(apk, tool).packageName, pkg);
  fs.writeFileSync(apk, "package: name='com.philkes.notallyx'");
  assert.throws(() => apkPackage(apk, tool), /isolated_sample_apk_required/);
});
test('candidate create phase executes in a real Node Script child with current Host evidence', async (t) => {
  const { createScriptSupervisor } = require(path.join(ROOT, 'desktop/ai-app-bridge-cli/bin/script/script-supervisor'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-real-script-candidate-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  let screen = 'overview', title = '', body = '', revealed = false; const commands = [];
  const bounds = (top) => ({ left: 0, top, right: 100, bottom: top + 100 });
  const actions = async (command, args) => {
    commands.push(command);
    if (command === 'tree') return { root: { ...visible, bounds: { left: 0, top: 0, right: 400, bottom: 800 }, children: screen === 'editor'
      ? [{ ...makeNode('EnterTitle', title), bounds: bounds(0) }, { ...makeNode('EnterBody', body), bounds: bounds(200) }]
      : [{ ...makeNode('TakeNote', ''), bounds: bounds(400) }, { ...visible, resourceName: `${pkg}:id/MainListView`, className: 'androidx.recyclerview.widget.RecyclerView', bounds: { left: 0, top: 0, right: 400, bottom: 800 } }, { ...visible, className: 'com.google.android.material.card.MaterialCardView', visible: revealed, effectiveVisible: revealed, bounds: { left: 0, top: 0, right: 400, bottom: 300 }, children: [makeNode('Title', title), makeNode('Note', body)] }] } };
    if (command === 'swipe') { assert(args.startY > args.endY && args.endY >= 0 && args.startY <= 800); revealed = true; return { ok: true }; }
    if (command === 'tap') { assert.equal(args.tapY, 450); assert.equal(args.scope, 'app'); screen = 'editor'; return { ok: true }; }
    if (command === 'input-text') { assert.equal(args.packageName, pkg); assert(args.requestId); if (args.tapY === 50) title = args.text; else if (args.tapY === 250) body = args.text; else throw new Error('wrong editor coordinate'); return { ok: true }; }
    if (command === 'keyevent') { if (args.keyCode === 4) screen = 'overview'; return { ok: true }; }
    if (command === 'screenshot') { fs.writeFileSync(args.outFile, PNG); return { ok: true, path: args.outFile, artifact: { sha256: hashFile(args.outFile) }, foregroundMatchesPackage: true }; }
    throw new Error(`unexpected command:${command}`);
  };
  const supervisor = createScriptSupervisor();
  let current = await supervisor.handle({ operation: 'start', actions, mutationLease: require(path.join(ROOT, 'desktop/ai-app-bridge-cli/bin/shared-kernel/device-mutation-lease')).createDeviceMutationLease({ directory: path.join(out, 'ownership') }), script: { schemaVersion: 'aab.code-script/v1', language: 'javascript', name: 'candidate-offline-real-child',
    sourcePath: path.join(validation, 'regression-script.js'), target: { platform: 'android', serial: 'simulation', packageName: pkg },
    inputs: { out, runId: 'real-child-simulated-provider', phase: 'create', title: 'Unique', originalBody: '第一行\nsecond line', editedBody: 'edited' },
    policy: { timeoutMs: 5000, restartPolicy: 'none' } } });
  assert.equal(current.ok, true, current.error);
  const deadline = Date.now() + 7000;
  while (!['completed', 'failed', 'cancelled'].includes(current.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = await supervisor.handle({ operation: 'wait', operationId: current.operationId, waitMs: 100, afterSequence: current.eventSequence });
  }
  assert.equal(current.status, 'completed', JSON.stringify({ status: current.status, error: current.error, events: current.events.slice(-3) }));
  const result = JSON.parse(fs.readFileSync(path.join(out, 'result.json')));
  assert.equal(result.checkpoints.length, 2); assert(result.checkpoints.every((point) => point.assertion.scope === 'device' && point.assertion.verdict === 'passed'));
  assert.equal(title, 'Unique'); assert.equal(body, '第一行\nsecond line'); assert(commands.includes('swipe'), 'offscreen note is revealed using observed Recycler bounds');
  assert.equal(commands.includes('batch') || commands.includes('intent'), false);
});

test('list UI oracle rejects lost/duplicated/wrong-order tasks and wrong indentation, scopes overview card', async (t) => {
  const items = [
    { body: 'Parent-A', isChild: false, checked: false }, { body: 'Child-A1', isChild: true, checked: false },
    { body: 'Child-A2-edited', isChild: true, checked: false }, { body: 'Parent-B', isChild: false, checked: true },
  ];
  const taskNodes = items.map((item, index) => ({ ...visible, resourceName: `${pkg}:id/EditText`, editable: !item.checked, focusable: !item.checked, alpha: item.checked ? 0.5 : 1, contentDescription: `EditText${index}`,
    text: item.body, bounds: { left: item.isChild ? 160 : 100, top: 300 + index * 150, right: 1000, bottom: 400 + index * 150 } }));
  const children = [makeNode('EnterTitle', 'Unique'), ...[false, true].map((checked) => ({ ...visible,
    resourceName: `${pkg}:id/${checked ? 'CheckedListView' : 'MainListView'}`, children: taskNodes.filter((node, index) => items[index].checked === checked)
      .map((node) => ({ ...visible, resourceName: `${pkg}:id/Content`, children: [node, { ...visible,
        resourceName: `${pkg}:id/CheckBox`, className: 'com.google.android.material.checkbox.MaterialCheckBox' }] })) }))];
  const all = visibleNodes({ root: { ...visible, children } });
  assert.equal(listContentMatches(all, 'Unique', 'list-editor', items), true);
  const wrongIndent = structuredClone(all); wrongIndent.find((node) => node.text === 'Child-A1').bounds.left = 100;
  assert.equal(listContentMatches(wrongIndent, 'Unique', 'list-editor', items), false);
  assert.equal(listContentMatches(all.filter((node) => node.text !== 'Parent-B'), 'Unique', 'list-editor', items), false);
  assert.equal(listContentMatches([...all, structuredClone(taskNodes[0])], 'Unique', 'list-editor', items), false);
  const wrongOrder = structuredClone(all); wrongOrder.find((node) => node.text === 'Child-A2-edited').bounds.top = 250;
  assert.equal(listContentMatches(wrongOrder, 'Unique', 'list-editor', items), false);
  const tree = { activity: 'com.philkes.notallyx.presentation.activity.note.EditListActivity', root: { ...visible, children } };
  const accepted = await fixture(t, tree); accepted.args.expectedCheckpoints[0] = { name: 'editor', screen: 'list-editor', items };
  assert.equal(checkTextUi(accepted.args).verdict, 'passed');
  accepted.args.expectedCheckpoints[0].items = structuredClone(items); accepted.args.expectedCheckpoints[0].items[2].body = 'not saved';
  assert.equal(checkTextUi(accepted.args).verdict, 'failed');
  const card = (title, tasks) => ({ ...visible, className: 'com.google.android.material.card.MaterialCardView', children: [makeNode('Title', title), ...tasks] });
  const overview = visibleNodes({ root: { ...visible, children: [card('Unique', taskNodes.slice(0, 3)), card('Other', [taskNodes[3]])] } });
  assert.equal(listContentMatches(overview, 'Unique', 'list-overview', items), false);
});

test('all three list phases execute in real Node Script children with simulated provider, no Intent or batch', async (t) => {
  const { createScriptSupervisor } = require(path.join(ROOT, 'desktop/ai-app-bridge-cli/bin/script/script-supervisor'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-list-script-candidate-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  let screen = 'overview', title = '', items = [];
  const commands = [], gestures = [];
  const rect = (left, top, right = 1000) => ({ left, top, right, bottom: top + 100 });
  const taskTop = (index) => items[index]?.checked ? 1100 : 400 + index * 150;
  const taskNodes = () => items.map((item, index) => ({ ...visible, resourceName: `${pkg}:id/EditText`, editable: !item.checked, focusable: !item.checked, alpha: item.checked ? 0.5 : 1, text: item.body,
    contentDescription: `EditText${item.checked ? 0 : index}`, bounds: rect(item.isChild ? 360 : 300, taskTop(index)) }));
  const actions = async (command, args) => {
    commands.push(command);
    if (command === 'tree') return { activity: screen === 'editor' ? 'ListActivity' : 'MainActivity',
      root: { ...visible, bounds: { left: 0, top: 0, right: 1080, bottom: 2200 }, children: screen === 'editor'
        ? [{ ...makeNode('EnterTitle', title), bounds: rect(100, 50) },
          ...[false, true].map((checked) => ({ ...visible, resourceName: `${pkg}:id/${checked ? 'CheckedListView' : 'MainListView'}`,
            children: taskNodes().flatMap((node, index) => items[index].checked === checked ? [{ ...visible, resourceName: `${pkg}:id/Content`, children: [node,
              { ...visible, resourceName: `${pkg}:id/CheckBox`, className: 'com.google.android.material.checkbox.MaterialCheckBox',
                contentDescription: `CheckBox${items[index].checked ? 0 : index}`, bounds: rect(100, taskTop(index), 200) }] }] : []) })),
          { ...visible, text: '添加项目', bounds: rect(300, 1700) }]
        : [{ ...visible, resourceName: `${pkg}:id/MainListView`, className: 'androidx.recyclerview.widget.RecyclerView', bounds: { left: 0, top: 0, right: 1080, bottom: 2200 } }, { ...makeNode('MakeList', null), bounds: rect(0, 100, 200) }, { ...makeNode('TakeNote', null), bounds: rect(0, 1800, 200) },
          ...(title ? [{ ...visible, className: 'com.google.android.material.card.MaterialCardView', bounds: { left: 0, top: 0, right: 1080, bottom: 1300 }, children: [
            { ...makeNode('Title', title), bounds: rect(300, 100) }, ...taskNodes().map((node) => ({ ...node, editable: false }))] }] : [])] } };
    if (command === 'tap') {
      if (screen === 'overview') {
        screen = 'editor'; if (!title) items = [{ body: '', checked: false, isChild: false }];
      } else if (args.tapY === 1750) items.push({ body: '', checked: false, isChild: false });
      else if (args.tapX === 150) { const index = items.findIndex((_, i) => args.tapY === taskTop(i) + 50); assert(index >= 0); items[index].checked = !items[index].checked; }
      return { ok: true };
    }
    if (command === 'input-text') {
      if (args.tapY === 100) title = args.text;
      else { const index = items.findIndex((_, i) => args.tapY === taskTop(i) + 50); assert(index >= 0); items[index].body = args.text; }
      return { ok: true };
    }
    if (command === 'keyevent') { if (args.keyCode === 4) screen = 'overview'; return { ok: true }; }
    if (command === 'swipe') {
      const index = items.findIndex((_, i) => args.startY === taskTop(i) + 50); assert(index >= 0);
      items[index].isChild = args.endX > args.startX; gestures.push({ body: items[index].body, isChild: items[index].isChild }); return { ok: true };
    }
    if (command === 'screenshot') { fs.writeFileSync(args.outFile, PNG); return { ok: true, path: args.outFile, artifact: { sha256: hashFile(args.outFile) }, foregroundMatchesPackage: true }; }
    throw new Error(`unexpected simulated command:${command}`);
  };
  for (const [phase, checkpoints] of [['list-create', 5], ['list-hierarchy', 8], ['list-restart', 3]]) {
    const phaseOut = path.join(out, phase); const supervisor = createScriptSupervisor();
    let current = await supervisor.handle({ operation: 'start', actions, mutationLease: require(path.join(ROOT, 'desktop/ai-app-bridge-cli/bin/shared-kernel/device-mutation-lease')).createDeviceMutationLease({ directory: path.join(out, 'ownership') }), script: { schemaVersion: 'aab.code-script/v1', language: 'javascript', name: phase,
      sourcePath: path.join(validation, 'regression-script.js'), target: { platform: 'android', serial: 'simulation', packageName: pkg },
      inputs: { out: phaseOut, runId: 'list-real-child-simulated-provider', phase, listTitle: 'Unique list' },
      policy: { timeoutMs: 12000, restartPolicy: 'none' } } });
    const deadline = Date.now() + 14000;
    while (!['completed', 'failed', 'cancelled'].includes(current.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      current = await supervisor.handle({ operation: 'wait', operationId: current.operationId, waitMs: 100, afterSequence: current.eventSequence });
    }
    assert.equal(current.status, 'completed', JSON.stringify({ phase, status: current.status, error: current.error, events: current.events.slice(-3) }));
    const result = JSON.parse(fs.readFileSync(path.join(phaseOut, 'result.json'))); assert.equal(result.checkpoints.length, checkpoints);
    assert(result.checkpoints.every((point) => point.assertion.scope === 'device' && point.assertion.verdict === 'passed'));
  }
  assert.equal(title, 'Unique list');
  assert.deepEqual(items, [{ body: 'Parent-A', checked: false, isChild: false }, { body: 'Child-A1', checked: false, isChild: true },
    { body: 'Child-A2-edited', checked: false, isChild: true }, { body: 'Parent-B', checked: true, isChild: false }]);
  assert.deepEqual(gestures, [{ body: 'Child-A1', isChild: true }, { body: 'Child-A2', isChild: true }, { body: 'Child-A1', isChild: false }, { body: 'Child-A1', isChild: true }]);
  assert.equal(commands.includes('batch') || commands.includes('intent'), false);
});

test('real R4 checked row belongs to CheckedListView and is readonly, never evidence of editable input', async (t) => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/r4-checked-list.tree.json')));
  const all = visibleNodes(raw); const title = all.find((node) => node.resourceName === `${pkg}:id/EnterTitle`).text;
  const items = ['Parent-A', 'Child-A1', 'Child-A2', 'Parent-B'].map((body, index) => ({ body, isChild: false, checked: index === 3 }));
  assert.equal(all.find((node) => node.text === 'Parent-B').editable, false);
  assert.equal(listContentMatches(all, title, 'list-editor', items), true);
  const accepted = await fixture(t, raw); accepted.args.title = title; accepted.args.expectedCheckpoints = [{ name: 'editor', screen: 'list-editor', items }];
  assert.equal(checkTextUi(accepted.args).verdict, 'passed');
  for (const mutate of [
    (nodes) => { nodes.find((node) => node.resourceName === `${pkg}:id/CheckedListView`).resourceName = `${pkg}:id/WrongListView`; },
    (nodes) => { nodes.find((node) => node.text === 'Parent-B').editable = true; },
    (nodes) => { nodes.find((node) => node.text === 'Parent-A').editable = false; },
    (nodes) => { nodes.find((node) => node.text === 'Parent-B').text = 'missing checked marker'; },
    (nodes) => { const section = nodes.find((node) => node.resourceName === `${pkg}:id/CheckedListView`); const row = visibleNodes({ root: section }).find((node) => node.resourceName === `${pkg}:id/Content`); row.children = row.children.filter((node) => node.resourceName !== `${pkg}:id/CheckBox`); },
  ]) {
    const copy = structuredClone(raw); mutate(visibleNodes(copy));
    assert.equal(listContentMatches(visibleNodes(copy), title, 'list-editor', items), false);
  }
});

test('independent Host UI oracle rejects editability change after screenshot even with genuine issued observations', async (t) => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/r4-checked-list.tree.json')));
  const title = visibleNodes(raw).find((node) => node.resourceName === `${pkg}:id/EnterTitle`).text;
  const after = structuredClone(raw); const changed = visibleNodes(after).find((node) => node.text === 'Parent-B');
  Object.assign(changed, { editable: true, focusable: true, alpha: 1 });
  const observed = await fixture(t, raw, { afterTree: after }); observed.args.title = title;
  observed.args.expectedCheckpoints = [{ name: 'editor', screen: 'list-editor', items: ['Parent-A', 'Child-A1', 'Child-A2', 'Parent-B'].map((body, index) => ({ body, checked: index === 3, isChild: false })) }];
  assert.equal(checkTextUi(observed.args).verdict, 'inconclusive');
});

test('label UI binds exact label text and controls to the same real row, not a shared prefix', async (t) => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/labels-management.tree.json')));
  raw.activity = 'com.philkes.notallyx.presentation.activity.main.MainActivity';
  const labels = visibleNodes(raw).filter((node) => node.resourceName === `${pkg}:id/LabelText`);
  labels[0].text = 'AAB-label-a'; labels[1].text = 'AAB-label-ab';
  const expected = { present: ['AAB-label-a', 'AAB-label-ab'], absent: ['AAB-label-renamed'] };
  assert.equal(labelContentMatches(visibleNodes(raw), expected), true);
  const accepted = await fixture(t, raw);
  accepted.args.expectedCheckpoints[0] = { name: 'editor', screen: 'labels', labels: expected };
  assert.equal(checkTextUi(accepted.args).verdict, 'passed');
  const wrong = structuredClone(raw); visibleNodes(wrong).find((node) => node.text === 'AAB-label-a').text = 'AAB-label-ab-extra';
  assert.equal(labelContentMatches(visibleNodes(wrong), expected), false);
  const missingControl = structuredClone(raw), list = visibleNodes(missingControl).find((node) => node.resourceName === `${pkg}:id/MainListView`);
  list.children[0].children = list.children[0].children.filter((node) => node.resourceName !== `${pkg}:id/EditButton`);
  assert.equal(labelContentMatches(visibleNodes(missingControl), expected), false, 'another row EditButton cannot fill this row');
  const duplicate = structuredClone(raw); visibleNodes(duplicate).find((node) => node.resourceName === `${pkg}:id/MainListView`).children.push(structuredClone(list.children[1]));
  assert.equal(labelContentMatches(visibleNodes(duplicate), expected), false);
});

test('independent Host UI rejects a conflict dialog that still contains old A despite a successful input receipt', async (t) => {
  const dialog = (value) => ({ activity: 'com.philkes.notallyx.presentation.activity.main.MainActivity', root: { ...visible, children: [
    makeNode('alertTitle', '编辑标签'), makeNode('EditText', value),
    { ...visible, resourceName: 'android:id/button1', text: '保存' }, { ...visible, resourceName: 'android:id/button2', text: '取消' },
  ] } });
  const old = await fixture(t, dialog('AAB-label-a'));
  old.args.expectedCheckpoints[0] = { name: 'editor', screen: 'label-input-dialog', input: { title: '编辑标签', value: 'AAB-label-ab' } };
  old.checkpoint.assertion = { verdict: 'passed' }; old.checkpoint.inputReceipt = { ok: true };
  assert.equal(checkTextUi(old.args).verdict, 'failed');
  const fresh = await fixture(t, dialog('AAB-label-ab')); fresh.args.expectedCheckpoints = old.args.expectedCheckpoints;
  assert.equal(checkTextUi(fresh.args).verdict, 'passed');
});

test('unknown or disabled top window cannot expose a real background label page', async (t) => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/labels-management.tree.json')));
  raw.activity = 'com.philkes.notallyx.presentation.activity.main.MainActivity';
  const present = visibleNodes(raw).filter((node) => node.resourceName === `${pkg}:id/LabelText`).map((node) => node.text);
  assert.equal(labelContentMatches(visibleNodes(raw), { present }), true);
  for (const root of [{ visible: true, effectiveVisible: true, enabled: false }, { enabled: true }, null]) {
    const copy = structuredClone(raw); copy.windows.push({ index: 99, root });
    assert.deepEqual(visibleNodes(copy), []);
    const current = await fixture(t, copy); current.args.expectedCheckpoints[0] = { name: 'editor', screen: 'labels', labels: { present } };
    assert.equal(checkTextUi(current.args).reason, 'current_native_window_unavailable');
  }
  const hidden = structuredClone(raw); hidden.windows.push({ index: 99, root: { visible: false, effectiveVisible: false } });
  assert.equal(labelContentMatches(visibleNodes(hidden), { present }), true, 'only an explicitly hidden window may be skipped');
});

test('duplicate and conflicting rename execute in real Node children using exact scoped rows', async (t) => {
  const { createScriptSupervisor } = require(path.join(ROOT, 'desktop/ai-app-bridge-cli/bin/script/script-supervisor'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-label-rejection-script-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const names = ['Project', 'AAB-label-a', 'AAB-label-ab'];
  const rect = (left, top, right, bottom) => ({ left, top, right, bottom });
  const node = (props, bounds) => ({ ...visible, bounds, ...props });
  let screen = 'overview', dialog = null, value = '', selectedRow = null;
  const selections = [], commands = [];
  const tree = () => ({ activity: 'com.philkes.notallyx.presentation.activity.main.MainActivity',
    root: node({ children: dialog ? [node({ resourceName: `${pkg}:id/alertTitle`, text: dialog === 'create' ? '添加标签' : '编辑标签' }, rect(100, 100, 900, 150)),
      node({ resourceName: `${pkg}:id/EditText`, text: value, editable: true }, rect(100, 200, 900, 300)),
      node({ resourceName: 'android:id/button2', text: '取消' }, rect(100, 400, 300, 500)), node({ resourceName: 'android:id/button1', text: '保存' }, rect(700, 400, 900, 500))]
      : [node({ contentDescription: '打开抽屉式导航栏' }, rect(0, 0, 100, 100)), ...(screen === 'drawer' ? [node({ resourceName: `${pkg}:id/Labels`, children: [node({ resourceName: `${pkg}:id/design_menu_item_text`, text: '标签' }, rect(0, 100, 900, 200))] }, rect(0, 100, 900, 200))]
        : screen === 'labels' ? [node({ contentDescription: '添加标签' }, rect(900, 0, 1000, 100)), node({ resourceName: `${pkg}:id/MainListView`, children: names.map((text, index) => node({ className: 'android.widget.LinearLayout', children: [
          node({ resourceName: `${pkg}:id/LabelText`, text }, rect(0, 200 + index * 150, 600, 300 + index * 150)),
          node({ resourceName: `${pkg}:id/EditButton` }, rect(700, 200 + index * 150, 800, 300 + index * 150)),
          node({ resourceName: `${pkg}:id/DeleteButton` }, rect(800, 200 + index * 150, 900, 300 + index * 150)),
        ] }, rect(0, 200 + index * 150, 1000, 300 + index * 150))) }, rect(0, 200, 1000, 1000))] : [])] }, rect(0, 0, 1080, 1200)) });
  const actions = async (command, args) => {
    commands.push(command);
    if (command === 'tree') return tree();
    if (command === 'screenshot') { fs.writeFileSync(args.outFile, PNG); return { ok: true, path: args.outFile, artifact: { sha256: hashFile(args.outFile) }, foregroundMatchesPackage: true }; }
    if (command === 'keyevent') { assert.equal(args.keyCode, 111); return { ok: true }; }
    if (command === 'input-text') { assert(dialog); assert.equal(args.tapY, 250); value = args.text; return { ok: true }; }
    if (command === 'tap') {
      if (dialog) { assert.equal(args.tapX, 800); assert.equal(args.tapY, 450); assert(names.includes(value), 'fixture attempts only known conflicts'); dialog = null; return { ok: true }; }
      if (args.tapX === 50 && args.tapY === 50) screen = 'drawer';
      else if (screen === 'drawer' && args.tapY === 150) screen = 'labels';
      else if (screen === 'labels' && args.tapX === 950) { dialog = 'create'; value = ''; }
      else if (screen === 'labels' && args.tapX === 750) { selectedRow = Math.round((args.tapY - 250) / 150); selections.push(names[selectedRow]); dialog = 'rename'; value = names[selectedRow]; }
      else throw new Error(`unexpected observed target:${args.tapX},${args.tapY}`);
      return { ok: true };
    }
    throw new Error(`unexpected command:${command}`);
  };
  for (const phase of ['labels-duplicate', 'labels-conflict']) {
    screen = 'overview';
    const supervisor = createScriptSupervisor(), directory = path.join(out, phase); fs.mkdirSync(directory);
    let current = await supervisor.handle({ operation: 'start', actions, mutationLease: require(path.join(ROOT, 'desktop/ai-app-bridge-cli/bin/shared-kernel/device-mutation-lease')).createDeviceMutationLease({ directory: path.join(out, 'ownership') }), script: { schemaVersion: 'aab.code-script/v1', language: 'javascript', name: 'label-negative-simulated-provider',
      sourcePath: path.join(validation, 'regression-script.js'), target: { platform: 'android', serial: 'simulation', packageName: pkg },
      inputs: { out: directory, runId: 'label-negative-offline', phase, label: names[0], labelA: names[1], labelAb: names[2] }, policy: { timeoutMs: 10000, restartPolicy: 'none' } } });
    const deadline = Date.now() + 12000;
    while (!['completed', 'failed', 'cancelled'].includes(current.status) && Date.now() < deadline) current = await supervisor.handle({ operation: 'wait', operationId: current.operationId, waitMs: 100, afterSequence: current.eventSequence });
    assert.equal(current.status, 'completed', JSON.stringify({ status: current.status, error: current.error }));
    const result = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'))); assert.equal(result.checkpoints.length, phase === 'labels-duplicate' ? 3 : 4);
  }
  assert.deepEqual(selections, ['AAB-label-a']);
  assert(!commands.includes('batch') && !commands.includes('intent'));
});
