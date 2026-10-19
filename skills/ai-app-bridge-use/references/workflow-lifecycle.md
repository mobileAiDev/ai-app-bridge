# Intent / Script 执行与恢复

以下细节按需读取；设备/App 操作的默认入口与例外以 [SKILL.md](../SKILL.md) 为准。文中的 `docs/` 路径相对已安装 CLI 发布包根目录，定位方法见 SKILL.md 的“按需参考”。

## Intent

已有字段、目标和结果判断方式时，可用 `start {mode:"autonomous",agentModule:"/absolute/policy.cjs",background:false,...}`，由现有 Intent 在一次调用内连续执行。模块导出 `decide(input)`，输入含当前 revision、summary、lastAction 和 observationFailure，返回下述 decision；根据当前结果决定下一步、等待或结束。命令动作默认不重采树，需要新页面事实时再观察。模块可以执行普通本地 JavaScript；不要求每次 decide 都请求模型。模块接口与完整 start 形状见 `COMMAND_CONTRACT.md` **Run a known sequence in one Intent call**。按流程规模显式设置 budget，耗尽或需要干预时保留原 operationId 继续处理。

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
当前页的目标和判断方式明确后，优先用 `source` 内嵌普通代码和 `waitMs:60000` 连续执行；长期复用再保存 `sourcePath`。直接调用现有 MCP `run` 或 CLI，无需另写 RPC 控制器或 JSON 流程解释器。陌生页面也可在代码里观察、等待和处理已识别分支，不必先发现整个流程。页面暂时为空时在本地有界等待；只有需要新判断时再 `ctx.askAgent`，任务完成直接 `return`。问题只带待决事项和相关候选，完整回执可用 `recordingDir` 留存。
它在完成、需要 Agent 决策或本次等待耗尽时返回；省略 waitMs 默认异步启动。启动 App 后按页面/网络结果等待，`launch-activity` 接纳启动请求不等于页面已可用。普通动作不必每步重读整棵树；需要新状态、节点身份或业务完成条件时再观察，Intent 可用 `observeAfter:false` 保留连续执行能力。
Script 默认提供全部注册命令；显式 permissions 才收窄。`ctx.call` 返回 envelope：先检查 `ok`，设备数据在 `result`；调用失败和 `ctx.assert` 的 verdict 由源码处理。
`ctx.call` 可启动和控制 Intent/Script，也可安装、查询与恢复；缺省继承父 target，显式子 Script target:null 选择 Host。子任务有独立 operationId/期限，父任务停止不会隐式取消子任务。组合调用 Intent start 默认 background:true，先返回接纳状态；按返回 ID 继续 wait/decide/cancel，接纳不表示完成。
Runtime 卡住可先 `runtime {operation:"stop",timeoutMs:5000}`，仍无响应用 `runtime {operation:"force-stop"}`；保留证据，设备结果未知。Script/Intent 内调用这类关闭会返回独立控制器的 controlAccepted/resultPath，再由另一调用确认状态。
可用 `script {operation:"recipes"}` 读配方目录，加 name 读普通 JS 源码和 start 请求；CLI 同样支持，无需先启动 Runtime。android-test-session 在改设置前保存独立恢复文件，取消后可新开 Script 恢复；android-launch-and-wait 启动一次并在设备侧等待标签。填写真实 target/inputs，可直接运行或改源码。`ctx.target` 提供声明目标的副本；Python 同名。更多范围与恢复说明见 SCRIPT_AUTHORING.md。
用原 operationId 查询 `status`/`wait`；每次 `waitMs` 最多 60000，`running` 或 `finishing` 时用上一响应的 `eventSequence` 作为 `afterSequence` 继续等待。
`waiting_for_agent` 是源码的 `ctx.askAgent`：用 `control.pendingQuestion`（或本页 `agent_question_created` 事件）里的 `requestId`/`revision` 调 `decide {...,waitMs:60000}`，或 `cancel`；不要等到超时。先检查 status 再读问题，其他状态下问题可能为空。一次等待超时后继续 `wait`，不重发业务动作。完整 start → wait → result 范例见 `SCRIPT_AUTHORING.md` **Lifecycle: start, wait, result**。
停止后的 checkpoint Script 可由 Agent 在原 `resume` 请求中传 `recovery.checkpoint:{name,state}`，明确选择新的 `ctx.resume()` 状态；适用于中断后先查询原结果、或取消后另选续跑位置。原回执和未知结果保留，具体合同与示例见 `SCRIPT_AUTHORING.md` **Recover a stopped Script**。
中断后可先 `script {operation:"inventory"}` 找需要检查的原操作，再用 `recovery {operationId}` 或源码内 `ctx.recovery()` 读取 checkpoint 之后的命令、标签、派发标记与原回执；这只读取事实，不恢复或重放。调用可附 `ctx.call(command,args,{label:"业务步骤"})`。恢复后再次崩溃仍保留旧恢复边界，成功写入新的 `ctx.checkpoint` 后才推进；缺失记录保持缺失。checkpoint 模式允许 `recordingDir`，每次重启产生独立 attempt，不覆盖前次文件。
`completed` 仅说明源码返回并持久化；status/wait 的 `resultRef` 不是最终值。
start 已返回 `value.result` 时直接检查断言和持久化状态；仅在还没有返回值且存在 `resultRef` 时调用 `operation:"result"`。失败操作若源码返回了诊断也会保留结果，`status:"failed"` 和 `executionError` 仍表示原执行没有成功。读取失败保留错误，不从进度事件拼出返回值。
