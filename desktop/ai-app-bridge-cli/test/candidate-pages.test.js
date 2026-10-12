'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const host = require('../bin/execution-host');
const { createResponseStore } = require('../bin/response-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { publicReply, finishReply, responseReply } = require('../bin/public-reply');
const { selectionFailure, withActionGuidance } = require('../bin/shared-kernel/action-guidance');
const { validateCommandArguments } = require('../bin/command-registry');
test.after(() => host.close());

const candidates = Array.from({ length: 75 }, (_, i) => ({ text: `Choice ${i}: ` + 'long visible description '.repeat(30),
  selector: { viewId: `view-${i}` }, bounds: { left: 0, top: i * 50, right: 100, bottom: i * 50 + 40 } }));

test('full candidates survive delivery, and saved pages advance without repeating the action', async () => {
  const store = createResponseStore({ adapter: createMemoryEvidenceAdapter() }); let calls = 0;
  const dependencies = { responseStore: store, factRecorder: null, observationCollector: null,
    rawRunner: async () => { calls++; return selectionFailure('native_selector_ambiguous', candidates); } };
  const initial = (await host.run({ command: 'tap-native', arguments: { serial: 'candidate-pages', packageName: 'example.app',
    selector: { text: 'Choice' }, feedback: 'off' }, output: { maxBytes: 32768 } }, dependencies)).value;
  assert.equal(initial.execution.dispatched, false); assert.equal(initial.execution.matched, 75);
  assert.ok(Buffer.byteLength(JSON.stringify(initial)) <= 98304);
  assert.equal(initial.control.source.persisted, true);
  const frozen = store.read(initial.control.source.ref);
  assert.deepEqual(frozen.snapshot.value.candidates, candidates);
  assert.equal(frozen.snapshot.value.candidatesTruncated, false);
  const seen = [...initial.control.candidates]; let page = initial.control.candidatePage;
  assert.ok(page.count > 0 && page.count <= 20); assert.equal(page.available, 75);
  while (page.hasMore) {
    assert.ok(page.read); validateCommandArguments(page.read.command, page.read.arguments);
    const reply = (await host.run(page.read, dependencies)).value;
    seen.push(...reply.value); page = reply.control.candidatePage;
    assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= 98304);
  }
  assert.deepEqual(seen, candidates); assert.equal(calls, 1);
});

test('Intent lastAction candidates remain available through extraction without bloating protected control', async () => {
  const store = createResponseStore({ adapter: createMemoryEvidenceAdapter() });
  const value = { ok: false, error: 'native_selector_ambiguous', operationId: 'intent-choices', revision: 4,
    lastAction: { ...selectionFailure('native_selector_ambiguous', candidates), actionId: 'old-action' } };
  const reply = await finishReply({ body: publicReply({ command: 'intent', reply: { value } }),
    extract: { mode: 'select', path: '/revision' }, output: { maxBytes: 16384 }, getStore: () => store });
  assert.equal(reply.value, 4); assert.equal(reply.control.lastAction.actionId, 'old-action');
  assert.equal(reply.control.lastAction.candidatePage.available, 75);
  assert.equal(reply.control.lastAction.candidatePage.read.extract.path, '/lastAction/candidates');
  assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= 16384);
  assert.deepEqual(store.read(reply.control.source.ref).snapshot.value.lastAction.candidates, candidates);
});

test('large candidate pages adapt to bytes and remain readable without mutating the frozen continuation', async () => {
  const store = createResponseStore({ adapter: createMemoryEvidenceAdapter() });
  const wide = Array.from({ length: 45 }, (_, i) => ({ selector: { viewId: `long-${i}` }, text: `${i}:` + 'long label '.repeat(600) }));
  let reply = await finishReply({ body: publicReply({ command: 'tap-native', reply: { value: selectionFailure('native_selector_ambiguous', wide) } }),
    extract: { mode: 'select', path: '/ok' }, getStore: () => store });
  const seen = [...reply.control.candidates]; let smallerPage = false;
  while (reply.control.candidatePage.hasMore) {
    const read = reply.control.candidatePage.read; smallerPage ||= read.extract.limit < 20;
    const frozen = store.read(read.arguments.ref), originalControl = structuredClone(frozen.snapshot.control);
    reply = await finishReply({ body: responseReply(frozen), extract: read.extract, frozen });
    assert.equal(reply.delivery.status, 'inline'); assert.ok(Array.isArray(reply.value));
    assert.deepEqual(frozen.snapshot.control, originalControl); seen.push(...reply.value);
    assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= 98304);
  }
  assert.equal(smallerPage, true); assert.deepEqual(seen, wide);
});

test('a provider-truncated selection advertises fresh observation instead of pretending the saved response has missing candidates', () => {
  const args = { sessionId: 's', runtimeEpoch: 'r', selector: { text: 'Agree' } };
  const value = withActionGuidance('web-click', args, { ok: false, error: 'web_element_ambiguous', dispatched: false,
    details: { matched: 200, candidatesTruncated: true, selectionRequired: true, candidates: [{ text: 'Agree', selector: { elementId: 'e1' } }],
      candidateQuery: { query: args.selector, offset: 20, maxControls: 200 } } });
  const reply = publicReply({ command: 'web-click', reply: { value } });
  assert.equal(reply.control.candidatePage.sourceTruncated, true);
  assert.equal(reply.control.candidatePage.matched, 200);
  assert.equal(reply.control.candidatePage.hasMore, false);
  const read = value.guidance.nextActions.find(call => call.command === 'web-dom');
  assert.deepEqual(read.arguments.query, args.selector); validateCommandArguments(read.command, read.arguments);
  assert.equal(reply.execution.details.candidates, undefined);
});
