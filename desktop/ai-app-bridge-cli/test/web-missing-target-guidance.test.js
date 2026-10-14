'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withActionGuidance, selectionFailure } = require('../bin/shared-kernel/action-guidance');
const { validateCommandArguments } = require('../bin/command-registry');
const { createWebIntentDeviceAdapter } = require('../bin/intent/web-intent-adapter');
const { createScriptHostPort } = require('../bin/script/script-host-port');
const { schema } = require('../bin/shared-kernel/web-dom-target');

const target = { sessionId: 'missing-control', runtimeEpoch: 'current-document', targetId: 'main' };

test('missing Web controls offer the same target and selector as optional read/wait calls', () => {
  for (const selector of [{ text: 'Delayed submit', tag: 'button' }, { css: '[data-action="save"]' }, { ariaLabel: 'Search', role: 'textbox' }]) {
    const original = selectionFailure('web_element_not_found', []);
    const args = { ...target, selector, requestId: 'original-attempt' };
    const reply = withActionGuidance('web-click', args, original);
    const { guidance, ...unchanged } = reply;
    assert.deepEqual(unchanged, original);
    assert.deepEqual(guidance?.nextActions.map(action => [action.command, action.arguments]), [
      ['web-dom', { ...target, query: selector }], ['web-wait', { ...target, selector }],
    ]);
    assert.match(guidance.message, /if.*load/i);
    assert.match(guidance.message, /not.*replay/i);
    for (const action of guidance.nextActions) validateCommandArguments(action.command, action.arguments);
    assert.equal(args.requestId, 'original-attempt');
    assert.deepEqual(withActionGuidance('web-click', args, reply), reply);
  }
});

test('an absent observed element ID suggests a new observation without waiting for the stale ID', () => {
  const selector = { elementId: 'old-node', text: 'Submit' };
  const reply = withActionGuidance('web-input', { ...target, selector, value: 'sensitive input' }, selectionFailure('web_element_not_found', []));
  assert.deepEqual(reply.guidance?.nextActions.map(action => [action.command, action.arguments]), [
    ['web-dom', target],
  ]);
  assert.equal(JSON.stringify(reply.guidance).includes('sensitive input'), false);
  assert.match(reply.guidance.message, /elementId/);
});

test('missing Web controls do not overwrite an existing provider recovery decision', () => {
  const original = { ...selectionFailure('web_element_not_found', []), guidance: { message: 'Provider-specific context', nextActions: [] } };
  assert.deepEqual(withActionGuidance('web-click', { ...target, selector: { text: 'Submit' } }, original), original);
});

test('typed Web Intent exposes missing-control guidance before any provider action is submitted', async () => {
  const calls = [];
  const adapter = createWebIntentDeviceAdapter({ provider: { run: async (...args) => { calls.push(args); assert.fail('No provider action may run for a missing observed control'); } } });
  const selector = { text: 'Delayed submit', tag: 'button' };
  const reply = await adapter.action({ ...target, spec: { action: 'tap', selector },
    rawTree: { webTargetSchema: schema, dom: { targetSchema: schema, truncated: false, controls: [] } } });
  assert.equal(reply.error, 'web_element_not_found');
  assert.equal(reply.dispatched, false);
  assert.equal(reply.ambiguous, false);
  assert.equal(calls.length, 0);
  assert.deepEqual(reply.guidance?.nextActions.map(action => [action.command, action.arguments]), [
    ['web-dom', { ...target, query: selector }], ['web-wait', { ...target, selector }],
  ]);
});

test('Script returns the same missing-control diagnosis and suggestions without issuing the suggested wait', async () => {
  const calls = [];
  const host = createScriptHostPort({ executionId: 'missing-control-script', target: { platform: 'web', ...target },
    actions: async (command, args) => {
      calls.push({ command, args });
      return withActionGuidance(command, args, selectionFailure('web_element_not_found', []));
    } });
  const selector = { text: 'Submit', tag: 'button' };
  const reply = await host.call('web-click', { selector });
  assert.equal(reply.error, 'web_element_not_found');
  assert.equal(reply.dispatched, false);
  assert.equal(reply.ambiguous, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'web-click');
  assert.deepEqual(reply.guidance, reply.result.guidance);
  assert.deepEqual(reply.guidance.nextActions.map(action => action.command), ['web-dom', 'web-wait']);
  for (const action of reply.guidance.nextActions) validateCommandArguments(action.command, action.arguments);
});
