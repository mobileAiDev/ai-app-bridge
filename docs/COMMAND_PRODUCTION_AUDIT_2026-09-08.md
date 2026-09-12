# Bridge 命令与生产就绪审计（2026-09-08）

**结论：当前是有真实 Android 闭环证据的研发候选版，尚未达到整个体系的生产交付标准。** 原有命令值得保留的能力很多，但发行包、设备动作保护、参数与错误合同、安装流程、跨平台采证和执行接线仍有明确缺口。继续扩大 sample 场景之前，应先收口这些问题。

源码基线：`4da58fac5a9f8e522e85f7aa2f23cea195d75f95`，分支 `codex/script-intent-isolated-rebuild`。本次只读审查生产代码，新增审计文档和证据，并更新后续关口的优先级；没有改动运行时代码、安装 App、操作手机、推送或发布。预先存在的未跟踪 Flutter `pubspec.lock` 保留。

这里的“生产级”指工具可稳定分发、连续运行、明确失败、给出可信证据，并能在支持的平台复现。SDK 的 debug 接入定位没有因此变为允许业务 Release 包开放控制入口。

## 1. 范围、证据与直接回答

实际公开面为 **97 个命令：94 个既有命令、3 个 Script/Intent/evidence 入口，涉及 134 个公开参数名**。逐项处置与参数见 [命令清单](COMMAND_CATALOG_AUDIT_2026-09-08.md)，原始结构化目录见 [command-catalog.json](audits/2026-09-08/command-catalog.json)。这覆盖公开命令盘点与生产路由审查，不代表本轮逐一运行了 97 个真机流程。

证据汇总在 [audit-evidence.json](audits/2026-09-08/audit-evidence.json)，包含 23 个关键源码文件的 SHA-256、打包结果和可核对的探针输出。完整本地日志及复现程序在 [审计原始目录](../build/ai_app_bridge_artifacts/production-readiness-audit-2026-09-08)。探针使用模拟 ADB/WDA、注入函数和一个启动后关闭的 loopback Web provider，没有访问真实手机。

本轮验证：

- Host 存储、采证 HTTP 接线及租约合同相关测试 **63/63**。
- Android 真实磁盘 Capture 后端测试 **19/19**，包括关闭后重新创建 store/capture 实例读取、历史超过热窗口、引用、游标与淘汰；这是 JVM 磁盘测试，不等于 Android 进程崩溃或断电实测。
- iOS Capture 内存合同测试 **4/4**，在 macOS XCTest 运行；测试明确断言 `persistent=false`、无 committed refs，不能解释为 iPhone 持久化通过。
- 14 个命令/返回值探针、2 个跨平台 Script target 探针、1 个前台不匹配探针、2 个 WDA 不确定结果探针；这些是行为复现，不是 19 项生产验收通过。
- 实际 npm tarball 在新目录解包后，CLI/MCP 两个入口的 `--help` 都加载失败。外部依赖经 `NODE_PATH` 提供，故这是打包入口复核，尚不是完整干净 `npm install` 验收。

前两次 Web 探针没有启动 provider，属于审计夹具错误，已保留；最终探针启动/关闭真实 loopback provider 后重做，未把早期夹具错误记成 Bridge 缺陷。

### install 现在走新 Intent 吗？

**没有。** 当前生产调用链为：

```text
run(install-apk)
  → LegacyDispatcher
  → runBridgeChecked / executeCommand
  → installApk
  → spawn(adb install)
  → installerAssistOnce / assistInstallerScreens
  → UIA dump + 固定按钮标签 + ADB tap
```

它有安装超时、部分 ROM 标签处理和 `pm path` 检查，但没有新 Intent 的 observation/decision revision、独立动作回执、操作级 status/cancel 或持续证据合同。源码中的 Android Activity `Intent` 字样也不代表接入了本项目的新 Intent 执行系统。依据：[installApk](../desktop/ai-app-bridge-cli/bin/ai-app-bridge.js#L560)、[installerAssistOnce](../desktop/ai-app-bridge-cli/bin/ai-app-bridge.js#L700)。

### 查询是真实存储查询，还是只查内存？

| 范围 | 当前生产读取来源 | 可以下的结论 |
| --- | --- | --- |
| Android `logs/network/state/events`，持久后端 attached 后 | `MobileCaptureStore → SegmentedCaptureBackend → SegmentedFactStore.readPage → 文件映射` | 是真实持久事实读取。临时结果集合和内存位置索引用来筛选、定位，不是第二份权威 payload 库。 |
| Android 初始化、持久化禁用或接入失败 | `BoundedMemoryCaptureBackend` | 仍可能只读内存；status/attachment 与强证据 coverage 必须检查。该后端不制造 committed refs。 |
| Host execution/evidence/显式 Host history | `FactStore → segmented adapter → 索引定位 → engine.readAt` | 索引定位后确实读取持久记录；SQLite 或 mmap 索引不等于把结果只存在内存。 |
| iOS 四流普通 GET | `liveCapture → LegacyLiveView → MobileCaptureStore → BoundedMemoryCaptureBackend` | 当前仍是有界内存。`decision-window` / `connected-history` 明确返回 `persistence_unavailable`。磁盘引擎存在不等于这些 GET 已接入它。 |
| Flutter | 使用对应宿主平台 capture | Android 这条动作关联链已做过真机验证；iOS 不能沿用该结论。 |
| Web 四流 live 查询 | `WebBridgeProvider.sessions` 内的数组/Map | 当前是会话内存。Web Host history 是另一条已采记录路径，不保证 SDK 每条推送都已持久化。 |
| `webview-network/console` | 本次 CDP 会话采集的局部结果 | 是现场采集，不是手机持久历史；目前返回合同不能直接充当 Script 要求的 durable capture page。 |

`mmap` 将文件映射到进程地址空间，读取会使用操作系统页缓存；它与“进程重启就全部丢失的数组”不同。是否真实持久化，应看权威文件、提交回执、重开读取和故障语义，不能按实现里是否出现内存对象判断。

依据：[Android 接入](../android/ai-app-bridge-android/src/main/kotlin/io/github/mobileaidev/aiappbridge/android/AiAppBridge.kt#L527)、[Android 查询](../android/ai-app-bridge-android/src/main/kotlin/io/github/mobileaidev/aiappbridge/android/capture/SegmentedCaptureBackend.kt#L135)、[Host 读取](../desktop/ai-app-bridge-cli/bin/segmented-fact-store.js#L519)、[iOS 内存后端](../ios/ai-app-bridge-ios/Sources/AiAppBridgeIOS/Capture/MobileCaptureStore.swift#L174)、[iOS 强查询拒绝](../ios/ai-app-bridge-ios/Sources/AiAppBridgeIOS/Capture/LegacyLiveView.swift#L29)、[Web 读取](../desktop/ai-app-bridge-cli/bin/web-provider.js#L187)。

## 2. 发布与正确性问题

P0 表示当前包无法正常交付；P1 表示相关平台/能力生产化前必须解决的正确性或合同缺口；P2 表示接口和维护性收口。本审计不是只看本次 diff 的缺陷审查，包含既有行为与现行兼容约束需要重订的部分。

### A01 · P0 · npm 发行包漏掉启动所需文件

`ai-app-bridge.js` 顶层加载 `./bridge-forward`，但 package `files` 白名单没有 `bin/bridge-forward.js`。实际打包 82 个文件后，新目录的 CLI 与 MCP 均以 `MODULE_NOT_FOUND` 退出。仓库运行和既有打包清单测试通过没有覆盖这个入口。

依据：[require](../desktop/ai-app-bridge-cli/bin/ai-app-bridge.js#L12)、[files](../desktop/ai-app-bridge-cli/package.json#L18)，证据字段 `pack`。

收口：从 tarball 安装到干净目录，执行 CLI help、MCP initialize/tools/list、runtime-status 和一条受控目标操作；校验完整相对依赖闭包。此项不能用仓库目录中的 require 成功替代。

### A02 · P1 · App-local 点击在前台不匹配时仍派发

Intent native Adapter 明确传入 `appLocalAction:true`，但公共 `tap` 发现前台包不匹配后仍执行 ADB 点击并返回 `ok:true`，仅在辅助字段写 `foreground_package_mismatch`。探针中目标为 `audit.expected`、前台为 `audit.other`，仍记录一次 `shell input tap 10 20`。这是模拟传输复现，未点击真实其他 App。

依据：[Intent 调用](../desktop/ai-app-bridge-cli/bin/intent/intent-production-adapter.js#L226)、[tap 分支](../desktop/ai-app-bridge-cli/bin/ai-app-bridge.js#L2573)，证据字段 `appLocalForegroundProbe`。

收口：区分明确的 device-coordinate 操作与 app-scoped 操作；后者目标不符、前台未知、观察失效时必须返回未派发错误。ADB 原语本身保留，不能在失败分支中悄悄扩大作用目标。

### A03 · P1 · 新旧入口没有统一物理设备动作仲裁

新 Script/Intent 使用进程内 device-mutation lease；Legacy 仍按 `(serial, packageName)` 排队。持有新租约期间，`runBridgeChecked(tap)` 仍进入 Legacy runner，探针已复现。旧同设备不同包并发 golden 也明确要求并行。多个 MCP 进程的 Map 彼此独立，不构成跨进程设备独占；本轮没有做多进程真机竞争试验。

依据：[Legacy TargetExecution](../desktop/ai-app-bridge-cli/bin/target-execution.js#L29)、[新租约](../desktop/ai-app-bridge-cli/bin/script/script-host-port.js#L215)、[旧并发 golden](../desktop/ai-app-bridge-cli/test/p0-legacy-concurrency-golden.test.js#L34)，探针 `legacy_dispatch_while_new_device_lease_held`。

收口：所有会影响同一物理前台的入口共用执行所有者；只读并发另定规则。先明确单进程或多客户端支持范围，再选择对应仲裁机制。原计划的 Legacy 并发兼容条款需要更新，不能把保持旧测试当成物理正确性证明。

### A04 · P1 · 安装没有流程合同，结果验证也不足

除未接新 Intent 外，当前安装只检查文件存在、ADB 输出 Success，以及所提供包名是否能被 `pm path` 找到；没有核对 APK 自身包名、版本、签名和实际安装物的对应关系。已有目标包存在时，存在“包存在”替代“本次正确安装”的问题。`packageAfter` 验证失败而 ADB Success 时，已复现 `ok:false,error:null`。

模拟 ADB 接受任意夹具文件的探针仅证明 Host 没有独立核验，不能解释为真实 Android 会接受非 APK 文件。安装器读取旧 UIA 树后还会查询包状态，再按原坐标点击，缺少临派发的页面/目标复核。

收口：保留安装用户入口；包传输作为明确底层操作，系统安装页交互交给通用 Intent。记录目标 APK 身份、安装前后版本/签名/安装结果，公开 operationId、进度、阻塞原因及取消后结果未知状态。系统安装器没有 App SDK 时，使用真实系统 UI 和包管理结果作为证据，不强求不存在的 App 内事件。

### A05 · P1 · iOS 持久化查询尚未接入生产四流

Swift 生产 `MobileCaptureStore` 只有 `BoundedMemoryCaptureBackend`，普通 GET 读它，强查询被 `LegacyLiveView` 明确拒绝。此次 4 项 XCTest 验证的是内存行为。应承认当前拒绝强结论是正确行为，但跨平台持久采证能力尚未交付。

收口：完成真实 C/Swift 持久后端接线，统一稳定引用、epoch、查询窗口、分页、丢失与淘汰语义；用 iPhone 做写入后重启/重开查询与断连验证。同步补 Flutter iOS 的完整 actionId ingress。

### A06 · P1 · Script 广告的 iOS/Web 动作与 target 模型不一致

Script catalog 列出了 `ios-tap/input/swipe`、`web-click/input/scroll`，但 `compileScriptSpec` 只保留 `serial/packageName`，丢弃 `deviceId/bundleId/sessionId/targetId`。变更租约无条件读取 `bound.serial`。即使单次调用显式提供 iOS/Web 参数，两个 HostPort 探针也都返回 `serial_required`，没有派发。

依据：[ScriptSpec](../desktop/ai-app-bridge-cli/bin/script/script-spec.js#L39)、[租约](../desktop/ai-app-bridge-cli/bin/script/script-host-port.js#L215)、[绑定](../desktop/ai-app-bridge-cli/bin/script/script-host-port.js#L358)，证据字段 `platformScriptProbes`。

收口：target 作为明确的平台联合类型，编译、哈希/恢复、租约、日志、调用均保留同一身份。在真正实现前，能力发现必须区分 Android 可执行与其他平台待完成，不能用虚构 serial 绕过。

### A07 · P1 · 普通输入参数有隐式变义

已复现：`tap(null,true)` 变为 `(0,1)`；负坐标进入 ADB；负 swipe duration 进入 ADB；`keyCode:0` 被 `|| 4` 变成返回键。MCP 默认 `run.arguments` 是 `additionalProperties:true`，没有按命令执行统一 schema 校验。新 `tap-flutter` 的严格校验比旧 `tap/swipe/keyevent` 完整。

依据：[requiredNumber](../desktop/ai-app-bridge-cli/bin/ai-app-bridge.js#L4653)、[动作 switch](../desktop/ai-app-bridge-cli/bin/ai-app-bridge.js#L402)、[MCP 校验入口](../desktop/ai-app-bridge-cli/bin/mcp-server.js#L973)，探针前五项。

收口：在任何设备/网络动作前统一验证类型、有限值、范围、单位、必填及互斥参数；拒绝未知参数。CLI 字符串解析与程序入口类型校验分开，不能用 `Number(null)` 或 `|| default` 猜调用者意图。

### A08 · P1 · iOS 不确定动作会切换接口再次派发

WDA 输入和滑动在首个接口任意异常后调用另一接口。注入首个请求 `ETIMEDOUT` 后，输入依次请求 `/keys`、`/wda/keys`；滑动依次请求 `/actions`、`/wda/dragfromtoforduration`，最后均返回成功。若首个动作已执行而回包丢失，存在二次动作风险；本轮证明两次派发，没有声称真实 iPhone 已发生重复输入。

依据：[wdaInput](../desktop/ai-app-bridge-cli/bin/ios-provider.js#L570)、[wdaSwipe](../desktop/ai-app-bridge-cli/bin/ios-provider.js#L641)，证据字段 `iosMutationRetryProbes`。

收口：接口能力应在动作前明确；只在确定未派发且合同允许的错误上切换。回包不确定返回 `ambiguous` 并重新观察，不能盲重放。Android clear-data 等其他副作用 fallback 一并按该规则审查。

### A09 · P1 · requestId 复用缺少请求内容冲突校验

Legacy 幂等键只取 target + requestId。同一 ID 的 tap 之后发送不同 input-text，返回的是第一次 tap 的成功结果，第二次 runner 没有执行。缓存复用本身有价值，但不同请求应明确报冲突。

依据：[TargetExecution.execute](../desktop/ai-app-bridge-cli/bin/target-execution.js#L40)，探针 `same_request_id_different_command`。

收口：记录规范化 command/arguments 的请求摘要；相同 ID 相同请求重取结果，不同请求返回 `idempotency_conflict`。同时明确 TTL、结果未知、重启与跨客户端语义。

### A10 · P1 · Web live 数据缺少字节边界与断连语义

Web capture 数组只有条数上限，stateEntries/会话/DOM Map 没有相应完整字节与生命周期边界。注入 1,200 个 state key 后，`limit:1` 返回 1 条 items 却返回 1,200 项 values；连接关闭后，显式 session 查询仍 `ok:true`，响应没有 connected 标志。不能把此响应当成当前已连接页面的新证据。

依据：[stateResponse](../desktop/ai-app-bridge-cli/bin/web-provider.js#L208)、[recordCapture](../desktop/ai-app-bridge-cli/bin/web-provider.js#L401)、[requireSession](../desktop/ai-app-bridge-cli/bin/web-provider.js#L468)，探针 `web_state_retention_and_limit`。

收口：规定 live 与显式历史模式，断连 live 查询停止强结论；增加 byte quota/TTL/丢失说明，values 与 items 使用一致窗口。为 Web 强证据设计实际来源合同，不能补几个 complete 字段冒充持久化。

### A11 · P1 · 错误表示不统一，部分失败不能稳定识别

未知命令/缺包名是纯文本；坏 Flutter 坐标是 JSON；底层异常常把整条 message 放入 error；安装验证失败出现 error=null。`toolResultForRaw` 只用 `ok===false` 决定 MCP isError，注入 `{error:'audit_provider_failure'}` 得到 isError=false。该探针证明错误整形缺口，不代表每个真实 provider 都返回这种对象。

收口：统一 `ok + error.code/message/field/details + dispatched/ambiguous + target/executionId`，确保 MCP isError 与结构化结果一致。设备不可达、目标歧义、目标失效、参数无效、超时、动作结果未知、证据不足必须分别表达。业务断言 failed/inconclusive 继续与命令执行状态分开。

### A12 · P2 · 参数发现与多入口存在明显漂移

公开 capabilities 只列 134 个参数名，没有完整类型、必填、单位、范围和 operation 分支；`tap` 说明仍只说 ADB，实际有 SDK 路径。`timeoutSec/timeoutMs/installTimeoutMs/installerTimeoutMs/intervalMs` 与多套坐标/目标参数让调用者承担过多内部知识。

compact 为 2 个 MCP tools，full 实际为 51 个 tools；full 中仍可用通用 run，不能理解为它有全部 97 个独立工具。CLI `executeCommand('script')` 实际返回 unknown command，说明命令集合与入口支持范围必须明确区分。

依据：[capabilityPayload](../desktop/ai-app-bridge-cli/bin/mcp-server.js#L856)、[runGeneric](../desktop/ai-app-bridge-cli/bin/mcp-server.js#L917)、[手工 CLI 参数映射](../desktop/ai-app-bridge-cli/bin/mcp-server.js#L1653)。

收口：一个命令定义同时提供 schema、effects、目标类型、权限、错误、handler 和已实现平台；CLI/MCP/Script 从它派生校验和帮助。默认只保留 compact，旧工具别名如需迁移必须有明确期限和等价测试。

### A13 · P1 · 生产接线仍回绕 Legacy，静态隔离不足

MCP 给 Script 注入的 actions 调用 `legacyDispatcher.dispatch`；Intent capture 也走该分发。Script 文件没有 import Legacy 并不能证明实际执行链隔离。另有旧 `script-production-adapter.js` 仍在源码/包目录，当前代码 Script 入口没有引用它，测试仍单独引用；目录结构因此容易误导审查者。

依据：[实际接线](../desktop/ai-app-bridge-cli/bin/mcp-server.js#L777)、[当前 Script 入口](../desktop/ai-app-bridge-cli/bin/script/script-entry-code.js#L8)、[总计划](SCRIPT_INTENT_RUNTIME_CAPTURE_MASTER_PLAN.md#L254)。

收口：Script/Intent 的运行控制保持各自独立，设备操作通过共同且有实际职责的 provider Interface；MCP 只做协议适配。测试从公开入口验证运行调用路径和副作用，不只搜 import 字符串。未使用的旧执行适配器迁到 test-support 或删除。

### A14 · P1 · 用户安装路径与已验证 SDK 组合不一致

CLI/Android 项目为 `0.3.0-rc.1`，Flutter pubspec 为 `0.2.4`，其 Android 插件依赖仍指向 `0.2.8`；README 示例也指向旧发布依赖。LocalSend 真机验证通过的是显式排除旧依赖、替换为本地 AAR 的组合。该实验有效，但不能代表用户按当前安装文档即可获得新能力。

依据：[Flutter Android 依赖](../flutter/ai_app_bridge_flutter/android/build.gradle#L51)、[pubspec](../flutter/ai_app_bridge_flutter/pubspec.yaml#L3)、[样例接入说明](../examples/localsend-sample/README.md#L20)。

收口：冻结兼容的 CLI/Android/Flutter/iOS 包版本与协议能力标识，制作可安装候选包，在干净 App 和干净目录按公开文档复现，再谈正式发布。文档和 Skill 从同一命令合同更新，样例专用替换不能成为默认安装要求。

## 3. 哪些命令应保留

逐项评估的建议分布：**保留 36、重构后保留 33、移入专家能力 16、收敛入口 10、迁入样例 2**。“保留”表示能力有价值，不表示免于统一 schema/报错/目标校验或已完成全平台验收。

- 日常核心保留：status、树、截图、四流查询、明确目标的点击/输入/滑动/按键、启动、Intent、Script、evidence。
- 安装、权限弹窗等多步流程保留用户入口，由 Intent 的通用流程能力承载；不要各维护一套按钮循环。
- native、UIA、Flutter、DOM 的实现差异真实存在。可以统一目标与参数合同，但不能因都叫“点击”就删除 provider 差异。
- H5 与 Flutter-H5、Flutter 全树与 operable 投影优先评估收敛为明确的 provider/view；等价性与性能未验证前不批量删别名。
- raw eval/raw action、端口转发、冻结/解冻、权限强制修改、WDA setup 留在显式专家/夹具能力面。
- `launch-native-test` 与 `smoke` 迁入样例验证；`launch-flutter` 的普通启动并入 launch-app，专用 initial route 归入样例接入合同。
- batch 保留为小批顺序调用工具，限制预算。它不承担 Script 的持续控制和业务断言合同。

## 4. 建议的实现组织

按 `codebase-design` 的 Module/Interface 原则，核心是让调用者通过少量明确合同获得完整行为，并让修复集中在同一实现位置。无需为每个旧函数再套一层类。

```text
CLI / MCP / Script SDK
  → 同一命令定义：参数、目标、effects、错误、平台能力
  → 设备执行所有者：租约、期限、取消、请求幂等与结果未知
  → native / UIA / Flutter / DOM / WDA provider
  → 明确动作回执

Intent：观察 → 决策 → 调用上述 provider Interface → 验证
Capture：按目标与视图查询权威来源 → 返回窗口、coverage、refs
Evidence：记录本轮执行/引用 → 显式采证文件 → 导出/离线核验
```

实现时避免以下形式上的“完成”：给旧 install 套 Intent 名称；给内存查询填 committed=true；让 Script 经 JSON 文本回绕 Legacy 却只测试无 import；把命令数量减少当成接口变好。

### 参数与结果的最低合同

| 项目 | 要求 |
| --- | --- |
| target | 明确 platform；Android serial/package、iOS deviceId/bundle、Web session/target 分型保留；app-scoped 和 device-scoped 明确区分。 |
| 选择器 | 坐标与 selector 二选一；selector 精确性、唯一性、观察来源和过期条件明确。 |
| 坐标 | 显式空间与单位：Android physical、Flutter logical、iOS WDA point/元素；只在唯一位置转换。 |
| 时间 | 对外统一毫秒与 deadline；长流程分别说明总期限与阶段期限；取消是否中断已派发动作必须明确。 |
| 输入 | 明确空字符串、替换/追加、可见敏感值和目标聚焦；布尔、null 和数字禁止隐式混用。 |
| 查询 | 明确 live/history/decision-window、时间/ID/游标窗口及保持分页过滤；空结果、未采、断连、未提交、已淘汰分别表达。 |
| 结果 | 命令执行、效果观察、业务断言分别表达；未派发、已派发结果未知、已验证失败不可混为一个 ok。 |
| 重试 | 动作不确定时不自动重放；只读重试有总预算；请求 ID 冲突必须可检测。 |

## 5. 推进到生产的顺序与验收

| 顺序 | 范围 | 完成条件 |
| --- | --- | --- |
| 1 | 发行与命令合同基线 | 修复真实打包入口；确定 97 项的处置；建立单一 schema/错误/平台声明来源。先冻结输入输出和目标安全要求，再迁移实现。 |
| 2 | 共享动作执行 | 修复 App-local 前台不匹配、跨入口仲裁、非法参数、幂等冲突及不确定重试；公开入口的故障注入证明错误时未误派发。OPPO 复验基础动作与固定 Script。 |
| 3 | 安装与系统流程 | 将 install/权限页交互纳入通用 Intent；覆盖首次安装、升级、拒绝/取消、倒计时或扫描阻塞、错误 APK/签名及失败后结果核验。 |
| 4 | 数据查询与跨平台 | 保持 Android 磁盘证据合同；完成 iOS 持久后端和 Flutter ingress；修复 Script 平台 target 与 Web live/历史、字节预算。每个平台各做最小真实闭环。 |
| 5 | 连续运行与故障 | 执行中取消、断连、进程重启、游标过期、磁盘不足/损坏、并发和目标变化；结果必须明确且可追溯。容量与延迟使用固定规模测量。 |
| 6 | 可分发候选版验收 | 从干净安装包和公开文档接入干净业务 App，完成受支持平台矩阵、升级/回退、能力发现、Skill 与诊断文档一致性。最后才做多 App/整机套件组合。 |

原计划里“下一轮直接进入 iOS 同义闭环”调整为先处理上述合同与正确性阻断。iOS 仍在目标内；需要的是同一套正确合同的实现，不能绕过存储和 target 缺口直接扩场景。

安全与资源验收还需包含：debug/Release 接入隔离、敏感输入/截图/网络数据处理、iOS listener 的实际可达面与访问控制、HTTP 请求大小/超时、WDA 会话身份、Web session 生命周期及各队列的 byte budget。已看到 Android loopback 绑定、iOS DEBUG 条件、证据文件字节限额/hash/权限等基础保护，但本轮没有把安全评审或完整压力门禁写为通过。

现有 NotallyX 与 LocalSend 用于验证 Bridge。已有固定场景通过继续有效，最新 LocalSend 原冻结脚本的 7 项手机断言仍保留 inconclusive。测试数量、正常流程耗时和源码目录里的新类数量，都不能代替上述交付条件。
