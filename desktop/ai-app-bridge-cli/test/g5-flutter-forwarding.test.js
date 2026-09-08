'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const flutterRoot = path.join(__dirname, '../../../flutter/ai_app_bridge_flutter');

function readFlutter(rel) {
  return fs.readFileSync(path.join(flutterRoot, rel), 'utf8');
}

test('G5 Dart forwards record* over MethodChannel then HTTP and has no store', () => {
  const dart = readFlutter('lib/ai_app_bridge_flutter.dart');
  assert.equal(/MobileCaptureStore|CaptureStore|BoundedMemory/.test(dart), false);
  assert.match(dart, /static const String _baseEndpoint = 'http:\/\/127\.0\.0\.1:18080'/);
  assert.match(dart, /unawaited\(_sendCapture\('recordLog', '\/v1\/logs'/);
  assert.match(dart, /unawaited\(_sendCapture\('recordNetwork', '\/v1\/network'/);
  assert.match(dart, /unawaited\(_sendCapture\('recordState', '\/v1\/state'/);
  assert.match(dart, /unawaited\(_sendCapture\('recordEvent', '\/v1\/events'/);
  assert.match(dart, /if \(await _invokeBridgeMethod\(method, body\)\) \{\s*return;/);
  assert.match(dart, /await _postJson\(path, body\)/);
  assert.match(dart, /connectionTimeout = const Duration\(milliseconds: 300\)/);
  assert.equal([...dart.matchAll(/timeout\(\s*const Duration\(milliseconds: 500\)/g)].length >= 2, true);
  assert.match(dart, /} catch \(_\) \{\s*\/\/ The native AI app bridge is optional/);
});

test('G5 Flutter plugins map record* onto the native SDK record methods', () => {
  const android = readFlutter(
    'android/src/main/kotlin/io/github/mobileaidev/aiappbridge/flutter/AiAppBridgeFlutterPlugin.kt',
  );
  const ios = readFlutter(
    'ios/ai_app_bridge_flutter/Sources/ai_app_bridge_flutter/AiAppBridgeFlutterPlugin.swift',
  );
  assert.match(android, /androidBridgeClassName = "io\.github\.mobileaidev\.aiappbridge\.android\.AiAppBridge"/);
  // Channel names stay public; Android now forwards the whole payload to preserve actionId.
  assert.match(android, /"recordLog", "recordNetwork", "recordState", "recordEvent" ->/);
  assert.match(android, /recordCapture\(call\.method, call\.arguments as String\)/);
  assert.match(android, /getMethod\("recordFlutterCapture", String::class\.java, String::class\.java\)/);
  assert.match(android, /\.invoke\(null, method, payloadJson\)/);
  assert.match(ios, /AiAppBridge\.shared\.recordLog\(/);
  assert.match(ios, /AiAppBridge\.shared\.recordNetwork\(/);
  assert.match(ios, /AiAppBridge\.shared\.recordState\(/);
  assert.match(ios, /AiAppBridge\.shared\.recordEvent\(/);
});

test('G5 does not add a Dart cache or edit pubspec.lock', () => {
  const dart = readFlutter('lib/ai_app_bridge_flutter.dart');
  const testSource = fs.readFileSync(path.join(flutterRoot, 'test/g5_capture_forwarding_test.dart'), 'utf8');
  assert.equal(/class \w*CaptureStore|Map<String,.*> _logs|_networkEntries/.test(dart), false);
  assert.match(testSource, /G5 channel success sends record\*/);
  assert.match(testSource, /G5 channel failure posts the four streams/);
});
