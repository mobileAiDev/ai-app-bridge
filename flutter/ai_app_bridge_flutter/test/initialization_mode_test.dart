import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/read_snapshot.dart';

void main() {
  testWidgets('debug initialization retains diagnostics and bound targets',
      (tester) async {
    final bridge = AiAppBridge.instance;
    addTearDown(bridge.shutdown);
    bridge.initialize(
      appName: 'mode-contract',
      captureDebugPrint: false,
      captureFlutterErrors: false,
      captureHttpClient: false,
    );
    await tester.pumpWidget(MaterialApp(
      home: TextButton(onPressed: () {}, child: const Text('Observed action')),
    ));

    final full = await readBridgeSnapshot(tester);
    expect(full['app']['mode'], 'debug');
    expect(full['layout']['buildMode'], 'debug');
    expect(full['layout']['widgetDump']['ok'], true);
    expect(full['layout']['widgetDump']['length'], greaterThan(0));
    expect(full['layout']['widgetInspector']['ok'], true);
    expect(full['layout']['operable']['ok'], true);
    final epoch = full['layout']['operable']['runtimeEpoch'];

    // Reinitialization must not change live target identity or enable UI scans.
    bridge.initialize(
      appName: 'mode-contract-reinitialized',
      captureDebugPrint: false,
      captureFlutterErrors: false,
      captureHttpClient: false,
    );
    final response = await readBridgeResponse(tester, scope: 'operable');
    final snapshot = response['snapshot'];
    expect(snapshot['app']['mode'], 'debug');
    expect(snapshot['layout'].keys, ['operable']);
    expect(snapshot['layout']['operable']['runtimeEpoch'], epoch);
    expect(snapshot['layout']['operable']['buildMode'], 'debug');
    expect(snapshot['uiObservation']['active'], false);
  });
}
