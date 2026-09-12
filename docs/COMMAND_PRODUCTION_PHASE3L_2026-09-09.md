# 第三阶段 L：Android shell 结束凭据、未知恢复与有界留存

Android 物理输入和 UIA 动作现在使用手机端原任务完成凭据。Host 取消、响应丢失或进程死亡后，未确认的任务继续阻止后续写操作；取得相同任务的结束证明后才恢复。Intent、Script 和必要的普通命令共用这条执行路径。本轮通过 OPPO 真机、干净发行包、独立业务数据与离线证据核验，未修改样例 App 业务。整个体系仍在生产化推进中。

## 实现与合同

- 新增 `aab.android-shell-execution/v1`。准备阶段固定 actionId、随机 jobId、Android boot ID、命令 SHA-256 和手机单调时钟准入期限。Host 在实际启动前同步保存原任务身份，手机分离进程等待原命令退出后原子写入回执。
- 取消与 worker 争夺一次性准入。取消先到或期限已过时不执行命令；已经准入的命令自然收尾。杀死 Host/ADB 客户端不作为远端结束证明，也不使用 PID 信号猜测原任务是否已停。
- 恢复通过公开 `device-ownership reconcile`，使用已保存的 serial、ADB 路径和原任务身份。错 boot、错命令、缺失任务、尚未收尾均继续阻断，不换目标、不重放、不按时间过期释放。
- 手机任务位于 `/data/local/tmp/ai-app-bridge-shell/v1`。stdout/stderr 各受 shell 文件上限约束；本机验证为 64 KiB。最多保留 512 个未确认目录。准备过程持锁，仅回收已确认目录；未知记录不能为新任务让位。
- 正常执行在读出输出、Host 所有权日志同步写入原结束凭据后才确认手机副本。确认失败保留副本，不推翻已知的结束结果。未读取输出、准备后遗留和恢复取得的任务仍保留，自动安全退役尚未实现。
- Android 物理 tap/swipe/keyevent、UIA 动作、应用启动、pm-clear、权限夹具、app-ops、进程信号和 logcat 清缓冲接入共享 shell 端口。权限系统 UI 原先遗漏的 mutation 标记也已补上。选中的 Native/Flutter SDK 路径保持其各自执行协议。
- Intent 保留适配器派发保护，再由实际传输记录接管原任务身份。仅 Host 观察、准备或退出前检查不再生成虚构的远端 `host-call` 待恢复项。未携带派发元数据的 `ok:false/error`，例如 H5 超时，不能被当成确定结束而释放占用。
- 普通错误归一化、执行历史、Intent/Script action-receipt 保存 `executionReceipt`；多次物理操作的 `executionReceipts` 数组在普通历史和 Script 中保留。已确认命令退出但输出读取失败返回 `shell_output_unavailable`，仍携带原结束凭据。

公开入口仍为 95 个，见 [3L 机器合同](audits/2026-09-09/command-contract-phase3l.json)、[命令合同](../desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md)、[Script 合同](../desktop/ai-app-bridge-cli/docs/SCRIPT_AUTHORING.md)和 [Intent 前台合同](../desktop/ai-app-bridge-cli/docs/INTENT_FOREGROUND.md)。`logcat clear:true` 现在返回带执行字段的对象，读取仍返回文本。

## 验证范围

证据根目录：`build/ai_app_bridge_artifacts/command-production-phase3l-2026-09-09/`。

设备为 `FYZLAU49X8OVQGJ7 / PGFM10 / OP528F / API 36`，boot ID 为 `255c2c42-88b7-4b49-b442-5b18ba12a0be`。使用已安装的 `io.github.mobileaidev.notallyx.sample`，APK SHA-256 为 `ecf83a99cd3875fad0755e8254f1b31aaf2e56c84f9735f0e49830957fff623c`；本轮 UIA 验证不依赖重新构建 SDK。本轮未修改、构建或重跑 Android/Flutter SDK 测试，不能把上一轮的 SDK 通过数计入本轮。

基线 HEAD 为 `4da58fac5a9f8e522e85f7aa2f23cea195d75f95`，开始时保留 214 个修改/未跟踪文件的哈希。没有提交、推送或发布；未操作非 OPPO 设备。

| 检查 | 结果与证据 |
| --- | --- |
| Host 全套 | 938/938，0 失败/取消/跳过，27048.130959 ms；`logs/host-all-second.log` |
| 干净发行包 | 新目录 npm 安装、原生依赖生命周期及 node-gyp 编译、95 项能力、JS/Python、Intent、权限、取消退出及重启合同通过；`package-final/report.json` |
| 发布物逐字节核验 | 102 个文件：96 个非依赖发布文件、6 个随包依赖；源码、tarball、干净安装内容一致。87 个 bin 运行时文件与真机测试安装包一致；`package-source-verification.json` |
| 手机 shell 协议 | 引号/Unicode/换行、准入前取消、准入前过期、执行中取消后自然完成、非零退出共 5 场景；错命令/boot/重复启动拒绝；`port-final/summary.json` |
| Host 崩溃恢复 | 原命令运行中 SIGKILL；活跃 owner 阻断、死亡后未知阻断、提前恢复仍 pending、原任务收尾后恢复；独立文件仅一行 `once`；`shell-recovery/report.json` |
| 输出与留存边界 | 输出实际限于 65536 字节、exitCode 153 且有完成凭据；仅回收已确认目录；512 目录时新任务未准备/未派发；移除本测试自有空目录后恢复执行；`shell-bounds/report.json` |
| 公开真实 App 流程 | Intent 打开搜索并返回列表，再按其已观察的 selector 编写 JS/Python 同义流程；三者完成，每条保存 3 份 shell 凭据；`app-flows-verified/report.json` |
| 独立业务结果 | 真实数据库 integrity_check 通过，所有 SQL 表及偏好前后相同；`business-state-verification.json` |
| 持久查询与离线核验 | 新进程从真实分段 FactStore 按原 actionId/target 查回恢复调用；5 份归档重开存储导出，搬移后在禁用 ADB、原存储不可用时全部 verified；`offline/report.json`、`offline/recovery-disk-proof.json` |

真机测试包 tarball SHA-256 为 `c9fab22b9107ed9cc6ac2a6cf2063a96d729d4b0914118166999ca5adb8173c4`。补齐发布文档后的最终包为 `f7a3830280bc4f9f89a00c70767d9537dd27676bf17a940f8886ac3019d78508`；其运行时与真机测试包逐文件一致，最终包另做干净安装合同验证，没有把文档变更当成需要再次操作手机的代码变更。

## 原任务恢复与独立证据

原任务 actionId 为 `original-shell-recovery`，jobId 为 `7fd00985-17db-4b7a-9c38-e76ac2a75dff`。受控 Host 子进程调用干净安装包内的真实 managed executor，在手机私有验证文件追加 `once` 后等待，再输出 `command-finished`。原 Host 在等待期间被 SIGKILL；手机任务继续运行。

公开 MCP 在 owner 存活时返回 `target_busy`，Host 死亡后返回 `device_ownership_unresolved`。提前 reconcile 仍为 `shell_action_not_settled`；取得原匹配终态后回到 idle。原文件只有一次追加，输出和原 wire receipt 单独保留。恢复结果的摘要与手机原 JSON 一致，新进程从分段 FactStore 取出的 executionReceipt 也一致。原动作没有重放。

这是“真实手机 shell + 已安装执行器 + 公开恢复”的故障验证。原命令由受控子进程发起，并非公开 App 业务命令；它与三条公开 App 正向流程分别记录，不能互相冒充覆盖。

NotallyX 前后 SQL SHA-256 均为 `7f455bb4881e87dd1b2398eebe2ba2a4a2162f21506c020a8ba9dc5222063446`，偏好均为 `f64cff3558d9812cb1233c5915d4f8ee3ecfb62b92355641d5a896288cd5e196`；BaseNote 10 行、Label 11 行。三条流程的搜索页与恢复列表截图分别核看，UI 树核验主列表/搜索框/抽屉按钮。此结果只证明本轮打开搜索和返回、业务表及偏好未变，不是完整 App 覆盖。

5 份离线归档包含 3 条通过流程和 2 次保留的失败，共 15 份 shell 凭据，其中通过流程 9 份。失败归档中的已执行动作保留真实凭据，流程本身不改写为通过。UIA 的 actionId 关联手机 shell 任务，不代表 App SDK 产生了关联业务事件。

## 保留的失败与限制

- 第一轮设备尝试使用不适配 Android mksh 的 flock 文件描述符，准备阶段失败、未执行目标命令；改用该非交互 shell 继承的 stdin 锁后真实协议场景通过。引号编码和 `%s` actionId 等边界保留了实际回归。
- Host 中间失败来自尚未迁移的受控 ADB fixtures 和 Intent context 预期，以及验证辅助程序语法错误；修正后全套 938 通过。协议模拟器仅用于 Host 测试，真实 worker 行为由真机证据验证。
- 首次发行包验证撞到此前受控假 serial 留下的全局未知记录；未删除这些记录。验证工具改为每轮独立所有权目录，后续干净包通过。
- 第一轮 App 流程发生前台变化，后续决定被 `reobserve_required/dispatched:false` 拒绝。按用户要求停止锁屏专项排查。第二轮控制器仅以“搜索”按钮判断首页，误认笔记详情页，最终返回列表断言失败。改为必须存在 MainListView 和抽屉按钮，重新观察实际首页后完整跑通；未改 App 或绕过前台保护。
- 文件配额试验使用本控制器创建的 499 个空目录，加上 13 个原有未确认目录到达 512 上限。只用逐一 `rmdir` 清理这批精确记录的自有空目录，原未确认记录保持不变。

## 下一关

本轮解决 Android shell 进程层的可确认结束及未知恢复。它不证明 PackageInstaller、Activity 启动后的异步工作或其他 Binder 服务已完成业务；UIA 也仍缺少 SDK 那样的手机端原子目标绑定。

接下来优先完成 H5 普通 HTTP 的排队/执行/超时结束合同，以及安装任务的 PackageInstaller 结束身份与故障恢复。普通历史写入失败策略仍需明确。shell 准备后遗留/未读取输出/恢复任务的安全退役、worker 准入后内部准备失败的明确终态和清理错误的完整公开传递继续保留为缺口。

CDP 与通用 SDK HTTP 的未知结果已保守阻断，但缺少各自可核验的原结束协议；不能据此称为已支持恢复。其他 Android 版本、serial 别名、其他 Host OS/Node、iOS/H5/Web 持久查询、原四 App 固定覆盖与长时间压力/性能门禁继续按总计划推进。
