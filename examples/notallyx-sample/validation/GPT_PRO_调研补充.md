# AI App Bridge 后续路线：给 GPT Pro 的本轮事实补充

请把本文件与 2026-09-06 的原调研任务一起阅读。它更新本地实现与实验进展，不替代原任务对产品价值、架构取舍和公开同类方案的独立研究要求。

**材料日期：2026-09-07；最终冻结口径：R5/R6/R7 相同核心套件三轮通过，分别为 73.535/75.159/83.762 秒；完整 App 仍未验收。** 本文编写时未做新增外部调研。以下“已完成”来自本地源码、测试和留档实验；公开项目链接只是供你核查的一手入口。不要把这些本地改动当成已经公开发布的能力。文末记录实际冻结版本与结果，旧失败继续保留。

## 1. 我们现在真正想做的工作流

日常由 Agent 使用 **Intent** 观察和操作真实 App，做开发联调、探索及测试，积累实际观察、决策、动作回执、失败和业务结果。Agent 从这些记录中识别可重复的业务场景，**编写并冻结 Script**。随后 Script 执行固定回归，采集新证据，由独立业务 oracle 判断本轮结果。

`日常 Intent → 实际来源证据 → Agent 编写/调试 Script → 冻结场景与前置数据 → 运行 Script → 新证据与独立判定`

Intent 和 Script 继续保持独立运行时，共用必要的设备能力与证据合同。当前不先建设自动 Intent→Script 编译器，不要求把探索轨迹机械翻译成脚本。请研究哪些来源整理、场景参数化和维护成本值得优先解决，以及达到什么实测条件后才值得自动生成场景骨架。若认为现有 Script 应由成熟执行器承担，请给出具体能力映射和迁移代价，而非仅按“自研/现成”分类。

产品仍服务开发、调试和验收。debug SDK 可以提供应用内部证据；无 SDK 的 UIA/ADB/WDA 路径不能被当成拥有同样内部证据。整机回归是多个 App 与系统、权限、后台、跨 App、外设流程的进一步组合，尚未被本次单 App 样例证明。

## 2. 相比原材料新增的本地事实

| 层级 | 新事实 | 结论边界 |
| --- | --- | --- |
| 真实业务 App | 采用 [Crustack/NotallyX 固定源码](https://github.com/Crustack/NotallyX/tree/03ff809f058dbcabd5f0d20f114546686dfc9cb5)，commit `03ff809f058dbcabd5f0d20f114546686dfc9cb5`，上游版本 7.11.2、GPL-3.0。隔离样例包为 `io.github.mobileaidev.notallyx.sample`，设备为 `b46093e6`。 | 是有笔记、任务、标签、附件、提醒、备份、存储及锁等业务的真实开源 App；本地样例不是上游发行版。 |
| 架构迁移 | 18 个外部 DB/DAO 消费者迁入 `NoteApplicationService`；`DatabaseSession`、`StorageMaintenance`、`StorageOperationGate` 协调句柄、维护、事务与提交后动作。保留 Room schema 11 和原业务数据格式。 | 改的是贯穿业务入口的数据依赖与复合操作边界，没有更换数据库引擎，也没有把全 App 改成 Android 无关领域层。 |
| App 测试 | 194/194 通过，包括 178 个原测试与 16 个新增测试。 | 源码/JVM/Robolectric 证明；不能代替全部设备业务验证。 |
| Android Bridge SDK 测试 | 113/113 通过。 | SDK 的本轮测试范围，不代表 Android/iOS/Flutter/Web 全平台全部验收。 |
| Host 测试 | CLI `npm run check -- --test-concurrency=1`：615/615 通过，无失败或跳过，56.131 秒。 | 串行运行以减少 CPU 争用对已有绝对耗时阈值的干扰，未放宽阈值；之前的失败日志保留。 |
| 原数据升级 | 覆盖安装前后的 4 条业务记录、标签、偏好及文件 canonical 比较为零差异。迁移后的 App 已继续完成实际业务操作。 | 证明这一批真实数据与升级路径；不证明所有历史版本、备份恢复、加密切换或断电恢复都正确。 |
| 日常 Intent | 已实际操作文本创建/保存重开/编辑、标签/颜色/置顶、任务父子层级、复制独立修改、搜索与空结果、归档及回收站恢复、只读切换等子流程，并留有相应数据库或页面证据。 | 子流程验证与完整功能模板通过分开计数；失败、inconclusive 记录不会变成成功来源。 |
| R3 固定核心 Script | 一次成功回归为 **32.258 秒**；完整通过 2 个文字场景模板，另覆盖 3 个组织模板的部分子流程；11 个页面检查点有本轮新证据。 | 是局部核心套件的单次成功观测，不是全 App 耗时，不是重复运行稳定性结论。全功能报告仍未通过。 |
| R4 扩展 Script | 增加清单流程后，原始运行在 `postcondition_timeout:list-checked-editor` 失败；原因是已勾选项变只读，脚本仍要求可编辑。R5 已按真实分组与属性修复并通过，见文末三轮结果。 | R4 保持失败，后续未执行项不追溯改写。修复后的前后树及独立数据库均继续强校验；错误属性和分组负例会被拒绝。 |

完整业务清单保留 **51 个功能、143 组场景模板、396 个展开覆盖槽**，包含 normal、negative、restart 分层及需要环境或人工的项目。这是静态清单与计划分母，不能读成已经执行了 396 项，也不能把 615 项 Host 测试加入业务分母。

本轮候选 APK SHA-256 为 `8252b6c0a4d36ce1a38c4056ba2bb5becfa63ca18803e7dde42de3116cb80836`；最终重复实验应以每轮报告实际冻结的 APK、脚本和清单 hash 为准。

## 3. 真实链条暴露出的机制问题

- **界面有字不等于业务已保存。** SDK 直接对自定义输入框 `setText` 曾绕过业务监听器；修为 IME 输入连接后，中文、多行、特殊字符才完成保存重开与独立 DB 读取闭环。
- **快执行会暴露等待条件不充分。** IME 布局变化会移动弹窗；已增加连续新观察下的位置与状态稳定条件。重复正文可能存在于不同笔记，标题、正文、标签必须绑定同一张卡片。
- **断言和证据不能由脚本单方自证。** 独立 Host oracle 核对实际发行的 observation、调用历史、目标、时间窗口、图片字节 hash，再重新计算业务条件；不把 Script 的 `passed/completed` 当业务结果。截图前后树用于稳定状态核对，仍不是原子 UI 快照。
- **落盘后的字节必须与 checksum 对应。** 冷启动 unavailable capture 的 `window: undefined`，以及回执的 `resolved/matched: undefined`，曾在 hash 之后被持久化层变成 `null`。现统一先冻结 JSON 表示、按既有规则脱敏，再算 hash。旧坏记录不回写；6 个真实失败记录重放通过。新真机运行 `intent-1788746713101-1` 的 59 条记录，包括 17 次观察和 8 份动作回执，读取及 close/reopen 校验均通过。
- **历史来源的文件 SHA 与内部回执有效性不同。** 可搬迁来源 bundle 保留真实原字节、Intent ID、路径映射、状态和 DB 依赖；这只能证明来源未被改动。部分早期内部回执的 checksum 状态仍明确未验证或失配，不能因为外层文件 SHA 正确就变成可信动作证明。
- **业务模型决定 oracle。** NotallyX 的持久清单项只有 `body/checked/isChild/order/checkedTimestamp` 等真实字段，没有 durable item ID。验证应比较完整有序字段序列、重复项数量及父子组，不能要求一个源码根本没保存的 ID。见 [固定版本 ListItem](https://github.com/Crustack/NotallyX/blob/03ff809f058dbcabd5f0d20f114546686dfc9cb5/app/src/main/java/com/philkes/notallyx/data/model/ListItem.kt) 与 [Room 转换器](https://github.com/Crustack/NotallyX/blob/03ff809f058dbcabd5f0d20f114546686dfc9cb5/app/src/main/java/com/philkes/notallyx/data/model/Converters.kt)。

这些发现支持继续验证“日常证据建设可维护回归”的价值，但尚不能证明自有 runtime 或存储是实现该价值的唯一、最经济方案。

## 4. 请重点研究并回答的问题

**同类机制与可复用部分。** 从官方文档、原仓库、测试或论文区分：逐步 Agent 操作、录制/代码生成、条件等待、确定性回放、运行轨迹、失败重试、checkpoint 恢复、业务判定。候选一手入口包括 [Appium](https://github.com/appium/appium)、[Maestro](https://github.com/mobile-dev-inc/maestro)、[Playwright](https://github.com/microsoft/playwright)、[AndroidX Test](https://github.com/android/android-test)、[Detox](https://github.com/wix/Detox)。请核查实际版本与可用范围；这些链接不是我们已经完成的功能比较。尤其说明哪些机制能直接承担当前需求，哪些仍需 Bridge 提供应用内部证据或生命周期控制。

**如何把日常证据变成可维护的回归资产。** 一个场景最少需要哪些来源字段、业务前置状态、实际选择器、条件等待、期望值与失败记录？如何从多次 Intent 轨迹提取稳定业务意图，避免复制偶然坐标、时间、排序和脏数据？怎样发现来源过期、选择器漂移、重复场景，以及某次 Agent“修测试”只是迁就错误实际行为？请提出可人工审查、可版本化的最小场景合同与维护闭环，并明确哪些环节先由 Agent 编写，哪些值得自动化。

**独立断言与测试数据隔离。** 如何使 oracle 在来源、期望和执行上独立于生成脚本的 Agent？哪些 UI/文件/DB/服务端/系统状态足以支持哪类业务结论？如何防止旧截图、新树、另一张卡片或另一条业务记录被拼成假成功？应该怎样做故意错误预期、缺证据、串证和数据损坏负例？请同时设计唯一 runId、固定种子数据、重置/恢复、时间与账号隔离、共享附件/后台任务清理，以及 fixture 恢复自身失败时的停止条件。

**适用边界及失败语义。** 何时使用 Intent，何时固化 Script，何时普通 JS/batch 或成熟测试框架已经足够？SDK 内部证据能增加哪些可验证性，UIA/ADB/WDA 能覆盖哪些外部路径，如何避免把机械动作回执伪装成端侧因果关联？如何处理未确认副作用、取消与重启，而不重放可能已经发生的动作？请分开讨论单 App、跨 App、系统设置/权限、后台、外设、无源码 App，以及加密/备份/断电等需要专门环境的长流程。

**5～10 分钟究竟覆盖什么。** 先冻结功能、正常/异常/重启分支、数据规模和设备条件，再估计套件成本。给出核心必测、扩展回归、环境专项的可解释分层，始终保留全分母和未运行项。网络、渲染、后台与硬件耗时不可凭模型变快而消失；不要用 R3 的小套件线性外推完整 App。若全分母不可能在目标时间内完成，请指出瓶颈和合理的分批/选择策略，不要静默删掉困难场景。

**如何设计可推翻路线的重复实验。** 请给出预注册的比较条件、重复次数依据、冷/热启动与轮次交错策略，以及全部尝试、失败、重试、成功率、耗时分布和维护成本的报告格式。模型耗时和 token 成本只采用实际采集记录；没有记录就保留未知。需要分辨产品缺陷、脚本错误、oracle 错误、fixture 错误和基础设施失败，但不能将后四类从总体开发成本中删除。

## 5. 实验比较与计时必须遵守的口径

这是两个独立问题：

1. **基线 APK vs 架构迁移 APK**：同数据、同 Script、同业务预期，检验业务保持与回归差异。这不是 Intent 与 Script 的对照，不能据此写“Script 加速了多少倍”。
2. **Intent 逐步操作 vs batch/普通 JS/Script 等执行方式**：需要另外固定同一 App 构建、provider、设备、前置状态、动作、等待、证据和 oracle，才可以比较交互和执行开销。现有 NotallyX 迁移结果尚未给出这组公平对照。

R3 的 32.258 秒包含 APK 核对、页面操作与等待、截图/树、强停重开、数据库采集和独立判定。最终 report JSON/HTML 写盘位于该计时结束之后。124 ms 的 construction 仅是冻结输入，不是 Intent 探索、写脚本和调试总成本；没有估算模型成本。后续请分别报告建设/调试、构建安装、fixture 准备、回归采证判定、报告收尾，并给清楚的总 wall-clock 边界。

## 6. 给你的资料入口与交付要求

官方一手入口：[AI App Bridge 原仓库](https://github.com/mobileAiDev/ai-app-bridge)、[原调研所用历史基线 fc576dc](https://github.com/mobileAiDev/ai-app-bridge/tree/fc576dc738565856d8d2a971d284e74d8f0b4772)、[NotallyX 原仓库](https://github.com/Crustack/NotallyX)及上文固定 commit。请单独核对调研时最新公开版本，不把本地 dirty 工作树、固定历史基线和公开发行版本混为一谈。

以下路径均相对 AI App Bridge 仓库根；网页版 GPT Pro 无法直接访问本机路径，需要将相关文件作为附件提供。缺少附件时请明确列出无法核实的结论，不假装已读取：

| 本地资料 | 用途 |
| --- | --- |
| `.tools/research-brief-2026-09-06/调研任务-增强版.md`、`本地事实与实现摘录.md`及原 ZIP | 原始完整问题与 2026-09-06 冻结背景；保留原件，本文件是后续补充。 |
| `examples/notallyx-sample/README.md`、`validation/application-migration.md`、`validation/application-review.md` | 上游归属、迁移范围、18 个消费者、事务/维护合同、源码与 JVM 审查边界。 |
| `validation/INTENT_TO_SCRIPT.md`、`validation/路线评估.md`、`validation/测试进度.md` | 当前主工作流、路线判断及证据成熟度。这里的 `validation/` 均位于 NotallyX sample 内。 |
| `validation/feature-inventory.json`、`scenarios.json`、`core-baseline-plan.json` | 51/143/396 分母、分层、源码入口及 oracle 要求。 |
| `validation/evidence-source-index.json`、`source-evidence/`、`source-provenance.js` | 真实 Intent 来源、状态、可搬迁原始证据及完整性验证；不等同于新回归验收。 |
| `validation/regression-script.js`、`run-regression.js`、`ui-oracles.js`、`oracles.js`、`collector.js`、`report.js` | 实际脚本、控制器、独立判定和计时实现。比较时优先对应运行目录中的 `frozen/`。 |
| `build/ai_app_bridge_artifacts/notallyx-migration/` | `upgrade/`、各 `intent-exploration/`、`migrated/*-snapshot/`及 R1～R7 原始运行（R6 为 `script-baseline-r6`）；只附相关报告与必要证据，不要求搬运无关 Host FactStore 全目录。 |
| `.tools/business-app-migration-2026-09-07/` | App/SDK/Host 测试日志，`host-suite-final-summary.json`、checksum 故障分析、候选 manifest、fixture 控制器事故记录。保留失败与恢复经过，不能仅附最终绿灯。 |

请最终交付：一个明确主线建议；能力/替代方案对照及一手引用；从真实来源到可维护场景的最小合同；独立 oracle 与 fixture 设计；冻结覆盖和重复测量方案；按必要性排序的两周验证任务、停止条件及会推翻推荐的证据。区分“本地已经证明”“外部资料支持”“尚待实验”，并说明哪些结论现在能决定，哪些还不能。

## 7. 最终补录：R5/R6/R7

三轮初始数据为同一 fixture `d90baa03-191e-43d6-8d47-82a378f5b0e6` 的 8 条笔记；每轮 before snapshot 的 canonical 比较零差异。相同 Script SHA `a45dff972a12e0281cc392f69595de7a781ba6f91e048e8901835d8cfe542006`，相同 Host manifest SHA `445aba4b2ffa5dbcf052ebdb37b523639effcceff7893ca9476a83b31d771600`，相同功能与场景清单。每轮 27 个 UI 检查点、8 份数据库快照，独立重算均通过；初始笔记全部保留。原架构 APK 为较早 IME 修复版 SDK，迁移 APK 另含输入保护；因此本组是业务对照和实际耗时证据，不能推断独立架构/SDK 性能收益。

| 轮次 | App/脚本/场景 hash 与起始数据 | 完整/部分/未运行分母 | 业务 oracle 与故意错误预期负例 | wall-clock、尝试及失败 | 原始报告 |
| --- | --- | --- | --- | --- | --- |
| R5 | 迁移 APK `8252b6c0…`；上列相同脚本与 8 条初始数据 | 4 passed、3 partial、136 not_run / 143 模板；完整分母 396 槽 | 27 UI + 8 DB 通过；40 项离线测试和真实只读/分组/证据负例通过 | 73.535 秒，完整套件一次成功；R1/R2/R4 原失败保留 | `script-migrated-r5/report/report.json` |
| R6 | 原架构 APK `4e412235…`；同上 | 同上；fullApp=false | 27 UI + 8 DB 通过 | 75.159 秒，一次成功 | `script-baseline-r6/report/report.json` |
| R7 | 迁移 APK `8252b6c0…`；同上 | 同上；fullApp=false | 27 UI + 8 DB 通过 | 83.762 秒，一次成功 | `script-migrated-r7/report/report.json` |

表内报告路径相对 `build/ai_app_bridge_artifacts/notallyx-migration/`。机器汇总 `comparison/summary.json` 包含完整 hash、前置状态比较与数据库重读结果；中文说明为 `validation/固定回归结果.md`。R5 另独立核验 436 artifact SHA、138 份持久 envelope 的读取和重开 checksum；81 份 UI 观察按 payload SHA 与 Host 发行记录另计。

这三次是两次迁移版和一次原架构的短轮验证，不是长期成功率估计；也没有实际测量 Agent/model 延迟，不能计算 Intent vs Script 加速倍数。安装和 fixture 准备在计时之外，执行、等待、采证及独立判定在计时之内。

若后续改了错误预期、等待逻辑或 fixture，请标明变更原因和新冻结 hash；旧 R4 仍保持原始失败，不追溯改写。
