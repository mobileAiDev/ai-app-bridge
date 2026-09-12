'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createMcpClient, payloadOf } = require('./mcp-jsonrpc-client');

function invalidCases({ adb = '/unusable-adb', source = 'module.exports.main = () => true;' } = {}) {
  const target = { platform: 'android', serial: 'contract-probe', packageName: 'example.contract', adb };
  const { platform, ...commandTarget } = target;
  const start = { operation: 'start', goal: 'Contract validation must precede I/O', target };
  const script = { schemaVersion: 'aab.code-script/v1', language: 'javascript', source };
  const scriptStart = { operation: 'start', script };
  const decision = { decisionId: 'probe', basedOnRevision: 1, agentDecision: 'act', action: { action: 'tap', selector: { text: 'Save' } } };
  const decide = value => ({ operation: 'decide', operationId: 'unopened', decision: value });
  const cases = [];
  const add = (name, command, args, field, error = 'invalid_argument') => cases.push({ name, command, args, field, error });
  add('explicit-operation', 'intent', {}, 'operation', 'missing_argument');
  add('start-requires-target', 'intent', { operation: 'start', goal: start.goal }, 'target', 'missing_argument');
  add('target-requires-serial', 'intent', { ...start, target: { platform: 'android', packageName: target.packageName } }, 'target.serial', 'missing_argument');
  add('target-rejects-alias', 'intent', { ...start, target: { ...target, deviceId: 'other' } }, 'target.deviceId', 'unsupported_argument');
  add('target-port-is-numeric', 'intent', { ...start, target: { ...target, port: '1234' } }, 'target.port');
  add('foreground-is-unique', 'intent', { ...start, target: { ...target, foregroundPackages: ['example.picker', 'example.picker'] } }, 'target.foregroundPackages');
  add('supervised-has-no-agent-budget', 'intent', { ...start, budget: { maxSteps: 1 } }, 'budget', 'unsupported_argument');
  add('autonomous-requires-module', 'intent', { ...start, mode: 'autonomous' }, 'agentModule', 'missing_argument');
  for (const [key, value] of [['maxSteps', 0], ['maxAgentCalls', 1.5], ['maxDurationMs', '5'], ['allowlist', ['tap', 'tap']]]) {
    add(`budget-${key}`, 'intent', { ...start, mode: 'autonomous', agentModule: '/unusable-agent', budget: { [key]: value } }, `budget.${key}`);
  }
  add('capture-streams-required', 'intent', { ...start, require: {} }, 'require.streams', 'missing_argument');
  add('capture-no-retarget', 'intent', { ...start, require: { streams: ['events'], target: { platform: 'android', serial: 'other' } } }, 'require.target', 'unsupported_argument');
  add('capture-known-streams', 'intent', { ...start, require: { streams: ['screenshots'] } }, 'require.streams[0]');
  add('observe-canonical-name', 'intent', { operation: 'reobserve', operationId: 'x' }, 'operation');
  add('status-cannot-change-goal', 'intent', { operation: 'status', operationId: 'x', goal: 'other' }, 'goal', 'unsupported_argument');
  add('decision-requires-revision', 'intent', decide({ decisionId: 'probe', agentDecision: 'complete' }), 'decision.basedOnRevision', 'missing_argument');
  add('decision-revision-is-integer', 'intent', decide({ ...decision, basedOnRevision: '1' }), 'decision.basedOnRevision');
  add('terminal-decision-forbids-action', 'intent', decide({ ...decision, agentDecision: 'complete' }), 'decision.action', 'unsupported_argument');
  add('action-rejects-text-alias', 'intent', decide({ ...decision, action: { action: 'tap', selector: { text: 'Save' }, text: 'Other' } }), 'decision.action.text', 'unsupported_argument');
  add('selector-rejects-unknown', 'intent', decide({ ...decision, action: { action: 'tap', provider: 'native', selector: { text: 'Save', fuzzy: true } } }), 'decision.action.selector.fuzzy', 'unsupported_argument');
  add('selector-one-identity', 'intent', decide({ ...decision, action: { action: 'tap', provider: 'native', selector: { text: 'Save', resourceName: 'save' } } }), 'decision.action.selector');
  add('script-explicit-operation', 'script', {}, 'operation', 'missing_argument');
  for (const operation of ['progress', 'intervene']) add(`script-removed-${operation}`, 'script', { operation, operationId: 'x' }, 'operation');
  add('script-no-outer-target', 'script', { ...scriptStart, target }, 'target', 'unsupported_argument');
  add('script-no-spec-alias', 'script', { operation: 'start', script, spec: script }, 'spec', 'unsupported_argument');
  add('script-explicit-language', 'script', { ...scriptStart, script: { ...script, language: 'js' } }, 'script.language');
  add('script-exact-source', 'script', { ...scriptStart, script: { ...script, sourcePath: '/unusable-file' } }, 'script');
  add('script-known-policy', 'script', { ...scriptStart, script: { ...script, policy: { onFailure: 'pause' } } }, 'script.policy.onFailure', 'unsupported_argument');
  add('script-no-invalid-default', 'script', { ...scriptStart, script: { ...script, policy: { timeoutMs: 0 } } }, 'script.policy.timeoutMs');
  add('script-restart-enum', 'script', { ...scriptStart, script: { ...script, policy: { restartPolicy: 'auto' } } }, 'script.policy.restartPolicy');
  add('script-permissions-unique', 'script', { ...scriptStart, script: { ...script, permissions: ['app.read', 'app.read'] } }, 'script.permissions');
  add('script-python-path-is-python-only', 'script', { ...scriptStart, pythonPath: '/unusable-python' }, 'script.language');
  add('script-recording-requires-no-restart', 'script', { ...scriptStart, recordingDir: '/unusable-recording', script: { ...script, policy: { restartPolicy: 'checkpoint' } } }, 'script.policy.restartPolicy');
  add('script-status-no-payload', 'script', { operation: 'status', operationId: 'x', script }, 'script', 'unsupported_argument');
  add('script-wait-budget', 'script', { operation: 'wait', operationId: 'x', waitMs: 60001 }, 'waitMs');
  add('script-decision-required', 'script', { operation: 'decide', operationId: 'x', requestId: 'r', revision: 1 }, 'decision', 'missing_argument');
  add('evidence-verify-no-export-fields', 'evidence', { operation: 'verify', archiveDir: '/unusable', manifestSha256: 'a'.repeat(64), namespace: 'intent' }, 'namespace', 'unsupported_argument');
  add('flutter-payload-is-object', 'flutter-action', { ...commandTarget, payload: '{"action":"back"}' }, 'payload');
  add('flutter-id-owned-by-host', 'flutter-action', { ...commandTarget, payload: { action: 'back', actionId: 'forged' } }, 'payload.actionId', 'unsupported_argument');
  add('flutter-back-forbids-coordinates', 'flutter-action', { ...commandTarget, payload: { action: 'back', x: 0 } }, 'payload.x', 'unsupported_argument');
  add('flutter-input-coordinates-paired', 'flutter-action', { ...commandTarget, payload: { action: 'inputText', text: '', x: 0 } }, 'payload');
  add('ios-flutter-same-payload-contract', 'ios-flutter-action', { deviceId: 'unused-ios', bundleId: 'example.contract', payload: { action: 'swipe', startX: 0, startY: 1, endX: 2, endY: 3, durationMs: 1 } }, 'payload.durationMs', 'unsupported_argument');
  add('web-target-explicit', 'web-state', {}, 'sessionId', 'missing_argument');
  add('web-custom-action-explicit', 'web-command', { sessionId: 'unused-web', runtimeEpoch: 'unused-epoch', name: 'demo.action' }, 'name');
  add('web-input-value-required', 'web-command', { sessionId: 'unused-web', runtimeEpoch: 'unused-epoch', name: 'input', arguments: { selector: '#field' } }, 'arguments.value', 'missing_argument');
  add('web-state-no-unused-arguments', 'web-command', { sessionId: 'unused-web', runtimeEpoch: 'unused-epoch', name: 'state', arguments: { limit: 10 } }, 'arguments.limit', 'unsupported_argument');
  return cases;
}

async function verifyExecutionContract({ out, serverPath }) {
  const directory = path.join(out, 'execution-contract'); fs.mkdirSync(directory);
  const blockedStore = path.join(directory, 'not-a-store');
  fs.writeFileSync(blockedStore, 'This file must never be opened as a FactStore directory.');
  const marker = path.join(directory, 'forbidden-io');
  const adb = path.join(directory, 'controlled-adb');
  fs.writeFileSync(adb, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)}, 'device IO');\n`, { mode: 0o755 });
  const source = `module.exports.main=()=>require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'program executed');`;
  const client = createMcpClient({ serverPath, env: { AI_APP_BRIDGE_FACT_STORE_DIR: blockedStore },
    transcriptPath: path.join(directory, 'mcp.jsonl'), stderrPath: path.join(directory, 'stderr.log') });
  const results = [];
  try {
    await client.initialize();
    for (const item of invalidCases({ adb, source })) {
      const response = await client.request('tools/call', { name: 'run', arguments: { command: item.command, arguments: item.args } });
      const result = payloadOf(response);
      assert.equal(result.error, item.error, `${item.name}: ${JSON.stringify(result)}`);
      assert.equal(result.field, item.field, `${item.name}: ${JSON.stringify(result)}`);
      assert.equal(result.dispatched, false); assert.equal(result.ambiguous, false);
      assert.equal(response.result.isError, true);
      results.push({ name: item.name, command: item.command, error: result.error, field: result.field });
    }
  } finally { await client.close(); }
  assert.equal(fs.readFileSync(blockedStore, 'utf8'), 'This file must never be opened as a FactStore directory.');
  assert.equal(fs.existsSync(marker), false, 'invalid input must cause no device or program I/O');
  const report = { ok: true, rejectedCases: results.length, openedFactStore: false, providerOrProgramDispatched: false, results };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

async function verifyAutonomousContract({ out, serverPath }) {
  const directory = path.join(out, 'autonomous-contract'); fs.mkdirSync(directory);
  const io = path.join(directory, 'adb.jsonl');
  const adb = path.join(directory, 'controlled-adb');
  const uia = await require('../../test-support/uia-runtime-fixture').createUiaRuntimeFixture({
    directory: path.join(directory, 'uia'), serial: 'contract-probe',
    xml: '<hierarchy><node package="example.contract" text="Ready" enabled="true" bounds="[0,0][100,100]"/></hierarchy>' });
  fs.writeFileSync(adb, `#!${process.execPath}
const fs=require('node:fs');
if (require(${JSON.stringify(require.resolve('../../test-support/uia-runtime-fixture'))}).handleUiaRuntimeFixture(process.argv.slice(2), { directory: ${JSON.stringify(uia.directory)} })) process.exit(0);
const call=require(${JSON.stringify(require.resolve('../../test-support/android-shell-fixture'))}).handleAndroidShellFixture(process.argv.slice(2));
if(call.handled)process.exit(0); const args=call.args;
fs.appendFileSync(${JSON.stringify(io)}, JSON.stringify(args)+'\\n');
if(args.includes('dumpsys') && args.includes('window'))process.stdout.write('mCurrentFocus=Window{test u0 example.contract/example.contract.MainActivity}');
`, { mode: 0o755 });
  const client = createMcpClient({ serverPath, env: { AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'facts'), AI_APP_BRIDGE_FACT_CACHE_PROFILE: '64mb',
    AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR: path.join(directory, 'ownership') },
    transcriptPath: path.join(directory, 'mcp.jsonl'), stderrPath: path.join(directory, 'stderr.log') });
  const run = async (command, args) => payloadOf(await client.request('tools/call', { name: 'run', arguments: { command, arguments: args } }));
  const results = [];
  try {
    await client.initialize();
    for (const kind of ['complete', 'malformed', 'action']) {
      const calls = path.join(directory, `${kind}-agent.jsonl`);
      const agentModule = path.join(directory, `${kind}-agent.js`);
      const answer = kind === 'malformed' ? 'null' : kind === 'complete'
        ? "{decisionId:'done', basedOnRevision:input.revision, agentDecision:'complete'}"
        : "{decisionId:'act', basedOnRevision:input.revision, agentDecision:'act', action:{action:'keyevent',keyCode:0}}";
      fs.writeFileSync(agentModule, `exports.decide=input=>{require('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(input)+'\\n');return ${answer};};`);
      let result = await run('intent', { operation: 'start', operationId: `contract-${kind}`, goal: 'Verify public autonomous decision control',
        mode: 'autonomous', agentModule, provider: 'uia', target: { platform: 'android', serial: 'contract-probe', packageName: 'example.contract', adb },
        budget: { maxSteps: 10, maxAgentCalls: 1, maxDurationMs: 10000, allowlist: ['keyevent'] } });
      if (kind === 'malformed') {
        assert.equal(result.status, 'waiting_for_decision'); assert.equal(result.error, 'invalid_argument');
        assert.equal(result.field, 'decision');
        const state = await run('intent', { operation: 'status', operationId: result.operationId });
        assert.equal(state.history.items.some(item => item.kind === 'decision'), false);
        result = await run('intent', { operation: 'decide', operationId: result.operationId,
          decision: { decisionId: 'corrected', basedOnRevision: result.revision, agentDecision: 'complete' } });
      }
      assert.equal(result.status, kind === 'action' ? 'intervention_required' : 'completed', JSON.stringify(result));
      if (kind === 'action') { assert.equal(result.error, 'max_agent_calls'); assert.equal(result.lastAction.dispatched, true); }
      assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1);
      results.push({ name: kind, operationId: result.operationId, status: result.status, agentCalls: 1,
        terminalEvidenceId: result.terminalEvidenceId, lastAction: result.lastAction });
    }
  } finally { await client.close(); await uia.close(); }
  const actions = fs.readFileSync(io, 'utf8').trim().split('\n').map(JSON.parse).filter(args => args.includes('input'));
  assert.deepEqual(actions, [['-s', 'contract-probe', 'shell', 'input', 'keyevent', '0']]);
  const report = { ok: true, provider: 'controlled ADB subprocess; no real device', results, actions };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

module.exports = { invalidCases, verifyExecutionContract, verifyAutonomousContract };
