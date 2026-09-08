import 'dart:convert';

import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('observed navigation labels tap their own destinations',
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
    AiAppBridge.instance.initialize(
      appName: 'navigation-targets-test',
      captureDebugPrint: false,
      captureFlutterErrors: false,
      captureHttpClient: false,
    );

    var selected = 0;
    await tester.pumpWidget(MaterialApp(
      home: StatefulBuilder(
          builder: (BuildContext context, StateSetter setState) {
        return Scaffold(
          body: Text('Page $selected'),
          bottomNavigationBar: NavigationBar(
            selectedIndex: selected,
            onDestinationSelected: (int index) =>
                setState(() => selected = index),
            destinations: const <Widget>[
              NavigationDestination(
                  icon: Icon(Icons.download), label: 'Receive'),
              NavigationDestination(icon: Icon(Icons.send), label: 'Send'),
              NavigationDestination(
                  icon: Icon(Icons.settings), label: 'Settings'),
            ],
          ),
        );
      }),
    ));
    await tester.pump(const Duration(milliseconds: 150));

    for (final (String, int) destination in <(String, int)>[
      ('Settings', 2),
      ('Receive', 0),
      ('Send', 1),
    ]) {
      final List<dynamic> nodes = snapshots.last['layout']['operable']['nodes'];
      final List<dynamic> matches = nodes
          .where((dynamic node) =>
              node['text'] == destination.$1 && node['tap'] != null)
          .toList();
      expect(matches, hasLength(1),
          reason: 'ambiguous or missing ${destination.$1}');
      final Map<dynamic, dynamic> bounds = matches.single['tap']['bounds'];
      await tester.tapAt(Offset(
        (bounds['centerX'] as num).toDouble(),
        (bounds['centerY'] as num).toDouble(),
      ));
      await tester.pump(const Duration(milliseconds: 350));
      expect(selected, destination.$2);
      expect(find.text('Page ${destination.$2}'), findsOneWidget);
    }
    AiAppBridge.instance.shutdown();
  });
}
