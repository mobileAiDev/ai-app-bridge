# AI App Bridge 改善版本 V1：整体实施与验收方案

> 本文保留冻结时的方案与基线。当前实施、终审及待放行项见 [M4 验收记录](IMPROVEMENT_RELEASE_V1_M4_2026-09-19.md)。

更新：2026-09-19。版本：第 6 版（M0 确认后的实施基线）。第 5 版外部复核及代表样例已复查，必要字段和引导修正见第 10.2 节；M0 轻量接口确认完成，可以按工作包开始实施。真实 tools/list、完整响应族、持久化和最大输入性能随 M2 正式实现验证，发布前确认限额。新版本尚未实现或验收。文件名保持不变，历史评估链接继续有效。

这次改善一起解决输出过大、使用方式不稳定、错误难修正、证据容易误判、升级入口不一致和安装门槛问题。`extract` 有必要，但必须与预算、可信回看、使用范例及验收一起交付。

工程以功能正确、信息完整、使用效率和接入成本为优先。数据筛选由查询参数与调用者的 extract 明确指定，公共返回与存储以内容保真为默认；不主动增加隐私处理层或相关产品配置、专项验收。

本文管理范围、优先级、职责和放行；参数、字段、快照与限额统一见 [公共返回合同](IMPROVEMENT_RELEASE_V1_CONTRACT.md)。两份文档不重复维护同一套 schema。事实依据为 0.3.8 / `0005c1a` 源码、历史使用记录和注明方法的离线探测；历史测试通过不代表改善版已通过。

## 1. 目标、职责和交付边界

首版必须交付：可控的公共返回、可运行的三类范例、可定位的 Script 诊断、同步的合同/发布入口、执行器准备前检查，以及可复核的测试报告。新加入“最简 MCP 接入”：用户能直接配置 MCP，无须先学 CLI、手工配置 FactStore 或编译原生依赖。

| 角色 | 负责 | 交付与边界 |
| --- | --- | --- |
| Codex | 整体方案、合同决策、独立审核验收 | 明确工作包和验收；按源码、包和实际运行证据复核；审核发现回给实施者修复 |
| Fable 5.1 | 可行性复核、实现、测试及修复 | 先举证复核 M0，再按工作包提交；提供改动清单、测试和可复现证据，不以自测替代独立验收 |
| 用户 | 业务范围与对外发布决策 | 决定是否对外发布 0.3.9，以及最终发布；普通实施选择按已冻结合同推进 |

本轮交付是方案，不修改生产代码或执行对外发布。后续实现以工作包为提交边界，不同时让两个 AI 改同一个公共返回模块。方案作者审核自己的设计仍可能有盲点，Fable 的可行性复核必须包含反例；最终审核必须独立读代码并复测关键失败路径。

首版不包含：新的动作命令体系、字段 DSL、多级提取 pipeline、OCR/媒体内容提取、常驻提取进程池、完整 OS 沙箱。独立 Android 测试模块和免 Node 发行包留作后续候选，不阻塞本版，也不作为现有能力宣传。

## 2. 实际困难与版本任务

| 编号 | 证据与准确判断 | 必要性 | 改善与归属 |
| --- | --- | --- | --- |
| R1 | 两份 POS compact 响应按原脚本选取字段后，从 176465/158770 字节变为 12646/9674，约减 93%；只证明输出可减，不证明采集提速，也不证明全部业务信息保留。[S1] | 高 | 公共 extract、最终预算、快照与重读；M2/M4 |
| R2 | Cursor 长会话实际启动 Script 28 次（JS 18、Python 10），后续仍退回零散操作，直到用户提醒。[S2] | 高 | 探索/回归/单次查询三类可运行范例，封装 wait/result/断言；M1/M4 |
| R3 | 7 次 run.command=capabilities、4 次 waitMs=90000；约束多藏在二级 schema。当前公共 wait 验证已给出 `waitMs must be <= 60000.`，不足在入口/修正例和各错误路径一致性，不是所有错误都无 message。[S2、S3、S5] | 高 | 精确字段、允许范围、最小合法调用；不自动改写错误命令；M1 |
| R4 | 当前 TEST_PLAN 的 smoke、接入文档版本与部分 NotallyX target.platform 夹具漂移。[S4] | 很高，先修 | 公开入口与夹具合同校验、打包后范例；历史发布记录保留原版本；M1/M4 |
| R5 | 子进程 stderr 被丢弃，JS/Python 主要只传 message，Python 排错反复调整。[S5] | 高 | 有界 stderr、类型、源码位置与 stack；复用现有诊断路径，不新增完整日志归档/引用系统；M3 |
| R6 | 付款码测试混拼播放器、使用旧播放残留，停音采样晚于自然结束；Script 完成被过度解读。[S6] | 很高 | 来源/时序/业务断言模板与反例回归；M4，消费业务另行验收 |
| R7 | POS compileSdk 33 与所选 UI Automator 依赖要求冲突，测试中临时改业务编译 SDK。[S7] | 高 | 准备前列实际配置、依赖要求与影响范围；独立测试模块仅作候选；M3 |
| R8 | 全局 CLI 更新不代表旧 MCP 已刷新；消费依赖首轮交付遗漏过。已有代码指纹检测，但客户端首次调用才取指纹可能掩盖旧内存代码，错误建议也不分哪侧旧。[S8、S14] | 高 | 客户端启动时固定身份、两侧版本/指纹/环境诊断、发布入口清单；M3/M4 |
| R9 | UI 观察开销已有默认关闭与限时修复；前台解析、旧设备命令兼容也有历史修复。[S9] | 保留回归 | 不重新列为未修缺陷；新处理不得延长动作锁或引入常驻扫描，补 compact 已知状态保真；M4 |
| R10 | 真实深树紧凑 JSON 为 289965 字节，缩进后 1143164；缩进空白约占后者 72%。[S12] | 很高，先做 | CLI/MCP 公共 JSON 去缩进，0.3.9 保留旧结构；M1 |
| R11 | capabilities includeOptions:true 为 424057 字节，intent 为 116249；窄 decide 为 51605，进一步限定为 5493。android 是 platform，不是有效 domain。[S12] | 高 | 渐进发现和准确过滤例；0.4.0 才启用发现硬预算；M1/M2 |
| R12 | CLI/MCP 共用 Node 包，engines 为 >=26.3.0 <27；FactStore 原生源码随包但安装时 node-gyp 编译，无独立数据库服务。只用 MCP 不会消除这些运行/安装依赖。[S17] | 高，进入首版 | 预编译扩展、最简 MCP 配置、干净环境安装验证和分层依赖说明；M5 |

S2 统计为 1058 次 run、193 次 capabilities 调用，含失败/重复，不是成功用例数。本版使用 UTF-8 紧凑 JSON 字节与实际客户端交付字节两种明确口径；不把字节比例称为 token 比例，也不由 Bridge 输出大小推断特定客户端实际保留了多少上下文。

## 3. 已确定的产品与合同决策

1. **公共 extract 必填、允许 null。** 价值落点是 tools/list 的顶层 required 与字段说明，CLI 同一合同。null 表示本次不做调用者提取，仍有查询范围、预算和原命令行为；内部 ctx.call 不强制新增字段。
2. **默认正文预算候选 96 KiB，硬上限 256 KiB。** 代表性 Intent start/decide 快照约 66.6 KB，加封套后可用；带历史的 status 可能超限，范例明确 limit、正确历史游标与 extract。M0 不承诺所有状态响应都内联通过，M2 完整验证并校准。预算覆盖控制、错误、诊断与提取结果，不只计算 value。
3. **动作、提取、交付分别报告。** `_feedback` 留在原 value；仅把已有执行事实和继续操作必需字段复制到受保护的 execution/control，不整份复制反馈。提取失败不重放动作、不返回大原文兜底，源保存成功时只对同一快照修正提取。
4. **重新提取基于同一份命令响应。** null、即时提取和快照重读使用相同源内容；快照原样保存，不另设 direct/projected 或表示选择字段。已有 UI history 早于最终 feedback，不作为快照来源。
5. **提取先用独立子进程。** 复用 JS/Python IPC 与清理；regex 也在可终止进程运行；源码派发前固定，输入/输出/时间/活跃进程数分别有界。无空位明确报忙，首版不做常驻池或新增任务队列。
6. **首次探索用 Intent，固定回归用 Script，单次查询用命令加 extract。** 先缩小采集范围，再提取输出；后置提取不能改善已发生的采集成本或补回缺失状态。
7. **首版保持一个 MCP 接入入口。** FactStore/Runtime 是随产品管理的内部能力，不增加用户单独安装数据库、学习 CLI 或维护服务的步骤；平台工具和 Python 按实际能力说明依赖。
8. **显式合同迁移。** 0.4.0 同时改变请求和响应；旧调用补 extract，解析器读取公共封套的 value/control、退出码与错误状态，原 value 内字段位置保持。不能宣称只是增加可选参数或所有旧客户端无需修改。

源码能确认 MCP 将响应写成工具正文，CLI stdout 也可能被模型工具读取；各客户端可能有截断/外置/压缩，界面折叠不是上下文未占用的证明。[S3、S10] Script 内部数据只有经过 progress/askAgent/result 等公共出口才成为对应工具输出；存盘不会自动进入上下文。因此本版控制公共交付，并记录采集、提取、交付三段成本。

### 3.1 本轮收掉的额外复杂度

| 原设计负担 | 收敛后的首版边界 |
| --- | --- |
| direct/projected、额外数据处理及表示选择 | 已撤回；即时提取和重读使用同一份命令响应，不另增处理层 |
| 把完整 `_feedback` 搬到 control | 保留原位置，只保护少量既有执行/续跑字段，减少迁移和重复数据 |
| 新公共响应版本、快照版本及 Runtime 协议升级 | 复用现有 Runtime reply.value、身份检查和 evidence schema/checksum；仅增加响应记录类型 [S19] |
| 提取排队/等待状态、完整诊断归档、发现专用配置 | 活跃进程数限制加明确报忙；有界诊断；发现使用固定默认预算 |
| 通用工具链兼容探测及扩大平台/Node 支持 | 只检查所选执行器已知约束；先解决已声明支持范围内的安装，不把兼容面扩张列为前置 |
| M0 先做一遍完整原型、性能和验收，M2 再实现 | M0 只确认接口、代表样例与复用点；实际功能及失败/性能测试随对应实现提交完成 |

预算解决上下文膨胀，源快照与 ref 解决失败后重读而不重做动作，受保护的执行/控制信息解决误判和无法续跑，独立可终止进程解决提取超时。这些均对应实际问题，保留；本轮不再增加与这些问题无关的机制。

## 4. 公共实现位置与依赖

```text
验证公共请求并固定提取源码
  → 原命令执行/原事实记录/最终 feedback，释放设备动作锁
  → 公共返回处理：分类控制 → 固定响应 → 需要时原样保存 → 提取 → 封套/预算
  → Runtime 传输 → CLI 或 MCP 仅加传输外壳
                         ↑
客户端本地命令 ──同一返回处理模块
保存成功的 ref → response read → 校验同一快照 → 同一提取/交付路径（无设备调用）
```

| 实现范围 | 必须完成的连接 |
| --- | --- |
| command-request、CLI、MCP schema/discovery | 公共字段校验与业务参数分离；预检失败设备调用为 0；required/description 实际暴露 |
| execution-host、runtime-client 本地路径 | 公共处理恰好一次；Script/Intent 当次响应都覆盖；离线 verify 不被迫启动 Runtime |
| runtime-protocol、CLI/MCP Adapter | 公共封套装入现有 reply.value 并完整往返；Adapter 取出同一正文；history 不重复；旧代码由已有身份检查拒绝，不重建传输协议 |
| runner / IPC / shutdown | 独立提取进程、stdin 输入帧和 stdout 返回帧分限额；超时与过载、stderr/源码位置；Host 跟踪覆盖提取阶段，所有退出路径清理本次临时源码目录 |
| FactStore / evidence | 需要留存的普通响应新增最终快照类型；复用存储和 checksum，不复用早于最终值的 UI 记录；read 及既有导出/校验识别 response，不新增归档格式或服务 |
| 安装/发行与文档 | 预编译依赖、干净安装、有效 Node 范围、MCP 配置与平台准备；与实际发布包对账 |

业务命令通常不逐一嵌入提取逻辑；但响应族的控制字段映射、Native compact 状态保真及本地特殊路径需要明确覆盖，不能因“公共模块”而漏掉这些工作。

## 5. 工作包、顺序与发行

| 工作包 | 实施范围 | 依赖 | 可审核完成条件 |
| --- | --- | --- | --- |
| M0 接口确认与复用检查 | 复核请求/返回字段及普通命令、Script、Intent 必需控制字段；代表封套和大小样例；复用点与迁移清单；仅对不确定接入点做最小探测 | 本稿 | 接口及失败语义明确，代表样例可行，实施者能据此直接开始；不要求先完成 worker/持久化原型或全量性能测试 |
| M1 现有使用面修正 | 无缩进；文档/夹具同步；发现过滤、错误修正例；Intent/Script 当前可用范例 | 可立即开展，不依赖新预算 | 原合同合法请求仍可用，JSON 结构和值等价；公开范例按当前包校验 |
| M2a 公共返回基础 | 参数/schema、必要控制保护、统一封套、CLI/MCP/Runtime 与本地路径 | M0 | null 打通各响应族；原 value 含 `_feedback` 保持；真实 tools/list、CLI 解析、封套往返和退出码正确，无额外设备调用 |
| M2b 快照与读取 | 最终响应原样保存、保存失败、ref/read/expiry/checksum、归档 | M2a | 解码字节及原响应值一致、跨进程重读、0 次设备调用；未保存无 ref，无快照套娃、编码开销和存储故障可见 |
| M2c 提取和预算 | JS/Python/regex，预检/runner/资源/关闭；交付预算与发现预算 | M2a/M2b | 真实 worker 完成最大 8 MiB 输入 × 两语言 × 参考机复测（含冷启动/传输）；成功及失败路径保留动作事实；每次业务动作至多按原请求执行一次 |
| M3 诊断与准备 | 有界 Script 诊断；客户端启动身份；准确版本错误；所选执行器已知依赖要求与项目配置预检 | 可与 M1/M0 分开实施 | 诊断定位到源码；不误导停新 Runtime；已知 compileSdk 等冲突在主要构建前暴露，不偷偷升级配置，不建设通用工具链兼容引擎 |
| M4 迁移和独立验收 | 请求/响应迁移、三类完整范例、compact 保真、反例、包/真机/性能/升级矩阵 | M1/M2/M3/M5 | 第 9 节验收对账，关键项无未说明缺口；报告清楚区分通过、失败和未验证 |
| M5 最简接入与发行 | 当前支持范围内预编译 FactStore、固定版本 MCP 启动范例、依赖分层、干净环境安装验证 | M5 开始时明确已有支持的平台/架构/系统 ABI 及 Node-API 基线，不默认扩大主包 Node 支持面 | 第 7.1 节加载/安装/指纹/包测试四处同步；声明支持的平台无需本地编译扩展；只配置 MCP 即可启动/发现/调用；不用 Python 能完成普通命令与 JS/regex |

M0 已完成轻量确认，按本版接口基线开工。先做 M1，M3/M5 可按模块独立推进；M2 依次 M2a → M2b → M2c，再完成 M4。每个包附变更清单和针对性测试；失败修复后补对应回归，不靠重复全套测试代替定位。性能参数校准、完整失败路径和包/真机验收属于实施交付，不再作为开工前原型任务。

文档投入不等待 0.3.9 的对外发布决定：smoke、旧接入版本、target.platform 及已知错误引导在 M1 修正；依赖新 extract/封套的完整范例统一在 M4 编写和验收，共用流程与断言，不为两个版本各建一套新示例。

**0.3.9 检查点**：只接纳保持现有公共合同的 M1/M3 修正，以及已证明兼容的打包改善。保留 CLI/MCP 旧结构，不新增 extract 必填、统一封套或发现硬预算。若某项改变了已接受输入/响应语义，移入 0.4.0。

**0.4.0 改善版**：包含 M0–M5 全部首版完成条件和公共合同迁移。0.3.9 是否对外发布由用户决定；实施默认把它作为可审核检查点，未决定对外发布不阻塞后续工作。这里只给工作顺序与关口，不给未经实施核对的工期承诺。

## 6. 使用引导与可修正错误

| 场景 | 完整范例必须做到 |
| --- | --- |
| 首次探索 / 分支流程 | Intent 观察 → 唯一定位 → 绑定 revision → 动作 → 新观察 → 独立判断；status 显式 limit，按实际需要提取字段；明确 supervised 不会仅凭 goal 自动做完 |
| 固定多步 / 重复回归 | 同场景 JS/Python Script；正确读取 ctx.call 的 result；每 case 断言/证据；start → wait → result → 失败清理 |
| 单次 UI / 网络 / 日志 | 使用该命令真实支持的过滤、游标和数量限制；null 与三种提取模式；失败后改 extract 读 ref，原动作不再派发 |

Script 等待辅助函数保持原 operationId，每次 waitMs ≤ 60000，事件续等的 afterSequence 使用上次 eventSequence。Intent status 历史分页的 afterSequence 则使用上次 history.lastSequence（新封套为 control.history.lastSequence），两种序列不能混用。status 范例显式 limit（可从 1 起），但单条 summary 历史仍可能超预算；只查当前状态时配合 extract，不把 limit 当字节限制。

待回答状态明确交还调用者处理，不能一直等到超时；control.pendingQuestion 保留当前问题的 requestId/revision/request，不依赖该问题是否仍出现在本页 events。progress 只写状态变化、失败和证据引用，不逐步倾倒 ctx.call 全量数据。重复脚本用 sourcePath，示例连同运行入口、等待和最终解析一起测试。

错误消息按具体入口给一条最小修正：capabilities 是独立工具；未知 domain 给真实列表；wait 超界给范围及继续等待例；缺 target.platform 精确到字段；缺 extract 给 null 例且确认未派发。Intent status 超预算点名 limit、历史游标来源和 extract；已有响应优先按 ref 重读，源不存在/损坏不得建议盲目重放动作。诊断本身也受预算，不把整份 capabilities 塞进错误。

## 7. 准备、安装和升级生效

### 7.1 最简 MCP 接入

当前事实：npm 包同时包含 CLI/MCP，Node 是运行依赖；FactStore 是随包的原生库，不是用户另外部署的数据库服务。当前安装需本机编译，`verify:package` 甚至断言 native 编译成功；它只证明有编译环境的干净目录可用，没有证明普通用户免编译安装。[S17]

首版产品路径固定为：安装受支持 Node → 使用一份固定版本的 npm/npx MCP 配置 → 首次调用由产品管理 Runtime 与存储目录。用户可以一直只用 MCP。M5 必须提供预编译原生扩展、校验和与支持平台清单；普通发行路径不要求 C/C++ 编译工具或为了装扩展先安装 Python。源码构建作为明确的开发者路径，缺少对应二进制时准确报告平台/架构/ABI，不静默切换存储后端或把本机编译当正常用户安装成功。

M5 至少同步以下四处，不能只把二进制放进包里：

| 位置 | 必须改动及验收 |
| --- | --- |
| [原生加载入口](../native/segmented-fact-store/index.js)及[包文件清单](../native/segmented-fact-store/package.json) | 发行路径显式选择已支持平台的预编译 .node；npm 打包及主包 bundleDependencies 确实包含相应产物；缺失或不支持时明确失败，不自动转源码编译 |
| 原生包安装生命周期 | 取消当前 binding.gyp + 默认安装规则触发的 node-gyp rebuild；源码编译仅由独立开发者命令触发；正常 npm/npx 安装不要求编译器或 Python |
| [代码指纹](../desktop/ai-app-bridge-cli/bin/runtime-directory.js:34) | 与加载器使用同一二进制选择，哈希实际加载的 .node，不再固定 build/Release；仍在客户端/Runtime 启动时固定各自身份 |
| [安装包验证](../desktop/ai-app-bridge-cli/scripts/validation/verify-package.js:37) | 以干净环境免编译安装、实际加载产物及身份/校验和验证替代 gyp info ok 断言；覆盖固定版本 npm/npx 和纯 MCP 调用 |

[binding.gyp](../native/segmented-fact-store/binding.gyp)声明 NAPI_VERSION=8，绑定源码使用 Node-API，可利用其跨 Node 版本的 ABI 稳定性，避免按每个 Node 版本重复构建扩展；系统/架构、系统库及最低系统版本仍须匹配支持矩阵，不能据此声称“只按 OS/arch 就必然可用”。这是原生扩展的打包依据，不代表主包已经支持 Node 24。[Node-API 官方说明](https://nodejs.org/api/n-api.html#implications-of-abi-stability)；当前 npm 默认触发编译的条件见 [npm 安装生命周期](https://docs.npmjs.com/cli/v11/using-npm/scripts/#npm-install)。

Python 仅在选择 Python Script/extract 时探测并要求；JS/regex 与普通命令不因此依赖 Python。Android/iOS/Web 的设备工具按 provider 文档分开说明；支持矩阵注明 WDA 14.1.1 随所有平台安装、准备/构建运行路径仅在 macOS 支持，该包无 install/postinstall，不列为首版安装阻碍或拆包任务。[S18] 首版按已有平台与 Node 范围交付并说明要求；扩大兼容面是独立后续决定，不把降 Node 版本、增加系统支持列为本版安装改善的前置。

M5 验证至少包含：支持矩阵内无编译工具、无 Python 的环境；npx 首次与再次启动；纯 MCP initialize/tools/list/只读调用；FactStore 自建/读写/重启恢复；不支持平台和安装损坏；断开 MCP 后 Runtime 原有生命周期。0.4.0 的 `extract` 由工具 schema 和示例指导 Agent 填写，不要求最终使用者每次手工配置提取脚本。

**免 Node 独立发行包**单列候选：打包 Node、原生扩展、资源及签名/升级机制；先验证同一包可运行 MCP、启动独立 Runtime 与提取子进程，再决定发行。当前不提供也不宣称已有。首版至少交付免本地编译的 Node/npm 路径；如果后续把“用户不安装 Node”定为首版要求，需要新增独立包的正式验收工作包。

### 7.2 执行器准备

executor-prepare 复用现有准备路径，在主要构建/安装前确认目标模块/variant，并核对所选执行器已知的硬要求，优先覆盖实际遇到的 compileSdk 与依赖 minCompileSdk 冲突。需要取得有效配置时复用现有 Gradle 路径做最小配置探测；只读正则不能可靠解析的值报告未确定，不凭猜测宣称兼容。相关 JDK/Gradle/AGP 版本随诊断列出，不为首版建设全工具链兼容求解、探测缓存或自动修复体系。

冲突给实际值、要求值和受影响范围，不隐式升级业务配置或切换 provider。临时 init script 即使不改源文件，也可能改变有效业务配置，报告必须承认影响。独立 com.android.test 留作后续候选；将来只有业务配置不变且测试 APK 实际构建/安装/动作通过后才能称验证成功，不作为本版预检修复的前置任务。

### 7.3 身份与升级

Runtime 已在启动时固定代码身份，待修的是 CLI/MCP 客户端首次 run 才计算的时机。错误同时报告两侧包版本、Node/ABI、代码与配置指纹；可比较版本不同时指出版本较低一侧，版本相同而指纹不同只能判断构建/环境不一致，不能凭哈希判“旧”。只有证据支持 Runtime 是待更新一侧才给停止该 Runtime 的操作建议；不自动重启正在工作的实例。

每次发布证据清单区分：源码提交/包校验和、实际 CLI 路径、当前 MCP 加载版本/启动指纹、Runtime/配置身份、消费项目解析的依赖；涉及设备安装时再列序列号、包/variant、安装产物与前台目标。纯 Host 改动不强迫无关 SDK 重装，构建成功不能替代实际安装生效。

## 8. 基线、度量与收益判断

| 样本 / 探测 | 本轮可复核结果 | 用途与限制 |
| --- | --- | --- |
| backup-dialog 原始夹具 | 紧凑 289965；缩进 1143164 字节，缩进空格 822506 | 去缩进有直接收益；不是采集提速或 token 比例 |
| labels 原始夹具 | 紧凑 41214；缩进 153848 字节 | 补第二种树形样本 |
| capabilities | 默认 18895；tree 1913；webview 3972；全部 options 424057；intent 116249；decide 51605；限定 Android/native/tap 5493 | 默认/窄发现可用，宽发现需过滤；decide 本身没有超过 64 KiB |
| 当前 Intent worker，合成 5k / 10k Flutter 节点 | summary 65476 / 65485；完整 start 66558 / 66574 字节 | fake adapter 各一次 observe，无设备动作；这是当前响应，不是新封套验收；时间/身份造成少量尺寸波动 |
| 新 run 声明 | 合同中的完整 run 声明紧凑 UTF-8 为 1844 字节；现有 validateValue 通过 9 个合法/12 个非法样例 | 已验证结构分支复用；语义预检、CLI 集成及真实 tools/list 总量随 M2 正式实现验证 |
| tools/list 离线替换测量 | 当前 tools 数组 1227 字节，替换 run 声明并保留工具 description 后为 2872；含 `{tools:...}` 的 result 分别为 1237 / 2882 | 与外部复核数字一致，差别仅在外壳口径；候选是离线声明替换，不代表新服务已暴露 schema 或客户端已兼容 [S20] |
| Intent status，150 / 600 合成节点 | 默认 value 102078 / 201768 字节；正确使用 history.lastSequence 后为 33782 / 67012；limit=1 的最大历史页仍达 66340 / 132800 | 事件序列 3、历史序列 8；不能用 eventSequence 代替历史游标，limit 不保证字节上界；无设备 [S21] |
| 普通 tap-text，fake runner | 错用 text 时 value 154 字节、原报告封套 491，是缺 targetText 的错误；改用 targetText 后成功 value 553、保留完整 value 的代表封套 982 字节 | 纠正报告把不同样本的数字合并；成功 fake mutation 调用 1 次，设备调用 0；大小随身份/时间变化 [S21] |
| 历史整套测试 | 前稿作者记录 1338 通过，另有并发时 p95 时序敏感报告 [S15] | 本轮未重跑，不计作新版本验收 |

Intent 回放方法：复用 `test/summary-transformer-g3.test.js` 的 5k/10k 节点生成规则，`createFakeIntentDeviceAdapter({trees:{flutter:rawTree}})` + 内存 evidence adapter 调用真实 Intent `handle(start)`，统计 `JSON.stringify` 字节并清理 operation。无设备、无提取实现，不把该探测当业务测试。[S16]

文档校验：两份方案的 Markdown 表格列数一致，文件链接均存在，合同 JSON 可解析且 required/分支结构符合本稿；前轮已重新计算两份树夹具与七组 capabilities 的字节。现有 validator 的 21 个 schema 样例及 CLI null/无值 flag、Python 大整数静默失真探测继续有效；早前对六组记录处理样例的检查属于旧方案，不计作当前快照保真验收。[S18] 尚未完成新功能实际持久化读回、最大输入超时、全套或真机验收。

本轮复杂度审核另验证了 4 个合成公共封套：JSON、文本、bytes、动作成功而提取失败，作为现有 reply.value 经 JSON 传输和 decodeReply 后均完全一致。[S19] 这证明无需为承载封套更换 Runtime 协议，不等于公共返回功能或旧客户端迁移已经实现。

M0 外部复核补查确认现有单帧上限会拒绝 8 MiB 输入，且共用限额不能同时表达大输入、小输出；同 requestId 在缓存过期或新建 TargetExecution 实例后会再调用 runner。另以 290119 字节合成快照，经过现有 evidence 封套及两次 FactStore 写前规范化，snapshotBase64 解码字节与记录 checksum 保持一致。[S20] 这些是 fake stream/runner 与内存字节探测，未连接设备，也没有证明新的 response 类型或真实落盘路径已经完成。

新基线分别测：采集次数/耗时、提取预检/启动/运行/总耗时、输入字节、完整交付字节、调用次数、快照写入/重读与错误。性能断言单列安静环境运行，保留功能组的字节/语义断言；并发失败先定位、再重建多次基线，不直接放宽 p95 门槛。

M4 选三个可比真实任务：UI/网络查询、固定流程回归、限时日志诊断。2026-09-19 用户明确指定在 OPPO 测试应用验证后续流程，不再使用 POS；会员场景替换为测试应用的同类 UI/网络断言，保留以下证据要求。同设备/版本/查询范围对照，确认关键断言仍能完成；不通过删控件状态、缩小证据窗口来伪造收益。统计 non-null extract 比例、预算超限与 ref 重读次数作为引导观察指标，不设置鼓励无意义提取的占比门槛。token 仅在客户端有可靠测量时报告。

## 9. 验收矩阵与放行

| ID | 必测情况 | 判定条件 |
| --- | --- | --- |
| A01 原行为/迁移 | null、普通 JSON/文本/bytes、CLI/MCP、Runtime 与本地路径；校验/鉴权/关闭/传输及序列化失败 | 业务语义与原 value（含 `_feedback`）保持；成功及错误出口均交付同一公共封套，退出码一致；未知不伪装未派发，旧请求显式拒绝 |
| A02 预检 | 缺 extract、CLI null/无值 flag/非法 JSON/顶层字段剥离、非法 mode/flags/path/source、解释器缺失、语法错误 | CLI 先解析封套 JSON，再解析业务参数；派发前能判定的全部拒绝，设备调用 0；源码在动作前固定 |
| A03 两语言/regex | JS/Python 相同四字段 inputs；null/标量/嵌套数组/对象；整数 ±(2^53-1)、±2^53、±(2^53+1)、布尔值；regex 无匹配、捕获缺省、Unicode 零长度、JSON Pointer 转义 | 安全整数通过，越界在 Python 序列化前拒绝，调用方显式转字符串可通过；不篡改原 execution；无隐式类型替换或无限匹配 |
| A04 控制保护 | 原命令失败/未知/超时、回执、Script 待回答问题被事件游标过滤、Intent revision/lastAction、install-apk/permission-dialog、历史分页/采集截断、返回伪 ok | 按实际响应形状保护事实和续跑信息；当前问题仍含 requestId/revision/request；历史只复制页控制字段，提取成功不篡改执行成功条件 |
| A05 预算 | 默认/最小/最大、边界字节、多字节中文、恒等提取、大 feedback/错误/发现输出；Intent status 默认及 limit=1 的大 summary 历史页 | 度量最终正文；不复制完整历史到控制区、不截断 JSON、不返回大原文兜底；控制超限明确失败；limit 不被当作字节保证 |
| A06 无重放 | 成功动作后提取 throw/timeout/进程崩溃/超预算、修改 extract 后读 ref；去重缓存过期/淘汰、Host 重启 | 原业务动作计数保持 1，所有 ref 重读设备调用 0；不以相同 requestId 重发原命令代替重读；原动作身份不随 extract 改变 |
| A07 输入/保存一致 | 原命令 JSON/文本、嵌套字段、空值/中文/XML、最终 feedback；JS/Python 即时与重读；快照编码往返 | 提取前不按字段名/内容改写源值；保存前与读回解码字节/checksum 相同，四字段 inputs 相同；null 源内容与提取输入一致 |
| A08 留存故障 | 预算内 null 未保存、ENOSPC、超单响应限额、淘汰/到期、checksum 损坏、跨进程、归档 | 未尝试保存为 persisted=false/reason=not_requested 且无 ref；保存失败也无 ref；内存提取与保存独立，不补采、不套娃 |
| A09 资源/生命周期 | 8 MiB × JS/Python × 参考机冷启动和默认并发；输入/输出帧独立边界；灾难性 regex、stdout/stderr 洪泛、活跃进程满、断连/停止/迟到输出、spawn 失败 | 提交合同第 5 节性能数据；8 MiB 输入能通过通道但不扩大返回帧上限；Host shutdown 覆盖提取，所有退出路径清理本次临时目录；无空位明确报忙，不重放动作，设备锁已释放 |
| A10 发现/引导 | run capabilities、wait 90000、错误 domain、target.platform 缺失、三类范例；声明支持的 MCP 客户端对 oneOf/null 的暴露 | 每种有可运行修正；宽发现超限后可按有效 operation 示例一步收窄；范例包含 wait/result/断言，schema 不静默裁剪；服务端 schema 校验不替代客户端验证 |
| A11 诊断 | JS/Python 编译/运行异常、源码文件名、print/console、长 stack | 类型/位置/有限诊断可见，协议无污染；成功路径不倾倒日志 |
| A12 准备/身份 | 不兼容 compileSdk；旧客户端/新 Runtime 及反向；同版本不同构建/Node | 影响范围准确；不错误指挥停新 Runtime；启动身份不被升级后读盘冒充 |
| A13 安装/包 | M5 支持矩阵、无编译器/无 Python、固定版本 npx、直接 MCP、重启恢复 | 预编译扩展实际载入；只用 MCP 可完成普通/JS/regex；版本及发行资源可追溯 |
| A14 证据方法 | 混拼来源、旧状态、自然结束后停音、缺设备/外设 | 反例判失败或证据不足；blocked/not_run 不写成 not_applicable |
| A15 状态/性能回归 | checked/checkable、未知与 false、空文本、重复控件、前台解析、观察窗口、OPPO 测试应用（按用户指定替换 POS）；低端设备性能单列未验证 | 上游已知状态保留，缺省不伪造；既有修复无回退；不增加常驻观察或重复设备调用 |
| A16 消费与升级 | 实际 CLI/MCP/Runtime、受影响消费脚本与依赖、需要时设备产物 | 按第 7.3 节逐层核实；安装包测试不能替代真机业务测试 |

执行四轮：细节 → 完整流程 → 健壮性 → Review 驱动补测。每个 case 记录预期、实际观察、断言、状态、来源/时间/目标和证据引用。状态使用 passed、failed、blocked、not_run、inconclusive、not_applicable，人工裁定附原因并保留原断言。

A09 另明确覆盖至少 3 个并行 MCP 提取请求：受控保持 2 个 worker 活跃时验证第三个报 busy，随后仅按 ref 重读；另测真实短 regex/脚本并发的总耗时、busy 次数和额外调用数，据此校准默认并发 2。不把“同时发了 3 个请求”直接等同于必然有 3 个同时活跃的 worker。

放行要求：首版范围内关键合同、无重放、控制保护、留存一致性、支持平台安装及公开范例全部通过；已有功能无已知关键回归。三项真实对照有完整证据，缺设备时不能把“仅离线通过”写为完整验收；明确缩减发布支持范围须重新记录范围决定。物理纸张、真扫码枪、真实付款码音频仍属于对应消费项目的独立业务验收。

报告最少交付：源码/包身份、工作包与 A01–A16 对账、失败和未验证项、关键日志/快照 checksum、三项对照数据、安装和升级清单。测试数量与 Script 完成状态不能代替这些内容。

## 10. 实施交接

轻量 M0 已完成：第 5 版外部复核提供三类响应、复用点和迁移清单，本轮复查并纠正样例及游标口径；必要控制字段落入合同 §2.1。Fable 可直接从 M1 开始，按第 5 节推进，不再先提交一套完整原型。默认预算、超时及并发值继续以本稿为候选，在对应正式实现中校准。

迁移首先覆盖 [CLI 测试解析器](../desktop/ai-app-bridge-cli/test-support/cli-client.js)、[MCP payloadOf](../desktop/ai-app-bridge-cli/scripts/validation/mcp-jsonrpc-client.js)及其调用测试；再更新 CLI/MCP help、serverInstructions、tools/list、仓库内使用 skill、COMMAND_CONTRACT、SCRIPT_AUTHORING、README、INTEGRATION、TEST_PLAN 与 NotallyX 范例。外部消费项目按 A16 核对；文本搜索命中数不作为语义迁移完成的证明。

真实 tools/list、全响应族及落盘/故障测试交给 M2a/M2b；实际 worker 的最大输入、两语言和并发测量交给 M2c。接口变更回写唯一合同并复核受影响验收，正常实现选择和数值校准随提交记录。最终审核基于提交与可重现证据，不只读实施者总结。此文档是交接材料，本轮没有自动向其他 AI 发送任务。

### 10.1 对第 3 版 M0 外部复核的处理

报告给出的“可以开始实施”支持总体方向，但其引用仍包含已撤回的投影、反馈搬移及协议升级，不能据此称双方已对第 4/5 版逐条达成一致。按报告编号处理如下；实现以当前两份文件为准。

| 意见 | 处理 |
| --- | --- |
| B1、B4、B5、B6 | 第 4 版已明确 null 未保存无 ref、Python 序列化前拒绝越界整数、四字段 inputs、CLI 公共 JSON 先解析；无需恢复旧文再修改 |
| B2、S2 | 写侧处理的源码事实成立；投影/幂等处理建议不采纳，沿用已确定的原样字节快照。复用 evidenceId/checksum，不复制 Script 结果的双 hash/representation，也不导出 UI 处理函数来恢复撤回的方案 |
| B3 | 采纳通道限制问题；修法为 stdin 单行 JSON、输入帧与输出帧分别限额，见合同 §4/§5；不把同一个 maxFrameBytes 整体放大 |
| B7 | 采纳加载/安装/指纹/包测试四处接入，见 §7.1；Node-API 稳定性不能替代系统 ABI 和实际安装验证 |
| S1 | 保留 failureStage 作为首要失败定位，同时保留三段事实；多个失败有明确优先级，不能只看快捷字段就重试动作 |
| S3、S8 | 第 4 版已取消独立快照版本，Runtime 保持 v1；不恢复 v2 作为额外保险 |
| S4、S5 | 保留直观的 response read 入口，底层仍复用 evidence；bytes 的协议保留与 base64 交付规则保持，不凭“尚未找到生产者”删掉既有类型约定 |
| S6、S7 | 首版接受 UI 记录与最终快照并存，实际字节和保留期纳入既有测量，不宣称成本必然很小；M1 修正已知漂移，新合同完整范例在 M4 做一次，不等待 0.3.9 是否外发 |
| V1、V2、V3、V5、V7 | 纳入实现和 A01/A03/A04/A09：Host 关闭跟踪、临时目录清理、Python 类型错误、公共错误出口、两个 Intent 外观命令；不新增生命周期或清扫服务 |
| V6 | 纠正“同 requestId 换 extract 即安全重读”：缓存会过期/淘汰，且不跨 Host；正式保证仅来自 response read，不来自重发原命令 [S20] |
| V8 | Node 24 支持保留为后续候选，不把扩大主包 Node 范围重新塞回首版 M5 前置 |
| V4、V9、V10、V11 | 保留为对应实现测试：最大输入/冷启动耗时、发现收窄、已声明支持的 MCP 客户端；不据服务端离线探测宣称客户端或性能已验收 |

### 10.2 第 5 版轻量 M0 复核后的开工结论

可以实施；剩余工作属于既定工作包的实现和验证。本轮明确了以下边界，没有增加新的架构工作包：

- 96 KiB 保留为默认候选；Intent 历史按 history.lastSequence 续页，示例配 limit/extract。limit=1 仍可能读到大 summary，不能宣称必然内联通过。
- 普通成功 tap 样例与参数校验失败样例分开；Script result 的 not_persisted 样例只能证明失败返回形状，成功持久化读取随 M2b 验证。报告中的手工封套和假 ref 只用于大小估计，不是功能验收产物。
- 控制区不复制完整 history；Script 当前待回答问题不因 events 过滤而丢失，包含问题内容；execution 字段不取两个辅助函数键表的交集。细节统一见合同 §2.1。
- 快照及导出原样保存的约定补充到文档即可，不恢复额外处理机制，也不把既有通用 base64 规则说成 response 独有例外。真实并行 MCP 提取进入 A09，复用已有并发限制校准。

## 11. 证据与源码索引

- **S1**：[前次提取评估与离线样本说明](/Users/macbook/Documents/CompanyProject/ai-app-bridge/docs/CALLER_EXTRACTION_INTENT_SCRIPT_ASSESSMENT_2026-09-17.md)。176465 → 12646、158770 → 9674 是两个 compact 响应样本按原脚本选取字段后的比较，未作为默认算法。
- **S2**：[Cursor 原始使用记录](/Users/macbook/.cursor/projects/Users-macbook-Documents-CompanyProject-pos-android/agent-transcripts/7c0c5428-26ce-40ed-9323-1b35b998ad79/7c0c5428-26ce-40ed-9323-1b35b998ad79.jsonl:1247)。第 1 版统计工具调用；首个实际 Script run 在第 15 行，首个 Intent run 在第 1285 行；不把 capabilities 中查过命令当成已执行。本轮未重新统计。
- **S3**：[请求验证](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/command-request.js)、[CLI](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/ai-app-bridge.js)、[MCP](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/mcp-server.js)、[Runtime 编解码](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/runtime-protocol.js)、[本地特殊路径](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/runtime-client.js)。本轮源码复核：顶层只允许 command/arguments；`run` inputSchema 的 `arguments` 为 additionalProperties:true；MCP `toolJson` 与 CLI main 均用 `JSON.stringify(v, null, 2)`；MCP 把 history 同时放入 `_history` 与 `_meta`；`encodeReply` 只保留 value/history。新增 extract 尚不存在。
- **S4**：[当前测试计划](/Users/macbook/Documents/CompanyProject/ai-app-bridge/docs/TEST_PLAN.md:37)、[接入文档](/Users/macbook/Documents/CompanyProject/ai-app-bridge/docs/INTEGRATION.md:41)、[NotallyX search 夹具](/Users/macbook/Documents/CompanyProject/ai-app-bridge/examples/notallyx-sample/validation/test/review-search-durable.test.js)、[archive 夹具](/Users/macbook/Documents/CompanyProject/ai-app-bridge/examples/notallyx-sample/validation/test/review-public-archive.test.js:25)。本轮复核字段/文档，没有重跑历史所述整组失败测试。
- **S5**：[stderr 处理](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/script/script-session-channel.js:16)、[Node runner](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/script/node-runtime-adapter.js)、[Python SDK](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/script/script-sdk.py:147)、[scriptError](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/script/script-errors.js:17)。本轮复核：stderr 丢弃；Node 只传 `error.message`，Python 只传 `str(error)`；`scriptError` 辅助函数本身不包含 message，但上游验证/部分调用会补充 message，不能推论所有公开错误都没有说明。
- **S6**：[付款码 QA 核查](/Users/macbook/Documents/CompanyProject/pos-android/app/build/outputs/pay-voice-edq-20260917-is/review.md:16)。第 1 版读取报告；合成反例由该报告记录，未重新操作支付或运行真机测试。
- **S7**：第 1 版已读取 Codex 任务"解决 Instrumentation SDK 兼容问题"（01a0a83e-efcb-7691-a773-b73175061a98）；另见当前[执行器支持范围](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/docs/OPTIONAL_EXECUTORS.md:92)和[准备实现](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/executors/preparation.js)。POS 冲突属于历史实际案例，未重跑构建。
- **S8**：[0.3.8 发布交接](/Users/macbook/Documents/CompanyProject/ai-app-bridge/docs/RELEASE_HANDOFF_0.3.8_2026-09-15.md)。旧 MCP、新 CLI 和后续消费项目补齐是历史记录，不代表当前连接仍然如此。
- **S9**：[UI 观察性能记录](/Users/macbook/Documents/CompanyProject/ai-app-bridge/docs/UI_OBSERVER_PERFORMANCE_ASSESSMENT_2026-09-15.md)。既有受控场景结果不外推成所有低端设备的耗时保证。
- **S10**：[OpenAI 官方 MCP 调用说明](https://developers.openai.com/api/docs/guides/tools-connectors-mcp#step-2-calling-tools)。工具输出进入上下文的机制；客户端另外的外置/裁剪行为仍需逐客户端验证。
- **S11**：[共享 evidence store](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/shared-kernel/evidence-store.js)、[Script 持久化结果](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/script/script-result.js)、[归档合同](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/docs/EVIDENCE_ARCHIVE.md)。namespace 硬编码为 script/intent；可以复用基础设施，但普通命令响应级快照的 ref/checksum/读取入口不是已实现能力。
- **S12**：本轮实测。[tree 夹具](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/test/fixtures/notallyx-backup-dialog-native-tree.json)（`tree` 响应形态：ok/activity/root/windows/nodeCount，深度 39）minified 289965、`JSON.stringify(v, null, 2)` 1143164 字节，16287 行，缩进空白 822506 字节占 72%；[labels 夹具](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/test/fixtures/notallyx-labels-native-tree.json) 41214 → 153848。`command-discovery.capabilities()` 无缩进 / 缩进字节：`{}` 18895 / 23294；`{command:"tree"}` 1913 / 2898；`{domain:"webview"}` 3972 / 4623；`{includeOptions:true}` 424057 / 1303574；`{command:"intent"}` 116249 / 470161；`{command:"intent",operation:"decide"}` 51605 / 209115；再加 `platform:"android",provider:"native",action:"tap"` 后 5493 / 15449。`{domain:"android"}` 返回 `unknown_domain` 错误（缩进 112 字节），第 2 版初稿误记为小目录；当前 domain 为 execution、evidence、core、webview 等，没有 android。旧稿 run schema 片段为 1619 字节；新合同尺寸以本稿第 8 节为准。
- **S13**：[普通历史记录](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/fact-recorder.js:296)。`evidenceDescriptors` 把 UI_EVIDENCE_COMMANDS 的 result 经既有记录处理后写入 `ui` 分区、`*status` 写入 `state-event`，`isMobileCaptureCommand` 命令返回空。[execution-host.js](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/execution-host.js:256)：`attachRecordedFacts` 在 `safeRecordEvidence` 之后向 `feedback.evidence`、`feedback.factCache` 追加，`runBridgeWithinExecution` 随后再设置 `_feedback.observer`，因此已有 `ui` 记录早于最终交付值。本轮源码复核。
- **S14**：[代码指纹](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/runtime-directory.js:14)、[客户端兼容校验](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/runtime-client.js:69)、[Runtime 侧校验](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/execution-runtime.js:49)。`codeFingerprint` 覆盖 bin/、runtime/、package.json、ws/WDA/原生 addon 包与 `.node` 二进制及 `process.versions.node/modules`；模块级缓存、首次调用时读盘计算。Runtime 在 `start()` 开头计算身份（execution-runtime.js:18），客户端在 `run()` 内计算（runtime-client.js:144）。不匹配文案要求调用方停止 Runtime。本轮源码复核。
- **S15**：上一轮方案作者记录的 `npm test` 基线（`desktop/ai-app-bridge-cli`）：1338 通过、0 失败、约 47 秒；本次制定方案未重跑全套，不计作新版本验收。[summary-transformer-g3](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/test/summary-transformer-g3.test.js:133) 的 p95<20ms 断言在两次套件并发时失败一次、单跑通过；同测试断言 5k/10k 节点摘要输出 ≤ 64 KiB。

外部项目 build 目录和会话日志属于本机历史证据，可能按各自策略清理；正式版本验收须保存可校验的归档，不能只引用随时可能消失的临时路径。

- **S16**：2026-09-19 离线预算探测，入口为 [Intent worker](../desktop/ai-app-bridge-cli/bin/intent/intent-worker.js)、[测试入口](../desktop/ai-app-bridge-cli/test/helpers/intent-entry.js) 与 [摘要测试生成规则](../desktop/ai-app-bridge-cli/test/summary-transformer-g3.test.js)。方法与数值见第 8 节；使用内存存储、fake adapter，未连接设备。
- **S17**：[主包依赖和 Node 范围](../desktop/ai-app-bridge-cli/package.json)、[原生包源码发行配置](../native/segmented-fact-store/package.json)、[只加载 build/Release 的入口](../native/segmented-fact-store/index.js)、[当前干净目录打包验证](../desktop/ai-app-bridge-cli/scripts/validation/verify-package.js)、[存储说明](../desktop/ai-app-bridge-cli/README.md)。2026-09-19 核对源码，未重新安装 npm 发布物或执行无编译环境测试；“应提供预编译”是本版任务。
- **S18**：2026-09-19 M0 复核探测。[现有校验器](../desktop/ai-app-bridge-cli/bin/shared-kernel/argument-schema.js)接受 9 个合法配置并拒绝 12 个非法配置；[CLI 取参](../desktop/ai-app-bridge-cli/bin/ai-app-bridge.js)和[选项解析](../desktop/ai-app-bridge-cli/bin/command-registry.js)确认 null 尚为字符串、无值 flag 为 true，公共 wait 越界已有明确 message。早前对[记录器](../desktop/ai-app-bridge-cli/bin/fact-recorder.js)及[fact-codec](../desktop/ai-app-bridge-cli/bin/fact-codec.js)做过六组写前处理检查，现仅保留为历史探测，不再作为当前方案要求。Python 标准 JSON 输出整数 9007199254740993，Node JSON.parse 得到 9007199254740992；[Python SDK](../desktop/ai-app-bridge-cli/bin/script/script-sdk.py)当前 send 尚无该序列化前检查。另核对本机 WDA 14.1.1 包有 8 个直接依赖、prepare 脚本、无 install/postinstall；未据此声称整棵依赖树在所有平台安装已通过。
- **S19**：2026-09-19 复杂度审核。[Runtime 编解码](../desktop/ai-app-bridge-cli/bin/runtime-protocol.js)维持 `aab.runtime/v1`，4 个合成公共封套分别执行 `decodeReply(JSON.parse(JSON.stringify(encodeReply({value:body}))))`，均与 `{value:body}` 深度相等，含 `_feedback`、control/history、原动作成功与提取失败信息。[evidence schema](../desktop/ai-app-bridge-cli/bin/shared-kernel/evidence-schema.js)与[存储](../desktop/ai-app-bridge-cli/bin/shared-kernel/evidence-store.js)已有 canonicalJson/checksum 和统一记录封套；checksum 覆盖持久化记录正文，不需另加公开快照版本/第二份校验和。response 类型仍须正式扩展并测试，本轮未修改生产实现。
- **S20**：2026-09-19 外部 M0 复核补查。[通道](../desktop/ai-app-bridge-cli/bin/script/script-session-channel.js:5)与[runner](../desktop/ai-app-bridge-cli/bin/script/node-runtime-adapter.js:64)共用收发限额；输出预算 256 KiB 时实际帧上限为 1114112，fake stream 发送 8388608 字节 inputs（start 帧 8388686）得到 frame_too_large。[TargetExecution](../desktop/ai-app-bridge-cli/bin/target-execution.js:11)默认缓存 5 分钟/2048 项；fake tree runner 在重复请求、时钟推进至 300001 ms、新建 TargetExecution 实例三步的累计调用数为 1/2/3，设备调用为 0。[toolDefinitions](../desktop/ai-app-bridge-cli/bin/mcp-server.js:240)离线替换量测见 §8；原 run description 保留。原样快照检查使用既有 script/checkpoint envelope 承载 snapshotBase64，经过 buildEnvelope 及两次 normalizePersistentFact 后 290119 字节完全一致、verifyChecksum 通过；尚未实现 response namespace 或落盘重读。
- **S21**：2026-09-19 第 5 版 M0 复查。本机 Node 26.3.0，读取外部 `/tmp/aab-m0/m0-probe.js`、`m0-probe.json`、`m0-probe2.js`，发现成功 tap 的 value 字节被误配到缺 targetText 的错误封套。另用独立临时目录、真实 host.run + fake rawRunner，改用 targetText 后成功 value 553、完整值代表封套 982 字节。Intent 以同样 150/600 节点生成规则、内存 evidence store 和 fake adapter，经 start/decide 后查询 status；[worker](../desktop/ai-app-bridge-cli/bin/intent/intent-worker.js:323)与[ledger](../desktop/ai-app-bridge-cli/bin/shared-kernel/execution-ledger.js:92)证实历史游标独立。本轮 eventSequence=3、history.lastSequence=8；按后者续读无新增历史，value 33782/67012 字节；遍历 limit=1 页时最大 66340/132800，详见 §8。全部设备调用为 0，关闭 host 并删除本轮自建临时目录；未修改外部原探测文件，未运行真实提取 worker 或写入 response 类型。
