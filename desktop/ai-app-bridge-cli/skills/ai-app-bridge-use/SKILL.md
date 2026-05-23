---
name: ai-app-bridge-use
description: 使用 AI App Bridge MCP 观察、操作、验证 Android 或 Flutter 应用。Codex 需要读取 app UI 内容、截图、View tree、Flutter widget、WebView DOM、日志、网络请求、状态，或通过 ai-app-bridge-mcp 执行 Android app 操作时触发；必须在模型思考和规划下一步期间冻结 app，只在读取内容或执行操作前短暂解冻，并在全部任务结束前解冻 app。
---

# AI App Bridge Use

## MCP 安装

使用前先确认 AI App Bridge MCP server 已安装并配置。如果当前会话里已经有 `ai-app-bridge` MCP 工具，直接进入“冻结节奏”。

安装桌面 MCP 包：

```bash
npm install -g @mobileaidev/ai-app-bridge
```

把 MCP server 加到用户的 agent 配置里。

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

配置后重启或刷新 agent 的 MCP session。第一次使用时先调用 `capabilities`，确认 compact surface 里有 `run`、`freeze-app` 和 `thaw-app`。

## 冻结节奏

核心规则：**模型思考、分析证据、规划下一步期间，app 必须保持冻结；全部任务结束前，app 必须恢复解冻。**

每一轮都按这个循环执行：

1. 准备读取 app 内容或执行 app 操作前，调用 `thaw-app`。
2. 立即执行需要 app 运行的 MCP 命令，例如读取 `tree`、截图、等待文本、点击、输入、滚动、抓取 WebView 网络等。
3. 一旦拿到本轮需要的证据或动作结果，立即调用 `freeze-app`。
4. 在 app 已冻结的状态下，再分析证据、判断是否成功、规划下一步。
5. 下一轮真正要读内容或操作 app 时，再次 `thaw-app`。
6. 当确认整个用户任务已经完成、准备给用户最终回复前，最后调用一次 `thaw-app`，不要把 app 留在冻结状态。

换句话说，app 只在“采集证据/执行动作”的短窗口内运行；模型停下来思考时，app 应该已经被冻结；任务结束交还给用户前，app 应该已经解冻。

## 状态变化校验

对任何会改变可见界面的操作，例如打开/关闭面板、关闭弹窗、切换页面、点击 tab、进入详情页、展开抽屉、点击按钮后读取内容，不能只依赖 `uia-tree` 或 `tree` 判断成功。

操作后必须同时采集：

1. `screenshot`
2. `uia-tree` 或 `tree`

只有当截图中的可见画面与 UI tree 的关键节点一致时，才能认为操作成功。

如果两者冲突：

- 以截图作为当前真实可见界面的优先证据。
- 将 UI tree 视为可能存在缓存、残留节点、不可见层或过期节点。
- 重新点击、调整坐标、等待后再采集。
- 不得基于冲突证据向用户报告结论。

禁止仅凭 UI tree 中存在目标文本，就断言目标面板、弹窗、页面或 tab 已经打开；必须确认该文本在截图中对应的可见区域也存在，或截图中存在等价的可见状态标志。

例如打开评论面板后，必须确认：

- 截图中实际出现评论面板、评论标题或评论列表。
- UI tree 中也出现 `评论` 标题、评论列表节点或评论输入栏。
- 两者内容对应同一个界面。

## 推荐批处理

优先用 `batch` 把“解冻 -> 采集/操作 -> 冻结”放进同一个 MCP 调用，避免中间留下 app 继续播放或动画变化。

读取当前屏幕：

```json
{
  "command": "batch",
  "arguments": {
    "defaults": {
      "packageName": "com.example.app"
    },
    "steps": [
      { "id": "thaw", "command": "thaw-app" },
      { "id": "tree", "command": "tree", "arguments": { "compact": true, "visibleOnly": true } },
      { "id": "freeze", "command": "freeze-app" }
    ],
    "stopOnError": true,
    "includeRaw": true
  }
}
```

执行点击并读取结果：

```json
{
  "command": "batch",
  "arguments": {
    "defaults": {
      "packageName": "com.example.app"
    },
    "steps": [
      { "id": "thaw", "command": "thaw-app" },
      { "id": "tap", "command": "tap-text", "arguments": { "targetText": "继续" } },
      { "id": "screenshot-after", "command": "screenshot" },
      { "id": "tree-after", "command": "tree", "arguments": { "compact": true, "visibleOnly": true } },
      { "id": "freeze", "command": "freeze-app" }
    ],
    "stopOnError": true,
    "includeRaw": true
  }
}
```

任务结束前恢复 app：

```json
{
  "command": "thaw-app",
  "packageName": "com.example.app"
}
```

## 单步命令模式

如果不能用 `batch`，也必须手动保持同样顺序：

```json
{ "command": "thaw-app", "packageName": "com.example.app" }
```

```json
{ "command": "tree", "packageName": "com.example.app", "arguments": { "compact": true, "visibleOnly": true } }
```

```json
{ "command": "freeze-app", "packageName": "com.example.app" }
```

之后再开始思考和规划下一步。全部任务完成后，再执行一次：

```json
{ "command": "thaw-app", "packageName": "com.example.app" }
```

## 什么时候不要提前冻结

不要在一个需要 app 持续运行的 MCP 命令还没完成前冻结，例如：

- `wait-text`
- 点击、输入、滚动、启动 Activity
- 带 `durationMs` 的 `webview-network` / `webview-console`
- `logcat --follow`
- 安装、授权、权限弹窗处理

这些命令执行前先解冻，命令返回并拿到结果后立刻冻结，然后再思考。等全部任务完成并准备结束时，再解冻 app。

## 失败处理

如果 `freeze-app` 失败，继续用 MCP 完成观察和操作，但在结果里说明限制。常见原因包括：app 不是 debuggable、目标进程不存在、`run-as` 不可用、系统已经杀掉进程。

如果 app 已经被冻结，而 MCP 读取内容超时或无法返回数据，先调用 `thaw-app`，再重试读取；不要在冻结状态下反复读取 bridge 数据。

如果最终 `thaw-app` 失败，也要在给用户的最终回复里说明 app 可能仍处于冻结状态，以及失败原因。
