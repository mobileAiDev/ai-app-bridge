'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWDAFixture } = require('../test-support/ios-wda-fixture');
const { validateCommandArguments, commandContract } = require('../bin/command-registry');
const { validateValue } = require('../bin/shared-kernel/argument-schema');
const { intentDecisionSchema } = require('../bin/shared-kernel/execution-contracts');
const { sessionRef, schema } = require('../bin/shared-kernel/ios-native-target');
const { runExecution } = require('../bin/shared-kernel/execution-scope');

const selected = { bundleId: 'sample.app', wdaSessionId: 'session-1' };
function support(h) { h.state.orientationSchema = 'aab.ios-orientation/v1'; h.state.nativeTargetSchema = schema; }

test('orientation is one strict iOS capability shared by CLI, MCP, Script and native Intent', () => {
  const args = { deviceId: 'device', wdaRunnerBundleId: 'runner', ...selected, orientation: 'landscapeLeft' };
  validateCommandArguments('ios-set-orientation', args);
  assert.deepEqual(commandContract('ios-set-orientation').entrypoints, { mcp: true, cli: true, script: true });
  assert.equal(commandContract('ios-set-orientation').script.permission, 'app.interact');
  for (const orientation of ['LANDSCAPE', 'landscape', 3, null]) {
    assert.throws(() => validateCommandArguments('ios-set-orientation', { ...args, orientation }));
  }
  for (const field of ['deviceId', 'bundleId', 'wdaSessionId', 'orientation']) {
    const missing = { ...args }; delete missing[field];
    assert.throws(() => validateCommandArguments('ios-set-orientation', missing));
  }
  const decision = { decisionId: 'rotate', basedOnRevision: 1, agentDecision: 'act',
    action: { action: 'setOrientation', orientation: 'portrait' } };
  validateValue(decision, intentDecisionSchema(), 'decision');
  validateValue(decision, intentDecisionSchema('native', 'ios'), 'decision');
  assert.throws(() => validateValue(decision, intentDecisionSchema('native', 'android'), 'decision'));
  assert.throws(() => validateValue({ ...decision, action: { ...decision.action, selector: { label: 'unused' } } },
    intentDecisionSchema('native', 'ios'), 'decision'));
});

test('old Runner and changes to the observed App process, session or Runner reject orientation before dispatch', async t => {
  const h = await createWDAFixture(t);
  assert.equal((await h.run('ios-set-orientation', { ...selected, orientation: 'portrait' })).error, 'ios_wda_orientation_schema_required');
  support(h);
  const tree = await h.run('ios-uia-tree', selected), expectedSession = sessionRef(tree);
  for (const patch of [{ runnerEpoch: 'another-runner' }, { processId: 99 }, { sessionId: 'another-session' }, { bundleId: 'other.app' }]) {
    const result = await h.run('ios-set-orientation', { ...selected, orientation: 'portrait', expectedSession: { ...expectedSession, ...patch } });
    assert.equal(result.error, 'reobserve_required', JSON.stringify(result));
    assert.equal(result.dispatched, false);
  }
  h.state.beforeWrite = () => { h.state.foreground = { bundleId: 'other.app', processId: 502 }; };
  const raced = await h.run('ios-set-orientation', { ...selected, orientation: 'portrait', expectedSession });
  assert.equal(raced.error, 'ios_wda_target_changed');
  assert.deepEqual(h.readEffects(), []);
});

test('public one-shot CLI submits exactly one orientation action and receives its bound original completion', async t => {
  const h = await createWDAFixture(t); support(h);
  const response = await h.cli('ios-set-orientation', { ...selected, orientation: 'landscapeRight' }).exited;
  assert.equal(response.code, 0, response.stderr + response.stdout);
  const result = JSON.parse(response.stdout).value;
  assert.equal(result.ok, true);
  assert.equal(result.settled, true);
  assert.equal(h.state.actions.length, 1);
  assert.equal(h.state.actions[0].operation, 'set-orientation');
  assert.deepEqual(h.state.actions[0].payload, { orientation: 'landscapeRight' });
  assert.equal(result.executionReceipt.actionId, h.state.actions[0].actionId);
  assert.equal(result.executionReceipt.execution.target.processId, 501);
});

test('queued rotation cancellation retains the original action identity and produces no device effect', async t => {
  const h = await createWDAFixture(t, { mode: 'queued' }); support(h);
  const controller = new AbortController();
  const pending = runExecution({ signal: controller.signal }, () => h.run('ios-set-orientation', { ...selected, orientation: 'portrait' }));
  const body = await h.submitted;
  controller.abort({ code: 'cancelled' });
  const result = await pending;
  assert.equal(result.settled, true);
  assert.equal(result.dispatched, false);
  assert.equal(result.executionReceipt.actionId, body.actionId);
  assert.deepEqual(h.readEffects(), []);
});
