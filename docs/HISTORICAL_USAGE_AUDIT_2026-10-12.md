# AI App Bridge 历史使用审查（2026-10-12）

审查基线：`a76302e2bd8b46d417ba29525dac0a01cdeb0b42`（Host 0.4.5）。本轮工作区正在修改；下文把已发布基线、本轮正在修复和后续能力建议分开，不把代码改动当成真机验收结果。

**主要问题是工具把观察不确定性、历史结果不确定性和“不能执行下一步”混在一起；另有不少能力已经存在，却需要 agent 查 schema、查源码甚至反编译才能用到。** 用户需要的方向在历史中一直很清楚：Bridge 提供动作、观察、回执、证据和控制能力，agent 决定策略、执行方式以及何时重新观察或重试。[H02][H03][H04]

## 1. 覆盖范围与证据方法

本轮从本机实际会话文件建立索引，并扫描相关项目的整个可访问语料，不只查看当前对话或错误码所在源码。

| 来源 | 范围 | 文件数 | 说明 |
| --- | --- | ---: | --- |
| Codex | `ai-app-bridge` | 505 | 包含主对话、子 agent 和 fork 历史 |
| Codex | `pos-android` | 645 | 检查实际测试、安装、打印、会员等流程中的 Bridge 使用 |
| Codex | `duo` | 62 | 检查真机、云手机、分身、批量启动与安装 |
| Codex | `pda/pos-pda` | 3 | 检查接入与 H5/网络诊断 |
| Cursor | 上述四个项目 | 282 | 分别 35、224、10、13 个 transcript |

Codex 索引共 1,215 个文件，创建时间覆盖 2026-08-02 至 2026-10-12，约 14.5 GB；其中 237 个标记为用户对话、976 个为子 agent、2 个为审查任务。当前审查对话 `01a12da6-6033-7173-9fe7-e742dd6e137d` 不作为独立历史证据。Cursor 中本次引用的实际历史最早到 2026-07-22。

方法及边界：

1. 对全范围进行项目、角色、时间、原始用户反馈及工具调用筛选；按文本哈希去除重复转录的用户内容。对子 agent 委派词和用户原话分开判断。
2. 追踪相关问题链的用户要求、实际调用、返回的结构化错误、后续绕行与恢复；本报告列出可定位的代表性原始记录。没有逐字重审所有不相关业务讨论。
3. Codex 的原始工具结果可检查 `execution.ok/error/dispatched/ambiguous`。错误码出现在源码、测试夹具、读取旧日志、成功响应里的 `foreground` 观察字段时，不计为一次真实命令失败。筛选得到的错误码命中数不作为缺陷数量或误报率。
4. 本次 Cursor transcript 导出保留用户、assistant 和 `tool_use`，没有同等完整的 `tool_result`。因此 Cursor 可证明“发出了什么调用”“用户怎样纠正”和“agent 如何描述结果”；单独的 assistant 总结不升级为独立实测证明。涉及当前缺陷时再与源码、Codex 回执或已有验收材料交叉核对。
5. 只把必要的脱敏摘要、会话 ID、日期和行号写入本文件，不复制账号、登录信息、完整私有对话或业务载荷。没有操作设备，也没有重跑历史业务。

## 2. 先还原用户原本要的产品

这些不是本轮新发明的目标：

| 历史要求 | 现在应保留的产品含义 | 证据 |
| --- | --- | --- |
| 8/12：点击后不知道是否成功，希望有点击响应 | 把“请求已派发”“执行器返回”“页面/业务达到预期”分别说明。增强信息，不用后两项代替前一项的事实 | [H01] |
| 8/31：安装流程太死板；确认按钮可能延迟出现，agent 应通过 Intent/Script 处理 | 安装器提供状态与动作入口；不要把所有厂商安装流程写成固定按钮、固定动作白名单 | [H02] |
| 9/1–2：Script 默认连续运行；应支持 JS/Python、持续进度、主动介入和向 agent 请求决策 | 自动化能力和人工/agent 介入同时存在，由调用者选择。不要为每一步增加必须暂停的流程 | [H03] |
| 9/2：在正确前提下减少不必要往返；不能为快就不要树和截图 | 省重复采集、重复传输和重复决策；按需提供证据和引用，不隐去关键状态 | [H05] |
| 9/8、9/12：Intent/Script 是一等公民；Script 是提供者，不是限制者 | 单步有的能力应能编排；限制应来自显式配置或真实执行条件，而非另一套默认永久拒绝表 | [H04] |
| 9/18：曾明确要求 `extract` 必填，防止大树和网络灌满上下文 | 必填不是凭空增加的。当本轮改回便利的默认值时，应保留预算、按 ref 回看与执行事实，不能恢复为无上限输出 | [H08] |

历史也反复提醒不要把全部精力放在存储损坏、容量边界和形式契约上：这些是基础，核心仍是把复杂 App 的日常操作和连续测试跑顺。[H04]

## 3. 已经修过的项：不能重新当作当前缺陷

| 历史问题 | 当前基线的处理与剩余边界 |
| --- | --- |
| 9/14 UIA 死进程重启被旧 `nodeRef` 回执审计挡住；API 25 被排除 | 0.3.5 修复原绑定读取和 API 25 支持。见 [0.3.5 交接](RELEASE_HANDOFF_0.3.5_2026-09-14.md)。本轮 `binding.warnings` 又触发同类启动事故，说明“审计记录能否让执行器不可用”这一设计仍需改。[H06][H20] |
| 9/15 持续 UI 指纹观察占主线程 | 0.3.6 已改为默认关闭、显式限时窗口和 Flutter 按需读取。当前 `AndroidUiObserver.active` 初值仍为 false。不能沿用旧 A/B 数字指控新版持续满载；应保留默认空闲开销回归。见 [0.3.6 交接](RELEASE_HANDOFF_0.3.6_2026-09-15.md)、[观察性能评估](UI_OBSERVER_PERFORMANCE_ASSESSMENT_2026-09-15.md)。[H07] |
| Script 异常只剩 message、stderr 被丢弃；prepare 兼容性报错难懂 | 0.4.0 改善已有异常类型、源码位置、受限 stack/stderr，以及 Android prepare 的实际/要求工具链信息。当前 `script-session-channel.js` 保留 stderr，不能继续按旧描述说完全没有诊断。见 [M3 交付](IMPROVEMENT_RELEASE_V1_M3_2026-09-19.md)。[H09][H10] |
| iOS 只读 observation 被记为 mutation 后解不开；提取 cleanup 覆盖成功结果 | 0.4.1 已修具体 marker/reconcile 及 cleanupError。见 [0.4.1 交接](RELEASE_HANDOFF_0.4.1_2026-09-19.md)。这不等于所有未知执行和恢复路径都已解决。[H08] |
| 原 agent 消失、旧 QQ 操作 unresolved 后永久挡安装/点击 | 0.4.2 已提供公开 `device-ownership force-stop`，而且在普通 Runtime/版本检查/队列之前执行。不能说现在完全没有强停。其影响范围包括相关共享 Host 与记录中的 App，需要再提供更细的 UIA 恢复和清楚影响说明。见 [0.4.2 交接](RELEASE_HANDOFF_0.4.2_2026-10-06.md)。[H14] |
| K2 `WM.LayoutParams` 解析失败，以及前台 mismatch 阻止绑定动作 | 0.4.5 已修解析，并把 Android 前台事实改为 advisory。当前 `android-foreground-feedback.js` 返回 observations/warnings，不决定动作准入。见 [0.4.5 交接](RELEASE_HANDOFF_0.4.5_2026-10-08.md)。现场仍可能加载旧 MCP，必须核对实际两侧版本。[H16][H17] |

上述“已修”来自当前源码与明确的历史发布/验收记录，不表示本轮重新执行了对应真机测试。

## 4. 仍有实际影响的设计问题

### 4.1 历史记录维护不应决定新执行器能否启动

9/14 和 10/12 是两次不同字段触发的同类事故。10/12 的 Cursor 流程从用户追问恢复开始，到重启成功前，记录了 **49 个工具调用**（24 个 Shell、18 个 Read、4 个 Grep、2 个 Bridge 调用、1 个工具加载），包括解压并反编译已安装 dex，最后通过 `require(...uia-runtime-port).forceStop()` 调内部接口才恢复。[H20]

这个数字是 transcript 行 49–89 的调用出现数，不是耗时或 49 次独立故障。但它足以说明公开恢复路径的发现成本不合理。

改进：新 epoch 的可用性与旧历史维护分离；保留原始未知记录，返回维护警告与归档引用。公开 UIA 级 `status/start/stop/force-reset`，错误直接携带当前 serial 的合法下一步。正常恢复不应要求读源码或反编译，更不应默认扩大到整台设备/共享 Host 的强停。

本轮工作区已修改 `UiaJournal.prepare` 的处理，并开始暴露 UIA `force-reset`；这是待本轮验收的变更，尚非公开版本能力。

### 4.2 “旧动作未知”不应无限污染后续独立工作

云手机对 `duo-adb-transfer/v1` 遗留记录调用公开 reconcile 后仍返回 `device_ownership_unresolved`；另一个用户对话明确问“换一个 agent 怎么就永久卡死”。Duo 后续实际 `install-apk` 也有 ownership 拒绝。[H13][H14][H15]

需要分清三个事实：仍在执行的占用者、已消失但效果未知的动作、无法读取/维护的记录。只有第一类需要实际调度冲突处理；后两类应允许 agent 查看原记录，归档/重置或明确发起新的动作。允许新动作不能把旧结果改成成功，也不能偷偷重放它。

本轮工作区正在把历史 unknown 归档并随新动作返回警告；真实活锁仍应给 owner、operationId、开始时间、可用的等待/取消/强停入口。不要把“owner 活着”和“历史文件写着 pending”都命名成同一不可解释的 busy。

### 4.3 UIA 把局部观察失败升级成整页不可读

0.4.5 之后的 Duo 原始回执仍能看到：`uia_focused_root_unavailable`、`uia_tree_changed`、`uia_focused_window_unavailable`、`uia_reobserve_required`。其中前三类发生在 `uia-tree` 观察本身，错误文案多为 Java `Wire$Failure` 加同一错误码。[H18]

改进：返回仍可读取的窗口/节点，明确 `truncated`、覆盖范围、缺失部分和时间；agent 选择继续利用、重新观察或截图。焦点未知应作为观察事实。动作引用失效则清楚区分“原节点确实不存在”和“某个非身份属性变化”，附重新取目标的入口。

本轮工作区已开始调整 `UiaNodes` 的部分树交付与属性变化处理。后续验收应包含动画、键盘、系统弹窗、非焦点窗口和读取过程中子节点消失，不能只测固定完整树。

### 4.4 选择控件需要帮助消歧，而不是把寻找答案再推回 agent

精确匹配“同意”本来就不应匹配包含“同意”的长段说明；不能把两者描述成必然冲突。真正需改善的是：重复的精确标签、显式 contains 查询、可点击父节点、输入框的非点击子标签，以及匹配失败后没有候选和下一步。

历史里出现过按已观察 `targetRef` 点击却得到 `uia_reference_selector_mismatch`，也有点击“请输入手机号”得到 `uia_target_not_operable`。这证明只给一个错误码不足以指导 agent，但单条失败本身不能证明目标应该可操作。[H12][H18]

建议统一返回小而充分的候选：原文、角色/类、resource ID、可见/启用/可点击状态、bounds、所属窗口、可引用的节点身份及合法选择请求。相同标签的多个对象保留各自身份，不按展示文字去重。不擅自点第一个；让 agent 在同一返回里拿到可继续执行的选择。

本轮工作区已经加入多平台候选和 UIA 部分匹配入口；仍需验证候选建议的命令与该平台、动作类型和公开 schema 完全一致。

### 4.5 同一个能力，在 Script 或特定工作流里又被另一套默认策略拒绝

用户早已明确允许 agent 写任意 JS/Python，并把 Script/Intent 当一等入口。[H03][H04] 但本轮基线的 Script 存在默认/永久拒绝表，Intent 自主动作默认只有 tap，安装工作流另限制点击格式。

改进：按真实 adapter 能力暴露支持情况；调用者显式给 permissions/allowlist 时尊重该配置，缺省不额外禁止支持的命令。尚未接入 Script 的 workflow 应说明“适配未实现”和可用入口，不能伪装为风险禁令。流程验证保留为独立结果，不把它扩展成无关动作的永久禁令。

本轮工作区已移除默认永久拒绝、放宽缺省 allowlist 和安装动作限制。完整验收应覆盖普通命令、Script、Intent、安装/权限流程之间是否仍有不一致门禁。

### 4.6 提示要告诉 agent 哪一层坏了，并给当前参数可执行的修正

10/8 的真实 `runtime_code_mismatch` 是 MCP client 0.4.4 对 Runtime 0.4.5，`outdatedSide=client`。重启正确版本的 Runtime 不能刷新已加载的 client。[H17]

另外，Cursor 实际有把 `capabilities` 放进 `run.command`，以及 Script `waitMs=90000` 超过 60000 的调用。[H11] 这些都是可以通过短提示避免重复查大 schema 的错误。

建议有明确补救时才增加 guidance：

- 参数错误：字段路径、收到的值、有效范围、最小修正请求。例如 `waitMs:60000`，不要只报 invalid request。
- 版本错配：列实际 client/runtime 身份，明确过旧一侧；旧 client 提示重连该 MCP 连接，旧 Runtime 才给 Runtime 重启入口。同版本不同指纹不要猜谁旧。
- 观察失败：说明当前仍可读的证据，给 observe/screenshot 或指定窗口入口。
- 选择失败：给候选及合法选择请求。
- 执行器离线/锁冲突：给诊断对象及确切恢复范围。
- 提取/交付失败：明确动作结果未因此改变，给已有 response ref 的读取/提取请求，避免再次执行动作。

没有补救可做的真实平台错误只需报告事实，不要给每个错误附长教程或不相关强停建议。

## 5. 效率与能力可以继续扩展的地方

| 改善方向 | 实际历史支撑 | 适合的设计与边界 |
| --- | --- | --- |
| 统一 ADB 执行入口 | POS 会员测试 UI 用 Python 串 Bridge CLI，接口核验另用 ADB + `toybox nc` 从手机网络发请求；云端自定义传输另有生命周期问题。[H09][H13] | 提供明确 serial 的参数数组入口，覆盖 shell/exec-out、pull/push、forward/reverse、am/pm/dumpsys；支持 stdout/stderr、退出状态、耗时、文件/ref、超时/取消和历史。不要给设备级命令强塞 packageName，也不要将退出码 0 宣称为 UI/业务成功。具体命令由 agent 决定。 |
| 少写一层 Python/JS 外壳 | 9/17 agent 明确说没有使用 Bridge Script，而在本机 Python 做串联/JSON 筛选。[H09] | 提供可直接运行的 JS/Python 小范例：连续动作、观察后分支、网络/日志断言、异常 askAgent、checkpoint、收尾。让 ctx.call 的设备上下文、原始返回、提取视图和错误含义稳定。不要强迫用户把任何一次操作都改成 Script。 |
| 等待和结果的公共合同更省事 | Cursor POS 导出中有 28 个 Script start、216 个 wait、4 个 result 的调用出现数；10/12 等待又手写多版 envelope unwrap/字段映射。[H11][H20] | 统一紧凑进度、operationId/eventSequence、下一次 wait 参数；只在新事件/状态变化返回有意义内容；终态响应直接携小结果或结果 ref。保留单独 result 供重连后读取。这些出现数含重复记录，不能据此宣称每个脚本用了某个固定轮数。 |
| 默认返回兼顾易用和上下文成本 | `extract` 的直接动因就是树/网络太大；旧离线样本的展示筛选减少约 93% 字节，但不等于采集提速。[H08][H09] | 允许省略无意义的 `extract:null`；保留预算、控制事实和 response ref。提供常用字段选择/摘要选项，调用者仍可写任意提取逻辑。区分采集截断、显示提取、交付超预算，不用一个 ok 混淆三者。 |
| provider/窗口发现一次返回足够信息 | 9/1 用户纠正“抓树之前猜 Flutter 还是 UIA”；9/29 分身窗口 package 被误当独立进程。[H05][H19] | 发现结果同时提供可用 provider、原因、窗口/进程所有者和建议命令，允许显式选择。保留 declared package、window package、owner UID/PID、预期 package 的区别；未知就标未知，不补成期望值。 |
| 公开的一次诊断 | UIA 恢复要查内部记录和 dex；多次 SDK/插件/工具链漏接或兼容差异。[H06][H10][H20][H21] | 统一 doctor/inspect 可汇总实际 CLI/MCP/Runtime/SDK 版本、执行器活性、占用、转发、设备 API/工具可用性、安装/接入状态、原始证据 ref 和建议下一步。诊断本身不应被故障动作队列挡住。避免每次正常动作都重复完整诊断。 |
| 设备测试会话的准备与还原 | 10/7 用户追问 Bridge 是否应防锁屏；历史有重新开机后必须首次解锁的场景。[H22] | 可选会话准备：屏幕是否亮、keyguard/首次解锁状态、保持唤醒策略、当前键盘/旋转；提供显式可恢复设置。真正需要用户解锁时说明原因，别让它表现成未知 UIA 故障。当前公开命令没有完整的测试会话准备入口。 |
| 控制长期使用的证据成本 | 用户反复要求快，同时要求流程、进度和证据不丢。[H02][H03][H05] | 长流程优先 Script 本地执行、增量取日志/网络、复用观察引用；截图/完整树按需取得。保留可见的 coverage 与变化信息，避免为了少输出静默丢 checked、disabled、窗口身份或多个同名节点。保持持续 UI 观察默认关闭。 |

这些是从真实使用摩擦推导的能力建议，不能声称每项已有完整实现。尤其是统一 ADB、一次诊断和会话准备，需要完整覆盖异步取消、二进制输出以及 CLI/MCP/Script 的同一生命周期；只加一条 shell 包装命令不足以宣称统一完成。

## 6. 用历史问题验收改善效果

建议把以下场景固定成公开入口的回归用例，并分别记录工具耗时、模型往返、返回字节、恢复调用数和最终业务证据。不要只用单位测试数量表示易用性或效率。

| 场景 | 应满足的结果 |
| --- | --- |
| 一行按钮“同意”与长说明含“同意”；再增加两个同名按钮 | 精确/包含语义明确；同名返回候选；使用某个返回引用能选择指定对象，不需重新猜或完整重抓树 |
| 系统安装器/权限页/键盘/分身窗口与预期 App 包不同 | 前台事实完整返回，动作是否执行由实际目标与调用请求决定，不因外部包名直接否决 |
| UIA 旧进程死亡，历史带新诊断字段；旧动作未知 | 启动/明确重置可通过公开入口完成；不需要内部 require、手删文件或反编译；旧动作保持 unknown/原终态 |
| 动画或局部节点变化，焦点 root 暂不可用 | 可用观察不丢；缺失范围透明；对仍有效节点的选择和重新观察有可执行入口 |
| 单步、Script、Intent 调同一支持的动作 | 缺省能力一致；只有调用者显式限制时才产生权限拒绝；未适配能力如实说明 |
| 长脚本正常运行，随后新 agent 接手 | 能从 operationId 查询紧凑进度、原回执和结果；暂停、取消、继续、新执行都有明确入口，不重放未知动作 |
| MCP client 旧、Runtime 新，以及反向错配 | 错误准确指出旧的一侧，给该侧的修复提示；不能统一建议重启 Runtime |
| 错 command 层级、超范围 wait、输出超预算 | 一个错误响应足够修正；提取失败后通过 ref 取结果，不再执行原动作 |
| 设备网络诊断/文件传输需 ADB | 在 Bridge 内获得原生输出与生命周期；命令退出状态和业务效果明确分开，设备级命令无需无关 App 身份 |
| 安装 SDK 后空闲，以及仅运行简单回归 | 默认没有持续高频 UI 遍历；有需求时才启观察。用当前版本重新量测，不能引用旧性能数字当新结果 |

优先级：先解决启动/恢复、旧 unknown 污染、部分观察与选择提示；同步统一默认权限和错误补救。其后完善 ADB、等待/结果便利层和一次诊断，再做长期会话准备及更精细的性能优化。所有阶段都用真实工作流验证“agent 可以继续工作”，不把继续执行误写成业务已成功。

## 7. 与当前实现对应的位置

这些是本次只读交叉核对的入口；链接打开的是工作区当前内容。基线行为以文首提交和历史发布记录为准，本轮修改的最终结果以对应测试报告为准。

| 主题 | 源码 / 合同入口 |
| --- | --- |
| 前台事实与动作结果分离 | [android-foreground-feedback.js](../desktop/ai-app-bridge-cli/bin/shared-kernel/android-foreground-feedback.js) |
| UIA 历史审计、启动及强制归档 | [UiaJournal.java](../android/ai-app-bridge-uia/src/main/java/io/github/mobileaidev/aiappbridge/uia/UiaJournal.java)、[uia-runtime-port.js](../desktop/ai-app-bridge-cli/bin/shared-kernel/uia-runtime-port.js) |
| UIA 窗口、部分树、引用与目标属性 | [UiaNodes.java](../android/ai-app-bridge-uia/src/main/java/io/github/mobileaidev/aiappbridge/uia/UiaNodes.java)、[uia-target.js](../desktop/ai-app-bridge-cli/bin/shared-kernel/uia-target.js) |
| 设备占用与未知历史 | [device-mutation-lease.js](../desktop/ai-app-bridge-cli/bin/shared-kernel/device-mutation-lease.js)、[device-ownership-store.js](../desktop/ai-app-bridge-cli/bin/shared-kernel/device-ownership-store.js) |
| 命令发现、Script 支持与权限 | [command-registry.js](../desktop/ai-app-bridge-cli/bin/command-registry.js)、[script-catalog.js](../desktop/ai-app-bridge-cli/bin/script/script-catalog.js)、[execution-contracts.js](../desktop/ai-app-bridge-cli/bin/shared-kernel/execution-contracts.js) |
| 工作流另设的动作约束 | [install-intent.js](../desktop/ai-app-bridge-cli/bin/intent/install-intent.js)、[permission-intent.js](../desktop/ai-app-bridge-cli/bin/intent/permission-intent.js) |
| 提取请求、预算与结果事实 | [command-request.js](../desktop/ai-app-bridge-cli/bin/command-request.js)、[public-reply.js](../desktop/ai-app-bridge-cli/bin/public-reply.js)、[extraction/runner.js](../desktop/ai-app-bridge-cli/bin/extraction/runner.js) |
| Script 诊断、暂停/继续与进度 | [script-session-channel.js](../desktop/ai-app-bridge-cli/bin/script/script-session-channel.js)、[script-supervisor.js](../desktop/ai-app-bridge-cli/bin/script/script-supervisor.js) |
| 默认空闲观察成本 | [AndroidUiObserver.kt](../android/ai-app-bridge-android/src/main/kotlin/io/github/mobileaidev/aiappbridge/android/AndroidUiObserver.kt) |

## 8. 原始证据索引

以下链接指向本机已有会话，不随仓库分发；会话 ID、日期和行号用于复核。行号为本次扫描的 JSONL 物理行，长对话含后续日期。

| ID | 日期 / 会话 | 本次实读位置与用途 |
| --- | --- | --- |
| [H01] | Cursor，2026-08-12，`a00963c6-5352-4fa8-a43b-d0fecca23cc6` | L1：用户原始点击回执需求 |
| [H02] | Codex，2026-08-31，`01a04dd8-ffa3-7bf2-ad55-5c6cd29ee87c` | L18531–18545 安装流程；L20465–20676 agent 选择执行器和可查询事实；L26515 核心流程优先 |
| [H03] | Codex，2026-09-01–02，`01a059f1-f9f4-73e1-aa3f-ddd17bc4c137` | L11672 默认不暂停；L15667–15766 JS/Python、进度、介入与工作流非硬编码要求 |
| [H04] | Codex，2026-09-08–12，`01a0743b-4739-7dd0-9132-10da349b2525` | L20811 一等入口；L45942 核心能力优先；L74179 提供者而非限制者；L75590 按需加载引导 |
| [H05] | Cursor，2026-09-01–04，`496c727a-417e-4616-a01c-305bfff50a51` | L195 provider 不应猜；L576 效率反馈；L2356 正确前提下降低往返；L6426/6702 不应无限卡同一局限 |
| [H06] | Codex，2026-09-14，`01a09ed0-7301-7622-8fca-670aeface982` | L9 旧 nodeRef 死 runtime 事故描述；与 0.3.5 修复交接交叉核对 |
| [H07] | Codex，2026-09-15，`01a0a04d-6537-7453-921d-e6f954a8f5c4` | L4848 性能反馈；L4921 三种优化方向；L4962 当时触发周期源码结论；与 0.3.6 交接交叉核对 |
| [H08] | Codex，2026-09-17–19，`01a0ae93-0f11-7dc2-8c0f-cb19c19dad03` | L215 既有使用审查；L226 extract 必填原始要求；L6104 iOS/提取问题复核要求 |
| [H09] | Codex，2026-09-17，`01a0ae40-be12-7062-875a-a987fbb774af` | L541/577 用户追问；L546/570/623 agent 描述 Python 串 CLI、设备网络绕行及 Script 使用不足 |
| [H10] | Codex，2026-09-16，`01a0a83e-efcb-7691-a773-b73175061a98` | L9 compileSdk 33 与 UI Automator 需求冲突；与 M3 preflight 修复交叉核对 |
| [H11] | Cursor POS，2026-09-16–17，`7c0c5428-26ce-40ed-9323-1b35b998ad79` | L47 waitMs=90000；L216 错把 capabilities 放 run；L1329 Python Script；全 transcript 统计调用出现数 |
| [H12] | Codex Duo，2026-10-02，`01a0fa7e-05a8-7720-b483-1b93fc7184a6` | L754/L1676/L4365 以观察引用点击的实际 mismatch 回执 |
| [H13] | Codex Duo，2026-10-05，`01a10b03-7741-72f1-8d88-5d3096a24310` | L12 云手机遗留传输恢复需求；L85 公开 reconcile 实际 unresolved 回执 |
| [H14] | Codex，2026-10-06，`01a10e75-6a15-76c0-8110-c8f8d4ec9b40` | L12 用户对永久占用、换 agent 和强制解除的明确反馈 |
| [H15] | Codex Duo，2026-09-24–27，`01a0d1e1-62e8-7cb0-b2c3-f0f907da3923` | L304 launch 已派发却报 foreground mismatch；L10487 install-apk ownership 拒绝；L23282 观察期 foreground_changed |
| [H16] | Codex POS，2026-10-08，`01a11a1c-3323-7883-b5dc-de0293977054` | L724/L1030/L1110 tap-native 实际 foreground_probe_failed，dispatched=false；L1045 用户问是否旧版本 |
| [H17] | Codex，2026-10-08，`01a11a8d-e7ff-7a12-8837-17e913f8143e` | L1224/L1309 已安装新 Runtime、仍连旧 MCP 的真实 code mismatch；与 0.4.5 交接最终重连结果交叉核对 |
| [H18] | Codex Duo，2026-10-10–11，`01a12617-8694-7542-8284-ca90980bbd9b` | L585 root unavailable；L9090 tree changed；L13446 focused window unavailable；L19532/L19853 target not operable；L24530 reobserve_required 实际回执 |
| [H19] | Cursor Duo，2026-09-29，`6ba82b80-654d-4b0c-babb-ebd7bd678d1b` | L325 用户要求直接看页面；L326–350 多次恢复/ADB 绕行；L347 用户纠正把分身窗口误判为独立 App |
| [H20] | Cursor Duo，2026-10-12，`37f607d5-f699-49de-befb-6f7c37886cf4` | L40–42 手写 wait 提取；L48 用户追问恢复；L49–89 的49个工具调用；L87 内部 forceStop；L90 恢复总结。与当前 UIA Journal 源码及本轮复现交叉核对 |
| [H21] | Cursor PDA，2026-07-22，`1a906731-8553-4335-90b0-4948062b5ae7` | L28 用户纠正只接 runtime 漏 Gradle plugin；不转录该对话中的登录信息 |
| [H22] | Codex Duo，2026-10-07，`01a103db-6b0a-7d52-8757-72a4b35ab238` | L61439 用户询问防锁屏能力；作为会话准备能力建议的需求依据，不宣称系统加密可自动绕过 |

[H01]: /Users/macbook/.cursor/projects/Users-macbook-Documents-CompanyProject-ai-app-bridge/agent-transcripts/a00963c6-5352-4fa8-a43b-d0fecca23cc6/a00963c6-5352-4fa8-a43b-d0fecca23cc6.jsonl:1
[H02]: /Users/macbook/.codex/sessions/2026/08/29/rollout-2026-08-29T22-07-42-01a04dd8-ffa3-7bf2-ad55-5c6cd29ee87c.jsonl:18531
[H03]: /Users/macbook/.codex/sessions/2026/09/01/rollout-2026-09-01T06-30-25-01a059f1-f9f4-73e1-aa3f-ddd17bc4c137.jsonl:11672
[H04]: /Users/macbook/.codex/sessions/2026/09/06/rollout-2026-09-06T09-00-37-01a0743b-4739-7dd0-9132-10da349b2525.jsonl:74179
[H05]: /Users/macbook/.cursor/projects/Users-macbook-Documents-CompanyProject-ai-app-bridge/agent-transcripts/496c727a-417e-4616-a01c-305bfff50a51/496c727a-417e-4616-a01c-305bfff50a51.jsonl:2356
[H06]: /Users/macbook/.codex/sessions/2026/09/14/rollout-2026-09-14T15-27-36-01a09ed0-7301-7622-8fca-670aeface982.jsonl:9
[H07]: /Users/macbook/.codex/sessions/2026/09/14/rollout-2026-09-14T22-23-41-01a0a04d-6537-7453-921d-e6f954a8f5c4.jsonl:4921
[H08]: /Users/macbook/.codex/sessions/2026/09/17/rollout-2026-09-17T16-54-28-01a0ae93-0f11-7dc2-8c0f-cb19c19dad03.jsonl:226
[H09]: /Users/macbook/.codex/sessions/2026/09/17/rollout-2026-09-17T15-24-33-01a0ae40-be12-7062-875a-a987fbb774af.jsonl:546
[H10]: /Users/macbook/.codex/sessions/2026/09/16/rollout-2026-09-16T11-24-52-01a0a83e-efcb-7691-a773-b73175061a98.jsonl:9
[H11]: /Users/macbook/.cursor/projects/Users-macbook-Documents-CompanyProject-pos-android/agent-transcripts/7c0c5428-26ce-40ed-9323-1b35b998ad79/7c0c5428-26ce-40ed-9323-1b35b998ad79.jsonl:47
[H12]: /Users/macbook/.codex/sessions/2026/10/02/rollout-2026-10-02T10-42-38-01a0fa7e-05a8-7720-b483-1b93fc7184a6.jsonl:754
[H13]: /Users/macbook/.codex/sessions/2026/10/05/rollout-2026-10-05T15-42-18-01a10b03-7741-72f1-8d88-5d3096a24310.jsonl:85
[H14]: /Users/macbook/.codex/sessions/2026/10/06/rollout-2026-10-06T07-45-38-01a10e75-6a15-76c0-8110-c8f8d4ec9b40.jsonl:12
[H15]: /Users/macbook/.codex/sessions/2026/09/24/rollout-2026-09-24T13-26-44-01a0d1e1-62e8-7cb0-b2c3-f0f907da3923.jsonl:10487
[H16]: /Users/macbook/.codex/sessions/2026/10/08/rollout-2026-10-08T14-03-38-01a11a1c-3323-7883-b5dc-de0293977054.jsonl:724
[H17]: /Users/macbook/.codex/sessions/2026/10/08/rollout-2026-10-08T16-07-50-01a11a8d-e7ff-7a12-8837-17e913f8143e.jsonl:1224
[H18]: /Users/macbook/.codex/sessions/2026/10/10/rollout-2026-10-10T21-53-58-01a12617-8694-7542-8284-ca90980bbd9b.jsonl:585
[H19]: /Users/macbook/.cursor/projects/Users-macbook-Documents-project-duo/agent-transcripts/6ba82b80-654d-4b0c-babb-ebd7bd678d1b/6ba82b80-654d-4b0c-babb-ebd7bd678d1b.jsonl:325
[H20]: /Users/macbook/.cursor/projects/Users-macbook-Documents-project-duo/agent-transcripts/37f607d5-f699-49de-befb-6f7c37886cf4/37f607d5-f699-49de-befb-6f7c37886cf4.jsonl:48
[H21]: /Users/macbook/.cursor/projects/Users-macbook-Documents-CompanyProject-pda-pos-pda/agent-transcripts/1a906731-8553-4335-90b0-4948062b5ae7/1a906731-8553-4335-90b0-4948062b5ae7.jsonl:28
[H22]: /Users/macbook/.codex/sessions/2026/10/04/rollout-2026-10-04T06-21-13-01a103db-6b0a-7d52-8757-72a4b35ab238.jsonl:61439
