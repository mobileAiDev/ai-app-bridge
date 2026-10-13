'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { WebBridgeProvider } = require('../bin/web-provider');
const { validateCommandArguments } = require('../bin/command-registry');

const original = { sessionId: 'recovery-page', runtimeEpoch: 'original-document', targetId: 'main' };

function validateHints(reply) {
  assert.ok(reply.guidance?.message);
  assert.ok(reply.guidance.nextActions.length);
  for (const call of reply.guidance.nextActions) validateCommandArguments(call.command, call.arguments);
}

test('a disconnected document exposes diagnosis and explicit original-epoch history without replay', async () => {
  const provider = new WebBridgeProvider({ store: {} });
  provider.sessions.set(original.sessionId, { ...original, socket: null });
  const reply = await provider.run('web-click', { ...original, selector: { text: 'Save', tag: 'button' } });
  assert.equal(reply.error, 'web_target_disconnected');
  assert.equal(reply.dispatched, false);
  assert.equal(reply.ambiguous, false);
  validateHints(reply);
  assert.match(reply.guidance.message, /same document/i);
  assert.deepEqual(reply.guidance.nextActions.map(call => call.command), ['web-provider-status', 'web-sessions', 'web-dom']);
  assert.deepEqual(reply.guidance.nextActions.at(-1).arguments, { ...original, history: true, limit: 1 });
  assert.equal(reply.guidance.nextActions.some(call => call.command === 'web-click'), false);
});

test('a changed document exposes the actual current target and keeps the old requested identity separate', async () => {
  const provider = new WebBridgeProvider({ store: {} });
  const current = { ...original, runtimeEpoch: 'current-document' };
  provider.sessions.set(original.sessionId, { ...current, socket: { readyState: 1 } });
  const reply = await provider.run('web-dom', original);
  assert.equal(reply.error, 'web_target_changed');
  assert.equal(reply.dispatched, false);
  validateHints(reply);
  assert.deepEqual(reply.currentTarget, current);
  assert.deepEqual(reply.guidance.nextActions.at(-1), { command: 'web-dom', arguments: current, extract: null });
  assert.equal(original.runtimeEpoch, 'original-document');
});

test('an unknown session exposes discovery without inventing a target or an endpoint', async () => {
  const provider = new WebBridgeProvider({ store: {} });
  const reply = await provider.run('web-dom', original);
  assert.equal(reply.error, 'web_session_not_found');
  validateHints(reply);
  assert.deepEqual(reply.guidance.nextActions.map(call => call.command), ['web-provider-status', 'web-sessions']);
  assert.equal(reply.currentTarget, undefined);
});

test('session expiry during a failed asynchronous read preserves its original target-change diagnosis', async () => {
  const provider = new WebBridgeProvider({ store: {}, now: () => 400000 });
  const current = { ...original, runtimeEpoch: 'current-document' };
  provider.sessions.set(original.sessionId, { ...current, socket: null, disconnectedAtMs: 0 });
  const pending = provider.run('web-dom', original);
  const sessions = await provider.run('web-sessions');
  assert.equal(sessions.count, 0);
  const reply = await pending;
  assert.equal(reply.error, 'web_target_changed');
  assert.equal(reply.dispatched, false);
  assert.deepEqual(reply.currentTarget, current);
  validateHints(reply);
  assert.deepEqual(reply.guidance.nextActions.at(-1).arguments, current);
});
