# AI App Bridge Flutter

Flutter plugin for AI App Bridge. It exposes Flutter widget snapshots, runtime actions, structured logs, network records, state records, events, and H5 adapter registration so local AI agents can inspect, operate, verify, and iterate on Flutter apps.

## Install

Add the Flutter package. The plugin's Android debug variant automatically includes the Android runtime that starts the bridge server on the device; the release variant does not include that debug runtime automatically.

If the Android project does not already include JitPack, add `https://jitpack.io` to its repositories.

```yaml
dependencies:
  ai_app_bridge_flutter: ^0.2.1
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
