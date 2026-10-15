'use strict';

// Improvement release V1, M1: public JSON is compact and rejected calls carry a
// minimal correction. Accepted inputs and value structures are unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { capabilities, commandInputSchema } = require('../bin/command-discovery');
const { validateCommandArguments } = require('../bin/command-registry');
const { validateRunRequest } = require('../bin/command-request');
const { callTool, toolResultForReply } = require('../bin/mcp-server');
const { publicReply } = require('../bin/public-reply');
const { helpText } = require('../bin/ai-app-bridge');

const cli = path.resolve(__dirname, '../bin/ai-app-bridge.js');
const runCli = argv => spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8', env: { ...process.env, ADB: '/missing-usage-surface-adb' } });
const compact = text => text === JSON.stringify(JSON.parse(text));

test('H5 and Web stale targets get valid provider-specific observation hints without replaying actions', () => {
  const { withActionGuidance } = require('../bin/shared-kernel/action-guidance');
  for (const [command, args, observe] of [
    ['h5-click', { serial: 'd', packageName: 'a.b', selector: { elementId: 'e1' } }, 'h5-dom'],
    ['ios-h5-click', { deviceId: 'd', bundleId: 'a.b', selector: { elementId: 'e1' } }, 'ios-h5-dom'],
    ['flutter-h5-click', { serial: 'd', packageName: 'a.b', adapterId: 'web', selector: { elementId: 'e1' } }, 'flutter-h5-dom'],
    ['web-click', { sessionId: 's', runtimeEpoch: 'r', selector: { elementId: 'e1' } }, 'web-dom'],
  ]) {
    const result = withActionGuidance(command, args, { ok: false, error: 'reobserve_required', dispatched: false });
    assert.equal(result.guidance.nextActions[0].command, observe);
    for (const call of result.guidance.nextActions) validateCommandArguments(call.command, call.arguments);
    assert.equal(result.dispatched, false);
  }
});
const scriptSpec = target => ({ schemaVersion: 'aab.code-script/v1', name: 't', language: 'javascript', source: 'exports.main = async () => {};', target, permissions: ['app.read'] });
test('same-version code mismatch offers explicit Runtime recovery commands', () => {
  const { withActionGuidance } = require('../bin/shared-kernel/action-guidance');
  const result = withActionGuidance('adb-exec', { serial: 'd', argv: ['devices'] }, {
    ok: false, error: 'runtime_code_mismatch', details: { outdatedSide: 'undetermined' }, dispatched: false, ambiguous: false,
  });
  assert.deepEqual(result.guidance.nextActions.map(action => action.arguments.operation), ['status', 'stop', 'start']);
  assert.match(result.guidance.message, /stops existing Runtime tasks/);
  for (const action of result.guidance.nextActions) validateCommandArguments(action.command, action.arguments);
});
test('UIA bundle mismatch offers a normal stop before restarting and retains history', () => {
  const { withActionGuidance } = require('../bin/shared-kernel/action-guidance');
  const result = withActionGuidance('uia-runtime', { serial: 'device-a', operation: 'start' }, {
    ok: false, error: 'uia_runtime_version_mismatch', dispatched: false, ambiguous: false,
  });
  assert.deepEqual(result.guidance.nextActions.map(action => action.arguments), [
    { serial: 'device-a', operation: 'status' },
    { serial: 'device-a', operation: 'stop' },
    { serial: 'device-a', operation: 'start' },
  ]);
  assert.match(result.guidance.message, /retains the action history/);
  for (const action of result.guidance.nextActions) validateCommandArguments(action.command, action.arguments);
});

test('Flutter observation failures preserve the outcome and offer valid read-only recovery calls', () => {
  const { withActionGuidance } = require('../bin/shared-kernel/action-guidance');
  for (const error of ['flutter_observation_timeout', 'flutter_observation_busy', 'flutter_runtime_changed', 'flutter_action_handler_absent', 'flutter_runtime_shutdown']) {
    for (const [command, args, observe, diagnose] of [
      ['tap-flutter-text', { serial: 'device-a', packageName: 'a.b', targetText: 'Save' }, 'flutter-nodes', 'uia-tree'],
      ['ios-flutter-action', { deviceId: 'device-i', bundleId: 'a.b', payload: { action: 'tapText', text: 'Save' } }, 'ios-flutter-nodes', 'doctor'],
    ]) {
      // Guidance cannot turn an unknown action outcome into a safe replay.
      const value = { ok: false, error, dispatched: true, ambiguous: true, details: { observation: { phase: 'frame' } } };
      const result = withActionGuidance(command, args, value);
      assert.deepEqual(result.guidance?.nextActions.map(action => action.command), [observe, diagnose]);
      assert.equal(result.dispatched, true);
      assert.equal(result.ambiguous, true);
      assert.equal(result.error, error);
      assert.equal(result.details, value.details);
      assert.match(result.guidance.message, /not replayed/);
      for (const action of result.guidance.nextActions) validateCommandArguments(action.command, action.arguments);
    }
  }
});

test('a UIA selector change before dispatch includes an executable fresh-observation hint', () => {
  const { withActionGuidance } = require('../bin/shared-kernel/action-guidance');
  const result = withActionGuidance('tap-uia', { serial: 'device-a', selector: { text: 'Restore' } }, {
    ok: false, error: 'uia_reference_selector_mismatch', dispatched: false, ambiguous: false,
  });
  assert.equal(result.guidance?.nextActions[0]?.command, 'uia-tree');
  validateCommandArguments(result.guidance.nextActions[0].command, result.guidance.nextActions[0].arguments);
  assert.equal(result.dispatched, false);
});

test('an interrupted UIA click offers original receipt and runtime recovery without inventing completion', () => {
  const { withActionGuidance } = require('../bin/shared-kernel/action-guidance');
  const value = { ok: false, error: 'command_failed', message: 'socket hang up',
    source: 'uia-node-runtime', runtimeEpoch: '17b67215-07b6-496f-89bf-1350fc350636', actionId: 'script-fixture:action-5',
    settled: false, dispatched: null, ambiguous: true, executionReceipt: null,
    recovery: { ok: false, settled: false, dispatched: null, ambiguous: true, error: 'uia_runtime_unreachable' } };
  const result = withActionGuidance('tap-uia', { serial: 'device-a', packageName: 'notes.app',
    selector: { contentDescription: 'Save' } }, value);
  assert.deepEqual(result.guidance?.nextActions.map(action => [action.command, action.arguments.operation]), [
    ['device-ownership', 'receipt'], ['uia-runtime', 'start'], ['uia-tree', undefined], ['uia-runtime', 'force-reset'],
  ]);
  assert.deepEqual(result.guidance.nextActions[0].arguments, { serial: 'device-a', operation: 'receipt',
    runtimeEpoch: value.runtimeEpoch, actionId: value.actionId });
  for (const action of result.guidance.nextActions) validateCommandArguments(action.command, action.arguments);
  const { guidance, ...unchanged } = result;
  assert.deepEqual(unchanged, value);
  assert.match(guidance.message, /unknown/);
  assert.match(guidance.message, /not replay/);
});

const rejection = (command, args) => {
  try { validateCommandArguments(command, args); }
  catch (error) { return { code: error.code, field: error.field, message: error.message }; }
  assert.fail(`${command} accepted ${JSON.stringify(args)}`);
};

test('CLI replies and help schemas are one line of compact JSON with the same structure and values', () => {
  const help = runCli(['--help', 'script', '--operation', 'wait']);
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.equal(help.stdout.endsWith('\n') && !help.stdout.slice(0, -1).includes('\n'), true, 'one line plus the trailing newline');
  assert.equal(compact(help.stdout.trim()), true);
  assert.deepEqual(JSON.parse(help.stdout), commandInputSchema('script', { operation: 'wait' }));

  const rejected = runCli(['script', '--extract', 'null', '--operation', 'wait', '--operation-id', 'op-1', '--wait-ms', '90000']);
  assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
  assert.equal(rejected.stderr, '');
  assert.equal(compact(rejected.stdout.trim()), true);
  const reply = JSON.parse(rejected.stdout);
  assert.equal(reply.kind, 'json');
  assert.equal(reply.failureStage, 'validation');
  assert.equal(reply.execution.error, 'invalid_argument');
  assert.equal(reply.value.error, 'invalid_argument');
  assert.match(helpText, /one line of compact JSON/);
});

test('MCP tool text is compact JSON and still decodes to the same payload', async () => {
  const directory = await callTool('capabilities', { command: 'tree' });
  assert.equal(compact(directory.content[0].text), true);
  assert.deepEqual(JSON.parse(directory.content[0].text), capabilities({ command: 'tree' }));

  const value = { ok: true, command: 'status', nested: { list: [1, { deep: 'x' }], text: '中文 与 空格' } };
  const history = { lastSequence: 3, entries: [] };
  const reply = publicReply({ command: 'status', reply: { value, history } });
  const tool = toolResultForReply({ value: reply });
  assert.equal(compact(tool.content[0].text), true);
  assert.deepEqual(JSON.parse(tool.content[0].text), reply);
  assert.deepEqual(reply.value, value);
  assert.deepEqual(reply.control.history, history);
  assert.equal(tool._meta, undefined);
  assert.equal(tool.structuredContent, undefined);
  const text = publicReply({ command: 'uia-tree', reply: { value: 'plain text' }, completed: true });
  assert.equal(JSON.parse(toolResultForReply({ value: text }).content[0].text).value, 'plain text');
});

test('a Script target without or with an unsupported platform is rejected at the exact field', () => {
  assert.deepEqual(rejection('script', { operation: 'start', script: scriptSpec({ serial: 'd', packageName: 'a.b' }) }),
    { code: 'missing_argument', field: 'script.target.platform', message: 'script.target.platform is required.' });
  assert.deepEqual(rejection('script', { operation: 'start', script: scriptSpec({ platform: 'windows', serial: 'd', packageName: 'a.b' }) }),
    { code: 'invalid_argument', field: 'script.target.platform', message: 'script.target.platform must be one of: "android", "ios", "web".' });
  assert.deepEqual(rejection('script', { operation: 'start', script: scriptSpec('android') }),
    { code: 'invalid_argument', field: 'script.target', message: 'script.target must be object or null; no implicit type conversion is performed.' });
  assert.deepEqual(rejection('intent', { operation: 'start', goal: 'g', target: { serial: 'd', packageName: 'a.b' } }),
    { code: 'missing_argument', field: 'target.platform', message: 'target.platform is required.' });
  // Precise errors of a selected branch are unchanged.
  validateCommandArguments('script', { operation: 'start', script: scriptSpec({ platform: 'android', serial: 'd' }) });
  assert.equal(rejection('script', { operation: 'start', script: scriptSpec({ platform: 'ios', deviceId: 'd', bundleId: 'b', serial: 'x' }) }).code, 'unsupported_argument');
  validateCommandArguments('script', { operation: 'start', script: scriptSpec(null) });
  validateCommandArguments('script', { operation: 'start', script: scriptSpec({ platform: 'android', serial: 'd', packageName: 'a.b' }) });
});

test('a rejected discriminator is named only when the supplied value is not accepted', () => {
  const target = { platform: 'android', serial: 'd', packageName: 'a.b' };
  // operation:"start" is valid; mode selects between the two start variants.
  assert.deepEqual(rejection('intent', { operation: 'start', mode: 'wrong', goal: 'g', target }),
    { code: 'invalid_argument', field: 'mode', message: 'mode must be one of: "supervised", "autonomous".' });
  assert.deepEqual(rejection('intent', { operation: 'start', mode: 'autonomous', goal: 'g', target }),
    { code: 'missing_argument', field: 'agentModule', message: 'agentModule is required.' });
  // action:"tap" is valid; provider selects among the tap variants.
  const decide = action => ({ operation: 'decide', operationId: 'op', decision: { decisionId: 'd1', basedOnRevision: 1, agentDecision: 'act', action } });
  assert.deepEqual(rejection('intent', decide({ provider: 'wrong', action: 'tap', selector: { text: 'Labels' } })),
    { code: 'invalid_argument', field: 'decision.action.provider', message: 'decision.action.provider must be one of: "native", "uia", "flutter", "h5".' });
  assert.equal(rejection('intent', decide({ provider: 'native', action: 'wrong', selector: { text: 'Labels' } })).field, 'decision.action.action');
  assert.deepEqual(rejection('intent', decide({ provider: 'native', action: 'longPress', selector: { text: 'Labels' }, durationMs: 100 })),
    { code: 'invalid_argument', field: 'decision.action.durationMs', message: 'decision.action.durationMs must be >= 500.' });
});

test('range violations quote the documented meaning, including how to keep waiting', () => {
  const wait = rejection('script', { operation: 'wait', operationId: 'op', waitMs: 90000 });
  assert.equal(wait.field, 'waitMs');
  assert.match(wait.message, /^waitMs must be <= 60000\. .*afterSequence set to the last eventSequence\.$/);
  assert.match(rejection('intent', { operation: 'status', operationId: 'op', limit: 0 }).message, /^limit must be >= 1\. .*not response bytes\.$/);
  assert.deepEqual(rejection('script', { operation: 'foo', operationId: 'op' }),
    { code: 'invalid_argument', field: 'operation', message: 'operation must be one of: start, result, inventory, recovery, status, wait, pause, resume, cancel, decide, runtime-status, recipes.' });
});

test('the two continuation cursors are documented in the exposed schemas', () => {
  const wait = commandInputSchema('script', { operation: 'wait' }).properties;
  assert.match(wait.afterSequence.description, /eventSequence/);
  assert.match(wait.afterSequence.description, /history\.lastSequence for history/);
  assert.match(wait.afterSequence.description, /live watermark and can skip unread records/);
  assert.match(wait.waitMs.description, /afterSequence set to the last eventSequence/);
  const status = commandInputSchema('intent', { operation: 'status' }).properties;
  assert.match(status.afterSequence.description, /history\.lastSequence/);
  assert.match(status.afterSequence.description, /Not an eventSequence/);
  assert.match(status.limit.description, /not response bytes/);
});

test('discovery misuse names the discovery entry, the real domains and the platform filters', async () => {
  assert.throws(() => validateRunRequest({ command: 'capabilities', extract: null }), error => error.code === 'unknown_command' && error.field === 'command'
    && /capabilities is the discovery tool, not a run command/.test(error.message) && /CLI: --help <command>/.test(error.message));
  assert.throws(() => validateRunRequest({ command: 'smoke', extract: null, arguments: {} }), error => error.code === 'unknown_command'
    && error.message === 'Unknown command: smoke. List command names with the capabilities tool (CLI: ai-app-bridge help).');

  const domain = capabilities({ domain: 'android' });
  assert.equal(domain.error, 'unknown_domain');
  assert.equal(domain.field, 'domain');
  assert.match(domain.message, /Domains: execution, evidence, core, app, action, flutter, webview, ios, web, diagnostics, advanced\./);
  assert.match(domain.message, /"command":"intent","operation":"decide","platform":"android"/);
  const command = capabilities({ command: 'smoke' });
  assert.equal(command.error, 'unknown_command');
  assert.equal(command.message, 'Unknown command: smoke. Omit command, or pass a domain, to list the command directory.');
  const viaMcp = JSON.parse((await callTool('run', { command: 'capabilities', extract: null })).content[0].text).value;
  assert.equal(viaMcp.ok, false);
  assert.equal(viaMcp.error, 'unknown_command');
  assert.equal(viaMcp.dispatched, false);
  assert.match(viaMcp.message, /capabilities is the discovery tool/);
});
