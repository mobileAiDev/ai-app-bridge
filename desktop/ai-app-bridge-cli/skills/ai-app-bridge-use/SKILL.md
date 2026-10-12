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

MCP 入口是 `capabilities` 和 `run`；`capabilities` 是独立工具，不是 `run` 的命令。命令参数全部放在 `run.arguments`，包括目标和 operation，使用当前命令名与 JSON 类型。默认 capabilities 或 domain 查询只取目录；domain 取值为 execution、evidence、core、app、action、flutter、webview、ios、web、diagnostics、advanced；android 是平台不是 domain，平台筛选只用于 Intent decide 的 `platform`。用 `command` 查合同，Intent/Script/evidence 加 `operation` 只取当前操作。Intent decide 可再加实际 `platform`、`provider`、`action`，例如 `{"command":"intent","operation":"decide","platform":"android","provider":"native","action":"tap"}`。CLI `--help COMMAND` 接受相同筛选；发现正文上限 96 KiB，宽查询超限时按提示用 command/operation 收窄，不反复读取整个 schema。

省略 `extract` 时使用 auto：预算内完整返回，重复结构可用无损表格（`partial:false`）减少字节；超预算也先尝试无损表示，仍放不下才给含完整记录或文本片段的部分视图（`partial:true`）。不要看到 `read` 就机械补读：首个回复已经包含需要的信息时直接继续。已知需要什么时用 select、regex 或 JS/Python；显式 `null` 保持原始形状。业务参数在 `arguments`；`extract/output` 属于顶层，不传入设备命令。

CLI 与 MCP 共用独立执行 Runtime、命令合同和 operationId。CLI 响应是一行紧凑 JSON，业务值在 `value`；MCP 工具正文同样是紧凑 JSON。Script 的调用返回值另见下文。客户端退出不会取消任务，用原 operationId 显式 cancel。取消不撤销已派发效果；版本错误会列出两侧身份，只在确定 Runtime 是待更新一侧时安排显式 stop。

旧 MCP 实例可能与已安装 CLI 不同。缺少 Intent/Script 或参数不匹配时，核对实际入口版本，选用支持当前合同的入口；不要套用旧 batch、工具别名或外层参数。

**连接诊断：** 按需用 `doctor {serial:"设备",packageName:"可选应用"}`，或 `platform:"host"|"ios"|"web"`；CLI 例如 `ai-app-bridge doctor --serial 设备`。它分别报告各条路径与恢复调用；`ok:true` 表示诊断报告生成，问题在 checks/issueCount 中。某一路不可用不否定其他路径，正常点击不需要先跑 doctor。

**卡死 / 换 agent：** 先读 `device-ownership {operation:"status",serial:"原设备"}`。旧 Host 已消失的未知记录会归档，新明确动作可继续；archives/archive 可读原记录，reconcile-archive 只查询原动作，不取消或重放。活跃 owner 需要继续、取消，或由 agent 明确接管。决定强制接管时可用 `ai-app-bridge device-ownership --operation force-stop --serial 原设备`：无需旧回执，结束旧 Host/共享 Runtime 的相关任务并重置设备执行器；同 Host 的其他任务可能一起结束，已派发效果记为未知。读取 ownershipReleased/remoteResetPending，再观察当前状态。仅 UIA 卡住时优先考虑其 uia-runtime start/force-reset，按返回影响范围选择。

## 响应与提取

先看 `execution` 的原执行事实及 `failureStage`，再消费 `value`；Script 内部 `ctx.call` 仍按 `ok/result` 处理，不加 extract。`control` 保留续跑字段和采集覆盖；当前 Script 问题从 `control.pendingQuestion` 读取，即使 events 被游标过滤也可回答。

默认最终正文预算 96 KiB，可用 `output.maxBytes` 设为 16–256 KiB。提取失败或超预算不等于动作失败；存在 `control.source.persisted:true` 时，用 `response` 的 `operation:read`、原 `ref` 和新的 extract 重读，不重发原动作。未保存或留存已过期时没有可恢复的大结果，不捏造 ref。提取会减少交付内容，不承诺减少采集耗时。

`aab.response-tables/v1` 包含 `data/tables`：在各 `table.path` 处，用 `constants` 的公共叶子字段和 `columns` 对应的每行 `rows` 单元格构造对象，替换 null。路径都是 JSON Pointer；节点、空值、状态、顺序和重复项完整保留，不必再查原文。`aab.response-overview/v1` 的 `preview.ranges` 给出原偏移和完整记录/文本片段；只有确实需要未展示部分时，才使用 `value.read` 或自行 select 原始路径。原采集范围仍以 coverage/truncated 为准。

`aab.response-tables/v2` 还将重复长文本放在 `sharedTexts`：先把每项 `text` 填回它的 `paths`（指向整个表示的 `/data` 或 `/tables`），再按 v1 展开表格。`tables` 可以为空；`partial:false` 仍表示本次已完整返回，不需要补读。提取和保存的 ref 始终使用原始响应路径。

提取脚本只使用 `ctx.inputs = {kind, response, execution, control}`，返回严格 JSON；没有 `ctx.call`。保留实际断言需要的来源身份、时间和状态，不能将选出的几条成功记录当作完整覆盖。完整示例见 `docs/RESPONSE_EXTRACTION.md`。

## 目标与动作

- Android：明确 `serial`，App 命令再提供 `packageName`；设备级 Script 可只设 serial。iOS：`deviceId`/`bundleId`；Native Intent 还需原 WDA Runner/session 绑定。Web：从当前连接取得 `sessionId`/`runtimeEpoch`/`targetId`。
- Intent/Script 的目标带 `platform`。执行目标保持明确指定的 App/provider；Android 前台匹配、不匹配、未知是独立观测事实，不代表动作成功或失败。更多绑定按平台合同补齐。
- selector、nodeRef、pageRef 和坐标来自当前观察。多重匹配先看 candidates 和 guidance.nextActions，按实际意图选 nodeRef/targetRef；过期引用或 `reobserve_required` 再观察。Android 前台 warning 由 agent 决定继续、观察或调整目标；无需 force。Intent 切 provider 通过 `observe`，切 Android App 显式传 `observationTarget.packageName`。
- Android Native/UIA selector 可组合 text、className、resourceName、contentDescription 和 clickable 等条件，text 默认精确；包含匹配显式用 textContains/contentDescriptionContains。within 可直接限定容器，或用 `{text:"行标签",ancestor:{resourceName:"行容器"}}` 找邻近按钮；容器可多匹配，最终目标须唯一。候选序号只用于在已返回列表里取实际 viewId/完整 targetRef，不把第 N 个当跨观察稳定身份。Native 在 SDK 原子校验，省去 Host 重读；同 View 属性变动给 warning，显式 selector 条件仍要满足。UIA 组合查询先筛观察再绑定 nodeRef，属性变化给 warning。
- H5/Web selector 可组合 text、ariaLabel、tag（Web 还有 role/css），所有字段共同匹配；已有 elementId 可用于部分观察。原 DOM 节点属性变动是 warning，替换节点或切换文档才需要重新绑定。
- `logcat.grep` 默认匹配字面子串；`A|B` 等表达式显式用 `grepMode:"regex"`。普通空日志不意味着没有业务事件。若返回 `filterApplied:false`，查看保留的 text 和提示，不重复清空日志。
- 已派发但结果未知（`ambiguous`）时，原结果继续记为未知。可查询原回执、观察、取消或开始新的显式动作；工具不自动重放，是否重试由 agent 结合现场决定。保留原 `error`、`message`、`dispatched` 和操作状态。
- 若使用 freeze，后续操作和结束交付前先 thaw。

## 继续与恢复

旧 Host 已退出而动作结果未知时，新显式操作可继续；`previous_execution_unknown` 给出归档位置、read 请求和重叠风险。`device-ownership archives` 可按 actionId 筛选并跟随 nextCursor；`archive` 读取原记录，`reconcile-archive` 用 archiveId/entryId 只读查询原动作，不取消、不重放、不改变当前占用。归档直到明确调用 `delete-archive` 才删除；SDK 不支持只读查询时按返回说明更新。普通 `reconcile` 可能请求取消未完成动作，不能当作纯状态查询。`target_busy` 表示仍有活跃所有者，先查状态或按任务需要取消/强停。UIA 单独异常先用 `uia-runtime start`，需要重新建立会话时用 `uia-runtime force-reset`；它归档 UIA 会话，不结束整个 Bridge Host。

候选较多时先使用已完整返回的 value；需要更多已保存候选时跟随 `control.candidatePage.read`（Intent 在 lastAction 下），不会重复动作。若 `sourceTruncated:true`，跟随实际 provider 的观察提示；Web 支持 `web-dom {query:{text:"Agree",tag:"button"},offset:20,maxControls:100}`，按 nextOffset 继续，并用当前页的 elementId 明确选择。分页是新的页面观察，序号不会被当作稳定控件身份。

需要标准命令之外的诊断、安装或传输时，用 `adb-exec` 的 `argv` 数组；`serial` 可直接绑定设备，Host ADB 查询可省略。输出含 stdout/stderr/exitCode，二进制写 `outFile`。`completionScope:adb-process` 只证明 ADB 进程结束，设备效果另行观察。


`wait-text` 会在原 timeoutMs 内继续只读观察，保留尝试次数和最后失败原因，不重放动作。已发现的完整标签可在部分树中匹配；被截断的文本前缀不是完整标签。absentText 默认要求 provider 的完整观察范围；仅检查已返回部分时显式选择 `absenceScope:"observed"`，结果会保留 partial/unknown 范围。Intent summary 与 compact tree 的 `coverage.source`、`coverage.projection` 分别表示设备采集和 Host 投影，不能把投影完整当作源头完整。

## Intent

`start` 提供 `goal`、显式 `target` 和所需 provider；默认 supervised。
保留返回的 operationId，读取当前观察后以 `decide` 提交决策。
`decision` 包含唯一 `decisionId`、当前 `basedOnRevision` 和 `agentDecision`；控件 action 遵循该观察的 provider 合同，使用唯一 selector。
通用命令用 `action:{action:"command",command:"adb-exec",arguments:{argv:["shell","getprop","sys.boot_completed"],readOnly:true}}`，也可调用任意 Bridge 命令、Intent 或 Script。结果在 `lastAction.result`；即使 `waiting_for_observation` 也能用命令修复。命令默认不再采集页面，`uiObservation` 标明旧观察状态；需要新树时加 `observeAfter:true` 或调用 `observe`。失败/未知回执保留，agent 可作新决策，不自动重放。
需要刷新或切换 provider 时用 `observe`，随后使用新 revision。
`complete`/`fail`/`inconclusive` 也需要当前 revision，且不带 action；完成决策不能代替实际结果证据。
supervised 不会仅凭 goal 自动执行：没有决策时停在 `waiting_for_decision` 直到 `timeoutMs`。
`status` 显式给 `limit`（限制条数，不限制字节）；续读历史用上一页的 `history.lastSequence` 作为 `afterSequence`，不能用 Script 的 `eventSequence`。完整 start → decide → status → complete 范例见 `COMMAND_CONTRACT.md` **Execution operation contracts**。
`intent wait` 用上次 eventSequence 作为 afterEventSequence，waitMs 最多 60000，按 Host 事件唤醒；与历史 afterSequence 区分。用于后台启动和安装期间等待，避免紧密轮询 status。
安装与权限弹窗命令会返回受监督 Intent，须继续观察和决策；具体收尾条件见对应合同章节。

## Script

`start` 的 `script` 内提供 `target`、`language`（`javascript` 或 `python`），以及 `source`/`sourcePath` 二选一。源码入口、权限和 API 按需查 `SCRIPT_AUTHORING.md`。
Script 默认提供全部注册命令；显式 permissions 才收窄。`ctx.call` 返回 envelope：先检查 `ok`，设备数据在 `result`；调用失败和 `ctx.assert` 的 verdict 由源码处理。
`ctx.call` 可启动和控制 Intent/Script，也可安装、查询与恢复；缺省继承父 target，显式子 Script target:null 选择 Host。子任务有独立 operationId/期限，父任务停止不会隐式取消子任务。组合调用 Intent start 默认 background:true，先返回接纳状态；按返回 ID 继续 wait/decide/cancel，接纳不表示完成。
Runtime 卡住可先 `runtime {operation:"stop",timeoutMs:5000}`，仍无响应用 `runtime {operation:"force-stop"}`；保留证据，设备结果未知。Script/Intent 内调用这类关闭会返回独立控制器的 controlAccepted/resultPath，再由另一调用确认状态。
可用 `script {operation:"recipes"}` 读配方目录，加 name 读普通 JS 源码和 start 请求；CLI 同样支持，无需先启动 Runtime。android-test-session 在改设置前保存独立恢复文件，取消后可新开 Script 恢复；android-launch-and-wait 启动一次并在设备侧等待标签。填写真实 target/inputs，可直接运行或改源码。`ctx.target` 提供声明目标的副本；Python 同名。更多范围与恢复说明见 SCRIPT_AUTHORING.md。
用原 operationId 查询 `status`/`wait`；每次 `waitMs` 最多 60000，`running` 或 `finishing` 时用上一响应的 `eventSequence` 作为 `afterSequence` 继续等待。
`waiting_for_agent` 是源码的 `ctx.askAgent`：用 `control.pendingQuestion`（或本页 `agent_question_created` 事件）里的 `requestId`/`revision` 调 `decide`，或 `cancel`；不要等到超时。完整 start → wait → result 范例见 `SCRIPT_AUTHORING.md` **Lifecycle: start, wait, result**。
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
- `docs/SCRIPT_AUTHORING.md`：首次写脚本看 **Start and observe**、**Lifecycle: start, wait, result**（含可运行的 JS/Python 回归范例）、**Calls and assertions**；命令准入看 **Capability selection**；采集或暂停需求再读对应章节。
- `docs/EVIDENCE_ARCHIVE.md`：需要记录、导出或离线校验时读取，包含文件范围与 coverage 的具体边界。

- `docs/RESPONSE_EXTRACTION.md`：单次提取、两语言源码、正文预算、失败后原 ref 重读及退出码。
