import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late List<MethodCall> calls;
  late _RecordingHttpClient httpClient;
  HttpOverrides? previousOverrides;

  setUp(() {
    calls = <MethodCall>[];
    httpClient = _RecordingHttpClient();
    previousOverrides = HttpOverrides.current;
    HttpOverrides.global = _RecordingHttpOverrides(httpClient);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('ai_app_bridge'),
      (MethodCall call) async {
        calls.add(call);
        return <String, Object?>{'ok': true};
      },
    );
    AiAppBridge.instance.initialize(
      appName: 'g5-forwarding',
      captureDebugPrint: false,
      captureFlutterErrors: false,
      captureHttpClient: false,
    );
  });

  tearDown(() {
    AiAppBridge.instance.shutdown();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('ai_app_bridge'), null);
    HttpOverrides.global = previousOverrides;
  });

  test('G5 channel success sends record* and does not HTTP fallback', () async {
    _recordAll();
    await pumpEventQueue();
    expect(_methodsOf(calls), <String>[
      'recordLog',
      'recordNetwork',
      'recordState',
      'recordEvent',
    ]);
    expect(jsonDecode(calls.first.arguments! as String)['tag'], 'g5');
    expect(
      httpClient.posts.where(_isCapturePath),
      isEmpty,
    );
  });

  test('G5 channel failure posts the four streams to 127.0.0.1:18080', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('ai_app_bridge'),
      (MethodCall call) async {
        calls.add(call);
        if (call.method.startsWith('record')) {
          throw PlatformException(code: 'debug_bridge_absent');
        }
        return <String, Object?>{'ok': true};
      },
    );
    _recordAll();
    await pumpEventQueue();
    expect(
      httpClient.posts.where(_isCapturePath).map((Uri uri) => uri.toString()).toList(),
      <String>[
        'http://127.0.0.1:18080/v1/logs',
        'http://127.0.0.1:18080/v1/network',
        'http://127.0.0.1:18080/v1/state',
        'http://127.0.0.1:18080/v1/events',
      ],
    );
  });

  test('G5 channel ok:false falls back to HTTP and swallows HTTP errors', () async {
    httpClient.hang = true;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('ai_app_bridge'),
      (MethodCall call) async {
        calls.add(call);
        if (call.method == 'recordLog') {
          return <String, Object?>{'ok': false};
        }
        return <String, Object?>{'ok': true};
      },
    );
    AiAppBridge.instance.recordLog(tag: 'g5', message: 'fallback');
    await pumpEventQueue();
    await Future<void>.delayed(const Duration(milliseconds: 700));
    expect(
      httpClient.posts.any((Uri uri) => uri.path == '/v1/logs'),
      isTrue,
    );
  });

  test('G5 Dart has no store and keeps the existing timeouts and plugin seams', () {
    final String dart = File('lib/ai_app_bridge_flutter.dart').readAsStringSync();
    final String android = File(
      'android/src/main/kotlin/io/github/mobileaidev/aiappbridge/flutter/AiAppBridgeFlutterPlugin.kt',
    ).readAsStringSync();
    final String ios = File(
      'ios/ai_app_bridge_flutter/Sources/ai_app_bridge_flutter/AiAppBridgeFlutterPlugin.swift',
    ).readAsStringSync();
    expect(RegExp(r'MobileCaptureStore|CaptureStore|BoundedMemory').hasMatch(dart), isFalse);
    expect(dart.contains('connectionTimeout = const Duration(milliseconds: 300)'), isTrue);
    expect(RegExp(r'timeout\(\s*const Duration\(milliseconds: 500\)').hasMatch(dart), isTrue);
    expect(dart.contains("unawaited(_sendCapture('recordLog', '/v1/logs'"), isTrue);
    expect(android.contains('io.github.mobileaidev.aiappbridge.android.AiAppBridge'), isTrue);
    expect(android.contains('"recordLog"'), isTrue);
    expect(android.contains('"recordNetwork"'), isTrue);
    expect(android.contains('"recordState"'), isTrue);
    expect(android.contains('"recordEvent"'), isTrue);
    expect(ios.contains('AiAppBridge.shared.recordLog'), isTrue);
    expect(ios.contains('AiAppBridge.shared.recordNetwork'), isTrue);
    expect(ios.contains('AiAppBridge.shared.recordState'), isTrue);
    expect(ios.contains('AiAppBridge.shared.recordEvent'), isTrue);
  });
}

void _recordAll() {
  AiAppBridge.instance.recordLog(tag: 'g5', message: 'hello');
  AiAppBridge.instance.recordNetwork(method: 'GET', url: 'https://example.test/login');
  AiAppBridge.instance.recordState(key: 'ready', value: true);
  AiAppBridge.instance.recordEvent(name: 'opened');
}

List<String> _methodsOf(List<MethodCall> calls) {
  return calls
      .where((MethodCall call) => call.method.startsWith('record'))
      .map((MethodCall call) => call.method)
      .toList();
}

bool _isCapturePath(Uri uri) {
  return uri.path == '/v1/logs' ||
      uri.path == '/v1/network' ||
      uri.path == '/v1/state' ||
      uri.path == '/v1/events';
}

class _RecordingHttpOverrides extends HttpOverrides {
  _RecordingHttpOverrides(this.client);

  final _RecordingHttpClient client;

  @override
  HttpClient createHttpClient(SecurityContext? context) => client;
}

class _RecordingHttpClient extends Fake implements HttpClient {
  final List<Uri> posts = <Uri>[];
  bool hang = false;
  Duration? connectionTimeout;

  @override
  Future<HttpClientRequest> postUrl(Uri url) {
    posts.add(url);
    if (hang) {
      return Completer<HttpClientRequest>().future;
    }
    return Future<HttpClientRequest>.value(_RecordingHttpRequest());
  }

  @override
  void close({bool force = false}) {}
}

class _RecordingHttpRequest extends Fake implements HttpClientRequest {
  @override
  final HttpHeaders headers = _RecordingHttpHeaders();

  @override
  void add(List<int> data) {}

  @override
  Future<HttpClientResponse> close() {
    return Future<HttpClientResponse>.value(_RecordingHttpResponse());
  }
}

class _RecordingHttpResponse extends Fake implements HttpClientResponse {
  @override
  Future<E> drain<E>([E? futureValue]) async => futureValue as E;
}

class _RecordingHttpHeaders extends Fake implements HttpHeaders {
  @override
  ContentType? contentType;
}
