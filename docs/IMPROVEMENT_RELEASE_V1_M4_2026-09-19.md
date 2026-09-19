# 0.4.0 改善版：M4 发布验收记录

日期：2026-09-19。候选源码 `3133d20`，分支 `fable/improvement-v1-m1`。
本报告汇总已完成的 M1–M5；冻结方案的历史“尚未实现”描述不代表当前进度。
代码终审、Android / iOS 真机检查、Codex 与 Cursor 真实客户端检查均已通过。A01–A16 放行；本记录形成时尚未执行对外发布。

## 交付与身份

外部 run 必填 `extract`；显式 `null` 取本次完整结果，regex / JavaScript /
Python 由调用者选择。公共返回保护执行事实、问题、游标和证据窗口，最终紧凑
JSON 正文默认 96 KiB。提取失败不重放动作；已保存响应可按 ref 重新提取。
Script 有界诊断、可修正错误、完整生命周期示例、启动身份检查和执行器准备预检
一起交付。没有增加 direct/projected、隐私投影、任务队列或通用工具链兼容引擎。

最简 MCP 安装只要求受支持的 Node（`>=26.3.0 <27`）。FactStore 是包内扩展，
无需独立服务；普通调用、JS 和 regex 不要求 Python 或本地编译器。
Python 仅在选择 Python Script/extract 时需要。Windows / musl 不在本版支持矩阵。

最终主包：`mobileaidev-ai-app-bridge-0.4.0.tgz`，SHA-256：
`63239bda91fda7f8f89afc7d8fa8e0ed1f4aca8d9a488ff9cda03afc4adff040`。
包已在仓库外全新安装并通过当前 CLI/MCP 合同检查。与完整 verify:package
通过的 `909f905e…1470` 包逐文件比较，仅两份消费者文档不同：
`docs/COMMAND_CONTRACT.md`、`docs/OPTIONAL_EXECUTORS.md`；运行代码、依赖和
四个 native artifact 完全相同。没有把两个压缩包的不同 hash 当成实现变化。

持久证据根目录：
`/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/0.4.0-2026-09-19`。
结构化对账见 [M4 JSON](IMPROVEMENT_RELEASE_V1_M4_2026-09-19.json)；证据目录的 `manifest.json` 逐文件记录大小和 checksum。
测试原始日志中的 `/tmp` 是运行时路径，关键报告、正文、截图、日志和最终 tarball
另存到上述目录，不依赖临时目录作为唯一留存。

| 工作包 | 结果 | 主要提交 / 证据 |
| --- | --- | --- |
| M0 | passed | 第 6 版冻结方案与公共合同，后续实测限额回写合同 |
| M1 | passed | `5cd32af`、`e11d680`、`828b1e5`；紧凑输出、错误引导、文档与范例 |
| M2a | passed | `dc63f8e`；统一请求与返回、控制保护、CLI/MCP/本地路径 |
| M2b | passed | `41edaf5`；8 MiB 原样快照、真实 ref、跨进程读取与归档 |
| M2c | passed | `1018b60` 及审核修复；两语言/正则、预算、可终止 worker、无重放 |
| M3 | passed | `8ed81d2`、`13a0db0`、`bac7cb3`、`6885a58`；诊断、身份、准备预检 |
| M4 | passed | `3666bb3`、`9091bba`、`5b3804a`、`49c181b`、`3133d20`；真实设备、客户端和独立终审通过 |
| M5 | passed | `b6a0bdb`、`47bdc59`；四个预编译平台、全新安装、纯 MCP/npx |

## 测试与安装矩阵

| 检查 | 实际结果 | 边界 |
| --- | --- | --- |
| Host 全套 | 1325 功能 + 50 串行测试 = **1375 passed，0 failed，0 skipped** | 162 个 test 文件恰好执行一次；性能断言未放宽 |
| 文档可执行范例 | 5/5 | 从文档围栏读取，含 JS/Python、wait/result/断言 |
| NotallyX 迁移 | 138/138 | 消费脚本与夹具回归；不是该 App 的新真机业务验收 |
| Android SDK/plugin/executor | BUILD SUCCESSFUL，241 tasks | SDK、插件、单测/lint、六个执行器构建；测试 SDK 目录独立 |
| Android sample | 构建、安装和 OPPO 实际流程通过 | 当前 SDK 0.4.0；sample 自身 versionName 仍为 0.1.0 |
| iOS Swift 包 / 真机 | unsigned generic build、Kiwix signed build、安装启动及 SDK 0.4.0 公共返回验证通过 | iPhone 17 Pro Max / iOS 27.2；未重跑 Kiwix 全部业务流程 |
| Flutter SDK | analyze 无问题，66 tests passed，pub dry-run 0 warnings | Flutter 3.44.8 / Dart 3.12.2；未发布 pub.dev |
| Flutter test helper | analyze 无问题，pub dry-run 0 warnings | 仓库没有 test 目录，不称为测试通过 |
| Web SDK | 23/23，build passed | 本版相关 SDK 回归 |
| macOS arm64 / x64 | 各 native 8/8；完整 tarball、首次/重复 npx、MCP 通过 | macOS 27；x64 为 Rosetta |
| Linux arm64 / x64 glibc | 各 native 8/8；完整 tarball、首次/重复 npx、MCP 通过 | Debian 12 VM / glibc 2.36；x64 为 VM 中 Rosetta |

native 的编译目标是 macOS 13.5 / glibc 2.28 / Node-API 8；未在这些最低系统或
物理 x64 主机实测。四平台身份和 artifact checksum 见 [M5 对账](IMPROVEMENT_RELEASE_V1_M5_2026-09-19.json)。
正常安装与纯 MCP 的 JS/regex 路径实际禁止执行 Python/编译器；Python 功能在
另一个正常环境验证。固定版本 npx 使用本地候选包构成的受控发行源，不能据此
声称 npm registry 已有 0.4.0。

原自动发现方式把 13 个 helper 模块也算作“测试”。当前脚本只选择 `.test.js`，
153 个功能文件与 9 个含时序断言的文件全部保留。数量不能直接与早期 1338 比较。
第一次并行测试触发 P3 p95 断言，按既定方案将时序组串行执行后通过；未增大阈值、
删除断言或把失败当成可忽略。最终日志为 `aab-m4-final-host-tests-r3.log`。

## 真实流程与输出对照

用户明确要求后续流程使用 OPPO 测试应用，不再使用 POS。实际目标固定为
`b46093e6` / PKR110 / Android 16 / API 36，包
`io.github.mobileaidev.aiappbridge.sample`，前台为 `DebugBridgeNativeTestActivity`。

最终流程为 `aab-m4-sample-flow-r6`：计数器从 0 到 1，App state 与新 tree 一致；
点击请求按钮后 UI 显示 HTTP 200，自动网络记录是 App 自己发出的同一 URL GET。
请求指向 sample 自有的本地 MockWebServer；不是对外业务服务的验收。
Script 终态和持久化 result 均核实，四个业务断言通过，两张截图人工查看一致。
反例分别得到：旧 tree `inconclusive/evidence_action_window_stale`、伪造/缺失证据
`inconclusive/evidence_not_host_issued`、错误计数器预期 `failed`，没有误计为通过。

`aab-m4-extract-comparison-r6` 在相同 SDK、进程 epoch 和查询范围上执行三次实际
设备查询，然后只按各自保存的 ref 读回原始内容；重读不再次查询设备。
tree 保留该测试所需控件状态；network/logs 的目标、时间窗口、完整覆盖及分页字段
分别对照，没有通过缩小原查询窗口来制造收益。

| 查询 | 原 value 字节 | 提取 value 字节 | 提取后的完整正文 | 原 ref 重读的完整正文 |
| --- | ---: | ---: | ---: | ---: |
| tree | 76549 | 17062 | 17991 | 77591 |
| network | 1468 | 173 | 1700 | 3109 |
| logs | 1512 | 430 | 1951 | 3147 |

这是 UTF-8 紧凑 JSON 字节，不是 token 测量或采集提速结果。原文重读有独立的
origin 控制信息，故两列完整正文也不等同于同一命令只替换 value 的比较。
三次均 non-null extract，ref 重读 3 次，预算超限 0；测试明确用 256 KiB 输出
预算，不能冒充默认 96 KiB 边界测试。设备查询 3 次不包含身份预检请求。
三个原文及提取结果均完成独立断言，不声明提取保留了所有 UI 信息。

参考机最大输入测量仍见 [M2c 数据](IMPROVEMENT_RELEASE_V1_M2C_MEASUREMENTS_2026-09-19.json)：
8 MiB，JS/Python，单路与并发 2，共 60 个 worker 全部通过，最大 146.76 ms。
默认提取超时保留 2000 ms，并发保留 2；真实 MCP 受控占满两个 worker 后第三个
明确 busy，释放后只按 ref 重读。没有低端硬件的性能结论。

## 四轮验收与修复

| 轮次 | 发现及处理 | 最终证据 |
| --- | --- | --- |
| 细节 | 请求迁移、类型、控制字段、快照保真、预算和进程诊断逐项验证 | Host 全套、各 M2/M3 报告与最终包 |
| 流程 | sample 原脚本假定旧 TCP 端口；网络夹具触发主线程反向 DNS；公开脚本混入已移除参数 | 改为当前连接方式、自有 HTTP fixture/literal IP、当前合同；r6 完整流程通过 |
| 健壮性 | 非法参数、throw/超时/退出/洪泛、保存失败、并发占满、旧证据/错误业务预期 | 不派发或保留真实执行事实；动作不重放；设备反例明确失败/证据不足 |
| Review 驱动 | 发现终态 status 使用超限 4096，且只看 Script 完成未核实保留结果；时序文件仍有并行漏项 | `9091bba` 修正 status 游标/limit、实际 result 和业务断言对账，全部时序组串行；r6 重跑通过 |

独立 Standards / Spec 的最终代码复核固定至 `3133d20`，均无剩余 P0–P2。
终审发现 LocalSend 新指南指向 0.4.0，而 integrate.py 仍注入 0.3.8；同类核查
发现 Flexify 也有旧 pin。`3133d20` 对齐两个脚本、LocalSend manifest 和 Flexify
说明；两份实际脚本在隔离最小上游夹具执行后均生成 0.4.0，Spec 复核确认闭环。
这是脚本验证，不是两个消费者的新业务构建。主包不含这些样例文件，最终 tarball
及其已验证内容不变。

Android lint 曾受全局 SDK 目录中的预览/备份平台干扰；使用隔离的稳定 SDK 目录
完成构建，没有修改用户全局 SDK 或升级消费者 compileSdk。Flutter 初次 dry-run
指出版本日志缺失/未提交，修正后两个包均零警告。所有失败保留原日志并标明修复轮次。
OPPO 早前 USB 断连按用户说明保留为线缆/设备不稳定观察；最终通过流程未发生断连，
没有重启 ADB 或在结果未知时自动重放动作。

## A01–A16 对账

| ID | 状态 | 证据与限制 |
| --- | --- | --- |
| A01 | passed | public-return、Host/CLI/MCP、文本/bytes、本地路径与故障出口；最终包 |
| A02 | passed | extract/source/解释器/语法预检及 CLI null/无值/JSON/字段剥离；拒绝时设备调用 0 |
| A03 | passed | extraction 类型矩阵、JS/Python 四字段 inputs、安全整数、regex Unicode/JSON Pointer |
| A04 | passed | 控制保护、待回答问题、Intent/Script 游标、采集覆盖、动作失败/未知及伪 ok |
| A05 | passed | 最小/默认/最大正文、中文、控制区/错误/发现超限、大 summary 分页；完整正文测量 |
| A06 | passed | throw/timeout/退出/超限后动作计数为 1；ref 跨进程/重启读取且 provider 调用 0 |
| A07 | passed | 原 value/feedback 不改写，保存字节与 checksum 往返，JS/Python 即时与重读一致 |
| A08 | passed | not_requested、写入/容量/过期/校验损坏、归档；无假 ref、补采或嵌套快照 |
| A09 | passed | 8 MiB 两语言性能、两活跃 worker + 第三 busy、帧/日志/退出/停止/清理；参考机限制见上 |
| A10 | passed | 真实 Codex 客户端四种调用通过；Cursor 3.21.13 的 schema 与五次工具调用经原始客户端数据库和日志独立核对通过 |
| A11 | passed | JS/Python 类型/源码位置/有限 stack 与 stderr，终态持久化，无协议污染 |
| A12 | passed | 真实 Gradle compileSdk 33 拒绝/34 通过；新旧双方及相同版本不同构建的身份错误 |
| A13 | passed | 四平台 native、全新安装、固定 npx、纯 MCP、重启恢复；最低 OS/物理 x64 未实测 |
| A14 | passed | Host 来源/时序反例 + OPPO 旧/缺证据及错误预期；真实 POS 音频/外设不在本次业务验收内 |
| A15 | passed | compact 已知状态/false/未知、前台与观察窗口回归及 OPPO 实测；低端硬件性能 not_run |
| A16 | passed | 候选 CLI/MCP/Runtime、仓库消费脚本、OPPO/iOS SDK 0.4.0 已核实；全局入口及外部依赖的实际升级作为发布后的独立步骤跟踪 |

## 客户端、iOS 与升级入口

真实 Codex Desktop app-server `0.155.0-alpha.9.2` 加载候选 0.4.0 MCP：实际
工具目录保留 required `command/extract`、nullable 及三路 oneOf；null、regex、
JS、Python 四次实际调用通过。使用临时客户端配置，不创建用户任务，不把这项
当作 LLM 是否主动选取 extract 的行为研究。Cursor 3.21.13 在独立工作区调用
`aab-040-acceptance`：实际工具缓存保留 required / oneOf / null，两种语言可用；
null、regex、JS、Python 成功，故意抛错返回 execution.ok=true / extraction.failed
及 MCP isError。独立审核将五次请求及完整响应与 Cursor 原始会话数据库逐项
比较，并以相同 toolCallId 对照错误日志，全部一致；安装目录 195 个包文件与
候选 tarball 一致。`initialize.serverInfo.version` 未向模型暴露，身份改由真实
进程路径、包版本和文件比对证明，不影响本项。新项目服务需先在 Cursor 的 MCP
设置连接；旧全局 0.3.8 服务仍可见，应按项目 namespace 区分。提示词与回执分别
归档为 `CURSOR_ACCEPTANCE_PROMPT.md` 和 `aab-m4-cursor-client/acceptance/`。

Kiwix 原安装因签名/开发者信任拒绝启动。Xcode 恢复后用户登录账号；专用原生
sample 构建成功，但设备已有三个免费开发 App，安装被系统明确拒绝。没有删除
Kiwix、Flexify 或 WDA，而是重建并覆盖同 bundle 的 Kiwix。
官方固定上游源码和 CoreKiwix 13.1.0-4 下载已校验，0.4.0 SDK 签名构建和安装成功；
新包 codesign 校验有效，描述文件匹配当前设备，有效期至 2026-09-26。
首次启动返回明确 `ios_app_launch_rejected`，用户确认手机显示“不信任的开发者”。
用户完成信任后，公开 launch 和 status 已通过：实际 SDK 0.4.0，进程 3199，
epoch `40AE7581-7DC5-45E2-84D2-AC72F2070BC0`。截图显示原有 freeCodeCamp 阅读页面。
最终候选包的真实 MCP 完成 null、JS、Python、regex、tree、原文回读和预期提取
抛错后恢复，共 3 个设备查询、7 个 ref 读取、0 个设备变更调用。两语言结果与
同一原始快照一致。停止本次 Runtime 后再启动新进程，只读原 ref：100346 字节
正文超过默认 98304，正确交付原 ref，再用 Python 取回摘要；两个读取没有设备查询。
见 `aab-m4-ios-mcp-r2/report.json` 与 `retained-report.json`。第一版验证夹具把
MCP 的显式 `isError:false` 错误期待成字段缺省，修正夹具后重跑，原失败日志保留。

系统全局 CLI 及用户既有 MCP 配置仍指向 0.3.8。0.4.0 的验收使用隔离候选入口，
不宣称旧进程已经升级。外部项目的依赖升级尚未执行；用户已授权发布后更新，POS 不做业务/设备流程。
npm、JitPack、pub.dev 和 Git 远端均未发布。用户已授权全部验收通过后发布并更新
相关项目依赖；npm 登录已恢复，GitHub 账号可用。公开坐标的发布后解析仍属于实际发布步骤。
发布顺序、调用方迁移及客户端重连见包内 [RELEASE](../desktop/ai-app-bridge-cli/docs/RELEASE.md)。
