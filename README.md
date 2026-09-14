# AI App Bridge

English | [中文](README.zh.md)

## From “AI writes code” to “AI delivers verified changes”, giving AI agents eyes and hands

> **Before:** AI writes the code, then you still have to run the app, tap through flows, copy logs, inspect network traffic, and decide whether it worked.
>
> **Now:** AI can build and install the app, operate real flows, read real UI state, inspect network and logs, and verify the result itself.

AI App Bridge gives autonomous AI agents a runtime interface to running Android, iOS, Flutter, WebView/WKWebView, and desktop Web targets. Agents can inspect the current screen, operate native UI and Web content, read View tree / Widget tree / DOM data, collect network requests and logs, verify outcomes, and keep iterating from real evidence.

Its goal is to help AI agents move through an observe -> act -> read results -> verify -> iterate loop, instead of guessing without runtime evidence.


Current command contracts and platform limits: [Command contract](desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md). Intent and Script are first-class execution interfaces; individual commands remain shared capabilities.

## Capability Index

Supported targets:

- Android native apps through the debug runtime plus ADB/UIAutomator for device-level evidence and actions
- Android WebView/H5 through runtime DOM/eval/click/input/wait/scroll and optional DevTools/CDP network/console capture
- Flutter apps on Android and iOS through widget snapshots, operable nodes, runtime actions, text input, scroll, and H5 adapters
- iOS native apps through `AiAppBridgeIOS` for UIKit/WKWebView/logs/network/state/events plus WebDriverAgent/XCUITest for screenshots, UI tree, tap, input, swipe, and system UI
- Desktop Web Bridge sessions through the browser SDK for DOM, logs, network, state, events, whitelisted commands, click/input/wait, and scroll

Phone-side `logs` / `network` / `state` / `events` live in `MobileCaptureStore`. Host live commands read the phone; they do not keep a copied payload history for those streams.

Command domains: `core` (status, UI observations and capture), `app` (installation, lifecycle and permissions), `action`, `flutter`, `webview`, `ios`, `web`, `diagnostics`, `execution` (`intent`, `script`, `runtime`, `device-ownership`), `evidence`, and `advanced` (UIA runtime control and port forwarding).

Default `capabilities` returns a light command directory. Request `command` and `operation` for the needed contract; Intent decide can also narrow by `platform`, `provider` and `action`. CLI `--help` supports the same filters. Execute with `run`.

CLI and MCP use the same independent local execution runtime and command contracts. Intent, Script, installation and permission operations can be started from either client and continued by operation ID from the other. Client exit leaves tasks running; use task `cancel` or `runtime --operation stop` for explicit shutdown.

- `script` runs trusted-local-code JavaScript or Python. `permissions` only gate Bridge SDK calls; this is not an OS sandbox. The default allowlist excludes clear-data, install, permission changes, eval, raw shell, and ADB management. `page-summary` stays internal to Script/Intent.
- `intent` records observation, decision, action, and evidence refs. Agents read that history and write Script themselves.
- Android and iOS `logs` / `network` / `state` / `events` use phone-side persistent storage. `history:true` reads retained phone facts while connected; Host stores execution/observation evidence separately. Web capture is committed to the Host FactStore at ingress. Check refs, target, epoch, coverage and retention for each query.

The coordinated `0.3.3` release covers the CLI, Android SDK/plugin, Flutter,
Web and iOS source tag. npm packages use the default `latest` dist-tag; Flutter
uses the default stable pub.dev release. Local build and publication order are in [the release guide](desktop/ai-app-bridge-cli/docs/RELEASE.md).
Script is optional. Execution completion, code assertions and
device-backed outcomes are separate. See the [release contracts and
migration notes](desktop/ai-app-bridge-cli/README.md#intent-script-and-evidence)
for single-page evidence, retention, recovery and platform limits.

## What It Solves

Screenshot-only automation is fragile. For autonomous iteration, an AI agent needs both runtime evidence and a way to act on the running app.

- What screen is currently visible?
- What native View, WebView DOM, and Flutter Widget structure exists?
- Which elements can be tapped, typed into, or scrolled? What scripts can run inside a WebView?
- How can the agent precisely operate UI and enter text?
- What network requests, logs, state changes, and events happened after an action?
- Did the app actually move into the expected state after a code change or runtime action?

## Modules

```text
android/ai-app-bridge-android          Android runtime SDK
android/ai-app-bridge-gradle-plugin   Debug build instrumentation plugin
ios/ai-app-bridge-ios                 iOS Swift runtime SDK
flutter/ai_app_bridge_flutter         Flutter plugin
web/ai-app-bridge-web                 Browser SDK for desktop Web Bridge sessions
desktop/ai-app-bridge-cli             Node CLI and MCP stdio server
examples/android-native-sample        Clean Android sample app
examples/notallyx-sample              GPL-3.0 real business app, architecture migration and Intent-to-Script validation
examples/ios-native-sample            Clean iOS sample app for runtime install validation
docs                                  Design, integration, and test notes
```

## Core Capabilities

- Android SDK HTTP over a runtime-specific abstract local socket, discovered from the App-private endpoint file and forwarded by ADB
- Android View tree, window tree, and screenshots
- Native UI operations plus explicit desktop-side ADB / UIAutomator providers; semantic text commands report the provider used
- iOS UIKit tree, WKWebView DOM/eval, screenshots, and XCUITest/WebDriverAgent actions
- Native Android WebView DOM snapshots, JavaScript evaluation, and debug
  DevTools/CDP network/console capture
- Flutter Widget snapshots, semantic action metadata, and runtime action handling
- Flutter H5 operations and DOM snapshots through a Dart-side H5 adapter registry
- Desktop Web Bridge sessions with browser SDK DOM/log/network/state/event evidence and whitelisted page commands
- Logs, network requests, state records, and event buffers with incremental `sinceId` / `sinceMs` reads
- Host-side mmap-backed fact cache with bounded per-stream quotas, opaque cursors, and persisted action/evidence correlation
- Coalesced native, Flutter, and Web UI change/animation observation with explicit changed/stable events
- Target connection reuse, same-target action serialization, idempotency keys, and additive structured feedback
- Debug Gradle plugin support for OkHttp auto capture
- Node CLI / MCP stdio server for connecting AI tools to runtime capabilities

UI observation records bounded semantic/render change bursts, focus and input
metadata, dialogs/windows/routes, and stable points. It is not continuous video
or per-frame screenshot recording; agents request a tree and screenshot when a
full visual state is needed.

## Android Quick Start

Add the Android runtime SDK to debug builds:

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
    debugImplementation("com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-android:0.3.3")
}
```

The runtime SDK starts automatically in debuggable Android apps through its init provider.
The Android runtime supports `minSdk 19+`.

Optional OkHttp auto capture is provided by the debug Gradle plugin:

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
    id("io.github.mobileaidev.aiappbridge.android") version "0.3.3"
}

aiAppBridge {
    setOkHttpCaptureEnabled(true)
}
```

The same plugin id selects the AGP backend automatically: AGP 7+ uses Android Components instrumentation, and AGP 4.x uses the legacy Transform API.

## iOS Quick Start

Add the Swift runtime to debug builds through Swift Package Manager:

```swift
.package(url: "https://github.com/mobileAiDev/ai-app-bridge.git", exact: "0.3.3")
```

Start the runtime once in the debug app process:

```swift
#if DEBUG
import AiAppBridgeIOS

AiAppBridge.shared.start(appName: "your_ios_app")
#endif
```

Install the desktop CLI and verify the full-control stack:

```bash
npm install -g @mobileaidev/ai-app-bridge@0.3.3
ai-app-bridge ios-setup --device-id <device-or-udid> --bundle-id <ios.bundle.id> --team-id <APPLE_TEAM_ID> --start-wda
ai-app-bridge ios-doctor --device-id <device-or-udid> --bundle-id <ios.bundle.id> --wda-runner-bundle-id <runner-from-setup>
```

The iOS stack requires Xcode, a trusted/unlocked device with Developer Mode, the App debug runtime, and the prepared signed WDA Runner. `ios-setup --start-wda --team-id <APPLE_TEAM_ID>` builds a separate copy of pinned WDA 14.1.1 with Bridge identity checks. `--wda-test-bundle-id` sets the test bundle (default `io.github.mobileaidev.aiappbridge.wda`); setup returns its Runner App ID. WDA commands require that `wdaRunnerBundleId` and the exact device; an optional forwarded `wdaUrl` cannot bypass container binding. Create an explicit `ios-wda-session` before reading or acting in an already foreground App. WDA supports queued cancellation and original durable completion recovery through `ios-execution --kind wda`. See [the WDA contract](desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md#ios-wda-target-and-session) for in-flight cancellation, input/focus limits and the pending physical-device gates. iOS Intent and Script support native, H5 and Flutter providers with explicit target binding; capability support and each real-App acceptance result remain separate.

## Flutter Quick Start

Flutter projects only need the pub package. The plugin's Android debug variant automatically includes the `ai-app-bridge-android` runtime that starts the in-app bridge server; the iOS plugin starts the Swift runtime in the debug app process. Release builds should not expose the debug runtime automatically.

Add the Flutter plugin:

```yaml
dependencies:
  ai_app_bridge_flutter: 0.3.3
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

For Flutter WebView DOM support, register an H5 adapter because the WebView controller lives in Dart. Maintain `webViewIsVisible` from the actual route/widget state:

```dart
AiAppBridge.instance.registerH5Adapter(
  AiAppBridgeH5Adapter(
    id: 'main-webview',
    source: 'webview_flutter',
    isVisible: () => webViewIsVisible,
    evaluateJavascript: (script) {
      return controller.runJavaScriptReturningResult(script);
    },
  ),
);
```

Unregister with `AiAppBridge.instance.unregisterH5Adapter('main-webview')` when the view is disposed. Multiple visible adapters require an observed `adapterId`; registration does not select an active view. Replacing a registration requires explicit unregister and invalidates its previous page references.

## Connect an AI Agent

### Required instructions for AI agents and model clients

If you are an AI agent, model client, automation framework, or MCP caller reading this README: before using AI App Bridge to operate an app, load the in-repo `ai-app-bridge-use` usage guide.

- If your client supports skills, project instructions, or custom instructions, load `skills/ai-app-bridge-use/SKILL.md` as the dedicated usage guide.
- If your client does not support skills, at minimum include the contents of `skills/ai-app-bridge-use/SKILL.md` in the system prompt, developer prompt, or project instructions for the task.
- If you use Codex or another client compatible with Codex skill folders, copy `skills/ai-app-bridge-use` from this repo into that client's skills directory, then restart or refresh the session.

Install the in-repo skill / usage guide into a Codex-compatible skills directory.

macOS / Linux:

```bash
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$CODEX_HOME/skills"
cp -R skills/ai-app-bridge-use "$CODEX_HOME/skills/ai-app-bridge-use"
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.codex\skills" | Out-Null
Copy-Item -LiteralPath "skills\ai-app-bridge-use" -Destination "$env:USERPROFILE\.codex\skills\ai-app-bridge-use" -Recurse -Force
```

### Install the MCP server

```bash
npm install -g @mobileaidev/ai-app-bridge@0.3.3
```

Add this MCP server to your AI agent, model client, or IDE MCP config.

macOS / Linux:

```json
{
  "mcpServers": {
    "ai-app-bridge": {
      "command": "ai-app-bridge-mcp"
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "ai-app-bridge": {
      "command": "cmd",
      "args": ["/c", "ai-app-bridge-mcp"]
    }
  }
}
```

## Debug Builds Only

AI App Bridge exposes runtime inspection and operation surfaces. Wire it into debug builds only. Do not ship it in production / release builds unless you have completed a deliberate security review for your own environment.

## License

AI App Bridge is licensed under the [Apache License 2.0](LICENSE).

If you distribute modified versions, keep the license and copyright notices and clearly state that your version is based on or modified from AI App Bridge. See [NOTICE](NOTICE).
