import 'support/read_snapshot.dart';
import 'dart:convert';

import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('idle performs no automatic snapshots; reads are fresh and leases expire', (tester) async {
    const channel = MethodChannel('ai_app_bridge');
    final calls = <MethodCall>[];
    final bridge = AiAppBridge.instance;
    final label = ValueNotifier('20');
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async { calls.add(call); return {'ok': true}; });
    addTearDown(() { bridge.shutdown(); label.dispose(); messenger.setMockMethodCallHandler(channel, null); });
    bridge.initialize(appName: 'idle-test', captureDebugPrint: false, captureFlutterErrors: false, captureHttpClient: false);
    await tester.pumpWidget(MaterialApp(home: ValueListenableBuilder<String>(
      valueListenable: label, builder: (context, value, child) => TextButton(onPressed: () {}, child: Text(value)),
    )));
    final semanticsBefore = tester.binding.semanticsEnabled;
    await tester.pump(const Duration(seconds: 10));
    expect(calls, isEmpty);
    expect(bridge.uiObservation({'operation': 'status'})['active'], false);
    var snapshot = await readBridgeSnapshot(tester);
    expect(jsonEncode(snapshot['layout']['operable']), contains('20'));
    label.value = '21';
    await tester.pump();
    snapshot = await readBridgeSnapshot(tester);
    expect(jsonEncode(snapshot['layout']['operable']), contains('21'));
    expect(tester.binding.semanticsEnabled, semanticsBefore);
    expect(calls.where((call) => call.method == 'updateSnapshot'), isEmpty);

    expect(bridge.uiObservation({'operation': 'start', 'durationMs': 5001})['ok'], false);
    final lease = bridge.uiObservation({'operation': 'start', 'durationMs': 100});
    expect(lease['active'], true);
    expect(bridge.uiObservation({'operation': 'stop', 'leaseId': 'wrong'})['ok'], false);
    expect(bridge.uiObservation({'operation': 'start', 'durationMs': 100})['error'], 'ui_observation_busy');
    await tester.pump(const Duration(milliseconds: 200));
    expect(bridge.uiObservation({'operation': 'status'})['active'], false);
    bridge.initialize(appName: 'still-off', captureDebugPrint: false, captureFlutterErrors: false, captureHttpClient: false);
    expect(bridge.uiObservation({'operation': 'status'})['active'], false);
    await tester.pump(const Duration(seconds: 10));
    expect(calls.where((call) => call.method == 'updateSnapshot'), isEmpty);
  });

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

    expect(AiAppBridge.instance.uiObservation({'operation': 'start', 'durationMs': 1000})['active'], true);
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

    expect(calls.where((call) => call.method == 'updateSnapshot'), isEmpty);
    final snapshot = jsonEncode(await readBridgeSnapshot(tester));
    expect(snapshot, isNot(contains('s3cr3t-value')));
    expect(snapshot, contains('[secure:length=12]'));
    AiAppBridge.instance.shutdown();
  });
}
