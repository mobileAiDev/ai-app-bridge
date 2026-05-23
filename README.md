# AI App Bridge

[English](README.en.md)

## 从“AI 写代码”到“AI 完成交付”，让 AI 长出眼睛和手

> **以前：** AI 写完代码，你还要自己跑、自己点、遇到问题自己抓日志、自己抓网络请求、自己判断。  
> **现在：** AI 写完代码，可以自己构建安装 App、自动操作 UI 功能路径、读取真实 UI 状态、检查网络和日志，并完成验收。

AI App Bridge 让 AI agent 可以直接接入正在运行的 Android / Flutter 应用。它能操作安卓 / flutter / H5 三端页面 ， 获取安卓 / flutter / H5 三端网络请求和运行日志 、 View tree / Widget tree / DOM，让 AI 不只看截图，也能基于真实状态自主迭代开发移动端。

它的核心目标是让 AI agent 按“观察 -> 操作 -> 读取结果 -> 验证 -> 继续迭代”的方式自主推进，而不是在缺少运行证据时猜测。

AI App Bridge is a mobile runtime bridge for autonomous AI agents. It lets agents inspect running Android and Flutter apps, operate native UI and WebViews, read view/widget/DOM trees, collect logs and network records, then follow an observe -> act -> read results -> verify -> iterate loop with real evidence.

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
flutter/ai_app_bridge_flutter         Flutter 插件
desktop/ai-app-bridge-cli             Node CLI 和 MCP stdio server
examples/android-native-sample        干净的 Android 示例应用
docs                                  设计、集成和测试文档
```

## 核心能力

- 本地 bridge 状态查询：从 `127.0.0.1:18080` 开始自动选择可用端口
- Android View tree、窗口树和截图
- 原生/H5 UI 操作，以及桌面端 ADB / UIAutomator 兜底操作
- 原生 Android WebView DOM 快照和 JavaScript 执行
- Debug WebView DevTools/CDP 网络请求和 console 捕获
- Flutter Widget 快照、语义动作信息和运行时动作处理
- Flutter H5 操作和 DOM 快照
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
    debugImplementation("com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-android:0.2.7")
}
```

Runtime SDK 会在 debuggable Android 应用中通过 init provider 自动启动。

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
    id("io.github.mobileaidev.aiappbridge.android") version "0.2.7"
}

aiAppBridge {
    setOkHttpCaptureEnabled(true)
}
```

## Flutter 快速接入

Flutter 项目只需要添加 pub 包。插件的 Android debug variant 会自动引入 `ai-app-bridge-android` runtime，用来启动设备内本地 bridge server；release variant 不会自动带入这个 debug runtime。

如果 Android 工程还没有配置 JitPack，需要在仓库配置中加入 `https://jitpack.io`。然后添加 Flutter 插件：

```yaml
dependencies:
  ai_app_bridge_flutter: ^0.2.1
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
