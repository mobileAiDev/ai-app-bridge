# Script / Intent 隔离重建计划

> 状态：执行任务书
> 适用对象：Grok、Cursor Agent、Codex 或其他实现代理
> 核心规则：严格按阶段执行；当前阶段 Gate 未通过时停止，不进入下一阶段。

## 1. 目标

在当前稳定基线上，只新增两个 MCP command：

- script
- intent

最终需要同时满足：

1. 对外仍然只有 capabilities 和 run，所有现有命令的名称、参数、返回、错误和 Batch 行为保持不变。
2. LegacyDispatcher 只负责隔离并转发现有命令，不承担新业务逻辑。
3. Script 是全新执行链，不调用旧 Batch、LegacyDispatcher 或 Intent。
4. Intent 是全新执行链，不调用旧 Batch、LegacyDispatcher 或 Script。
5. Script 和 Intent 使用各自独立的 worker、runtime、executor、state 和 EvidenceStore Interface。
6. 新 Script/Intent 的动作必须有已经持久化的证据、plan/decision 和 dispatch marker。
7. page-summary 是对已有 tree 的毫秒级纯转换，不负责采集。
8. 不引入 UiA2；Android 黑盒语义观察使用当前已有 UIA。
9. 并发边界与旧版一致：同一 `(serial, packageName)` 同一时刻最多一个设备操作；同一 serial 的不同 package 允许并行。
10. Script、Intent 或落盘系统的故障不能影响任何现有命令。
11. Script 固定流程应通过减少 Agent 往返获得可量化提速。
12. Intent 同时支持监督模式与自主模式，业务结论始终由 Agent 给出。

## 2. 开工前基线

预期但必须现场核对：

- 仓库：/Users/macbook/Documents/CompanyProject/ai-app-bridge
- 分支：dev
- 预期 HEAD：3b33e9e
- 预期存在失败实现 stash：stash@{0}
- 预期未跟踪文件：flutter/ai_app_bridge_flutter/pubspec.lock

开始前执行只读检查：

~~~bash
git status --short --branch
git log -1 --oneline --decorate
git stash list
git diff --stat
adb devices -l
~~~

执行约束：

- 保留当前用户文件和未跟踪文件。
- 失败 stash 只作只读参考，不整体恢复或应用。
- 不执行 destructive Git 命令，不自动 commit 或 push。
- 最多使用一个只读研究子代理；主代理负责所有代码修改和最终核验。
- 不使用 evidence-driven-qa skill。
- 不使用旧 ai-app-bridge-use 或旧 MCP 实例。
- 测试 MCP 必须从当前 worktree 启动，并记录 HEAD、PID 和端口。
- 只停止自己启动的精确 MCP PID，不触碰 ADB server 或手机辅助包。

完成标准：输出真实分支、HEAD、dirty files、stash、设备 serial、MCP PID/端口；任何不一致先解释，不带着未知基线开始修改。

## 3. 对外 Interface 与内部分发

### 3.1 对外 Interface

外部仍然是：

~~~text
capabilities
run(command, arguments)
~~~

只允许以下加法：

- capabilities 增加 script
- capabilities 增加 intent
- run(command=script) 可调用
- run(command=intent) 可调用

现有 command 必须保持：

- command 名称和下划线/连字符兼容不变
- 参数和默认值不变
- 返回 JSON 和 isError 行为不变
- Batch 的串行、停止、失败和跳过行为不变
- compact/full/legacy MCP 外观不变
- 不暴露 legacy、legacyMode、第二个 MCP 或第二个外部端口

### 3.2 CommandRouter

~~~text
MCP capabilities/run
        │
        ▼
CommandRouter
├─ command === script
│      └─ ScriptEntry → ScriptWorker → ScriptRuntime
│
├─ command === intent
│      └─ IntentEntry → IntentWorker → IntentRuntime
│
└─ 其他所有 command
       └─ LegacyDispatcher → 当前原有执行链
~~~

script 和 intent 必须使用独立 registry。不得把它们加入旧 commandDefinitions/commandByName，否则旧 Batch 会意外允许嵌套新命令。

### 3.3 LegacyDispatcher

LegacyDispatcher 只是旧代码隔离壳：

- 接收除 script/intent 外的所有现有 command。
- 原样转发给当前实现。
- 不包含 Script/Intent 判断、Evidence gate、Provider 选择、新状态或新重试。
- 调用旧命令时不加载 Script/Intent 代码。
- 新模块加载或运行失败后，旧命令仍可以继续执行。

不要为了“整理架构”搬迁或重写现有执行实现；只建立最小分发 Seam。

## 4. 代码隔离

### 4.1 依赖方向

允许：

~~~text
CommandRouter → LegacyDispatcher
CommandRouter → ScriptEntry
CommandRouter → IntentEntry
~~~

禁止：

~~~text
Script → LegacyDispatcher
Script → 旧 Batch
Script → Intent

Intent → LegacyDispatcher
Intent → 旧 Batch
Intent → Script

Legacy → Script
Legacy → Intent
~~~

### 4.2 建议目录

不迁移旧实现，只新增：

~~~text
desktop/ai-app-bridge-cli/bin/
  command-router.js

  legacy/
    legacy-dispatcher.js

  script/
    script-entry.js
    script-worker.js
    script-runtime.js
    script-compiler.js
    script-executor.js
    script-device-adapter.js
    script-evidence-store.js
    script-errors.js

  intent/
    intent-entry.js
    intent-worker.js
    intent-runtime.js
    intent-observer.js
    intent-action-executor.js
    intent-device-adapter.js
    intent-evidence-store.js
    intent-errors.js

  shared-kernel/
    evidence-schema.js
    semantic-node.js
    summary-transformer.js
    target-lease-protocol.js
~~~

shared-kernel 只能包含纯数据、纯算法和小 Interface，不能演变成隐藏的共同执行器。

### 4.3 可共享内容

允许共享：

- Evidence 数据格式
- 纯 SummaryTransformer
- target/serial 数据类型
- Provider Interface
- 底层稳定 Provider Implementation
- TargetLease 协议

Script 和 Intent 各自定义独立 DevicePort 与测试 Adapter。生产 Adapter 可以调用相同的底层稳定 Provider Implementation，但不能通过旧命令或旧 Batch 间接执行。

如果当前 Provider 缺少合适的底层调用 Interface：优先增加只读、加法式 Adapter；如果必须重写旧 Provider 才能继续，则停止该阶段并报告。

## 5. 落盘与执行证据

必须区分两种 Interface。

### 5.1 HistorySink

用于现有日志和历史：

~~~text
offer(fact)
status()
~~~

不变量：

- 异步、有界、可降级
- 不改变 Legacy 结果
- 不成为旧命令执行前提
- 不调用 ADB、Provider、截图或 UIA

保留当前 segmented store 内核，不整体重做。

### 5.2 EvidenceStore

用于新 Script/Intent：

- 原始观察证据
- page-summary
- Script plan 或 Agent decision
- dispatch marker
- action receipt
- operation revision/checkpoint

不变量：

- 必须持久确认
- 是新执行链的正式门闩
- 持久化失败时不能执行后续动作
- 不影响 Legacy
- Script 与 Intent 使用独立 Interface 和 namespace
- 可以共享同一底层 segmented store Implementation

正确原则：

> 被动历史落盘不能阻塞 Legacy；Script/Intent 的决策证据、plan/decision、dispatch marker 和 action receipt 必须成功持久化，才能推进各自的新执行链。

### 5.3 Evidence 数据

ObservationEvidence 至少包含：

~~~text
evidenceId
namespace                 script | intent
operationId
revision
serial
packageName
provider                  native | uia | flutter | h5
capturedAtMs
foregroundTarget
runtimeEpoch/generation
rawTreeId
summaryId
screenshotId?             可选
checksum
persisted=true
~~~

DecisionEvidence 至少包含：

~~~text
decisionId
operationId
revision
basedOnEvidenceIds[]
actionSpecHash
agentDecision             act | complete | fail | inconclusive
committedAtMs
~~~

DispatchMarker 必须在动作前持久化：

~~~text
actionId
operationId
decisionId/planStepId
target
actionSpecHash
state=prepared
preparedAtMs
~~~

ActionReceipt 至少包含：

~~~text
actionId
startedAtMs
completedAtMs
mechanicalStatus
providerResult
error?
ambiguous
~~~

顺序门禁：

- 原始证据未持久化时，不得向 Agent 暴露可执行 revision。
- plan/decision 未持久化时，不得准备动作。
- dispatch marker 未持久化时，不得执行动作。
- 动作已执行但 receipt 无法持久化时，状态必须为 ambiguous。
- ambiguous 动作不得自动重试。
- evidence revision 过期时返回 reobserve_required。
- screenshot 只有在调用方明确要求时才是必需证据。

## 6. page-summary

不新增顶层 page-summary command。它是纯 SummaryTransformer：

~~~text
已有 raw tree + rawTreeId + 可选 screenshotId
                         ↓
                  线性遍历和裁剪
                         ↓
summary + 原节点引用 + rawTreeId + screenshotId?
~~~

输入只来自已经取得的：

- Native tree
- 当前已有 UIA tree
- Flutter tree
- H5/CDP DOM

摘要至少提取：

- 文本、按钮、输入框
- 图片/可点击图片、可点击元素
- checked/selected/enabled 状态
- bounds、accessibility/semantic label
- 原始节点 ID、rawTreeId
- 已存在时传递 screenshotId

SummaryTransformer 不负责 tree、Provider、ADB、UIA、Flutter/CDP 启动、截图、dumpsys 或后台补证。

性能门禁：

- O(n)
- 5,000、10,000 节点 p95 小于 20ms
- 单次硬上限 50ms
- 默认输出约 64KB 以内
- 相同输入产生确定性相同输出
- 每个摘要节点可以映射回原始节点
- 摘要与原始证据持久化成功后才交给 Agent

## 7. Script

### 7.1 定位

Script 是全新、确定性的连续执行器，不经过旧 Batch，也没有逐步监督模式。

默认行为：

~~~text
created → running → step_completed → next_step → completed
~~~

自动暂停只有执行失败：

~~~text
execution_failure → paused_failure
~~~

Agent 显式请求暂停：

~~~text
pause_requested → 当前设备动作完成或超时 → receipt持久化 → paused_manual
~~~

checkpoint 只持久化恢复点并继续运行，不自动暂停。

### 7.2 外部操作

仍通过一个 script command：

~~~text
script.start
script.status
script.pause
script.resume
script.cancel
script.intervene
~~~

### 7.3 v1 步骤

只实现：

- observe
- action
- assert
- checkpoint

暂不实现：

- 并行
- 自动 retry
- 条件分支和循环
- 任意代码/eval/shell
- 自动 Provider fallback
- 自动截图
- Agent 逐步决策

### 7.4 执行顺序

~~~text
解析并校验 Script
→ 持久化 canonical Script、revision、target、hash
→ observe
→ 持久化 raw evidence + summary
→ action 引用已持久 evidenceRevision
→ 持久化 dispatch marker
→ ScriptExecutor 执行动作
→ 持久化 action receipt
→ assert/checkpoint/下一步
~~~

动作门禁：

- 每个 UI action 必须引用当前 Script 已持久化的 evidence revision。
- node 操作必须最终解析为 rawTreeId + nodeId。
- 坐标操作必须引用 screenshot 或 tree bounds 证据。
- target 管理动作必须引用设备/前台状态证据。
- selector 匹配 0 个或多个节点均视为执行失败并暂停，不能猜测。
- action receipt 未持久化前不能进入下一步。

### 7.5 失败暂停

以下统一进入 paused_failure：

- Provider失败或超时
- 必需证据获取/持久化失败
- selector 无匹配或多匹配
- evidence revision 过期
- foreground/target 不匹配
- dispatch marker写入失败
- action失败或 ambiguous
- action receipt无法持久化
- assert失败
- 步骤或整体超时

返回至少包含：

~~~text
status=paused
pauseReason=execution_failure
failedStepId
error
latestEvidenceIds
lastActionReceipt
recoveryOptions
~~~

### 7.6 checkpoint 与恢复

checkpoint 保存：

~~~text
scriptId
revision
operationId
currentStepIndex
completedStepIds
latestEvidenceRevision
actionReceipts
variables
eventSequence
~~~

checkpoint 后立即继续执行。

resume 前必须：

1. 读取持久 checkpoint。
2. 确认最后 action receipt。
3. 重核 serial/package/foreground。
4. 检查 evidence revision；失效时先重新观察。
5. ambiguous action 等待 Agent 介入，不能自动重放。

Agent 介入允许：

- continue
- abort
- replace_remaining_steps（生成新 revision）
- update_variables
- skip_non_mutating_step
- retry_readonly_step

不得修改已经执行的历史、绕过 Evidence gate 或自动重试 ambiguous mutation。

### 7.7 进度回报

Script 产生递增 sequence 事件：

~~~text
script_started
step_started
evidence_committed
action_prepared
action_completed
assert_passed
checkpoint_committed
pause_requested
paused
intervention_required
resumed
script_completed
script_failed
script_ambiguous
~~~

status 支持 afterSequence 和 eventLimit，避免每次返回完整历史。

## 8. Script 格式

推荐双格式：

- 人工编写：.aabscript.yaml
- MCP 内部 canonical format：严格 JSON

YAML 由 ScriptCompiler 编译为 canonical JSON；真正执行的永远是版本化 JSON。禁止 JavaScript、eval、shell、任意表达式执行和动态 import。

示例：

~~~yaml
apiVersion: aab.script/v1
kind: Script

metadata:
  name: localsend-settings-license
  description: Open Settings, About, and License Notices

target:
  serial: <DEVICE_SERIAL>
  packageName: <PACKAGE_NAME>

execution:
  mode: continuous
  evidencePolicy: required
  onFailure: pause
  checkpointBehavior: persist-and-continue
  maxDurationMs: 120000
  maxSteps: 30

reporting:
  persistEvents: true
  includeTimings: true

variables:
  settingsText: Settings
  aboutText: About
  licenseText: License Notices

steps:
  - id: observe_home
    observe:
      provider: flutter
      require: [tree, summary]

  - id: open_settings
    action:
      name: tap
      basedOn: steps.observe_home.evidenceRevision
      target:
        selector:
          role: button
          text: variables.settingsText

  - id: verify_settings
    observe:
      provider: flutter
      require: [tree, summary]
    assert:
      visibleText: variables.aboutText

  - id: settings_checkpoint
    checkpoint:
      label: settings_opened
      persist: true

  - id: open_about
    action:
      name: tap
      basedOn: steps.verify_settings.evidenceRevision
      target:
        selector:
          text: variables.aboutText

  - id: verify_about
    observe:
      provider: flutter
      require: [tree, summary]
    assert:
      visibleText: variables.licenseText
~~~

编译后的 JSON 必须包含 schemaVersion/scriptId/revision/target/policy/steps/canonicalHash，并在执行前持久化。

## 9. Intent

### 9.1 定位

Intent 是独立的动态 Agent 回合执行器，不调用 Script。

支持两种 Decision Adapter：

~~~text
DecisionPort
├─ SupervisedDecisionAdapter
└─ AutonomousAgentAdapter
~~~

无论何种模式，业务 complete/fail/inconclusive 都由 Agent 给出，IntentRuntime 只判机械状态和证据有效性。

### 9.2 外部操作

~~~text
intent.start
intent.status
intent.decide
intent.pause
intent.resume
intent.cancel
intent.intervene
~~~

### 9.3 监督模式

~~~text
观察
→ 证据持久化
→ page-summary
→ waiting_for_decision
→ 外部 Agent decide
→ 动作
→ 再观察
~~~

用于调试、高风险动作、跨 App、系统设置、权限和 ambiguity。主要目标是安全和可解释，不以显著提速为门禁。

### 9.4 自主模式

~~~text
观察
→ 证据持久化
→ AutonomousAgentAdapter 调用 Agent
→ Agent返回一个动作或终态
→ 动作
→ 再观察
→ 自动循环
~~~

自主模式必须配置：

- maxSteps
- maxDurationMs
- maxAgentCalls
- action allowlist
- target/package 锁定
- evidence freshness
- 需要介入的风险策略

以下情况进入 intervention_required：

- evidence 不完整或 revision 过期
- foreground/target 改变
- 节点无匹配或多匹配
- 动作 ambiguous
- 进入不允许的系统/其他 App
- 请求 allowlist 外动作
- 达到预算
- Provider连续失败

### 9.5 状态机

~~~text
created
→ observing
→ evidence_ready
→ waiting_for_decision / autonomous_deciding
→ decision_committed
→ action_prepared
→ acting
→ receipt_committed
→ observing
~~~

终态：

~~~text
completed
failed
inconclusive
cancelled
ambiguous
blocked_evidence_store
~~~

一次 Agent decision 最多执行一个动作。status 只读状态和证据，不访问设备；cancel 只改变 Intent 状态并结束其自有任务，不 force-stop App、不清数据、不恢复 ADB。

## 10. Provider 策略

本计划不引入 UiA2、Appium UiAutomator2 driver、test package 或 instrumentation。

允许：

- Native/SDK tree
- 当前已有 UIA
- Flutter tree
- H5/CDP DOM
- 显式 screenshot

规则：

- 一次观察只选择一个主要语义 Provider。
- Provider 由 Script observe 步骤或 Intent start 明确指定。
- 不自动并发采集或 fallback。
- UIA 与 screenshot 串行。
- screenshot 只有显式要求时才采集。
- UIA tree 获取一次后在主机摘要，不重复 dump。
- Provider失败返回机械错误，由 Script暂停或 Intent/Agent决定。

## 11. TargetLease 与 ADB 安全

Script、Intent、Legacy 代码隔离，但物理设备是共享资源。使用最小 TargetLease Seam：

~~~text
targetKey = androidAppTargetKey(serial, packageName)
acquire(targetKey)
release(targetKey)
~~~

TargetLease 不理解 command、Script、Intent、Evidence、Provider或业务结果。

规则：

- TargetLease 只供新 Script/Intent 路径使用，不得注入 Legacy 执行器。
- 同一 `(serial, packageName)` 同时最多一个设备操作。
- 同一 serial、不同 package 使用不同 lease key，必须允许并行，与旧版行为一致。
- lease 只覆盖单次设备 I/O。
- Agent等待、摘要和落盘期间不持有 lease。
- worker 崩溃后必须释放 lease。
- TargetLease 不能演变成共同执行器。

新 Script/Intent 路径永久禁止：

- adb reconnect/kill-server/start-server/disconnect
- 自动 wait-for-device 恢复循环
- am instrument
- UiA2安装、启动、重启、清理和 force-stop
- 自动 uiautomator dump
- 自动 logcat follow
- 全局 forward 清理
- 任意两个设备操作的 Promise.all
- 超时后的 USB transport 自愈

超时后只结束当前模块拥有的精确 host child/process group，返回 transport_timeout 或 ambiguous；不向手机发送恢复命令。v1 中只读和动作命令均不自动重试。

## 12. 分阶段实施与 Gate

### Phase 0：基线冻结

只新增兼容性测试，不实现新命令。

记录 tools/list、capabilities、旧 command definitions、aliases、错误形式、Batch行为、旧调用轨迹、设备 ADB延迟和当前 MCP PID/端口/HEAD。

Gate G0：

- 现有测试通过。
- 旧命令基线快照完成。
- serial明确。
- 连续20次带硬超时的 adb shell true 全成功。
- 没有修改业务实现。

### Phase 1：CommandRouter 与隔离壳

实现 CommandRouter、LegacyDispatcher 和 Script/Intent lazy entry 占位；新命令可以暂时返回 not_implemented。

Gate G1：

- 所有旧命令与G0深度相等。
- 旧命令调用时 Script/Intent 加载次数为0。
- 任一新 loader 抛错后旧命令仍正常。
- 旧 Batch仍拒绝 Script/Intent步骤。
- capabilities除新增两个定义外无变化。
- full/legacy顶层工具不新增新工具。

### Phase 2：落盘 Interface 分离

实现 HistorySink、ScriptEvidenceStore、IntentEvidenceStore、namespace/checksum/revision，以及内存测试 Adapter 和 segmented-store 生产 Adapter。暂不接设备动作。

Gate G2：

- HistorySink初始化失败、ENOSPC、队列满、writer阻塞/崩溃不影响Legacy。
- Script/Intent EvidenceStore故障可以阻止各自新动作。
- evidence ID可读回并验证checksum。
- namespace和operation state隔离。
- 超大tree、序列化失败和损坏manifest有明确结果。

### Phase 3：SummaryTransformer

只实现纯算法、fixtures和基准。

Gate G3：

- Native/UIA/Flutter/H5 fixtures均可摘要。
- 5k、10k节点p95小于20ms。
- 摘要节点可映射到原始节点。
- 测试期间Provider/ADB调用数为0。
- 相同输入输出确定且大小受限。

### Phase 4：Script v1

先使用 fake ScriptDeviceAdapter，再接生产 Adapter。实现 worker、DSL/compiler、executor、observe/action/assert/checkpoint、Evidence gate、进度、pause/resume/cancel/intervene 和 timings。

Gate G4-A（纯测试）：

- Script不import Legacy/Intent，不调用旧Batch/runBridgeChecked/LegacyDispatcher。
- fake Adapter在同一 `(serial, packageName)` 上最大并发为1，不同 package 可并行。
- 无evidence、plan或dispatch marker时action不dispatch。
- receipt失败时停止后续步骤。
- checkpoint持久化后继续，不自动暂停。
- 只有执行失败或Agent显式pause进入paused。
- ambiguous mutation不重试。
- ScriptWorker崩溃后Legacy和Intent entry正常。
- Script结束后推进假时钟30分钟，新增设备调用数为0。

Gate G4-B（真机）：

- 一个短Native/UIA Script和一个短Flutter Script跑通。
- 回归测试证明同一 serial、不同 package 的 Script/Intent 设备操作可并行。
- 每步前后记录ADB shell延迟。
- UIA与截图不并发。
- 完成后无残留ADB child/timer。
- 旧命令再次回归通过。

### Phase 5：Intent监督模式

先fake Adapter，再接生产 Adapter。实现worker、state、observer、action executor、evidence revision、decisionId、dispatch marker、receipt、status/pause/resume/cancel/intervene。

Gate G5：

- Intent不import Script/Legacy。
- start无持久证据时不能进入waiting_for_decision。
- stale revision不dispatch；相同decisionId不重复执行。
- 一次decision最多一个动作。
- receipt丢失进入ambiguous。
- status/cancel设备调用数为0。
- 完成至少三轮observe→decide→action→observe。
- 旧命令与Script再次回归通过。

### Phase 6：Intent自主模式

只在监督模式稳定后增加 AutonomousAgentAdapter、预算和介入策略。

Gate G6：

- 业务终态仍由Agent给出。
- 达到风险/预算门禁时进入intervention_required。
- 自主模式可由Agent随时pause/cancel/intervene。
- Agent adapter崩溃不影响Intent核心状态、Script或Legacy。
- 与监督模式运行同一流程并完成分段性能对比。

### Phase 7：复杂开源 App

只有G0～G6全绿后才安装和验证复杂App。锁定当前serial，从官方来源获取APK并记录版本/hash。

1. LocalSend：Flutter Script连续流程，Settings→About→License Notices→返回。
2. Wikipedia：Native/UIA Intent，分别跑监督和自主模式。
3. VLC for Android：放入本地授权媒体，离线完成扫描、搜索、播放、暂停、seek、设置和返回。官方资料：[VideoLAN Android](https://images.videolan.org/vlc/download-android.html)、[VLC-Android仓库](https://code.videolan.org/videolan/vlc-android)。
4. Organic Maps：预装一个小区域地图，关闭VPN或使用飞行模式完成离线搜索、详情、书签、路线、设置和恢复。官方资料：[Organic Maps仓库](https://github.com/organicmaps/organicmaps)、[Android releases](https://github.com/organicmaps/organicmaps/releases)。

Moodle不在本计划中；网络/VPN不可达不能算Bridge失败。

### Phase 8：稳定性与性能

执行Script 100次启动/取消/超时，Intent两种模式各100次启动/决策/取消/超时，并覆盖EvidenceStore故障、worker crash/hang、Provider timeout、MCP重启、stale/duplicate decision和operation恢复。

Gate G8：

- 无child、timer、FD增长。
- 同serial maxActive=1。
- 无后台ADB和自动恢复命令。
- Legacy全量回归通过。
- Script、Intent、HistorySink/EvidenceStore故障域符合设计。

任一Gate失败时停止，不进入下一Phase，也不通过削弱证据门闩或旧测试来换取通过。

## 13. 性能门禁

所有新返回记录：

~~~text
workerOverheadMs
targetLeaseWaitMs
providerAcquireMs
evidenceCommitMs
summaryMs
decisionWaitMs
actionMs
receiptCommitMs
totalMs
~~~

目标：

- worker/IPC p95小于30ms
- Summary p95小于20ms
- metadata commit p95小于20ms
- raw tree + summary commit p95目标小于100ms
- 已暖Native/Flutter/H5观察目标小于1s
- UIA acquisition、screenshot、Agent decision分别报告

Script显著加速门禁：选择至少8步固定流程，旧方式逐步Agent往返，新方式continuous；预热2次、正式10次。

- Agent往返次数下降至少80%
- orchestration overhead下降至少80%
- 总耗时p50下降至少30%
- 总耗时p95下降至少20%
- 成功率不下降
- Evidence完整率100%

Intent监督模式只设正确性门禁。自主模式建议目标：Agent/MCP空闲往返时间下降至少50%，总耗时p50比监督模式下降至少20%，成功率和Evidence完整率不下降。

真机红线：

- 任意 adb shell true 超时立即停止设备操作。
- 任意一次超过500ms立即停止并诊断。
- p95超过当轮基线两倍时阶段不得通过。
- 不得通过reconnect恢复后继续宣称通过。

## 14. 静态依赖门禁

增加自动依赖检查：

- script 不import intent或legacy。
- intent 不import script或legacy。
- legacy 不import script或intent。
- shared-kernel 不import三个上层Module。
- Script/Intent不引用旧Batch、runBridgeChecked、LegacyDispatcher或旧command registry。
- Script/Intent代码和运行argv不包含UiA2、instrumentation或ADB恢复指令。

## 15. 立即停止条件

出现任一情况立即停止当前阶段：

1. 旧命令返回或调用轨迹变化。
2. 必须重写旧Provider才能继续。
3. Script/Intent/Legacy出现禁止依赖。
4. EvidenceStore被绕过。
5. 动作在dispatch marker之前执行。
6. ambiguous动作发生自动重试。
7. 同一 `(serial, packageName)` 出现并发设备操作，或同一 serial 的不同 package 被错误地串行化。
8. 出现UiA2、instrumentation或ADB恢复命令。
9. 手机shell超时或持续变慢。
10. 为通过测试而删除或弱化旧测试。
11. 将网络/VPN失败误判为App自动化失败。
12. 需要恢复整个失败stash。

停止报告必须给出触发条件、最小复现、设备/进程状态、命令时序、当前diff和回退点；不得自行扩大设计范围。

## 16. 每阶段交付格式

~~~text
Phase:
Gate:
Status: PASS | FAIL | INCONCLUSIVE

HEAD:
Dirty files:
Files changed:

Implemented:
Not implemented:

Legacy compatibility:
Script isolation:
Intent isolation:
Evidence durability:
ADB maxActive:
ADB before/after:
Performance breakdown:

Tests run:
Exact results:

Real device:
Serial:
Model:
Apps/packages:
Observed result:

Risks:
Rollback scope:
Next phase allowed: yes | no
~~~

不能只报告“测试通过”或“核心链路正常”。

## 17. 最终验收

只有以下全部满足才能宣布完成：

1. 现有MCP外观和全部旧命令行为不变。
2. LegacyDispatcher只负责隔离和分发。
3. Script不调用旧Batch、Legacy或Intent。
4. Intent不调用旧Batch、Legacy或Script。
5. 三条链路的代码、状态和故障域隔离。
6. 新动作具有持久Evidence、plan/decision、dispatch marker和receipt。
7. 无证据时不执行动作，ambiguous时不自动重放。
8. page-summary只处理已有tree并达到毫秒级门禁。
9. Script默认连续；checkpoint持久化后继续；只有执行失败或Agent显式请求才暂停。
10. Script支持progress/status/pause/resume/cancel/intervene和持久恢复。
11. Intent监督和自主模式均跑通，业务终态只由Agent决定。
12. 不存在UiA2、单次观察内的并发ADB采集或自动ADB恢复；不同 package 的独立操作仍允许并行。
13. 连续稳定性验证无child、timer、FD泄漏。
14. LocalSend、Wikipedia、VLC、Organic Maps分段跑通。
15. Script达到定义的显著加速门禁；Intent自主模式完成与监督模式的量化对比。
16. 所有结果包含可追溯Evidence IDs和分段耗时。

## 18. 给实现代理的首条指令

~~~text
请完整阅读 docs/SCRIPT_INTENT_ISOLATED_REBUILD_PLAN.md，并严格按Phase执行。现在只执行Phase 0：只读核对当前基线，新增兼容性特征测试，建立G0报告。不要实现Script、Intent、page-summary或Provider改动。G0不通过时停止并报告，不进入Phase 1；不要应用stash，不使用UiA2或ADB恢复命令。
~~~
