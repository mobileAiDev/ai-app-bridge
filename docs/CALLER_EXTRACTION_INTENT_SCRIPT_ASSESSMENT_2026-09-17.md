# 调用者自定义响应提取与 Intent / Script 评估

日期：2026-09-17。状态：方案评估；没有修改 Bridge 实现。

> 后续决策见 [2026-09-18 改善版本整体方案](/Users/macbook/Documents/CompanyProject/ai-app-bridge/docs/IMPROVEMENT_RELEASE_V1_2026-09-18.md)。其中公共 `extract` 已改为必填、允许显式 `null`，并配套输出预算、响应原样保存与回看、明确的合同迁移；本文“可选参数、缺省兼容”的建议已被取代。以下保留当时的源码判断与测试记录。

## 决策方向

调用者提供提取逻辑，Bridge 在 Host 执行并返回结果。支持正则与 JavaScript / Python 脚本；字段选择、数组过滤、聚合、格式转换由调用者决定。现有语义摘要可以继续作为显式可选能力，不能成为所有响应的强制处理方式。

这次 POS 会员联调的本机 Python 已证明这种使用方式有价值。值得内置的是“执行调用者的响应处理代码、控制运行生命周期、保留执行事实与引用”，而不是把这次脚本的字段白名单和去重规则固化到 Bridge。

## 当前事实

本轮核对源码分支 `codex/script-intent-isolated-rebuild`，HEAD `0005c1a`，源码和安装的 CLI 都是 0.3.8。下述六个文件与安装包内容的 SHA-256 一致：CLI 入口、MCP 入口、summary-transformer、intent-observer、script-host-port、SCRIPT_AUTHORING 文档。当前 MCP capabilities 能发现 Intent / Script；没有发现能力不可用这一阻碍。

| 能力 | 当前实现 | 与本次提案的关系 |
| --- | --- | --- |
| 普通 tree / network | 有 compact、查询过滤、数量和正文长度限制 | 已有特定命令裁剪；尚不是调用者自定义的通用响应提取 |
| Intent | 保存原始观察，再生成语义摘要；决定绑定 revision | 适合交互探索；提取应作为返回视图，保留内部完整观察及决策绑定 |
| Script | JS / Python、ctx.call、progress、askAgent、自定义返回值 | 今天已可在脚本内读取响应、用任意代码提取、返回小结果 |
| 普通 CLI / MCP 输出 | 序列化执行结果；CLI 使用 value，Script 的调用数据使用 result | 尚无跨入口的调用者提取配置 |
| 证据 | 普通命令有辅助历史；Intent / Script 有保存与导出机制 | 应复用；历史保存状态与原动作结果独立，不能假定每次都保留了完整原始数据 |

源码入口：

- [普通命令参数](../desktop/ai-app-bridge-cli/bin/command-registry.js)
- [普通 tree 的 compact 实现](../desktop/ai-app-bridge-cli/bin/device-provider.js)
- [现有语义摘要](../desktop/ai-app-bridge-cli/bin/shared-kernel/summary-transformer.js)
- [Intent 观察与保存](../desktop/ai-app-bridge-cli/bin/intent/intent-observer.js)
- [Script 调用与 page-summary](../desktop/ai-app-bridge-cli/bin/script/script-host-port.js)
- [Script 编写合同](../desktop/ai-app-bridge-cli/docs/SCRIPT_AUTHORING.md)
- [普通命令历史](../desktop/ai-app-bridge-cli/bin/fact-recorder.js)
- [MCP 输出](../desktop/ai-app-bridge-cli/bin/mcp-server.js)、[CLI 输出](../desktop/ai-app-bridge-cli/bin/ai-app-bridge.js)

## 本次实测与限制

从已经保存的 POS UI 响应离线重放原 Python 展示逻辑，按 UTF-8 minified JSON 比较：

| 样本 | Bridge compact 响应字节 | Python 展示摘要字节 | 减少 |
| --- | ---: | ---: | ---: |
| 快速创建弹窗、部分手机号 | 176465 | 12646 | 92.8% |
| 恢复后的收银界面 | 158770 | 9674 | 93.9% |

这是两个样本的输出体积比较，不是 token 精确计数、端到端提速或正式新功能基准。原脚本基于文字/可点击条件选节点，投影 resourceName、text、enabled、selected、className，并按投影去重；相同投影可能对应不同控件。它没有保留所有状态和定位信息，不能直接升格为默认公共算法。普通 Native compact 节点本身也没有保留 checked；后置提取无法恢复上游已丢弃字段。

准确地说，POS 临时脚本另存的是 Bridge 返回的整个 compact 响应，不是设备未经裁剪的完整树。未来须分别描述采集阶段的范围/截断和展示阶段的提取，不能用“原始已保存”掩盖前置丢失。

本轮另外执行：

- 11 项现有摘要相关本机测试通过：summary-native-foreground、summary-ios-controls、p8-page-summary-bench。
- 通过当前 MCP 启动 Python Script `script-1789634328090-17`，用离线样例调用 page-summary，自行提取字段，随后通过 result 读回 416 字节持久化结果。样例保留了空输入框、checked=true 和 disabled 按钮。
- 该 Script 只有一个纯 Host 转换调用，没有设备调用、没有业务断言。这只验证现有 Script 路径可用。
- 按调用者自定义提取方向，又运行 Python Script `script-1789634688754-23`：直接从 `ctx.inputs.response` 接收合成 JSON，自行按 checked 筛选节点并用 `re.findall` 提取日志中的 code；读回 `selectedIds=["female"]`、`codes=["1000","0"]`，persisted=true。该运行没有 page-summary 或任何 ctx.call，证明现有 Script 可直接承载任意调用者代码；不代表提议的通用 extract 参数已实现。

## 推荐的 Interface

在现有命令调用上增加可选 `extract`，没有该配置时保持现有行为。调用者指定算法；Bridge 不自行判断哪些业务字段重要。

以下是建议语义，不是已经可调用的参数合同：

| 模式 | 输入与输出 | 适用情况 |
| --- | --- | --- |
| script | 当前响应作为明确命名的输入；JS / Python 返回 JSON | UI 节点选取、正则组合、分组、统计、复杂结构转换 |
| regex | 调用者明确选定的字符串，pattern / flags；返回匹配及捕获组列表 | 日志文本或正文中提取编号、错误等 |

Script 模式建议复用现有 main(ctx)、language、source/sourcePath 语义，约定从 `ctx.inputs.response` 读取该次响应，避免再设计脚本语言。source 与 sourcePath 二选一，启动前冻结源码。字符串正则可以复用同一受控执行基础设施，并固定其正则引擎语义。

输入合同必须明确：普通命令是 Host 已得到的该次结果对象，不包含 CLI 的传输包装；异步 Script 的 start 返回的是操作状态，最终值的提取应作用于 result。Intent 提取的是对外观察/状态视图，Host 原有的 revision、原始观察和动作校验保持有效。不能让同一个 response 名字在不同 operation 下暗中代表未来的最终结果。

需要时调用者选择未经 compact 的读取；Bridge 不能把 compact 结果自动当成完整树。提取脚本看到哪个版本，就应明示哪个版本。

第一阶段不增加字段选择 DSL 或多级 pipeline。JavaScript / Python 自带 filter、map、正则、排序和聚合，已经覆盖复杂需求。正则是常见任务的便捷表达；以后再根据重复出现的需求增加直接字段选择。

## 执行位置与职责

```text
命令执行 → 原执行结果与已有证据记录 → 调用者提取代码 → CLI / MCP 返回
                     └────────── 原响应引用（确实保留时）
```

在 Host 的执行结果与对外序列化之间放置一个 ResponseExtractor Module，由 CLI、MCP 和需要此能力的 Script 调用共同使用。其 Interface 接受输入、提取配置、预算，返回提取结果与处理状态。执行命令、执行提取、保存证据分别报告结果。

复用现有 Script 的 Node / Python 子进程与协议基础设施，不在长期运行的 Host 主线程直接 eval 或运行不受限正则。对提取只提供输入与结果能力；不为它开放 Bridge 设备调用。现有运行方式仍然属于 trusted-local-code：不给 ctx.call 不等于操作系统沙箱，这一点应与现有 Script 合同一致。

普通 Script 已经可以自行提取每个 ctx.call 的 result，默认无需改变。若以后为 ctx.call 加提取选项，也必须先保留原始回执和用于断言的观察；派生结果不能冒充新的设备事实。

通用提取与 POS 的业务探针分开：解析 MMKV、取得会话、会员接口、SIT 网络路径都属于项目脚本。把这些 Python 文件搬进 Script 运行，并不会自动让原始 ADB / subprocess 请求成为受 ctx.call 管理的操作或证据。

## 必须确定的行为

1. **执行事实独立返回。** 调用者可任意提取 payload，但原命令的错误、派发/未知结果、目标、operationId/revision、证据覆盖等协议控制信息保留在外层；仅保留该命令实际提供的字段，不编造默认状态。任意提取内容不能把失败或 ambiguous 改写成成功。
2. **提取失败不重跑动作。** 返回原执行状态和单独的提取错误。语法、语言可用性、配置可在派发前验证；处理代码运行中仍可能失败。修正规则后针对已保留响应重新提取，不重新点击或提交。请求去重身份与提取规则应分别处理。
3. **空结果与错误不同。** 正则未匹配返回空列表；字段缺失/类型不符按明示合同报错。非法正则、执行超时、解释器缺失、非 JSON 返回值、超出输出预算有独立错误，不自动切语言或返回另一种格式。
4. **预算覆盖真正的计算。** 限制输入/输出字节、运行时间与进程资源；正则死循环式回溯不能占住 Host 事件循环。超时结束提取工作，不改变已经发生的动作。
5. **存储状态真实。** 复用现有证据与 recording；只有确实保存的数据才给可用引用。说明保存的实际内容、保存失败与引用过期。不要另建一套长期无界的响应仓库。
6. **提取结果仍由调用者解释。** 若调用者只返回两行文字，就由调用者承担信息遗漏；Bridge 保证提取过程与执行事实，不替调用者保证业务判断完整。需要再次操作 UI 时，仍执行唯一定位和身份/时效校验。
7. **协议状态不被自定义函数改写。** 输入为独立副本，返回值只进入提取数据区。Intent 的 operationId / revision 保留在外层，不依赖用户脚本恰好返回它们。

## 为什么这次少用 Intent / Script

这次最初在对照新界面、旧接口与实际 SIT 数据，本机 Python 把单步命令、独立 HTTP 核验、打印与文件存储直接接起来，起步方便。后续流程稳定后继续沿用这个包装，是执行方式上的选择；当前能力核对没有证明 Intent / Script 因能力缺失而无法使用。

已有能力可以更充分地用：

- **未知流程/需要逐步判断：Intent。** 观察带 revision，Agent 决定下一步。默认 supervised 的 goal 不会独立代替 Agent 完成推理；autonomous 需要 agentModule。
- **固定流程/重复回归：Script。** 通过 ctx.call 操作，在脚本里提取、断言、返回小结果。它支持条件、循环以及 askAgent，并非只能播放线性命令。
- **一次观察/单步诊断：普通命令 + 可选 extract。** 不必为一次字段提取启动一套手写 subprocess 包装。

产品上的摩擦是真实存在的：Script 要编写源码并处理 start → wait/status → result；Intent 要管理 operationId、revision 和 decision。其生命周期有价值，但短任务示例、可发现性和共用响应处理还可改善。不能凭这次偏好推出它们无用，也没有证据证明它们比单次命令更慢。

## 落地顺序与验收

1. 先提供一份使用现有 Script 完成“调用 → 用户代码提取 → 返回”的最小 JS/Python 示例，验证调用者要的表达能力；这一步不依赖新增通用参数。
2. 实现共享 extract 合同与 Module，接普通 CLI/MCP；支持 script 和 regex。现有摘要继续作为可选工具。统一错误与原响应引用，不改变旧调用默认形状。
3. 将提取接入 Intent 的对外观察以及 Script 最终结果读取；记录明确的输入表示。Script 内部 ctx.call 的自动提取可按真实大响应/IPC需求再加。
4. 用同一份输入验证 CLI/MCP/JS/Python 提取语义，再以会员创建、已存在登录、取消保持状态等稳定流程做真实设备对照。本次评估没有重跑设备或业务接口。

验收至少覆盖：调用者可选择任意原有字段、重复控件不被内置去重、空输入/选中状态由提取规则决定、正则多匹配和零匹配、源码语法/运行错误、超时/大输出、目标与 revision 保留、提取错误后已提交动作不重放、引用过期/保存失败、旧客户端没有 extract 时保持兼容。

价值对照记录输出字节/token、作者编写时间、调用次数、Host 处理时间、设备调用次数和业务结果。输出变小不能自动推导采集更快；提取运行在 Host 时，设备到 Host 的原始采集成本可能仍然存在。
