import 'dart:async';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

Future<Map<String, dynamic>> readBridgeResponse(WidgetTester tester) async {
  const channel = MethodChannel('ai_app_bridge');
  final done = Completer<Map<String, dynamic>>();
  unawaited(TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.handlePlatformMessage(
    'ai_app_bridge', channel.codec.encodeMethodCall(const MethodCall('readSnapshot', '{}')),
    (data) => done.complete(Map<String, dynamic>.from(channel.codec.decodeEnvelope(data!) as Map)),
  ));
  for (var i = 0; i < 100 && !done.isCompleted; i++) {
    await tester.pump(const Duration(milliseconds: 20));
  }
  expect(done.isCompleted, isTrue, reason: 'Explicit snapshot must settle');
  return done.future;
}

Future<Map<String, dynamic>> readBridgeSnapshot(WidgetTester tester) async {
  final response = await readBridgeResponse(tester);
  expect(response['ok'], true, reason: '$response');
  return Map<String, dynamic>.from(response['snapshot'] as Map);
}
