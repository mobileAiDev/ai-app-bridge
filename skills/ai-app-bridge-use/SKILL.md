---
name: ai-app-bridge-use
description: 用 AI App Bridge 操作、测试和诊断 Android、iOS、Flutter、WebView 与 Web App。以 Intent / Script 推进任务；独立读日志、截图、查询可直接调用命令。ADB 通过内置 adb-exec 执行。
---

# AI App Bridge

**设备和 App 操作默认走 Bridge；Intent / Script 是任务执行的主要入口。** 按任务性质选择，不按步骤数量限制：

| 需求 | 入口 |
| --- | --- |
| 观察页面、探索并作决策 | **Intent**：按当前观察决策；已有本地策略时可 autonomous 连续执行 |
| 代码可表达的操作、等待、分支和断言，包括一次性任务 | **Script**：普通 JavaScript/Python，通过 `ctx.call` 调用能力；新判断才 `ctx.askAgent` |
| 单独读日志、截图、查状态、定点诊断或明确的原子动作 | **直接调用对应 Bridge 命令**，无须包装成 Intent / Script |

Script 可以边观察边处理已知分支，无须先摸清整个 App。把当前已知工作留在一次执行里；Intent 与 Script 也可互相调用。

只有用户明确指定其他工具、Bridge 确实不可用，或当前合同无法提供所需能力/语义时，才使用外部工具，并说明具体缺口。熟悉裸 ADB、某个 SDK 命令失败，都不构成离开 Bridge 的理由。正常操作无须先做全面诊断。

## ADB 也通过 Bridge

ADB 的参数直接放进 `adb-exec.argv`，可通过 MCP、Bridge CLI、Intent command action 或 Script 调用：

```javascript
// MCP：独立诊断，DEVICE 替换为实际 serial。
run({command:"adb-exec", arguments:{serial:"DEVICE", argv:["shell","getprop","sys.boot_completed"], readOnly:true}})
// Script：继承 script.target.serial。
const reply = await ctx.call("adb-exec", {argv:["shell","getprop","sys.boot_completed"], readOnly:true});
```

只有实际只读命令才设 `readOnly:true`；二进制输出用 `outFile`。ADB 进程退出不等于 App 业务成功。

**Android 没有 App SDK 仍可用 Bridge 的 UIA 和 ADB：** `uia-tree` / `tap-uia` 操作可访问控件，`screenshot` 截整屏，`adb-exec` 执行 ADB。SDK 路径失败只说明该路径的问题；按实际目标选择能力，保留未知动作回执，切路径不自动重放。

## 调用要点

MCP 只有 `capabilities` 和 `run`。按需查询 `capabilities({command:"script",operation:"start"})`（Intent 换成 `command:"intent"`）；单条能力用对应 command。已知合同可直接执行。所有业务参数放在 `run.arguments`，CLI 使用 kebab-case。

- **Intent**：`run.command:"intent"`，start 提供 `goal/target/provider`。supervised 需要 agent 用当前 revision 提交 `decide`；autonomous 使用本地 `agentModule`。无 SDK 的 Android 可访问 UI 选择 `provider:"uia"`。
- **Script**：`run.command:"script"`，start 的 `script` 包含 `schemaVersion:"aab.code-script/v1"`、`language`、`target`、`source/sourcePath` 二选一；可带 `waitMs:60000`。默认可调用全部注册命令，包括 `adb-exec`；源码是 trusted-local-code，不是 OS 沙箱。
- **目标**：Intent 在 `arguments.target`，Script 在 `arguments.script.target`。Android 带 `platform:"android",serial`，App 任务再带 `packageName`；iOS/Web 按当前合同填写真实设备、会话和目标身份。

首次编写或需要完整 start/decide/wait 示例时，读 [执行与恢复](references/workflow-lifecycle.md) 及发布包 `docs/SCRIPT_AUTHORING.md`。已有配方可用 `run({command:"script",arguments:{operation:"recipes"}})`，已连接 Web 可选 `name:"web-steps"`。

## 结果与继续

- MCP/CLI 看 `execution` 判断执行，`value` 取数据，`control` 续跑；Script 内 `ctx.call` 则先检查 `ok`，再读 `result`。
- `waitMs` 每次最多 60000；超时用原 `operationId` 继续等待，不重发动作。`waiting_for_agent` 读取 `control.pendingQuestion` 并提交 `decide`。回复已有 result 就直接使用，否则按 `resultRef` 读取。
- MCP 过旧或断开可使用 **AI App Bridge CLI**。断开不取消任务；按原 ID 继续或 cancel。故障按需用 `doctor`，重启前核对当前任务和影响。
- 提取/输出问题不等于动作失败；用已保存的 `control.source.ref` 重读。控件引用过期先观察，结果未知保留未知；业务成功按实际证据判断。使用 freeze 后先 thaw 再继续或交付。

## 按需参考

- [执行与恢复](references/workflow-lifecycle.md)：Intent 决策/autonomous，Script 等待、问题、checkpoint 和恢复。
- [目标与故障处理](references/runtime-and-targets.md)：selector、系统弹窗、provider、设备占用、UIA/SDK、Runtime 与防休眠。
- [结果与证据](references/results-and-evidence.md)：大结果提取、表格/差量、历史分页、覆盖与归档。

上述参考中的 `docs/` 相对 CLI 发布包根目录：从 `command -v ai-app-bridge` 解析符号链接，其 `bin/..` 即包根目录；仓库内为 `desktop/ai-app-bridge-cli`。查所需章节即可。
