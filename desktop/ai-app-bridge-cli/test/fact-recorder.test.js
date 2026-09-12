const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { FactCache } = require('../test-support/fact-cache');
const { FactRecorder } = require('../bin/fact-recorder');
const { createFactStore } = require('../bin/fact-store');
const { createLegacyFactStoreAdapter } = require('../bin/shared-kernel/evidence-adapters');

function createCache(t, budgetBytes = 2 * 1024 * 1024) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-app-bridge-fact-recorder-'));
  const cache = new FactCache({
    directory,
    budgetBytes,
  });
  t.after(() => {
    cache.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return cache;
}

function createRecorder(t) {
  const cache = createCache(t);
  return { cache, recorder: new FactRecorder({ cache, now: () => 10_000 }) };
}

test('completed SDK recovery survives a production segmented store reopen without rewriting the original unknown outcome', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-completion-history-'));
  let store = createFactStore({ directory, profile: '64mb' });
  let cache = createLegacyFactStoreAdapter(store);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const recorder = new FactRecorder({ cache });
  const target = { serial: 'receipt-device', packageName: 'example.native' };
  assert.equal(recorder.recordExecution({ command: 'input-text', args: { ...target, requestId: 'original' },
    result: { ok: false, error: 'native_action_timeout', dispatched: null, ambiguous: true, settled: false, executionReceipt: null } }).ok, true);
  const identity = { actionId: 'original', runtimeEpoch: 'native-epoch' };
  const proof = { kind: 'native', ...identity, settled: true, dispatched: true, ambiguous: false, error: 'native_action_cancelled',
    execution: { schemaVersion: 'aab.native-execution/v1', ...identity, settled: true }, responseSha256: 'a'.repeat(64) };
  assert.equal(recorder.recordExecution({ command: 'device-ownership', args: { serial: target.serial, requestId: 'recovery' },
    result: { ok: true, recovered: true, executionReceipt: proof, text: 'private payload must not enter this record' } }).ok, true);
  store.close();
  store = createFactStore({ directory, profile: '64mb' });
  cache = createLegacyFactStoreAdapter(store);
  const original = cache.query({ partition: 'action', actionId: 'original', limit: 1 }).items[0].payload.result;
  const recovered = cache.query({ partition: 'action', actionId: 'recovery', limit: 1 }).items[0].payload.result;
  assert.equal(original.settled, false); assert.equal(original.dispatched, null); assert.equal(original.executionReceipt, null);
  assert.deepEqual(recovered.executionReceipt, proof); assert.doesNotMatch(JSON.stringify(recovered), /private payload/);
});

test('records an execution without persisting input, script, or payload contents', (t) => {
  const { cache, recorder } = createRecorder(t);
  const recorded = recorder.recordExecution({
    command: 'input-text',
    args: {
      serial: 'device-1',
      packageName: 'com.example.app',
      requestId: 'action-1',
      text: 'super secret input',
      script: 'document.cookie',
      payload: '{"password":"secret"}',
      arguments: { selector: '#field', value: 'nested secret input' },
      tapX: 0,
      tapY: 0,
    },
    result: { ok: true, action: 'input-text', text: 'super secret input' },
    feedback: { status: 'completed' },
  });

  assert.equal(recorded.ok, true);
  const facts = cache.query({ partition: 'action', target: recorded.targetKey }).items;
  assert.equal(facts.length, 1);
  const serialized = JSON.stringify(facts[0]);
  assert.doesNotMatch(serialized, /super secret input|nested secret input|document\.cookie|password.*secret/);
  assert.equal(facts[0].payload.args.textLength, 18);
  assert.equal(facts[0].payload.args.scriptLength, 15);
  assert.equal(facts[0].payload.args.arguments.valueLength, 19);
  assert.equal(facts[0].payload.args.tapX, 0);
  assert.equal(facts[0].actionId, 'action-1');
});

test('does not ingest mobile four-stream payloads into Host FactStore', (t) => {
  const { cache, recorder } = createRecorder(t);
  const android = { serial: 'device-1', packageName: 'com.example.app' };
  const ios = { deviceId: 'iphone-1', bundleId: 'com.example.app' };
  const commands = [
    ['logs', android, { id: 1, timestampMs: 9000, message: 'ready' }],
    ['network', android, { id: 2, timestampMs: 9001, method: 'GET', url: 'https://example.test' }],
    ['state', android, { id: 3, timestampMs: 9002, key: 'session', value: 'open' }],
    ['events', android, { id: 4, timestampMs: 9003, category: 'ui', name: 'ui.changed' }],
    ['ios-logs', ios, { id: 5, timestampMs: 9004, message: 'ios-ready' }],
    ['ios-network', ios, { id: 6, timestampMs: 9005, method: 'POST', url: 'https://ios.example.test' }],
    ['ios-state', ios, { id: 7, timestampMs: 9006, key: 'route', value: 'home' }],
    ['ios-events', ios, { id: 8, timestampMs: 9007, category: 'app', name: 'opened' }],
  ];
  for (const [command, args, item] of commands) {
    assert.deepEqual(recorder.recordEvidence(command, args, { ok: true, items: [item] }), []);
  }
  assert.equal(cache.query({ partition: 'network' }).count, 0);
  assert.equal(cache.query({ partition: 'app-log' }).count, 0);
  assert.equal(cache.query({ partition: 'ui' }).count, 0);
  assert.equal(cache.query({ partition: 'state-event' }).count, 0);
});

test('ingests Host-owned Web evidence into bounded semantic partitions', (t) => {
  const { cache, recorder } = createRecorder(t);
  const base = { sessionId: 'web-1' };

  recorder.recordEvidence('web-network', base, {
    ok: true,
    items: [{ id: 1, timestampMs: 9000, method: 'GET', url: 'https://example.test' }],
  });
  recorder.recordEvidence('web-logs', base, {
    ok: true,
    items: [{ id: 2, timestampMs: 9001, level: 'info', message: 'ready' }],
  });
  recorder.recordEvidence('web-events', base, {
    ok: true,
    items: [
      { id: 3, timestampMs: 9002, category: 'ui', name: 'ui.changed' },
      { id: 4, timestampMs: 9003, category: 'app', name: 'checkout' },
    ],
  });

  assert.equal(cache.query({ partition: 'network' }).count, 1);
  assert.equal(cache.query({ partition: 'app-log' }).count, 1);
  assert.equal(cache.query({ partition: 'ui' }).count, 1);
  assert.equal(cache.query({ partition: 'state-event' }).count, 1);
});

test('canonical target identity cannot be overwritten by provider metadata', (t) => {
  const { cache, recorder } = createRecorder(t);
  recorder.recordEvidence('tree', {
    serial: 'device-locked',
    packageName: 'com.example.locked',
  }, {
    ok: true,
    app: {
      packageName: 'com.example.wrong',
      serial: 'wrong-device',
      model: 'provider-model',
    },
    root: { text: 'identity check' },
  });

  const fact = cache.query({ partition: 'ui' }).items[0];
  assert.equal(fact.app.packageName, 'com.example.locked');
  assert.equal(fact.app.serial, 'device-locked');
  assert.equal(fact.app.model, 'provider-model');
});

test('reads persisted device-log history through logcat', (t) => {
  const { recorder } = createRecorder(t);
  recorder.recordDeviceLog({ serial: 'device-1' }, {
    lines: ['1700000000.000 device evidence'],
    count: 1,
    buffers: ['main'],
    observedAtMs: 9000,
  });
  const history = recorder.readHistory('logcat', { serial: 'device-1' });
  assert.equal(history.ok, true);
  assert.equal(history.type, 'logcat');
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].lines[0], '1700000000.000 device evidence');
  assert.equal(history._factCache.history, true);
});

test('reads persisted history through existing evidence command shapes and opaque cursors', (t) => {
  const { recorder } = createRecorder(t);
  const args = { sessionId: 'web-1' };
  recorder.recordEvidence('web-events', args, {
    ok: true,
    items: [
      { id: 1, category: 'ui', name: 'dialog.opened' },
      { id: 2, category: 'app', name: 'checkout' },
    ],
  });

  const first = recorder.readHistory('web-events', { ...args, limit: 1 });
  assert.equal(first.ok, true);
  assert.equal(first.type, 'events');
  assert.equal(first.items.length, 1);
  assert.equal(first._factCache.history, true);
  assert.equal(typeof first._factCache.cursor, 'string');

  const second = recorder.readHistory('web-events', {
    ...args,
    limit: 10,
    factCursor: first._factCache.cursor,
  });
  assert.equal(second.items.length, 1);
  assert.notEqual(second.items[0].name, first.items[0].name);
});

test('optionally reads persisted execution records through the existing events history command', (t) => {
  const { recorder } = createRecorder(t);
  const args = { serial: 'device-1', packageName: 'com.example.app' };
  recorder.recordExecution({
    command: 'tap-text',
    args: { ...args, requestId: 'tap-checkout', targetText: 'Checkout' },
    result: { ok: true, action: 'tap-text', matched: { className: 'Button' } },
    feedback: { status: 'completed' },
  });

  const withoutActions = recorder.readHistory('events', { ...args, limit: 10 });
  assert.equal(withoutActions.items.length, 0);

  const withActions = recorder.readHistory('events', {
    ...args,
    limit: 10,
    includeActions: true,
  });
  assert.equal(withActions.items.length, 1);
  assert.equal(withActions.items[0].kind, 'execution');
  assert.equal(withActions.items[0].command, 'tap-text');
  assert.equal(withActions.items[0].status, 'completed');
  assert.equal(withActions.items[0]._fact.actionId, 'tap-checkout');
});

test('deduplicates request ids and capture ids within a target runtime', (t) => {
  const { cache, recorder } = createRecorder(t);
  const args = {
    serial: 'device-1',
    packageName: 'com.example.app',
    requestId: 'same-request',
  };
  const firstAction = recorder.recordExecution({ command: 'tap', args, result: { ok: true } });
  const duplicateAction = recorder.recordExecution({ command: 'tap', args, result: { ok: true } });
  assert.equal(duplicateAction.deduplicated, true);
  assert.equal(duplicateAction.globalSeq, firstAction.globalSeq);

  const capture = { ok: true, items: [{ id: 7, category: 'ui', name: 'ui.changed' }] };
  assert.equal(recorder.recordEvidence('web-events', { sessionId: 'web-1' }, capture).length, 1);
  assert.equal(recorder.recordEvidence('web-events', { sessionId: 'web-1' }, capture).length, 0);
  assert.equal(cache.query({ partition: 'ui' }).count, 1);
});

test('delegates capture-id deduplication to the cache across recorder restarts', (t) => {
  const cache = createCache(t);
  const args = { sessionId: 'web-1' };
  const capture = {
    ok: true,
    session: { connectedAtMs: 10_000 },
    items: [{ id: 11, level: 'info', message: 'same runtime record' }],
  };

  const firstRecorder = new FactRecorder({ cache, now: () => 10_000 });
  const first = firstRecorder.recordEvidence('web-logs', args, capture);
  const restartedRecorder = new FactRecorder({ cache, now: () => 11_000 });
  const duplicate = restartedRecorder.recordEvidence('web-logs', args, capture);

  assert.equal(first.length, 1);
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0].deduplicated, true);
  assert.equal(duplicate[0].globalSeq, first[0].globalSeq);
  assert.equal(cache.query({ partition: 'app-log' }).count, 1);
});

test('attributes timestamped evidence to the matching action interval instead of the latest action', (t) => {
  const cache = createCache(t);
  const recorder = new FactRecorder({
    cache,
    now: () => 2_000,
    actionCompletionGraceMs: 25,
  });
  const args = { sessionId: 'web-1' };
  const actionTimeline = [
    {
      actionId: 'action-first',
      requestedAtMs: 1_000,
      startedAtMs: 1_005,
      completedAtMs: 1_020,
    },
    {
      actionId: 'action-second',
      requestedAtMs: 1_021,
      startedAtMs: 1_030,
      completedAtMs: 1_045,
    },
  ];

  recorder.recordEvidence('web-events', args, {
    ok: true,
    items: [
      { id: 21, timestampMs: 1_015, category: 'ui', name: 'first.dialog.opened' },
      { id: 22, timestampMs: 1_035, category: 'ui', name: 'second.page.opened' },
      { id: 23, timestampMs: 1_025, category: 'ui', name: 'first.animation.settled' },
      { id: 24, timestampMs: 1_071, category: 'ui', name: 'unsafe.late.evidence' },
      { id: 25, category: 'ui', name: 'untimed.best.effort' },
    ],
  }, {
    actionId: 'action-second',
    actionTimeline,
  });

  const facts = cache.query({ partition: 'ui' }).items;
  assert.equal(facts.find((fact) => fact.payload.record.id === 21).actionId, 'action-first');
  assert.equal(facts.find((fact) => fact.payload.record.id === 22).actionId, 'action-second');
  assert.equal(facts.find((fact) => fact.payload.record.id === 23).actionId, 'action-first');
  assert.equal(facts.find((fact) => fact.payload.record.id === 24).actionId, null);
  assert.equal(facts.find((fact) => fact.payload.record.id === 25).actionId, 'action-second');
  cache.close();
});

test('does not let a later requested-but-not-started action steal evidence from the running action', (t) => {
  const cache = createCache(t);
  const recorder = new FactRecorder({ cache, now: () => 2_000 });
  const args = { sessionId: 'web-1' };

  recorder.recordEvidence('web-events', args, {
    ok: true,
    items: [{ id: 31, timestampMs: 1_015, category: 'ui', name: 'running.action.changed' }],
  }, {
    actionId: 'action-queued',
    actionTimeline: [
      {
        actionId: 'action-running',
        requestedAtMs: 1_000,
        startedAtMs: 1_005,
        completedAtMs: null,
      },
      {
        actionId: 'action-queued',
        requestedAtMs: 1_010,
        startedAtMs: null,
        completedAtMs: null,
      },
    ],
  });

  assert.equal(cache.query({ partition: 'ui' }).items[0].actionId, 'action-running');
  cache.close();
});

test('uses an explicit runtime action id instead of guessing from overlapping action times', (t) => {
  const { cache, recorder } = createRecorder(t);
  recorder.recordEvidence('web-logs', {
    sessionId: 'web-1',
  }, {
    ok: true,
    debugBridge: { runtimeEpoch: 'runtime-explicit-action' },
    items: [{
      id: 1,
      timestampMs: 1_020,
      actionId: 'runtime-action-2',
      level: 'info',
      tag: 'test',
      message: 'bound by runtime',
    }],
  }, {
    actionTimeline: [
      { actionId: 'host-action-1', startedAtMs: 1_000, completedAtMs: 1_030 },
      { actionId: 'host-action-2', startedAtMs: 1_010, completedAtMs: 1_040 },
    ],
  });

  const record = cache.query({ partition: 'app-log' }).items[0];
  assert.equal(record.actionId, 'runtime-action-2');
});

test('redacts Android password EditText contents only in persisted UI evidence', (t) => {
  const { cache, recorder } = createRecorder(t);
  const liveResult = {
    ok: true,
    root: {
      className: 'android.widget.EditText',
      resourceName: 'com.example.app:id/login_password',
      text: 'android-secret-marker',
      contentDescription: 'android-accessibility-secret',
    },
  };

  recorder.recordEvidence('tree', {
    serial: 'device-1',
    packageName: 'com.example.app',
  }, liveResult);

  assert.equal(liveResult.root.text, 'android-secret-marker');
  assert.equal(liveResult.root.contentDescription, 'android-accessibility-secret');
  const persisted = cache.query({ partition: 'ui' }).items[0].payload.record.root;
  assert.equal(persisted.secure, true);
  assert.equal(persisted.text, '[REDACTED]');
  assert.equal(persisted.textLength, 21);
  assert.equal(persisted.contentDescription, 'android-accessibility-secret');
  assert.doesNotMatch(JSON.stringify(persisted), /android-secret-marker/);
});

test('redacts iOS secure text field labels and values in persisted UI evidence', (t) => {
  const { cache, recorder } = createRecorder(t);
  const liveResult = {
    ok: true,
    root: {
      className: 'XCUIElementTypeSecureTextField',
      text: 'ios-secret-marker',
      label: 'ios-private-label',
      accessibilityValue: 'ios-accessibility-value',
    },
  };

  recorder.recordEvidence('ios-tree', {
    deviceId: 'ios-device-1',
    bundleId: 'com.example.ios',
  }, liveResult);

  assert.equal(liveResult.root.text, 'ios-secret-marker');
  const persisted = cache.query({ partition: 'ui' }).items[0].payload.record.root;
  assert.equal(persisted.secure, true);
  assert.equal(persisted.text, '[REDACTED]');
  assert.equal(persisted.textLength, 17);
  assert.equal(persisted.label, 'ios-private-label');
  assert.equal(persisted.accessibilityValue, 'ios-accessibility-value');
  assert.doesNotMatch(JSON.stringify(persisted), /ios-secret-marker/);
});

test('redacts obscured Flutter semantics contents in persisted UI evidence', (t) => {
  const { cache, recorder } = createRecorder(t);
  const liveResult = {
    ok: true,
    root: {
      nodeId: 41,
      flags: 'SemanticsFlag.isTextField, SemanticsFlag.isObscured',
      label: 'flutter-private-label',
      value: 'flutter-secret-marker',
      hint: 'flutter-private-hint',
    },
  };

  recorder.recordEvidence('flutter-tree', {
    serial: 'device-1',
    packageName: 'com.example.flutter',
  }, liveResult);

  assert.equal(liveResult.root.value, 'flutter-secret-marker');
  const persisted = cache.query({ partition: 'ui' }).items[0].payload.record.root;
  assert.equal(persisted.secure, true);
  assert.equal(persisted.label, 'flutter-private-label');
  assert.equal(persisted.value, '[REDACTED]');
  assert.equal(persisted.valueLength, 21);
  assert.equal(persisted.hint, 'flutter-private-hint');
  assert.doesNotMatch(JSON.stringify(persisted), /flutter-secret-marker/);
});

test('redacts sensitive Web DOM control contents in persisted UI evidence', (t) => {
  const { cache, recorder } = createRecorder(t);
  const liveResult = {
    ok: true,
    controls: [{
      tag: 'input',
      type: 'password',
      text: 'web-secret-marker',
      value: 'web-private-value',
      ariaLabel: 'web-private-label',
      placeholder: 'web-private-placeholder',
    }],
  };

  recorder.recordEvidence('web-dom', { sessionId: 'web-session-1' }, liveResult);

  assert.equal(liveResult.controls[0].value, 'web-private-value');
  const persisted = cache.query({ partition: 'ui' }).items[0].payload.record.controls[0];
  assert.equal(persisted.secure, true);
  assert.equal(persisted.text, '[REDACTED]');
  assert.equal(persisted.value, '[REDACTED]');
  assert.equal(persisted.ariaLabel, 'web-private-label');
  assert.equal(persisted.placeholder, 'web-private-placeholder');
  assert.equal(persisted.valueLength, 17);
  assert.doesNotMatch(JSON.stringify(persisted), /web-secret-marker|web-private-value/);
});

test('preserves ordinary static labels next to secure controls for AI retrieval', (t) => {
  const { cache, recorder } = createRecorder(t);
  const liveResult = {
    ok: true,
    root: {
      children: [
        {
          className: 'android.widget.Button',
          text: 'Continue checkout',
          contentDescription: 'Submit order',
        },
        {
          className: 'android.widget.EditText',
          inputType: 129,
          text: 'sibling-secret-marker',
        },
      ],
    },
  };

  recorder.recordEvidence('tree', {
    serial: 'device-1',
    packageName: 'com.example.app',
  }, liveResult);

  const children = cache.query({ partition: 'ui' }).items[0].payload.record.root.children;
  assert.equal(children[0].text, 'Continue checkout');
  assert.equal(children[0].contentDescription, 'Submit order');
  assert.equal(children[0].secure, undefined);
  assert.equal(children[1].text, '[REDACTED]');
});

test('persists ordinary tree labels without privacy truncation', (t) => {
  const cache = createCache(t, 16 * 1024 * 1024);
  const recorder = new FactRecorder({ cache, now: () => 10_000 });
  const children = Array.from({ length: 1_100 }, (_, childIndex) => ({
    id: childIndex,
    children: Array.from({ length: 10 }, (_, grandchildIndex) => ({
      id: `${childIndex}-${grandchildIndex}`,
      text: 'ordinary label',
    })),
  }));

  recorder.recordEvidence('tree', {
    serial: 'device-1',
    packageName: 'com.example.app',
  }, { ok: true, root: { children } });

  const persisted = cache.query({ partition: 'ui' }).items[0].payload.record;
  assert.equal(persisted.root.children.length, 1_100);
  assert.equal(persisted.root.children[0].children.length, 10);
  assert.equal(persisted.root.children[0].children[0].text, 'ordinary label');
  assert.doesNotMatch(JSON.stringify(persisted), /\[TRUNCATED\]/);
});

test('applies the same secure-input projection to persisted status evidence', (t) => {
  const { cache, recorder } = createRecorder(t);
  recorder.recordEvidence('ios-status', {
    deviceId: 'ios-device-1',
    bundleId: 'com.example.ios',
  }, {
    ok: true,
    currentInput: {
      className: 'UITextField',
      value: 'status-secret-marker',
      accessibilityValue: 'status-accessibility-secret',
      input: { secure: true, textLength: 20 },
    },
  });

  const persisted = cache.query({ partition: 'state-event' }).items[0].payload.record.currentInput;
  assert.equal(persisted.secure, true);
  assert.equal(persisted.value, '[REDACTED]');
  assert.equal(persisted.valueLength, 20);
  assert.equal(persisted.accessibilityValue, 'status-accessibility-secret');
  assert.doesNotMatch(JSON.stringify(persisted), /status-secret-marker/);
});

test('does not apply UI privacy projection semantics to network evidence', (t) => {
  const { cache, recorder } = createRecorder(t);
  recorder.recordEvidence('web-network', {
    sessionId: 'web-1',
  }, {
    ok: true,
    items: [{
      id: 901,
      sensitive: true,
      value: 'network-opaque-body',
      redacted: true,
    }],
  });

  const persisted = cache.query({ partition: 'network' }).items[0].payload.record;
  assert.equal(persisted.value, 'network-opaque-body');
  assert.equal(persisted.redacted, true);
  assert.equal(persisted.secure, undefined);
});

test('automatic observation persists original network bodies', (t) => {
  const { cache, recorder } = createRecorder(t);
  const liveRecord = {
    id: 902,
    method: 'POST',
    url: 'https://example.test/private',
    requestBody: '{"privateNote":"keep this live only"}',
    responseBody: Buffer.from('binary-response'),
  };

  recorder.recordEvidence('web-network', {
    sessionId: 'web-1',
  }, {
    ok: true,
    items: [liveRecord],
  }, {
    collector: 'observation',
  });

  const persisted = cache.query({ partition: 'network' }).items[0].payload.record;
  assert.equal(persisted.method, 'POST');
  assert.equal(persisted.url, 'https://example.test/private');
  assert.equal(persisted.requestBody, '{"privateNote":"keep this live only"}');
  assert.deepEqual(persisted.responseBody, { type: 'buffer', byteLength: 15 });
  assert.equal(liveRecord.requestBody.includes('keep this live only'), true);
  assert.equal(Buffer.isBuffer(liveRecord.responseBody), true);
});
