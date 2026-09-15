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


当前版本的入口、参数与平台范围见[命令合同](desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md)。Intent 和 Script 是一等执行入口，基础命令继续作为共用能力保留。

命令域：`core`（状态、UI 观察和采集）、`app`（安装、生命周期和权限）、`action`、`flutter`、`webview`、`ios`、`web`、`diagnostics`、`execution`（`intent`、`script`、`runtime`、`device-ownership`）、`evidence`、`advanced`（UIA runtime 控制和端口转发）。

默认 `capabilities` 返回精简命令目录；按 `command` 和 `operation` 查询所需合同。Intent decide 可再按 `platform`、`provider`、`action` 筛选，CLI `--help` 支持相同筛选。用 `run` 执行选定命令。

CLI 与 MCP 共用独立的本地执行 Runtime 和命令合同。Intent、Script、安装和权限操作可以由任一客户端启动，再由另一客户端通过 operationId 继续。客户端退出后任务继续运行；显式使用任务 cancel 或 `runtime --operation stop` 停止。

- `script` 运行 trusted-local-code 的 JavaScript 或 Python。`permissions` 只门闩 Bridge SDK 调用，不是 OS 沙箱。默认 allowlist 不含清数据、安装、权限变更、eval、raw shell 或 ADB 管理。`page-summary` 只留在 Script/Intent 内部。
- `intent` 记录 observation、decision、action 和证据引用。Agent 自行读取历史并编写 Script。
- Android 和 iOS 的 `logs` / `network` / `state` / `events` 使用手机侧持久存储，连接时通过 `history:true` 查询保留的事实；Host 分别保存执行与观察证据。Web 采集在接收时写入 Host FactStore。每次查询均需核对 refs、目标、epoch、coverage 和保留范围。

`0.3.8` 统一 CLI、Android SDK/plugin、Flutter、Web 和 iOS 源码版本；外部发布是单独步骤，本地构建不会修改 npm/pub.dev 默认版本。新增能力见[可选执行器接入指南](desktop/ai-app-bridge-cli/docs/OPTIONAL_EXECUTORS.md)。
本地构建和发布顺序见[发行指南](desktop/ai-app-bridge-cli/docs/RELEASE.md)。Script 为可选能力；
执行结束、纯代码断言和有设备证据的结果分别统计。当前设备强断言仅支持完整单页，
多页查询可以取数，但尚不支持合并为一个完整窗口断言。恢复仅适用于显式可重入
checkpoint 模板，不确定副作用不会自动重放。参见 [候选版本合同与迁移说明](desktop/ai-app-bridge-cli/README.md#intent-script-and-evidence)。

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

- Android SDK 通过本次运行专属的本地 socket 提供 HTTP；Host 从 App 私有端点文件发现地址，再建立 ADB 转发
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
    debugImplementation("com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-android:0.3.8")
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
    id("io.github.mobileaidev.aiappbridge.android") version "0.3.8"
}

aiAppBridge {
    setOkHttpCaptureEnabled(true)
}
```

同一个插件会自动选择 AGP backend：AGP 7+ 使用新版 Android Components instrumentation，AGP 4.x 使用 legacy Transform API。

## iOS 快速接入

在 debug 构建里通过 Swift Package Manager 引入 Swift runtime：

```swift
.package(url: "https://github.com/mobileAiDev/ai-app-bridge.git", exact: "0.3.8")
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
npm install -g @mobileaidev/ai-app-bridge@0.3.8
ai-app-bridge ios-setup --device-id <device-or-udid> --bundle-id <ios.bundle.id> --team-id <APPLE_TEAM_ID> --start-wda
ai-app-bridge ios-doctor --device-id <device-or-udid> --bundle-id <ios.bundle.id> --wda-runner-bundle-id <runner-from-setup>
```

iOS 控制栈需要 Xcode、已信任且解锁并开启 Developer Mode 的设备、App debug runtime，以及经过准备和签名的 WDA Runner。`ios-setup --start-wda --team-id <APPLE_TEAM_ID>` 会从固定 WDA 14.1.1 生成独立副本并加入 Bridge 身份校验。`--wda-test-bundle-id` 设置测试包，默认 `io.github.mobileaidev.aiappbridge.wda`；setup 返回对应 Runner App ID。后续 WDA 命令必须带确切设备和 `wdaRunnerBundleId`，可选的转发 `wdaUrl` 不能跳过容器身份校验。在已经位于前台的 App 中显式创建 `ios-wda-session` 后才能读树和操作。WDA 已提供排队取消、原完成记录持久化及 `ios-execution --kind wda` 恢复；进行中事件取消、输入焦点限制及待完成的真机关口见 [WDA 合同](desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md#ios-wda-target-and-session)。iOS Intent 和 Script 已支持明确目标绑定的 native、H5、Flutter provider；平台能力与每个真实 App 的业务验收结果分别判断。

## Flutter 快速接入

Flutter 项目只需要添加 pub 包。插件的 Android debug variant 会自动引入 `ai-app-bridge-android` runtime，用来启动设备内本地 bridge server；iOS plugin 会在 debug app 进程中启动 Swift runtime。release 构建不应自动暴露 debug runtime。

添加 Flutter 插件：

```yaml
dependencies:
  ai_app_bridge_flutter: 0.3.8
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

Flutter WebView DOM 支持需要注册 H5 adapter，因为 WebView controller 在 Dart 层。`webViewIsVisible` 由实际 route/widget 状态维护：

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

销毁视图时调用 `AiAppBridge.instance.unregisterH5Adapter('main-webview')`。多个 adapter 同时可见时必须明确选择已观察的 `adapterId`；注册本身不指定活动视图。替换同一 ID 必须先 unregister，旧页面引用随之失效。

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
npm install -g @mobileaidev/ai-app-bridge@0.3.8
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
