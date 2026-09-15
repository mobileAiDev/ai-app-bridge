'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

async function main() {
  const serial = process.argv[2];
  if (!serial) throw new Error('Pass the explicit Android serial as the first argument.');
  const directory = path.resolve(process.argv[3] || '../../build/executor-0.3.7');
  fs.mkdirSync(directory, { recursive: true });
  process.env.AI_APP_BRIDGE_EXECUTOR_HOME = path.join(directory, 'cache');
  process.env.AI_APP_BRIDGE_FACT_STORE_DIR = path.join(directory, 'facts');
  const host = require('../../bin/execution-host');
  const adb = process.env.ADB || 'adb';
  const target = { serial, packageName: 'io.github.mobileaidev.aiappbridge.sample', adb };
  const proof = { startedAt: new Date().toISOString(), target, checks: [], calls: [] };
  let identity;
  const run = async args => {
    const started = performance.now();
    const reply = await host.run({ command: 'android-executor', arguments: { ...target, ...args } });
    proof.calls.push({ arguments: args, value: reply.value, elapsedMs: performance.now() - started });
    return reply.value;
  };
  const observe = async (engine, options = {}) => {
    const result = await run({ operation: 'observe', ...identity, engine, ...options });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.observation;
  };
  const one = (observation, condition) => {
    const nodes = observation.nodes.filter(condition);
    assert.equal(nodes.length, 1, JSON.stringify(nodes));
    return nodes[0];
  };
  try {
    proof.permissionBefore = (await host.run({ command: 'permission-state', arguments: { ...target, permission: 'android.permission.CAMERA' } })).value;
    assert.equal(proof.permissionBefore.ok, true, JSON.stringify(proof.permissionBefore));
    assert.equal(proof.permissionBefore.granted, false, 'Prepare this fixture with camera permission denied before testing the system dialog');
    proof.fixtureSetup = 'Camera permission was independently confirmed denied before instrumentation starts';
    const open = await run({ operation: 'open', instrumentation: target.packageName + '.test/androidx.test.runner.AndroidJUnitRunner',
      testClass: target.packageName + '.BridgeSessionTest', activity: target.packageName + '.debugbridge.DebugBridgeNativeTestActivity' });
    assert.equal(open.ok, true, JSON.stringify(open));
    identity = { sessionId: open.sessionId, runtimeEpoch: open.runtimeEpoch };
    proof.open = open;
    for (const adapter of ['espresso', 'espresso-web', 'uiautomator']) assert.ok(open.capabilities.adapters[adapter]);
    let observation = await observe('espresso');
    const initial = one(observation, node => node.description === 'native_counter_status').text;
    const button = one(observation, node => node.text === 'Native Increment');
    const request = { operation: 'act', ...identity, snapshotId: observation.snapshotId, actionId: 'increment-once', action: { type: 'click', nodeId: button.nodeId } };
    assert.equal((await run(request)).ok, true);
    assert.equal((await run(request)).replayed, true);
    observation = await observe('uiautomator');
    const incremented = one(observation, node => node.description === 'native_counter_status').text;
    assert.notEqual(incremented, initial);
    assert.match(incremented, /1/);
    proof.checks.push('Espresso click and duplicate receipt replay; UI Automator observes the same application state without restart');
    const input = one(observation, node => node.description === 'native_input');
    const edited = await run({ operation: 'act', ...identity, snapshotId: observation.snapshotId,
      action: { type: 'setText', nodeId: input.nodeId, text: 'UIA 中文商品 123' } });
    assert.equal(edited.ok, true, JSON.stringify(edited));
    assert.equal(edited.action.mechanism, 'accessibility-ACTION_SET_TEXT');
    const oldSnapshot = observation.snapshotId;
    observation = await observe('espresso');
    assert.equal(one(observation, node => node.description === 'native_input').text, 'UIA 中文商品 123');
    const stale = await run({ operation: 'act', ...identity, snapshotId: oldSnapshot, action: { type: 'click', nodeId: input.nodeId } });
    assert.equal(stale.error, 'reobserve_required');
    assert.equal(stale.dispatched, false);
    const editor = one(observation, node => node.description === 'native_input');
    const replaced = await run({ operation: 'act', ...identity, snapshotId: observation.snapshotId,
      action: { type: 'replaceText', nodeId: editor.nodeId, text: 'Espresso 中文商品 456' } });
    assert.equal(replaced.ok, true, JSON.stringify(replaced));
    assert.equal(replaced.action.mechanism, 'espresso-replaceText-setter');
    observation = await observe('uiautomator');
    assert.equal(one(observation, node => node.description === 'native_input').text, 'Espresso 中文商品 456');
    proof.checks.push('UI Automator ACTION_SET_TEXT and Espresso replaceText both read back; mechanisms remain distinct; stale snapshot rejected');
    observation = await observe('espresso');
    const webView = one(observation, node => node.description === 'native_h5_webview');
    const scroll = await run({ operation: 'act', ...identity, snapshotId: observation.snapshotId, action: { type: 'scrollTo', nodeId: webView.nodeId } });
    assert.equal(scroll.ok, true, JSON.stringify(scroll));
    const webOptions = { webView: { by: 'description', value: 'native_h5_webview' } };
    observation = await observe('espresso-web', webOptions);
    const domButton = one(observation, node => node.id === 'native-h5-button');
    const webClick = { operation: 'act', ...identity, snapshotId: observation.snapshotId, actionId: 'h5-click-once', action: { type: 'webClick', nodeId: domButton.nodeId } };
    const clicked = await run(webClick);
    assert.equal(clicked.ok, true, JSON.stringify(clicked));
    assert.equal(clicked.action.mechanism, 'webdriver-javascript-atoms');
    assert.equal((await run(webClick)).replayed, true);
    observation = await observe('espresso-web', webOptions);
    assert.equal(one(observation, node => node.id === 'native-h5-body').text, 'Native H5 clicked');
    const domEdit = async (type, text) => {
      const node = one(observation, item => item.id === 'native-h5-input');
      const edited = await run({ operation: 'act', ...identity, snapshotId: observation.snapshotId, action: { type, nodeId: node.nodeId, ...(text === undefined ? {} : { text }) } });
      assert.equal(edited.ok, true, JSON.stringify(edited));
      observation = await observe('espresso-web', webOptions);
    };
    await domEdit('webClear');
    await domEdit('webKeys', 'H5 商品 789');
    assert.equal(one(observation, node => node.id === 'native-h5-input').value, 'H5 商品 789');
    proof.checks.push('Same Instrumentation session switches from native Views to Espresso-Web; H5 click/receipt replay and Chinese input read back, with JS atoms mechanism');
    const frameOptions = { ...webOptions, framePath: [{ name: 'native-h5-frame' }] };
    observation = await observe('espresso-web', frameOptions);
    const frameButton = one(observation, node => node.id === 'frame-button');
    const frameClick = await run({ operation: 'act', ...identity, snapshotId: observation.snapshotId, action: { type: 'webClick', nodeId: frameButton.nodeId } });
    assert.equal(frameClick.ok, true, JSON.stringify(frameClick));
    observation = await observe('espresso-web', frameOptions);
    assert.equal(one(observation, node => node.id === 'frame-button').text, 'Frame clicked');
    proof.checks.push('Espresso-Web selects the named same-origin H5 iframe and reads back its click');
    fs.writeFileSync(path.join(directory, 'android-executor-observation.json'), JSON.stringify(observation, null, 2));
    const screenshot = await promisify(execFile)(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
    proof.screenshot = path.join(directory, 'android-executor.png');
    fs.writeFileSync(proof.screenshot, screenshot.stdout);
    observation = await observe('espresso');
    const permissionButton = one(observation, node => node.text === 'Request Camera Permission');
    assert.equal((await run({ operation: 'act', ...identity, snapshotId: observation.snapshotId, action: { type: 'scrollTo', nodeId: permissionButton.nodeId } })).ok, true);
    observation = await observe('espresso');
    assert.equal((await run({ operation: 'act', ...identity, snapshotId: observation.snapshotId, action: { type: 'click', nodeId: one(observation, node => node.text === 'Request Camera Permission').nodeId } })).ok, true);
    observation = await observe('uiautomator');
    fs.writeFileSync(path.join(directory, 'android-executor-permission.json'), JSON.stringify(observation, null, 2));
    const allow = one(observation, node => typeof node.resourceId === 'string' && /:id\/permission_allow_(foreground_only_)?button$/.test(node.resourceId));
    assert.notEqual(allow.packageName, target.packageName);
    assert.equal((await run({ operation: 'act', ...identity, snapshotId: observation.snapshotId, action: { type: 'click', nodeId: allow.nodeId } })).ok, true);
    observation = await observe('espresso');
    assert.ok(observation.nodes.some(node => node.text === 'Camera permission: granted'));
    proof.permissionAfter = (await host.run({ command: 'permission-state', arguments: { ...target, permission: 'android.permission.CAMERA' } })).value;
    assert.equal(proof.permissionAfter.ok, true); assert.equal(proof.permissionAfter.granted, true);
    proof.checks.push('Espresso requests camera permission; UI Automator operates the observed system permission dialog; native callback reads granted');
    const closed = await run({ operation: 'close', ...identity });
    assert.equal(closed.ok, true, JSON.stringify(closed));
    identity = null;
    const receipt = await run({ operation: 'receipt', sessionId: open.sessionId, runtimeEpoch: open.runtimeEpoch, actionId: 'increment-once' });
    assert.equal(receipt.receipt.settled, true);
    assert.equal(receipt.receipt.result.ok, true);
    proof.checks.push('Orderly close and original device receipt retained after instrumentation ends');
    proof.ok = true;
  } finally {
    if (identity) {
      try { proof.cleanup = await run({ operation: 'close', ...identity }); }
      catch (error) { proof.cleanup = { ok: false, error: error.message }; }
    }
    await host.close();
    fs.writeFileSync(path.join(directory, 'android-executor-verification.json'), JSON.stringify(proof, null, 2));
  }
  process.stdout.write(JSON.stringify({ ok: true, checks: proof.checks, evidence: path.join(directory, 'android-executor-verification.json') }) + '\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
