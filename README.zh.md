# AI App Bridge

[English](README.md) | 中文

## 从“AI 写代码”到“AI 完成交付”，让 AI 长出眼睛和手

> **以前：** AI 写完代码，你还要自己跑、自己点、遇到问题自己抓日志、自己抓网络请求、自己判断。
>
> **现在：** AI 写完代码，可以自己构建安装 App、自动操作 UI 功能路径、读取真实 UI 状态、检查网络和日志，并完成验收。

AI App Bridge 让自主 AI agent 可以直接接入正在运行的 Android、iOS、Flutter、WebView / WKWebView 和桌面 Web 目标。Agent 可以读取当前屏幕，操作原生 UI 和 Web 内容，读取 View tree / Widget tree / DOM，采集网络请求和日志，验证结果，并基于真实证据持续迭代。

它的核心目标是让 AI agent 按“观察 -> 操作 -> 读取结果 -> 验证 -> 继续迭代”的方式自主推进，而不是在缺少运行证据时猜测。

## 能力索引

支持目标：

- Android native app：debug runtime 提供应用内证据，ADB/UIAutomator 提供设备级截图、tree 和动作
- Android WebView/H5：runtime DOM/eval/click/input/wait/scroll，以及可选 DevTools/CDP 网络和 console 捕获
- Flutter Android/iOS：widget 快照、可操作节点、runtime action、文本输入、滚动和 H5 adapter
- iOS native app：`AiAppBridgeIOS` 提供 UIKit/WKWebView/logs/network/state/events，WebDriverAgent/XCUITest 提供截图、UI tree、tap、input、swipe 和系统 UI
- 桌面 Web Bridge session：浏览器 SDK 提供 DOM、logs、network、state、events、白名单 command、click/input/wait 和 scroll

手机侧 `logs` / `network` / `state` / `events` 只存在 `MobileCaptureStore` 中。Host 连接态命令直读手机，不保存这些 payload 的复制历史。

MCP 命令域：`core`（`status`、`tree`、`uia-tree`、`screenshot`、`logs`、`network`、`state`、`events`）、`app`（安装、清数据、启动、freeze/thaw、权限、appops）、`action`（tap、input、swipe、keyevent、wait、keyboard）、`flutter`、`webview`、`ios`、`web`、`diagnostics`、`advanced`（`batch`、端口转发）。

默认 MCP surface 是 compact：先调用 `capabilities` 发现 domain、command 和 options，再调用 `run` 执行选定命令。

隔离的 MCP 命令 `script` 和 `intent` 在 `advanced` 域。它们是通用运行时，不是 explore / export-to-script / assemble-report 这类产品工作流命令。

- `script` 运行 trusted-local-code 的 JavaScript 或 Python。`permissions` 只门闩 Bridge SDK 调用，不是 OS 沙箱。默认 allowlist 不含清数据、安装、权限变更、eval、raw shell 或 ADB 管理。`page-summary` 只留在 Script/Intent 内部。
- `intent` 记录 observation、decision、action 和证据引用。Agent 自行读取历史并编写 Script。
- 手机 `logs` / `network` / `state` / `events` 由 `MobileCaptureStore` 管理。更新后的 Android runtime 在连接状态下支持 MCP `history:true` 持久查询；Host 不保存手机 payload 的复制历史。当前 iOS 强查询明确返回 `persistence_unavailable`，原有 Legacy 读取仍可使用。

当前工作区准备的是本地 CLI `0.3.0-rc.1`，尚未发布到 npm。Script 为可选能力；
执行结束、纯代码断言和有设备证据的结果分别统计。当前设备强断言仅支持完整单页，
多页查询可以取数，但尚不支持合并为一个完整窗口断言。恢复仅适用于显式可重入
checkpoint 模板，不确定副作用不会自动重放。参见 [候选版本合同与迁移说明](desktop/ai-app-bridge-cli/README.md#optional-script-and-evidence-contracts-in-this-candidate)。

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
web/ai-app-bridge-web                 桌面 Web Bridge session 的浏览器 SDK
desktop/ai-app-bridge-cli             Node CLI 和 MCP stdio server
examples/android-native-sample        干净的 Android 示例应用
examples/notallyx-sample              GPL-3.0 真实业务 App、架构迁移与 Intent 到 Script 验证
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
- 桌面 Web Bridge session，通过浏览器 SDK 暴露 DOM/log/network/state/event 证据和白名单页面命令
- 日志、网络请求、状态和事件缓冲区，支持 `sinceId` / `sinceMs` 增量读取
- Host 侧 mmap + SQLite WAL 事实缓存，按数据流限额、持久化 action/证据关联并支持不透明游标
- 原生、Flutter 和 Web 的 UI 变化/动画批次观察，记录 changed/stable 事件
- 目标连接复用、同目标动作串行、幂等 request id 和加法式结构化反馈
- Debug Gradle 插件支持 OkHttp HTTP 自动捕获
- Node CLI / MCP stdio server，方便 AI 工具接入运行时能力

UI 观察会有界记录语义/渲染变化批次、焦点和输入元数据、对话框/窗口/路由以及稳定点；它不是持续录像或逐帧截图。需要完整视觉状态时，Agent 再按需读取 tree 和 screenshot。

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
