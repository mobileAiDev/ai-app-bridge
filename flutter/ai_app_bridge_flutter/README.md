# AI App Bridge Flutter

Flutter plugin for AI App Bridge. It exposes Flutter widget snapshots, runtime actions, structured logs, network records, state records, events, and H5 adapter registration so local AI agents can inspect, operate, verify, and iterate on Flutter apps on Android and iOS.

## Install

Add the Flutter package. The plugin's Android debug variant automatically includes the Android runtime that starts the bridge server on the device. The iOS plugin starts the Swift runtime from the app process. Release builds should not expose the debug runtime automatically.

```yaml
dependencies:
  ai_app_bridge_flutter: ^0.2.4
```

## Initialize

```dart
import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';
import 'package:flutter/widgets.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  AiAppBridge.instance.initialize(appName: 'your_app_name');
  runApp(const MyApp());
}
```

## WebView Adapter

Flutter WebView DOM support requires a registered H5 adapter because the WebView controller lives in Dart:

```dart
AiAppBridge.instance.registerH5Adapter(
  AiAppBridgeH5Adapter(
    id: 'main-webview',
    source: 'webview_flutter',
    evaluateJavascript: (script) {
      return controller.runJavaScriptReturningResult(script);
    },
  ),
);
```

AI App Bridge is intended for debug builds. Do not expose runtime control surfaces in production builds without a deliberate security review.

## iOS Notes

Flutter iOS support uses two layers:

- The Flutter plugin publishes widget/action snapshots to `AiAppBridgeIOS`.
- The desktop CLI/MCP uses WebDriverAgent/XCUITest for full-control device actions such as tap, input, swipe, permission dialogs, screenshots, and external UI tree reads.

The published Flutter package contains the iOS Swift runtime sources used by the plugin, so Flutter apps only need the pub dependency. Native iOS apps can use the separate SwiftPM package from the GitHub repository.
