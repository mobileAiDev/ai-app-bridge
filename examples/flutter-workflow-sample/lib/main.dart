import 'package:flutter/material.dart';
import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';
import 'workflow_lab.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  AiAppBridge.instance.initialize(
    appName: 'Bridge Workflow Lab',
    captureDebugPrint: true,
    captureFlutterErrors: true,
    captureHttpClient: true,
  );
  runApp(const WorkflowLab());
}
