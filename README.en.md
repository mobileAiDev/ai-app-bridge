# AI App Bridge

English | [中文](README.md)

## From “AI writes code” to “AI delivers verified changes”, giving AI agents eyes and hands

> **Before:** AI writes the code, then you still have to run the app, tap through flows, copy logs, inspect network traffic, and decide whether it worked.  
> **Now:** AI can build and install the app, operate real flows, read real UI state, inspect network and logs, and verify the result itself.

AI App Bridge gives autonomous AI agents a runtime interface to running Android and Flutter apps. Agents can inspect the current screen, operate native UI and WebViews, read View tree / Widget tree / DOM data, collect network requests and logs, verify outcomes, and keep iterating from real evidence.

Its goal is to help AI agents move through an observe -> act -> read results -> verify -> iterate loop, instead of guessing without runtime evidence.

## What It Solves

Screenshot-only automation is fragile. For autonomous iteration, an AI agent needs both runtime evidence and a way to act on the running app.

- What screen is currently visible?
- What native View, WebView DOM, and Flutter Widget structure exists?
- Which elements can be tapped, typed into, or scrolled? What scripts can run inside a WebView?
- What network requests, logs, state changes, and events happened after an action?
- Did the app actually move into the expected state after a code change or runtime action?

## Modules

```text
android/ai-app-bridge-android          Android runtime SDK
android/ai-app-bridge-gradle-plugin   Debug build instrumentation plugin
flutter/ai_app_bridge_flutter         Flutter plugin
desktop/ai-app-bridge-cli             Node CLI and MCP stdio server
examples/android-native-sample        Clean Android sample app
docs                                  Design, integration, and test notes
```

## Core Capabilities

- Local bridge status on the first available port starting at `127.0.0.1:18080`
- Android View tree, window tree, and screenshots
- Native UI tap support, with desktop-side ADB / UIAutomator fallback operations
- Native Android WebView DOM snapshots, JavaScript evaluation, and debug
  DevTools/CDP network/console capture
- Flutter Widget snapshots, semantic action metadata, and runtime action handling
- Flutter H5 adapter registry for exposing Dart-side WebViews to AI agents
- Logs, network requests, state records, and event buffers with incremental `sinceId` / `sinceMs` reads
- Debug Gradle plugin support for OkHttp auto capture
- Node CLI / MCP stdio server for connecting AI tools to runtime capabilities

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
    debugImplementation("com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-android:0.2.7")
}
```

The runtime SDK starts automatically in debuggable Android apps through its init provider.

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
    id("io.github.mobileaidev.aiappbridge.android") version "0.2.7"
}

aiAppBridge {
    setOkHttpCaptureEnabled(true)
}
```

## Flutter Quick Start

Flutter projects only need the pub package. The plugin's Android debug variant automatically includes the `ai-app-bridge-android` runtime that starts the in-app bridge server; the release variant does not include this debug runtime automatically.

If the Android project does not already include JitPack, add `https://jitpack.io` to its repositories. Then add the Flutter plugin:

```yaml
dependencies:
  ai_app_bridge_flutter: ^0.2.1
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

For Flutter WebView DOM support, register an H5 adapter because the WebView controller lives in Dart:

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
npm install -g @mobileaidev/ai-app-bridge
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
