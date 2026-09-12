---
name: ai-app-bridge-use
description: 使用 AI App Bridge 观察、操作和验证 Android、iOS、Flutter、WebView 或 Web App；适用于真实交互、流程自动化和设备诊断。
---

# AI App Bridge Use

## 选择入口

- **Intent**：日常操作和未知流程，观察与 Agent 决策绑定；适合页面探索、系统窗口交互。
- **Script**：固定流程和重复运行，自由编写 JavaScript/Python（trusted-local-code），用 `ctx.call` 调用设备能力；权限声明不是 OS 沙箱。
- **单次命令**：观察、单步动作、安装、权限夹具和诊断可独立调用，无须包装成完整流程。

## 共享调用合同

MCP 入口是 `capabilities` 和 `run`；命令参数全部放在 `run.arguments`，包括目标和 operation，使用当前命令名与 JSON 类型。默认 capabilities 或 domain 查询只取目录；用 `command` 查合同，Intent/Script/evidence 加 `operation` 只取当前操作。Intent decide 可再加实际 `platform`、`provider`、`action`，例如 `{"command":"intent","operation":"decide","platform":"android","provider":"native","action":"tap"}`。CLI `--help COMMAND` 接受相同筛选；`includeOptions:true` 才展开整个目录，按需使用。

CLI 与 MCP 共用独立执行 Runtime、命令合同和 operationId。CLI JSON 响应的业务值在 `value`；Script 的调用返回值另见下文。客户端退出不会取消任务，用原 operationId 显式 cancel。取消不撤销已派发效果；更换 Runtime 版本或环境前先显式 stop。

旧 MCP 实例可能与已安装 CLI 不同。缺少 Intent/Script 或参数不匹配时，核对实际入口版本，选用支持当前合同的入口；不要套用旧 batch、工具别名或外层参数。

## 目标与动作

- Android：明确 `serial` 和 `packageName`。iOS：`deviceId`/`bundleId`；Native Intent 还需原 WDA Runner/session 绑定。Web：从当前连接取得 `sessionId`/`runtimeEpoch`/`targetId`。
- Intent/Script 的目标带 `platform`。目标标识、当前前台和返回的观察必须对应；更多绑定按平台合同补齐。
- selector、nodeRef、pageRef 和坐标来自当前观察。多重匹配、过期引用、前台变化或 `reobserve_required` 需要重新观察；Intent 切 provider 通过 `observe` 完成。
- 已派发但结果未知（`ambiguous`）时先观察，避免换 provider 或端点重放动作。保留原 `error`、`message`、`dispatched` 和操作状态。
- 若使用 freeze，后续操作和结束交付前先 thaw。

## Intent

`start` 提供 `goal`、显式 `target` 和所需 provider；默认 supervised。
保留返回的 operationId，读取当前观察后以 `decide` 提交决策。
`decision` 包含唯一 `decisionId`、当前 `basedOnRevision` 和 `agentDecision`；`act` 的 action 遵循该观察的 provider 合同，控件动作使用唯一 selector。
需要刷新或切换 provider 时用 `observe`，随后使用新 revision。
`complete`/`fail`/`inconclusive` 也需要当前 revision，且不带 action；完成决策不能代替实际结果证据。
安装与权限弹窗命令会返回受监督 Intent，须继续观察和决策；具体收尾条件见对应合同章节。

## Script

`start` 的 `script` 内提供 `target`、`language`（`javascript` 或 `python`），以及 `source`/`sourcePath` 二选一。源码入口、权限和 API 按需查 `SCRIPT_AUTHORING.md`。
`ctx.call` 返回 envelope：先检查 `ok`，设备数据在 `result`；调用失败和 `ctx.assert` 的 verdict 由源码处理。
用原 operationId 查询 `status`/`wait`；连续等待使用上一响应的 `eventSequence` 作为 `afterSequence`。
`completed` 仅说明源码返回并持久化；status/wait 的 `resultRef` 不是最终值。
完成后调用 `script` 的 `operation:"result"` 读取 `result`、`resultRef` 和 `persisted`，检查 representation 及实际断言结果。读取失败保留错误，不从进度事件拼出返回值。

## 验证与证据

按用户要求的结果选取本轮证据；动作回执、UI 变化、业务结果和证据覆盖分别判断，证据不足保留为 inconclusive。
要保留可移交的过程文件，在 Intent/Script start 时设置新的 `recordingDir`；已有操作的保留记录可通过 `evidence` 导出。
`evidence export` 使用原 operationId 和对应 namespace（intent/script）；包含已记录文件需 `includeRecordedPayloads:true`。保存返回的 manifestSha256，交给离线 `evidence verify`。
归档校验只证明保留内容的完整性和覆盖范围；缺页、缺引用或已淘汰记录仍需如实报告，不能据此推断业务通过。

## 按需文档

从 `command -v ai-app-bridge` 取得入口并解析符号链接；其 `bin/..` 是 CLI 发布包根目录。源码仓库中为 `desktop/ai-app-bridge-cli`。以下路径均相对此包根目录，不相对本技能；先查标题或关键词，只读相关章节。

- `docs/COMMAND_CONTRACT.md`：入口与 Runtime 看 **Discovery and entrypoints**；Intent 看 **Execution operation contracts**；目标看 **Target and dispatch** 及对应 iOS/H5/Web 章节；安装/权限看 **Installation is an Intent operation** / **Runtime permission requests use Intent**。
- `docs/SCRIPT_AUTHORING.md`：首次写脚本看 **Start and observe**、**Calls and assertions**；命令准入看 **Capability selection**；采集或暂停需求再读对应章节。
- `docs/EVIDENCE_ARCHIVE.md`：需要记录、导出或离线校验时读取，包含文件范围与 coverage 的具体边界。
