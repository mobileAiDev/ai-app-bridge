const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { runBridgeChecked } = require('../test-support/host-client');
const { TargetExecution } = require('../bin/target-execution');
const { FactCache } = require('../test-support/fact-cache');
const { FactRecorder } = require('../bin/fact-recorder');
const { ObservationCollector } = require('../bin/observation-collector');

function payloadOf(result) {
  return JSON.parse(result.content[0].text);
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('MCP can launch an inactive Android app without an unsolicited SDK connection blocking its transport', async t => {
  const calls = [];
  let transportBlocked = false;
  const rawRunner = async command => {
    calls.push(command);
    if (command === 'status') {
      // Mirrors the physical failure: an inactive SDK connection blocks ADB
      // while the ordinary launch is preparing its original shell command.
      transportBlocked = true;
      return { ok: false, error: 'provider_timeout' };
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    return transportBlocked ? { ok: false, error: 'deadline_exceeded', dispatched: false }
      : { ok: true, component: 'example.app/.MainActivity', dispatched: true };
  };
  const collector = new ObservationCollector({ rawRunner, recordEvidence: async () => {}, recordDeviceLog: async () => {} });
  collector.start(); t.after(() => collector.stop());
  const result = payloadOf(await runBridgeChecked('launch-activity', {
    serial: 'inactive-sdk-phone', packageName: 'example.app', activity: '.MainActivity', feedback: 'off',
  }, { factRecorder: null, observationCollector: collector, targetExecution: new TargetExecution(), rawRunner }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls, ['launch-activity']);
});

function createSqliteCache(t, budgetBytes = 1024 * 1024) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-app-bridge-mcp-execution-'));
  const cache = new FactCache({ directory, budgetBytes });
  t.after(() => {
    cache.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return cache;
}

test('MCP execution uses the in-process target actor and preserves canonical coordinates', async () => {
  const targetExecution = new TargetExecution();
  const calls = [];
  const dependencies = {
    targetExecution,
    rawRunner: async (command, args) => {
      calls.push({ command, args });
      return { ok: true, action: command, x: args.tapX, y: args.tapY };
    },
  };
  const args = {
    serial: 'android-1',
    packageName: 'com.example.app',
    requestId: 'mcp-tap-1',
    tapX: 0,
    tapY: 0,
  };

  const first = payloadOf(await runBridgeChecked('tap', args, dependencies));
  const duplicate = payloadOf(await runBridgeChecked('tap', args, dependencies));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.tapX, 0);
  assert.equal(calls[0].args.tapY, 0);
  assert.equal(first._feedback.status, 'completed');
  assert.equal(first._feedback.target.serial, 'android-1');
  assert.deepEqual(first._feedback.outcome, {
    ok: true,
    action: 'tap',
    x: 0,
    y: 0,
  });
  assert.deepEqual(duplicate, first);
});

test('MCP legacy execution serializes same-serial different-package mutations', async () => {
  const gate = deferred();
  const starts = [];
  const dependencies = {
    targetExecution: new TargetExecution(),
    rawRunner: async (_command, args) => {
      starts.push(args.packageName);
      await gate.promise;
      return { ok: true, packageName: args.packageName };
    },
  };

  const first = runBridgeChecked('tap', { tapX: 1, tapY: 2,
    serial: 'android-1',
    packageName: 'com.example.first',
    feedback: 'off',
  }, dependencies);
  const second = runBridgeChecked('tap', { tapX: 1, tapY: 2,
    serial: 'android-1',
    packageName: 'com.example.second',
    feedback: 'off',
  }, dependencies);

  await nextTurn();
  try {
    assert.deepEqual(
      new Set(starts),
      new Set(['com.example.first']),
    );
  } finally {
    gate.resolve();
    await Promise.allSettled([first, second]);
  }
});

test('MCP execution preserves an empty input value for clearing a field', async () => {
  let received;
  const result = await runBridgeChecked('input-text', {
    serial: 'android-1',
    packageName: 'com.example.app',
    text: '',
  }, {
    targetExecution: new TargetExecution(),
    rawRunner: async (_command, args) => {
      received = args;
      return { ok: true, textLength: args.text.length };
    },
  });

  assert.equal(received.text, '');
  assert.equal(payloadOf(result).textLength, 0);
});

test('full feedback promotes a correlated semantic UI change to verified', async () => {
  let eventReads = 0;
  const result = await runBridgeChecked('tap', { tapX: 1, tapY: 2,
    serial: 'android-1',
    packageName: 'com.example.app',
    feedback: 'full',
  }, {
    targetExecution: new TargetExecution(),
    rawRunner: async (command) => {
      if (command === 'ui-observation') return { ok: true, active: true, leaseId: 'test-window' };
      if (command === 'tap') return { ok: true, handledDown: true, handledUp: true };
      if (command === 'events') {
        eventReads += 1;
        return eventReads === 1
          ? { ok: true, items: [] }
          : {
              ok: true,
              items: [{
                id: 1,
                category: 'ui',
                name: 'ui.changed',
                data: { semanticChanged: true, renderChanged: false },
              }],
            };
      }
      return { ok: true };
    },
  });

  const payload = payloadOf(result);
  assert.equal(payload._feedback.ui.semanticChanged, true);
  assert.equal(payload._feedback.status, 'verified');
});

test('full feedback never promotes a failed action even if the UI also changed', async () => {
  let eventReads = 0;
  const result = await runBridgeChecked('tap', { tapX: 1, tapY: 2,
    serial: 'android-1',
    packageName: 'com.example.app',
    feedback: 'full',
  }, {
    targetExecution: new TargetExecution(),
    rawRunner: async (command) => {
      if (command === 'ui-observation') return { ok: true, active: true, leaseId: 'test-window' };
      if (command === 'tap') return { ok: false, error: 'tap_rejected' };
      if (command === 'events') {
        eventReads += 1;
        return eventReads === 1
          ? { ok: true, items: [] }
          : {
              ok: true,
              items: [{
                id: 1,
                category: 'ui',
                name: 'ui.changed',
                data: { semanticChanged: true },
              }],
            };
      }
      return { ok: true };
    },
  });

  const payload = payloadOf(result);
  assert.equal(payload.ok, false);
  assert.equal(payload._feedback.ui.semanticChanged, true);
  assert.equal(payload._feedback.status, 'failed');
});

test('MCP execution returns structured failed feedback when an in-process runner throws', async () => {
  const result = await runBridgeChecked('tap', { tapX: 1, tapY: 2,
    serial: 'android-1',
    packageName: 'com.example.app',
    tapX: 1,
    tapY: 2,
  }, {
    targetExecution: new TargetExecution(),
    rawRunner: async () => { throw new Error('device unavailable'); },
  });

  const payload = payloadOf(result);
  assert.equal(result.isError, true);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'command_failed');
  assert.equal(payload.message, 'device unavailable');
  assert.equal(payload._feedback.status, 'failed');
});

test('MCP execution keeps the legacy operation available while reporting fact-cache initialization failure', async () => {
  let operationCalls = 0;
  const result = await runBridgeChecked('tap', { tapX: 1, tapY: 2,
    serial: 'android-1',
    packageName: 'com.example.app',
    tapX: 4,
    tapY: 8,
  }, {
    targetExecution: new TargetExecution(),
    factRecorderFactory: () => {
      const error = new Error('FactCache requires node:sqlite: node_sqlite_unavailable');
      error.code = 'node_sqlite_unavailable';
      throw error;
    },
    rawRunner: async () => {
      operationCalls += 1;
      return { ok: true, action: 'tap' };
    },
  });

  const payload = payloadOf(result);
  assert.equal(operationCalls, 1);
  assert.equal(payload.ok, true);
  assert.equal(payload._feedback.factCache.persistence, false);
  assert.equal(payload._feedback.factCache.degraded, true);
  assert.equal(payload._feedback.factCache.error, 'node_sqlite_unavailable');
});

test('MCP execution keeps live four-stream payload and exposes action facts without copying mobile bodies', async (t) => {
  const cache = createSqliteCache(t);
  const factRecorder = new FactRecorder({ cache, now: () => 20_000 });
  const calls = [];
  const rawRunner = async command => {
    calls.push(command);
    return { ok: true, items: [{ id: 1, category: 'ui', name: 'ui.changed' }] };
  };
  const observationCollector = new ObservationCollector({ rawRunner,
    recordEvidence: factRecorder.recordEvidence.bind(factRecorder),
    recordDeviceLog: factRecorder.recordDeviceLog.bind(factRecorder) });
  observationCollector.start();
  t.after(() => observationCollector.stop());
  const result = await runBridgeChecked('events', {
    serial: 'android-1',
    packageName: 'com.example.app',
    requestId: 'events-1',
  }, {
    factRecorder,
    observationCollector,
    targetExecution: new TargetExecution(),
    rawRunner,
  });

  const payload = payloadOf(result);
  assert.deepEqual(calls, ['events']);
  assert.equal(payload._feedback.observer.target.backgroundPolling, false);
  assert.equal(payload._feedback.observer.target.lastSuccessAtMs, null);
  assert.equal(typeof payload._feedback.observer.target.expiresAtMs, 'number');
  assert.equal(payload.items[0].name, 'ui.changed');
  assert.equal(cache.query({ partition: 'ui' }).count, 0);
  assert.equal(cache.query({ partition: 'action' }).count, 1);
  assert.equal(payload._feedback.evidence.some((item) => item.partition === 'ui'), false);
  assert.equal(payload._feedback.evidence.some((item) => item.partition === 'action'), true);
  assert.equal(JSON.stringify(payload._feedback.evidence).includes('ui.changed'), false);
  assert.equal(payload._feedback.factCache.persistence, true);
  assert.equal(payload._feedback.factCache.degraded, false);
  assert.deepEqual(payload._feedback.factCache.profileSelection, { mode: 'explicit' });
  assert.equal(payload._feedback.factCache.mmap.enabled, true);
  assert.equal(payload._feedback.factCache.mmap.effectiveBytes > 0, true);
});

test('MCP Web history rejects an unbound request even when unrelated Host history is present', async (t) => {
  const cache = createSqliteCache(t);
  const factRecorder = new FactRecorder({ cache, now: () => 30_000 });
  const args = { sessionId: 'web-1' };
  factRecorder.recordEvidence('web-network', args, {
    ok: true,
    items: [{ id: 1, method: 'GET', url: 'https://example.test' }],
  });
  let liveCalls = 0;

  const result = await runBridgeChecked('web-network', {
    ...args,
    history: true,
  }, {
    factRecorder,
    targetExecution: new TargetExecution(),
    rawRunner: async () => { liveCalls += 1; return { ok: true, items: [] }; },
  });

  const payload = payloadOf(result);
  assert.equal(liveCalls, 0);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'missing_argument');
  assert.equal(payload.field, 'runtimeEpoch');
  assert.equal(payload.dispatched, false);
});

test('MCP registers a persistent observer, links the action, and reports compact observer health', async () => {
  const calls = [];
  const target = {
    kind: 'android',
    key: 'android:["android-1","com.example.app"]',
    serial: 'android-1',
    packageName: 'com.example.app',
  };
  const observationCollector = {
    register(command, args) {
      calls.push({ type: 'register', command, args });
      return { registered: true, target };
    },
    noteAction(receivedTarget, actionId) {
      calls.push({ type: 'noteAction', target: receivedTarget, actionId });
      return true;
    },
    status() {
      return {
        running: true,
        targetCount: 1,
        maxTargets: 32,
        inactiveTargetTtlMs: 1_800_000,
        targetEvictions: 0,
        targetExpirations: 0,
        targets: [{
          ...target,
          runtimeEpoch: null,
          failureCount: 0,
          lastError: null,
          backgroundPolling: false,
          expiresAtMs: 1_840_000,
          lastSuccessAtMs: null,
          deviceLog: { enabled: true, running: true, buffers: ['main', 'system', 'crash'] },
        }],
        dropped: { deviceLogLines: 0, deviceLogBytes: 0, deviceLogBatches: 0 },
      };
    },
  };

  const result = await runBridgeChecked('tap', { tapX: 1, tapY: 2,
    serial: 'android-1',
    packageName: 'com.example.app',
    tapX: 10,
    tapY: 20,
    requestId: 'observer-action-1',
  }, {
    factRecorder: null,
    observationCollector,
    targetExecution: new TargetExecution(),
    rawRunner: async () => ({ ok: true, action: 'tap' }),
  });

  const payload = payloadOf(result);
  assert.equal(calls[0].type, 'register');
  assert.equal(calls[1].type, 'noteAction');
  assert.equal(calls[1].actionId, 'observer-action-1');
  assert.deepEqual(calls[1].target, target);
  assert.deepEqual(payload._feedback.observer, {
    running: true,
    targetCount: 1,
    maxTargets: 32,
    inactiveTargetTtlMs: 1_800_000,
    targetEvictions: 0,
    targetExpirations: 0,
    target: {
      key: target.key,
      runtimeEpoch: null,
      failureCount: 0,
      lastError: null,
      backgroundPolling: false,
      expiresAtMs: 1_840_000,
      lastSuccessAtMs: null,
      deviceLog: { enabled: true, running: true, buffers: ['main', 'system', 'crash'] },
    },
    dropped: { deviceLogLines: 0, deviceLogBytes: 0, deviceLogBatches: 0 },
  });
});

test('MCP pre-registers a mutation and carries one generated action id through completed timings', async (t) => {
  const cache = createSqliteCache(t);
  const factRecorder = new FactRecorder({ cache, now: () => 20_000 });
  const calls = [];
  const target = {
    kind: 'android',
    key: 'android:["android-1","com.example.app"]',
    serial: 'android-1',
    packageName: 'com.example.app',
  };
  const observationCollector = {
    register() {
      calls.push({ type: 'register' });
      return { registered: true, target };
    },
    noteAction(receivedTarget, actionId, timings) {
      calls.push({ type: 'noteAction', target: receivedTarget, actionId, timings });
      return true;
    },
    status() {
      return { running: true, targetCount: 1, targets: [target] };
    },
  };
  const executionTimes = [995, 1_000, 1_005, 1_010];
  const targetExecution = new TargetExecution({ now: () => executionTimes.shift() });

  const result = await runBridgeChecked('tap', { tapX: 1, tapY: 2,
    serial: 'android-1',
    packageName: 'com.example.app',
    tapX: 10,
    tapY: 20,
  }, {
    factRecorder,
    observationCollector,
    targetExecution,
    rawRunner: async (_command, receivedArgs) => {
      calls.push({ type: 'runner', receivedArgs });
      return { ok: true, action: 'tap' };
    },
  });

  const payload = payloadOf(result);
  const notes = calls.filter((call) => call.type === 'noteAction');
  assert.equal(calls[0].type, 'register');
  assert.equal(calls[1].type, 'noteAction');
  assert.equal(calls[2].type, 'noteAction');
  assert.equal(calls[3].type, 'runner');
  assert.equal(notes.length, 3);
  assert.match(notes[0].actionId, /^host-action-/);
  assert.equal(notes[1].actionId, notes[0].actionId);
  assert.equal(notes[2].actionId, notes[0].actionId);
  assert.equal(Number.isSafeInteger(notes[1].timings.startedAtMs), true);
  assert.deepEqual(notes[2].timings, payload._feedback.timings);
  assert.equal(notes[2].timings.requestedAtMs, 1_000);
  assert.equal(notes[2].timings.startedAtMs, 1_005);
  assert.equal(notes[2].timings.completedAtMs, 1_010);
  assert.equal(calls[3].receivedArgs.requestId, undefined);
  assert.equal(calls[3].receivedArgs.runtimeActionId, notes[0].actionId);
  assert.equal(cache.query({ partition: 'action' }).items[0].actionId, notes[0].actionId);
  cache.close();
});

test('MCP treats observer failures as degraded feedback without failing the primary command', async () => {
  const observationCollector = {
    register() { throw new Error('observer unavailable'); },
    noteAction() { throw new Error('should not be called'); },
    status() { throw new Error('status unavailable'); },
  };

  const result = await runBridgeChecked('tap', { tapX: 1, tapY: 2,
    serial: 'android-1',
    packageName: 'com.example.app',
    tapX: 1,
    tapY: 2,
  }, {
    factRecorder: null,
    observationCollector,
    targetExecution: new TargetExecution(),
    rawRunner: async () => ({ ok: true, action: 'tap' }),
  });

  const payload = payloadOf(result);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload._feedback.observer, {
    running: false,
    degraded: true,
    error: 'observer unavailable',
  });
});
