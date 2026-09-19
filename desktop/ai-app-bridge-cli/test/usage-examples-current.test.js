'use strict';

// Improvement release V1, M1: the documented Script and Intent lifecycle
// examples run against the current contract. Sources are read from the docs so
// the published text and the executed program cannot drift apart.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { handle: scriptHandle } = require('../bin/script/script-entry');
const { handle: intentHandle, resetIntentOperations } = require('./helpers/intent-entry');
const { createFakeIntentDeviceAdapter } = require('../bin/intent/intent-device-adapter');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createScriptEvidenceStore } = require('../bin/script/script-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { validateRunRequest } = require('../bin/command-request');
const { inspectPython } = require('../bin/script/python-runtime-adapter');

const authoring = fs.readFileSync(path.resolve(__dirname, '../docs/SCRIPT_AUTHORING.md'), 'utf8');
const contract = fs.readFileSync(path.resolve(__dirname, '../docs/COMMAND_CONTRACT.md'), 'utf8');
const fenced = (text, info) => [...text.matchAll(new RegExp('```' + info + '\\n([\\s\\S]*?)```', 'g'))].map(match => match[1]);
// Lifecycle blocks hold one run call per line.
const documentedRun = (text, command, operation) => fenced(text, 'json lifecycle-example').flatMap(block => block.trim().split('\n')).map(line => JSON.parse(line))
  .filter(call => call.command === command && call.arguments.operation === operation);
const target = { platform: 'android', serial: 'example-device', packageName: 'com.example.notes' };
const nodes = text => ({ ok: true, compact: true, nodes: [{ className: 'TextView', text, visible: true, clickable: true, bounds: [0, 0, 100, 40] }] });

// Result persistence that takes longer than one wait call, so the caller
// observes status "finishing" before the terminal status.
function slowResultAdapter(delayMs) {
  const adapter = createMemoryEvidenceAdapter();
  const record = adapter.record;
  adapter.record = envelope => envelope.kind === 'result'
    ? new Promise(resolve => setTimeout(() => resolve(record(envelope)), delayMs))
    : record(envelope);
  return adapter;
}

// The documented three-call lifecycle: start, wait while running or finishing, then result.
async function runDocumentedScript(language, source, adapter = createMemoryEvidenceAdapter()) {
  const commands = [];
  const store = createScriptEvidenceStore({ adapter });
  const [startCall] = documentedRun(authoring, 'script', 'start');
  const [waitCall] = documentedRun(authoring, 'script', 'wait');
  const [resultCall] = documentedRun(authoring, 'script', 'result');
  const startArguments = { ...startCall.arguments, script: { ...startCall.arguments.script, language, source, target } };
  delete startArguments.script.sourcePath;
  validateRunRequest({ ...startCall, arguments: startArguments });
  const started = await scriptHandle({ ...startArguments, store,
    actions: async (command, args) => {
      commands.push(command);
      if (command === 'tree') return nodes(commands.includes('tap-text') ? 'New label' : 'Labels');
      if (command === 'tap-text') return { ok: true, matched: { text: args.targetText }, x: 50, y: 20 };
      throw new Error(`unexpected device command ${command}`);
    } });
  assert.equal(started.ok, true, JSON.stringify(started));
  const resultArguments = { ...resultCall.arguments, operationId: started.operationId };
  validateRunRequest({ ...resultCall, arguments: resultArguments });
  let page = { status: 'running', eventSequence: waitCall.arguments.afterSequence };
  const events = [];
  const statuses = [];
  let earlyResult = null;
  for (let polls = 0; ['running', 'finishing'].includes(page.status); polls += 1) {
    assert(polls < 200, 'documented wait loop did not finish');
    const waitArguments = { ...waitCall.arguments, operationId: started.operationId, waitMs: 200, afterSequence: page.eventSequence };
    validateRunRequest({ ...waitCall, arguments: waitArguments });
    page = await scriptHandle(waitArguments);
    events.push(...page.events);
    statuses.push(page.status);
    // Reading the result while the run is still finishing is the mistake the loop avoids.
    if (page.status === 'finishing' && !earlyResult) earlyResult = await scriptHandle(resultArguments);
  }
  const result = await scriptHandle(resultArguments);
  await store.close();
  return { started, page, events, statuses, earlyResult, result, commands };
}

for (const language of ['javascript', 'python']) {
  test(`the documented ${language} regression example runs start → wait → result on the current contract`, async t => {
    if (language === 'python' && !inspectPython().available) { t.skip('python3 >= 3.9 is not installed'); return; }
    const [source] = fenced(authoring, language + ' regression-example');
    assert(source, `SCRIPT_AUTHORING.md lacks the ${language} regression-example block`);
    const run = await runDocumentedScript(language, source);
    assert.equal(run.page.status, 'completed', JSON.stringify(run.page));
    assert.deepEqual(run.commands, ['tree', 'tap-text', 'tree']);
    assert.equal(run.events.map(event => event.type).filter(type => type === 'progress').length, 1);
    assert.equal(run.result.ok, true, JSON.stringify(run.result));
    assert.equal(run.result.persisted, true);
    assert.deepEqual(run.result.result.cases, [
      { name: 'entry control is visible', verdict: 'passed', reason: null },
      { name: 'expected text is shown after the tap', verdict: 'passed', reason: null },
    ]);
    assert.equal(run.result.result.actionId, `${run.started.operationId}:action-1`);
    // Each afterSequence continued from the previous eventSequence, so no event arrived twice.
    assert.equal(new Set(run.events.map(event => event.sequence)).size, run.events.length);
  });
}

test('the documented wait loop keeps waiting through finishing while the result is persisted slowly', async () => {
  const [source] = fenced(authoring, 'javascript regression-example');
  const run = await runDocumentedScript('javascript', source, slowResultAdapter(700));
  assert.equal(run.statuses.includes('finishing'), true, JSON.stringify(run.statuses));
  assert.equal(run.statuses.at(-1), 'completed');
  assert.equal(run.earlyResult.ok, false);
  assert.equal(run.earlyResult.error, 'result_not_ready', JSON.stringify(run.earlyResult));
  assert.equal(run.result.ok, true, JSON.stringify(run.result));
  assert.equal(run.result.result.cases.length, 2);
});

test('the documented Intent lifecycle pages history with history.lastSequence and never acts alone', async () => {
  resetIntentOperations();
  const calls = documentedRun(contract, 'intent', 'start').concat(documentedRun(contract, 'intent', 'decide'), documentedRun(contract, 'intent', 'status'));
  assert.equal(calls.length, 5, 'COMMAND_CONTRACT.md documents start, two decisions and two status pages');
  const [start, act, complete, firstPage, nextPage] = [calls[0], calls[1], calls[2], calls[3], calls[4]];
  const adapter = createFakeIntentDeviceAdapter({ trees: { native: { root: { id: 'root', className: 'FrameLayout', clickable: false, children: [
    { id: 'labels', className: 'Button', text: 'Labels', clickable: true, children: [] }] } } } });
  const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  const startArguments = { ...start.arguments, target };
  validateRunRequest({ ...start, arguments: startArguments });
  const started = await intentHandle({ ...startArguments, adapter, store });
  assert.equal(started.status, 'waiting_for_decision', JSON.stringify(started));
  assert.equal(started.revision, 1);
  assert.equal(adapter.calls.filter(call => call.name === 'action').length, 0, 'supervised start observes only');

  const actArguments = { ...act.arguments, operationId: started.operationId, decision: { ...act.arguments.decision, basedOnRevision: started.revision } };
  validateRunRequest({ ...act, arguments: actArguments });
  const acted = await intentHandle(actArguments);
  assert.equal(acted.status, 'waiting_for_decision', JSON.stringify(acted));
  assert.equal(acted.revision, 2);
  assert.equal(adapter.calls.filter(call => call.name === 'action').length, 1);

  const pageArguments = { ...firstPage.arguments, operationId: started.operationId };
  validateRunRequest({ ...firstPage, arguments: pageArguments });
  const page = await intentHandle({ ...pageArguments, limit: 2 });
  assert.equal(page.history.items.length, 2);
  assert.equal(page.history.hasMore, true);
  assert.equal(page.history.lastSequence, page.history.items.at(-1).sequence);
  assert.notEqual(page.history.lastSequence, page.eventSequence, 'history and event cursors are different sequences');
  const continuation = { ...nextPage.arguments, operationId: started.operationId, limit: 2, afterSequence: page.history.lastSequence };
  validateRunRequest({ ...nextPage, arguments: continuation });
  const next = await intentHandle(continuation);
  assert.equal(next.history.items[0].sequence > page.history.lastSequence, true);
  assert.equal(new Set([...page.history.items, ...next.history.items].map(item => item.sequence)).size, 4, 'the two pages share no entry');

  const completeArguments = { ...complete.arguments, operationId: started.operationId, decision: { ...complete.arguments.decision, basedOnRevision: acted.revision } };
  validateRunRequest({ ...complete, arguments: completeArguments });
  const finished = await intentHandle(completeArguments);
  assert.equal(finished.status, 'completed', JSON.stringify(finished));
  assert.equal(adapter.calls.filter(call => call.name === 'action').length, 1, 'complete is a judgment, not an action');
  resetIntentOperations();
});
