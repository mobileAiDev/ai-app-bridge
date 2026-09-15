# ai_app_bridge_test

Optional AI App Bridge executor using the application's Flutter SDK `integration_test` and `WidgetTester`. Add this package to **dev_dependencies**. It does not add a separate business App or Android Gradle project.

Requires Flutter >=3.41.0 and Dart >=3.11.0 <4.0.0. Verified with Flutter 3.41.9 on Android API 25 and Flutter 3.44.8 on API 36, including Python/JS orchestration, cancellation, navigation and orderly close.

```yaml
dev_dependencies:
  ai_app_bridge_test: 0.3.7
```

```dart
// integration_test/bridge_test.dart
import 'package:ai_app_bridge_test/ai_app_bridge_test.dart';
import 'package:your_app/main.dart' as app;
void main() => aiAppBridgeTest(app.main);
```

Build the entrypoint once:

```sh
flutter build apk --debug --target integration_test/bridge_test.dart \
  --dart-define=INTEGRATION_TEST_SHOULD_REPORT_RESULTS_TO_NATIVE=false
```

Install the debug APK, then use Bridge 0.3.7 `flutter-executor` operations `open`, `observe`, `act`, `receipt`, `close`. Python and JavaScript Script both call them through `ctx.call` with `app.test` permission. Workflows are not recompiled into the application for each run.

This Host integration currently supports the standard **Android** Flutter embedder. Opening restarts the app; closing drains the test and ends only its original process. `enterText` injects and verifies Flutter editing state; it does not test a physical IME. Platform views, H5 DOM and system dialogs need their own provider. Cancellation never starts a replacement action while the original tester Future is unresolved.

See the [complete executor contract and integration guide](https://github.com/mobileAiDev/ai-app-bridge/blob/main/desktop/ai-app-bridge-cli/docs/OPTIONAL_EXECUTORS.md) for lifecycle, dependency profiles, receipts and limitations. Local source/package validation does not imply this version is already published to pub.dev.
