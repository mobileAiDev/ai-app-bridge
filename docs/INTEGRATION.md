# Integration

## Supported Targets And MCP Domains

AI App Bridge supports Android native apps, Android WebView/H5/CDP, Flutter
apps on Android and iOS, iOS native apps via `AiAppBridgeIOS` plus
WebDriverAgent/XCUITest, WKWebView, and desktop Web Bridge sessions.

The MCP server defaults to a compact surface with two tools:

- `capabilities` lists supported targets, domains, commands, and optional arguments.
- `run` executes a command from the capability index.

Command domains are `core`, `app`, `action`, `flutter`, `webview`, `ios`,
`web`, `diagnostics`, and `advanced`. Use `packageName` or explicit `port` for
Android app commands, `bundleId` plus `deviceId` when needed for iOS commands,
and `sessionId` plus optional `targetId` for Web Bridge commands.

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

## iOS

Add the Swift runtime to debug builds through Swift Package Manager:

```swift
.package(url: "https://github.com/mobileAiDev/ai-app-bridge.git", from: "0.2.11")
```

Start the runtime once from app startup code:

```swift
#if DEBUG
import AiAppBridgeIOS

AiAppBridge.shared.start(appName: "your_ios_app")
#endif
```

The runtime exposes app-level evidence over HTTP from the first available port starting at `18080`:

- `/v1/status`
- `/v1/view/tree`
- `/v1/screenshot`
- `/v1/logs`, `/v1/network`, `/v1/state`, `/v1/events`
- `/v1/h5/dom`, `/v1/h5/eval`
- `/v1/flutter/snapshot`, `/v1/flutter/action`

Full iOS control also requires XCUITest/WebDriverAgent. The app runtime provides structured evidence from inside the app; WDA provides system-level actions and external UI tree access, including taps, text input, swipes, screenshots, permission dialogs, and UI outside the app process.

```bash
ai-app-bridge ios-devices
ai-app-bridge ios-doctor --device-id <device-or-udid> --bundle-id <ios.bundle.id>
ai-app-bridge ios-setup --device-id <device-or-udid> --bundle-id <ios.bundle.id> --team-id <APPLE_TEAM_ID> --start-wda
ai-app-bridge ios-status --device-id <device-or-udid> --bundle-id <ios.bundle.id>
ai-app-bridge ios-tap --bundle-id <ios.bundle.id> --tap-x 120 --tap-y 360 --wda-url <wda-url-from-setup>
ai-app-bridge ios-input --bundle-id <ios.bundle.id> --accessibility-id <field-accessibility-id> --clear-first --text "hello" --wda-url <wda-url-from-setup>
```

If WDA is not already running, `ios-setup` can attempt to start the CLI-vendored
`appium-webdriveragent` project when the signing team is supplied. Use
`--wda-bundle-id` only when your Apple team needs a different unique bundle id.

```bash
ai-app-bridge ios-setup \
  --device-id <device-or-udid> \
  --bundle-id <ios.bundle.id> \
  --team-id <APPLE_TEAM_ID> \
  --wda-bundle-id io.example.unique.wda \
  --start-wda
```

The command intentionally stops with structured errors for missing Developer Mode, unavailable developer disk image services, missing signing team, or unreachable WDA. Do not treat those errors as optional if the target requires full-control iOS support.
On physical devices, the reachable WDA endpoint can be a CoreDevice tunnel URL such as `http://[fdxx::1]:8100`; reuse the URL returned by setup rather than assuming localhost.

## Flutter

Flutter projects only need the Flutter plugin dependency. The plugin's Android debug variant automatically brings in the Android runtime that starts the in-app bridge server; the iOS plugin starts the Swift runtime in the debug app process. The release variant should not expose the debug runtime automatically.

Add the Flutter plugin:

```yaml
dependencies:
  ai_app_bridge_flutter: ^0.2.4
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

## Web Bridge

Web apps use the browser SDK in debug/test browser code and the desktop MCP
provider on the agent side.

```bash
npm install --save-dev @mobileaidev/ai-app-bridge-web
npm install -g @mobileaidev/ai-app-bridge
```

Start the provider through MCP with `web-session-start`, read endpoint/token
with `web-connect-info`, then connect the page:

```js
import { createAiAppBridge } from "@mobileaidev/ai-app-bridge-web";

const bridge = createAiAppBridge({
  endpoint: "ws://127.0.0.1:18180/ai-app-bridge-web",
  token: "session-token",
  appName: "your_web_app",
  capture: { console: true, errors: true, fetch: true, xhr: true, dom: true }
});

bridge.start();
```

After the page connects, MCP commands in the `web` domain use `sessionId` and
optional `targetId` to read DOM/log/network/state/event evidence or run
whitelisted page commands.

## Desktop / MCP

```bash
npm install -g @mobileaidev/ai-app-bridge

ai-app-bridge status --package-name <android.package>
ai-app-bridge webview-pages --package-name <android.package>
ai-app-bridge webview-network --package-name <android.package> --duration-ms 3000
ai-app-bridge ios-doctor --device-id <device-or-udid> --bundle-id <ios.bundle.id>
ai-app-bridge-mcp --help
ai-app-bridge-mcp
```

The desktop tool owns ADB port forwarding, UIAutomator, devicectl, WDA HTTP
calls, screenshots, input, permission dialogs, the Web Bridge session provider,
and MCP transport.
For debuggable WebViews with WebView debugging enabled, it can also attach to
the WebView DevTools socket and collect CDP Network and console events.

## Compatibility Notes

### Android / Native
- **OkHttp Auto Capture**: The Gradle plugin is compatible with OkHttp 3.12+ and 4.x. For versions below 3.12, the response body may not be fully captured due to API differences. If using R8/ProGuard, ensure OkHttp is kept from obfuscation to maintain reflection compatibility.
- **WebView Variants**: The bridge automatically recognizes `android.webkit.WebView`, Tencent X5 (`smtt`), UCWeb, and Crosswalk (`xwalk`). For other custom WebView implementations, register a custom `WebViewAdapter`.
- **Ports and Multi-Process Apps**: The bridge starts in the main app process and tries ports from 18080 upward. Desktop tools should read the app port file through ADB instead of assuming 18080.

### Flutter
- **Flutter SDK Requirements**: The bridge plugin depends on Flutter 3.10+ (Dart 3.0+) to utilize the latest `SemanticsNode` APIs and `rootPipelineOwner`. Older Flutter versions are not supported out of the box.

### iOS
- **Xcode / Device Requirements**: Full-control iOS validation requires Xcode, a trusted/unlocked physical device, Developer Mode enabled, and developer disk image services available through `xcrun devicectl`.
- **WDA Signing**: WebDriverAgentRunner must be signed for the target device. A paid developer account is not required just to publish a Swift package, but local WDA signing still needs an Apple account/team configured in Xcode.
- **Runtime Port Discovery**: The Swift runtime writes `Documents/ai_app_bridge_port.json`. The CLI reads it through `devicectl` when possible, or accepts `--ios-host`, `--ios-port`, or `--runtime-url` explicitly.
- **Flutter iOS Publishing**: The pub package vendors the iOS Swift runtime sources inside the plugin, so Flutter consumers only add `ai_app_bridge_flutter`. Native iOS consumers use the GitHub SwiftPM package/tag directly.
