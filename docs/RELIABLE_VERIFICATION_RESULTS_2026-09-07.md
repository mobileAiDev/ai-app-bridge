# 路线收敛与 0.3.0-rc.1 验证结果

日期：2026-09-07。分支 `codex/script-intent-isolated-rebuild`，基础 HEAD `eec151b04daabdd2df2897c67cc8a669e235e731`，包含原有和本轮未提交修改。此报告的包、APK、AAR 和证据快照确定实际受测内容；没有执行 commit、push、npm/Maven 发布。

## 结论与后续选择

继续采用“稳定设备桥 + 可选 Script + 可靠证据接口”。本轮把原型中的关键生产断点补齐，并形成可内部试用的 Android RC。现有 batch 和普通脚本仍是合理入口；Intent 作为外部 Agent 的探索协议，不要求所有任务都经过 Intent 再生成 Script。

实测没有显示 Script 的速度优势。后续投入应优先放在可靠观察、明确失败、可重读证据、实际项目中的长流程控制和恢复。暂不同时扩展端侧 OCR/模型、消费者助手或另一套存储引擎。正式推广前，优先把该 RC 接入一个实际业务 App，按新验收方式完成包含业务失败、弹窗、列表、重试和后台状态的完整流程；再扩机型和 iOS。

## 已完成的关键修复

- 生产入口移除 Fake 默认路径，真实 JS/Python 子进程经原设备桥执行；恢复保持冻结源、目标和权限。prepare/receipt/terminal 写入顺序与取消/超时边界有回归；未知副作用不能自动重放。
- 设备断言只接受 Host 签发的当前观测，代码断言独立统计。旧/伪造/缺失/部分证据不能通过；Host 仅保留最多 128 条、256 KiB 的引用元数据和 hash，不复制手机四流 payload。
- Android 四流查询进入手机持久存储，HTTP→CLI→MCP→Script/Intent 保留真实目标、窗口、epoch、分页和 ref。Intent 查询参数不能替换执行目标，也不能通过捕获读接口派发动作。
- Android 生命周期公开实际 open/attach 错误并正确处理 maintenance reopen；修复合法全零短段尾误判和分区游标读取。查询不再扫描不相关分区。
- UIA 每次读取清理旧文件、检查本次 dump 结果，避免用旧页面 XML 验收新页面。P9 scorer/fixture 也不再以 completed 默认业务全部通过。
- sample 的自动 OkHttp 请求改为读取自身 bridge 端口，避免误请求同机另一个 App。测试使用真实回环 HTTP；没有把“Record Network”手动记录当成自动抓包。

## 回归与构建

| 验证 | 结果 | 范围 |
| --- | --- | --- |
| Host `node --test --test-concurrency=1` | 583/583 通过 | 最终功能及测试源码；之后只调整了 history 能力描述，使其准确表达实测 transport error |
| Android testDebugUnitTest + assembleDebug | 113/113 通过，构建成功 | 真实 Mapped 文件、生命周期 listener、边界/负例和分区页测试 |
| Swift 定向检查 | 24 项通过 | 本机 macOS，Legacy 与新 unavailable 合同；无 iOS 真机验收 |
| 本机新目录正常 npm install | native 现场编译、关闭/重开读取、MCP、Node Script 均通过 | 安装后的纯代码断言 1，设备通过 0；无复用项目 node_modules |

Host 并行全量的一次记录中，未改动的 G3 5k summary p95 为 21.627 ms，超过 20 ms；当时同时存在构建和设备对照负载。随后串行全量通过，未放宽阈值。两份日志均保留，因此不声称高并发负载下该性能门槛已稳定满足。

## Android 真机闭环

设备 `b46093e6`，OnePlus PKR110，Android 16 / SDK 36；包 `io.github.mobileaidev.aiappbridge.sample`，实际 status 确认 SDK `0.3.0-rc.1`、存储 `OPEN`、后端 `attached`。sample APK SHA256：`d31f514ce50b91e1c8379e20c82884d8b592d09bc9a060f5195f60038df55009`。

通过真实 stdio MCP 启动 Node Script：

1. 手机时间建立前置 state 水位，真实点击 Native Increment，界面 `0 → 1`，持久 state 的 `native_test.screen.counter=1`、actionId 与当前动作一致。
2. 新 tree 与 screenshot 记录同一结果，state 和 tree 各自使用当前 Host evidence 断言。
3. 手机时间建立前置 network 水位，点击自动 OkHttp GET；实际请求 sample 自身 `/v1/logs?limit=1`，自动记录 `source=okhttp-auto`、GET、HTTP 200；界面显示 `OkHttp auto capture: HTTP 200`。
4. 4 个正向断言通过。故意使用旧树和伪造缺失证据均 inconclusive；使用有效新证据但错误 counter 期望为 failed。负例独立统计，没有改变断言门槛。

这是 sample 的真实 UI、状态和回环 HTTP 验证，不是外部业务后台、订单或支付结果验证。最终生命周期前的运行见 `.tools/implementation-2026-09-07/sample-loop-r2/`；clear 后重新完整通过见 `sample-post-clear-loop/`。原始 MCP transcript、观测 JSONL、正负断言及两张截图均保留。

### 持久引用与生命周期

`sample-lifecycle-r2/report.json` 的 6 项检查全部通过：

- 新 Host 进程按原 mobileFactId 精确读取 state/network，字段内容、captureId、epoch 和目标一致。
- 注入 225 条明确标记为 synthetic 的 HTTP 状态记录，原 UI state 从 Legacy 有界投影退出；最后连续 187 条记录可读，符合数量与字节双上限。旧 state/network ref 仍可从磁盘重读。HTTP ack 不被当成 225 条全部 committed 的证明。
- force-stop sample 后，捕获查询明确失败，未返回 Host 复制的手机 payload。实际错误保留为 `socket hang up`。此项是 App 进程停止，USB 始终连接。
- 新 Host 加重新启动 App 后，runtimeEpoch 改变；旧 epoch 的 exact ref 仍能从 connected-history 读取到原内容。
- 把旧 runtimeEpoch 用于新 decision-window 时明确拒绝。
- SDK `bridge-runtime` clear 成功，存储重新 OPEN/attached；旧 state/network ref 返回 `mobile_fact_unavailable`。随后重新跑完整 UI/状态/自动网络闭环通过，证明新写入恢复正常。

没有以 1 GB 物理磁盘填满或拔 USB/断电方式测试；物理 retention/corruption/写入失败等已有离线文件测试，不能合并成实机结论。生命周期 r1 因验证脚本错误要求固定 200 条而失败；已修为检验实际受字节预算约束的连续尾部，原失败记录保留。

## 三路线公平对照

LocalSend `org.localsend.localsend_app.debug`，同一手机、语言与现存 App 安装。流程为接收首页→通过链接接收→返回首页，每次同 11 个 provider 步骤、3 组 screenshot + Flutter nodes。每种方式 3 次，交错顺序。此流程在编写本轮 harness 前未用于其实现；先探索定位可见标签，再冻结预期和步骤进行回放比较。

| 方式 | 正向通过 | 执行耗时中位数 | 每次执行 MCP 请求 |
| --- | ---: | ---: | ---: |
| 既有 batch | 3/3 | 38.84 秒 | 1 |
| 普通 JS 调 MCP run | 3/3 | 38.78 秒 | 11 |
| Script ctx.call | 3/3 | 39.18 秒 | 62 |

27 张截图和 27 份节点树，由执行器之外的相同 oracle 验收；9 次故意错误页面期望全部被拒绝。截图文字识别只用了 Host 上的 Swift Vision QA 辅助，不是产品端侧 OCR 功能。

Script 采用 1 秒 wait，progress 也会提前返回；62 次包括这些状态请求，不能当作模型调用或模型费用。准备每次约 11 秒、OCR/验收约 1–2 秒另行记录；没有模型探索成本、生成代码成本或真实业务任务总成本测量。本表比较当前 CLI 中三种交互方式，不是已发布 Git commit 的独立性能基准。完整报告为 `localsend-comparison-r2/测试结果.md`。

r1 实际发现旧 UIA 文件造成返回首页后错误报告旧页面仍存在，失败与诊断均保留。修复读取器后重新完整运行 r2；没有删除 absent 条件、忽略失败或只选成功 trial。

## 支持范围与未完成门槛

- 当前是内部 Android RC。Native sample 新持久证据链已实测；LocalSend Flutter UI 对照使用其现存 SDK，不据此宣称 Flutter App 集成新 Android SDK 后的四流持久链已验收。
- Intent 生产接线和目标/副作用协议通过回归，未把本轮 Script sample 流程冒充完整 Intent Agent 验收。Python 有真实子进程测试，本轮真机闭环使用 JS。
- iOS 新持久强查询明确 unavailable；多页合并强断言仍未提供。只有完整单页和当前 Host evidence 可用于强断言。
- 新启动 loss fence 不会被 cursor 单独抹去；保留前置手机 `sinceMs`。磁盘 committed 代表可读，不代表每条 fsync 或任意断电不丢。
- JVM 1000 条真实盘查 p95 约 39.94 ms，旧 10 ms hot-query 门槛未通过；最大保留量和各设备的读取延迟仍需专门测量。
- 其余三 App 的旧 P9 通过不能替代本次修正后的重跑；实际业务 App、多机型、iOS 和干净机器安装属于下一阶段。

## 交付与证据入口

- 交付合同：`docs/RELIABLE_VERIFICATION_DELIVERY.md`。
- 最终 npm 包身份、现场安装步骤和 SHA：`docs/INSTALLATION_VALIDATION_2026-09-07.md`。
- Android AAR：`android/ai-app-bridge-android/build/outputs/aar/ai-app-bridge-android-debug.aar`，SHA256 `abd39709c2c8870aac313be5a9870dda2491d0baa0a677f330ca3f17088ede32`。
- 本轮原始证据：`.tools/implementation-2026-09-07/`；Android/Swift 子报告：`.tools/route-implementation-2026-09-07/android-capture/`。
- 修改前快照保存在 `before-worktree.zip`、`before-manifest.json`、`before-diff.patch`；最终文件摘要与相对本轮起点的变化见 `after-manifest.json`。原有未提交工作、未跟踪文件和 Flutter lock 保留。
