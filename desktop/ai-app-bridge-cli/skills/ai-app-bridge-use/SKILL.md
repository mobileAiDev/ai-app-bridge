---
name: ai-app-bridge-use
description: 使用 AI App Bridge MCP 观察、操作、验证和调试 Android、iOS 或 Flutter 应用。Codex 需要检查移动端 UI、截图、Android View/UIAutomator tree、iOS UIKit/WDA tree、点击/输入/等待/滑动、安装/启动/清数据、Flutter widget 与 action、WebView/WKWebView/H5 DOM 或 CDP 网络/控制台、日志/网络/状态/事件、权限/appops、smoke 测试，或按需使用 freeze/thaw 稳定动态画面时触发。
---

# AI App Bridge Use

## Agent 快速流程

1. 确认目标 app：Android 使用 `packageName`，iOS 使用 `bundleId`，真机多设备场景传 `deviceId`/UDID；没有目标 id 时先从上下文、构建配置或前台 app 线索推断。面向具体 app 的命令必须传目标 id，只有无法发现 bridge 端口时才传 `port` 或 `runtimeUrl`。
2. 发现能力：默认 MCP surface 只有 `capabilities` 和 `run`。不确定命令或参数时先调用 `capabilities`，再用 `run` 执行。
3. 选择命令路径：按任务类型选 `core`、`app`、`action`、`flutter`、`webview`、`diagnostics` 或 `advanced` 域；不要先退回原始 `adb`。
4. 用 `batch` 串联相关步骤：观察、操作、等待、截图、tree 验证尽量放进一次 MCP 调用。
5. 验证可见结果：界面变化必须用 `screenshot` 加 `tree`/`uia-tree` 交叉确认。
6. 只在需要稳定动态画面时使用 `freeze-app`/`thaw-app`；如果本轮冻结过 app，最终回复前必须解冻。

## 能力发现和调用

`capabilities` 用来列出命令域和参数：

```json
{ "domain": "webview", "includeOptions": true }
```

```json
{ "command": "input-text", "includeOptions": true }
```

`run` 用 CLI 形式的命令名执行能力，例如：

```json
{
  "command": "screenshot",
  "packageName": "com.example.app"
}
```

如果 MCP 暴露的是 full/legacy surface，直接工具名通常用下划线形式；语义与 `run` 里的连字符命令一致，例如 `tap_text` 对应 `tap-text`。

## 任务路由

| 任务 | 首选命令 |
| --- | --- |
| 当前 app 状态和桥接信息 | `status` |
| 真实可见画面 | `screenshot` |
| App 内 View 节点 | `tree`，常配 `compact`、`visibleOnly` |
| 系统窗口、权限弹窗、Compose/跨 app UI | `uia-tree`、`tap-uia-text` |
| 点击、输入、等待、滑动、按键 | `tap-text`、`tap`、`input-text`、`wait-text`、`swipe`、`keyevent` |
| 键盘处理 | `keyboard-state`、`hide-keyboard` |
| 安装、启动、清数据 | `install-apk`、`launch-app`、`launch-activity`、`clear-app-data` |
| 权限和 appops | `permission-state`、`permission-grant`、`permission-revoke`、`permission-dialog`、`appops-set` |
| Flutter UI 和动作 | `flutter-tree`、`flutter-nodes`、`tap-flutter-text`、`input-flutter-text`、`scroll-flutter`、`flutter-action` |
| 原生 WebView DOM | `h5-dom`、`h5-click`、`h5-input`、`h5-wait`、`h5-scroll` |
| Flutter H5 adapter | `flutter-h5-dom`、`flutter-h5-click`、`flutter-h5-input`、`flutter-h5-wait`、`flutter-h5-scroll` |
| WebView CDP 网络/控制台 | `webview-pages`、`webview-network`、`webview-console` |
| App 内记录 | `logs`、`network`、`state`、`events` |
| Android 日志 | `logcat`，按 `pid`、`appPid`、`tag`、`level`、`grep` 过滤 |
| iOS 设备/环境检查 | `ios-devices`、`ios-doctor`、`ios-setup` |
| iOS App 内证据 | `ios-status`、`ios-tree`、`ios-logs`、`ios-network`、`ios-state`、`ios-events`、`ios-h5-dom`、`ios-h5-eval` |
| iOS 系统级 UI 与动作 | `ios-uia-tree`、`ios-tap`、`ios-input`、`ios-swipe`、`ios-screenshot` |
| 自检 | `smoke` |
| 多步骤串行执行 | `batch` |
| 动态画面稳定 | `freeze-app`、`thaw-app`，只按需使用 |

## 常用模式

观察当前界面：

```json
{
  "command": "batch",
  "arguments": {
    "defaults": { "packageName": "com.example.app" },
    "steps": [
      { "id": "status", "command": "status" },
      { "id": "shot", "command": "screenshot" },
      { "id": "tree", "command": "tree", "arguments": { "compact": true, "visibleOnly": true } }
    ],
    "stopOnError": true,
    "includeRaw": true
  }
}
```

点击并验证结果：

```json
{
  "command": "batch",
  "arguments": {
    "defaults": { "packageName": "com.example.app" },
    "steps": [
      { "id": "tap", "command": "tap-text", "arguments": { "targetText": "继续" } },
      { "id": "wait", "command": "wait-text", "arguments": { "targetText": "完成", "timeoutSec": 8 } },
      { "id": "shot-after", "command": "screenshot" },
      { "id": "tree-after", "command": "tree", "arguments": { "compact": true, "visibleOnly": true } }
    ],
    "stopOnError": true,
    "includeRaw": true
  }
}
```

输入文本：

```json
{
  "command": "input-text",
  "packageName": "com.example.app",
  "arguments": {
    "text": "中文输入",
    "hideKeyboard": true
  }
}
```

捕获 WebView 网络：

```json
{
  "command": "webview-network",
  "packageName": "com.example.app",
  "arguments": {
    "durationMs": 3000,
    "urlFilter": "/api/"
  }
}
```

iOS 观察和操作：

```json
{
  "command": "batch",
  "arguments": {
    "defaults": {
      "deviceId": "00008150-...",
      "bundleId": "com.example.ios"
    },
    "steps": [
      { "id": "status", "command": "ios-status" },
      { "id": "tree", "command": "ios-tree" },
      { "id": "uia", "command": "ios-uia-tree", "arguments": { "wdaUrl": "http://[fd00::1]:8100" } },
      { "id": "tap", "command": "ios-tap", "arguments": { "wdaUrl": "http://[fd00::1]:8100", "tapX": 160, "tapY": 320 } },
      { "id": "events", "command": "ios-events" }
    ],
    "stopOnError": true,
    "includeRaw": true
  }
}
```

## 验证规则

把 `screenshot` 当作当前可见画面的最高优先级证据，把 `tree`/`uia-tree` 当作可操作节点和结构证据。

对打开/关闭面板、关闭弹窗、切换页面、点击 tab、进入详情页、展开抽屉、按钮触发内容变化等可见状态变化，必须同时采集截图和 tree。只有二者指向同一状态时，才报告成功。

如果截图和 tree 冲突：

- 以截图判断用户实际看到什么。
- 认为 tree 可能包含缓存、不可见节点、过期层或非前台窗口。
- 重新等待、采集或换用 `uia-tree`、坐标点击、Flutter/WebView 专用命令。
- 不要把冲突证据包装成确定结论。

异步 UI 用 `wait-text` 或 H5/Flutter wait 命令等待；不要用固定 sleep 代替状态判断。

## 平台专项

iOS：

- 完整能力必须同时使用两层：App 内 `AiAppBridgeIOS` runtime 负责结构化证据，WebDriverAgent/XCUITest 负责系统级 tap/input/swipe、权限弹窗、外部 UI tree 和跨 app UI。
- 首次真机使用先跑 `ios-devices` 和 `ios-doctor`。如果 Developer Mode、DDI、信任、解锁、Xcode Apple team 或 WDA signing 不满足，停下来报告 blocker，不要跳过 WDA 降级成只读模式。
- WDA 可由 `ios-setup --start-wda --team-id <APPLE_TEAM_ID>` 启动；真机上返回的 WDA URL 可能是 CoreDevice tunnel，例如 `http://[fdxx::1]:8100`，后续 `ios-uia-tree`、`ios-tap`、`ios-input`、`ios-swipe` 都优先复用这个 URL。
- 文本输入优先用元素目标，例如 `ios-input` 搭配 `accessibilityId` 或 `elementId` 和 `clearFirst`；坐标输入仅用于没有稳定 accessibility id 的控件。
- Flutter iOS 仍按 Flutter 路径读 widget/action 证据；设备级动作、权限弹窗和外部 UI 仍走 iOS WDA 命令。

Flutter：

- 先尝试泛用 `tap-text`/`input-text`；失败、节点不可见或语义特殊时切到 `flutter-*`。
- 用 `flutter-nodes` 找可操作节点，用 `scroll-flutter` 处理需要滚动后才出现的文本。

WebView/H5：

- DOM 操作优先用 `h5-*` 或 `flutter-h5-*`，避免靠坐标猜元素。
- CDP 网络/控制台用 `webview-network`/`webview-console`；目标 app 需要 debuggable，且 WebView debugging 可用。
- `webview-pages` 可先确认可 attach 的 page、socket、URL。

输入：

- 中文和 Unicode 输入优先用 `input-text` 或 `input-flutter-text`，不要用原始 `adb shell input text`。
- 下半屏点击前注意键盘遮挡；必要时先 `keyboard-state` 再 `hide-keyboard`。

权限和系统 UI：

- 运行时权限优先用 `permission-state`/`permission-grant`/`permission-revoke`。
- 必须处理系统弹窗时，用 `permission-dialog` 或 `uia-tree`/`tap-uia-text`。

## Freeze/Thaw 策略

`freeze-app`/`thaw-app` 是稳定动态画面的能力之一，不是默认动作节奏。只有冻结能让证据更可靠时才用。

适合冻结：

- 视频、动画、倒计时、实时刷新列表、游戏、播放页等会在思考期间变化的画面。
- 点击后出现短暂状态，需要先固定再分析截图和节点。
- 用户要求精确截图、坐标、像素或瞬时状态验证。

不要冻结或不要提前冻结：

- 静态页面的一次性观察、简单点击、普通表单输入。
- `install-apk`、`launch-*`、`clear-app-data`、权限弹窗处理。
- `wait-text`、点击、输入、滚动、WebView CDP 捕获、`logcat --follow` 等命令尚未完成时。

如果使用冻结：

1. 读取、操作、等待、捕获前先确保 app 解冻。
2. 拿到本轮证据后，确实需要稳定画面时再 `freeze-app`。
3. 冻结期间只做分析和规划，不执行依赖 app 运行的命令。
4. 下一次读取/操作/等待/捕获前先 `thaw-app`。
5. 最终回复前调用 `thaw-app`，不要把 app 留给用户时仍处于冻结状态。

动态画面采集并冻结：

```json
{
  "command": "batch",
  "arguments": {
    "defaults": { "packageName": "com.example.app" },
    "steps": [
      { "id": "thaw", "command": "thaw-app" },
      { "id": "shot", "command": "screenshot" },
      { "id": "tree", "command": "tree", "arguments": { "compact": true, "visibleOnly": true } },
      { "id": "freeze", "command": "freeze-app" }
    ],
    "stopOnError": true,
    "includeRaw": true
  }
}
```

最终恢复：

```json
{
  "command": "thaw-app",
  "packageName": "com.example.app"
}
```

## 失败处理

- `packageName`/`port` 缺失：先补目标，不要让 MCP 回落到默认 sample。
- iOS `bundleId`/`deviceId`/`wdaUrl` 缺失：先用 `ios-devices`/`ios-setup` 补齐；需要 full-control 时不要在没有 WDA 的情况下宣称完成。
- iOS 设备锁屏、未信任、Developer Mode/DDI 不可用、WDA signing 失败、首次启动弹出授权/密码框：停下告诉用户需要操作，用户处理后再重试。
- `screenshot` 报前台 package 不匹配：先 `launch-app` 或确认当前前台，再继续判断。
- `tree` 为空但截图正常：尝试 `uia-tree`、等待一轮或使用 Flutter/WebView 专用命令。
- WebView CDP 不可用：确认 app debuggable、WebView debugging、目标 page；不能用 CDP 时退回 `h5-*` 或可见 UI 验证。
- `freeze-app` 失败：继续任务；只有影响动态证据稳定性时才说明限制。
- 冻结状态下读取超时：先 `thaw-app` 再重试。
- 最终 `thaw-app` 失败：在回复中明确说明 app 可能仍被冻结。

## 安装配置

如果当前会话没有 AI App Bridge MCP，安装桌面包：

```bash
npm install -g @mobileaidev/ai-app-bridge
```

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

配置后重启或刷新 MCP session，再调用 `capabilities` 确认连接。
