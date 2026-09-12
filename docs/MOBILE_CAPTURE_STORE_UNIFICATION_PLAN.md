# Mobile CaptureStore 统一存查与 Script / Intent 决策接线计划

> 2026-09-08 归档补充：当前获准的外部证据归档允许 Agent 显式用 `start.recordingDir` 为单次执行保留已经取得的手机载荷文件。具体契约见 [EVIDENCE_ARCHIVE.md](../desktop/ai-app-bridge-cli/docs/EVIDENCE_ARCHIVE.md)。这是以下 Host 零复制规则的有限例外：默认执行路径不复制；Host FactStore 仍只存附件引用和 hash；live/history、断连、恢复路径均不能读取这些文件，不后台补齐，不新增手机数据查询库或自动报告工作流。

> 状态：执行任务书
>
> 适用对象：Grok、Cursor Agent、Codex 或其他实现代理
>
> 当前记录基线：`codex/script-intent-isolated-rebuild` @ `eec151b`（实施前必须重新核对）
>
> 2026-09-10 推进顺序：本文件是基础能力子计划，不再把全部存储 Phase 作为复杂 App Intent/Script 开发的串行前置。遵循[复杂 App 主线](BRIDGE_NEXT_GATES_2026-09-08.md#2026-09-10-用户纠偏后的当前优先级)：修复当前业务流程实际遇到的正确性阻塞，随后回到业务验收；其他存储性能与边界项保持未完成，并在生产交付前验证。

文档关系：本文件是 `docs/SCRIPT_INTENT_RUNTIME_CAPTURE_MASTER_PLAN.md` 的 CaptureStore 子计划。`docs/SCRIPT_INTENT_ISOLATED_REBUILD_PLAN.md` 中“Legacy 外观不变、Script / Intent / Legacy 代码隔离”的原则继续有效；其“Script 只允许声明式 steps、禁止 JS/Python”的结论失效。JS/Python runtime 和持续进度摘要以总计划为准；Intent execution 只提供中性历史，Agent 自行读取历史编写 Script，并在回放后自行按证据引用编写报告，代码不做 Intent→Script 转换或报告组装。

## 1. 最终目标

把 Android / iOS SDK 中 `logs`、`network`、`state`、`events` 的写入和查询收敛到一个深模块 `MobileCaptureStore`：

1. 手机端 segmented FactStore 是 App 事实的权威持久来源。
2. 内存只保留严格按字节计费的热缓存；缓存可整体丢弃，不能成为第二份事实来源。
3. 现有 `/v1/logs`、`/v1/network`、`/v1/state`、`/v1/events` 名称、参数和 Legacy 返回保持不变。
4. Script / Intent 通过各自隔离的 `CapturePort` 使用同一批既有查询能力，不调用 `LegacyDispatcher`。
5. 手机保持连接时才查询手机事实；断开后返回 `target_disconnected` / `inconclusive`，不从 Host 旧数据兜底。
6. 执行链路不后台复制手机 capture payload。Host ledger 只保存 execution、decision、action、checkpoint 和手机 `factId` 引用；测试完成后 Agent 可通过现有 evidence 查询按引用取回本轮所需证据，该读取不能成为实时决策或断连兜底。
7. 不新增 Agent 可见的存储、同步、segment 或 cursor 命令。
8. 不引入 ADB 后台轮询、ADB reconnect、UiA2、instrumentation 或新的手机辅助包。

完成后的数据流：

~~~text
App SDK / Flutter forwarding
          │
          ▼
   MobileCaptureStore
   ├─ Segmented FactStore        权威事实
   ├─ Byte-bounded HotCache      可丢弃查询加速
   └─ Rebuildable Projection     仅在性能 Gate 证明需要时启用
          │
          ├─ Legacy response adapter → 现有四个命令原样返回
          ├─ Script CapturePort  → 当前决策结果 + mobile fact refs
          └─ Intent CapturePort  → 当前决策包 + mobile fact refs

Host ExecutionStore
   └─ execution / decision / action / checkpoint / mobile fact refs
~~~

## 2. 范围与非目标

### 2.1 本计划包含

- Android SDK 的四类 capture 写入、查询、status、clear 和 FactStore lifecycle。
- iOS SDK 的等价能力及 Swift 队列一致性。
- Flutter Android / iOS 转发映射与 vendored iOS source mirror。
- 手机 FactStore 的 additive commit receipt、读取页和 gap / watermark 元数据。
- Host 对手机 capture 的连接态查询、零 payload 复制和断连语义。
- Script / Intent 共用协议、分别拥有的只读 `CapturePort`。
- Legacy 契约、内存、并发、故障、性能和真机验收。

### 2.2 本计划不包含

- JS / Python Script runtime 由总计划实现；本子计划交付它直接使用的 `ScriptCapturePort`，不另造存查链路。
- 不扩展当前声明式 Script DSL；总计划以 JS/Python code runtime 替换它。
- 不重做 Intent 状态机、动作执行器、Provider、page-summary 或 UI 观察层。
- 不改变 tree、screenshot、Flutter nodes、H5 DOM、CDP 或 WDA/XCUITest。
- 不把手机证据做成 Host 离线查询库，不做手机到 Host 的持续同步或补齐；验收时由 Agent 通过现有查询按本轮 refs 取证并生成报告，不新增自动报告工作流。
- 不更改 Web Bridge 和 Host-owned device log 的存储归属。
- 默认不修改 segmented 文件格式：优先用 additive wrapper、receipt sidecar/index partition 和可重建 projection。若现有格式确实无法提供 stable commit receipt/mobileFactId/watermark，允许在独立格式 Gate 后演进；该 Gate 必须包含旧文件读取、新旧 writer/readers 兼容矩阵、crash-tail/golden/migration/rollback，不能用“文件格式零改”作为假通过条件。
- 不处理既有 Host SQLite 文件迁移。

## 3. 当前代码事实

实施代理必须先重新核对下表，不能把本文记录当作实时事实：

| 位置 | 当前行为 | 已知问题 |
| --- | --- | --- |
| `android/ai-app-bridge-android/.../AiAppBridge.kt` | `record*` → `CaptureAppend` → `MobileCaptureStore.append()`；GET → `query()` + `LegacyLiveView` | FactStore enqueue 仍是 additive persistence，不是 live GET |
| Android / iOS 热缓存 | `BoundedMemory` CountCaps 300/200/300/200，另有 byte budget | live GET 后端仍是 memory-only（`persistent: false`） |
| `ios/ai-app-bridge-ios/.../AiAppBridge.swift` | 与 Android 相同：无四流容器，无 shadow 双写 | iOS physical G8 仍未补 |
| `SegmentedFactStore` | 支持 append、cursor read、gap、quota、reopen | 不是 live GET backend |
| Flutter | Dart → MethodChannel → HTTP fallback；iOS vendor 与 iOS SDK 同源 | Dart 没有第二份 store |
| Host ObservationCollector | 不 idle poll 手机四流，不 `recordEvidence(payload)` | Host-owned execution/history 仍保留 |
| Host `history:true` | 断连不回退 Host 复制的手机 payload | 无 |

实施导航；开始 Phase 0 前仍须用搜索确认调用关系，不能只按文件名修改：

- Android capture 入口：`android/ai-app-bridge-android/src/main/kotlin/io/github/mobileaidev/aiappbridge/android/AiAppBridge.kt`
- Android 落盘：同目录的 `ObservationFactSink.kt`、`SegmentedFactStore.kt`、`MappedSegmentedFactStore.kt`
- iOS capture 入口：`ios/ai-app-bridge-ios/Sources/AiAppBridgeIOS/AiAppBridge.swift`
- iOS 落盘：同目录的 `ObservationFactSink.swift`、`SegmentedFactStore.swift` 与 `Sources/SegmentedFactStoreC/`
- Flutter iOS mirror：`flutter/ai_app_bridge_flutter/ios/ai_app_bridge_flutter/Sources/AiAppBridgeIOS/` 与 `Sources/SegmentedFactStoreC/`
- Host 复制路径：`desktop/ai-app-bridge-cli/bin/observation-collector.js`、`fact-recorder.js`、`mcp-server.js`
- 隔离边界：`desktop/ai-app-bridge-cli/bin/script/`、`desktop/ai-app-bridge-cli/bin/intent/`、`desktop/ai-app-bridge-cli/bin/legacy/legacy-dispatcher.js`
- 外部路由兼容入口：`desktop/ai-app-bridge-cli/bin/command-router.js`

当前必须保留的用户文件：

- `flutter/ai_app_bridge_flutter/pubspec.lock` 当前为未跟踪文件；实施时不得删除、覆盖或提交，除非用户另行要求。

## 4. 数据所有权与连接边界

### 4.1 手机拥有的事实

以下 payload 只由手机 `MobileCaptureStore` 权威保存：

- SDK `logs`
- SDK / instrumented `network`
- SDK `state`
- SDK / UI observer `events`
- 已有自动 App log、process logcat、H5 console 等手机来源，但仍遵守各自公开可见性规则

自动 logcat、H5 console 或其他持久来源不能因为统一存储而自动出现在公开 `/v1/logs`。公开查询仍按原 stream/source 过滤。

### 4.2 Host 拥有的事实

Host 只权威保存：

- execution lifecycle
- Script plan / Intent decision
- dispatch marker
- action receipt
- checkpoint / progress
- Host 自己采集的 device log、Web Bridge、ADB/WDA/CDP 事实
- 对手机证据的轻量引用

手机引用至少包含：

~~~text
targetKey
runtimeEpoch
mobileFactId
actionId                  nullable
capturedAtMs
stream
~~~

Host 不保存引用所指向的手机 capture payload。

### 4.3 断连语义

- 手机端查询连接失败：`target_disconnected`。
- Script：当前步骤失败并暂停，保留可恢复 execution state。
- Intent：本轮 observation 为 `inconclusive`，不允许基于 Host 旧记录继续动作。
- Legacy：保持现有连接错误形式。
- 恢复连接后重新查询手机；不执行 Host→手机或手机→Host 补齐任务。

## 5. 深模块与 Interface

### 5.1 `MobileCaptureStore`

Android 与 iOS 实现相同语义、不同语言的模块：

~~~text
append(record, durability) -> AppendReceipt
mark(streams)              -> CaptureWatermark
query(query)               -> CapturePage
status()                   -> CaptureStoreStatus
clear(scope)               -> ClearReceipt
~~~

Interface 隐藏：

- mmap segment / offset
- writer queue
- large-fact chunk
- cache 淘汰
- projection rebuild
- runtime transport
- Android / iOS 存储目录差异

`mark()` 仅供内部 Script / Intent 决策窗口使用，不加入 Agent capabilities。

### 5.2 内部 Adapter

保留两个真实 Adapter，避免假想 seam：

1. `SegmentedCaptureBackend`：生产持久实现。
2. `BoundedMemoryCaptureBackend`：测试、store opening 和明确 degraded fallback。

`BoundedMemoryCaptureBackend` 也必须有严格字节上限。它不能宣称 `persistent=true`。

### 5.3 Capture 数据

所有四流先完成现有 redaction / truncation，再进入 `MobileCaptureStore`。同一条 capture 只序列化一次，缓存和 writer queue 共享同一不可变 UTF-8 byte buffer。

内部记录至少包含：

~~~text
schema
stream
partition
targetKey
runtimeEpoch
captureId                 现有 per-runtime 数字 id
actionId                  nullable
source
timestampMs
record                    已脱敏的 Legacy record
~~~

commit 后生成稳定引用：

~~~text
mobileFactId = mf1:<storeGeneration>:<globalSequence>:<hashPrefix>
~~~

- `storeGeneration` 在新 store / clear 后变化，不修改 segmented C 格式。
- `globalSequence` 来自真实 commit receipt。
- `hashPrefix` 来自 canonical persisted bytes，用于发现错误引用。
- Legacy JSON 不增加这些内部字段。

### 5.4 持久化语义

- SDK capture 默认 `async`：调用线程只完成脱敏、一次序列化和有界 enqueue。
- UI 主线程不执行文件读写、flush、segment scan 或 projection rebuild。
- `append()` 返回 accepted 不等于 committed；内部 receipt 明确 `pending / committed / dropped`。
- `query()` 与 writer 使用有序 seam，提供 read-your-writes；pending cache 与 committed facts 合并时按 `mobileFactId` / runtime capture identity 去重。
- Script / Intent 只有拿到 committed fact refs 和完整 coverage 才能把事实用于强证据判断。
- Legacy persistence 失败不改变原命令成功结果，但 status 暴露 degraded / dropped。

### 5.5 热缓存

默认总预算先设为 1 MiB，预算包含 pending 和 hot payload，二者共享 byte buffer，不能双算两份：

| Stream | 默认预算 | 淘汰策略 |
| --- | ---: | --- |
| network | 384 KiB | 按时间 FIFO ring |
| logs | 256 KiB | 按时间 FIFO ring |
| events | 256 KiB | 按时间 FIFO ring |
| state | 128 KiB | 按 key 的 update/access LRU |

同时保留安全 count cap，防止大量极小记录产生元数据膨胀。预算必须可在内部测试配置中覆盖，不能新增 Agent 参数。

重要区分：

- logs/network/events 是时间流，使用 FIFO；传统 LRU 会破坏时间窗口。
- state 是 latest-by-key 投影，使用 LRU；每次更新同一 key 只能保留最新值。
- `status.capture.*` 表示 Legacy 逻辑窗口计数，不等于 HotCache 当前物理对象数。

### 5.6 查询视图

同一个模块提供三种内部 view，调用者不能自行拼接 store/cache：

1. `legacy-live`
   - 供现有四个 endpoint。
   - 严格复刻原窗口、过滤、排序、limit、JSON 和 null 语义。
2. `connected-history`
   - 供已有 `history:true` 在手机连接时读取手机持久事实。
   - 使用 opaque page cursor、`gap`、`hasMore`；不返回 segment/offset。
3. `decision-window`
   - 供 Script / Intent。
   - 基于 pre-action watermark、runtimeEpoch、actionId、stream 和截止时间。
   - 返回 coverage、committed fact refs 和临时 payload。

查询顺序：

~~~text
query
→ 判断 HotCache 是否完整覆盖请求区间
→ 完整：直接返回
→ 不完整：读取 FactStore
→ 合并尚未 commit 的同一 byte buffer
→ 去重、按 Legacy 或 decision 语义排序
→ 返回 coverage / gap / refs
~~~

Hot path 禁止从 store 起点全量扫描。

### 5.7 查询投影

第一步复用现有 cursor 和 HotCache coverage，不立即引入新的 SQLite 依赖。

在最大保留量下执行 cold-query benchmark：

- 若 200 条目标记录 p95 ≤ 100 ms，保持现实现，不增加投影。
- 若超过 100 ms，必须在切换生产读取前实现 `CaptureIndexProjection`。

`CaptureIndexProjection` 只能是可重建索引：

- 优先使用现有 `index` partition 保存周期性 tail/state checkpoint。
- payload 仍只存在原 FactStore partition。
- projection 写失败不删除或覆盖事实。
- projection 缺失时允许后台 rebuild；当前 Legacy 热查询继续使用有界缓存。
- rebuild 不在 App 主线程，不阻塞 SDK `record*`。

## 6. Legacy 兼容合同

### 6.1 必须原样保留

- `/v1/logs`、`/v1/network`、`/v1/state`、`/v1/events` 路径。
- GET / POST method、请求字段、默认值和错误形式。
- `sinceId`：只返回 `id > sinceId`。
- `sinceMs`：保留 `timestampMs >= sinceMs`。
- filter 后取最后 `limit` 条的顺序。
- Android 默认 limit 200、最大 500。
- iOS 默认 limit 200、最大 1000。
- Android POST wrapper、iOS POST wrapper 的现存差异。
- Android state key 的 `namespace.key` 与 iOS 的 `namespace:key` 差异。
- redaction、body truncation、source、type、timestamp 和 id。
- Android / iOS `status.capture` 的现有字段。
- 正常范围内的 clear 和重新记录行为。

### 6.2 Legacy 逻辑窗口

即使 FactStore 保存更多事实，`legacy-live` 仍模拟原逻辑窗口：

- Android / iOS logs：最后 300 条。
- network：最后 200 条。
- events：最后 300 条。
- state：最后 200 个最新 key。

HotCache 可以比这个窗口小；不足部分从 FactStore / projection 读取。不能为了兼容继续把完整 Legacy 窗口 payload 常驻内存。

### 6.3 明确批准的行为修正

iOS `stateEntries` 当前没有执行已声明的 200 上限。本计划按用户要求修为 byte-bounded keyed LRU：

- ≤200 个 key 时必须与当前结果等价。
- >200 个 key 时按明确、可测试的 update/access LRU 淘汰。
- 该变化必须单列为 intentional delta，不能伪装成零差异。

### 6.4 `history:true`

`history:true` 是新增持久化能力，不属于旧版最初的 live command 行为。本计划将手机 target 的语义改为：

- 连接时直接读取手机 `connected-history`。
- 断开时返回 `target_disconnected`，不读 Host 副本。
- Web Bridge、Host device-log 等 Host-owned history 保持原路径。

capabilities 中已有字段不删除；只修正手机来源与断连语义，并更新文档。

### 6.5 `_feedback.evidence` intentional delta

HEAD 的真实行为必须在 G0 冻结：foreground command 与 `feedback:'full'` probe 的结果会先作为 payload 写入 Host FactStore，再把轻量 Host `{partition, globalSeq, ...}` refs 放进 `_feedback.evidence`；background ObservationCollector 事实只写 Host，不回填某次 response，`feedback:'off'` 也不会阻止底层复制。

目标合同写死为：

- Legacy primary result 不变；显式执行 `logs/network/state/events/tree/screenshot` 时，其当前 payload 仍只出现在该命令自己的主响应中。
- `_feedback.evidence` 只允许有界 refs、coverage、timing 和本轮 UI semantic comparison，不内联 mobile capture payload。
- `feedback:auto/off` 不得为补齐 `_feedback` 自动拉四流；`off` 仍只控制是否返回 feedback metadata。
- `feedback:full` 可以保留明确请求的当前 UI probe，但只采其验证所需的 events/tree/screenshot，不启动长期 collector，也不把 mobile payload 复制到 Host。
- background mobile ObservationCollector 被删除；`_feedback.observer` 的旧 health metadata 属于 intentional delta，更新为“不运行/不适用”或移除前必须有 before/after contract test。

这项变化只涉及辅助 feedback/history 数据路径，不授权修改 Legacy 主命令的执行、主响应或错误。

## 7. Host、Script 与 Intent 接线

### 7.1 Host 零复制

对 Android / iOS App capture：

- `ObservationCollector` 不再按 1 秒持续拉取四流并把 payload 写 Host。
- foreground command 结果不再经 `FactRecorder.recordEvidence()` 复制 payload。
- full feedback probe 只在 `_feedback` 保留本轮有界 UI semantic comparison、coverage 和手机 refs，不内联 mobile capture payload；Legacy command 的主结果仍按原合同返回。
- Host FactStore 可以保存引用和 execution control facts，不保存 capture record body。
- 无显式查询、无活跃 Script/Intent 决策窗口、无 active condition wait 时，四流手机调用数必须为 0。`wait-text`/H5/Web/evidence-window wait 可以在 deadline 内只轮询声明所需通道，并单独记录 poll count 与 `businessWaitMs`；它不算 idle，但也不得启动全局四流采集。

按 target kind 分支保留 Host-owned 数据：Web Bridge、device-wide logcat、ADB/WDA/CDP 事实不受此规则影响。

### 7.2 Script / Intent 隔离

新增两个独立 Interface：

~~~text
ScriptCapturePort.query(commandName, args, executionContext)
IntentCapturePort.observe(requirements, executionContext)
~~~

共同规则：

- 生产 Adapter 可以调用同一个底层 provider / mobile endpoint。
- Script / Intent 不 import `LegacyDispatcher`、旧 Batch 或彼此实现。
- Agent / 脚本仍使用 `logs/network/state/events` 的既有概念和记录形状。
- store cursor、segment、projection、writer queue 对 Agent 不可见。
- 当前声明式 Script 不增加新的 DSL step；总计划中的 JS/Python runtime 直接使用该 Port。

### 7.3 决策窗口

动作相关判断必须避免“动作完成后才开始抓网络”的竞态：

~~~text
pre-action mark
→ dispatch actionId
→ App 产生 network/log/state/event
→ query decision-window until match or deadline
→ close through watermark
→ 根据 coverage + predicate 给出 verdict
~~~

Host action receipt 记录 watermark 关联和 `mobileFactId`，不记录手机 payload。

判断矩阵：

| 事实结果 | Coverage | Verdict |
| --- | --- | --- |
| 匹配请求且 statusCode 满足断言 | complete | passed |
| 匹配请求但业务断言失败 | complete | failed |
| 截止时间内没有匹配记录 | complete | failed |
| store disabled / queue drop / cursor gap | partial | inconclusive |
| 手机断连 / runtimeEpoch 改变 | unavailable | inconclusive，并暂停当前执行 |

“没有匹配”只有在窗口完整时才是失败；证据缺失不能伪装成业务失败。

## 8. 清理与生命周期

- Android clear：先停止接收、drain writer、旋转 store generation、清 HotCache，再删除旧目录并按现有流程重启。
- iOS clear：保持外部返回不变，同时旋转 store generation，使旧事实不能重新出现在 `legacy-live`；旧 generation 异步清理。
- start/opening：使用共享 byte-budget 的 bounded pending cache；open 成功后按顺序 flush。
- open 失败：Legacy 继续使用 degraded bounded memory；Script/Intent 强证据返回 `inconclusive`。
- close：停止接收新写入，bounded drain，关闭 backend；不能无限等待。
- process restart：默认 Legacy view 只看当前 runtimeEpoch；connected-history 可显式跨 runtime 分页。
- runtimeEpoch 改变时，进行中的 Script/Intent decision-window 失效并重新观察。

## 9. 分阶段实施

本节是 CaptureStore 自身的顺序；它不阻塞总计划中的 ScriptSpec/Fake/JS/Python child track。总计划 P0 与本计划 G0 都通过后，G1–G7 可与总计划 P2/P3 并行；只有生产设备 ScriptHostPort/IntentCapturePort 接线必须等待 G7。

### Phase 0：冻结真实合同

只加 characterization / golden tests，不切生产路径。

工作：

1. 记录实时 branch、HEAD、dirty files、SDK versions。
2. 冻结 Android 与 iOS 四流 GET/POST/status/clear JSON。
3. 覆盖 sinceId、sinceMs、limit、顺序、state overwrite、redaction、overflow。
4. 冻结 Flutter MethodChannel 与 HTTP fallback 调用形状。
5. 给 Host 手机 payload 复制路径添加反向测试，证明当前确实在复制，供 Phase 6 删除时翻转断言。

Gate G0：

- 所有基线测试通过。
- Android / iOS 差异分别记录，不“顺手统一”。
- 无生产代码变化。
- 用户未跟踪文件零变化。

### Phase 1：纯 CaptureStore 合同

新增纯模型、query/filter/order/cache policy 和 bounded-memory test Adapter；不接 AiAppBridge 单例。

Gate G1：

- 同一组 contract fixtures 在 Kotlin 与 Swift 通过。
- FIFO、state LRU、byte accounting、dedupe、coverage、gap 全覆盖。
- 1,000,000 个小记录与 10,000 个最大允许网络记录后，cache owned bytes 不超过配置预算。
- 测试 Interface，不测试内部容器字段。

### Phase 2：FactStore receipt 与读取原语

以 additive 方式增加：

- async commit receipt
- stable store generation / mobileFactId
- bounded page read
- through watermark
- flush/drain completion

现有 `SegmentedFactStore.record()` 行为和测试保持不变。

Gate G2：

- accepted、committed、queue-full、closed、disabled 可区分。
- append 后立即 query 满足 read-your-writes。
- reopen、tail recovery、large fact、CRC、quota eviction、cursor gap 通过。
- clear 后旧 generation 不可通过新 cursor 读取。
- 默认 additive sidecar/index 路径不修改事实 record 格式；若必须改格式，先通过旧文件读取、新旧 reader/writer 矩阵、golden、crash-tail、迁移和 rollback 的独立兼容 Gate，随后才允许进入 Phase 3。

### Phase 3：Android shadow 与切换

步骤：

1. 接入 `AndroidMobileCaptureStore`，旧容器继续作为返回 oracle。
2. debug/test shadow 比较旧结果与新结果；生产仍返回旧结果。
3. 完成 query、status、clear、lifecycle、自动日志 source 可见性测试。
4. G3-shadow 通过后切 `/v1/*` 到 `legacy-live` adapter。
5. 删除旧四个大 payload 容器与重复 `persistMobileFact` 分支。

Gate G3：

- golden JSON exact match。
- 自动 logcat / H5 console 未意外进入公开 logs。
- 并发 append/query/clear/status 无重复、无漏项、无死锁。
- storage fault 不改变 Legacy POST/GET 的既有成功或错误形状。
- HotCache 小于 Legacy 逻辑窗口时仍能返回正确窗口。
- no main-thread file I/O。

### Phase 4：iOS shadow 与切换

步骤同 Android，并额外完成：

- 所有四流访问收拢到统一 queue / actor seam。
- 修复 state byte-bounded LRU intentional delta。
- 更新 Flutter vendored iOS source mirror。

Gate G4：

- Android 的 G3 项在 iOS 等价通过。
- Thread Sanitizer / 并发测试无数据竞争。
- `SegmentedFactStoreSourceMirrorTests` 通过。
- Swift Package 与 Flutter iOS 构建通过。

### Phase 5：Flutter 映射验证

Flutter 不新增 Dart store 或第二份缓存，只验证 forwarding：

- Android MethodChannel 成功与 HTTP fallback。
- iOS MethodChannel 成功与 HTTP fallback。
- record 后 native query 可见。
- native store degraded 时保持现有 fire-and-forget App 行为，同时内部 health 可观测。

Gate G5：Dart public API、错误吞吐和超时行为与现有合同一致。

### Phase 6：Host 手机 payload 零复制

按 target kind 删除两类手机复制：

1. ObservationCollector 的 mobile 四流 idle polling / recordEvidence。
2. foreground/probe 对 mobile capture payload 的 FactRecorder 写入。

接入 connected mobile history；Host-owned sources 保持。

Gate G6：

- spy/static test 证明 mobile payload 不进入 Host FactStore。
- Host execution facts 和 mobile fact refs 仍可查。
- 显式四流查询的 Legacy 主 payload 保持 golden；`_feedback.evidence` 只含 refs/coverage/timing，不含 raw mobile records。
- `feedback:auto/off` 不额外拉四流；`feedback:full` 只做有界、明示 UI probe。
- 无显式查询、活跃 execution 或 condition wait 时等待 60 秒，手机四流调用数为 0。
- 手机断开后 `history:true`、ScriptCapturePort、IntentCapturePort 均不返回 Host 旧事实。
- Web/device-log Host history 回归通过。

### Phase 7：Script / Intent 决策 Port

实现 Port 和 fake adapters，供总计划中的 JS/Python Script 与 Intent 分别使用：

- ScriptCapturePort 支持四个只读命令形状。
- IntentCapturePort 可按 `require` 组装当前轮 capture evidence。
- action pre-mark、actionId、deadline、coverage、fact refs 接通。
- execution/decision 只持久化 refs 和 verdict。

Gate G7：

- 一次登录流程可通过 network statusCode 判断下一步。
- 一次日志断言、state 断言、event 断言通过。
- negative assertion 只有 complete window 才返回 failed。
- gap / queue drop / runtime restart / disconnect 返回 inconclusive。
- Script/Intent 不引用 LegacyDispatcher、旧 Batch 或彼此实现。

### Phase 8：性能、压力与真机

先用 SDK sample 产生可控事实，再做真实流程；不能只做 mock。

最低矩阵：

- Android JVM contract / FactStore tests。
- Android 当前连接 OPPO 真机。
- iOS unit + simulator；有真实 iOS 设备时补 physical gate，未补不得声称 iOS release-ready。
- Flutter example 的 Android 真机转发。
- 一个固定 Script-style 登录/提交网络断言。
- 一个 Intent-style 日志/state/event 辅助判断。

Gate G8 见第 11 节。

### Phase 9：删除过渡代码与文档收口

- 删除 shadow oracle、旧 payload containers 和无调用路径。
- 保留 contract fake，不保留生产双写开关。
- 更新 README、DESIGN、DOKIT_LOG_CAPTURE 和 Script/Intent 计划中的手机事实归属。
- 输出完整兼容差异、性能和残留风险。

Gate G9：静态搜索、全量测试、真实设备结果和文档一致。

## 10. 测试矩阵

### 10.1 合同测试

每个平台分别覆盖：

- recordLog / Network / State / Event SDK 调用。
- POST `/v1/*` wrapper。
- GET empty / one / many。
- sinceId 边界、sinceMs 相等边界。
- invalid/negative/oversized limit。
- filter 后 `takeLast(limit)`。
- state 同 key 更新与 key 顺序。
- clear 后立即 query。
- status.capture 计数。
- redaction 和最大 body。

### 10.2 Store / Cache 测试

- cache hit、partial coverage、cold read。
- pending + committed merge。
- repeated query 无重复。
- queue full / disabled / closed。
- cursor expired / quota eviction / gap。
- reopen / crash-tail recovery。
- large fact chunk / manifest。
- clear 与并发 writer/read。
- projection corrupt / rebuild（若启用）。

### 10.3 Host 测试

- mobile ObservationCollector 不 idle poll。
- normal mobile command 不持久化 payload。
- mobile history 连接态直读。
- disconnect 无 Host fallback。
- Host-owned target history 保留。
- execution facts 只含 refs，不含手机 record body。

### 10.4 Script / Intent 测试

- pre-action watermark 不漏掉快速完成的请求。
- actionId 精确命中和 time-window fallback。
- 网络成功、网络失败、没有请求、延迟请求。
- log/state/event 对应判断。
- runtimeEpoch 改变使窗口失效。
- fact 未 commit、gap 或掉盘时停止强结论。

## 11. 性能与资源门禁

所有数字在当前 OPPO 和测试机分别记录 p50 / p95 / p99，不只报最好值。

| 指标 | Gate |
| --- | --- |
| SDK `record*` 调用线程附加耗时 | p95 ≤ 1 ms，p99 ≤ 3 ms |
| Hot query，最多 200 条 | p95 ≤ 10 ms |
| Cold query，最多 200 条 | p95 ≤ 100 ms；不满足则必须先上 projection |
| decision query 自身耗时 | p95 ≤ 50 ms，不含等待业务请求出现的时间 |
| CaptureStore 主线程文件 I/O | 0 次 |
| Hot/pending payload bytes | ≤ 1 MiB 默认预算 |
| 长压内存 | 记录数继续增长时 retained heap 不线性增长 |
| Idle mobile 四流 Host 请求 | 0 次 |
| 新增 ADB child / reconnect | 0 次 |

压力场景：

- 100,000 logs。
- 20,000 带最大允许 body 的 network records。
- 10,000 unique state keys。
- 100,000 events。
- 100 次 open/close/clear/reopen。
- queue-full、low disk、tail corruption、projection rebuild。

只用 count cap 通过不算合格；必须报告真实 serialized bytes、cache owned bytes、heap/PSS 和磁盘增长。

## 12. 静态门禁

实施后执行等价静态检查：

1. `AiAppBridge` 不再持有四个大 payload 容器。
2. 四个 record path 只进入 `MobileCaptureStore.append()`。
3. 四个 GET path 只进入 `MobileCaptureStore.query()` + Legacy response adapter。
4. Android/iOS production code 没有双写 feature flag。
5. Script / Intent 不 import LegacyDispatcher / Batch。
6. mobile target 不调用 Host `FactRecorder.recordEvidence(payload)`。
7. 手机断连路径没有 Host history fallback。
8. 无 UiA2、instrumentation、ADB reconnect、`adb kill-server` 或 transport reset。
9. Flutter 没有新增第二个 Dart capture store。

## 13. 立即停止条件

出现任一项就停止当前 Phase 并报告：

1. 旧命令 golden JSON 出现未批准差异。
2. 新查询需要扫描整个保留区才能完成 hot path。
3. storage fault 改变 Legacy 正常命令结果。
4. iOS / Android 在同一 Phase 被同时大范围重写。
5. Host 返回手机断连前的旧事实作为当前决策证据。
6. 手机 payload 被新路径复制到 Host。
7. HotCache 或 pending queue 可无界增长。
8. App 主线程发生文件读取、flush 或 rebuild。
9. clear 后旧事实重新进入 Legacy live view。
10. 引入 ADB 恢复、UiA2 或额外手机安装包。
11. 用户未跟踪文件发生变化。

## 14. 回滚策略

- 每个平台独立切换：Android 和 iOS 不放在同一个不可分割提交。
- shadow 阶段只在 test/debug harness 中存在；生产切换后不保留长期双写。
- 每个 Phase 先产出测试和报告，再申请进入下一阶段。
- G3 失败只回滚 Android CaptureStore wiring，不回滚 FactStore receipt 原语。
- G4 失败不影响已通过的 Android。
- G6 失败恢复 Host mobile capture 的现有路径，但不回滚手机统一存查。
- 不执行 destructive Git 命令；不 push。是否 commit 由用户单独授权。

## 15. 每阶段交付格式

~~~text
Phase:
Starting branch / HEAD:
Files changed:
Legacy golden:
Android tests:
iOS tests:
Flutter tests:
Host tests:
Mobile payload copied to Host: yes/no
Hot bytes / heap / PSS:
Write/query p50/p95/p99:
Idle mobile calls:
ADB processes before/after:
Intentional deltas:
Gate result: PASS / FAIL / BLOCKED
Open risks:
Next phase authorized: yes/no
~~~

命令成功不等于 Gate 通过；报告必须同时给出断言、计数、资源和失败注入结果。

## 16. 最终验收

全部满足才算完成：

1. 手机四类事实只有一个统一写入与查询模块。
2. FactStore 是持久事实来源，内存是 byte-bounded cache。
3. Android / iOS Legacy live commands 除明确 iOS state overflow 修正外保持合同。
4. Script / Intent 通过隔离 Port 使用现有四类查询能力。
5. 网络、日志、state、event 均能作为连接态决策依据。
6. 决策记录只保存手机 fact refs，不保存手机 payload。
7. 断连无 Host fallback，当前执行暂停或 inconclusive。
8. Host 不持续轮询或复制 mobile capture payload。
9. Web/device-log 等 Host-owned 历史未回归。
10. Hot cache、pending、projection、FactStore quota 全部有界。
11. Android OPPO 真机性能和长压通过。
12. iOS 未完成 physical gate 时明确标注，不声称全平台 release-ready。
13. 无新增 ADB / UiA2 / instrumentation 风险。
14. 旧容器、shadow 双写和过渡代码已删除。
15. 文档与最终实现一致。

## 17. 给实现代理的首条指令

~~~text
先完整阅读 docs/SCRIPT_INTENT_RUNTIME_CAPTURE_MASTER_PLAN.md，再阅读本文件。现在只执行 CaptureStore Phase 0：重新核对当前 branch/HEAD/dirty files，新增 Android/iOS/Flutter/Host characterization 与 golden tests，输出 G0 报告。不要修改生产存储、查询、Host observer、Script 或 Intent；不要碰手机、ADB、UiA2、MCP 或用户未跟踪文件。G0 未通过时停止，不进入 Phase 1。
~~~
