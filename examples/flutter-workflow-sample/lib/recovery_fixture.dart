import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';

/// Test-only durable oracle, independent of Bridge action receipts.
class RecoveryJournal {
  RecoveryJournal(this.file, this.faultPoint) {
    if (file.existsSync()) {
      final rows = file.readAsLinesSync().map(jsonDecode).toList();
      count = rows.last['count'] as int;
      deliveries = rows.last['deliveries'] as int;
    }
  }

  final File file;
  final String faultPoint;
  int count = 0, deliveries = 0;

  void record(String phase, String action) => file.writeAsStringSync(
    '${jsonEncode({'phase': phase, 'action': action, 'faultPoint': faultPoint, 'count': count, 'deliveries': deliveries, 'pid': pid, 'atMs': DateTime.now().millisecondsSinceEpoch})}\n',
    mode: FileMode.append,
    flush: true,
  );

  void enter() {
    deliveries++;
    record('entered', 'original');
  }

  void apply() {
    count++;
    record('applied', 'original');
  }

  void continueExplicitly() {
    deliveries++;
    count++;
    record('applied', 'new-explicit');
  }
}

/// A synchronous App callback keeps the real Flutter executor admitted until
/// the device-side fault worker kills this process. It is never an SDK hook.
class FlutterRecoveryFixture extends StatefulWidget {
  const FlutterRecoveryFixture({
    required this.directory,
    required this.runId,
    required this.faultPoint,
    super.key,
  });

  final String directory, runId, faultPoint;

  @override
  State<FlutterRecoveryFixture> createState() => _FlutterRecoveryFixtureState();
}

class _FlutterRecoveryFixtureState extends State<FlutterRecoveryFixture> {
  late final journal = RecoveryJournal(
    File('${widget.directory}/flutter-recovery-${widget.runId}.jsonl'),
    widget.faultPoint,
  );

  @override
  void initState() {
    super.initState();
    journal.record('ready', 'none');
  }

  void originalAction() {
    journal.enter();
    if (widget.faultPoint == 'after-effect') journal.apply();
    sleep(const Duration(seconds: 8));
    if (widget.faultPoint == 'before-effect') journal.apply();
    journal.record('returned', 'original');
    setState(() {});
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Flutter 进程恢复实验')),
    body: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Fault point: ${widget.faultPoint}'),
          Text('Effect count: ${journal.count}'),
          Text('Deliveries: ${journal.deliveries}'),
          Text('Process: $pid'),
          const Text('原回调阻塞 8 秒，测试工作台在指定提交点终止此应用进程。'),
          FilledButton(onPressed: originalAction, child: const Text('执行原始动作')),
          FilledButton(
            onPressed: () => setState(journal.continueExplicitly),
            child: const Text('执行新的明确动作'),
          ),
        ],
      ),
    ),
  );
}
