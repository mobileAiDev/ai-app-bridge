'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { capabilities, commandInputSchema } = require('../bin/command-discovery');
const { commandSchema } = require('../bin/command-registry');
const { validateValue } = require('../bin/shared-kernel/argument-schema');
const { callTool } = require('../bin/mcp-server');

test('the light directory preserves every command while details remain explicit', () => {
  const directory = Object.values(capabilities().domains).flat();
  const expanded = Object.values(capabilities({ includeOptions: true }).domains).flat();
  assert.deepEqual(directory.map(x => x.command), expanded.map(x => x.command));
  assert.ok(directory.every(x => typeof x.summary === 'string' && !Object.hasOwn(x, 'inputSchema') && !Object.hasOwn(x, 'scriptCatalog')));
  assert.ok(expanded.every(x => x.inputSchema && x.entrypoints));
  const domain = capabilities({ domain: 'execution' }).domains;
  assert.deepEqual(Object.keys(domain), ['execution']);
  assert.ok(domain.execution.some(x => x.command === 'intent'));
});

test('operation selection keeps both Intent start modes and rejects other operations', () => {
  const target = { platform: 'android', serial: 'test-device', packageName: 'example.app' };
  const schema = commandInputSchema('intent', { operation: 'start' });
  assert.equal(schema.anyOf.length, 2);
  validateValue({ operation: 'start', target, goal: 'Observe' }, schema);
  validateValue({ operation: 'start', target, goal: 'Observe', mode: 'autonomous', agentModule: '/agent.js' }, schema);
  assert.throws(() => validateValue({ operation: 'status', operationId: 'x' }, schema), { field: 'operation' });
  for (const command of ['intent', 'script', 'evidence']) {
    const original = commandSchema(command);
    assert.deepEqual(commandInputSchema(command), original);
    for (const operation of original.properties.operation.enum) {
      const selected = commandInputSchema(command, { operation });
      assert.ok((selected.anyOf || [selected]).every(branch => branch.properties.operation.const === operation));
      assert.deepEqual(selected.properties.operation.enum || [selected.properties.operation.const], [operation]);
    }
  }
});

test('Intent action discovery narrows to the actual platform and provider contract', () => {
  const selected = commandInputSchema('intent', { operation: 'decide', platform: 'android', provider: 'native', action: 'tap' });
  const request = { operation: 'decide', operationId: 'i', decision: { decisionId: 'd', basedOnRevision: 1, agentDecision: 'act', action: { action: 'tap', provider: 'native', selector: { resourceName: 'example.app:id/open' } } } };
  validateValue(request, selected);
  assert.throws(() => validateValue({ ...request, decision: { ...request.decision, action: { ...request.decision.action, provider: 'uia' } } }, selected));
  assert.throws(() => validateValue({ ...request, decision: { ...request.decision, action: { action: 'back', provider: 'native' } } }, selected));
  validateValue({ ...request, decision: { decisionId: 'done', basedOnRevision: 2, agentDecision: 'complete' } }, selected);
  const web = commandInputSchema('intent', { operation: 'decide', platform: 'web' });
  assert.deepEqual(web.properties.decision.properties.action.properties.provider, { const: 'h5' });
  const ios = commandInputSchema('intent', { operation: 'decide', platform: 'ios', provider: 'native' });
  assert.ok(ios.properties.decision.properties.action.properties.action.enum.includes('setOrientation'));
  assert.ok(!ios.properties.decision.properties.action.properties.action.enum.includes('back'));
});

test('invalid discovery scope returns an actionable field', () => {
  const cases = [
    [{ operation: 'start' }, 'operation'],
    [{ command: 'tree', operation: 'start' }, 'operation'],
    [{ command: 'intent', operation: 'missing' }, 'operation'],
    [{ command: 'intent', operation: 'start', provider: 'native' }, 'provider'],
    [{ command: 'intent', operation: 'decide', platform: 'other' }, 'platform'],
    [{ command: 'intent', operation: 'decide', platform: 'web', provider: 'native' }, 'provider'],
    [{ command: 'intent', operation: 'decide', platform: 'ios', provider: 'native', action: 'back' }, 'action'],
    [{ command: 'intent', operation: 1 }, 'operation'],
  ];
  for (const [args, field] of cases) {
    const result = capabilities(args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.field, field, JSON.stringify(args));
  }
});

test('CLI help and MCP expose the same selected schema without starting execution', async () => {
  const args = { command: 'intent', operation: 'decide', platform: 'android', provider: 'native', action: 'tap' };
  const cli = spawnSync(process.execPath, [path.join(__dirname, '../bin/ai-app-bridge.js'), '--help', 'intent', '--operation', 'decide', '--platform', 'android', '--provider', 'native', '--action', 'tap'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const mcp = JSON.parse((await callTool('capabilities', args)).content[0].text);
  assert.equal(mcp.ok, true);
  assert.deepEqual(JSON.parse(cli.stdout), mcp.inputSchema);
  assert.deepEqual(mcp.selection, { operation: 'decide', platform: 'android', provider: 'native', action: 'tap' });
  const bad = spawnSync(process.execPath, [path.join(__dirname, '../bin/ai-app-bridge.js'), '--help', 'intent', '--operation', 'missing'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.equal(JSON.parse(bad.stdout).value.field, 'operation');
});
