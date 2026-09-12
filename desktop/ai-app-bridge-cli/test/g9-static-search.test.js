'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '../../..');

function readRepo(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function listJs(dir) {
  const abs = path.join(ROOT, dir);
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJs(rel));
    } else if (entry.name.endsWith('.js')) {
      out.push(rel);
    }
  }
  return out;
}

test('G9 production AiAppBridge no longer holds four payload containers', () => {
  const android = readRepo('android/ai-app-bridge-android/src/main/kotlin/io/github/mobileaidev/aiappbridge/android/AiAppBridge.kt');
  const ios = readRepo('ios/ai-app-bridge-ios/Sources/AiAppBridgeIOS/AiAppBridge.swift');
  const flutterIos = readRepo('flutter/ai_app_bridge_flutter/ios/ai_app_bridge_flutter/Sources/AiAppBridgeIOS/AiAppBridge.swift');
  for (const [name, source] of [['android', android], ['ios', ios], ['flutter-ios', flutterIos]]) {
    assert.equal(source.includes('logEntries'), false, name);
    assert.equal(source.includes('networkEntries'), false, name);
    assert.equal(source.includes('eventEntries'), false, name);
    assert.equal(source.includes('stateEntries'), false, name);
    assert.equal(source.includes('shadowCapture'), false, name);
    assert.equal(/AndroidShadowCapture|IOSShadowCapture/.test(source), false, name);
    assert.match(source, /CaptureAppend\.appendSanitized\(/);
    if (name === 'android') assert.match(source, /LegacyLiveView\.fromHttp/);
    else assert.match(source, /CaptureHttpView\.fromHttp/);
  }
});

test('G9 production Script and Intent adapters do not add ADB probes', () => {
  const script = readRepo('desktop/ai-app-bridge-cli/bin/script/script-entry-code.js');
  const intent = readRepo('desktop/ai-app-bridge-cli/bin/intent/intent-production-adapter.js');
  const host = readRepo('desktop/ai-app-bridge-cli/bin/script/script-host-port.js');
  for (const [name, source] of [['script-adapter', script], ['intent-adapter', intent], ['host', host]]) {
    assert.equal(/probeAdbShell|shell', 'true'|adb_probe_failed/.test(source), false, name);
  }
});

test('G9 Script and Intent do not import LegacyDispatcher or Batch', () => {
  for (const file of listJs('desktop/ai-app-bridge-cli/bin/script')) {
    const source = readRepo(file);
    assert.equal(/legacy\/|LegacyDispatcher|runBatch|mcp-server/.test(source), false, file);
  }
  for (const file of listJs('desktop/ai-app-bridge-cli/bin/intent')) {
    const source = readRepo(file);
    assert.equal(/script\/|legacy\/|LegacyDispatcher|runBatch|mcp-server/.test(source), false, file);
  }
});

test('G9 Host live path does not copy mobile payloads or fall back to history', () => {
  const collector = readRepo('desktop/ai-app-bridge-cli/bin/observation-collector.js');
  const recorder = readRepo('desktop/ai-app-bridge-cli/bin/fact-recorder.js');
  const mcp = readRepo('desktop/ai-app-bridge-cli/bin/mcp-server.js');
  assert.equal(collector.includes("recordEvidence('logs'"), false);
  assert.equal(collector.includes("recordEvidence('network'"), false);
  assert.equal(collector.includes("recordEvidence('state'"), false);
  assert.equal(collector.includes("recordEvidence('events'"), false);
  assert.doesNotMatch(collector, /pullEvidence|evidenceStreams/);
  assert.equal(/adb kill-server|kill-server|UiA2/.test(collector + recorder + mcp), false);
});

test('G9 Flutter Dart has no second capture store', () => {
  const dart = readRepo('flutter/ai_app_bridge_flutter/lib/ai_app_bridge_flutter.dart');
  assert.equal(/class\s+\w*CaptureStore/.test(dart), false);
  assert.match(dart, /unawaited\(_sendCapture\('recordLog', '\/v1\/logs', payload\)\);/);
});

test('G9 public history contract keeps mobile facts authoritative', () => {
  const { capabilityPayload } = require('../bin/mcp-server');
  const schema = capabilityPayload({ command: 'network' }).inputSchema;
  assert.match(schema.properties.history.description, /read the phone FactStore while connected/);
  assert.match(schema.properties.history.description, /never use Host-copied payload/);
});
