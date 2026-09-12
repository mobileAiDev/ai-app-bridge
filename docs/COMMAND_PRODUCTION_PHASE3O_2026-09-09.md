# 第三阶段 O：UIAutomator 节点执行，进行中

本阶段已将公共 UIA 文字点击、Intent 安装/权限选择和 Script 接入同一手机节点运行时。第八检查点完成 Android SDK localabstract 传输和后台读取超时后的同 Host 恢复验证：1043 项 Host、165 项 SDK 单测、46 个 SDK 真机场景、干净包、三轮启动及公共入口复验通过。后台读取仍可能明确超时；后续启动、SDK 读取和证据链已验证正常。此前 42 项 UIA JVM、准入前双进程退出恢复、257 次连续动作、会话退役和停机确认等证据保留。真正未知回调、更广节点故障、4 份原准备记录退役、新 SDK 在复杂 App 上的复验及其他平台仍未收口。本文件记录实施检查点，不是阶段全部通过报告，上一完整阶段验收仍为 [3N](COMMAND_PRODUCTION_PHASE3N_2026-09-09.md)。

## 实施前已核对的缺口

- 普通 `tap-text` 的 UIA 分支与 Intent 的 `tapUniqueUiaNode` 都会重读树，最后仍调用物理 tap。现有两次节点身份比较不含 bounds，也没有与手机端节点的执行身份绑定；只能减少观察到派发之间的风险。
- 在 OPPO API 36 上，重新建立 UiAutomation 连接后，同一按钮的 sourceId 保持不变，windowId 从 15437 变为 15500。不能把一次命令中的 windowId 当作后续新连接仍有效的引用。新执行端需要在同一连接内保存节点引用，并使引用随 runtime epoch 失效。
- 普通 `AccessibilityNodeInfo.performAction()` 的 false 包含拒绝、等待原回调超时和传输失败，不能直接作为远端已结束证明。新模块向系统提交一次请求，接收匹配 interactionId 的原始 Binder 回调。实现依据核对了 [AOSP AccessibilityInteractionClient](https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/refs/heads/android16-release/core/java/android/view/accessibility/AccessibilityInteractionClient.java) 和 [原回调 AIDL](https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/refs/heads/android16-release/core/java/android/view/accessibility/IAccessibilityInteractionConnectionCallback.aidl)。

## 已实现和实测

新增来源：`android/ai-app-bridge-uia/src/main/java/io/github/mobileaidev/aiappbridge/uia/UiaConnection.java`。

模块封装 UiAutomation 连接、当前窗口读取、真实 sourceId、单次点击提交及原回调接收。启动时解析确定的框架接口，不支持时直接报错。连接使用 `FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES`，不通过旧 UiAutomator runner 启动。关闭由上层在已准入动作排空后调用。以下表格保留第一检查点的连接验证；后续持久运行时见下一节。

手机为 `FYZLAU49X8OVQGJ7 / OPPO PGFM10 / API 36`。没有重建 SDK 或改变样例业务源码。证据目录：`build/ai_app_bridge_artifacts/command-production-phase3o-2026-09-09/`。

| 检查 | 最新结果 |
| --- | --- |
| 真实来源构建 | `protocol-probe/fifth/build.json` 绑定共享模块、验证程序与实际 DEX jar；Java 17 编译、D8 min API 33 |
| 同会话节点 | 真实窗口/节点引用可读取；错误 epoch 返回 stale_reference，dispatched=false |
| 原始动作回调 | 同一连接内点击 Native Increment，原 interactionId 回调 handled=true；独立 SDK 树计数从 7 变为 8 |
| 弹窗后的旧引用 | 先经独立 SDK WindowInspector 确认弹窗取得焦点，再尝试旧页面引用；返回 foreground_changed，dispatched=false，关闭弹窗后 SDK 计数仍为 8 |
| 退出 | 最终会话主动 quit 后进程 exit 0；实际手机进程表未剩余 NodeSessionProbe |

最终共享模块 SHA-256 为 `58237fba2d8f078c09e4019eda95c264ca985c320fa44270786adcf94dc659df`。最新验证是 `protocol-probe/fifth/session-report.json`，独立结果在该目录的 SDK tree、原回调结果和截图中。

这些检查走的是验证进程，尚未经过新的公共 MCP/Intent/JS/Python 执行链、共享设备所有权或完整证据归档。因此不能计为新的公共流程通过，也不能把约 25 ms 的原型点击时间当作完整 Script 性能。

## 保留的失败与纠正

- 第一版单次进程未等到可用树，selector matches 0 后未捕获异常，设备报告 exit 137。logcat 与代码位置确认发生在派发前，独立 SDK 计数为 0。后续增加有界观察同步和结构化错误，未重放未知动作。
- 单次连接的后续验证取得节点后因窗口身份变化返回 reobserve_required；据此改为会话内引用。
- 前三版会话控制器在发起 Open Dialog 后立即尝试旧引用，旧引用仍被接受，计数增加。这些失败没有先独立证明弹窗已取得焦点，不能直接认定为“已显示弹窗后误点”的产品故障。后续使用 focused window、清理本地窗口缓存，并加入独立 SDK 焦点前提；第四次通过，第五次在实际共享模块及新的连接启动方式上通过。失败记录与各版验证 jar 保留，未改写为通过。
- 当前选择 focused window 是明确合同；没有把 active window 或缓存中的第一个窗口当作替代。依据也核对了 [UiAutomation 窗口查询实现](https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/refs/heads/android16-release/core/java/android/app/UiAutomation.java)。属性复验与后续系统派发仍不是跨进程的事务，不能宣称任意 App 的内容属性和系统窗口切换都具备同 UI 线程的原子前置条件。

## 第二检查点：持久运行时

新增 `Wire`、`DurableFiles`、`UiaActionEngine`、`UiaNodes`、`UiaHttp`、`UiaRuntime`，协议和构建方式见 [模块说明](../android/ai-app-bridge-uia/README.md)。运行时持有同一 UiAutomation 连接，通过认证的 local abstract socket 接收请求。动作先保存原请求，再单次准入；原回调产生的终态经过文件和目录 fsync 后才对外返回。Host 连接断开不结束动作。取消先到时保存墓碑，使迟到的 prepare/start 仍然不执行。

`UiaNodes` 保存快照引用、焦点窗口、节点身份和属性，执行前验证当前唯一匹配及可点击祖先，最后提交真实 window/source ID。绑定强度在回执中明确标为 `same_connection_node_and_reobserved_attributes`，没有宣称跨进程属性事务。

| 检查 | 本轮新结果 |
| --- | --- |
| Gradle 与构建来源 | `:ai-app-bridge-uia:buildRuntimeBundle` 通过；DEX、Java 来源、构建配置、Android API jar、D8 jar 由 manifest 绑定 |
| 执行内核 | 19/19 JVM 测试通过；覆盖原回调 true/false、未知 Binder 结果、重复提交、身份冲突、取消和超时、落盘失败、容量与确认 |
| 真实节点与独立结果 | `runtime-validation-02/report.json` 为 ok=true；5 个原动作有匹配终态；成功动作使 SDK 独立计数从 10 变为 12，其余操作不增加计数 |
| Host 中断 | 独立子进程收到 start 的 queued 响应后被 SIGKILL；另一进程查回原终态，并与手机文件中的原 receiptJson/hash 精确匹配。未独立证明信号发生时动作已经准入，不能替代准入后中断的公共入口验收 |
| 取消与迟到请求 | 先 cancel，再 prepare/start，始终返回原取消回执；计数保持不变 |
| 焦点变化 | 独立 SDK 先确认弹窗 focused，旧引用返回 `uia_foreground_changed`、dispatched=false；关窗后计数保持 12 |
| 认证和关闭 | 错误 token 返回 401；准备中的动作阻止 stop；全部终态确认后正常退出，最终进程表无该运行时 |
| 原记录重开 | 同一根目录正常重启到新 epoch，拒绝旧请求和旧节点引用；原 epoch 的回执文件仍可精确读取且字节未变；新会话正常退出，独立 SDK 最终计数仍为 12 |

本轮 DEX SHA-256：`cd9785d40e60580a045d2e8cdb4928ca7c243b0b354bcb78e2fb550f771f80f0`。编译 API 35、D8 min API 33；实际设备仍为同一 OPPO API 36，样例安装物 SHA-256 仍为 `9cdff0b4f5990b56bd34ed6d455505335557e78af65978df1eb1e8a2887faa45`。样例及 Android/Flutter SDK 业务来源未改。

`stageRuntimeBundle` 也已执行，将来源绑定的 jar/manifest 放入 CLI 的 `runtime/uia` 目录；npm 文件白名单和公共消费者尚未接入。重开证据在 `runtime-reopen-02/report.json`。最后的截图、SDK 树、状态、共享占用和进程核验为 `device-runtime-final*`：计数 12，无弹窗，输入与 H5 初始内容保持不变，共享占用 idle，无残留 UIA 运行时；截图已人工查看。

保留一次真实失败：`runtime-validation-01` 的动作、回执与业务计数检查通过，最终 stop 未退出，因此整轮标为 false。该机上跨线程关闭监听 socket 没有唤醒已阻塞的 accept；一次只读 status 连接唤醒后，原进程在 pending=0、5 个回执已确认的状态下正常退出。随后修复为显式唤醒唯一 acceptor，由 acceptor 完成监听关闭。第二轮完整重跑通过，未将第一轮改写为通过。

这些结果仍是独立手机运行时验证。共享设备所有权、FactStore、普通 MCP/Intent/JS/Python 和发布包尚未接入，因此不能计为公共 UIA 命令已通过。3N 的 968 项 Host 检查不是本轮新执行结果。

## 第三检查点：公共入口、所有权与证据

新增 Host 端口负责 bundle/hash 核验、认证、同设备连接锁、ADB forward 身份核验、原请求执行和原回执恢复。普通文字命令、自动选择后的 UIA 分支、Intent 与两种 Script 语言都发送 snapshot/ref，不再从文字匹配计算坐标。显式物理点击仍保留。权限流程的请求、权限状态和取消复核包在新的 `uiaTap` 入口外，原条件没有因换入口而丢失；受控公开权限测试验证三次节点选择及一次 Back。

UIA 原动作 ID 接受原始非空 Unicode 字符串（最多 1024 UTF-16 单元），包括 Intent/Script 的复合 ID；没有映射为另一套 UUID。手机记录升级为 `aab.uia.record.v2`，文件名为原 ID 的 SHA-256，记录与回执仍保留原 ID。新 bundle DEX 为 `6fa7b182f48e4f923fb271940e10e2ed160e47534ed58b2ec0f5a12dc6d316fa`，执行内核 20/20 JVM 检查通过。

`device-ownership` 在提交前保存精确请求；原回执必须匹配 boot/epoch/action/request hash、节点/选择器/窗口绑定。Host 先持久保存结束证明，再确认手机副本。已提交结果未知、损坏或错配凭据继续阻断写入；恢复不会换 runtime 或重放原动作。容量满时在新占用标记前拒绝，避免明知不能准备却留下不可恢复的 pending。

| 检查 | 第三检查点结果 |
| --- | --- |
| Host 全量 | `host-full-18.log`：996/996，0 失败/取消/跳过，25,229.916583 ms；涵盖凭据篡改、响应丢失、Host SIGKILL、容量、真实 HTTP 取消、原文件恢复和两个 Host 进程竞争同一连接 |
| 干净包 | `package-17/report.json`：ok=true，96 个入口，原生存储模块实际编译，UIA jar/manifest 已包含；公开权限、Script/Intent shutdown 与能力合同通过；95 个 bin/runtime 文件与真机使用的 package-12 逐字节一致，仅更新公开文档 |
| 普通 CLI | `public-probe-03`：原始中文复合 ID，节点回调和共享持久证明一致；独立 SDK 计数 12 → 13；运行时正常关闭 |
| 公共 MCP/Intent/JS/Python | `device-public-15/report.json`：ok=true；同一 OPPO 上逐次独立 SDK 计数 21 → 27，无重复派发；JS/Python 各自设备断言 passed |
| 错误预期 | 同源 JavaScript 的错误期望产生 failed 断言，执行状态 completed；没有把执行结束写为测试通过 |
| 真实 Host SIGKILL | 包内 CLI 收到手机 start HTTP 响应头、尚未解析时被 SIGKILL；共享原动作保持 unresolved，另一公共写入口被阻断；reconcile 取得同一 action/request 的原回执后释放，独立计数只增加一次 |
| 持久和离线 | 关闭 MCP 后，新进程读回 Intent 与三个 Script 终态；四份归档搬移后在不可用 FactStore/ADB 环境核验通过，原 UIA 回执字节/hash 均一致 |
| 最终状态 | 6 个原动作均 terminal/acknowledged，pending=0；运行时正常停止；截图为计数 27、无弹窗，Native/H5 输入仍为初始内容 |

真实 SIGKILL 边界是“收到 start 响应头，Host 尚未解析”，没有独立证明该瞬间 Android 动作仍处于准入后等待回调，因此不替代此项故障验收。UIA 外部动作仍不自动具有样例 SDK 事件 actionId 关联；本次独立结果来自 SDK 树。

本检查点发现并修复真实归档缺口：FactStore 对嵌套 JSON 字符串的无条件重新序列化会改变 Android 转义字符，破坏原回执哈希。现在无脱敏变化且无重复键时保留原字节；有密码/token、重复或转义键时仍执行脱敏。新增 native FactStore 关闭重开、原字节及凭据隐藏用例。`device-public-10` 保留为失败；`device-public-14` 的动作/恢复已通过，但验证器误用了 Intent 的字段来检查 Script 重启返回，也保留为失败；修正验证器后 `device-public-15` 完整通过。

最终包 SHA-256：`a3ddc9c990dfb52053f161c5adf4db98e7d74773b9e13406c0fc8bf54f3f22e8`；真机包为 `9cb17077b605f95bafb25a4f05d2d47e76be74505d5d6957fbaec8ff5eea887f`，代码等价核对见 `package-code-equivalence.json`。`host-full-16.log` 在同时进行 npm 原生模块编译时出现三项性能阈值失败（JS 握手 152.21525 ms、另一组最大采样 162 ms、5k 摘要 p95 42.646916 ms），保留为失败，不下调阈值。停止并行打包后同一完整测试命令在 `host-full-18.log` 全部通过；这不是持续竞争负载下的性能验收。

## 第四检查点：会话轮换、退役与进程锁

新增 `UiaJournal`，把历史记录校验和退役从运行时连接类中分离出来；在线执行与重开校验共用严格原请求解析。新进程先取得根目录的 OS 文件锁，逐个校验原请求、终态、回执哈希和节点绑定。所有原会话审计通过后，才将全部 terminal/acknowledged 的会话原子移动到 `retired/`，同步源/目的父目录，再删除内容；半途清理从此命名空间继续。未确认终态保留原字节；原始非终态、损坏数据和异常路径阻止重开，不以临时文件代替结束凭据。

Host 只在**新观察**时自动轮换写满且全部已确认的会话。已绑定的动作不触发轮换；旧 epoch/ref 失效，必须重新观察。共享连接锁串行化轮换与 forward 配置。显式 `uia-runtime --operation start` 先运行只探测文件锁的 `owner-status`，新运行时再次持锁审计后才能创建 UiAutomation；即使 descriptor 仍写 running=true，原进程已退出且历史全终态时也可重开。HTTP 失败不启动替代进程，公开为 `uia_runtime_unreachable`；原进程仍持锁或历史结果未知时保持拒绝。

内容寻址 DEX 先上传独立临时文件，核对哈希，再用同目录 `mv -n` 发布并再次核验；不覆盖已加载的 jar。原始记录审计通过后移除旧 jar 和协议临时文件；每个运行时最多输出 16 行断连诊断，限制 startup.log 增长。

| 检查 | 第四检查点结果 |
| --- | --- |
| JVM / DEX | `runtime-build-04.log`：30/30，含 10 项真实文件系统用例；64 份已确认会话可退役，未确认字节保留，所有非终态及损坏凭据阻断，临时终态不能覆盖 unknown，部分退役删除可继续；DEX `29d4e6eb863ca71c9a20e8c47559692d79be76270072fb8031d0c9b0216e3df5` |
| Host | `host-full-22.log`：1006/1006，0 失败/取消/跳过，25,203.002375 ms；新观察轮换、旧引用拒绝、未确认/未知不轮换、锁竞争、原进程死亡后受约束重开、已有 jar 不覆盖均有检查 |
| 首轮连续执行 | `device-lifecycle-02/report.json`：257 次，297,462 ms；两个 epoch 分别 256/1 次，7 个独立 SDK 计数检查 passed；Script 计数 27 → 284，重开后新动作 → 285 |
| 手机退役和 Host 留存 | 首轮手机仅剩一个会话、一条动作、一个 jar；257 份原始回执仍能从 Host 导出，原 receiptJson/hash 全部一致，788 条归档记录搬移后在无有效 FactStore/ADB 的环境核验通过 |
| 强制退出 | 首轮在 pending=0、唯一终态已确认后 SIGKILL 原 UIA 进程；普通读取失败且未暗中重启，显式 start 检查文件锁后以新 epoch 重开；计数不增加，包内执行器拒绝旧引用，随后一次新动作只增加一次 |
| 最终包连续执行 | `device-lifecycle-03/report.json`：ok=true；257 次，289,640 ms（4 分 49.640 秒），两个 epoch 分别 256/1；7 个独立计数检查 passed，Script 285 → 542，重开后新动作 → 543；不可达错误明确为 `uia_runtime_unreachable` |
| 最终包凭据 | 同一 `package-20` 的 257 份原始回执全部取回，788 条归档记录搬移后离线核验通过；manifest `cded472d6b69f7fb5812d12f3de99c2738e2b59f3a00743608a9dcfba5f69aaf`；长循环后手机一个会话、一条原动作、一个 jar，目录占用 58 KiB |
| 公共入口复验 | `device-public-16/report.json`：ok=true；同一包再跑 MCP、Intent、JS、Python、错误预期和 Host SIGKILL 原回执恢复；独立计数 543 → 549；JS/Python 断言 passed，错误预期为 failed；四份归档重开/离线核验通过 |
| 最终包来源 | `package-20/report.json`：ok=true、96 个入口，原生存储模块实际编译；tarball SHA-256 `0e61d9c5329b7af3c6eafe802208ac589db65becca9176866804192d7ad730cf`；95 个已发布 bin/runtime 文件与当前源码逐字节一致，见 `package20-source-equivalence.json` |
| 最后可达设备状态 | `device-public-16` / `checkpoint4-last-confirmed-device.json`：UIA 已正常停止，最后 6 条动作均 terminal/acknowledged，pending=0；截图计数 549，Native/H5 输入仍为初始内容；Host 最后占用核验为 idle |

这是容量边界和进程生命周期验证，覆盖范围是重复节点动作与独立计数，不是“整个复杂 App 五分钟测试完”的证明。已结算后杀进程也不替代“准入后回调仍未知时进程死亡”的验收；本轮未重启整部手机。Host 当前仍会读取 descriptor 并核对 forward，耗时包含这些开销，后续性能优化不得省略目标与原动作证明。

公共复验和正常停止完成后，设备更换为另一台已授权手机 `b46093e6 / PKR110 / API 36`，系统品牌字段为 `OnePlus`；收尾再次读取原 `FYZLAU49X8OVQGJ7` 时 ADB 返回 device not found，见 `checkpoint4-collection-state.json`。上述计数、退役、退出与归档证据全部属于原测试机，最后可达状态与当前连接状态分别保存；新机的 App 安装物和初态尚未核对，后续验证器也须使用这台设备的实际身份而非假定 OPPO 品牌字符串。

保留失败：`device-lifecycle-01` 在首次发布 DEX 时被 OPPO 拒绝硬链接，未启动动作，计数保持 27；随后统一改为不覆盖的同目录移动，未增加按 ROM 兜底分支。`device-lifecycle-02` 的功能检查通过，但死进程读取只返回通用 socket hang up；后续补充明确机器错误并加强最终包验收。`host-full-21.log` 为 1005/1006：握手采样 `84,86,88,88,94,100,104,151` 的最后一项超过 150 ms，未并行打包也发生了一次边缘失败。下一完整运行 22 通过；该波动保留为性能风险，不能据单次通过宣称持续负载已经达标。

## 第五检查点：停机确认、Host 崩溃与持久回执查询

设备已切换并重新建立基线：`b46093e6 / OnePlus PKR110 / API 36`，boot ID `b05e5829-09fb-48f3-9987-876f57facd0f`。通过干净包的公开 `install-apk` Intent 更新测试 APK，原安装物 `d31f514c…` 换为冻结的 `9cdff0b4f5990b56bd34ed6d455505335557e78af65978df1eb1e8a2887faa45`，PackageInstaller 原 session/结束回执和独立手机 APK 哈希均已核对。随后公开启动原有测试 Activity，SDK 计数从 0 开始；未修改样例业务源码。

本次补齐两个会丢失清理机会的窗口：Host 已保存结束证明但尚未确认手机，以及手机已确认但 Host 尚未删除待确认事项。所有权日志升级为 `aab.device-ownership/v2`，仍使用原来的物理锁路径；v1 的原 pending/reservation 无损保留，不能为 v1 已遗忘的动作凭空补出确认事项。每次 UIA 结算同时持久保存完整原请求、回执、FactStore 目的地和待确认事项。队列最多 8 条、日志最多 4 MiB；满时在新的 UIA 准备前明确拒绝，已知动作不重放。

确认前先将回执写入共享的 segmented FactStore 并逐字节读回；MCP、Intent、Script 与 CLI 复用同一 Host 存储模块。只有此后才确认手机副本并清除待确认事项。这样下一次操作覆盖 `lastSettlement` 时，历史仍由真实持久查询返回。新增 `device-ownership --operation receipt --serial … --runtime-epoch … --action-id …`，不连接手机、不改变占用。请求/回执都明确返回原哈希、保存哈希和 `original-json` / `redacted-json`；脱敏后 `originalCompletionAvailable=false`，不会冒充原始凭据。历史仍受 FactStore 留存配额约束，查不到只表示未保留。

停止的原会话由持有手机根 OS 锁的一次性维护进程确认，不启动 UiAutomation；已有新运行时则由它处理旧 epoch。活动 epoch 仍只能通过自己的执行引擎确认，避免绕过内存中的执行状态。手机副本已退役时返回 `not_retained`，它只表示清理状态；Host 必须已有匹配的原结算和持久历史，不能用此返回证明未知动作结束。另一个未知动作不会因清理旧凭据而解锁。

| 检查 | 第五检查点结果 |
| --- | --- |
| JVM / DEX | `runtime-build-06.log`：35/35，含 15 项真实文件系统用例；停止后确认保留原文、重试、后续退役、活动 epoch 拒绝、不同未知动作不变、错配/损坏/符号链接拒绝；DEX `5b603e8cbc1b02e7871146b63f98bfcccf1d4929e477b5842d7889887409de9c` |
| Host 全量 | `host-full-24.log`：1017/1017，0 失败/取消/跳过，26,519.7955 ms；针对性集合 57/57，覆盖真实子进程 SIGKILL、8 条队列上限、错配、Host 写盘失败、FactStore 不可用/写者占用、原目录恢复与明确脱敏 |
| 干净包 | `package-21/report.json`：ok=true，96 个入口，原生存储模块实际编译；tarball `5e32390c897a1c54236ca82125401e02b08448b7f1badea7f70364ad9156fd07` |
| 手机确认前 Host SIGKILL | `device-acknowledgements-01/report.json`：独立计数 0 → 1；原动作 terminal、手机 acknowledged=false，Host pending 已结算而确认队列仍有 1 条；停止手机运行时后新 Host 完成原文件确认，运行时仍保持停止，随后正常启动才退役原会话 |
| 手机确认后 Host SIGKILL | 同一报告：独立计数 1 → 2；手机 acknowledged=true，Host 队列仍有 1 条；正常 stop/start 实际删除原会话后，新 Host 收到 `not_retained`，清理队列但不再次点击，新运行时 count 保持 0 |
| 后续覆盖与真实查询 | 再一次公开点击计数 2 → 3、覆盖 lastSettlement；再次关闭并新开 Host，两份旧会话已消失的原回执仍从 FactStore 查询到，原文 SHA-256 分别为 `2e89b1554682a359f74cde66d10f3cfb1723a0af2c950f6d0c9013419e2c9ebe`、`07dbdaa63efe13e93e6339cc8bdad0530c0a1c87d4430fa0df2051e51daa0d66` |
| 公共入口复验 | `device-public-17/report.json`：同一包、同一 PKR110，MCP、Intent、JS、Python、错误预期与 Host start 响应前崩溃恢复全部通过；独立计数 3 → 9，错误预期仍为 failed 断言而执行 completed；四份归档新进程重开及搬移后的离线核验通过 |
| 收尾 | 手机运行时正常停止，最后 6 条原动作均 terminal/acknowledged，pending=0；共享 Host 所有权 idle、待确认事项 0；公共复验最后截图为计数 9、Native 初始文本，无弹窗 |

复验结束后的冻结采集再次核验 APK、手机 6 条终态和 OS 进程列表：运行时进程为 0，所有权空闲。此时 SDK `tree` 返回 `provider_timeout`，另外一次只读截图显示手机已回到桌面，见 `checkpoint5-tree-collection.json` / `checkpoint5-collection.png`。没有把最后成功计数 9 当作此刻的新 SDK 观察，也没有据此推断返回桌面的原因；下一次设备验收须重新确认前台和 SDK 状态。

FactStore 当前是单写者句柄：被另一个 Host 持有时返回 `fact_store_writer_busy`，保留确认事项，使用原持有者执行 reconcile 或关闭它后重试。恢复绑定原 FactStore 目录，不暗中写入替代库。没有将这个边界宣称为多写者支持。

保留开发失败：`host-focused-23.log` 的 4 处为新测试对 CLI 非零退出/库异常以及虚拟 forward 重用的错误假定；`host-focused-25.log` 的 6 处暴露原 FactStore 写者仍存活的场景，现已明确检查占用保留和关闭后重试。`host-full-23.log` 的 5 处来自测试默认目录覆盖显式旧路径，以及 UIA 虚拟 ADB 拦截了其他协议的 push；隔离默认路径并限定虚拟协议范围后 `host-full-24` 全量通过。`device-public-17-arguments.log` 保留一次传错验证器参数的退出，尚未创建验证目录或调用手机；正确参数后的 17 报告为完整实测。既有性能边缘失败继续保留，不改变门槛。

本轮杀的是已完成动作之后的 Host，不是准入后等待未知回调的 Android 运行时；未重启手机。第五检查点补的是通用执行与留存链路，不是样例业务功能，也不扩大为四 App、整机或整个 3O 已通过。

## 第六检查点：准入前退出的明确恢复凭据

手机仍为第五检查点的 PKR110，boot ID 与冻结 APK 哈希均未改变。运行时原有顺序是先 fsync `admitted` 记录，再提交 Binder 动作；因此已退出的原进程留下的 `prepared` / `queued`、interactionId=0、无回执且未确认记录，可以证明该动作尚未提交。新增 `recover-record` 一次性维护操作，在整个读取、验证和写盘期间持有同一手机根 `owner.lock`，不建立 UiAutomation。原进程仍存活、身份/请求/原 DEX 不符、记录缺失、已准入或 unknown 均不能生成这份凭据。

恢复在原记录中保存 `completion: recovered_before_admission`、`dispatched:false` 和 `uia_owner_exited_before_admission`。原请求字节、准备时间及期限保持不变；`recovery` 单独记录恢复 boot/elapsed time、原准备时间、准入前 phase、原文件精确 SHA-256 和两端 DEX 哈希。没有伪造原回调，也没有把另一轮开机时间填成原 `completedAtElapsedMs`。重复恢复只同步已经验证的原终态，保留第一份回执字节。Host 沿同一结算、FactStore 和待确认队列完成持久留存。

| 检查 | 第六检查点结果 |
| --- | --- |
| JVM / DEX | `runtime-build-07.log`：42/42，含 22 项真实文件系统测试；prepared/queued 恢复、原字节与首次凭据保留、不同 boot 的时钟、admitted/unknown 不变、缺失/错配/损坏/符号链接拒绝均通过；DEX `a14c69259dd57f08ddcc9f3700748c1a01930ff7a48b94535f31996c5a67b154` |
| Host | 专项 `host-focused-27.log` 49/49；全量 `host-full-25.log` 1032/1032，0 失败/取消/跳过，26,357.019542 ms；包含真实 Host 子进程退出、活动手机所有者阻断、公共恢复及关闭后原生 FactStore 查询 |
| 干净包 | `package-22/report.json`：ok=true、96 个入口，原生存储实际重新编译；tarball `b46593c8c5b10492545c74212c84fbbea70d3aa17c1f462dd5fd0dc1773a4168`；98 个已发布 bin/runtime 文件与源码逐字节一致 |
| 原进程存活 | `device-pre-admission-03/report.json`：公开 CLI 在发送 start 前暂停；读取手机原文件确认 phase=prepared、interactionId=0。直接维护被真正的手机 OS 锁拒绝，返回 `uia_runtime_already_running`，原文件哈希不变 |
| 双进程退出 | 对核验过的原手机运行进程及 Host 分别发送 SIGKILL；原 prepared 文件仍在、字节不变，公共新写入被 `device_ownership_unresolved` 拦住；随后公共 reconcile 得到明确未提交的持久凭据，pending 与确认队列均清空 |
| 独立结果和无重放 | SDK 树与已查看的截图均显示恢复前后计数 **9 → 9**；恢复后手机根 OS 锁仍无人持有、descriptor 仍为原 epoch。显式启动新会话并新发一次点击后才变为 **10** |
| 持久查询 | 已确认原会话被后续启动实际退役，后续动作覆盖 lastSettlement；关闭并新开 Host 仍查询到原请求和恢复回执，FactStore globalSeq=14，回执 SHA-256 `ed660c33e5133863de697fbcee3e7f6b85e5025f413aa5b78dda6d84ec2429f5` |
| 公共入口复验 | `device-public-18/report.json`：同一 package-22，MCP、Intent、JS、Python、错误预期和 Host start 响应丢失恢复全部通过；计数 **10 → 16**，错误预期保持 failed 断言；4 份归档关闭重开、搬移后在无有效 FactStore/ADB 的环境核验通过 |
| 最终新观察 | `checkpoint6-final-tree.json` 与已查看的 `checkpoint6-final.png`：计数 16、Native 初始文本，无弹窗；6 条手机原记录均 terminal/acknowledged、实际 UIA 进程 0；新 Host 所有权 idle、pending=null、待确认事项 0 |

原动作 ID `uia-pre-admission:1788965875866`，原 epoch `777ae6fa-a920-4fd7-bb83-0292b5e682c8`，准入前原文件 SHA-256 `a8a2dcc8c872ed8668421c175fc9650db01922b1a5ad209bc18184c0b929dea9`。真机只验证了 **prepared 阶段进程死亡、同一次开机**。queued 阶段死亡和跨开机时钟当前只有 JVM 合同验证；没有重启手机，也没有把已提交且失去回调的动作写成已结束。

保留本轮实际失败：`device-pre-admission-01` 与 `02` 在公开 MCP 启动测试页时返回 `deadline_exceeded` / `Android shell transport failed`、dispatched=false，尚未进入 UIA 故障注入。默认反馈和 feedback=off 均发生，不能归因于反馈开关。手机留下两份只有 identity/command/worker 的准备目录，无 launched/admission/回执；没有擅自删除。随后同一包的公开 CLI 启动成功，详细 I/O 跟踪在 `launch-transport-trace-01`；测试页可用后第三轮 MCP 启动与完整恢复验证通过。CLI 成功和第三轮通过不代表先前 MCP 启动故障已修复，根因继续列为生产化关口。

## 第七检查点：启动顺序与 Android 显式采证

在同一 PKR110、相同 boot 和 APK 上复现：公开 Home 后等待 30 秒，新 MCP 的 `launch-activity` 在 shell 准备阶段超时。`launch-diagnosis/home-03` 保留无插桩失败；`home-04` 的 I/O 跟踪记录自动 `status` 的 SDK 连接与准备并发，准备进程输出 0 字节，独立 ADB 读取也被阻塞。关闭 MCP 后 ADB 恢复。`home-05` 只关闭自动轮询，保留原 MCP、持久库及公开启动入口，889 ms 成功。这是自动连接干扰启动的实证，没有据此声称已定位 Android/ADB 更底层的具体缺陷。

Android 观察目标现在只维护有界注册、动作时间线和明确开启的设备 logcat。它不再自动连接 SDK 或轮询 `status`；到期清理由独立本地计时器执行，重复注册及动作更新续期，最后一个目标过期时排空并停止日志流。显式实时查询、Intent/Script 采证与持久历史仍走原共享能力。`_feedback.observer.target.backgroundPolling=false` 明确表达这一点，未知 runtimeEpoch 和未执行的健康检查保留 null。Web 后台流及现有 iOS 行为未在此轮改动。

第一版 `package-23` 的无反馈后台启动已通过，但 `device-android-launch-01` 第二轮 full 反馈再次失败：反馈探针仍在启动前读取 App 事件，最终 25,153 ms 返回 `deadline_exceeded`、dispatched=false。该失败促使补上启动专用反馈顺序。`launch-app` / `launch-activity` 现在先完成原启动，再读取系统 UIA 树与可选截图，不假定 App SDK 已运行。启动失败保留原结果且不追加读取；采证失败不重放启动或改查 SDK。启动后的快照没有事件基线，语义变化保持 inconclusive，不能自动标记 verified。

| 检查 | 第七检查点结果 |
| --- | --- |
| 回归与全量 | 两个新回归先在旧实现失败；`host-focused-29.log` 54/54，`host-full-27.log` **1038/1038**，0 失败/取消/跳过，27,338.176334 ms；覆盖显式采证、TTL 续期/日志排空、Web/iOS 原行为、启动前无 SDK、失败启动无额外查询及采证失败保留原结果 |
| 干净包 | `package-24/report.json`：ok=true、96 个入口，原生存储实际重新编译；tarball `215058d80b9338304f7a1c2f5d5699408bb78673bd2030a5020728d2889c5e58`；98 个 bin/runtime 文件与源码逐字节一致 |
| 三次后台启动 | `device-android-launch-02/report.json`：每次公开 Home、等待 30 秒、新 MCP；feedback off/full/off 分别 **810.009 / 1863.393 / 744.424 ms**，无插桩、无轮询覆盖、无超时增加。三次均有原 shell 回执、独立前台核对、SDK 树计数 16、截图和显式 status/四流读取 |
| full 反馈 | `full-feedback-verification.json`：原启动成功，系统 UIA 树与截图真实返回；语义变化保持 inconclusive。原截图另存 `full-feedback.png` 并核对 SHA-256 |
| 公共主链路 | `device-public-19/report.json`：同一 package-24 完成 MCP、Intent、JS、Python、错误预期和 Host start 响应解析前 SIGKILL/原回执恢复；SDK 计数 **16 → 22**。JS/Python passed，错误预期为 failed 断言、执行 completed；4 份归档重开及搬移离线核验通过 |
| 收尾新观察 | `checkpoint7-final-tree.json` 与已查看的 `checkpoint7-final.png`：计数 22，Native 初始内容，无弹窗；6 条原动作 terminal/acknowledged，实际 UIA 进程 0；新 Host 所有权 idle、pending=null、待确认事项 0 |
| 手机源码和残留 | 本轮未改 Android SDK/UIA 或样例源码，沿用第六检查点已验证 DEX `a14c69259dd57f08ddcc9f3700748c1a01930ff7a48b94535f31996c5a67b154`，未重跑 JVM。现存 4 份仅含 identity/command/worker 的 shell 准备目录已逐字节保存，原先 2 份哈希未变；未删除，见 `checkpoint7-shell-staging-records/summary.json` |

本轮通过的范围是清除隐式 SDK 读取对启动的依赖，并验证原有公共执行/证据链不回退。**显式向后台 App 发起 SDK 读取，超时后在同一 Host 继续操作的传输回收仍须单独验证和修复。** 还没有关闭 ADB/SDK 传输这个更大问题，后续也要审视冻结、清数据等生命周期命令的通用反馈策略。此前启动失败、诊断失败、第一版 full 反馈失败和性能边缘失败全部保留，不扩大为整个 3O、整机或全平台验收。

## 接下来必须完成

1. **生命周期和留存。** 优先验证后台 SDK 显式读取超时后的同 Host 传输回收，再安全退役 4 份有准确身份的 shell 准备记录；继续审视其他生命周期命令的反馈前提。prepared 阶段双进程退出恢复已有真机实证；继续真实 queued 阶段死亡、设备重启和真正未知回调。新会话的重开审计仍要求原动作已有明确终态；只能由原运行时或独立准入前凭据先完成恢复，admitted/unknown 保持阻断。不能用提高超时、换入口或删除原记录代替修复。
2. **更广真实节点验收。** 普通入口共用端口已验证；继续可点击祖先、替换/移动/重复/禁用、虚拟节点、系统安装/权限页面和真实执行中取消/超时。受控权限结果不能代替本版本的系统弹窗实测。
3. **运行时交接。** 已实现同设备连接锁、显式关闭和 OS 锁重开检查；需要完成真正未知动作的进程/设备退出边界、其他 instrumentation 对同一自动化资源的交接与 API/ROM 范围。
4. **长期存查和采证。** 新 UIA 持久回执查询已明确原文/脱敏表示；现有 Script/Intent 归档里的嵌套执行回执合同仍需统一。继续更大覆盖范围和持续负载的查询/证据边界；旧真机预算/Intent 生命周期验证器中依赖一次性 uiautomator 子进程的观测点，也需要迁移到新的运行时协议边界。握手尾延迟的边缘失败另行定量验证，不修改已有门槛。

当前运行时使用 API 33+ 的窗口缓存接口，仅在 API 36 的 OPPO PGFM10 和 OnePlus PKR110 上完成各自已注明的场景，不能互相代替未执行的场景。旧 Android、其他 ROM、多显示屏和跨平台能力边界须在发布合同中明确并实际验收。iOS 设备暂不需要；进入 iOS 真机验证前通知用户接入。整套生产化目标保持进行中。


## 第八检查点：Android SDK 本地 socket 与超时回收（2026-09-10）

本轮先复现显式后台状态读取超时后，同一个 MCP 的启动命令及独立 ADB 都阻塞。Host 跟踪确认 HTTP socket 已关闭，后续命令使用新的执行预算；仅连接 TCP、不发送 HTTP 也能复现。随后在同一个 App UID 下做两种监听的对照：后台 localabstract 响应 2.766 ms，后续 ADB 正常；TCP 对照超时并拖住后续 ADB。证据位于 `sdk-timeout-diagnosis/`，包括原失败、连接跟踪和同 UID 帮助进程的自然退出及资源清理。没有重启 ADB 服务或手机，也未将该结果归因为已确认的厂商内核实现。

Android SDK 现在只监听本次 runtimeEpoch 对应的 LocalServerSocket，以 AtomicFile 发布 `files/ai_app_bridge_endpoint.json`。Host 每次按 serial/packageName 读取真实端点，验证 schema、包名、代际与 socket 名，再建立或复用对应转发并核对归属。旧 TCP 监听、51 个端口扫描、默认样例包/端口和旧端口文件回退均已移除，读请求不再隐藏重试。Android App 命令的公开 schema 要求 packageName；port 只指定电脑端口，不能绕过发现。remove-forward 要求 serial/port，拒绝删除属于另一设备的转发。iOS 传输未改。

| 验证 | 本轮证据 |
| --- | --- |
| Host | `host-full-30.log`：1043/1043，0 失败/取消/跳过，27,676.961458 ms；实际端点错配、非法状态、显式端口不可绕过、单次请求及跨设备删除保护均有检查 |
| SDK | `sdk-transport-build-01.log`：165/165 Android 单测；PKR110 上 46/46 SDK 故障集成通过，84.173 秒；46 份 trace 均晚于本次测试日志创建时间，原文及哈希已保存 |
| 安装与来源 | 公开 install-apk Intent 完成，原 PackageInstaller session 与手机 APK 哈希独立匹配；sample APK 为 `53cdc4442f3a92a8e05aa2c63f2945781a50a11dfe6f1fed06b4b688745d43eb`，SDK 测试 APK 为 `433f09b0be27c35c661f6aae4b059e92a7df1ce028a25c5afa2069f5bbd80266`；sample 4 个业务源码文件未变 |
| 原始故障 | `sdk-timeout-diagnosis/read-03/report.json`：后台 status 超时 10,162.871 ms，随后同 MCP 启动成功 793.081 ms；独立 ADB 在 Host 关闭前后均确认 App 前台 |
| 完整启动链 | `device-android-launch-03/report.json`：三轮 Home 30 秒、off/full/off 反馈，启动分别为 779.314 / 1876.699 / 795.007 ms；首轮显式后台 status 超时后继续成功。每轮实际读取 SDK 状态、树、四类 capture、截图，并核对私有端点与响应代际；full 反馈仍将无基线的 UI 结论记为 inconclusive |
| 公共入口 | `device-public-20/report.json`：MCP、Intent、JS、Python、错误预期和 Host start 响应解析前 SIGKILL 恢复通过，独立计数 0 → 6；错误预期为 failed 断言而执行 completed；4 份操作归档重新打开并搬移后离线核验通过，另有 1 份安装归档在不可用 FactStore/ADB 环境下通过 |
| 干净包与收尾 | `package-25/report.json`：原生存储模块实际编译，96 个入口；tarball `ea8735d0527f41ab4fa8c6ce43c928072ade1ff12b941625f57fe7a36f4440c9`，99 个 bin/runtime 文件逐字节匹配。最终新 SDK 树为计数 6，UIA 已停止、6 条原记录 terminal/acknowledged，Host idle、待确认 0 |

后台 SDK 读取仍可能返回 provider_timeout；本轮证明的是超时后的隔离与后续设备操作可继续，并未宣称后台采证始终成功。SDK instrumentation 的 Flutter 场景验证执行层及回调合同，不替代真实 Dart App 的新版端点验收。NotallyX/LocalSend 的旧安装物须重新集成此 SDK 后再运行既定套件；目前没有把它们的历史成功计入新版端点结果。

原 4 份 shell 准备记录的 identity/command/worker 均重新读取、哈希未变，本轮未删除；证据在 `checkpoint8-shell-staging-records/summary.json`。接下来按原任务协议安全退役，再更新复杂 App SDK 并继续原计划中的 queued/重启/未知回调、系统节点、平台 target/iOS 持久查询与持续运行关口。进入 iOS 真机验证前通知用户。整体目标继续进行中，尚未生产验收；Flutter lock 未变，本轮未提交或推送。

保留开发失败：`transport-regression-red.log` 记录旧 Host 仍产生 tcp 转发的预期红测；`host-focused-30` 的一个失败是旧测试 ADB 未提供新要求的 serial 发现，`host-full-28` 的两个失败是仍断言旧 port-only 报错。最终全量 30 通过。`transport-pre-instrumentation-uia-stop.json` 是不接受 feedback 参数的明确预分派拒绝，移除该参数后正常确认运行时已停止，没有将错误参数请求计作设备执行。

## 第九检查点：复杂样例固定流程收口与推进方式纠偏

原 4 份 shell 准备记录已通过原协议取消、持久保存及冷重开读回、确认和正常准备清理后退役。NotallyX / LocalSend 已重建并通过公开安装 Intent 更新 SDK，未修改样例业务功能。LocalSend Script v1.0.10 根据新 Intent 证据适配 scrollable 节点、明确的系统 picker UIA 路由和语言选中条件。只读 uia_tree_changed 在原观察预算内显式重读，保留失败记录；不重试已发出的动作。

证据根目录为 build/ai_app_bridge_artifacts/command-production-phase3o-2026-09-09/，冻结清单见 checkpoint-09/summary.json。

| 已完成事项 | 原始证据与范围 |
| --- | --- |
| 原 shell 记录退役 | shell-retirement-01/report.json：4 份原 prepared 请求原协议取消，dispatched=false；持久核验后确认并退役。这是验证历史，不是新增公共 shell 历史管理能力 |
| NotallyX 原 Script 复用 | notallyx-transport-reuse-01/report.json：三轮正例 37.330 / 34.722 / 34.433 秒，各 84 passed、0 failed/inconclusive；错误预期正确失败、取消后无后续动作；5 次独立 SQLite/prefs 不变，5 份归档离线通过 |
| LocalSend 当前契约复用 | localsend-transport-matrix-07/report.json：core 62.500 秒；三轮正例 111.943 / 105.724 / 103.666 秒，UI/独立设置通过；错误预期与取消通过，6 份归档离线通过；每轮正例仍有 7 项手机语义证据 inconclusive |
| 当前源与公开包 | package-26/report.json、package26-source-equivalence.json：干净安装通过、96 个入口，99 个 bin/runtime 文件与检查点 8/包 25 相同；本轮未重复此前 Host / SDK 全量检查 |
| 最终状态 | checkpoint9-final-02/report.json：b46093e6 / PKR110 / API 36，同一 boot；NotallyX 11 notes / 11 labels 全字段不变，LocalSend 设置恢复；10 条手机终态均确认，Host idle，无 pending；UIA 已停止，后续独立 OS 查询无进程 |

NotallyX APK SHA-256 为 33c395641f60eb04b358f0183050c99b76dfcb2c78020a4290e1330b9d7c2c34，LocalSend 为 45d7c170949bd0372801dafbc49e38dc041752d7c55e9b65214e153e090a99e0；包 26 为 84fb724ff02cbb9c11f1dfbd9736380bb7a49b36b9c60c0c3d4f8fcd580cfb1a。Flutter 与上游依赖锁文件保持不变。

progress-loop-audit.json 保留了 7 次 LocalSend 整组调用：源码和失败原因确有变化，但局部适配后反复启动整组造成过度回归。最终 matrix-07 已通过，关闭这一阶段。后续采用“定向复现 → 公共层修复 → 定向验证”，一批相关实现稳定后仅做一次相应集成回归。

下一批公共实现有两个独立复现：flutter-back-open-reproduction.json 的语义 Back 收到机械回执但页面未离开，DOWN→UP 为 753 ms，全树重验处于按住期间，根因仍需定向实验；cli-argument-audit-02/report.json 证明多余位置参数被忽略、重复单值参数被后值覆盖。修复后推进平台 target / iOS 持久查询，真机前通知用户。设备重启未知回调、系统节点、残留安装目录/SDK forwards、H5 多页面与长期负载仍是发布前关口，不继续扩张样例测试。

固定流程秒数不能代表完整 App 或整机测试时长。LocalSend 受控 peer/网络、真实传输、执行中动作取消与缺失手机语义证据仍未验收。checkpoint9-final/report.json 的即时 OS 退出断言失败保留：UIA stop 的 descriptor 已停止不等于进程瞬间消失，最终报告记录后续实际退出观察，没有声称修复 stop 实现。

## 第十检查点：公共参数解析与短点击修复，转入 iOS 持久查询

本轮遵循用户要求，停止整组样例反复回归，直接修公共层已复现的两个问题。CLI 原始 token 解析现在拒绝多余位置参数、重复单值参数和非规范旗标；只有 category / extra 可重复。解析错误也统一返回 JSON、dispatched=false、ambiguous=false 和退出码 1，不在错误处理时重新解析同一坏输入。

Flutter 在 DOWN 前仍依据完整操作树确定唯一目标；DOWN 后只检查原 Element、语义/动作绑定、祖先路径及实际触点是否仍可达。移位、遮盖、移除或变更均发 CANCEL。整个短触摸期间自动全量快照延期，终止后恢复；H5 采集异步返回后也重新检查触摸状态。原来按住期间的全树扫描与自动快照已在 Widget 实验中分别复现并消除，没有移除取消、期限或目标核验。

| 结果 | 证据与边界 |
| --- | --- |
| CLI | cli-integration-01.log：80/80，0 失败/跳过；包含公共进程 JSON/退出码和原 CLI 合同。干净包另实测 3 种错误输入，均在设备访问前拒绝 |
| Flutter | flutter-tap-red-03.log 先复现按住期间无关树遍历、自动快照和移位仍 UP；flutter-tap-green-01.log 定向 38/38，flutter-tap-integration-01.log 本模块全量 50/50。未重复 Android SDK/Host 全套 |
| 公开包 | package-27/report.json：96 个入口，原生存储模块实际干净编译；SHA-256 为 96df7cfa3183757a75cf1a9b75d7fa170b7857f351052e241318633d11f2db5f。99 个 bin/runtime 文件逐字节匹配当前源码 |
| 新 APK | flutter-tap-build-receipt.json：LocalSend APK SHA-256 为 0c3eecf348a5613ce8490a6d915fbb0889b867d5520481cae2b9209cd72056df；Flutter 依赖锁未变，未改 LocalSend 业务源码 |
| 三次真实 Back | flutter-back-timing-02/012-intent.json 与 flutter-back-timing-03/report.json：52 / 54 / 49 ms；每次具备原 actionId 的 pointer.tap、route pop、committed mobile ref 及后续设置页树。此前失败样本为 753 ms，不能据此推导所有设备的延迟分布 |
| 独立结果与离线 | flutter-tap-final-review/report.json：独立 prefs 与初态相同，最后恢复接收页、Host idle；原安装、首个 Back 所属取消归档、余下两个 Back 的完成归档共 3 份，复制后在无 ADB 且 FactStore 不可用的新 Host 验证通过 |

验证控制器的失败也保留：第一次安装把异步 waiting_for_observation 误当作同步完成，Host 关闭后原任务在准入前取消，匹配原 settled/dispatched=false 凭据及旧 APK 后才发起新安装；一次误选了设置页左侧语言标签，随后依据源码和当前树选择同行右侧真实按钮；首个 Back 已成功但额外 connected-history 读取超时，原 Intent 自带的有界采证已有完整 52 ms 触摸和路由记录，后续仅补余下两次，没有重跑已通过的第一项。该历史查询超时保留为发布前缺口。

back-3.png 保存的是退出转场，两个页面图层同时可见，不能称为稳定设置页截图；路由事实与后续树单独证明返回，restore-receive.png 已人工核对最终接收页。本轮不主张完成全部 App/整机测试，也不主张每种取消或持续负载均已覆盖。

下一阶段已据真实调用路径限定在 platform-next-scope.json：iOS 的 ios-logs/network/state/events 进入 AiAppBridge.liveCapture，再到内存 MobileCaptureStore；LegacyLiveView 对强查询明确返回 persistence_unavailable。已有 SegmentedFactStore / FactStoreReceiptPort 并不表示公开查询已接线。直接整合持久写入与读取、冷重开与错误合同，再将明确的 iOS 身份接入 Intent/Script。开始真机阶段前通知用户接设备。未知回调、资源生命周期、H5 多页面及长时负载继续作为发布前关口，不重新扩张样例矩阵。
