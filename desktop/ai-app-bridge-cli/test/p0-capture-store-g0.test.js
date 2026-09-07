'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ObservationCollector } = require('../bin/observation-collector');
const { FactCache } = require('../bin/fact-cache');
const { FactRecorder } = require('../bin/fact-recorder');
const { runBridgeChecked } = require('../bin/mcp-server');
const { TargetExecution } = require('../bin/target-execution');
const contract = require('./fixtures/p0-mobile-capture-contract.json');

const ROOT = path.join(__dirname, '../../..');

function readRepo(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function payloadOf(result) {
  return JSON.parse(result.content[0].text);
}

function createSqliteCache(t, budgetBytes = 2 * 1024 * 1024) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-app-bridge-p0-capture-'));
  const cache = new FactCache({ directory, budgetBytes });
  t.after(() => {
    cache.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return cache;
}

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
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    }
    this.nowMs = destinationMs;
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
  }
}

test('G0 Android capture contract stays platform-specific', () => {
  const gradle = readRepo('android/ai-app-bridge-android/build.gradle.kts');
  assert.match(gradle, /version = "0\.3\.0-rc\.1"/);
  const source = readRepo(contract.android.source);
  assert.match(source, /private const val bridgeVersion = "0\.3\.0-rc\.1"/);
  assert.match(source, /CountCaps\(logs = 300, network = 200, events = 300, state = 200\)/);
  assert.equal(source.includes('logEntries'), false);
  assert.equal(source.includes('networkEntries'), false);
  assert.equal(source.includes('eventEntries'), false);
  assert.equal(source.includes('stateEntries'), false);
  assert.equal(source.includes('shadowCapture'), false);
  assert.match(source, /CaptureAppend\.appendSanitized\(/);
  assert.match(source, /LegacyLiveView.fromHttp\(captureStore, "logs"/);
  assert.match(source, /LegacyLiveView.fromHttp\(captureStore, "network"/);
  assert.match(source, /LegacyLiveView.fromHttp\(captureStore, "state"/);
  assert.match(source, /LegacyLiveView.fromHttp\(captureStore, "events"/);
  assert.equal(source.includes('since-id'), false);
  const liveView = readRepo(contract.android.liveView);
  assert.match(liveView, /query.limit \?: 200/);
  assert.match(liveView, /query.platform == "ios"\) 1_000 else 500/);
  assert.match(liveView, /\.put\("ok", page.ok\)/);
  assert.match(liveView, /\.put\("type", page.type\)/);
  assert.match(liveView, /\.put\("items", /);
  assert.match(liveView, /body.put\("values", values\)/);
  assert.equal(liveView.includes('since-id'), false);
  const backend = readRepo(contract.android.storeBackend);
  assert.match(backend, /query.sinceId != null && fact.captureId <= query.sinceId/);
  assert.match(backend, /query.sinceMs != null && fact.timestampMs < query.sinceMs/);
  assert.match(backend, /filtered.takeLast\(limit\)/);
  for (const route of contract.android.getPaths) {
    assert.match(source, new RegExp(`GET" && request.path == "${route}"`));
    assert.match(source, new RegExp(`POST" && request.path == "${route}"`));
  }
  assert.match(source, /POST" && request.path == "\/v1\/app\/clear-data"/);
  assert.match(source, /return JSONObject\(\)\.put\("ok", true\)\.put\("event", event\)/);
  assert.match(source, /private const val redactedValue = "\[redacted\]"/);
  assert.match(source, /\.put\("url", redactUrl\(payload.optString\("url", ""\)\)\)/);
  assert.match(source, /\.put\("value", if \(payload.has\("value"\)\) payload.opt\("value"\) else JSONObject.NULL\)/);
  assert.match(source, /event.put\("data", payload.opt\("data"\)\)/);
  assert.equal(source.includes('redactJsonValue(payload.opt("value")'), false);
  assert.deepEqual(contract.android.stateKey, 'namespace.key');
  assert.deepEqual(contract.android.query.maxLimit, 500);
  assert.deepEqual(contract.android.postEnvelope, 'ok+event');
});

test('G0 iOS capture contract keeps its own key, limit, and overflow behavior', () => {
  const source = readRepo(contract.ios.source);
  assert.match(source, /private let bridgeVersion = "0\.2\.11"/);
  assert.match(source, /CountCaps\(logs: 300, network: 200, events: 300, state: 200\)/);
  assert.match(source, /let stateKey = "\\\(namespace\):\\\(key\)"/);
  assert.equal(source.includes('logEntries'), false);
  assert.equal(source.includes('networkEntries'), false);
  assert.equal(source.includes('eventEntries'), false);
  assert.equal(source.includes('stateEntries'), false);
  assert.equal(source.includes('shadowCapture'), false);
  assert.match(source, /CaptureAppend\.appendSanitized\(/);
  assert.match(source, /liveCapture\("logs"/);
  assert.match(source, /liveCapture\("network"/);
  assert.match(source, /liveCapture\("state"/);
  assert.match(source, /liveCapture\("events"/);
  assert.match(source, /LegacyLiveView.fromHttp\(store: captureStore/);
  const liveView = readRepo(contract.ios.liveView);
  assert.match(liveView, /query.platform == "ios" \? 1_000 : 500/);
  assert.match(liveView, /query.limit \?\? 200/);
  assert.match(liveView, /http\["sinceId"\] \?\? \(platform == "ios" \? http\["since-id"\] : nil\)/);
  assert.match(liveView, /http\["sinceMs"\] \?\? \(platform == "ios" \? http\["since-ms"\] : nil\)/);
  const backend = readRepo(contract.ios.storeBackend);
  assert.match(backend, /fact.captureId <= sinceId/);
  assert.match(backend, /fact.timestampMs < sinceMs/);
  assert.match(backend, /filtered.suffix\(limit\)/);
  for (const route of contract.ios.getPaths) {
    assert.match(source, new RegExp(`"GET", "${route}"`));
    assert.match(source, new RegExp(`"POST", "${route}"`));
  }
  assert.match(source, /"POST", "\/v1\/app\/clear-data"/);
  assert.match(source, /"action": "clear-app-data"/);
  assert.match(source, /"ok": true, "record": event/);
  assert.match(source, /"value": redactJsonValue\(payload\["value"\] \?\? NSNull\(\)\)/);
  assert.match(source, /"data": redactJsonValue\(payload\["data"\] \?\? NSNull\(\)\)/);
  assert.notEqual(contract.ios.stateKey, contract.android.stateKey);
  assert.notEqual(contract.ios.query.maxLimit, contract.android.query.maxLimit);
  assert.notEqual(contract.ios.stateOverflow, contract.android.stateOverflow);
  assert.notEqual(contract.ios.postEnvelope, contract.android.postEnvelope);
});

test('G0 Flutter MethodChannel and HTTP fallback call shape stay frozen', () => {
  const pubspec = readRepo('flutter/ai_app_bridge_flutter/pubspec.yaml');
  assert.match(pubspec, /version: 0\.2\.4/);
  const dart = readRepo(contract.flutter.source);
  assert.match(dart, /static const MethodChannel _channel = MethodChannel\('ai_app_bridge'\);/);
  assert.match(dart, /static const String _baseEndpoint = 'http:\/\/127\.0\.0\.1:18080';/);
  assert.match(dart, /unawaited\(_sendCapture\('recordLog', '\/v1\/logs', payload\)\);/);
  assert.match(dart, /unawaited\(_sendCapture\('recordNetwork', '\/v1\/network', payload\)\);/);
  assert.match(dart, /unawaited\(_sendCapture\('recordState', '\/v1\/state', payload\)\);/);
  assert.match(dart, /unawaited\(_sendCapture\('recordEvent', '\/v1\/events', payload\)\);/);
  assert.match(dart, /if \(await _invokeBridgeMethod\(method, body\)\) \{\n\s+return;\n\s+\}\n\s+await _postJson\(path, body\);/);
  assert.match(dart, /} catch \(_\) \{\n\s+\/\/ The native AI app bridge is optional/);
  assert.match(dart, /} catch \(_\) \{\n\s+return false;/);

  const androidPlugin = readRepo(
    'flutter/ai_app_bridge_flutter/android/src/main/kotlin/io/github/mobileaidev/aiappbridge/flutter/AiAppBridgeFlutterPlugin.kt',
  );
  assert.match(androidPlugin, /private const val channelName = "ai_app_bridge"/);
  assert.match(androidPlugin, /"recordLog" -> recordLog/);
  assert.match(androidPlugin, /"recordNetwork" -> recordNetwork/);
  assert.match(androidPlugin, /"recordState" -> recordState/);
  assert.match(androidPlugin, /"recordEvent" -> recordEvent/);

  const iosPlugin = readRepo(
    'flutter/ai_app_bridge_flutter/ios/ai_app_bridge_flutter/Sources/ai_app_bridge_flutter/AiAppBridgeFlutterPlugin.swift',
  );
  assert.match(iosPlugin, /private static let channelName = "ai_app_bridge"/);
  assert.match(iosPlugin, /case "recordLog":/);

  const iosVendor = readRepo(
    'flutter/ai_app_bridge_flutter/ios/ai_app_bridge_flutter/Sources/AiAppBridgeIOS/AiAppBridge.swift',
  );
  assert.equal(iosVendor.includes('logEntries'), false);
  assert.equal(iosVendor.includes('shadowCapture'), false);
  assert.match(iosVendor, /CaptureAppend\.appendSanitized\(/);
  assert.match(iosVendor, /LegacyLiveView\.fromHttp\(store: captureStore/);
  assert.equal(/class\s+\w*CaptureStore|Map<String,\s*.*>\s+(logs|network|events)/.test(dart), false);
});

test('G0 Host ObservationCollector does not copy mobile four-stream payloads into FactStore', async (t) => {
  const timers = new ManualTimers();
  const cache = createSqliteCache(t);
  const recorder = new FactRecorder({ cache, now: timers.now });
  const commands = [];
  const collector = new ObservationCollector({
    rawRunner: async (command) => {
      commands.push(command);
      if (command === 'status') {
        return { ok: true, debugBridge: { runtimeEpoch: 'p0-runtime' } };
      }
      if (command === 'logs') {
        return { ok: true, items: [{ id: 11, message: 'copied-log', timestampMs: 1_000 }] };
      }
      if (command === 'network') {
        return { ok: true, items: [{ id: 12, method: 'GET', url: 'https://copied.test/path' }] };
      }
      if (command === 'state') {
        return { ok: true, items: [{ id: 13, namespace: 'app', key: 'ready', value: 'copied-state' }] };
      }
      if (command === 'events') {
        return { ok: true, items: [{ id: 14, category: 'app', name: 'copied-event' }] };
      }
      return { ok: true, items: [] };
    },
    recordEvidence: recorder.recordEvidence.bind(recorder),
    recordDeviceLog: async () => {},
    spawn: () => null,
    clock: timers.now,
    timers,
    pollIntervalMs: 100,
    statusIntervalMs: 100,
  });

  collector.register('tap', { serial: 'android-1', packageName: 'com.example.app' });
  collector.start();
  await timers.advanceBy(60_000);

  assert.equal(commands.includes('logs'), false);
  assert.equal(commands.includes('network'), false);
  assert.equal(commands.includes('state'), false);
  assert.equal(commands.includes('events'), false);
  assert.equal(cache.query({ partition: 'app-log' }).items.length, 0);
  assert.equal(cache.query({ partition: 'network' }).items.length, 0);
  assert.equal(
    cache.query({ partition: 'state-event' }).items.some((item) => (
      item.payload.record.value === 'copied-state' || item.payload.record.name === 'copied-event'
    )),
    false,
  );
  await collector.stop();
});

test('G0 history:true does not return Host-copied payload when live provider fails', async (t) => {
  const cache = createSqliteCache(t);
  const factRecorder = new FactRecorder({ cache, now: () => 40_000 });
  const args = { serial: 'android-1', packageName: 'com.example.app' };
  factRecorder.recordEvidence('logs', args, {
    ok: true,
    items: [{ id: 21, message: 'stale-host-copy', timestampMs: 2_000 }],
  });
  let liveCalls = 0;
  const result = await runBridgeChecked('logs', { ...args, history: true }, {
    factRecorder,
    targetExecution: new TargetExecution(),
    rawRunner: async () => {
      liveCalls += 1;
      throw new Error('target_disconnected');
    },
  });
  const payload = payloadOf(result);
  assert.equal(liveCalls, 1);
  assert.equal(payload.ok, false);
  assert.match(String(payload.error), /target_disconnected/);
  assert.equal(payload.items, undefined);
  assert.equal(JSON.stringify(payload).includes('stale-host-copy'), false);
});

test('G0 feedback:off does not copy mobile payload; _feedback.evidence stays refs', async (t) => {
  const cache = createSqliteCache(t);
  const factRecorder = new FactRecorder({ cache, now: () => 50_000 });
  const args = { serial: 'android-1', packageName: 'com.example.app' };

  const off = payloadOf(await runBridgeChecked('logs', { ...args, feedback: 'off' }, {
    factRecorder,
    targetExecution: new TargetExecution(),
    rawRunner: async () => ({
      ok: true,
      items: [{ id: 31, message: 'copied-with-feedback-off' }],
    }),
  }));
  assert.equal(off._feedback, undefined);
  assert.equal(cache.query({ partition: 'app-log' }).items.length, 0);

  const on = payloadOf(await runBridgeChecked('logs', { ...args, feedback: 'full', requestId: 'p0-logs-1' }, {
    factRecorder,
    targetExecution: new TargetExecution(),
    rawRunner: async () => ({
      ok: true,
      items: [{ id: 32, message: 'inline-body-must-not-appear-in-refs' }],
    }),
  }));
  assert.equal(on.items[0].message, 'inline-body-must-not-appear-in-refs');
  assert.equal(Array.isArray(on._feedback.evidence), true);
  assert.equal(on._feedback.evidence.every((item) => item.message === undefined), true);
  assert.equal(on._feedback.evidence.some((item) => item.partition === 'action' && item.globalSeq != null), true);
  assert.equal(on._feedback.evidence.some((item) => item.partition === 'app-log'), false);
  assert.equal(
    JSON.stringify(on._feedback.evidence).includes('inline-body-must-not-appear-in-refs'),
    false,
  );
  assert.equal(
    cache.query({ partition: 'app-log' }).items.some((item) => (
      item.payload.record && item.payload.record.message === 'inline-body-must-not-appear-in-refs'
    )),
    false,
  );
});

test('G0 Host collector defaults remain 1s poll and 30 minute target TTL', () => {
  const source = fs.readFileSync(path.join(__dirname, '../bin/observation-collector.js'), 'utf8');
  assert.match(source, /pollIntervalMs = 1_000/);
  assert.match(source, /inactiveTargetTtlMs = 30 \* 60 \* 1_000/);
  assert.match(source, /const evidenceStreams = \['logs', 'network', 'state', 'events'\]/);
  assert.equal(contract.hostCopy.feedbackOffStopsCopy, true);
  assert.equal(contract.hostCopy.historyTrueReadsHostOnDisconnect, false);
});
