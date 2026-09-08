# Script / Intent、JS / Python Runtime 与统一证据总计划

> 状态：权威执行任务书
>
> 当前阶段完成度、收敛后的下一步与实测范围见 `docs/BRIDGE_DEVELOPMENT_STATUS_2026-09-07.md`。以下合同继续有效；后续优先补 Bridge 通用能力缺口，不以样例 App 的功能覆盖清单决定开发范围。
>
> 2026-09-08 路线复核见 [下一阶段关口](BRIDGE_NEXT_GATES_2026-09-08.md)。显式单次证据文件输出的有限例外以手机存查子计划开头及公开 `EVIDENCE_ARCHIVE.md` 为准；它不改变默认 live 路径、数据权威或 Agent 编排边界。
>
> 当前记录基线：`codex/script-intent-isolated-rebuild` @ `eec151b`（实施前必须重新核对）
>
> 适用对象：Grok、Cursor Agent、Codex 或其他实现代理
>
> 执行规则：同一依赖 track 的 Gate 未通过就停止其下游；第 14 节明确允许的并行 track 不互相空等，汇合 Gate 未通过不得接生产设备链路。

## 0. 文档优先级

1. 本文件是 Script / Intent 核心链路总计划。
2. `docs/MOBILE_CAPTURE_STORE_UNIFICATION_PLAN.md` 是手机存查子计划；`logs/network/state/events` 的存储、查询、Host 复制和断连语义以它为准。
3. `docs/SCRIPT_INTENT_ISOLATED_REBUILD_PLAN.md` 只保留“Legacy 外观与实际行为不变、Script / Intent / Legacy 隔离”的原则。
4. 旧计划中“Script 只允许声明式 steps、禁止 JS/Python”的结论失效。
5. 总计划、子计划与当前代码冲突时，实施代理先报告，不自行选择旧实现。

### 0.1 本次评审后的强制裁决

以下合同在 Phase 0 结束前必须写入 characterization/golden，后续 Phase 不得各自发明：

1. `ctx.call()` 返回 Script 专用 envelope；既有 command 名和 `result` 内的数据语义可以复用，但 Script 的 coverage、window、fact refs 和 execution metadata 不伪装成 Legacy 顶层 JSON。
2. `page-summary` 只是 ScriptHostPort / IntentObservationPort 的内部观察能力；不得出现在顶层 MCP command 列表，也不得被 `run(command=page-summary)` 调用。
3. “Legacy 零回归”只约束既有 live 主响应和既有执行路径；第 2.1 节列出的 intentional delta 必须单独批准、测试和发布说明。
4. 当前 Legacy target lease 的事实键是 `(serial, packageName)`；不得把它误写成只按 serial。新 Script/Intent 对同一物理设备的前台 mutation 另加 device-mutation lease，且不得反向改变 Legacy 并发。
5. Script v1 包含 `ctx.assert()`；普通异常只代表执行失败，不得自动统计为业务 assertion。
6. `wait` 使用有界短 long-poll 和专用 Host timeout，不继承会先于 `waitMs` 到期的通用 120 秒 race。
7. `permissions` 是 Bridge SDK 授权门闩，不是 OS 沙箱；Script code 仍是 `trusted-local-code`。
8. 任意 Agent 生成代码默认不可跨进程崩溃恢复；只有显式采用 checkpoint/re-entry 模板的脚本才可以声明 restart-safe。
9. Phase 6 只给现有 Intent 状态机接 CapturePort 和 ExecutionLedger，不重写 supervised/autonomous 状态机。
10. CaptureStore 与 Script Fake/runtime 合同在 Phase 0 后可并行开发；只有生产设备 `ScriptHostPort` 接线依赖 CaptureStore Gate G7。

## 1. 最终测试验收场景

以下三步是系统最终要通过的测试验收，不是要固化进代码的产品工作流：

1. Agent 使用 Intent 探索并跑通目标 App。
2. Agent 读取 Intent 的执行记录、页面摘要、动作、决策和证据引用，自行生成 JavaScript 或 Python Script。
3. Agent 启动 Script；Script 在 5–10 分钟内回放已经学会的覆盖范围，持续回报进度和执行摘要。完成后 Agent 使用现有 execution/evidence 查询能力取回本轮已落盘证据，补齐完整测试报告。
4. Script 遇到新页面、证据缺口或失败时，Agent 根据持续进度、滚动摘要和本轮证据决定暂停、恢复、修改 Script，或重新使用 Intent 探索；系统不自动切换工作流。

代码中不新增这些业务化命令：

- `intent explore`
- `export-to-script`
- `compile-from-intent`
- `run-learned-flow`
- `assemble-report`
- Intent 自动调用 Script

Intent 和 Script 是两个通用能力。如何先用 Intent、再生成 Script、最后写测试报告，始终由 Agent 编排。

“5–10 分钟”指：

- App 已安装；
- 手机保持连接；
- 测试账号、fixture 和初始状态已准备；
- Intent 已经探索过；
- 回放的是明确的测试覆盖范围。

它不表示首次探索任意未知 App，也不表示在十分钟内穷举一个大型 App 的全部功能。

## 2. 代码必须交付的通用能力

为了让第 1 节自然成立，代码只交付以下通用能力：

1. 手机 `logs/network/state/events` 统一存查，FactStore 为权威事实源，内存严格有界。
2. Intent 的 observation、decision、action、receipt、progress 和 evidence refs 完整落盘并可按 execution 查询。
3. Script 真正支持系统 JavaScript 和 Python，不再以固定 steps DSL 作为最终形态。
4. Script 默认连续运行，不逐步等待 Agent。
5. Script runtime 自动持续回报机械进度和滚动执行摘要。
6. Script 可以主动询问 Agent；Agent 可以依据摘要暂停、恢复、回答或取消。
7. Script 可直接使用 UI、action、logs、network、state、events 等既有能力语义。
8. 每次 Script 记录本轮新证据；旧 Intent 证据不能冒充本轮通过证据。
9. Agent 能通过现有 capabilities 和 execution/evidence 查询合同完成代码生成与报告，不需要理解 store/segment/cursor 内部。
10. Legacy 旧命令的 live 外观、实际执行逻辑、错误和并发范围不受影响；已批准的 history、feedback metadata 和 iOS state 修正按第 2.1 节单列。
11. 新链路不引入 UiA2 server/test package、instrumentation、ADB reconnect 或每步 ADB 健康探针；当前已有 UIA provider 可以继续使用。

### 2.1 兼容边界与 intentional delta

“Legacy 零回归”精确定义为：对既有非 history 的 live command，相同输入仍走原 LegacyDispatcher/Provider，主响应、错误、动作、target identity、幂等和 `(serial, packageName)` 并发行为保持 golden 等价。以下三项是明确批准的行为变化，不得藏在“零回归”里：

1. 手机 `history:true`：连接时改为直接读手机持久事实；断连返回 `target_disconnected`，不再读 Host 复制的旧 payload。
2. mobile `_feedback.evidence`：取消为补齐 feedback 而自动采集/复制四流；只允许附带本次命令已经取得的 refs、coverage、timing 和有界 UI semantic comparison，不内联 mobile capture payload。
3. iOS state 超过 200 key：执行明确的 byte-bounded keyed LRU；正常范围保持等价。

每项 delta 必须有 before/after contract test、迁移说明和 capabilities 文档。除此之外出现 Legacy 差异立即停止。

## 3. 最终模块关系

~~~text
Legacy command
  → LegacyDispatcher
  → 原有 Legacy 实现

Intent command
  → IntentSupervisor
  → IntentObservationPort / IntentDecisionPort / IntentActionPort
  → ExecutionLedger + MobileCaptureStore refs

Script command
  → ScriptSupervisor
  → NodeRuntimeAdapter / PythonRuntimeAdapter
  → child Script SDK
  → ScriptHostPort
  → target/provider/capture ports
  → ExecutionLedger + MobileCaptureStore refs

Agent
  → 读取 Intent execution/history
  → 自行写 JS/Python
  → 控制 Script
  → 读取本轮 execution/evidence
  → 自行生成测试报告
~~~

隔离规则：

- Script 不 import Intent。
- Intent 不 import Script。
- Script/Intent 都不 import LegacyDispatcher、Batch 或 `mcp-server.js`。
- Legacy 调用不加载 Script/Python runtime。
- 可以共享的只有 target identity、lease protocol、evidence envelope、redaction 和 bounded ledger adapter。

## 4. 深模块与 Interface

### 4.1 `MobileCaptureStore`

详细设计见 CaptureStore 子计划：

~~~text
append(record, durability) -> AppendReceipt
mark(streams)              -> CaptureWatermark
query(query)               -> CapturePage
status()                   -> CaptureStoreStatus
clear(scope)               -> ClearReceipt
~~~

手机 FactStore 保存 app facts；内存只是 byte-bounded cache。生产 `AiAppBridge` 不再持有四流 payload 容器；公开 GET 只读 `MobileCaptureStore.query()`。Host live path 不复制手机 payload。

### 4.2 `ExecutionLedger`

~~~text
record(ExecutionFact)                    -> RecordReceipt
snapshot(executionId)                    -> ExecutionSnapshot
query(executionId, afterSequence, limit) -> ExecutionPage
latest(executionId, kind)                -> ExecutionFact?
~~~

它保存 Host 自己拥有的事实：

- execution lifecycle
- observation metadata
- Agent decision
- Script progress
- checkpoint
- dispatch marker
- action receipt
- assertion verdict
- tree/screenshot/mobile fact refs
- timing

它不保存手机 logs/network/state/events payload。

Ledger 记录必须语言无关、Intent/Script 中立。这样 Agent 能读取现有 execution history 自行理解流程；代码不需要另造“探索轨迹导出器”。

### 4.3 `ScriptSupervisor`

~~~text
start(ScriptSpec)                         -> StartReceipt
control(operationId, ControlCommand)      -> ExecutionSnapshot
wait(operationId, afterSequence, waitMs)  -> ExecutionSnapshot
inspectRuntimes()                         -> RuntimeReport
~~~

它隐藏：

- Node/Python 差异
- child process
- ScriptSessionChannel
- progress/summary
- pause/cancel race
- checkpoint/restart
- target lease
- marker/receipt
- registry/event/output 限额

真实 Adapter：

- `NodeRuntimeAdapter`
- `PythonRuntimeAdapter`
- `FakeRuntimeAdapter`

### 4.4 `ScriptHostPort`

脚本 SDK 只需学习一个小 Interface：

~~~text
call(command, arguments, options?) -> ScriptCallResult
assert(assertion)                  -> AssertionResult
progress(event)           -> ProgressReceipt
checkpoint(name, state)   -> CheckpointReceipt
askAgent(request)         -> AgentDecision
controlPoint()            -> ControlState
~~~

`call()` 复用既有能力名称，但不复用 Legacy 的顶层 response envelope。固定返回：

~~~json
{
  "ok": true,
  "command": "network",
  "result": {
    "items": []
  },
  "execution": {
    "executionId": "script-...",
    "callId": "call-...",
    "actionId": null
  },
  "evidence": {
    "window": {
      "afterActionId": "action-...",
      "closedAtMs": 0
    },
    "coverage": {
      "status": "complete",
      "gap": false,
      "committed": true
    },
    "refs": []
  },
  "timings": {}
}
~~~

规则：

- `result` 内保留对应 provider/既有 capability 的数据语义；Legacy command 本身仍返回原 JSON，不包这层 envelope。
- `execution`、`evidence.coverage`、`evidence.refs` 和 `evidence.window` 是 Script/Intent 新语义，不得塞进 Legacy `/v1/network` 或其他主响应。
- Script 的窗口参数放在第三个 `options` 参数。例如 `{ evidenceWindow: { afterActionId, timeoutMs } }`；`since: "last-action"` 不作为 Legacy 参数透传。
- mutation call 自动取得 pre-action watermark，并在 `execution.actionId` 返回稳定 action ID。后续查询必须显式引用该 action ID，不依赖进程全局“上一次动作”。
- `coverage.status` 只允许 `complete | partial | unavailable`；`gap=true`、未 commit、runtime epoch 改变或断连时不能产生强通过/失败结论。

第一版 `call()` 允许的 capability 名称分组如下：

- `tree`、内部 `page-summary`、`flutter-nodes`、`h5-dom`
- `logs`、`network`、`state`、`events`
- `tap`、`tap-text`、`input-text`、`swipe`、`keyevent`、`wait-text`
- `launch-app`、`status`、`screenshot`

以及 capabilities 明确公布的 Android Flutter/H5、iOS、Web 等价名称。生产 Adapter 直接调用底层 provider/target ports，不绕回 Legacy、MCP 或 Batch。

`page-summary` 是唯一的内部伪 capability：它只能消费本轮已经取得的 tree/Flutter/H5/iOS nodes 做纯转换，并携带调用方已提供的 tree/screenshot refs；不得注册为 MCP `commandDefinitions`，不得出现在顶层 command capabilities，也不得自己触发截图或五路采集。

`ctx.assert()` v1 使用结构化输入：

~~~javascript
const verdict = await ctx.assert({
  name: "search request succeeded",
  predicateSummary: "matched request has statusCode 200",
  condition: network.result.items.some((item) => item.statusCode === 200),
  requiredEvidence: ["network"],
  evidence: network.evidence,
  requireCoverage: "complete"
});
~~~

Host 校验 evidence refs、freshness 和 coverage 后返回 `passed | failed | inconclusive`，并自动写 assertion event。`condition=false` 且 coverage 不完整仍是 `inconclusive`；普通 `throw`、child crash 或 call failure只记 execution failure，不计 assertion。

### 4.5 `ProgressProjector`

~~~text
accept(ExecutionFact) -> ProgressSnapshot
read(executionId, afterSequence, limit) -> ProgressPage
~~~

它只投影已有 execution facts，不发设备命令，不查询手机，不判断业务成功。

## 5. Execution 记录充分性

不增加 Intent→Script 专用格式，但 execution/history 必须让 Agent 看懂已经发生的事。

每个 execution fact 至少包含：

~~~text
schemaVersion
executionId
sequence
revision
kind
target
timestampMs
actionId                  nullable
parentFactId              nullable
payloadSummary
evidenceRefs
timings
~~~

### 5.1 Observation

至少记录：

- logical page/route when known
- provider
- page-summary
- treeId
- screenshotId
- foreground attribution
- coverage/gap
- capturedAtMs

### 5.2 Decision

至少记录：

- decisionId/revision
- selected action or terminal verdict
- referenced observation/evidence IDs
- supervised/autonomous mode
- Agent-visible reason summary

不要求保存模型私有推理。

### 5.3 Action

至少记录：

- action intent
- target selector and resolved node/bounds
- pre-action observation/tree reference
- dispatch marker
- mechanical receipt
- ambiguity
- before/after timing
- related mobile fact window

### 5.4 Assertions

至少记录：

- predicate summary
- required evidence kinds
- current-run refs
- coverage complete/partial/unavailable
- passed/failed/inconclusive

Agent 读取这些中性记录即可自行生成 JS/Python；代码不负责把它自动转换成程序。

### 5.5 Agent-visible 查询，不暴露 Store

`ExecutionLedger` 本身不成为新的顶层 MCP command。Agent 仍通过通用命令查询：

- `run(command=script, operation=status|wait, operationId, afterSequence, limit)` 读取 Script snapshot/events/refs；
- `run(command=intent, operation=status, operationId, afterSequence, limit)` 读取 Intent observation/decision/action/refs；
- 已终止 child 的 operation 从 Ledger 读取，不要求无界保留 live registry；
- 手机 payload 继续通过已有 `logs/network/state/events/tree/screenshot` 及其 history/cursor 参数按 refs 定位，且手机必须仍连接。

不增加 `execution-store`、`evidence-store`、`sync`、`segments` 或 `assemble-report` 命令。若现有 history/cursor 不能精确定位某类 mobile ref，先给该既有 command 增加 additive locator 并过 capabilities/Legacy 兼容 Gate，不能暴露底层 segment/offset。

## 6. Script 外部合同

外部命令仍叫 `script`。MCP 仍只有 `capabilities` 和 `run`。

### 6.1 Operations

| operation | 语义 |
| --- | --- |
| `start` | 校验、持久化、启动 child，握手后立即返回 operationId |
| `status` | 立即返回 snapshot |
| `wait` | long-poll 到新事件、Agent request、终态或 timeout |
| `progress` | 保留为兼容查询别名 |
| `pause` | 请求下一个安全点暂停 |
| `resume` | 恢复 live child 或从 checkpoint restart |
| `decide` | 回答脚本的 Agent request |
| `cancel` | 取消并完成动作收口 |
| `intervene` | 带 reason 的 pause 兼容别名 |
| `runtime-status` | 探测 Node/Python |

`start` 不等待脚本跑完，避免长脚本受单次 MCP 120 秒 timeout 截断。

### 6.2 ScriptSpec v1

~~~json
{
  "schemaVersion": "aab.code-script/v1",
  "name": "wikipedia-core",
  "language": "javascript",
  "source": "async function main(ctx) { return { passed: true }; }\nmodule.exports = { main };",
  "entrypoint": "main",
  "target": {
    "serial": "device-serial",
    "packageName": "org.wikipedia"
  },
  "inputs": {},
  "permissions": [
    "app.read",
    "app.interact",
    "capture.read"
  ],
  "policy": {
    "timeoutMs": 600000,
    "onFailure": "pause",
    "restartPolicy": "none",
    "maxOutputBytes": 1048576,
    "maxProgressBytes": 1048576
  }
}
~~~

规则：

- canonical language 为 `javascript`、`python`；`js`、`py` 只是输入别名。
- `source` 与 `sourcePath` 二选一。
- source、inputs、policy 和 SDK version 共同生成 hash。
- start 固定 source 副本，执行中原文件变化不影响本轮。
- inputs、return value 和 checkpoint state 必须是有界 JSON。
- source artifact 是 Host-owned execution artifact，不是 mobile evidence。
- `restartPolicy` 默认且推荐为 `none`。只有脚本采用官方 checkpoint/re-entry 模板并通过 restart-safe 测试后，才能显式设为 `checkpoint`。

### 6.3 `wait` timeout 合同

- `waitMs` 是整数，范围 `0..60000`，默认 30000；长任务通过多次携带 `afterSequence` 的 long-poll 读取。
- `wait` 的 Host operation timeout 固定为 `waitMs + 5000 ms`，且不得再套用默认 120 秒 isolated timer。
- Script v1 不接受调用方用 `isolatedTimeoutMs` 覆盖 `wait`；传入时返回 `unsupported_argument`，避免两个竞争 timeout。
- `waitMs` 到期返回 `timedOut:true` 的正常 snapshot，不返回 `isolated_timeout`，不取消、不暂停 child。
- `start/status/pause/resume/decide/cancel` 各自使用短 operation-specific timeout；Script 总运行时只由 `policy.timeoutMs` 和 cancel 控制。

### 6.4 JavaScript

~~~javascript
async function main(ctx) {
  await ctx.progress({
    stage: "search",
    message: "opening search"
  });

  await ctx.call("tap-text", { targetText: "Search" });
  const input = await ctx.call("input-text", { text: ctx.inputs.query });

  const network = await ctx.call("network", {
    urlFilter: "/search"
  }, {
    evidenceWindow: {
      afterActionId: input.execution.actionId,
      timeoutMs: 5000
    }
  });

  const assertion = await ctx.assert({
    name: "search network completed",
    predicateSummary: "matching search request completed successfully",
    condition: network.result.items.some((item) => item.statusCode === 200),
    requiredEvidence: ["network"],
    evidence: network.evidence,
    requireCoverage: "complete"
  });

  await ctx.checkpoint("search-complete", {
    query: ctx.inputs.query
  });

  return {
    passed: assertion.verdict === "passed",
    factRefs: network.evidence.refs
  };
}

module.exports = { main };
~~~

### 6.5 Python

~~~python
def main(ctx):
    ctx.progress({
        "stage": "search",
        "message": "opening search"
    })

    ctx.call("tap-text", {"targetText": "Search"})
    input_result = ctx.call("input-text", {"text": ctx.inputs["query"]})

    network = ctx.call("network", {
        "urlFilter": "/search"
    }, {
        "evidenceWindow": {
            "afterActionId": input_result["execution"]["actionId"],
            "timeoutMs": 5000
        }
    })

    assertion = ctx.assert_({
        "name": "search network completed",
        "predicateSummary": "matching search request completed successfully",
        "condition": any(item.get("statusCode") == 200 for item in network["result"]["items"]),
        "requiredEvidence": ["network"],
        "evidence": network["evidence"],
        "requireCoverage": "complete"
    })

    ctx.checkpoint("search-complete", {
        "query": ctx.inputs["query"]
    })

    return {
        "passed": assertion["verdict"] == "passed",
        "factRefs": network["evidence"]["refs"]
    }
~~~

Python runner 支持同步 main 和 async main；第一版 SDK 不依赖第三方 package。Python 因 `assert` 是关键字，SDK 方法名固定为 `ctx.assert_()`；JavaScript 使用 `ctx.assert()`，两者发送同一 IPC method。

### 6.6 Permissions 与 allowlist

`ScriptSpec.permissions` 是脚本请求使用 Bridge SDK 能力的声明，Host policy 才是授权来源。脚本不能靠在 spec 中多写一个字符串给自己提权；它同时也不能限制 JS/Python 直接使用本机 OS API，因此整个 runtime 仍标为 `trusted-local-code`。

v1 默认 catalog：

| Permission | 默认允许的 ScriptHostPort 能力 |
| --- | --- |
| `app.read` | `status/tree/uia-tree/screenshot/flutter-tree/flutter-nodes/h5-dom/keyboard-state/permission-state`、内部 `page-summary` 及 iOS/Web 只读等价项 |
| `capture.read` | `logs/network/state/events/webview-console/webview-network` 及 iOS/Web 等价项 |
| `app.interact` | `launch-app/tap/tap-text/tap-uia-text/input-text/swipe/keyevent/wait-text/hide-keyboard`、Flutter/H5 click/input/wait/scroll 和 iOS/Web 等价交互项 |

以下命令不进入默认 allowlist：

- `clear-app-data`、`install-apk`、`ios-install-app`、`ios-setup`
- `permission-grant`、`permission-revoke`、`permission-dialog`、`appops-set`
- `h5-eval`、`flutter-h5-eval`、`ios-h5-eval`、任意 `web-command`
- raw shell、任意进程启动、ADB forward/remove-forward、kill-server/reconnect 和未列出的管理命令

其中前 3 组未来可由 Host-owned risk policy 按精确 command + target + argument schema 单独批准；ScriptSpec 只能“请求”，不能批准。最后一组 v1 在 ScriptHostPort 永久拒绝。Phase 0 必须把当前 command catalog 冻结成机器可读 allow/deny 测试；`capabilities(command=script)` 必须返回精确命令集合、所需 permission、risk policy 状态和醒目的 `trusted-local-code` 警告，不能只返回 operation 名。

## 7. 持续进度和滚动摘要

持续回报是 runtime 的强制能力，不依赖脚本作者主动调用 progress。

### 7.1 自动事件

至少自动记录：

- `script_accepted`
- `runtime_resolved`
- `child_started`
- `call_started`
- `call_completed`
- `call_failed`
- `assertion_passed/failed/inconclusive`
- `checkpoint_committed`
- `agent_question_created`
- `pause_requested`
- `paused`
- `resumed`
- `heartbeat`
- `script_completed/failed/cancelled/ambiguous`

脚本自己的 `ctx.progress()` 用来补充业务阶段、预计总量和说明，不替代自动事件。

### 7.2 RollingSummary

每次 material event 后更新：

~~~json
{
  "operationId": "script-...",
  "status": "running",
  "stage": "search",
  "message": "waiting for results",
  "currentCall": "network",
  "completedCalls": 17,
  "assertions": {
    "passed": 6,
    "failed": 0,
    "inconclusive": 0
  },
  "lastCheckpoint": "search-complete",
  "elapsedMs": 41000,
  "activeMs": 40500,
  "decisionWaitMs": 0,
  "latestEvidenceRefs": [],
  "agentRequest": null
}
~~~

两秒内没有 material event 时，Host 生成轻量 heartbeat。heartbeat 不查询设备、不触发 capture，只报告 elapsed、last event 和 child health。

### 7.3 Agent 读取

当前 MCP 没有可靠 server-push，因此真实 Interface 是增量 long-poll：

~~~text
script wait(operationId, afterSequence, waitMs)
→ 有新事件、需要决策、进入终态或 waitMs 到期时返回
→ 返回 incremental events + latest RollingSummary
~~~

- `status` 立即返回。
- `wait` 无 busy polling。
- Agent 可以持续 wait，也可以暂时离开后按 sequence 补读。
- 将来增加 push Adapter 时不改变 ProgressStream 语义。

### 7.4 idle 与 condition wait

“idle mobile 四流请求为 0”只适用于没有活跃 Script、Intent、显式 evidence 查询或 condition wait 的目标。`wait-text`、H5/Web wait 以及 ScriptHostPort 的 evidence-window wait 属于正在执行的业务等待，可以在 deadline 前按有界 interval 拉取其声明所需的 UI/capture 通道。

这些 wait 必须：

- 只轮询条件所需通道，不启动全局 ObservationCollector，也不无条件拉四流；
- 记录 `businessWaitMs`、poll count 和 provider timing，与真正 idle polling 分开；
- deadline、cancel 或 condition 满足后立即停止 timer；
- 不把等待业务结果的时间算成 summary/projector 开销。

## 8. Agent 询问、暂停、恢复和取消

### 8.1 Script 主动问 Agent

~~~javascript
const choice = await ctx.askAgent({
  question: "页面出现两个同名入口，应选择哪个？",
  options: [
    { id: "top", label: "顶部入口" },
    { id: "bottom", label: "底部入口" }
  ],
  context: {
    summary: pageSummary,
    evidenceRefs: pageSummary.evidenceRefs
  }
});
~~~

状态进入 `waiting_for_agent`。`decide` 必须匹配 operationId、requestId 和 revision；重复 decision 幂等，旧 revision 拒绝。

### 8.2 Agent 主动控制

Agent 根据 RollingSummary 随时可以：

- pause
- resume
- decide
- cancel
- intervene

progress、summary 和 checkpoint 不自动暂停。

### 8.3 安全点

pause 在以下位置生效：

- 每次 `ctx.call()` 前后
- 每次 progress/checkpoint/askAgent 前后
- Host-aware wait/sleep 分片之间

mutation 正在执行时：

1. 先进入 `pause_requested`。
2. 等动作返回并持久化 receipt。
3. 再进入 `paused_live`。
4. outcome unknown 时进入 `paused_ambiguous`，不得自动重试。

CPU 死循环或绕过 SDK 的 Host I/O 不能安全暂停；只能标记 unresponsive，随后由 watchdog cancel。不能谎报 paused。

### 8.4 Resume

- child 存活：恢复原语言栈和内存变量。
- Agent 生成稿默认 `restartPolicy=none`；child/Host 死亡后进入 terminal `runtime_lost`，只能整轮重跑或由 Agent 重新生成，不宣称恢复任意 JS/Python 调用栈。
- 只有显式 `restartPolicy=checkpoint` 且采用官方模板的脚本，才允许从已 commit 的 JSON checkpoint 重新启动，并通过 `ctx.resume` 做幂等 re-entry。
- prepared marker 没有可信 receipt：拒绝重放，返回 ambiguous。
- 没有 checkpoint/restart-safe 声明、checkpoint 无法反序列化或模板验收未通过：`resumeMode=none`。

Phase 5 的恢复 Gate 只验证模板化 checkpoint 脚本，不得把它描述成“任意 Agent 代码崩溃后续跑”。live child 的 pause/resume 与 crash restart 是两个独立能力。

## 9. Runtime 检测和可信边界

### 9.1 JavaScript

- 使用 `process.execPath` 启动独立 Node child。
- 不从 PATH 随机选择另一个 Node。
- child 与 CLI 的 Node 支持矩阵一致。

### 9.2 Python

检测顺序：

1. Host 管理配置中的固定 executable。
2. `AI_APP_BRIDGE_PYTHON`。
3. PATH 中 `python3`。
4. PATH 中 `python`。

要求 Python ≥3.9。结果在 Host 生命周期缓存；spawn 失败时最多重新探测一次。

- CLI 自动检测，不自动安装。
- Python 不存在时返回 `runtime_unavailable`，JavaScript 仍可运行。
- 不执行 brew、apt、winget、pip、npm 或 curl。

### 9.3 进程通信

- JS/Python 都在独立 child。
- Host 不使用 eval、vm 或内嵌解释器执行用户 source。
- spawn 使用 executable + argument array，`shell:false`。
- RPC 使用一次性 loopback JSONL channel；stdout/stderr 独立。
- token、frame、in-flight、output、event 和 timeout 全部有界。
- cancel 或 Host exit 回收整个 process group。

真实 JS/Python 拥有当前 OS 用户权限。临时目录、环境变量 allowlist、timeout 和 Bridge permissions 不是安全沙箱。第一版明确标为 `trusted-local-code`；不可信代码需要另做 container/VM Adapter。

## 10. 证据新鲜度和 Agent 报告

### 10.1 每轮必须产生新证据

每次 Script 必须产生自己的：

- action markers/receipts
- 关键状态 screenshotId/treeId
- logs/network/state/events fact refs
- assertion verdict
- progress/checkpoint

旧 Intent 证据可以帮助 Agent：

- 理解流程
- 选择 selector/fallback
- 定义期望
- 对比页面
- 编写代码

旧证据不能：

- 填充本轮 current evidence
- 证明本轮接口仍成功
- 证明本轮 UI 仍正确
- 在手机断连时兜底

### 10.2 Agent 按需取证

执行期间 Host 不后台复制全部手机 payload。Script 完成后，Agent 在手机仍连接时：

1. 从 execution history 取得 action/decision/tree/screenshot/mobile fact refs。
2. 用现有 tree/screenshot/logs/network/state/events 查询能力批量取回本轮需要的事实。
3. 按测试要求写入 ignored artifact root 和报告。

这是 Agent 的验收工作，不新增 `assemble-report` 产品命令。

### 10.3 evidence QA 验收要求

最终测试报告至少包含：

- page/state inventory
- element/interaction matrix
- flow/branch matrix
- edge/robustness matrix
- review-risk matrix

每个 verdict 必须能追到本轮 screenshot/tree、action receipt 和必要的 network/log/state/event 证据。

缺证据时只能是：

- failed
- inconclusive
- blocked
- not_verified

不能 passed。

## 11. 为什么可以从数小时降到 5–10 分钟

首次 Intent 的时间花在未知决策：

- 理解页面
- 选择下一步
- 探索分支
- 修 selector
- 判断证据
- 发现异常路径

Agent 把这些知识写进 JS/Python 后，Script 本地连续执行，删除：

1. 每步 3–8 秒 Agent round-trip。
2. 每步重新选择 provider。
3. 四流无条件 polling。
4. 每步立即生成完整人类报告。
5. 每 device call 前后两次 `adb shell true`。
6. 固定 sleep 和重复 capabilities 查询。

本轮证据仍然采集，只是：

- capture 自动落盘；
- Script 只在需要时查询 delta；
- progress/summary 使用 Host 已有 execution facts；
- Agent 在结束后一次性按 refs 补报告。

所以提速来自“复用流程知识 + 本地控制循环 + 延迟报告组装”，不是减少证据或复用旧通过结论。

## 12. 性能 Gate

| 指标 | Gate |
| --- | ---: |
| start receipt | p95 ≤ 500 ms |
| JS spawn + handshake | p95 ≤ 150 ms |
| Python spawn + handshake | p95 ≤ 300 ms |
| child↔Host 空 RPC | p95 ≤ 10 ms |
| Supervisor call 附加开销 | p95 ≤ 25 ms，不含 provider |
| page-summary 纯转换，10,000 nodes | p95 ≤ 20 ms，单次硬上限 50 ms；Provider/ADB/截图调用数 0 |
| page-summary 默认输出 | ≤64 KiB，且每个摘要节点可回溯原 tree/node ID |
| material event 到 summary 可读 | p95 ≤ 100 ms |
| heartbeat 最大间隔 | 2 秒 |
| hot CaptureStore query | p95 ≤ 10 ms |
| decision query | p95 ≤ 50 ms，不含业务等待 |
| 每 device call 额外 ADB probe | 0 |
| idle Host mobile polling | 0 |
| terminal 后 residual child | 0 |
| 已学会核心覆盖 | ≤5 分钟目标 |
| 已学会完整验收覆盖 | ≤10 分钟硬门禁 |

时间报告必须拆分：

- activeMs
- providerWaitMs
- businessWaitMs
- decisionWaitMs
- pausedMs
- evidenceQueryMs
- wallMs

Script 主动问 Agent 的等待继续计入 wallMs，不能排除后伪造达标。

## 13. 当前代码已知问题

Phase 0 必须重新验证：

- 当前 Script 只有 observe/action/assert/checkpoint。
- 普通嵌套 YAML 实际不可靠，JSON/object 才是主路径。
- start 等待整个 worker 完成。
- isolated timeout 默认 120 秒；超时返回后后台 Promise 可能继续操作。
- operations Map 和 events 数组无最终有界 lifecycle。
- 当前没有 Script decide。
- progress 只是 status alias，没有强制持续摘要。
- production adapter 每次 observe/action 前后各执行一次 `adb shell true`。
- 单步骤 hang 不能被总 timeout 中断。
- restore 不能真实恢复任意语言栈。
- CLI 本体没有完整 Script command surface。
- capabilities(command=script) 只公开 operation。
- 当前 Android Legacy、Script adapter、Intent adapter 都以 `(serial, packageName)` 作为 app target lease key，且 5 处测试明确要求同 serial/different package 并行；真实 USB/前台 mutation 安全性尚未由这些 fake 并发测试证明。
- 当前 ObservationCollector 默认每秒拉 status 后并发拉 logs/network/state/events，目标可保留 30 分钟；mobile payload 会写 Host FactStore。
- 当前 `_feedback.evidence` 本身只放 Host refs，不内联 payload；但 foreground/probe payload 已先被 Host 持久化，且 `feedback:off` 不停止该复制。
- 当前手机 `history:true` 完全跳过 live provider，只读 Host history，所以断连也可能返回旧事实；目标设计的 connected-history 是 intentional delta。
- 当前 `page-summary` 只存在为 Script/Intent 内部 `summarizeTree()`，G0/G1 测试明确禁止其成为顶层 command。

当前机器点时参考：

- Node `v26.3.0`，来自 `process.execPath`。
- `/usr/bin/python3` 为 Python 3.9.6。

生产实现必须探测，不能硬编码这些路径或版本。

## 14. 代码实施 Phase

依赖关系不是一条串行长链：

~~~text
P0 基线冻结
├─ CaptureStore track：P1 / G1–G7 ─┐
└─ Script contract track：P2 → P3 ─┴→ P4 production ScriptHostPort
                                         ↓
                                    P5 → P6 → P7...
~~~

P0 通过后，CaptureStore track 与 Script Fake/runtime track 可以由隔离工作区并行推进。P2/P3 不得为了等待真机 store 而空转；P4 的 production capture/action 接线必须等 P1/G7 通过。任何并行开发仍共享同一份冻结 schema/contract，不允许最后再临时拼接口。

### Phase 0：冻结基线

工作：

1. 记录 branch/HEAD/dirty/untracked。
2. 冻结 Legacy CLI/MCP/HTTP/JSON/并发 golden。
3. Characterize 当前 Script lifecycle、timeout、双 ADB probe、YAML/JSON 和无界状态。
4. 冻结 `page-summary` 非顶层 command 和纯 transformer 的 fixture/性能基线。
5. 完成 CaptureStore 子计划 G0。

Gate P0：

- 无生产代码变化。
- Legacy golden 完整。
- 当前缺陷有可执行 fixture。
- 用户文件零变化。

### Phase 1：统一 CaptureStore 与 Ledger（可与 P2/P3 并行）

按 CaptureStore 子计划完成手机统一存查、Host execution facts、refs 和断连语义。

Gate P1：

- CaptureStore G1–G7 通过。
- 手机 facts 唯一存查。
- Host 不后台复制 mobile payload。
- gap/drop/disconnect 可区分。
- Intent/Script execution facts 中立、可按 sequence 查询。

### Phase 2：ScriptSpec、Supervisor 与 Fake（可与 CaptureStore track 并行）

工作：

- ScriptSpec schema。
- start/status/wait/pause/resume/decide/cancel。
- FakeRuntime/FakeHostPort/FakeAgentPort。
- bounded registry/events/output。
- detailed capabilities contract。
- `ctx.call` envelope、`ctx.assert`、wait 专用 timeout 和 allow/deny catalog。

Gate P2：

- start 异步返回。
- 10 分钟 fake run 不受单次 MCP timeout 影响。
- wait 无 busy polling。
- wait 到期返回 snapshot；outer timeout 不先于 `waitMs`。
- 10,000 operation 后 retained heap 不线性增长。

### Phase 3：Node 与 Python Runner

工作：

- Node `process.execPath` Adapter。
- Python resolver/Adapter。
- child bootstrap、loopback channel、SDK。
- source artifact/hash。
- trusted-local-code policy。

Gate P3：

- JS/Python 分支、循环、异常、sync/async 通过。
- Python 缺失不影响 JS。
- 不安装依赖。
- child crash 不影响 Legacy/Intent。
- spawn/RPC 达性能预算。

### Phase 4：ScriptHostPort 与设备能力

工作：

- 抽取底层 provider/target ports。
- 接 UI/action/logs/network/state/events/wait。
- marker/receipt/target lease。
- 删除 per-call pre/post ADB probe。
- 保留 Legacy `(serial, packageName)` lease 及其跨 package 并行 golden，不修改 TargetExecution。
- 新 Script/Intent 增加 foreground device-mutation lease：同一 physical serial 的前台 mutation 串行；不同 serial 并行；同 serial 的只读 app-local 查询只在 provider/transport 证明安全时并行。

Gate P4：

- Script production files 不 import Legacy/Batch/MCP/Intent。
- 同一 physical serial 的 Script/Intent foreground mutation `maxActive=1`；不同 serial `maxActive>1`。
- Legacy same-serial/different-package golden 仍通过。
- 额外 ADB probe=0。
- transport error 不 reconnect。
- ambiguous action 不自动重试。

### Phase 5：持续进度、摘要与控制

工作：

- 自动 execution events。
- ProgressProjector/RollingSummary。
- 2 秒无设备查询 heartbeat。
- askAgent/decide。
- safe pause/live resume/checkpoint restart。

Gate P5：

- 脚本不主动 progress 时仍有持续 call-level 进度。
- business progress 正确合并。
- Agent 可按 summary pause/resume。
- in-flight mutation pause 有 receipt 或 ambiguous。
- checkpoint 不暂停。
- stale/duplicate decide 被拒绝。
- `restartPolicy=none` 的 child crash 明确终止且不可 resume；只有模板化 `restartPolicy=checkpoint` fixture 通过 restart gate。

### Phase 6：Intent 两模式与通用历史

工作：

- 保留现有 supervised/autonomous 状态机、decision revision、暂停/恢复和终态语义；本 Phase 只做接线，不拆掉重写。
- IntentObservationPort 使用统一 capture。
- Intent decision/action/receipt/progress 完整进入 ExecutionLedger。
- execution query 返回 Agent 所需中性记录和 refs。

Gate P6：

- supervised 只执行真实 decide。
- autonomous 无 Agent Adapter 时不伪造。
- history 足以让 Agent复述状态、动作、分支和证据。
- Script/Intent 无 cross-import。
- 现有 Intent G5/G6/G7 状态机测试只允许补充 capture/ledger 断言，不允许删除或改写业务语义。

### Phase 7：替换当前声明式 Script

迁移：

1. code runtime 先用显式 schema 旁路接入。
2. Gate 通过前旧 steps 只作临时对照。
3. production 切 code runtime。
4. 删除旧 compiler/executor/static worker。
5. 旧 steps payload 返回明确 `script_format_removed`。

删除前测试迁移清单：

1. 将 `script-g4a.test.js`、`script-production-adapter.test.js`、`stability-g8.test.js` 的 Script 部分、`acceptance-s17.test.js` 的每个不变量逐项移植到 JavaScript 与 Python fixture。
2. 保留 `intent-g5.test.js`、`intent-g6.test.js`、`intent-production-adapter.test.js`；只替换其中“Script 仍可用”的 sentinel fixture，不删除 Intent Gate。
3. 将 `cli.test.js` 的真实 MCP wiring/persistence 和 `scripts/g8-device-speed.js` 改为 code Script。
4. 保留 `legacy-surface-g0.test.js`、`command-router-g1.test.js`、`evidence-store-g2.test.js` 的 Legacy/隔离不变量。
5. 先让临时 `declarative-v1` adapter 与 code runtime 双跑一轮；上述消费者全部迁移且 `rg` 无生产引用后，才删除 compiler/worker/executor。
6. 原 G8 fake 2ms benchmark 只作回归微基准，不能充当复杂 App 5 分钟证明。

Gate P7：

- production 只有一个 Script 执行器。
- 外部 script 命令和控制 operations 保留。
- capabilities 能教会 Agent JS/Python。
- 上述迁移清单、Legacy 和 Intent 全量回归。

### Phase 8：性能优化

工作：

- profile runtime/RPC/provider/evidence/wait。
- 删除重复 context/forward/capabilities。
- condition wait 替代固定 sleep。
- 验证无 idle polling/ADB probe。

Gate P8：

- 第 12 节 micro gates 全通过。
- page-summary benchmark 只喂已有 Native/UIA/Flutter/H5 fixture，证明自身不触发 provider/ADB/screenshot。
- 与同语义 Agent-per-step 基线比较并报告真实节省。
- 没有减少 coverage/evidence 换速度。

### Phase 9：端到端测试验收

这是第 1 节使用场景的执行，不增加新代码工作流：

1. Agent 用 Intent 跑通。
2. Agent 查询 execution/evidence。
3. Agent 自行写 JS/Python。
4. Agent 启动 Script 并通过 wait 持续观察。
5. Agent 必要时 pause/resume/decide。
6. Agent 结束后取回本轮证据并写 evidence QA 报告。
7. 遇到新状态或失败时，由 Agent 决定修订 Script 或重新使用 Intent，不由代码自动跳转。

所有场景均不含登录；若首次启动有 onboarding/权限页，作为显式可选分支处理。Phase 9 开始前先用 Intent 冻结当前版本、语言、页面标签、fixture hash 和初始状态，不能临场删减。Moodle 不使用。

| App | 已学会核心覆盖，目标 ≤5 分钟 | 已学会完整验收覆盖，硬门禁 ≤10 分钟 | 必要断言与证据 |
| --- | --- | --- | --- |
| LocalSend（Flutter） | 处理 onboarding；进入 Receive；打开 Settings；进入 About/License；逐层返回 | 核心覆盖 + 无 peer/空发现分支 + 一次安全的文件选择后取消 + theme/language 切换并恢复 + 重复前进/返回 | 每页 summary/tree ref；目标控件存在；导航终态；设置恢复；无 peer/取消不崩溃；关键 state/events/logs 与截图 |
| Wikipedia Android（native） | 处理 onboarding；搜索固定可访问词条；打开文章；打开目录/章节；返回搜索；进入 Settings | 核心覆盖 + no-result 查询 + reading-list 保存/取消分支（使用测试列表）+ language/theme 切换并恢复 + 重复文章/返回 | 搜索请求或明确离线状态；标题/正文/目录可见；no-result 正确；设置恢复；相关 network/state/events/logs 与关键截图 |
| VLC Android（native，本地媒体 fixture） | 处理权限/onboarding；扫描固定 fixture；打开媒体；play/pause；seek；返回媒体列表 | 核心覆盖 + 空目录/无结果分支 + 播放恢复状态 + 连续 play/back + 设置页打开并恢复任何修改 | fixture hash；媒体项/播放状态/进度变化；空状态；无 crash；state/events/logs、tree 和截图 |
| Organic Maps（native，离线地图 fixture） | 处理 onboarding；打开离线地图；搜索固定 POI；打开详情；添加书签；进入 route preview 后取消 | 核心覆盖 + no-result 搜索 + bookmark 删除/恢复 + route cancel/back + Settings 打开并恢复修改 | 离线地图/POI fixture identity；搜索/详情/书签/route 状态；取消后页面归属；state/events/logs、tree 和截图 |

矩阵规则：

- “核心”与“完整验收”是两份固定 scenario manifest；每个步骤、断言、fixture 和 expected terminal page 都版本化，运行时不得把失败项从 manifest 删除。
- 不要求真实发送文件、写公开账号、下载地图或访问需要 VPN 的服务；所有外部副作用使用本地 fixture、测试列表、preview 或 cancel 路径。
- 网络不可达、fixture 缺失或本地化文本变化必须报告 `blocked/inconclusive`，不能通过换成更短路径伪造达标。
- 每个 App 的 core/acceptance 分别记录 `active/provider/business/decision/paused/evidence/wall` 时间；Agent 等待计入 wall。

Gate P9：

- 四个 App 分别完成完整场景。
- 已学会核心覆盖目标 ≤5 分钟。
- 已学会验收覆盖每次 ≤10 分钟。
- 至少一个 App 分别用 JS/Python 跑同义流程。
- progress/summary 全程可见。
- 报告五类矩阵完整。
- 没有旧证据冒充 current pass。

### Phase 10：清理与发布审计

- 删除 shadow/transition code。
- 更新 README、CLI help、capabilities、示例和安全说明。
- package manifest 包含 JS/Python runtime assets。
- 输出 Legacy zero-diff、性能、四 App、证据和残留风险报告。

Gate P10：第 16 节全部满足。

## 15. 静态门禁与立即停止

静态门禁：

1. Legacy files 不 import Script/Intent。
2. Script files 不 import Intent/Legacy/Batch/MCP。
3. Intent files 不 import Script/Legacy/Batch/MCP。
4. Host 不 eval 用户 source。
5. spawn 使用 args array、`shell:false`。
6. 无自动 Python/Node/package 安装。
7. 无 per-action ADB probe/reconnect/kill-server。
8. operations/events/output/IPC 全部 byte-bounded。
9. mobile payload 不进入 Host live history。
10. old step compiler/executor 无 production 引用。
11. `page-summary` 不在顶层 MCP command/capabilities。
12. Script `wait` 不受通用 120 秒 isolated timer 竞争。
13. 默认 Script allowlist 不含清数据、安装、权限变更、eval、raw shell 或 ADB 管理。

立即停止：

- Legacy live golden 或第 2.1 节之外的行为出现未批准变化。
- Intent/Script 被代码绑定成固定工作流。
- 旧 evidence 被当作本轮通过证据。
- progress 触发额外设备 polling。
- pause 在动作 receipt 前谎报安全完成。
- 5–10 分钟通过依赖少测或少取证。
- JS/Python 被错误称为 sandboxed。
- 用户未跟踪文件发生变化。

## 16. 最终验收

全部满足才算完成：

1. Intent、Script、Legacy 是三个隔离执行模块。
2. Script 真正支持系统 JavaScript 和 Python。
3. Script start 异步，默认连续运行。
4. runtime 自动持续产生进度和滚动摘要。
5. 脚本可询问 Agent，Agent 可 pause/resume/decide/cancel。
6. safe pause、live resume 语义真实；checkpoint restart 只对显式模板化 restart-safe 脚本成立。
7. Script 可调用既有 UI/action/evidence 能力语义。
8. Intent/Script execution history 中立且证据引用完整。
9. 每次 Script 使用本轮新证据。
10. CaptureStore 是手机 facts 唯一来源，Host live path 不复制 payload。
11. Agent 能用现有查询完成测试报告，不需要专用转换/报告命令。
12. Legacy live 外观和实际执行逻辑零回归；history/feedback/iOS LRU intentional delta 单列通过。
13. Script/Intent/Legacy 无 cross-import。
14. 无额外 ADB probe/reconnect/UiA2。
15. 四个复杂 App 通过 5–10 分钟验收场景。
16. evidence QA 五类矩阵完整；无证据不通过。
17. terminal 后无残留 child、无无界 registry/event。
18. `ctx.call` envelope 与 Legacy response 明确分层，`ctx.assert` 能区分 failed/inconclusive。
19. 同一物理 serial 的新 Script/Intent 前台 mutation 串行，且 Legacy 跨 package 并发 golden 未被改写。
20. `wait` 可反复 long-poll 10 分钟运行而不产生 `isolated_timeout` 假失败。
21. capabilities 明确公开 allowlist、permission 语义与 `trusted-local-code` 风险。

## 17. 给实现代理的首条指令

~~~text
完整阅读 docs/SCRIPT_INTENT_RUNTIME_CAPTURE_MASTER_PLAN.md 和 docs/MOBILE_CAPTURE_STORE_UNIFICATION_PLAN.md，并按总计划的文档优先级处理旧计划。现在只执行 Phase 0：重新核对 branch/HEAD/dirty files；新增 Legacy golden；新增当前 Script 的阻塞 start、120 秒 isolated timeout、每设备调用前后双 ADB probe、steps/YAML 真实行为、operations/events 无界生命周期 characterization；冻结 page-summary 非顶层 command/纯 transformer 基线；完成 CaptureStore G0。不要修改生产代码，不操作手机/ADB/MCP，不触碰用户未跟踪文件。输出 P0/G0 报告并停止。
~~~
