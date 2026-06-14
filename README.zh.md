# AI App Bridge

[English](README.md) | 中文

## 从“AI 写代码”到“AI 完成交付”，让 AI 长出眼睛和手

> **以前：** AI 写完代码，你还要自己跑、自己点、遇到问题自己抓日志、自己抓网络请求、自己判断。
>
> **现在：** AI 写完代码，可以自己构建安装 App、自动操作 UI 功能路径、读取真实 UI 状态、检查网络和日志，并完成验收。

AI App Bridge 让自主 AI agent 可以直接接入正在运行的 Android、iOS 和 Flutter 应用。Agent 可以读取当前屏幕，操作原生 UI、WebView / WKWebView 和 Flutter H5，读取 View tree / Widget tree / DOM，采集网络请求和日志，验证结果，并基于真实证据持续迭代。

它的核心目标是让 AI agent 按“观察 -> 操作 -> 读取结果 -> 验证 -> 继续迭代”的方式自主推进，而不是在缺少运行证据时猜测。

## 解决的问题

移动端自动化如果只依赖截图，AI 很容易在关键细节上猜错。要让 AI 自主迭代，运行时需要同时提供两类能力：看清当前应用状态，并执行下一步动作。

- 当前页面处在什么状态？
- 原生 View、WebView DOM、Flutter Widget 的真实结构是什么？
- 哪些元素可以点击、输入或滚动？WebView 中能执行哪些脚本？
- 如何精准地操作 UI 和输入内容？
- 执行动作后产生了哪些网络请求、日志、状态变化和事件？
- 修改代码或触发操作后，应用是否真的进入了预期状态？

## 模块结构

```text
android/ai-app-bridge-android          Android runtime SDK
android/ai-app-bridge-gradle-plugin   Debug 构建插桩插件
ios/ai-app-bridge-ios                 iOS Swift runtime SDK
flutter/ai_app_bridge_flutter         Flutter 插件
desktop/ai-app-bridge-cli             Node CLI 和 MCP stdio server
examples/android-native-sample        干净的 Android 示例应用
examples/ios-native-sample            用于 runtime 安装验证的干净 iOS 示例应用
docs                                  设计、集成和测试文档
```

## 核心能力

- 本地 bridge 状态查询：从 `127.0.0.1:18080` 开始自动选择可用端口
- Android View tree、窗口树和截图
- 原生 UI 操作，以及桌面端 ADB / UIAutomator 兜底操作
- iOS UIKit tree、WKWebView DOM/eval、截图，以及 XCUITest/WebDriverAgent 操作
- 原生 Android WebView DOM 快照和 JavaScript 执行
- Debug WebView DevTools/CDP 网络请求和 console 捕获
- Flutter Widget 快照、语义动作信息和运行时动作处理
- Flutter H5 操作和 DOM 快照，通过 Dart 层 H5 adapter 暴露
- 日志、网络请求、状态和事件缓冲区，支持 `sinceId` / `sinceMs` 增量读取
- Debug Gradle 插件支持 OkHttp HTTP 自动捕获
- Node CLI / MCP stdio server，方便 AI 工具接入运行时能力

## Android 快速接入

在目标 App 的 debug 构建里引入 Android runtime SDK：

`settings.gradle.kts`：

```kotlin
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven("https://jitpack.io")
    }
}
```

`app/build.gradle.kts`：

```kotlin
dependencies {
    debugImplementation("com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-android:0.2.8")
}
```

Runtime SDK 会在 debuggable Android 应用中通过 init provider 自动启动。
Android runtime 支持 `minSdk 19+`。

可选的 OkHttp 自动捕获由 debug Gradle 插件提供：

`settings.gradle.kts`：

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

`app/build.gradle.kts`：

```kotlin
plugins {
    id("io.github.mobileaidev.aiappbridge.android") version "0.2.8"
}

aiAppBridge {
    setOkHttpCaptureEnabled(true)
}
```

同一个插件会自动选择 AGP backend：AGP 7+ 使用新版 Android Components instrumentation，AGP 4.x 使用 legacy Transform API。

## iOS 快速接入

在 debug 构建里通过 Swift Package Manager 引入 Swift runtime：

```swift
.package(url: "https://github.com/mobileAiDev/ai-app-bridge.git", from: "0.2.11")
```

在 debug app 进程启动一次 runtime：

```swift
#if DEBUG
import AiAppBridgeIOS

AiAppBridge.shared.start(appName: "your_ios_app")
#endif
```

安装桌面 CLI，并检查完整 iOS 控制栈：

```bash
npm install -g @mobileaidev/ai-app-bridge
ai-app-bridge ios-doctor --device-id <device-or-udid> --bundle-id <ios.bundle.id>
ai-app-bridge ios-setup --device-id <device-or-udid> --bundle-id <ios.bundle.id> --team-id <APPLE_TEAM_ID> --start-wda
```

iOS 完整控制需要 Xcode、已信任且解锁的真机、已开启 Developer Mode、App 内 debug runtime，以及已签名并可访问的 WebDriverAgent/XCUITest。CLI 内置 `appium-webdriveragent`，可通过 `ios-setup --start-wda --team-id <APPLE_TEAM_ID>` 自动启动，并默认使用唯一的 WDA bundle id；需要时可用 `--wda-bundle-id` 覆盖。真机上后续命令应复用 setup 返回的 WDA URL，它可能是 CoreDevice tunnel，例如 `http://[fdxx::1]:8100`，不一定是 `127.0.0.1`。

## Flutter 快速接入

Flutter 项目只需要添加 pub 包。插件的 Android debug variant 会自动引入 `ai-app-bridge-android` runtime，用来启动设备内本地 bridge server；iOS plugin 会在 debug app 进程中启动 Swift runtime。release 构建不应自动暴露 debug runtime。

添加 Flutter 插件：

```yaml
dependencies:
  ai_app_bridge_flutter: ^0.2.4
```

初始化一次：

```dart
import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';
import 'package:flutter/widgets.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  AiAppBridge.instance.initialize(appName: 'your_app_name');
  runApp(const MyApp());
}
```

Flutter WebView DOM 支持需要注册 H5 adapter，因为 WebView controller 在 Dart 层：

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

## 连接 AI Agent

### 给 AI agent / 模型客户端的强制使用说明

如果你是正在阅读本 README 的 AI agent、模型客户端、自动化框架或 MCP 调用方：在使用 AI App Bridge 操作 app 前，必须加载本仓库的 `ai-app-bridge-use` 使用规范。

- 如果你的客户端支持 skill / project instructions / custom instructions，把 `skills/ai-app-bridge-use/SKILL.md` 作为专用规范加载。
- 如果你的客户端不支持 skill，至少把 `skills/ai-app-bridge-use/SKILL.md` 的内容加入本次任务的系统提示、开发者提示或项目说明。
- 如果你使用 Codex 或兼容 Codex skill 目录的客户端，可以把本仓库的 `skills/ai-app-bridge-use` 复制到该客户端的 skills 目录，然后重启或刷新会话。

安装本仓库内置 skill / 使用规范到 Codex 兼容目录。

macOS / Linux：

```bash
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$CODEX_HOME/skills"
cp -R skills/ai-app-bridge-use "$CODEX_HOME/skills/ai-app-bridge-use"
```

Windows PowerShell：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.codex\skills" | Out-Null
Copy-Item -LiteralPath "skills\ai-app-bridge-use" -Destination "$env:USERPROFILE\.codex\skills\ai-app-bridge-use" -Recurse -Force
```

### 安装 MCP server

```bash
npm install -g @mobileaidev/ai-app-bridge
```

在你的 AI agent / 模型客户端 / IDE 的 MCP 配置里添加。

macOS / Linux：

```json
{
  "mcpServers": {
    "ai-app-bridge": {
      "command": "ai-app-bridge-mcp"
    }
  }
}
```

Windows：

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

## 仅限 debug 构建

AI App Bridge 会暴露运行时检查和操作能力，建议只在 debug 构建接入。除非已经完成针对自身环境的安全评审，否则不要把它打进 production / release 包。

## 开源协议

AI App Bridge 使用 [Apache License 2.0](LICENSE) 开源。

如果你分发修改后的版本，请保留许可证和版权声明，并明确说明你的版本基于或修改自 AI App Bridge。详见 [NOTICE](NOTICE)。
