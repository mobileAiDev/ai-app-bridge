# Bridge 开发主线与本轮结果

更新于 2026-09-07，分支 `codex/script-intent-isolated-rebuild` 的开发工作区。

## 当前目标

交付对象是 AI App Bridge：Intent 支持日常操作和探索，并保留可分析的证据；Agent 根据已验证的步骤和业务预期编写 Script，进行重复回归。NotallyX 用于检验这些能力在复杂真实 App 上是否成立。

后续工作按 Bridge 的可复用能力缺口决定，不以 NotallyX 功能清单的完成率决定。此前 sample 文档中“下一轮附件恢复、App 加密导出、权限取消”等功能扩展建议不再作为默认执行计划。只有迁移引入的缺陷或阻断 Bridge 验证的问题才需要改 sample 业务实现。

本轮停止套用 `ai-app-bridge-use` 与 `evidence-driven-qa` Skill。前者的本机副本缺少当前 Intent / Script 指引，仓库两份内容也有差异；后者是 App 功能验收流程，不能作为 Bridge 开发期逐页扩展任务的依据。开发以当前源码、接口契约及对应测试为准。

## 本轮交付

新增 `desktop/ai-app-bridge-cli/scripts/validation/script-contract.js` 和真实 Node 场景文件 `script-contract-scenario.js`，使用公开 stdio MCP，不注入 FakeHost，不通过 batch 代替 Script。

入口要求显式指定 server、serial、package 和新输出目录。它没有 NotallyX 业务依赖；测试目标变化无需修改场景源代码。使用说明见同目录 `script-contract.md`。

本轮没有修改 Bridge 生产逻辑或 sample App 源码。新增的价值是把原先分散在测试、临时 controller 和业务回归中的关键边界，变成可重复执行的公开入口契约检查。

## 实测结果

设备为 OPPO PGFM10，Android 16 / SDK 36，serial `FYZLAU49X8OVQGJ7`。目标 `io.github.mobileaidev.notallyx.sample`，status 返回版本 `7.11.2-aab-baseline`，Bridge `0.3.0-rc.1`。实际 server 是当前仓库 `desktop/ai-app-bridge-cli/bin/mcp-server.js`；本轮不是已安装全局连接器的验收。

最终运行 `build/ai_app_bridge_artifacts/bridge-contract-2026-09-07/r3/`：**17/17 项契约检查通过**，8 个 operation，3.877 秒。执行了两个独立 MCP 进程，Node 子进程退出和 Host 退出后的恢复均使用生产 provider。r1 是首轮 16 项运行；r2 加入持久记录复核；r3 加入目标 serial 的响应核对并验证最终控制器，前两轮记录均保留。

离线核对了 110 个产物文件和 73 个运行时 `bin/` 文件的 hash，冻结的控制器与场景均匹配当前源码。复核结果为 `build/ai_app_bridge_artifacts/bridge-contract-2026-09-07/r3-archive-review.json`。

- `r3/report.json` SHA256：`a6b920de8acedf83aebcd591a596a868297d1ac29acedde37c9dc916e601aed0`
- `r3/archive-manifest.json` SHA256：`bb864890551ba78b95e9b44fc4ac305b992f38b026c0e88018cf909181e5cfe1`

```sh
node desktop/ai-app-bridge-cli/scripts/validation/script-contract.js \
  --server desktop/ai-app-bridge-cli/bin/mcp-server.js \
  --serial FYZLAU49X8OVQGJ7 \
  --package io.github.mobileaidev.notallyx.sample \
  --out build/ai_app_bridge_artifacts/bridge-contract-2026-09-07/r3
```

复跑需要更换为未存在的输出目录。两份 JS 语法检查通过；缺少目标/server/输出参数时入口拒绝启动；没有因本轮增加开发脚本而重复构建 App 或扩大整 App 功能测试。

| 验证方向 | 观察到的结果 |
| --- | --- |
| 成功与失败区分 | 同一条 Script 可以 completed，同时明确记录设备断言 2 passed、1 failed、5 inconclusive；另有 1 个独立代码 passed |
| 证据边界 | 缺失、篡改、跨执行、错误流、动作前旧证据均被拒绝；重新读取后可通过 |
| 取消 | 等待 Agent 时取消，后续动作未派发，新 Script 可以执行 |
| 重启语义 | completed / cancelled 不可重放；none 策略显示 runtime_lost 且不可恢复 |
| 副作用保护 | checkpoint 之后已有动作时返回 ambiguous，不自动重放 |
| 恢复接线 | 子进程退出与 MCP 退出均可按显式 checkpoint 恢复真实 provider；旧 observation 变为 inconclusive |
| 持久记录 | 关闭后的副本重开两次，34 条 envelope 校验通过；8 个 operation 总计恰好 7 次 launch-app，未重复派发 |

17 项是契约检查数，8 个是 operation 数。耗时是这组短开发检查的时间，不是整个 App 的回归时间。原始失败断言仍保持失败，不能把检查负例符合预期解释成业务全部通过。

## 仍需推进

1. Intent → Script：评估 Agent 仅凭保存的观察、动作、目标、前后状态与证据引用，能否重建一个可复用流程；把实际缺失的信息补进 Bridge 接口。
2. 对尚未经过公开入口实测的边界补针对性用例，例如执行设备动作期间取消、传输中断及证据淘汰，避免反复扩大 sample 功能范围。
3. 开发接口稳定后对齐包、Skill 和客户端入口，完成独立安装路径验证。当前会话已挂载连接器的 `capabilities(script)` 仍返回 `unknown_command`，与当前仓库 MCP 的可用能力不同。

本轮不覆盖完整 App 功能、Intent 全流程、Python 恢复、iOS、物理拔线或断电。当前 Skill 和全局 MCP 配置没有被自动替换。

## 阶段提交与完成度判断

本次 Git 提交保存这一阶段累计的 Script / Intent 运行时、CaptureStore、证据与恢复修复、真实 NotallyX 样例及验证工具。它是开发阶段快照，不是发布操作。

Android 主链路的大部分核心能力已经跑通，当前处于可内部试用、已有复杂 App 实证的阶段：

| 能力 | 已有证明 | 距离最终目标的差距 |
| --- | --- | --- |
| Intent 日常操作与采证 | 真实 App 的编辑、列表、标签、备份探索记录，动作与独立结果关联 | 证据整理仍有场景辅助脚本，尚未证明干净上下文仅凭公开接口和证据就能稳定复现 |
| Script 连续回归 | 真实 Node 子进程、多阶段业务流程、进度、当前证据与独立判定 | 可复用脚本已存在，但跨 App 套件组合和生成后反复运行的稳定性还需验证；Python 真机范围单列 |
| 证据与执行可靠性 | 新旧证据区分、明确失败/证据不足、取消、checkpoint 恢复和持久重读 | 动作进行中取消、传输故障、更多淘汰/丢失边界仍需公开入口实测 |
| 交付与可用性 | 本机独立目录安装已验证部分能力 | 当前全局连接器与开发版不一致；尚需最终包完整真机验证、入口/文档对齐及干净环境复现 |

不以 App 的 143 个模板或某轮通过数量推算 Bridge 完成百分比。更有用的完成标准是三个验收关口：独立证据复用、跨流程/跨 App 稳定性、完整安装交付。整机回归放在 App 套件可独立复用之后组合建设。

### 下一轮优先任务

选一个现有 App 中尚未固化过的流程，使用 Intent 完成操作并保存完整来源证据。随后在不依赖原编写过程隐含信息的上下文中，仅根据公开接口文档、保存的证据和业务预期编写 Script；沿用同一份初始夹具重复运行三次，再做错误期望与取消两个负向检查。

接受条件是：本轮目标、前置状态、定位依据、业务结果和证据引用都可追溯；三次结果可独立复核；负例不能被报告为业务通过；分别记录探索/编写成本、执行耗时和人工介入。出现缺口时修 Bridge 的通用信息或接口，不为样例增加业务功能。无需先建设自动 Intent→Script 编译器。

### 提交前检查

- 当前 Host 全量重新执行：`npm test -- --test-concurrency=1`，647/647 通过，日志 `.tools/commit-stage-2026-09-07/host-test.log`。
- 验证工具重新执行：`node --test examples/notallyx-sample/validation/test/*.test.js`，74/74 通过，日志 `.tools/commit-stage-2026-09-07/validation-test.log`。
- 从 Git 暂存区导出的干净目录再次执行同一验证工具套件，74/74 通过；729 个来源证据输入的暂存 blob 与 manifest hash 一致，完整来源文件已进入提交。
- 最新真机契约证据：上述 r3 的 17/17 检查；本次提交前未再重复操作手机。
- 已有 Android SDK 测试 XML 为 114/114，App 为 212/212，均无失败；这是此前构建的证据，本次提交未重新构建 App。
- NotallyX 保留原始许可证、源码归属与实际测试所需资源；上游发布混淆产物排除在提交外。
- 来源证据包的截图、日志与嵌套路径原先会被根忽略规则排除，现明确作为冻结回归输入纳入，避免新检出缺文件。运行时 build 证据与本机配置继续留在 Git 外。
- 暂存区空白检查保留了 5 份上游导入文件原有的行尾空格/末尾空行提示，其余开发文件通过；未为格式提示修改样例业务源码。原有 `flutter/ai_app_bridge_flutter/pubspec.lock` 不纳入此阶段提交。
