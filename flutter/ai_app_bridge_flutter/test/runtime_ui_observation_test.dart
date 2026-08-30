import 'dart:convert';

import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('records route and pointer UI events',
      (WidgetTester tester) async {
    const MethodChannel channel = MethodChannel('ai_app_bridge');
    final List<MethodCall> calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (MethodCall call) async {
      calls.add(call);
      return <String, Object?>{'ok': true};
    });
    addTearDown(() {
      AiAppBridge.instance.shutdown();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    });

    AiAppBridge.instance.initialize(
      appName: 'ui-observation-test',
      captureDebugPrint: false,
      captureFlutterErrors: false,
      captureHttpClient: false,
    );
    await tester.pumpWidget(
      MaterialApp(
        navigatorObservers: <NavigatorObserver>[
          AiAppBridge.instance.navigatorObserver,
        ],
        home: Builder(
          builder: (BuildContext context) => Scaffold(
            body: TextButton(
              onPressed: () => Navigator.of(context).push<void>(
                MaterialPageRoute<void>(
                  settings: const RouteSettings(name: '/details'),
                  builder: (_) => const Scaffold(body: Text('Details')),
                ),
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 120));

    final List<Map<String, Object?>> events = calls
        .where((MethodCall call) => call.method == 'recordEvent')
        .map((MethodCall call) => (jsonDecode(call.arguments! as String) as Map)
            .cast<String, Object?>())
        .toList();
    expect(
      events.any((Map<String, Object?> event) =>
          event['name'] == 'ui.route.changed' &&
          (event['data'] as Map)['location'] == '/details' &&
          (event['data'] as Map)['semanticChanged'] == true &&
          (event['data'] as Map)['renderChanged'] == false),
      isTrue,
    );
    expect(
      events.any((Map<String, Object?> event) =>
          event['name'] == 'pointer.tap' &&
          (event['data'] as Map)['interactionObserved'] == true),
      isTrue,
    );
    AiAppBridge.instance.shutdown();
  });

  testWidgets('does not publish secure EditableText contents in snapshots',
      (WidgetTester tester) async {
    const MethodChannel channel = MethodChannel('ai_app_bridge');
    final List<MethodCall> calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (MethodCall call) async {
      calls.add(call);
      return <String, Object?>{'ok': true};
    });
    final TextEditingController controller =
        TextEditingController(text: 's3cr3t-value');
    addTearDown(() {
      controller.dispose();
      AiAppBridge.instance.shutdown();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    });

    AiAppBridge.instance.initialize(
      appName: 'secure-input-test',
      captureDebugPrint: false,
      captureFlutterErrors: false,
      captureHttpClient: false,
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TextField(controller: controller, obscureText: true),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 150));

    final List<String> snapshots = calls
        .where((MethodCall call) => call.method == 'updateSnapshot')
        .map((MethodCall call) => call.arguments! as String)
        .toList();
    expect(snapshots, isNotEmpty);
    expect(snapshots.join(), isNot(contains('s3cr3t-value')));
    expect(snapshots.join(), contains('[secure:length=12]'));
    AiAppBridge.instance.shutdown();
  });
}
