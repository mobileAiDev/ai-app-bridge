# 优化建议逐项审查、实测结果与采纳方案

最后更新：2026-10-14。源码基线：`87af91f44cf0070686c6bd3e3e695ef2423d6702`（0.4.8 发布后）；候选隔离在 `codex/proposal-evaluation`。目标是效率、能力、故障恢复与调用方自由度，正确性为基础。

本轮值得投入的方向是减少已经证实的 Host 重复工作、让恢复事实可直接读取、提供明确且可选择的等待与证据策略，以及补齐现有执行器的能力发现。**不能把低延迟等同于流程正确，也不能把固定测试数据上的通过等同于陌生复杂 App 可用。** 多项初看合理的默认优化，在反例或真实应用中没有净收益，甚至增加了错误与返工。

本文覆盖 [总台账](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/coverage-ledger.json) 的全部 57 项建议和 6 项事实校正。57 项都完成了对应范围的评估：包括实测收益、否定反例、受控机制原型及低收益排序；**不表示 57 项全部实现、全部做过真机实验或已经产品化**。每行标明证据和未覆盖范围。

最新补充：[Meituan 测试 App 的 30 轮矩阵、Intent 与真实 Host 恢复验证](MEITUAN_SCALE_OPTIMIZATION_VALIDATION_2026-10-14.md)。该轮独立核验动态列表和账本，也审计 fixture 缺陷；仍未覆盖完整美团级业务。新增窄持久化收益约 3%，四项 Host 实验约 28–32%；console 默认切换因工作流绘制就绪证据不足暂缓。新发现的 Script URL 哈希恢复缺陷单独修复，不把新增能力与旧性能候选混为同一发布成果。

目前静态性能样本仍使用预先知道的商品、商家、站点与流程，包含 P001／S001／SITE-002 等固定身份。用户指出这一点没有足够代表性，这个判断成立。它们可证明已知路径、恢复边界和分项开销，不能证明动态列表、未知目标、异步重排与大规模真实 App 的整体体验。**用户已将美团／抖音实测和大型测试 App 建设交给其他 agent；它们属于用户的外部分工，不再作为本轮主线审查的未完验收。本文保留证据适用范围，不预填外部任务通过或泛化收益。**

## 第二轮意见复核更新

已完成[补充审查与 25 条裁决](/Users/macbook/.codex/worktrees/proposal-evaluation/ai-app-bridge/docs/OPTIMIZATION_FOLLOWUP_REVIEW_2026-10-14.md)，新增 0／200 ms 后端延迟 × baseline／candidate 的完整流程矩阵。13 次尝试中首轮 baseline H5 返回导航超时，原 action 仍 unknown；按原身份查询并保存归档后，只重启 fixture 包，以新 runId 完成后续 12 次完整流程，36 段交易、180 条账本断言通过。失败没有删除，也没有重放原动作。

同一冻结作者的全样本中位：200 ms 档 **45.195→29.791 秒**，0 ms 档 **35.807→18.239 秒**。共享 Host 上四例出现 App Nap，活跃子集和全部样本均保留，不作为固定倍数承诺。候选 ownership 持久化约 **4.3 秒**，全部 FactStore record 约 **0.27 秒**；据此把 **ownership 提交去重／追加表示实验提前到第 2 阶段**。Memos 当前二阶段等待与 guest 固定时长录屏的负面结论不能外推到机制本身。模拟器 console 截图 **72.68 vs 180.93 ms**，用户已接受四角/相机孔来源差异；采纳能力路径，仍需连续动态产物验证。时钟跨域过滤已复现，先修示例与调用方，校时不作动作门槛。

本次另清理 Flutter caller 重复 guard，并修正文档使用 Host 时间的样例；18 项相关回归通过。下方 1668／50／独立安装包记录是上一轮冻结版本的证据，不冒充本轮新包验收。完整数据、已做与未做项见补充审查。

## 当前候选代码与产品状态

当前隔离工作树保留下表三项代码修改，以及重复 guard 清理和时间域示例修正；其余性能／架构实验都在外部证据目录，公开 0.4.8、全局 CLI 和消费项目依赖均未更新。

后续另有 Script 持久化 URL 字节保持、公开原 spec 续跑和相对路径恢复修复，验收范围与证据见上方最新报告。下表保留前轮候选，不将其历史通过数混入新修复回归。

| 候选 | 解决的问题 | 已有证据与范围 |
|---|---|---|
| H5 同命令反馈复用 | 一次 DOM 观察后又重复读取参考前台信息 | 原时间戳、目标绑定、回执与恢复合同不变。完整 Native/H5 与混合流程、四类故障均通过；H5 局部约 13–17%，整段小于 1%。保留候选，第三方动态 WebView 是后续吸收门槛。 |
| Android Flutter 观察结果分类 | 有可用树却返回 execution.ok=null／CLI exit 1 | 同一真实安装 debug App、实际 CLI→runtime→SDK 对照：旧版 exit 1，候选默认 auto exit 0，显式 operable 选择仍取得 5 个节点。各源失败／隐私信息保留。不是 Flutter 全部能力验收。 |
| workflow-lab 静态资源读取 | 文件缺失时先写 200，再试图写错误头，可能使测试服务退出 | 先读文件再写成功头；6 项服务测试通过，缺失资源后下一请求仍可服务。属于测试服务修复，不计为 Bridge 性能收益。 |

Flutter 实际设备证据：[最终对照](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/flutter-real-fix-5/summary.json)、[全部原回包](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/flutter-real-fix-5/all-replies.json)。显式 extract:null 超过交付预算的一次 exit 2 与一次 CLI 参数拼写错误均保留，不把测试程序错误混成产品失败，也不删除原样本。完整树的各源可用性与树覆盖范围不同，不能用顶层读取成功推导整页完整。

独立复核发现最初候选增加的 `partial:false` 也可能误导：四源均可用时仍可截断文字或节点。因此最终候选删除这个冗余字段，只保留 `availableSources`／`unavailableSources` 和各源原始覆盖；专门反例先失败，再修正通过。

最终候选检查结果在本文尾部的验收记录中更新。没有提交、发布或把实验环境开关变为默认值；“采纳为方案”均须经过各行列出的实现与动态验收门槛。

## 判定与证据口径

- **采纳为方案**：问题或能力方向有证据，值得安排实现；仍需逐项满足合入条件。不是已发布功能。
- **拒绝原做法**：当前默认策略、等价性宣称或具体原型已被反例否决；必要时保留更窄方向。
- **低收益／后置**：现有测量不足以支持复杂实现成本，或已存在能力无需重做。
- **值得继续实验**：有局部收益或必要能力，但合同、负收益或真实覆盖仍未闭合。

本文区别四类证据：①真实 Android／iOS Simulator／浏览器与实际 App 执行；②生产 Host／provider／Script 接口配受控 HTTP、虚拟 ADB 或注入故障；③真实文件系统／SQLite／子进程崩溃的局部原型；④离线语料与纯状态机模型。②③不能写成真实 Android 验收，④不能写成模型理解率或业务吞吐实测。每个判定同时列出正收益、负例和未覆盖范围。

计时比较固定业务范围和作者源码，并明确证据策略；减少反馈或改变截图归属探测的对照单列，不能称同等诊断证据下的透明提速。准备好的 Script 提交后执行、必要的脚本编写与模型响应、协调／独立账本核验、安装启动和证据最终可用时间分别记录。不同版本、不同作者脚本和异步重叠的分项不得相加或直接相减；多设备收益记为吞吐，不冒充单流程延迟下降。

## 六项事实校正

| ID | 原说法 | 采用的校正与证据边界 |
|---|---|---|
| F01 | Flutter 恢复 67.501／21.178 秒仍未达标 | 后续 0.4.8 记录已有进程死亡加完整交易 **30.860／31.114 秒**、恢复就绪约 **2.2–2.4 秒**，混合三段 **54.113／55.406 秒**。保留历史慢样本及主机不活跃观察，不把锁屏作为唯一已证明原因。[验收记录](/Users/macbook/.codex/worktrees/proposal-evaluation/ai-app-bridge/docs/WORKFLOW_ACCEPTANCE_0.4.8_2026-10-13.md) |
| F02 | 首次使用约 8 分钟都是工具执行 | 基线／候选派发至 UI 完成为 **355.653／311.083 秒**，之后协调等待 **157.180／189.845 秒**；MCP 窗口合计 **10.685／1.979 秒**。窗口外含编写、解读和调度，不等于精确的纯模型时间。各一例、程序不同，不能据此承诺模型或产品提速比例。[原始对照](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/0.4.8-work/2026-10-13/web-latency/first-use-comparison.json) |
| F03 | 混合 26–33 秒、NotallyX 26–27 秒代表当前 0.4.8 | 这些是较早的 0.4.6 时期证据，需要标版本与工作负载；不能和当前加入新故障的流程直接比较。本轮不能补写为 0.4.8 已复跑。[第一轮事实审核](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/first-round-review-archived.md) |
| F04 | 首段 15.3 秒／60 命令及表中中位数 | 原 steps 的复算是 **15.292 秒、60 命令**。采用标准偶数样本中位数时，wait-text **278 ms**、screenshot **384 ms**、h5-wait **718 ms**、h5-click **281 ms**；原表部分取上中位数。分项总和也不能和内部传输时间重复相加。[第一轮复算记录](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/first-round-review-archived.md) |
| F05 | 原消息的 SDK、ADB、fsync、keep-alive 微测是已确认基线 | 原消息没有附可复核的完整条件和原始记录。此轮自有 SDK 控制通道、传输、存储微测可分别支持各自结论，不能倒推原消息所有数值成立，也不能混算成完整流程收益。[SDK 实测](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/sdk-control-probe-result.json)、[持久化原型](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/persistence-results.json) |
| F06 | Native 150→30–40 ms、三段 46→20 秒、单段 4–5 秒、首次使用 2–3 分钟 | 这些仍是原提案的估算；不列入承诺。现有有范围的真实 A/B 替代估算，不能将单项改善连乘、多设备吞吐当单设备速度，或用删除统计等待来称产品变快。 |

## 已测出的主要收益，以及必须一起保留的失败

Android Host 单因素实验以冻结的前一轮 H5 候选为对照（不是再次把 H5 收益归给新变量），使用同一准备好的 Native／H5 三交易流程，每轮 187 条命令、1 次外部 RPC、独立后台账本 15 项检查。按已记录的主机活跃状态分层，基线 7 例中位 **42.629 秒**；显式省略参考反馈 3 例 **35.906 秒（−15.77%）**，绑定直接 ADB 传输 3 例 **37.931 秒（−11.02%）**，轻量截图 4 例 **40.8665 秒（−4.13%）**，epoch 范围内能力复用 4 例 **40.7275 秒（−4.46%）**。这四个比例不能相加。反馈省略和轻量截图改变证据范围，不是等证据性能比较。所有慢样本仍留在 [原始结果](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/host-experiment-results.json)；活跃分层和全部样本同时见 [计时汇总](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/host-final-timing-summary.json)。样本量不足以支持统计显著性或长期尾延迟承诺。主机不是独占资源，期间还存在其他实验及 iOS runtime 下载；活跃分层只排除了记录到的休眠／App Nap 状态，不能消除全部 CPU、磁盘和网络竞争。

更快组合第一次并没有可靠通过。Native `full-v2-1-native-combined` 的规格点击与加购相隔约 **61 ms**，两次输入回执均 handled／settled，但业务没有完成加购，弹窗仍在。API 36 对应 AOSP 中存在 ListView 点击回调延迟机制，可解释时序风险；没有该次设备回调时间证据，不能宣布因果已证实。后来 checked=true 的树距 action52 为 **233.559 秒**，不能写成“10 秒内已经选中”。原失败、源码哈希、AOSP URL 与时序边界保留在 [分析](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/native-callback-analysis.md) 与 [原运行目录](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/runs/full-v2-1-native-combined/run/price-changed)。

H5 `full-v3-6-duplicate` 也失败：first-h5-review 等待 **15 秒**超时，独立账本 `approvals=0`。原脚本只等“预览审核”按钮出现，不能证明服务器返回的订单详情已加载；原数据没有被删去。注意 `full-v3-2-mixed-combined` 是成功项，不是这次 H5 失败。[失败报告](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/runs/full-v3-6-duplicate/run/report.json)、[完整 timeout](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/runs/full-v3-6-duplicate/run/last-failure.json)。

在双方使用完全相同的改进作者程序后，Native 显式观察规格 selected 状态，再执行加购；3 对流程、18 个交易的独立 oracle 均通过，中位 **43.306→28.990 秒（约 −33.1%）**。H5 双方显式等服务器订单详情，再填写和确认，3 对均通过，中位 **25.692→20.285 秒（约 −21.0%）**。[Native 同源码结果](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/checked-author/results.json)、[H5 同源码结果](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/checked-author/h5-results.json)、[H5 就绪谓词源码](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/checked-author/concurrent-duplicate-flow.js)。候选仍采用减量诊断策略；这些结果证明固定业务中的可行收益，不证明原脚本已经正确、不证明未知 App 泛化，也不把作者修改计成 Host 单项收益。

Web 给了反向证据：有界 observer 在受控 30 命令购物 fixture 中 **2.545→0.989 秒**，但真实开源 Memos 的最终同源码对照，常态业务 **1.752→1.839 秒**，网络加 80 ms 条件 **3.441→3.614 秒**，当前两阶段等待组合的候选分组中位均约慢 5%，还有额外观察命令。后续复算发现常态多出的 DOM 约 6 ms，更关键是更早完成 presence 后多一轮约 150 ms 的 helper 就绪轮询；不能归因成 observer 本体慢 5%。Memos 使用真实 Web SDK／provider、实际 Chromium 和独立 SQLite；没有把模型编写、完整 MCP／Script supervisor 或截图算进去。不能拿 fixture 的约 61% 改善宣称 Web 默认等待已提速。[真实 Memos 结果](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/memos-summary.json)、[延迟条件](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/memos-delay80-summary.json)。

Flutter opt-in profile/AOT 的同冻结 Host、同输入形状复杂混合流程 3+3 例，6/6 账本通过，中位 **18.081→14.100 秒（−22.0%）**。双设备独立后台的两流程顺序／并行 **27.317→14.308 秒（1.91 倍吞吐）**，各单流程仍约 14 秒。它们是明确但范围有限的实测收益。[profile 对照](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/flutter-profile-comparison-results.json)、[多设备对照](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/parallel-workflow-results.json)。

## 逐项决策：Host、连接、持久化（16 项）

| ID／建议 | 判定 | 实际证据／反例 | 吸收边界与尚缺验证 |
|---|---|---|---|
| P01 前台探测与树并行 | **拒绝当前默认原型** | 静态复杂流程曾快约 5.73%，但真实 Host 受控“慢前台探测期间替换 View”反例：候选先取旧 ref，稍后动作失败；基线等探测后取新树可成功。[反例](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/native-staleness-result.json) | 未误派发仍会增添重观察与 agent 回合。不能用 SDK 能拒旧 ref 证明体验等价；不以自动重试掩盖新鲜度回退。 |
| P02 参考前台情报移出关键路径 | **采纳显式 feedback policy 方向；继续实验默认值** | 真实固定复杂流省略反馈中位 −15.77%，是 Host 最大单因素之一。[汇总](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/host-final-timing-summary.json) | 结果明确 `notCollected`／原始时间，不把未采集当 match。反馈 mismatch 保持情报；后到诊断不能改写既知动作结果。需动态 App 验证返工率与缺诊断成本。 |
| P03 用 SDK Activity／焦点代替设备前台 | **拒绝等价替换** | 真实 Android 展开通知栏，SDK 仍报 WorkflowLabActivity，WindowManager 报 SystemUI；收起后恢复。[对照](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/device-information/summary.json) | App 窗口和设备前台是两个事实。SDK 情报可以提供，但不能覆盖系统遮罩、权限窗、其他 App 和多窗口事实。 |
| P04 同一 H5 命令复用已取得反馈 | **采纳窄候选，仍补外部 WebView** | 同命令复用保留原时间和选择失败的观测，H5 局部中位约 −13% 至 −17%，整个已测流程不到 1%；初轮两组复杂流程、四类恢复与 1662 项回归有记录。[结果](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/experiment-results.json)、[功能检查](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/functional-h5-final.log) | 不跨命令 TTL 缓存，不动独立 h5-eval 的观察。收益属于小优化；第三方动态 WebView 尚未证明。 |
| P05 截图只做轻量窗口探测 | **值得显式可选模式；拒绝静默替换** | 真实固定复杂流中位 −4.13%，PNG 本体可保留，前置归属证明已变弱。[结果](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/host-experiment-results.json) | 标 `ownershipVerified:false` 与采集时段／serial／hash／尺寸。原强探测也非截图瞬间的原子证明。轻量和强证据用途由调用方选；不能称等证据提速。 |
| P06 请求内核对包名和 runtimeEpoch | **采纳已有 guard 与补齐 route 绑定；拒绝“新头即校验”** | 真实 SDK 对合法 schema 的旧 epoch 请求回 native_runtime_changed、dispatched=false。真实克隆 serial 不同而 SDK epoch、descriptor epoch、boot_id 相同。[旧 epoch](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/device-information/sdk-epoch-negative.json)、[克隆](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/clone-identity-isolation-results.json) | Native/H5/Flutter 部分已实现。epoch 不是设备身份证，必须与 transport／server namespace／target 绑定；旧 SDK 忽略字段不算能力通过。 |
| P07 forward 仅建连／出错核对，改绑定传输 | **优先采纳生产设计方向；不直接发布原型** | 真实固定复杂流直接 ADB 中位 −11.02%；6 个 transport fixture、12 个 provider 故障探针验证原 unknown 变更未重发。[测试](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/direct-transport-fixture.test.cjs)、[恢复审查](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/TRANSPORT_RECOVERY_AUDIT.md) | 原型只覆盖默认本地 ADB 配置，远程 server、wrapper、自定义端口未验收。只读且派发前可显式重发现一次；变更不自动重发。原动作恢复必须钉住原路由；公开旧 action 查询会重发现当前端点是已有缺口。 |
| P08 删除每次动作前 status | **采纳 epoch 内不可变能力复用方向** | 真实固定复杂流中位 −4.46%。V1 缓存键与错误压平有问题，V2 补 port／server namespace／socket，保留 status 原错，只缓存四个 schema／epoch 字段；坐标仍取新 status。[复核](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/host-candidate-code-review.md)、[fixture](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/host-v2-fixtures.tap) | 首次可信发现、观察 epoch 匹配与 route 完整分区仍要做。不能缓存焦点、坐标就绪或 mutable status；真实替换／重启／多目标动态矩阵仍是合入条件。 |
| P09 UIA 依 epoch 缓存连接 | **拒绝当前原型默认采纳；保留重新设计实验** | 实际 Host 配受控 HTTP／虚拟 ADB：同命令 ADB 6→2、HTTP 7→5；epoch 旋转使缓存路径从准确 stale-runtime 变成 unauthorized／ambiguous；serial-only 跨 namespace 还可把 B 的动作送到 A 并返回 ok。不是 Android 真机结果。[五组反例](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/connection-cache-results.json) | 需要完整路由键、保留本地 executor ownership、真实预派发分类、断线不重放、原身份查询；不能拿计数下降抵消恢复语义退步。 |
| P10 jar SHA 只算一次 | **低收益，后置** | 实际 32,669 B bundle，Node 热文件 2000 次读加 SHA：中位 **0.035917 ms**、p95 **0.051667 ms**；朴素 memo 在字节替换后返回旧摘要。[实测](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/uia-results.json) | 未测冷盘／大 jar，但当前不能解释百毫秒动作开销。只在不可变安装代次已保证时顺带复用，不新建复杂失效系统。 |
| P11 合并 UIA prepare／start／wait | **值得协议实验，晚于 Host 去重** | 实际 Host／HTTP、已建连接、完成延迟设为 4 ms 的受控 peer：20 动作 HTTP 60→20，中位 **29.613→6.623 ms**；丢返回后由原 action 查询完成，无重放。[实验](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/uia-results.json) | 没有 Java RPC／真实 Android Binder、持久化或设备流量实现。保留 prepare/admit/terminal、取消、原 actionId；测试控制通道不被长等待堵住及全部 crash point。 |
| P12 ack 移出前台等待 | **值得有界后台清理实验** | 真实 ownership／FactStore 的 durable debt 经 close/reopen、失败再清理仍保留原回执；延迟 30 ms ack 仍花约 44.55 ms 清理；9 项债务归档 8 项不释放设备容量；容量=2 fixture 第三次准入失败。[债务实验](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/uia-results.json)、[容量反例](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/uia-P12-capacity-results.json) | 移走工作不等于删除工作。先落原完成事实再 ack；需要有界 worker、关闭／重启、长期离线和容量观测。已知效果与清理债务分开返回。 |
| P13 合并 receipt／settled／release／fsync | **提前到第 2 阶段：ownership 提交去重与追加日志实验** | 新完整流程候选的 ownership 约 **4.3 秒**，448 commits／896 JS fsync；FactStore record 仅约 **0.27 秒**。前轮局部 4→3 commit 已有节省；本轮 11 组私有故障实验确认终态晚于返回会丢恢复事实、旧 writer 迟到 JSON 可覆盖新 pending。[补充审查](/Users/macbook/.codex/worktrees/proposal-evaluation/ai-app-bridge/docs/OPTIMIZATION_FOLLOWUP_REVIEW_2026-10-14.md)、[存储实验](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/followup-review-2026-10-14/persistence/P13_PERSISTENCE_FOLLOWUP.md) | 热点是 ownership，不先泛改低成本 FactStore。保持派发前 marker、公开 durable known／ack 前 completion 的逻辑保证；不要求保留每次物理写入。正规 append WAL／group commit 未被否定，需 generation、持久序号、可恢复 owner 与复杂故障实测。 |
| P14 全 Script 持租约 | **拒绝默认；显式短非交互范围可再试** | 真实 ownership 微测 30 个零时长效果 fsync 240→124、1240.9835→797.4784 ms；实际 Script 停在 askAgent 时，独立进程在逐命令方案可获得租约，整 Script 方案回 target_busy。[复测](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/concurrency-lease-retest.json)、[成本](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/concurrency-results.json) | 不是 Android 执行提速。需规定 askAgent／网络／子 Script 的释放与期限，避免为省本机写入锁住交互自由度。 |
| P15 同设备变更默认排队 | **拒绝静默默认；无已证吞吐收益** | 排队状态机原型出现入队绑定到出队已陈旧；父任务持锁等子任务，子任务排队到 deadline，效果为零。[反例](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/concurrency-results.json) | 这是模型而非 runtime 集成。可选队列需要 position／原因／deadline／取消／公平／依赖环，不自动换目标。即时 busy 应有选择与短指引。 |
| P16 不优先 keep-alive，不搬 Script 到设备 | **采纳当前优先级；保留远程场景** | 当前 SDK Connection: close；本地直接只读请求约 2.7 ms，准备好的 187 命令已经一次外部 RPC。已证主要成本为重复 ADB／持久化。[只读实测](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/direct-adb-read-result.json)、[完整流程](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/host-experiment-results.json) | 未实现或 A/B 新 keep-alive，不能称绝无收益；高 RTT 另测。当前没有足够收益理由新增设备语言或批量 DSL，普通 JS／Python 和 askAgent／decide 保留。 |

## 逐项决策：等待、状态与传输表示（8 项）

| ID／建议 | 判定 | 实际证据／反例 | 吸收边界与尚缺验证 |
|---|---|---|---|
| W01 用 observer 替代 polling、缩短 interval | **拒绝当前默认替换；保留有界显式事件实验** | 已满足条件本来先立即检查；40 ms 后出现节点时受控浏览器 290.4→60.8 ms，但真实 Memos 当前二阶段等待组合的分组中位约慢 5%，涉及额外 helper 轮询、CSS 就绪与 React 对象替换；不能推为 observer 本身慢。双方同就绪谓词的策略对照仍值得做。纯 observer 漏 property／CSSOM；高变更检查 2→12。[真实报告](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/README.md)、[等待](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/wait-summary.json) | 先分 presence 与 actionable；存在性可以多匹配，真正动作仍明确选目标。新参数需能力协商，旧 SDK 不可静默忽略。Native／H5／Flutter 没有同样收益证明；不默认超高频采集。 |
| W02 长等待前重写单连接 SDK | **采纳窄 server 调度改进；拒绝整协议重写前提** | 真实安装 Android SDK 状态查询通常 5–14 ms；一条未完成 HTTP header 可让后续查询拖约 1.44 秒，释放后恢复。managed action/capture 已异步。[真实探针](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/sdk-control-probe-result.json) | 证实 accept/read 有串行阻塞。先做有界 parser／worker 与 status/cancel 控制请求保障，不据此先造 multiplex 协议；新实现尚未验收。 |
| W03 绘制／帧／DOM事件版本证明镜像当前 | **拒绝这个证明** | 实际 Web value property、CSSOM 改变未产生 observer 或 SDK UI 事件，新树却已不同；Canvas／iframe 还有采集范围缺口。[反例](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/coverage-raw.json) | 事件只可唤醒重算。版本要说明 scope／coverage／age／gap；没有事件不等于全屏未变。Android／Flutter 未做覆盖完备证明。 |
| W04 每节点 Merkle 与设备常驻版本树 | **低收益未证；后置完整架构** | 相同文本的对象替换会内容 hash 相同而身份变。Web 53／223／523 控件采集约 0.4／1.3／3.0 ms，额外 Host 每节点 hash 0.127／0.476／0.940 ms；没有完整净收益。[采集成本](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/context-cost-raw.json)、[身份反例](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/coverage-raw.json) | 没有 Android／Flutter 每帧实现、CPU／帧损耗／内存实测。先按需 conditional read/diff，不默认常驻或将 hash 当动作身份。 |
| W05 长连接推送与 Host 镜像本地读 | **值得有范围原型，非近期前置** | 8 个实际采集的 snapshot 输入镜像，故意丢序号 3 后收到 4；原型明确 gap 并补采一次。Web 已有 WebSocket。[原型](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/mirror-counterexample.json) | 不是设备推送实现。缺背压、乱序／重连／控制请求优先级与长时 soak；本地读必须带新鲜度范围，不能冒充新观察。 |
| W06 回执前后版本／变化摘要 | **采纳为可选观察情报** | 实际点击令非 DOM 计数 +1 但 DOM hash 不变；另一点击返回 ok 且页面变为网络错误，订单账本仍 0。[反例](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/action-facts-and-order-counterexamples.json) | 可说“观察到／未观察到变化”，不能推导业务成功／失败或授权重试。选择采集范围与代价，避免每步强制全树观察。 |
| W07 内容寻址去重／结构 diff／屏幕指纹 | **采纳去重与检索提示方向；分开实现** | 8 次静态真采集内容 83,816 B 可去重为 8,728 B；但去文字结构指纹把价格 49 与 59 混同。[证据](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/mirror-counterexample.json)、[表示](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/representation-results.json) | 每次身份、时间、回执和覆盖仍保留。未测整段存储 I/O、GC、保留期和跨版本回归价值；指纹不证明订单或目标身份。 |
| W08 二进制／压缩无收益 | **本机小 JSON 低优先级；拒绝普遍无用的结论** | 真采集 23／93／218 KB JSON 解析中位 0.081／0.272／0.619 ms，gzip 0.146／0.339／0.753 ms，字节显著缩小但不是主要耗时。[实测](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/encoding.json) | 未测远程带宽、大 UIA XML、二进制截图。公共 Android 截图已直接取 PNG，不能把 SDK base64 改造收益算到它；模型端仍需要可读内容。 |

## 逐项决策：agent 信息、发现与复用（11 项）

| ID／建议 | 判定 | 实际证据／反例 | 吸收边界与尚缺验证 |
|---|---|---|---|
| O01 默认极简大纲，约缩小 10 倍 | **拒绝有损默认替换；保留可选投影** | 21 条真实历史 Memos DOM、44 个机械选择任务：完整与丰富大纲 44/44、无补读；极简大纲需 **20 次补读**才能完成。丰富大纲 103,559 tokens，现有无损 table 106,765，约省 3%，且字节反而更多。另一 42 任务 fixture 中极简仅 18 可直接答，其余 24 要补读。[语料](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/memos-corpus-summary.json)、[token](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/token-counts.json) | 是确定性任务，不是盲测 LLM 理解／响应速度；不能称首次回合减半。auto 应保留选目标与恢复所需信息，以补读率和总成本定默认，不能只盯返回字节。 |
| O02 Host 短引用隐藏完整绑定 | **值得限定作用域实验；收益未闭合** | 显式 observation scope 的动作参数可由 869 B 缩为 25 B；同对象属性变化可继续并提示，替换／reload／scope 缺失明确拒绝陈旧绑定。[实验](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/reference-recovery.json) | 现有 web-steps 已隐藏复制；还未测模型编写成本、持久引用表、多客户端和重启收益。不能把任意 UI 小变化变成整页 ref 作废。 |
| O03 默认可读增量 | **拒绝无条件默认；采纳显式、择小 delta 方向** | 47 个实际 fixture 相邻观察仅 **18 个 delta 更小、29 个更大**；初版丢相同标签重排顺序，补显式 order 后反例才通过。[最终](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/representation-results.json)、[原失败](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/author-revisions/projection-v1-before-order-fix/action-facts-and-order-counterexamples.json) | 指明 base／document／coverage，缺基线可获取全量；保留次序与错误／回执字段。尚无跨模型上下文压缩、多 agent 的总回合收益。 |
| O04 服务端 find | **复用已有能力；上下文不足再局部增强** | web-dom 已有 query／selector／offset／maxControls。受控 3 按钮过滤 **11,026→3,143 B**；增加祖先上下文整体变 **13,255 B**，523 控件采集 **3.0→5.2 ms**。真实 Memos 两层祖先未到文章，而该例 disabled 已能区分 Save。[开销](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/context-cost-raw.json)、[真实页面](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/memos-live-context-probe.json) | 不重复加同义入口。可定向取同卡片上下文，过滤未找到不等于全页不存在；跨 Native／UIA／Flutter 的一致覆盖仍需单独验证。 |
| O05 稳定字段顺序提升提示缓存 | **低优先级，未证模型收益** | 独立新请求共享前缀可从 13 B 到 15,967 B；追加式对话的旧历史前缀本来就不变。[实验](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/prompt-prefix-experiment.json) | 未测模型 cached_tokens／成本／延迟。只做可读性整理，不改证据 canonical hash、不删除时间或承诺缓存提速。 |
| O06 一次发现目标页面和可执行动作 | **采纳少回合目标；用现有观察附相关提示** | 已知命令一次发现 2,518 B，人为拆六次 14,435 B；六次不是接口强制。实际 registry 校验了当前观察可构造动作。[实验](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/guidance-discovery.json) | target 在线发现有用，但静态 help 不必强制连接设备。尚无固定模型／陌生 App 的回合 A/B；避免每次附全部能力造成新大回包。 |
| O07 缺 web_target_changed 指引 | **拒绝缺口前提；保留已有能力** | production provider 已返回 currentTarget 与 web-dom 指引；受控页和真实 Memos reload 后按回包命令恢复读取。[复核](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/reference-recovery.json)、[真实 reload](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/memos-poll250-0.json) | 若其他公开路径仍遗漏要定位到该层，而非再加同义提示。当前证据不保证所有平台所有错误都有引导。 |
| O08 找不到目标就给 wait 方案 | **采纳窄、可执行提示；拒绝自动等待所有错误** | 真实 web_element_not_found 缺 guidance；原型按实际 registry 生成 wait/read，延迟节点等到后新绑定点击成功；标签拼错选择 read，避免白等 timeout。[原型](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/guidance-discovery.json) | 简短命令必须含当前参数、只用于相符场景。业务错误／截断／覆盖不足／拼错分别提示；不能把快速失败改成固定长等待。 |
| O09 Native／UIA／Flutter helper 与成功程序复用 | **采纳普通 helper 路线，按真实重复提炼** | 同一个现有 web-steps 跑受控页及真实 Memos。最终 Memos 的有限显式重观察只处理 settled、未派发、非歧义 reobserve_required；记录旧／新对象；延迟候选三例各恢复一次，没有重放已知效果。[作者程序](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/src/memos-experiment.js) | 不制造新 DSL，不删除 askAgent／decide。Native／UIA／Flutter helper 本轮没有全实现；从多个动态调用方提炼，不能只封装已知 P001 业务。 |
| O10 探索记录导出 Script 草稿 | **采纳为能力方案，已验证功能可行** | 30 个记录调用变为 35 行／4,340 B 普通 JS，4 个输入槽；新会话与重排通过，目标改名在第 10 步停下，显式重观察和新源码继续后账本只发生一次。[三类试验](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/export-trials.json)、[草稿](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/src/exported-flow-draft.js) | 不是已完成通用导出器，未测作者／模型净耗时。导出表达目标的选择器与参数，不导出过期 ref；敏感输入留占位，断言与未覆盖分支明示。 |
| O11 应用知识缓存／屏幕地图／自愈 | **采纳被动配方提示；拒绝静默改目标** | 成功普通源码能复用到新会话／重排；改名后明确旧新选择器和原因可继续。同结构不同价格发生指纹碰撞。[复用](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/export-trials.json)、[碰撞](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/representation-results.json) | 尚无持久跨 App 检索质量和首次模型回合收益。缓存命中只给线索；App 版本、来源、失败记录、命中覆盖可查，不将历史成功变成本次 unknown 的结论。 |

## 逐项决策：恢复与执行自由度（7 项）

| ID／建议 | 判定 | 实际证据／反例 | 吸收边界与尚缺验证 |
|---|---|---|---|
| R01 marker 记 command／调用方 label | **优先采纳为方案** | 真实 Script 子进程崩溃、实际分段 FactStore 与原型 supervisor 可留 command=tap-text、label=place-order；旧 actionSpecHash 无法反推出命令。[实测](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/recovery-results.json) | label 可选、有界；命令是事实，label 是调用方情报。未知可扩展字段不能堵整个 Runtime 启动。Python 路径、隐私与标签规则尚未完整实现／验收。 |
| R02 ctx.recovery() 汇合 checkpoint 后事实 | **优先采纳只读事实视图** | 真 Script／FactStore／ctx IPC 原型把需手工关联的 **10,443 B→770 B**，100 次读取均值 **1.236 ms**；校验损坏保持 unknown／整体 false；程序 completed 仍可能含 ambiguous 动作。[实验](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/recovery-results.json)、[损坏边界](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/inventory-results.json) | 不是自动业务对账。需要稳定 checkpoint evidenceId、分页 high-watermark、保留期缺口与来源校验。无记录不等于未派发；断电和完整版本迁移未验证。 |
| R03 列出中断操作 | **采纳只读 inventory 方案** | 实际三次 Script 中两次真实子进程崩溃、一次正常结束；同 FactStore 原型正确筛选中断项，耗时约 **5.437 ms**。[实测](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/inventory-results.json) | 不是全局生产索引；多设备／多进程并发分页、损坏分区与 retention 需定义。应给原 operation/action 查询与显式恢复入口，不默认重放。 |
| R04 recordingDir 与 checkpoint 恢复兼容 | **采纳按 attempt 分目录方案** | 实际 Script restart／recorder 原型放宽策略 guard 后，两次 attempt 不同 recordingId、同 operation，旧记录哈希不变，两次不同效果均可追溯。[实测](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/recovery-results.json) | 当前仅证明隔离目录可行，未实现生产完整索引；不能覆盖旧 recording 或冒充连续无缺口。部分索引、viewer、清理与中断再中断待测。 |
| R05 effectKey 幂等 | **值得显式窄合同实验；不承诺业务 exactly-once** | 真实两进程 SQLite 唯一 claim、受控 effect：并发只一次；已 settled 返回原回执，效果后崩溃保持 unknown 不重放。错误 TTL 清 unknown 会产生两次效果；初版浅哈希漏嵌套差异，递归 canonical 修正。首次约 **6.267 ms** 对直接 **3.976 ms**，复用 **0.583 ms**。[并发](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/concurrency-results.json)、[嵌套反例](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/concurrency-R05-nested-retest.json)、[成本](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/concurrency-R05-cost-retest.json) | key 使用调用方明确声明的稳定 effect scope，命令／绑定目标／有效参数参与一致性校验；跨 operation 延续或新建 scope 由调用方明确选择，不能因新 operationId 自动绕过去重。在同一持久事实源内原子认领。retention 不得删 unknown。没有业务后端协作就不保证 exactly-once；lookup 的本次未派发不能掩盖原动作 unknown。 |
| R06 程序 bug 必须从头重跑，所以原 operation 热换源码／REPL | **拒绝前提与隐式热换；采纳明确新 operation 继续** | 实际冻结源码 Script 保持原 operation 改源码被拒；以新 operation 从当前状态继续只执行第二个效果，总效果 2，没有重做第一个。[实测](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/recovery-results.json) | 已有 askAgent／decide 保留。新源码继续要引用前序事实并列明 state／缺口，不声称恢复 JS/Python 栈；无需为继续能力先造 REPL。 |
| R07 不匹配不应令全工具无路可走 | **采纳局部失败与可恢复可见性，保留既有恢复** | 实际 worker 在效果后退出，ownership 归档保留旧 unknown，新明确动作仍能执行：原效果 1、新效果 1；局部写失败后独立只读 Script 可用。[复测](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/concurrency-R07-retest.json)、[故障注入](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/recovery-results.json) | 这是 Host／存储级证据，不是所有 Android force-reset／断电／升级矩阵。需要简短原身份查询、归档／force-close 提示和失败分区；不能清 unknown 伪造恢复成功。 |

R01–R04 的主要收益是把已经存在但分散的事实交给调用方，少做手工关联和无意义来回。原型的字节与 IPC 时间支持实现方向，却没有直接测出模型回合节省。设计应保持少量入口：恢复视图、操作清单、明确的新 attempt／operation 关联，复用原查询／取消／归档命令。不要为这些事实再定义一套执行语言。[本组详细报告](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/REPORT.md)。

## 逐项决策：平台与执行能力（7 项）

| ID／建议 | 判定 | 实际证据／反例 | 吸收边界与尚缺验证 |
|---|---|---|---|
| C01 Flutter debug-only 改 profile/AOT | **采纳显式测试变体方案；暂不全局默认切换** | 真实 profile AOT APK，显式 Dart 初始化及 Android profile SDK 依赖，完整 Flutter 登录／H5／SKU／Native 地址／优惠／支付丢响应后原订单查询与退款。6/6 流程通过；profile 中位 **14.100 秒**、debug **18.081 秒**，−22.0%。[A/B](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/flutter-profile-comparison-results.json) | 2 核 2 GiB 模拟器、固定已知业务；第一 profile 多一命令，其余 66。安装／预启动／诊断不在 Script 时间内。插件、路由、profile 崩溃恢复、iOS Flutter 与真机未全覆盖；debug 诊断更丰富。 |
| C02 profile 必然非 debuggable | **拒绝该前提** | 当前 Flutter 3.44.8 的 stock 与 opt-in profile APK 有 libapp.so、无 kernel_blob，manifest 都 debuggable=true，实际 run-as 成功；stock 没有 Bridge endpoint。[APK](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/flutter-stock-profile-apk-analysis.json)、[运行](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/android-stock-profile-run-as.json) | AOT/JIT、manifest、SDK 初始化是三个选择。其他 Flutter 版本、自定义 Gradle、商店 release 不能据此类推。 |
| C03 装 iOS runtime 即可验收 | **采纳 Simulator 专用 adapter 方案；拒绝安装即通过** | 真官方 iOS 27 runtime 与独立 iPhone 16e Simulator，stock SDK 原生树、WKWebView DOM 点击／原回执／重启 epoch／旧绑定拒绝可运行；公开 ios-status 对真实 UUID 却报 ios_tunnel_unavailable，Native SDK 原生触摸明确不支持。[真实结果](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/ios-simulator-results.json)、[公开 adapter](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/ios-public-adapter-simulator-probe.json) | 下载安装导出约 27 分 19 秒，不是“几秒补齐”。没验收 WDA／Flutter iOS／真机／复杂 App。即时 PNG 还可早于 compositor；初次 inactive 失败原因未证实，必须保留。 |
| C04 WDA 每动作固定三次 devicectl，均秒级 | **校正调用数；性能结论待真执行** | 生产 provider 配真实本地 HTTP 和 devicectl 子进程 fixture：语义 tap/input 各 **2 次**，坐标 tap/input/swipe 各 **3 次**，各 1 个 fixture 效果。[计数](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/ios-wda-call-count-results.json) | 不是真 WDA／XCTest 执行，没证明每次 devicectl 秒级，也没测删身份查询收益。可探有界上下文复用，不能照抄 Android 结论。 |
| C05 没有 doubleClick／drag、UIA 只点 | **先采纳准确能力发现；按执行器补缺口** | 生产 Playwright worker 在真实 Chromium 可 trusted click、doubleClick、drag，业务效果各一次；源码另有 Flutter integration_test drag/fling、Native longPress/swipe/scroll；独立 UIA managed action 当前仅 ACTION_CLICK。[真实浏览器](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/browser-capability-results.json) | 全平台“没有”不成立。多指是独立真缺口；未运行覆盖所有 Native／Flutter 手势、取消清理与旋转。不要重新造已有 primitive。 |
| C06 H5/Web element.click 不可信输入 | **采纳 synthetic／trusted 声明与显式 executor 选择** | 真实浏览器同页面：Web SDK element.click 回 ok，但 isTrusted/userActivation 门禁业务计数 0；明确 Playwright worker 点击计数 1，double／drag 也有效。[反例](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/browser-capability-results.json)、[画面](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/browser-capability.png) | SDK 交付用受控 wire，未比较 WebSocket 速度。不能在 synthetic 已 unknown 后静默改 trusted 重放；执行器兼容性、覆盖和价格由调用方选择。 |
| C07 网络模拟／时钟控制 | **采纳有范围测试能力；拒绝通用全局虚拟化假设** | 实际 Playwright 首请求 abort、第二次 fixture fulfil、unroute 后恢复真实服务；页面 60 秒 timer 可在约 **0.829 ms** Host 时间推进；Android 服务 fixture 真 HTTP 验证提交后丢响应／原订单查询。[浏览器原型](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/browser-capability-results.json) | Bridge 公共 executor schema 尚未暴露 route/clock。页面时间不是服务端过期／支付时钟；Native／Flutter 拦截一致性未实现。优先显式 page/backend scope、结束清理与故障日志。 |

平台原始失败没有从结果中抹去：profile 原型第一轮缺 launcher／静态资源；HTTP 服务曾先写 200 后写 500 导致 headers sent 和 H5 等待失败，修资源后重跑。iOS 初次 foreground inactive 与旧 PID descriptor 连接失败分别保留。它们说明构建通过不能替代运行证据，也不能将夹具故障计为产品性能。完整范围及清理记录见 [平台报告](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/platform-evaluation.md)。

## 逐项决策：真实等待、环境与全局流程（8 项）

| ID／建议 | 判定 | 实际证据／反例 | 吸收边界与尚缺验证 |
|---|---|---|---|
| E01 默认等待主线程／动画／网络全空闲 | **拒绝默认全局 idle；保留显式资源同步** | 真实 HTTP 业务 65.1 ms 已就绪，同时 SSE 响应体持续，pending=0 连续 100 ms 在 500 ms 窗口从未出现。[反例](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/raw/idle-counterexample.json) | 网络计数是 fetch wrapper 原型，不是 SDK 全资源跟踪。后台流量不应堵已可继续业务；按资源／域／任务提供事实，业务仍用保存／落账等谓词。 |
| E02 显式关系统动画 | **采纳可选非视觉环境 recipe；实测收益低** | 真实 Android 3 对完整流程、18 交易全过，原设置与关闭动画中位 **43.127→42.673 秒，仅 −1.053%**。每次准确恢复 `1.0/1.0/absent`；独立进程崩溃 journal fixture 验证恢复。[真实结果](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/animation-device/summary.json)、[故障恢复](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/animation-recovery-fixture.tap) | 不是显著工具提速，也不替代网络／业务就绪。视觉验收不默认启用，保留原 absent 而非写 1；其他 App／动画量／设备版本未证明。 |
| E03 录屏抽帧替代每步 PNG | **保留可选视频；拒绝默认等证据替代** | 同复杂流程 PNG／无 PNG／H264 各 2 例、共 6/6；中位 **13.812／11.304／12.882 秒**。该 guest 固定 25 秒录屏实现的整段耗时减少 6.7%，最终文件到 **26.58–28.89 秒**才可用；无 PNG 的 −18.2% 只是省略证据上界。静止期没有请求时点的新帧。[结果](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/video-evidence-summary.json)、[帧](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/video-evidence-4-video-frames/frames.json) | 25 秒有界 guest 录制，不是 console／scrcpy 流实现；不外推为录屏机制低收益，也未证明编码器或 CPU 竞争根因。流程结束即 stop 的主机路径可另测；动作时间对设备 PTS、丢帧、Toast、即时停止、无损图像等价未验证。首个后续帧可能远晚于动作，不能冒充第 N 步截图。 |
| E04 快照跳过登录／准备 | **采纳隔离 fixture 快照；拒绝透明回滚** | 真保存 **1.840 秒**、加载至新观察 **1.976 秒**，该 UI 登录 **1.669 秒**，短登录无净利。设备文件／页面／SDK epoch 回滚，后台支付退款和 Host 历史不回滚。[实测](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/snapshot-results.json) | 本次仅验证无 active/unresolved 动作的还原，其他状态未验证；这不是 caller 准入限制。调用方显式恢复仍保留原未决事实并说明 Host／后台不回滚，不将 unknown 变成未派发或自动重放。后端／账户／时钟需协调，复杂长准备另测。 |
| E05 只读 CoW 实例与真机 data 备份 | **采纳受控只读克隆设施；拒绝完整状态等价** | Emulator 37.1.3 拒绝 writable+readonly，两个全 readonly 成功；两个 serial 的 epoch 与 boot_id 相同，一端私有文件不影响另一端，退出再开 overlay 消失。[隔离](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/clone-identity-isolation-results.json)、[丢弃](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/clone-discard-results.json) | RSS 2.23–2.41 GiB 不能证明 CoW 实际节省多少物理内存。真机 data 不含完整 keystore／权限／内存／后端；克隆身份必须带 serial／route。 |
| E06 多设备并行 | **采纳独立目标编排／示例；标吞吐收益** | 两个 serial、独立后台 runId，8/8 完整混合流程通过。顺序两流程中位 **27.317 秒**，并行 **14.308 秒，1.91 倍吞吐**；各并行 Script 仍约 14 秒。[实测](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/parallel-workflow-results.json) | 只测两台及该主机负载，非三台饱和曲线、非单链路减半，也不证明共享真实账户并发安全。独立 serial 现有租约已允许并行。 |
| E07 并行＋快照＋知识缓存收益叠加 | **只保留已经实跑的组合；拒绝连乘推算** | 实跑 profile＋两个只读克隆＋后台隔离，两完整流程约 14.3 秒；该短登录用快照更慢，视频净益有限。[平台组合](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/platform-evaluation.md) | 知识缓存／探索导出未和这条 Android 链集成；不能得出单段 4–5 秒或全部场景倍数。后续每种组合都需同输入、同作者、同证据策略。 |
| E08 陌生复杂 App 一分钟全部测完 | **拒绝无覆盖定义的普遍承诺；坚持准备后执行指标** | 历史候选首次派发到 UI **311.083 秒**，MCP 窗口 **1.979 秒**，之后协调等待另 **189.845 秒**；每臂单例不同作者。当前 prepared Memos 不含模型编写或 Script supervisor。[历史对照](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/0.4.8-work/2026-10-13/web-latency/first-use-comparison.json) | 用户已明确必要的编写时间不可消除，工具应减少重复编写／无意义回合。将信息足够后连续执行、首次探索、恢复和覆盖单列；真实大型 App 与大型动态测试集由用户另行分工；本轮不以其结果替代或阻塞这 57 项的审查收敛。 |

## 不在原 57 条标题里、但影响真实可用性的根本缺口

**业务就绪不等于输入已经派发。** Native 已 handled／settled、Web 已元素存在／可点击，都不表示 SKU 回调、订单详情或保存请求完成。提速减少了偶然“用 Host 开销等 App”的时间，暴露了原作者程序缺少就绪条件。产品应让条件在普通 Script 内快速观察、解释失败范围、只在确有动态决策时询问 agent；不要新加统一固定 sleep，也不要给每个动作强制全 App idle。Native 的 checked、H5 的服务端详情与 Memos 的保存完成都要分别体现于示例、帮助和验收。当前还没有证据证明一个通用就绪算法能替代所有业务条件。

**部分观察被误报为整条执行失败是实在的易用性问题。** 实际采集的 profile/debug Flutter layout 含有效 operable 分支，但 Android Host 原路径缺顶层 ok，经公共回复成为 execution.ok=null／CLI exit 1。独立候选在实际 Host／CLI 配受控传输中保留四分支原文，将至少一源可用标成 ok=true，同时返回 availableSources／unavailableSources 并保留各分支原覆盖；捕获样本 operable 的 5 个节点不变。所有源失败、layout 缺失、隐私抑制仍准确保留失败或不可用，不能把 partial 当完整树。除捕获重放外，主审已在同一真实安装 App 上完成公开 CLI 的旧／新对照，见上文最终设备记录；不把缺失源改成完整，也不将观察成功改成动作成功。[原型复核](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/flutter-observation-review.md)、[公开回复检查](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/flutter-delivery-review-results.json)。

这次也发现更邻近的既有缺口：实际 Script Host 的 generic tree evidence 在部分源不可用时仍可能标 coverage=complete；iOS flutter-nodes 在受控失败源下用 Boolean(operable) 覆盖源 ok=false、清除 error。两项都应单独修正来源覆盖语义并复测，不能由 Android 顶层 ok 修复自动宣称解决。[独立复核索引](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/extra-review-coverage.json)。

**路由身份与缓存代次要区分。** 实际克隆证明 epoch／boot_id 可以重复；缓存表应完整分区，原动作查询／取消要沿原身份走。对只读、确定未派发的发现失败可以重新获取事实；已发出请求丢回复不能借“恢复”换到新目标再执行一次。需要将旧动作状态与当前端点分开供 agent 判断，而不是一个错误堵住所有其他独立操作。[传输恢复审查](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/TRANSPORT_RECOVERY_AUDIT.md)。

**固定数据不检验探索与选择能力。** 大量商品、复杂控件或多种技术栈本身仍不足够；如果程序预先知道 ID、目标顺序与成功路径，只证明已知流程。新的 [大型测试 App 建设任务](/Users/macbook/.codex/worktrees/proposal-evaluation/ai-app-bridge/docs/MEITUAN_SCALE_TEST_APP_BRIEF_2026-10-14.md) 已把范围扩展为真实无 SDK 大型 App、按实见复杂度建立的混合多业务 App、可复现动态压力三条线，并要求 SDK 开／关、冻结作者后留出 seed、独立 oracle。文档覆盖外卖、酒店、票务、预约、会员、订单、会话和跨页行为，当前不再过度缩成通用商城；**该建设和真实大型 App 实测已按用户最新指示外部分工；本主线完成建议评估与取舍，不再将这些新建设任务列作本轮未完验收**。

## 外部分工前已取得的真实反例

美团／抖音的后续探索和测试 App 建设按用户安排由其他 agent 负责；这次已取得的真实反例仍反馈到主线方案，不能因分工而丢失。

- **无障碍 clickable 标志不能概括触摸能力。** 美团城市“北京”的选择使用 `nearest_clickable_ancestor`，并非 exact_node；动作前树的 26 层祖先都标 clickable=false，语义动作明确未派发。根据截图显式执行 `adb-exec` 坐标点击后进入北京首页。建议错误说明未派发、目标边界与可选输入原语，让 agent 决定；不静默替换成坐标，也不把 UIA 的局限说成整个 Bridge 无法操作。
- **系统权限不属于 App 的包名过滤范围。** 抖音协议后，无过滤读树能看到通知权限窗口并完成精确操作。先提供系统窗口事实，避免让 agent 把过滤后的空树误判成 App 卡死；不隐式授权权限。
- **新采集的树与当前像素也可能不同步。** 真实城市页加载时树只有系统栏，视频推广关闭后树短时仍有推广文字。应标各自采样时刻和范围；这尚不能归因于 Bridge 缓存。
- **巨大原始回包与错误引导是不同问题。** 显式 `extract:null` 的 531 KB UIA 树触发 responseRef，不能用它证明默认 auto 失败；但一次未派发错误携带整段 window dump、缺少短恢复提示，确实增加读取成本。原始诊断可继续留存供按需读取。

已有范围、APK 身份、树／截图、坐标恢复、缺口及清理见 [真实 App 交接](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/real-world-apps/HANDOFF.md)。另一个动态后端开发样本虽在 3.908 秒完成 UI，独立账本审计发现支付断回包后实际收到两次 POST，因此未标完整通过；来源未定位，不能推断 Bridge 重放。六个留出 seed 未启动，代码与原失败见 [动态原型交接](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/dynamic-fixture/HANDOFF.md)。这些有限材料不算大型 App 通过证明。

## 建议的实施顺序

| 顺序 | 进入方案的工作 | 为什么优先 | 进入生产前要拿到什么 |
|---|---|---|---|
| 1：先减少误报与返工 | Flutter 部分观察分类；来源 coverage；R01–R03 只读恢复事实；O08 简短相关指引；用已有 discovery/helper 暴露真实 executor 与输入模式；修正 capture 时间域样例与补原 action 查询 | 都解决已发现的错误信息或手工拼事实，接口规模小；不必先做全协议或 UI 镜像。未知不重放仍可允许读取、原状态查询和新操作继续。 | 公共 CLI／MCP／Intent／Script 在源成功、部分成功、全失败、校验损坏、升级旧记录中的一致结果；提示命令真实可执行，不能多出强制填写字段。 |
| 2：去已测到的热路径重复工作 | P07 完整绑定传输；P08 不可变能力复用；P02 明确反馈策略；P04 同命令 H5 复用；P13 ownership 提交去重／追加表示；模拟器 console 截图 | 新实测 ownership 约 4.3 秒，截图原语每张约省 108 ms；单因素已见约 11%、4%、16% 与小于 1% 的不同范围收益；组合必须保留 readiness 和证据策略说明。 | 动态 seed／真实大型 App 的交错 A/B；自定义 ADB／远程 server 或明确 unsupported 边界；跨 serial、同 epoch 克隆、端点轮换、断连与取消全矩阵；完整失败保留；存储需双 Host、durable sequence、ack／释放和崩溃矩阵；截图需连续产物不覆盖、来源明确与失败恢复，像素完全一致不是门槛。 |
| 3：补实际能力与测试环境 | C01 opt-in profile/AOT；C03 Simulator adapter；C05/C06 真实能力发现与显式 trusted executor；E06 独立多设备示例 | profile 与多设备有明确范围收益；iOS 公开 adapter 是真实缺口；已有手势不应再实现一份。 | 各执行器自己的复杂流程与恢复，不以编译／SDK 私有调用替代公开入口。profile 进程死亡／取消／原 receipt，iOS Native 与 Flutter 分别记未完成。 |
| 4：减少重复作者工作 | O09 普通 helpers；O10 导出可编辑程序草稿；R04 分 attempt recording；O04 定向上下文；O02 短 ref 试点 | 已有功能原型可减少绑定／记录重复，仍需测补读和模型回合的净收益。 | 至少多业务、未知数据留出集；不泄露隐藏答案；改名／重排／分页／登录过期后明确续跑；总 token＋补读＋回合，而非单回包压缩率。 |
| 5：UIA 协议与后续存储能力 | P11 合并 RPC、P12 durable ack 清理、R05 opt-in effectKey；W02 有界请求调度；低开销 FactStore 的内部批次后置 | 局部原型证明可省部分调用／落盘，但失败与所有权合同复杂，收益上限尚未见真实 UIA。 | 真 Android UIA 复杂流程、所有 crash point、设备／Host 重启、未知结果、队列容量／长期离线、worker 饥饿、损坏日志、原记录可查询；不能只测 happy path。 |
| 6：选做，按需求启动 | E02 非视觉动画 recipe；E03 视频；E04 隔离快照；W06 变化摘要；W07 去重；W05 镜像研究；C07 有范围网络／时钟 | 有些功能有价值，但本轮提速小、证据成本可能上升，或架构成本尚无净收益支撑。 | 明确调用方用途、资源清理、证据含义与额外耗时；不要把它们作为使用普通 Intent/Script 的前置要求。 |

暂不进入默认产品路线：P01 的旧树并行、P03 的焦点等价替换、P09 当前 epoch 连接缓存、P14 全 Script 租约、P15 静默排队、W01 当前 observer 全局替换、W03 事件即新鲜度证明、O01 有损极简默认、O03 无基线默认增量、E01 全局 idle、E03 录屏等价替代 PNG。P10 hash、O05 前缀格式、W08 本地小 JSON 编码、P16 新 keep-alive／设备 DSL 当前后置。拒绝的是具体默认方式或收益宣称，不是否定在明确场景下由调用方选择的能力。

实施接口应尽量利用现有命令、extract、执行器选择、普通 Script ctx 和恢复查询。反馈／证据模式表达“采了什么、没采什么”；业务条件表达“等什么、等多久”；恢复视图表达“哪些已知、哪些仍未知”。避免再提供一条和 Intent 重复的单次执行入口，避免强制 label／extract:null／设备级包名一类额外手续，也避免每一步无条件回模型。

## 主线收敛、后续产品化门槛与外部分工

前轮冻结候选的功能回归为 **1668／1668 通过，0 skipped，172.088 秒**；删除误导性 partial 字段后重新完整运行，已核对原日志末尾。[最终功能日志](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/final-worktree-functional-v2.log)。它证明当时冻结版本的功能检查通过；本次 guard 清理另有 18 项相关回归，未新跑全量或新包验证；不证明隔离原型全部已合入，也不能覆盖尚未实现的协议、平台、恢复与大规模动态场景。本文对无真实跨平台／恢复证据的建议，继续保留“方向采纳／继续实验／后置”级别，不升级为全部实现验证。

| 验收线 | 当前结论 | 必须补的证据 |
|---|---|---|
| 本轮 57 条建议评估 | 全部有本轮范围内判定；E02 已补真实设备 A/B。评估状态完成不表示实现完成。 | 主审核对最终源码、采纳清单、版本与可发布范围；本轮主线可以完成评估和取舍，不能把这个计数表述成 57 项产品化。 |
| 真实大型、未集成 SDK App | 用户已交给其他 agent；不列作本主线未完任务，本文没有全面通过结论。 | 版本／APK hash／设备／入口条件／登录状态、页面及状态地图；真实 UIA/截图/设备命令成功与缺口分别记；不能用测试 App 替代。 |
| 动态 seed 后端／浏览器原型 | 已有动态机制探索与原型方向，完整大型动态测试集由用户另行分工；不宣称现有原型代表多业务 App 验收。 | 作者冻结后选择留出 seed，目标约束从 UI 观察求解；无解任务能准确结束；并发状态变更／重排／分页／旧响应／恢复；执行器不读隐藏答案。 |
| 大型混合多业务测试 App | 有明确建设 brief，已按用户指示外部分工；当前样例不是最终复杂度验收。 | 独立业务模型及跨业务会话／订单联动；Native、Flutter、H5 实际运行；SDK 开／关；后端网络、数据与故障真实约束；多业务完整 UI 及独立账本。 |
| 生产采纳 | 独立于实验成功，不能从本文推出所有改动已合入。 | 同源码、同证据策略交错 A/B；复杂正确性和恢复；取消／断连／版本差异／旧记录；可复核 diff、回退与文档。 |

性能与易用性报告应给每个页面／状态／跨业务跳转的覆盖和阻断原因，以及跨 seed 的完成率、首次成功率、错误分类、误报导致的额外读／回合、工具执行与恢复耗时分布、输出 token／补读、证据就绪时间、CPU／内存等资源。单次最短、少量中位和固定路径成功不能代表广泛场景验收。记录所有失败与最后处置，排除环境影响时也保留原样本及观察依据。

对可继续性单独断言：原动作已知则查询原回执；结果未知保持原身份并允许独立观察／业务对账；确定未派发的陈旧绑定可由作者显式重新观察和改绑；取消或源码修正后用有关系的新 attempt／operation 继续。不能靠重复 unknown 的变更“跑通”，也不能因一份诊断字段不匹配使所有只读与恢复入口不可用。

## 前轮冻结候选核验与本轮复核方式

| 检查 | 结果与证据 |
|---|---|
| 全量功能 | 1668 项通过，零失败／跳过；包括最终 Flutter 覆盖反例。见上文最终日志。 |
| 性能预算回归 | 50 项通过，22.038 秒。覆盖 Script／Intent 调度与预算，不将这些受控测试当 App 整段速度。[日志](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/final-worktree-performance.log) |
| 真安装包 | 实际 npm pack 后独立目录安装，禁用编译器和 Python，预编译 FactStore 加载；CLI／MCP、JS Script、原动作回执、断开重连、恢复与 shutdown 核验通过。125 个命令发现；受控 ADB，不冒充设备验收。[报告](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/final-package/report.json) |
| Flutter 原问题 | 原 CLI exit 1／execution.ok=null；最终候选 exit 0／execution.ok=true，原 responseRef 重读确认 provider 不合成 partial，原 operable 5 节点和 coverage 可读。自动 overview 的 partial 描述交付范围，仍正确保留。[最终设备证据](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/flutter-real-fix-5/summary.json) |
| 对候选的独立 Review | H5 复用／服务资源修复未发现新增实质问题；Flutter partial 误导被识别，最小公开回包测试先失败后通过。[原反例](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/flutter-layout-coverage-red.tap)、[最终 6 项](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/host/flutter-layout-final.tap) |
| 测试服务 | 缺资源只使该请求失败、进程继续可用；6 项测试通过。原资源故障与修正都保留于平台记录。 |

安装包核验首次调用缺少要求的证据目录参数，只输出用法而未执行安装；传入新目录后完整通过。Flutter 最终复核第一版误把 auto overview 的 partial 当 provider 字段，断言失败；已改为对同一 responseRef 读取原结果核验，原失败未删除。这些是验收程序问题，不算产品退化或性能样本。

复核可运行 `npm run test:functional`、`npm run test:performance`（CLI 目录），以及 `node --test examples/workflow-lab/server.test.mjs`（仓库根目录）。真实 App／SDK 原型需按各实验计划固定版本、源码、设备与后端再跑，不能仅重新跑单元测试代替。安装包核验为 `npm run verify:package -- /absolute/path/to/new-evidence-directory`，使用全新目录，避免覆盖已保存证据。

## 可追溯来源与本文限制

本文汇总 [总台账](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/coverage-ledger.json)、[caller 实验报告](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/caller/README.md)、[平台报告](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/platform/platform-evaluation.md)、[恢复报告](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/full-evaluation/recovery/REPORT.md)、Host 单因素与 corrected-author 结果；综合表不重复计数原始实验。表格中的采纳均是方案决策，实际候选代码与发布状态以上文清单及最终 git diff 为准。

外部项目只能提供设计线索，不能代替本项目实验。前一轮外部源码核查还发现，原建议“Playwright MCP 当前默认增量”的前提未被所检源码支持；Stagehand 页面也不足以证明其隐式自愈承诺。短引用、事件唤醒、配方缓存等机制按本表的本地反例与净收益判断，而不是以同类产品名气直接采纳。[第一轮来源审核](/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/proposal-review-2026-10-13/first-round-review-archived.md)。

Flutter 顶层结果误报已在隔离候选修正；相邻 Script coverage 和 iOS 源错误覆盖问题仍是明确待办。美团／抖音和大型测试 App 结果由外部分工单列；后续产品化扩大结论时须引用其实际证据，不能提前写成已通过。
