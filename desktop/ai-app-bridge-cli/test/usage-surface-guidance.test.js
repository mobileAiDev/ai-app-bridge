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
const scriptSpec = target => ({ schemaVersion: 'aab.code-script/v1', name: 't', language: 'javascript', source: 'exports.main = async () => {};', target, permissions: ['app.read'] });
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
  assert.equal(rejection('script', { operation: 'start', script: scriptSpec({ platform: 'android', serial: 'd' }) }).field, 'script.target.packageName');
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
    { code: 'invalid_argument', field: 'operation', message: 'operation must be one of: start, result, status, wait, pause, resume, cancel, decide, runtime-status.' });
});

test('the two continuation cursors are documented in the exposed schemas', () => {
  const wait = commandInputSchema('script', { operation: 'wait' }).properties;
  assert.match(wait.afterSequence.description, /eventSequence/);
  assert.match(wait.afterSequence.description, /Not history\.lastSequence/);
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
