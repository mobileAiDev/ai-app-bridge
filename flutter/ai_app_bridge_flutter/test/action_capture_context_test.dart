import 'support/read_snapshot.dart';
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  for (final useHttp in [false, true]) {
    testWidgets(
        'causal capture across real gestures and async work (HTTP: $useHttp)',
        (WidgetTester tester) async {
      final bridge = AiAppBridge.instance;
      final previousHttp = HttpOverrides.current;
      final transport = _CaptureHttpClient();
      if (useHttp) HttpOverrides.global = _CaptureHttpOverrides(transport);
      final captures = <Map<String, dynamic>>[];
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      const channel = MethodChannel('ai_app_bridge');
      String? runtimeEpoch;
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'updateSnapshot')
          runtimeEpoch = jsonDecode(call.arguments as String)['layout']
              ['operable']['runtimeEpoch'] as String?;
        if (call.method == 'checkAction') {
          final identity = jsonDecode(call.arguments as String) as Map;
          return jsonEncode({
            'ok': true,
            'schemaVersion': 'aab.flutter-execution/v1',
            ...identity,
            'remainingMs': 30000
          });
        }
        if (call.method.startsWith('record')) {
          captures.add({
            'methodName': call.method,
            ...jsonDecode(call.arguments as String)
          });
          return {'ok': !useHttp};
        }
        return {'ok': true};
      });
      addTearDown(() {
        bridge.shutdown();
        messenger.setMockMethodCallHandler(channel, null);
        HttpOverrides.global = previousHttp;
      });
      bridge.initialize(
          appName: 'action-context-test',
          captureDebugPrint: false,
          captureFlutterErrors: false,
          captureHttpClient: false);

      var presses = 0;
      void record(String label) {
        bridge.recordLog(tag: label, message: label);
        bridge.recordNetwork(url: 'https://example.test/$label', method: 'GET');
        bridge.recordState(key: label, value: true);
        bridge.recordEvent(name: label);
      }

      await tester.pumpWidget(MaterialApp(
          home: Scaffold(
              body: Center(
        child: GestureDetector(
            key: const Key('target'),
            behavior: HitTestBehavior.opaque,
            onTap: () {
              final label = 'press-${++presses}';
              record(label);
              if (presses == 1) {
                unawaited(Future<void>.delayed(
                    const Duration(milliseconds: 650), () => record('late-A')));
              }
            },
            child:
                const SizedBox(width: 150, height: 150, child: Text('Target'))),
      ))));
      final center = tester.getCenter(find.byKey(const Key('target')));
      Future<Map<dynamic, dynamic>> action(Map<String, Object?> request) async {
        final response = Completer<Object?>();
        if (runtimeEpoch == null) {
          runtimeEpoch = (await readBridgeSnapshot(tester))['layout']['operable']['runtimeEpoch'] as String;
        }
        final actionId = request['actionId'];
        final managed = {
          ...request,
          'execution': {
            'schemaVersion': 'aab.flutter-execution/v1',
            'actionId': actionId,
            'runtimeEpoch': runtimeEpoch,
            'timeoutMs': 30000,
          }
        };
        unawaited(messenger.handlePlatformMessage(
            'ai_app_bridge',
            channel.codec.encodeMethodCall(
                MethodCall('executeAction', jsonEncode(managed))),
            (data) => response.complete(channel.codec.decodeEnvelope(data!))));
        for (var i = 0; i < 30 && !response.isCompleted; i++) {
          await tester.pump(const Duration(milliseconds: 20));
        }
        expect(response.isCompleted, isTrue,
            reason: 'executeAction must finish via actual frames');
        return (await response.future) as Map;
      }

      runtimeEpoch = (await readBridgeSnapshot(tester))['layout']['operable']['runtimeEpoch'] as String;
      expect(runtimeEpoch, isNotNull);
      final unrelated =
          Timer(const Duration(milliseconds: 40), () => record('background'));
      addTearDown(unrelated.cancel);
      final point = <String, Object?>{
        'action': 'tapAt',
        'x': center.dx,
        'y': center.dy
      };
      expect((await action({...point, 'actionId': 'A'}))['ok'], true);
      expect((await action({...point, 'actionId': 'B'}))['ok'], true);
      await tester.pump(const Duration(milliseconds: 700));
      expect(
          captures.firstWhere((c) => c['name'] == 'press-1')['actionId'], 'A');
      expect((await action({...point}))['ok'], false);
      expect((await action({...point, 'actionId': 'C'}))['ok'], true);
      expect((await action({...point, 'actionId': 7}))['ok'], false);
      expect((await action({'action': 'unknown', 'actionId': 'failed'}))['ok'],
          false);
      record('after-failure');
      await tester.tapAt(
          center); // A normal human-like gesture has no Bridge action scope.
      await tester.pump(const Duration(milliseconds: 150));
      expect(presses, 4);

      for (final (label, id) in <(String, String?)>[
        ('press-1', 'A'),
        ('press-2', 'B'),
        ('late-A', 'A'),
        ('background', null),
        ('press-3', 'C'),
        ('press-4', null),
        ('after-failure', null),
      ]) {
        final facts = captures
            .where((c) =>
                c['tag'] == label ||
                c['key'] == label ||
                c['name'] == label ||
                c['url'] == 'https://example.test/$label')
            .toList();
        expect(facts, hasLength(4), reason: label);
        for (final fact in facts) {
          expect(fact['actionId'], id, reason: '$label ${fact['methodName']}');
          if (id == null) expect(fact.containsKey('actionId'), false);
        }
      }
      if (useHttp) {
        expect(transport.records, hasLength(captures.length));
        expect(transport.records,
            captures.map((c) => Map.of(c)..remove('methodName')).toList());
      }
      bridge.shutdown();
    });
  }
}

class _CaptureHttpOverrides extends HttpOverrides {
  _CaptureHttpOverrides(this.client);
  final HttpClient client;
  @override
  HttpClient createHttpClient(SecurityContext? context) => client;
}

class _CaptureHttpClient extends Fake implements HttpClient {
  final records = <Map<String, dynamic>>[];
  @override
  Duration? connectionTimeout;
  @override
  Future<HttpClientRequest> postUrl(Uri url) async =>
      _CaptureHttpRequest(records);
  @override
  void close({bool force = false}) {}
}

class _CaptureHttpRequest extends Fake implements HttpClientRequest {
  _CaptureHttpRequest(this.records);
  final List<Map<String, dynamic>> records;
  @override
  final HttpHeaders headers = _CaptureHttpHeaders();
  @override
  void add(List<int> data) => records.add(jsonDecode(utf8.decode(data)));
  @override
  Future<HttpClientResponse> close() async => _CaptureHttpResponse();
}

class _CaptureHttpResponse extends Fake implements HttpClientResponse {
  @override
  Future<E> drain<E>([E? futureValue]) async => futureValue as E;
}

class _CaptureHttpHeaders extends Fake implements HttpHeaders {
  @override
  ContentType? contentType;
}
