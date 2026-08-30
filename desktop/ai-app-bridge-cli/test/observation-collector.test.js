'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const { ObservationCollector } = require('../bin/observation-collector');
const { targetFor } = require('../bin/target-execution');
const { FactCache } = require('../bin/fact-cache');
const { FactRecorder } = require('../bin/fact-recorder');

function createSqliteCache(t, budgetBytes = 2 * 1024 * 1024) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-app-bridge-observation-'));
  const cache = new FactCache({ directory, budgetBytes });
  t.after(() => {
    cache.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return cache;
}

test('does not register device-only iOS commands without an app or runtime target', () => {
  const collector = new ObservationCollector({
    rawRunner: async () => ({ ok: true }),
    recordEvidence: async () => {},
    recordDeviceLog: async () => {},
    spawn: () => null,
  });

  assert.deepEqual(collector.register('ios-devices', { deviceId: 'ios-1' }), {
    registered: false,
    ignored: true,
    reason: 'observable_target_required',
  });
  assert.equal(collector.status().targetCount, 0);
});

test('bounds persistent observers and stops polling the least recently used target', async () => {
  const timers = new ManualTimers();
  const calls = [];
  const collector = new ObservationCollector({
    rawRunner: async (command, args) => {
      calls.push({ command, packageName: args.packageName });
      return command === 'status'
        ? { ok: true, debugBridge: { runtimeEpoch: `runtime-${args.packageName}` } }
        : { ok: true, items: [] };
    },
    recordEvidence: async () => {},
    recordDeviceLog: async () => {},
    spawn: () => null,
    clock: timers.now,
    timers,
    pollIntervalMs: 100,
    maxTargets: 2,
    inactiveTargetTtlMs: 10_000,
  });

  collector.register('tap', { serial: 'android-1', packageName: 'com.example.first' });
  await timers.advanceBy(1);
  collector.register('tap', { serial: 'android-1', packageName: 'com.example.second' });
  collector.start();
  await timers.advanceBy(0);
  calls.length = 0;

  await timers.advanceBy(1);
  collector.register('tap', { serial: 'android-1', packageName: 'com.example.third' });
  await timers.advanceBy(0);
  assert.deepEqual(
    collector.status().targets.map((target) => target.packageName),
    ['com.example.second', 'com.example.third'],
  );
  assert.equal(collector.status().targetEvictions, 1);

  await timers.advanceBy(100);
  assert.equal(calls.some((call) => call.packageName === 'com.example.first'), false);
  await collector.stop();
});

test('expires observers that have not been explicitly used during the target TTL', async () => {
  const timers = new ManualTimers();
  const collector = new ObservationCollector({
    rawRunner: async (command) => (
      command === 'status'
        ? { ok: true, debugBridge: { runtimeEpoch: 'runtime-expiring' } }
        : { ok: true, items: [] }
    ),
    recordEvidence: async () => {},
    recordDeviceLog: async () => {},
    spawn: () => null,
    clock: timers.now,
    timers,
    pollIntervalMs: 100,
    maxTargets: 4,
    inactiveTargetTtlMs: 250,
  });

  collector.register('tap', { serial: 'android-1', packageName: 'com.example.expiring' });
  collector.start();
  await timers.advanceBy(0);
  await timers.advanceBy(100);
  await timers.advanceBy(100);
  await timers.advanceBy(100);

  assert.equal(collector.status().targetCount, 0);
  assert.equal(collector.status().targetExpirations, 1);
  assert.equal(timers.tasks.size, 0);
  await collector.stop();
});

class ManualTimers {
  constructor(startMs = 1_000) {
    this.nowMs = startMs;
    this.nextId = 1;
    this.tasks = new Map();
  }

  now = () => this.nowMs;

  setTimeout = (callback, delayMs = 0) => {
    const id = this.nextId++;
    this.tasks.set(id, {
      callback,
      dueAtMs: this.nowMs + Math.max(0, Number(delayMs) || 0),
    });
    return id;
  };

  clearTimeout = (id) => {
    this.tasks.delete(id);
  };

  async advanceBy(delayMs) {
    const destinationMs = this.nowMs + delayMs;
    while (true) {
      let selectedId = null;
      let selectedTask = null;
      for (const [id, task] of this.tasks) {
        if (task.dueAtMs > destinationMs) continue;
        if (!selectedTask || task.dueAtMs < selectedTask.dueAtMs || (task.dueAtMs === selectedTask.dueAtMs && id < selectedId)) {
          selectedId = id;
          selectedTask = task;
        }
      }
      if (!selectedTask) break;
      this.nowMs = selectedTask.dueAtMs;
      this.tasks.delete(selectedId);
      selectedTask.callback();
      await settleAsyncWork();
    }
    this.nowMs = destinationMs;
    await settleAsyncWork();
  }
}

async function settleAsyncWork() {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

function fakeChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit('exit', 0, 'SIGTERM');
    return true;
  };
  return child;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('registers one background observer per Android target and pulls each evidence stream incrementally', async () => {
  const timers = new ManualTimers();
  const calls = [];
  const recorded = [];
  let cycle = 0;
  const collector = new ObservationCollector({
    rawRunner: async (command, args) => {
      calls.push({ command, args: { ...args } });
      if (command === 'status') {
        return { ok: true, debugBridge: { runtimeEpoch: 'android-run-1' } };
      }
      cycle += 1;
      return {
        ok: true,
        items: [{ id: cycle * 10, type: command }],
      };
    },
    recordEvidence: async (command, args, result, context) => {
      recorded.push({ command, args, result, context });
    },
    recordDeviceLog: async () => {},
    spawn: () => null,
    clock: timers.now,
    timers,
    pollIntervalMs: 100,
    statusIntervalMs: 1_000,
  });

  const first = collector.register('tap', {
    serial: 'android-1',
    packageName: 'com.example.app',
  });
  const duplicate = collector.register('events', {
    serial: 'android-1',
    packageName: 'com.example.app',
  });
  assert.equal(first.registered, true);
  assert.equal(duplicate.registered, false);
  assert.equal(collector.status().targetCount, 1);

  collector.start();
  await timers.advanceBy(0);
  assert.deepEqual(calls.map((call) => call.command), [
    'status',
    'logs',
    'network',
    'state',
    'events',
  ]);
  assert.equal(recorded.length, 5);
  assert.equal(recorded[1].context.runtimeEpoch, 'android-run-1');
  assert.equal(recorded[1].context.target.serial, 'android-1');

  calls.length = 0;
  await timers.advanceBy(100);
  assert.deepEqual(calls.map((call) => call.command), [
    'logs',
    'network',
    'state',
    'events',
  ]);
  assert.deepEqual(calls.map((call) => call.args.sinceId), [10, 20, 30, 40]);

  await collector.stop();
});

test('collects Android app streams by default without attributing device-wide logcat to the app', async () => {
  const timers = new ManualTimers();
  const calls = [];
  let spawnCount = 0;
  const collector = new ObservationCollector({
    rawRunner: async (command) => {
      calls.push(command);
      return command === 'status'
        ? { ok: true, debugBridge: { runtimeEpoch: 'app-streams-only' } }
        : { ok: true, items: [] };
    },
    recordEvidence: async () => {},
    recordDeviceLog: async () => {},
    spawn: () => {
      spawnCount += 1;
      return fakeChildProcess();
    },
    clock: timers.now,
    timers,
  });

  collector.register('tap', {
    serial: 'android-app-only',
    packageName: 'com.example.app.only',
  });
  collector.start();
  await timers.advanceBy(0);

  assert.equal(spawnCount, 0);
  assert.deepEqual(calls, ['status', 'logs', 'network', 'state', 'events']);
  assert.deepEqual(collector.status().targets[0].deviceLog, {
    enabled: false,
    reason: 'device_scope_opt_in_required',
  });

  await collector.stop();
});

test('reuses one default Android logcat stream per device and writes records in timed batches', async () => {
  const timers = new ManualTimers();
  const child = fakeChildProcess();
  const spawnCalls = [];
  const batches = [];
  const collector = new ObservationCollector({
    rawRunner: async (command) => (
      command === 'status'
        ? { ok: true, debugBridge: { runtimeEpoch: 'run-1' } }
        : { ok: true, items: [] }
    ),
    recordEvidence: async () => {},
    recordDeviceLog: async (args, batch, context) => {
      batches.push({ args, batch, context });
    },
    spawn: (file, args, options) => {
      spawnCalls.push({ file, args, options });
      return child;
    },
    clock: timers.now,
    timers,
    deviceLogFlushMs: 250,
  });

  collector.register('tap', {
    serial: 'android-1',
    packageName: 'com.example.first',
    deviceLogScope: 'device',
  });
  collector.register('tap', {
    serial: 'android-1',
    packageName: 'com.example.second',
    deviceLogScope: 'device',
  });
  collector.start();

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].file, 'adb');
  assert.deepEqual(spawnCalls[0].args, [
    '-s', 'android-1',
    'logcat', '-v', 'epoch',
    '-T', '1',
    '-b', 'main',
    '-b', 'system',
    '-b', 'crash',
  ]);
  child.stdout.emit('data', '1700000000.000 one\n1700000000.100 two\n');
  await timers.advanceBy(249);
  assert.equal(batches.length, 0);
  await timers.advanceBy(1);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].batch.lines, [
    '1700000000.000 one',
    '1700000000.100 two',
  ]);
  assert.equal(batches[0].args.serial, 'android-1');
  assert.deepEqual(batches[0].args.buffers, ['main', 'system', 'crash']);
  assert.equal(batches[0].context.lineCount, 2);
  assert.deepEqual(batches[0].context.targetKeys.length, 2);

  await collector.stop();
  assert.equal(child.killed, true);
  assert.equal(timers.tasks.size, 0);
});

test('persists explicitly opted-in logcat as device evidence without app package ownership', async (t) => {
  const timers = new ManualTimers();
  const child = fakeChildProcess();
  const recordedArgs = [];
  const cache = createSqliteCache(t);
  const recorder = new FactRecorder({ cache, now: timers.now });
  const collector = new ObservationCollector({
    rawRunner: async (command) => (
      command === 'status'
        ? { ok: true, debugBridge: { runtimeEpoch: 'device-scope-runtime' } }
        : { ok: true, items: [] }
    ),
    recordEvidence: recorder.recordEvidence.bind(recorder),
    recordDeviceLog: async (args, batch, context) => {
      recordedArgs.push(args);
      return recorder.recordDeviceLog(args, batch, context);
    },
    spawn: () => child,
    clock: timers.now,
    timers,
  });

  collector.register('tap', {
    serial: 'android-device-scope',
    packageName: 'com.example.observed.app',
    deviceLogScope: 'device',
  });
  collector.start();
  child.stdout.emit('data', '1700000000.000 device evidence\n');
  await timers.advanceBy(250);

  assert.deepEqual(recordedArgs[0], {
    serial: 'android-device-scope',
    deviceLogScope: 'device',
    buffers: ['main', 'system', 'crash'],
  });
  const fact = cache.query({ partition: 'device-log' }).items[0];
  assert.equal(fact.targetKey, 'android-device:["android-device-scope",""]');
  assert.deepEqual(fact.app, {
    kind: 'android-device',
    serial: 'android-device-scope',
  });

  await collector.stop();
  cache.close();
});

test('resets every Web evidence cursor when the connected generation changes', async () => {
  const timers = new ManualTimers();
  const calls = [];
  let connectedAtMs = 10_000;
  let itemId = 100;
  const collector = new ObservationCollector({
    rawRunner: async (command, args) => {
      calls.push({ command, args: { ...args } });
      if (command === 'web-status') {
        return { ok: true, session: { connectedAtMs } };
      }
      return { ok: true, items: [{ id: itemId }] };
    },
    recordEvidence: async () => {},
    recordDeviceLog: async () => {},
    spawn: () => null,
    clock: timers.now,
    timers,
    pollIntervalMs: 100,
    statusIntervalMs: 100,
  });

  collector.register('web-click', { sessionId: 'web-session-1', targetId: 'main' });
  collector.start();
  await timers.advanceBy(0);
  calls.length = 0;

  connectedAtMs = 20_000;
  itemId = 200;
  await timers.advanceBy(100);
  assert.deepEqual(calls.map((call) => call.command), [
    'web-status',
    'web-logs',
    'web-network',
    'web-state',
    'web-events',
  ]);
  assert.deepEqual(calls.slice(1).map((call) => Object.hasOwn(call.args, 'sinceId')), [
    false,
    false,
    false,
    false,
  ]);
  const target = collector.status().targets[0];
  assert.equal(target.runtimeEpoch, '20000');
  assert.equal(target.generationChanges, 1);
  assert.deepEqual(target.cursors, {
    logs: 200,
    network: 200,
    state: 200,
    events: 200,
  });

  await collector.stop();
});

test('backs off failed target polls exponentially and returns to the normal interval after recovery', async () => {
  const timers = new ManualTimers();
  let statusAttempts = 0;
  const collector = new ObservationCollector({
    rawRunner: async (command) => {
      if (command === 'ios-status') {
        statusAttempts += 1;
        if (statusAttempts <= 2) throw new Error(`runtime unavailable ${statusAttempts}`);
        return { ok: true, debugBridge: { runtimeEpoch: 'ios-run-1' } };
      }
      return { ok: true, items: [] };
    },
    recordEvidence: async () => {},
    recordDeviceLog: async () => {},
    spawn: () => null,
    clock: timers.now,
    timers,
    pollIntervalMs: 100,
    statusIntervalMs: 500,
    initialBackoffMs: 50,
    maxBackoffMs: 200,
  });

  const registration = collector.register('ios-tap', {
    deviceId: 'ios-device-1',
    bundleId: 'com.example.ios',
  });
  collector.start();
  await timers.advanceBy(0);
  assert.equal(statusAttempts, 1);
  assert.equal(collector.status().targets[0].failureCount, 1);
  assert.match(collector.status().targets[0].lastError, /runtime unavailable 1/);
  assert.equal(collector.noteAction(registration.target, 'action-during-backoff'), true);

  await timers.advanceBy(49);
  assert.equal(statusAttempts, 1);
  await timers.advanceBy(1);
  assert.equal(statusAttempts, 2);
  assert.equal(collector.status().targets[0].failureCount, 2);

  await timers.advanceBy(99);
  assert.equal(statusAttempts, 2);
  await timers.advanceBy(1);
  assert.equal(statusAttempts, 3);
  const recovered = collector.status().targets[0];
  assert.equal(recovered.failureCount, 0);
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.lastActionId, 'action-during-backoff');
  assert.equal(recovered.nextPollAtMs, timers.nowMs + 100);

  await collector.stop();
});

test('never guesses an Android serial for device logs and exposes why collection is disabled', async () => {
  const timers = new ManualTimers();
  let spawnCount = 0;
  const collector = new ObservationCollector({
    rawRunner: async (command) => (
      command === 'status'
        ? { ok: true, debugBridge: { runtimeEpoch: 'run-without-serial' } }
        : { ok: true, items: [] }
    ),
    recordEvidence: async () => {},
    recordDeviceLog: async () => {},
    spawn: () => {
      spawnCount += 1;
      return fakeChildProcess();
    },
    clock: timers.now,
    timers,
  });

  collector.register('status', {
    packageName: 'com.example.no.serial',
    deviceLogScope: 'device',
  });
  collector.start();
  assert.equal(spawnCount, 0);
  assert.deepEqual(collector.status().targets[0].deviceLog, {
    enabled: false,
    reason: 'serial_required',
  });

  await collector.stop();
});

test('adds sensitive logcat buffers only when explicitly requested', async () => {
  const timers = new ManualTimers();
  const child = fakeChildProcess();
  const spawnCalls = [];
  const collector = new ObservationCollector({
    rawRunner: async (command) => (
      command === 'status'
        ? { ok: true, debugBridge: { runtimeEpoch: 'run-sensitive-opt-in' } }
        : { ok: true, items: [] }
    ),
    recordEvidence: async () => {},
    recordDeviceLog: async () => {},
    spawn: (file, args) => {
      spawnCalls.push({ file, args });
      return child;
    },
    clock: timers.now,
    timers,
  });

  collector.register('tap', {
    serial: 'android-sensitive',
    packageName: 'com.example.sensitive',
    adb: '/opt/custom-adb',
    deviceLogScope: 'device',
    deviceLogBuffers: ['radio', 'not-a-real-buffer'],
  });
  collector.start();
  assert.equal(spawnCalls[0].file, '/opt/custom-adb');
  assert.deepEqual(spawnCalls[0].args, [
    '-s', 'android-sensitive',
    'logcat', '-v', 'epoch',
    '-T', '1',
    '-b', 'main',
    '-b', 'system',
    '-b', 'crash',
    '-b', 'radio',
  ]);
  assert.equal(spawnCalls[0].args.includes('security'), false);
  assert.equal(spawnCalls[0].args.includes('kernel'), false);

  await collector.stop();
});

test('bounds slow device-log writes and reports dropped batches instead of growing without limit', async () => {
  const timers = new ManualTimers();
  const child = fakeChildProcess();
  let releaseFirstWrite;
  const firstWrite = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  const recorded = [];
  const collector = new ObservationCollector({
    rawRunner: async (command) => (
      command === 'status'
        ? { ok: true, debugBridge: { runtimeEpoch: 'run-bounded' } }
        : { ok: true, items: [] }
    ),
    recordEvidence: async () => {},
    recordDeviceLog: async (_args, batch) => {
      recorded.push(batch.lines);
      if (recorded.length === 1) await firstWrite;
    },
    spawn: () => child,
    clock: timers.now,
    timers,
    deviceLogBatchLines: 1,
    maxDeviceLogPendingBatches: 1,
  });

  collector.register('tap', {
    serial: 'android-bounded',
    packageName: 'com.example.bounded',
    deviceLogScope: 'device',
  });
  collector.start();
  child.stdout.emit('data', 'one\n');
  child.stdout.emit('data', 'two\n');
  child.stdout.emit('data', 'three\n');
  assert.equal(recorded.length, 1);
  assert.equal(collector.status().dropped.deviceLogBatches, 1);
  assert.equal(collector.status().dropped.deviceLogLines, 1);

  releaseFirstWrite();
  await settleAsyncWork();
  assert.deepEqual(recorded, [['one'], ['two']]);
  await collector.stop();
});

test('stop drains final complete and partial logcat lines and leaves no timer or child behind', async () => {
  const timers = new ManualTimers();
  const child = fakeChildProcess();
  const batches = [];
  const collector = new ObservationCollector({
    rawRunner: async (command) => (
      command === 'status'
        ? { ok: true, debugBridge: { runtimeEpoch: 'run-stop-drain' } }
        : { ok: true, items: [] }
    ),
    recordEvidence: async () => {},
    recordDeviceLog: async (_args, batch) => {
      batches.push(batch.lines);
    },
    spawn: () => child,
    clock: timers.now,
    timers,
    deviceLogBatchLines: 2,
  });

  collector.register('tap', {
    serial: 'android-stop',
    packageName: 'com.example.stop',
    deviceLogScope: 'device',
  });
  collector.start();
  child.stdout.emit('data', 'one\ntwo\nthree\nfour\nfive');
  await collector.stop();

  assert.deepEqual(batches.flat(), ['one', 'two', 'three', 'four', 'five']);
  assert.equal(child.killed, true);
  assert.equal(timers.tasks.size, 0);
  assert.equal(collector.status().deviceLogs[0].queuedLines, 0);
  child.stdout.emit('data', 'late-after-stop\n');
  assert.equal(timers.tasks.size, 0);
  assert.equal(collector.status().deviceLogs[0].queuedLines, 0);
});

test('waits for every in-flight evidence pull before backing off so failed cycles cannot overlap', async () => {
  const timers = new ManualTimers();
  const slowLogs = deferred();
  let logPulls = 0;
  const collector = new ObservationCollector({
    rawRunner: async (command) => {
      if (command === 'status') return { ok: true, debugBridge: { runtimeEpoch: 'run-no-overlap' } };
      if (command === 'logs') {
        logPulls += 1;
        return slowLogs.promise;
      }
      if (command === 'network') throw new Error('network failed');
      return { ok: true, items: [] };
    },
    recordEvidence: async () => {},
    recordDeviceLog: async () => {},
    spawn: () => null,
    clock: timers.now,
    timers,
    pollIntervalMs: 100,
    statusIntervalMs: 1_000,
    initialBackoffMs: 50,
  });

  collector.register('status', { serial: 'android-overlap', packageName: 'com.example.overlap' });
  collector.start();
  await timers.advanceBy(0);
  assert.equal(logPulls, 1);
  await timers.advanceBy(500);
  assert.equal(logPulls, 1);
  assert.equal(collector.status().targets[0].nextPollAtMs, null);

  slowLogs.resolve({ ok: true, items: [] });
  await settleAsyncWork();
  assert.equal(collector.status().targets[0].failureCount, 1);
  assert.equal(collector.status().targets[0].nextPollAtMs, timers.nowMs + 50);
  await collector.stop();
});

test('keeps connection hints across duplicate registration and accepts TargetExecution target identity', async () => {
  const timers = new ManualTimers();
  const calls = [];
  const collector = new ObservationCollector({
    rawRunner: async (command, args) => {
      calls.push({ command, args });
      if (command === 'ios-status') {
        return { ok: true, debugBridge: { runtimeEpoch: 'ios-hinted' } };
      }
      if (command === 'web-status') {
        return { ok: true, session: { connectedAtMs: 123 } };
      }
      return { ok: true, items: [] };
    },
    recordEvidence: async () => {},
    recordDeviceLog: async () => {},
    spawn: () => null,
    clock: timers.now,
    timers,
  });

  collector.register('ios-status', {
    deviceId: 'ios-hints',
    bundleId: 'com.example.hints',
    runtimeUrl: 'http://127.0.0.1:19000',
  });
  collector.register('ios-tap', {
    deviceId: 'ios-hints',
    bundleId: 'com.example.hints',
  });
  collector.register('web-click', { sessionId: 'web-with-default-target' });
  assert.equal(collector.noteAction(
    targetFor('web-click', { sessionId: 'web-with-default-target' }),
    'web-action-1',
  ), true);

  collector.start();
  await timers.advanceBy(0);
  const iosStatus = calls.find((call) => call.command === 'ios-status');
  assert.equal(iosStatus.args.runtimeUrl, 'http://127.0.0.1:19000');
  const webTarget = collector.status().targets.find((target) => target.kind === 'web');
  assert.equal(webTarget.targetId, '');
  assert.equal(webTarget.lastActionId, 'web-action-1');

  await collector.stop();
});

test('keeps a bounded TTL action timeline and incrementally completes the same action id', async () => {
  const timers = new ManualTimers(1_000);
  const collector = new ObservationCollector({
    rawRunner: async () => ({ ok: true, items: [] }),
    recordEvidence: async () => {},
    recordDeviceLog: async () => {},
    spawn: () => null,
    clock: timers.now,
    timers,
    actionTimelineLimit: 2,
    actionTimelineTtlMs: 50,
  });
  const registration = collector.register('tap', {
    serial: 'timeline-device',
    packageName: 'com.example.timeline',
  });

  collector.noteAction(registration.target, 'action-first', {
    requestedAtMs: 990,
    startedAtMs: 995,
  });
  collector.noteAction(registration.target, 'action-first', { completedAtMs: 1_002 });
  await timers.advanceBy(10);
  collector.noteAction(registration.target, 'action-second', {
    requestedAtMs: 1_005,
    startedAtMs: 1_008,
    completedAtMs: 1_010,
  });
  await timers.advanceBy(10);
  collector.noteAction(registration.target, 'action-third', {
    requestedAtMs: 1_015,
    startedAtMs: 1_018,
  });

  let timeline = collector.status().targets[0].actionTimeline;
  assert.deepEqual(timeline.map((action) => action.actionId), ['action-second', 'action-third']);
  assert.deepEqual(timeline[1], {
    actionId: 'action-third',
    requestedAtMs: 1_015,
    startedAtMs: 1_018,
    completedAtMs: null,
  });

  await timers.advanceBy(60);
  collector.noteAction(registration.target, 'action-third', { completedAtMs: 1_080 });
  timeline = collector.status().targets[0].actionTimeline;
  assert.deepEqual(timeline, [{
    actionId: 'action-third',
    requestedAtMs: 1_015,
    startedAtMs: 1_018,
    completedAtMs: 1_080,
  }]);

  await timers.advanceBy(51);
  const expired = collector.status().targets[0];
  assert.deepEqual(expired.actionTimeline, []);
  assert.equal(expired.lastActionId, null);
});

test('restarts an exited logcat stream with bounded backoff and cancels restart during stop', async () => {
  const timers = new ManualTimers();
  const children = [fakeChildProcess(), fakeChildProcess(), fakeChildProcess()];
  let spawnCount = 0;
  const collector = new ObservationCollector({
    rawRunner: async (command) => (
      command === 'status'
        ? { ok: true, debugBridge: { runtimeEpoch: 'run-restart-logcat' } }
        : { ok: true, items: [] }
    ),
    recordEvidence: async () => {},
    recordDeviceLog: async () => {},
    spawn: () => children[spawnCount++],
    clock: timers.now,
    timers,
    deviceLogRestartMs: 50,
    maxDeviceLogRestartMs: 200,
  });

  collector.register('tap', {
    serial: 'android-restart',
    packageName: 'com.example.restart',
    deviceLogScope: 'device',
  });
  collector.start();
  assert.equal(spawnCount, 1);
  children[0].emit('exit', 1, null);
  await timers.advanceBy(49);
  assert.equal(spawnCount, 1);
  await timers.advanceBy(1);
  assert.equal(spawnCount, 2);

  children[1].emit('exit', 1, null);
  await collector.stop();
  await timers.advanceBy(500);
  assert.equal(spawnCount, 2);
  assert.equal(timers.tasks.size, 0);
});

test('restarts a shared device stream when a later registration explicitly expands its buffers', async () => {
  const timers = new ManualTimers();
  const children = [fakeChildProcess(), fakeChildProcess()];
  const spawnCalls = [];
  const collector = new ObservationCollector({
    rawRunner: async (command) => (
      command === 'status'
        ? { ok: true, debugBridge: { runtimeEpoch: 'run-buffer-expand' } }
        : { ok: true, items: [] }
    ),
    recordEvidence: async () => {},
    recordDeviceLog: async () => {},
    spawn: (_file, args) => {
      spawnCalls.push(args);
      return children[spawnCalls.length - 1];
    },
    clock: timers.now,
    timers,
  });

  collector.register('tap', {
    serial: 'android-expand',
    packageName: 'com.example.first',
    deviceLogScope: 'device',
  });
  collector.start();
  collector.register('tap', {
    serial: 'android-expand',
    packageName: 'com.example.second',
    deviceLogScope: 'device',
    deviceLogBuffers: ['kernel'],
  });

  assert.equal(children[0].killed, true);
  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(spawnCalls[1].slice(-2), ['-b', 'kernel']);
  await collector.stop();
});

test('passes a complete batch object directly to FactRecorder without an integration adapter', async (t) => {
  const timers = new ManualTimers();
  const child = fakeChildProcess();
  const cache = createSqliteCache(t);
  const recorder = new FactRecorder({ cache, now: timers.now });
  const collector = new ObservationCollector({
    rawRunner: async (command) => (
      command === 'status'
        ? { ok: true, debugBridge: { runtimeEpoch: 'run-recorder' } }
        : { ok: true, items: [] }
    ),
    recordEvidence: recorder.recordEvidence.bind(recorder),
    recordDeviceLog: recorder.recordDeviceLog.bind(recorder),
    spawn: () => child,
    clock: timers.now,
    timers,
  });

  collector.register('tap', {
    serial: 'android-recorder',
    packageName: 'com.example.recorder',
    deviceLogScope: 'device',
  });
  collector.start();
  child.stdout.emit('data', '1700000000.000 persisted line\n');
  await timers.advanceBy(250);

  const facts = cache.query({ partition: 'device-log' }).items;
  assert.equal(facts.length, 1);
  assert.deepEqual(facts[0].payload.record.lines, ['1700000000.000 persisted line']);
  assert.deepEqual(facts[0].payload.record.buffers, ['main', 'system', 'crash']);
  await collector.stop();
  cache.close();
});

test('attributes device-log batches by observedAtMs across two rapid actions', async (t) => {
  const timers = new ManualTimers(1_015);
  const child = fakeChildProcess();
  const cache = createSqliteCache(t);
  const recorder = new FactRecorder({ cache, now: timers.now, actionCompletionGraceMs: 25 });
  const collector = new ObservationCollector({
    rawRunner: async (command) => (
      command === 'status'
        ? { ok: true, debugBridge: { runtimeEpoch: 'run-device-log-actions' } }
        : { ok: true, items: [] }
    ),
    recordEvidence: recorder.recordEvidence.bind(recorder),
    recordDeviceLog: recorder.recordDeviceLog.bind(recorder),
    spawn: () => child,
    clock: timers.now,
    timers,
    deviceLogFlushMs: 1,
  });
  const registration = collector.register('tap', {
    serial: 'android-log-actions',
    packageName: 'com.example.logactions',
    deviceLogScope: 'device',
  });
  collector.noteAction(registration.target, 'action-first', {
    requestedAtMs: 1_000,
    startedAtMs: 1_005,
    completedAtMs: 1_020,
  });
  collector.noteAction(registration.target, 'action-second', {
    requestedAtMs: 1_025,
    startedAtMs: 1_030,
    completedAtMs: 1_040,
  });

  collector.start();
  child.stdout.emit('data', 'first action evidence\n');
  await timers.advanceBy(1);
  await timers.advanceBy(19);
  child.stdout.emit('data', 'second action evidence\n');
  await timers.advanceBy(1);

  const facts = cache.query({ partition: 'device-log' }).items;
  assert.equal(facts.find((fact) => fact.payload.record.lines[0] === 'first action evidence').actionId, 'action-first');
  assert.equal(facts.find((fact) => fact.payload.record.lines[0] === 'second action evidence').actionId, 'action-second');
  await collector.stop();
  cache.close();
});

test('bounds an unterminated logcat line and reports the discarded bytes', async () => {
  const timers = new ManualTimers();
  const child = fakeChildProcess();
  const collector = new ObservationCollector({
    rawRunner: async (command) => (
      command === 'status'
        ? { ok: true, debugBridge: { runtimeEpoch: 'run-partial-bound' } }
        : { ok: true, items: [] }
    ),
    recordEvidence: async () => {},
    recordDeviceLog: async () => {},
    spawn: () => child,
    clock: timers.now,
    timers,
    deviceLogBatchBytes: 16,
  });

  collector.register('tap', {
    serial: 'android-partial',
    packageName: 'com.example.partial',
    deviceLogScope: 'device',
  });
  collector.start();
  child.stdout.emit('data', 'x'.repeat(100));
  const logStatus = collector.status().deviceLogs[0];
  assert.equal(logStatus.partialBytes <= 16, true);
  assert.equal(logStatus.droppedBytes, 84);
  await collector.stop();
});
