import 'support/read_snapshot.dart';
import 'dart:convert';

import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets(
      'framework license page exposes a unique usable dependency target',
      (WidgetTester tester) async {
    const MethodChannel channel = MethodChannel('ai_app_bridge');
    final List<Map<String, dynamic>> snapshots = <Map<String, dynamic>>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (MethodCall call) async {
      if (call.method == 'updateSnapshot') {
        snapshots.add(jsonDecode(call.arguments as String));
      }
      return <String, Object?>{'ok': true};
    });
    addTearDown(() {
      AiAppBridge.instance.shutdown();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    });
    LicenseRegistry.addLicense(() => Stream<LicenseEntry>.value(
          LicenseEntryWithLineBreaks(<String>['Bridge fixture dependency'],
              'Bridge fixture license terms'),
        ));
    AiAppBridge.instance.initialize(
      appName: 'framework-page-test',
      captureDebugPrint: false,
      captureFlutterErrors: false,
      captureHttpClient: false,
    );
    await tester.pumpWidget(MaterialApp(
      navigatorObservers: <NavigatorObserver>[
        AiAppBridge.instance.navigatorObserver,
      ],
      home: const LicensePage(applicationName: 'Fixture App'),
    ));
    await tester.pumpAndSettle();
    snapshots.add(await readBridgeSnapshot(tester));
    final List<dynamic> nodes = snapshots.last['layout']['operable']['nodes'];
    final List<dynamic> matches = nodes
        .where((dynamic node) =>
            node['text'] == 'Bridge fixture dependency' && node['tap'] != null)
        .toList();
    expect(matches, hasLength(1));
    final Map<dynamic, dynamic> bounds = matches.single['tap']['bounds'];
    await tester.tapAt(Offset(
      (bounds['centerX'] as num).toDouble(),
      (bounds['centerY'] as num).toDouble(),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Bridge fixture license terms'), findsOneWidget);
    snapshots.add(await readBridgeSnapshot(tester));
    final List<dynamic> detail = snapshots.last['layout']['operable']['nodes'];
    expect(
        detail.any(
            (dynamic node) => node['text'] == 'Bridge fixture license terms'),
        isTrue);
    AiAppBridge.instance.shutdown();
  });
}
