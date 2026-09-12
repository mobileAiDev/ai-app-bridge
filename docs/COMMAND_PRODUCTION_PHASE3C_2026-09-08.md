# 命令生产化第三阶段 C：普通 Intent 生命周期与持久恢复

本阶段完成普通 Intent 的总执行预算、取消收尾、终态落盘和重启后查询。最终源码通过 822 项 Host 测试、干净 npm 安装与 MCP 验证，以及已授权 OPPO 的四项生命周期验证。当前全体系生产化目标仍在推进；本阶段没有扩大样例 App 功能，也不代替四 App 完整回归或跨平台验收。

工作分支为 `codex/script-intent-isolated-rebuild`，HEAD 为 `4da58fac5a9f8e522e85f7aa2f23cea195d75f95`。前序阶段和原有未提交文件保留；本阶段没有提交、推送或发布。

## 本次改变的行为

- 普通 Intent 的 `timeoutMs` 默认 300000 ms，从初次观察前开始，包含等待决策、暂停、Agent 回复、动作及再次观察。共享执行作用域将同一截止时间和取消信号传给 Provider I/O。嵌套调用不能延长预算。
- 取消先进入 `cancelling`，阻止新派发并中止已拥有的 Provider 工作；等待 I/O 和证据写入完成后，再提交唯一终态检查点。其他终态先进入 `finishing`。检查点失败报告 `blocked_evidence_store`，不会显示完成。
- 取消与初次观察、动作后观察、决策提交或终态持久化交错时，迟到结果不能恢复运行。已受理但结果不明的动作保留回执及 `lastAction.dispatched/ambiguous`，回执先于终态落盘。已完成的终态不能被后续取消改写。
- 自动模式暂停会使旧 Agent 回复失效，恢复后重新取得决策；被拒绝的暂停不改变内部执行状态。Agent 必须明确提交 `basedOnRevision`，运行时不再替它补齐。Agent adapter 收到 AbortSignal；其外部计算仍需要 adapter 协作停止。
- MCP EOF/SIGTERM 先关闭 Intent 接收入口，取消并等待进行中的 start/decide 请求和异步工作流创建，然后关闭 Host Store。未完成创建的工作流也计入 256 项容量，不能在关闭后开始安装。
- `intent status` 在重启后从持久 Host 证据读取并核验校验和，返回 `live:false, recovered:true, restartPolicy:"none"`。存在终态检查点时恢复结果；只有过程证据时报告 `interrupted/runtime_restarted` 及未配对动作标记。不会自动重放，也不能复用仍有证据的 operationId。缺少 operationId 和真实存储读取失败均明确报错。
- 安装、权限仍由各自的独立结果核验器决定结果。新增通用收尾不能覆盖安装物或权限事实。安装在提交前取消时，会等待已启动的身份查询，阻止后续安装提交并释放设备占用。

公开合同见 [COMMAND_CONTRACT.md](../desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md)，93 个命令的机器合同见 [本阶段快照](audits/2026-09-08/command-contract-phase3c.json)。仓库及发行包内的 Skill 已同步。手机 logs/network/state/events 的 live 查询权威未改为 Host 历史副本。

## 验证与产物

### Host 与进程验证

最终 `npm run check`：**822/822**，无失败、取消或跳过，耗时 **15687.070583 ms**。日志为 `build/phase3c-full-release.log`。

新增验证覆盖初次与动作后观察取消、决策和终态写入交错、证据写入失败、真实子进程强制回收、Agent 迟到回复、暂停/恢复、缺失 revision、空闲超时、持久终态恢复、缺失终态的不确定动作、读取失败、缺失 operationId，以及 256 个尚在创建的工作流的容量与退出行为。原 100 轮生命周期验证保留并适配总预算合同。

MCP 测试在 `intent start` 和 `intent decide` 请求尚未返回时分别触发 EOF 与 SIGTERM。受控 ADB 是实际子进程，并故意忽略 SIGTERM；验证确认进程被回收、MCP 正常退出、动作回执早于终态落盘。另一个 MCP 进程读取同一持久 Store，恢复取消结果并验证归档。已受理动作的回执保持 `dispatched:true, ambiguous:true`。

### 干净安装包

最终目录：`build/ai_app_bridge_artifacts/command-production-phase3c-package-accepted-2026-09-08/`。

- tarball SHA-256：`d4cd74d437de34a7a505d51e48c0ffacbd15335201e6103ddeca7ac88aad5e6a`。
- 在仓库外干净目录执行真实 `npm install`；本地原生依赖安装生命周期和 node-gyp 编译成功。
- 安装包提供两个 MCP 工具、93 个公开命令。86 个非依赖文件与当前源码逐字节一致；npm 标准化的 package.json 单独排除，详见 `source-match.json`。
- 结构化 Script 回复、权限四种结果、JS/Python 退出收尾、权限取消和本次 Intent 退出/重启验证均通过。此处 ADB 为受控 Provider，不算手机业务验收。

### OPPO 真机

最终目录：`build/ai_app_bridge_artifacts/command-production-phase3c-2026-09-08/device-packed-accepted/`。运行的是上述干净安装包的 MCP，控制器源码和 SHA、MCP JSONL、每次结果、截图、前后独立数据及归档均保留。

设备为用户授权的 `b46093e6` / `PKR110`，当前系统 brand 为 OnePlus。App 为 `io.github.mobileaidev.notallyx.sample`，安装 APK SHA-256 仍为 `ecf83a99cd3875fad0755e8254f1b31aaf2e56c84f9735f0e49830957fff623c`。

| 场景 | operationId | 实际结果 |
| --- | --- | --- |
| 新鲜 native 观察后完成，不执行动作 | `lifetime-normal-1788878992227` | completed；终态持久化；随后 cancel 不能改写结果 |
| 初次 UIA 观察进行中取消 | `cancel-1788878992406` | cancelled；本轮取消响应 4 ms；对应 Host ADB PID 74160 已退出；无观察发布或动作回执 |
| 等待决策耗尽 1500 ms 总预算 | `lifetime-idle-1788878992566` | timeout / deadline_exceeded；1617 ms 时查询确认；无设备动作 |
| UIA 观察进行中关闭 MCP stdin | `shutdown-1788878994183` | 正常退出；Host ADB PID 74235 已回收；重启后从 Store 恢复 cancelled |

四项结果均由新 MCP 进程从磁盘恢复。四份归档复制到新路径后，在不可用 Host Store 路径和不存在的 ADB 配置下离线核验，全部 `integrity:verified`。本轮 4 ms 是一个真实取消样本，不是 P95 或普遍延迟承诺；1617 ms 是验证查询时刻，不是超时计时器精确触发时刻。Host 子进程回收不能推出 Android 已受理操作被撤销。

独立读取的偏好 SHA-256 前后相同：`f64cff3558d9812cb1233c5915d4f8ee3ecfb62b92355641d5a896288cd5e196`。数据库主文件及 WAL 被读取到本地后，查询所有业务表并规范化比较，SHA-256 前后同为 `16090377a96644cacb5f82f11f257d7479573652efd4463d448a07676a11db21`；BaseNote 11 行、Label 11 行，其他表也一致。前后截图已检查，仍在同一设置页面、系统主题，未改变业务数据。截图文件并非逐字节相同，不用图片哈希替代业务校验。

## 保留的失败与验证范围

早期针对性测试暴露旧的同步 cancel 预期，以及测试断言提前退出、未释放受控 gate 的夹具问题；相关失败日志保留。首次 MCP 验证脚本错用了历史字段 `entries`，已按实际合同改为 `items`。一项中断恢复夹具遗漏 dispatch-marker 的必需字段，已补齐。

首次全量结果为 812/818：六项旧预期分别涉及终态决策没有 revision、外层 isolated timeout 的静态/行为断言，以及同步取消和零毫秒超时。旧的“调用者超时后运行继续”的合同已被移除，测试改为验证运行时拥有总预算并等待收尾。没有通过降低结果标准保留该行为。

中间通过的 818、821 项测试和候选包均保留。最后复核补了自动模式 revision、暂停标记、异步创建容量及缺少 operationId 的查询边界后，重新完成 822 项全量检查、最终打包和四项真机验证。正式结果只取 `phase3c-full-release.log`、`package-accepted` 和 `device-packed-accepted`。

本阶段证明生命周期与证据链，不是全 App 业务回归。Live Intent 的进度仍有内存状态及有界 ledger；重启查询有真实磁盘依据，但尚未完成全命令存查性能与淘汰语义验收。终态落盘需要等待实际写入，不能把无法中断的持久化承诺成硬时限。安装准备阶段整体预算、更多 ROM/权限组、强制杀进程与断电、多进程设备占用、SDK 原子目标验证及 iOS/Web 同义实现仍需后续关口。

下一阶段统一各 operation 分支及嵌套参数：明确 target、decision、selector、budget、Script spec 的必填、互斥、枚举、边界及报错，移除遗漏字段被隐式补齐或忽略的路径；以完整命令清单核对，不按零散案例推进。
