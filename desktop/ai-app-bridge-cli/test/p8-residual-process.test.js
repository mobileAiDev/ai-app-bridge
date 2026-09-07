'use strict';

const { createFakeHostPort } = require('../bin/script/fake-host-port');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createTestScriptSupervisor: createScriptSupervisor } = require('./helpers/script-supervisor');
const { childExitPromise } = require('../bin/script/node-runtime-adapter');

function processRow(pid) {
  const stdout = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
  return stdout.split('\n').map((line) => line.trim()).find((line) => Number(line.split(/\s+/)[0]) === pid);
}

function assertOwnedChildAlive(pid) {
  assert.equal(Number.isInteger(pid), true, 'the real child must report its pid');
  const row = processRow(pid);
  assert.ok(row, `child ${pid} must be running before its terminal transition`);
  assert.equal(Number(row.split(/\s+/)[1]), process.pid, row);
  assert.match(row, /script-sdk\.js/);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitDone(supervisor, operationId, waitMs = 5000) {
  const deadline = Date.now() + waitMs;
  let afterSequence = 0;
  while (Date.now() < deadline) {
    const snapshot = await supervisor.handle({
      operation: 'wait',
      operationId,
      waitMs: Math.max(1, Math.min(200, deadline - Date.now())),
      afterSequence,
    });
    if (snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled') {
      return snapshot;
    }
    afterSequence = snapshot.eventSequence;
  }
  return supervisor.handle({ operation: 'status', operationId, afterSequence: 0 });
}

test('P8 child error without pid does not count as exit when the process is alive', async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  const pending = childExitPromise(child);
  let resolved = false;
  pending.then(() => { resolved = true; });
  child.emit('error', new Error('kill ESRCH'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  child.emit('exit', 1);
  const ended = await pending;
  assert.equal(ended.type, 'exit');
  assert.equal(ended.code, 1);
});

test('P8 spawn error without pid settles the exit promise', async () => {
  const child = new EventEmitter();
  const ended = childExitPromise(child);
  child.emit('error', new Error('spawn ENOENT'));
  const value = await ended;
  assert.equal(value.type, 'exit');
  assert.equal(value.error, 'spawn ENOENT');
});

test('P8 JS complete leaves zero residual script-sdk children', { timeout: 10_000 }, async (t) => {
  const launched = deferred();
  const gate = deferred();
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const started = await supervisor.handle({
    operation: 'start',
    handlers: {
      status: async (args) => {
        launched.resolve(args.childPid);
        await gate.promise;
        return { ok: true };
      },
    },
    script: {
      schemaVersion: 'aab.code-script/v1',
      name: 'p8-residual',
      language: 'javascript',
      source: 'async function main(ctx) { await ctx.call("status", { childPid: process.pid }); return { ok: true }; }\nmodule.exports = { main };',
      target: { serial: 'p8', packageName: 'com.example.app' },
    },
  });
  t.after(async () => {
    gate.resolve();
    await supervisor.handle({ operation: 'cancel', operationId: started.operationId });
  });
  const childPid = await launched.promise;
  assertOwnedChildAlive(childPid);
  gate.resolve();
  const done = await waitDone(supervisor, started.operationId);
  assert.equal(done.status, 'completed');
  assert.equal(processRow(childPid), undefined, `completed child ${childPid} must have exited`);
});

test('P8 cancel does not publish cancelled until the child has exited', async () => {
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  let releaseStop;
  const started = await supervisor.handle({
    operation: 'start',
    runtime: {
      kind: 'javascript',
      start: () => new Promise(() => {}),
      stop: () => new Promise((resolve) => {
        releaseStop = resolve;
      }),
    },
    script: {
      schemaVersion: 'aab.code-script/v1',
      name: 'p8-cancel-window',
      language: 'javascript',
      source: 'async function main() { await new Promise(() => {}); }\nmodule.exports = { main };',
      target: { serial: 'p8', packageName: 'com.example.app' },
    },
  });
  const cancelPromise = supervisor.handle({
    operation: 'cancel',
    operationId: started.operationId,
  });
  const during = await supervisor.handle({
    operation: 'status',
    operationId: started.operationId,
  });
  assert.equal(during.status === 'cancelled', false);
  releaseStop();
  const cancelled = await cancelPromise;
  assert.equal(cancelled.status, 'cancelled');
});

test('P8 cancelled hanging JS leaves zero residual script-sdk children', { timeout: 10_000 }, async (t) => {
  const launched = deferred();
  const supervisor = createScriptSupervisor({ createHost: createFakeHostPort });
  const hanging = await supervisor.handle({
    operation: 'start',
    handlers: { status: async (args) => { launched.resolve(args.childPid); return { ok: true }; } },
    script: {
      schemaVersion: 'aab.code-script/v1',
      name: 'p8-residual-cancel',
      language: 'javascript',
      source: 'async function main(ctx) { await ctx.call("status", { childPid: process.pid }); await new Promise(() => {}); }\nmodule.exports = { main };',
      target: { serial: 'p8', packageName: 'com.example.app' },
    },
  });
  t.after(() => supervisor.handle({ operation: 'cancel', operationId: hanging.operationId }));
  const childPid = await launched.promise;
  assertOwnedChildAlive(childPid);
  const cancelPromise = supervisor.handle({
    operation: 'cancel',
    operationId: hanging.operationId,
  });
  const mid = await supervisor.handle({
    operation: 'status',
    operationId: hanging.operationId,
  });
  if (mid.status === 'cancelled') {
    assert.equal(processRow(childPid), undefined, `cancelled child ${childPid} must have exited`);
  } else {
    assert.equal(mid.status === 'cancelled', false);
  }
  const cancelled = await cancelPromise;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(processRow(childPid), undefined, `cancelled child ${childPid} must have exited`);
});
