'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIntentWorker } = require('../bin/intent/intent-worker');
const { createIntentEvidenceStore } = require('../bin/intent/intent-evidence-store');
const { createMemoryEvidenceAdapter } = require('../bin/shared-kernel/evidence-adapters');
const { createScriptHostPort } = require('../bin/script/script-host-port');
const { getProcessDeviceMutationLease } = require('../bin/shared-kernel/device-mutation-lease');
const { runExecution } = require('../bin/shared-kernel/execution-scope');
const registry = require('../bin/command-registry');
const target = { platform: 'android', serial: 'composition-phone', packageName: 'app.test' };
test.after(() => require('../bin/execution-host').close());

function fixture(t, { commands, failedObservation = false, ...options } = {}) {
  const store = createIntentEvidenceStore({ adapter: createMemoryEvidenceAdapter() });
  let observations = 0;
  const worker = createIntentWorker({ operationId: 'composition-intent', target, goal: 'Exercise command composition', store,
    commands, timeoutMs: 10000, adapter: {
      observe: async ({ rawTreeId }) => { observations++; return failedObservation
        ? { ok: false, error: 'bridge_not_ready' }
        : { ok: true, rawTreeId, rawTree: { root: { text: 'Ready', visible: true, children: [] } } }; },
      action: async () => { throw new Error('Command must not use the UI action adapter'); },
    }, ...options });
  t.after(() => worker.cancel());
  let sequence = 0;
  return { worker, store, get observations() { return observations; }, recover: () => { failedObservation = false; },
    act: (command, args = {}, extra = {}) => worker.decide({ decisionId: `decision-${++sequence}`,
      basedOnRevision: worker.status().revision, agentDecision: 'act', action: { action: 'command', command, arguments: args, ...extra } }) };
}

test('every advertised command is available in Script, with caller-selected restrictions only', async () => {
  for (const { command } of [...registry.commandDefinitions, ...registry.isolatedCommandDefinitions]) {
    assert.equal(registry.commandContract(command).script.supported, true, command);
  }
  const host = createScriptHostPort({ target, permissions: ['app.read'], actions: async () => ({ ok: true }) });
  assert.equal((await host.call('wait-text', { targetText: 'Ready' })).ok, true);
  assert.equal((await host.call('script', { operation: 'runtime-status' })).error, 'permission_not_granted');
  for (const command of ['wait-text', 'h5-wait', 'flutter-h5-wait', 'web-wait']) assert.equal(registry.isMutationCommand(command), false, command);
});

test('Script workflow defaults inherit target without adding unsupported requestId or taking a device lease', async () => {
  const lease = getProcessDeviceMutationLease();
  const calls = [];
  const host = createScriptHostPort({ target, executionId: 'parent', actions: async (command, args, options) => {
    registry.validateCommandArguments(command, args);
    const held = lease.acquire(target.serial); assert.equal(held.ok, true); held.release();
    calls.push({ command, args, options }); return { ok: true, operationId: 'child', status: 'running' };
  } });
  const result = await host.call('script', { operation: 'start', script: { schemaVersion: 'aab.code-script/v1',
    language: 'javascript', source: 'module.exports.main = () => 1' } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls[0].args.script.target, target);
  assert.deepEqual(calls[0].options.caller, { command: 'script', operationId: 'parent' });
  assert.equal(calls[0].args.requestId, undefined);
  assert.equal(result.result.operationId, 'child');
  assert.equal((await host.call('runtime', { operation: 'status' })).ok, true);
});

test('Intent command uses the shared command target and returns output without extra UI captures', async t => {
  const calls = [];
  const f = fixture(t, { commands: async (command, args) => {
    calls.push({ command, args });
    const held = getProcessDeviceMutationLease().acquire(args.serial); assert.equal(held.ok, true); held.release();
    return { ok: true, stdout: 'ready\n', stderr: '', exitCode: 0, dispatched: true, settled: true };
  } });
  await f.worker.start();
  for (let i = 0; i < 4; i++) {
    const result = await f.act('adb-exec', { argv: ['shell', 'echo', 'ready'] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.lastAction.result.stdout, 'ready\n');
    assert.equal(result.revision, 1);
    assert.equal(result.uiObservation.stale, true);
  }
  assert.equal(f.observations, 1);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].args.serial, target.serial);
  const other = await f.act('adb-exec', { argv: ['devices'], readOnly: true }, { target: { platform: 'android', serial: 'another-phone' } });
  assert.equal(other.lastAction.commandTarget.serial, 'another-phone');
  assert.equal(f.store.list('composition-intent').filter(r => r.kind === 'action-receipt').length, 5);
});

test('an Intent with no available observation can execute recovery then observe in the same operation', async t => {
  const f = fixture(t, { failedObservation: true, commands: async () => ({ ok: true, stdout: 'launched' }) });
  const initial = await f.worker.start();
  assert.equal(initial.status, 'waiting_for_observation');
  const result = await f.act('adb-exec', { argv: ['shell', 'am', 'start', '-n', 'app.test/.Main'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.lastAction.result.stdout, 'launched');
  assert.equal(result.uiObservation.available, false);
  assert.equal(f.observations, 1);
  f.recover();
  const observed = await f.worker.observe();
  assert.equal(observed.ok, true);
  assert.equal(observed.revision, 2);
  assert.equal(observed.uiObservation.stale, false);
});

test('known command failure and unknown outcome retain receipts and allow new decisions without replay', async t => {
  let calls = 0;
  const f = fixture(t, { commands: async () => { calls++; return calls === 1
    ? { ok: false, error: 'adb_exit_nonzero', stdout: '', stderr: 'not installed', exitCode: 1, dispatched: true, ambiguous: false, settled: true }
    : calls === 2 ? { ok: false, error: 'connection_lost', dispatched: null, ambiguous: true }
      : { ok: true, stdout: 'recovered' }; } });
  await f.worker.start();
  const failed = await f.act('adb-exec', { argv: ['shell', 'false'] });
  assert.equal(failed.status, 'waiting_for_decision');
  assert.equal(failed.lastAction.result.stderr, 'not installed');
  const unknown = await f.act('adb-exec', { argv: ['shell', 'am', 'start', '-n', 'app.test/.Main'] });
  assert.equal(unknown.lastAction.ambiguous, true);
  assert.equal(unknown.status, 'waiting_for_decision');
  const next = await f.act('adb-exec', { argv: ['devices'], readOnly: true });
  assert.equal(next.ok, true);
  assert.equal(calls, 3);
  assert.equal(f.store.list('composition-intent').filter(r => r.kind === 'action-receipt' && r.ambiguous).length, 1);
});

test('invalid command is a recoverable step and explicit observeAfter captures exactly once', async t => {
  const f = fixture(t, { commands: async () => ({ ok: true }) });
  await f.worker.start();
  const invalid = await f.act('this-command-does-not-exist');
  assert.equal(invalid.error, 'unknown_command');
  assert.equal(invalid.status, 'waiting_for_decision');
  assert.equal(invalid.lastAction.dispatched, false);
  const next = await f.act('adb-exec', { argv: ['devices'] }, { observeAfter: true });
  assert.equal(next.ok, true);
  assert.equal(next.revision, 2);
  assert.equal(f.observations, 2);
});

test('autonomous Agent receives command errors and may recover within the same Intent', async t => {
  let calls = 0, decisions = 0;
  const f = fixture(t, { commands: async () => ++calls === 1 ? { ok: false, error: 'adb_exit_nonzero', settled: true, dispatched: true, ambiguous: false }
    : { ok: true, stdout: 'fixed' }, mode: 'autonomous',
    agent: { decide: async input => {
      decisions++;
      if (decisions === 2) assert.equal(input.lastAction.error, 'adb_exit_nonzero');
      return { decisionId: `auto-${decisions}`, basedOnRevision: input.revision,
        agentDecision: decisions === 3 ? 'complete' : 'act', ...(decisions === 3 ? {} : {
          action: { action: 'command', command: 'adb-exec', arguments: { argv: ['devices'], readOnly: true } } }) };
    } } });
  const result = await f.worker.start();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(calls, 2);
  assert.equal(f.observations, 1);
});

test('production Script calls child Script and reads its result through one Host, after start scope has closed', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-composed-script-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const adb = path.join(directory, 'fake-adb');
  fs.writeFileSync(adb, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));`, { mode: 0o700 });
  const host = require('../bin/execution-host');
  const child = `module.exports.main = async ctx => {
    const first = await ctx.call('adb-exec', { argv: ['shell', 'echo', 'first'], readOnly: true });
    const second = await ctx.call('adb-exec', { argv: ['shell', 'echo', 'second'], readOnly: true });
    return { first, second };
  };`;
  const source = `module.exports.main = async ctx => {
    const child = await ctx.call('script', { operation: 'start', script: { schemaVersion: 'aab.code-script/v1', language: 'javascript', source: ${JSON.stringify(child)} } });
    if (!child.ok) throw new Error(JSON.stringify(child));
    let state = child.result;
    while (!['completed','failed','cancelled'].includes(state.status)) {
      state = (await ctx.call('script', { operation: 'wait', operationId: state.operationId, afterSequence: state.eventSequence, waitMs: 1000 })).result;
    }
    return { state, result: await ctx.call('script', { operation: 'result', operationId: state.operationId }) };
  };`;
  const started = await runExecution({ timeoutMs: 2000 }, () => host.dispatchProviderCommand('script', { operation: 'start', script: {
    schemaVersion: 'aab.code-script/v1', language: 'javascript', source,
    target: { platform: 'android', serial: 'nested-script-phone', adb }, policy: { timeoutMs: 10000 } } }));
  assert.equal(started.ok, true, JSON.stringify(started));
  let state = started;
  const deadline = Date.now() + 15000;
  while (!['completed', 'failed', 'cancelled'].includes(state.status) && Date.now() < deadline) {
    state = await host.dispatchProviderCommand('script', { operation: 'wait', operationId: started.operationId, afterSequence: state.eventSequence, waitMs: 1000 });
  }
  assert.equal(state.status, 'completed', JSON.stringify(state));
  const result = await host.dispatchProviderCommand('script', { operation: 'result', operationId: started.operationId });
  assert.equal(result.result.state.status, 'completed', JSON.stringify(result));
  assert.equal(result.result.result.result.result.first.ok, true, JSON.stringify(result));
  const stdout = result.result.result.result.result.second.result.stdout;
  assert.deepEqual(JSON.parse(stdout), ['-s', 'nested-script-phone', 'shell', 'echo', 'second']);
});

test('Script drives a registered Intent command, and Intent starts and reads a child Script', async t => {
  const host = require('../bin/execution-host');
  const entry = require('../bin/intent/intent-entry');
  let observations = 0;
  const started = await entry.handle({ operation: 'start', operationId: 'intent-called-by-script', target,
    goal: 'Compose tasks', commands: host.dispatchProviderCommand, adapter: {
      observe: async ({ rawTreeId }) => { observations++; return { ok: true, rawTreeId, rawTree: { root: { text: 'Ready' } } }; },
    } });
  t.after(() => entry.handle({ operation: 'cancel', operationId: started.operationId }));
  const script = await host.dispatchProviderCommand('script', { operation: 'start', script: {
    schemaVersion: 'aab.code-script/v1', language: 'javascript', source: `module.exports.main = async ctx => {
      const result = await ctx.call('intent', { operation: 'decide', operationId: 'intent-called-by-script', decision: {
        decisionId: 'nested-child-start', basedOnRevision: 1, agentDecision: 'act', action: { action: 'command', command: 'script', arguments: {
          operation: 'start', script: { schemaVersion: 'aab.code-script/v1', language: 'javascript', source: 'module.exports.main = async ctx => ({ serial: ctx.target.serial, value: 42 });' }
        } }
      } });
      return result;
    };`, policy: { timeoutMs: 5000 } } });
  let state = script;
  while (!['completed', 'failed', 'cancelled'].includes(state.status)) state = await host.dispatchProviderCommand('script', {
    operation: 'wait', operationId: state.operationId, afterSequence: state.eventSequence, waitMs: 1000 });
  assert.equal(state.status, 'completed', JSON.stringify(state));
  const result = await host.dispatchProviderCommand('script', { operation: 'result', operationId: script.operationId });
  assert.equal(result.result.ok, true, JSON.stringify(result));
  const childId = result.result.result.lastAction.result.operationId;
  assert.ok(childId);
  let childState;
  do {
    childState = await host.dispatchProviderCommand('script', { operation: 'wait', operationId: childId,
      afterSequence: childState?.eventSequence ?? 0, waitMs: 1000 });
  } while (!['completed', 'failed', 'cancelled'].includes(childState.status));
  const throughIntent = await entry.handle({ operation: 'decide', operationId: started.operationId, decision: {
    decisionId: 'nested-child-result', basedOnRevision: 1, agentDecision: 'act', action: {
      action: 'command', command: 'script', arguments: { operation: 'result', operationId: childId } } } });
  assert.deepEqual(throughIntent.lastAction.result.result, { serial: target.serial, value: 42 });
  assert.equal(observations, 1);
});

test('an Intent can cancel itself without waiting on its own in-flight command', async () => {
  const host = require('../bin/execution-host');
  const entry = require('../bin/intent/intent-entry');
  const started = await entry.handle({ operation: 'start', operationId: 'self-cancelling-intent', target,
    goal: 'Self cancellation', commands: host.dispatchProviderCommand,
    adapter: { observe: async ({ rawTreeId }) => ({ ok: true, rawTreeId, rawTree: { root: { text: 'Ready' } } }) } });
  const result = await entry.handle({ operation: 'decide', operationId: started.operationId, decision: {
    decisionId: 'cancel-self', basedOnRevision: 1, agentDecision: 'act', action: { action: 'command', command: 'intent',
      arguments: { operation: 'cancel', operationId: started.operationId } } } });
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
});

test('background Intent admission returns its ID before a slow initial observation and remains cancellable', async () => {
  const entry = require('../bin/intent/intent-entry');
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const result = await entry.handle({ operation: 'start', operationId: 'background-intent', target, goal: 'Slow observation', background: true,
    adapter: { observe: async ({ rawTreeId }) => { await blocked; return { ok: true, rawTreeId, rawTree: { root: { text: 'Ready' } } }; } } });
  assert.equal(result.accepted, true);
  assert.equal(result.status, 'observing');
  const cancel = entry.handle({ operation: 'cancel', operationId: result.operationId });
  release();
  assert.equal((await cancel).status, 'cancelled');
});

test('Intent wait wakes on events without another observation, times out, and aborts only the caller', async t => {
  const entry = require('../bin/intent/intent-entry');
  let release, captures = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const state = await entry.handle({ operation: 'start', operationId: 'event-wait-intent', target, goal: 'Wait on changes', background: true,
    adapter: { observe: async ({ rawTreeId }) => { captures++; await blocked; return { ok: true, rawTreeId, rawTree: { root: { text: 'Ready' } } }; } } });
  t.after(() => entry.handle({ operation: 'cancel', operationId: state.operationId }));
  const waiting = entry.handle({ operation: 'wait', operationId: state.operationId, afterEventSequence: state.eventSequence, waitMs: 1000 });
  release();
  let changed = await waiting;
  while (changed.status === 'observing') changed = await entry.handle({ operation: 'wait', operationId: state.operationId,
    afterEventSequence: changed.eventSequence, waitMs: 1000 });
  assert.equal(changed.timedOut, false);
  assert.equal(changed.status, 'waiting_for_decision');
  assert.equal(captures, 1);
  assert.ok(changed.events.every(event => event.sequence > state.eventSequence));
  const timeout = await entry.handle({ operation: 'wait', operationId: state.operationId, afterEventSequence: changed.eventSequence, waitMs: 5 });
  assert.equal(timeout.timedOut, true);
  assert.deepEqual(timeout.events, []);
  const controller = new AbortController();
  const stoppedWait = runExecution({ signal: controller.signal }, () => entry.handle({ operation: 'wait',
    operationId: state.operationId, afterEventSequence: changed.eventSequence, waitMs: 1000 }));
  controller.abort({ code: 'cancelled' });
  await assert.rejects(stoppedWait, { code: 'cancelled' });
  assert.equal(entry.handle({ operation: 'status', operationId: state.operationId }).status, 'waiting_for_decision');
  assert.equal(captures, 1);
});
