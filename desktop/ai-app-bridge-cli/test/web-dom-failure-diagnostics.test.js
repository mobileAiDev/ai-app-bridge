'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WebBridgeProvider } = require('../bin/web-provider');
const { normalizeCommandResult } = require('../bin/command-errors');

const target = { sessionId: 'query-diagnostics', runtimeEpoch: 'document-one', targetId: 'main' };

function fixture(result) {
  const provider = new WebBridgeProvider({ store: { record() { assert.fail('A failed read must not be stored as a DOM snapshot'); } } });
  provider.sessions.set(target.sessionId, { ...target, socket: { readyState: 1 } });
  provider.request = async (_session, type, payload) => {
    assert.equal(type, 'read'); assert.equal(payload.name, 'domSnapshot'); return result;
  };
  return provider;
}

test('an explicit SDK DOM query failure preserves the diagnostic and confirmed read outcome', async () => {
  const source = { ok: false, error: 'web_dom_query_failed',
    message: "Failed to execute 'querySelectorAll' on 'Document': '[' is not a valid selector.",
    details: { selector: '[' } };
  const reply = normalizeCommandResult(await fixture(source).run('web-dom', { ...target, selector: '[' }), 'web-dom');
  assert.equal(reply.error, source.error);
  assert.equal(reply.message, source.message);
  assert.deepEqual(reply.details, source.details);
  assert.equal(reply.dispatched, true);
  assert.equal(reply.ambiguous, false);
  assert.equal(reply.settled, true);
  for (const [key, value] of Object.entries(target)) assert.equal(reply[key], value);
});

test('a rejected DOM snapshot preserves its own source diagnostic', async () => {
  const dom = { ok: false, error: 'web_dom_query_failed', message: 'The scoped root selector is invalid.' };
  const reply = normalizeCommandResult(await fixture({ ok: true, dom }).run('web-dom', target), 'web-dom');
  assert.equal(reply.error, dom.error);
  assert.equal(reply.message, dom.message);
  assert.equal(reply.ambiguous, false);
  assert.equal(reply.settled, true);
});

test('a missing snapshot has an actionable protocol diagnosis without inventing a successful observation', async () => {
  const reply = normalizeCommandResult(await fixture({ ok: true }).run('web-dom', target), 'web-dom');
  assert.equal(reply.error, 'invalid_web_dom');
  assert.match(reply.message, /snapshot/i);
  assert.equal(reply.ambiguous, false);
  assert.equal(reply.settled, true);
});

test('an unanswered DOM request keeps the original uncertain transport outcome', async () => {
  const provider = fixture(null);
  provider.request = async () => { throw Object.assign(new Error('The original Web request did not return a confirmed result.'),
    { code: 'web_connection_lost', dispatched: null, ambiguous: true, settled: false }); };
  const reply = await provider.run('web-dom', target);
  assert.equal(reply.error, 'web_connection_lost');
  assert.equal(reply.ambiguous, true);
  assert.equal(reply.settled, false);
});
