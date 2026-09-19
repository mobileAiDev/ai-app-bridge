# Host 0.4.0 使用后问题复核与修复

2026-09-19。审核基线为 `447b2a2`，修复在 `codex/host-040-audit-fixes`。
结论：两个真实缺陷，其中 iOS 的归因需要修正；第三项符合现有合同。
修复现已随统一 0.4.1 对外发布，见 [0.4.1 交付记录](RELEASE_HANDOFF_0.4.1_2026-09-19.md)。
旧 npm 0.4.0 归档保持不变；以下保留发布前复核的过程与证据。

## 1. iOS 观察控制留下无法恢复的 ownership：成立，P1

现场共享 journal 中确有 `kind:ios-command, command:ios-ui-observation` 的
pending 记录；它阻止同一 iPhone 后续写入，与 App 是否相同无关。
本地真实 Host/HTTP 路径也复现：观察控制返回 `ui_observation_lease_mismatch`
后，ownership 变为 unresolved，后续 H5 动作未派发。

需要修正两处归因：

- `device-ownership` 的公开目标本来就是 Android；iOS 应调用 `ios-execution`。
  `ios-execution reconcile` 会进入 `reconcileIOS`，不是被同一把锁挡在入口外。
  此记录缺少 devicectl invocation，实际恢复错误为
  `ios_original_command_identity_unavailable`。
- pending journal 持久化在共享目录，重启 Runtime 本身不清除它。
  不新增通用 force-release，也不把重启写成恢复办法。

根因是把限时观察采集控制当成物理设备动作。修复后，iOS 观察控制由 SDK 的
100–5000 ms 租约管理，不创建物理动作 ownership，也不把其 HTTP 请求计为
外层 UI 动作已派发。明确的 SDK 拒绝和响应丢失都不会阻断后续 UI 写入。

对于旧 Host 误记的上述特定 marker，显式 reconcile 在校验原 device 和调用方
给定的 bundle 后清理；回执保留 `observationOutcome:unknown`，不声称观察启停
成功。未知 launch/H5/Flutter/WDA 动作仍必须提供原完成凭据，不能借此释放。

## 2. 临时目录 cleanup 覆盖提取结果：成立，P2

故障注入使 worker 已返回 `42` 后的 `rmSync` 抛出 EACCES，原代码将结果改为
`ok:false / extraction_cleanup_failed`，与报告所述一致。它也会覆盖原始提取错误。

修复将清理错误放入 `extraction.cleanupError`，保留原提取状态、成功值或原始
异常及对应退出码，并正常释放 worker 槽位。原动作不重放。

## 3. 超预算返回 output_budget_exceeded：不成立

冻结的 [公共合同 §5](IMPROVEMENT_RELEASE_V1_CONTRACT.md) 明确要求：正文超限
时省略 inline value，保留 execution/control 和真实 source ref，报告
`output_budget_exceeded`、attemptedBytes、limitBytes。执行成功而交付超限时，
`failureStage:delivery` 正是用于区分这两个事实。

用约 35 KB 的 tree 响应和 16 KiB 预算复现了同一组字段；该用例在修改前后均
通过合同断言。提取错误、执行错误仍由各自字段与首要 failureStage 表达，不能
仅凭 delivery.reason 的超限值判定它们丢失。本轮不修改 public-reply.js。

## 验证与当前交付边界

| 检查 | 结果 |
| --- | --- |
| 最小复现 | 修改前两个缺陷失败、预算合同用例通过；修改后三项通过 |
| 新增回归 | 3 项先失败后通过；覆盖成功/失败提取清理、native/Flutter 观察拒绝与响应丢失、旧记录恢复及禁止清理其他动作 |
| Host 全套 | 1328 功能 + 50 串行性能 = 1378 passed，0 failed，0 skipped |
| 真实 iPhone | 原旧 marker 显式恢复成功；错误 observation lease 被拒绝后，Kiwix launch 成功，最终 ownership idle |

真机目标为已连接的 iPhone 17 Pro Max / iOS 27.2 和
`io.github.mobileaidev.kiwix.sample`。使用修复源码启动的独立 Runtime；未重启
原全局 Runtime，未重放旧观察请求，launch 明确使用 terminateExisting=false。
复核结束时独立 Runtime 已停止，全局发布入口当时仍是 0.4.0；随后统一发行
0.4.1 时已更新全局 CLI 与 Runtime，并另外验证新建 MCP 连接。

原始日志和现场记录保存在
`/Users/macbook/Documents/CompanyProject/ai-app-bridge-review-evidence/0.4.0-grok-2026-09-19`，
结构化结果见其中 `report.json`。不将其他应用启动、签名、WDA、前台竞争或
业务场景的失败归入这两个 Host 缺陷，也未在本轮重新验收这些其他问题。
