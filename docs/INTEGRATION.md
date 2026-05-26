# Integration

## Android

Add the runtime SDK to debug builds:

`settings.gradle.kts`:

```kotlin
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven("https://jitpack.io")
    }
}
```

`app/build.gradle.kts`:

```kotlin
dependencies {
    debugImplementation("com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-android:0.2.8")
}
```

The runtime SDK starts automatically in debuggable apps through its init provider. Optional structured records can be emitted from app code:
The Android runtime supports `minSdk 19+`.

```kotlin
AiAppBridge.recordLog("info", "OrderPage", "loaded", """{"id":"1"}""")
AiAppBridge.recordState("order", "current", """{"status":"open"}""")
AiAppBridge.recordEvent("ui", "submit_clicked", null)
```

Optional OkHttp HTTP auto capture is owned by the debug Gradle plugin:

`settings.gradle.kts`:

```kotlin
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
        maven("https://jitpack.io")
    }
    resolutionStrategy {
        eachPlugin {
            if (requested.id.id == "io.github.mobileaidev.aiappbridge.android") {
                useModule("com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-gradle-plugin:${requested.version}")
            }
        }
    }
}
```

`app/build.gradle.kts`:

```kotlin
plugins {
    id("io.github.mobileaidev.aiappbridge.android") version "0.2.8"
}

aiAppBridge {
    setOkHttpCaptureEnabled(true)
}
```

The plugin keeps one public id and chooses the implementation internally: AGP 7+ uses Android Components instrumentation, while AGP 4.x uses the legacy Transform API.

## Flutter

Flutter projects only need the Flutter plugin dependency. The plugin's Android debug variant automatically brings in the Android runtime that starts the in-app bridge server; the release variant does not include that debug runtime automatically.

Add the Flutter plugin:

```yaml
dependencies:
  ai_app_bridge_flutter: ^0.2.3
```

Initialize once:

```dart
import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';
import 'package:flutter/widgets.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  AiAppBridge.instance.initialize(appName: 'your_app_name');
  runApp(const MyApp());
}
```

Flutter WebView DOM requires a registered H5 adapter because the WebView controller lives in Dart:

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

## Desktop / MCP

```bash
npm install -g @mobileaidev/ai-app-bridge

ai-app-bridge status --package-name <android.package>
ai-app-bridge webview-pages --package-name <android.package>
ai-app-bridge webview-network --package-name <android.package> --duration-ms 3000
ai-app-bridge-mcp
```

The desktop tool owns ADB port forwarding, UIAutomator, screenshots, input, permission dialogs, and MCP transport.
For debuggable WebViews with WebView debugging enabled, it can also attach to
the WebView DevTools socket and collect CDP Network and console events.

## Compatibility Notes

### Android / Native
- **OkHttp Auto Capture**: The Gradle plugin is compatible with OkHttp 3.12+ and 4.x. For versions below 3.12, the response body may not be fully captured due to API differences. If using R8/ProGuard, ensure OkHttp is kept from obfuscation to maintain reflection compatibility.
- **WebView Variants**: The bridge automatically recognizes `android.webkit.WebView`, Tencent X5 (`smtt`), UCWeb, and Crosswalk (`xwalk`). For other custom WebView implementations, register a custom `WebViewAdapter`.
- **Ports and Multi-Process Apps**: The bridge starts in the main app process and tries ports from 18080 upward. Desktop tools should read the app port file through ADB instead of assuming 18080.

### Flutter
- **Flutter SDK Requirements**: The bridge plugin depends on Flutter 3.10+ (Dart 3.0+) to utilize the latest `SemanticsNode` APIs and `rootPipelineOwner`. Older Flutter versions are not supported out of the box.
