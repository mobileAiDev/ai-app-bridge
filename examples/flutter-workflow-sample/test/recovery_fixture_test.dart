import 'dart:convert';
import 'dart:io';

import 'package:bridge_workflow_lab/recovery_fixture.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  for (final committed in [false, true]) {
    testWidgets(
      'restart preserves ${committed ? "committed" : "uncommitted"} effect without replay',
      (tester) async {
        final directory = Directory.systemTemp.createTempSync(
          'flutter-recovery-',
        );
        addTearDown(() => directory.deleteSync(recursive: true));
        final file = File('${directory.path}/flutter-recovery-test-run.jsonl');
        final point = committed ? 'after-effect' : 'before-effect';
        final oldProcess = RecoveryJournal(file, point);
        oldProcess.record('ready', 'none');
        oldProcess.enter();
        if (committed) oldProcess.apply();

        await tester.pumpWidget(
          MaterialApp(
            home: FlutterRecoveryFixture(
              directory: directory.path,
              runId: 'test-run',
              faultPoint: point,
            ),
          ),
        );
        expect(find.text('Effect count: ${committed ? 1 : 0}'), findsOneWidget);
        expect(find.text('Deliveries: 1'), findsOneWidget);
        await tester.tap(find.text('执行新的明确动作'));
        await tester.pump();
        expect(find.text('Effect count: ${committed ? 2 : 1}'), findsOneWidget);
        final rows = file.readAsLinesSync().map(jsonDecode).toList();
        expect(rows.where((row) => row['phase'] == 'entered').length, 1);
        expect(rows.last['action'], 'new-explicit');
        expect(rows.last['deliveries'], 2);
      },
    );
  }
}
