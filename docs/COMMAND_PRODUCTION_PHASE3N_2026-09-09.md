# 第三阶段 N：安装原任务凭据与普通命令历史失败合同

`install-apk` 已把一次手机安装任务、原 PackageInstaller session 与独立安装物核验连接起来。取消、超时或 Host 退出后，只有原任务的有效结束凭据能解除未知占用，不能以旧 APK 仍然存在或本地进程退出代替。本轮同时明确普通 MCP 命令的历史保存结果，并修复重复请求反馈累积。交付对象仍是 Bridge；没有修改样例 App 业务，整个体系尚未完成生产验收。

## 实现与合同

- 新增共享 `android-install-execution` 模块。APK 在 Host 冻结、解析 manifest、验签后推送到手机私有任务目录；任务绑定 actionId、jobId、Android boot、APK hash/字节数、包名、选项和完整命令 hash。先持久保存派发标记与占用身份，再准入执行。
- 手机只创建一个原 session，依次执行 `pm install-create/write/commit`，保存原输出。托管 shell 回执与安装回执必须同时匹配；成功必须是原 commit 明确成功，随后独立读取已安装 APK 的实际字节 hash。签名冲突等确定失败不能因旧 APK hash 相同而通过。
- 这是 PackageManager CLI 的机器协议，不是安装界面的按钮文案识别。非 staged commit 的原返回等待机制核对了 [Android 16 AOSP PackageManagerShellCommand](https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/refs/heads/android16-release/services/core/java/com/android/server/pm/PackageManagerShellCommand.java)。待用户处理、warning、未知 OEM 输出、缺失或不完整回执均保持 unresolved，不推断成功或结束。
- 安装仍由持久 MCP Intent 控制。需要系统界面交互时，Agent 依据真实观察选择唯一、revision 绑定的 UIA selector；这条既有路径保留，没有新增 ROM/按钮文字规则。删除旧 Host ADB install 子进程执行器及无效 `streaming` 参数。SDK 37 实际验签器的 `V3.0 Signer` 输出已纳入明确解析格式。
- 提交前取消阻止准入。提交后取消/超时只停止客户端继续等待，原安装排空；丢失回执继续保留设备占用。`device-ownership reconcile` 查询原任务，不重新安装，也不恢复已经丢失的 Intent 决策循环。
- `executionReceipt` 包含完整原 `shellReceipt/installResult` 和 canonical JSON 校验值，action-receipt 顶层持久保存 `settled/executionReceipt`。对象字段顺序在落盘、导出后变化不会破坏核验；跨进程恢复记录也能离线核对原任务身份和结果。
- 安装目录采用独占分配，最多保留 64 个；达到上限在 push 前显式拒绝。已知结束凭据先完成占用记录的持久更新，再清理 APK 和确认 shell 回执。准备失败和释放租约失败仍清理 Host 私有 APK；清理失败单独暴露。
- 普通 MCP 命令新增 `_history`（`aab.command-history/v1`），状态为 stored、partial、unavailable 或 disabled；原始文本等结果通过 MCP `_meta['ai-app-bridge/history']` 提供同一结果。每条引用明确 stored、actionId/globalSeq 和错误；缺失序号为 null。设备动作结果、dispatch/ambiguous 和原执行凭据不被辅助历史失败覆盖，写盘失败不会重放动作。
- FactRecorder 仅对成功追加的证据去重，失败的保存可在后续读取中再次尝试。每次交付复制 feedback 与 evidence 数组，避免同 requestId 的缓存结果被反复追加。重复成功/失败结果各自记录保存结果，provider 仍只执行一次。后台 observer 的独立写入策略不在本轮验收范围。

当前仍为 95 个命令。公开合同见 [COMMAND_CONTRACT](../desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md)，机器快照见 [3N 命令目录](audits/2026-09-09/command-contract-phase3n.json)。安装是 Script 的准备步骤，尚不是同步 `ctx.call` 能力，也不宣称 CLI 的短生命周期可承载该 Intent。

## 最终验证

证据根目录：`build/ai_app_bridge_artifacts/command-production-phase3n-2026-09-09/`。设备为已授权 OPPO `FYZLAU49X8OVQGJ7 / PGFM10 / API 36`，boot 为 `255c2c42-88b7-4b49-b442-5b18ba12a0be`。另一台 OPPO 未连接；未操作其余设备，也没有扩展锁屏问题调查。

基线 HEAD 为 `4da58fac5a9f8e522e85f7aa2f23cea195d75f95`，开始时保存 232 个已有修改/未跟踪文件的 hash，并核对 3M 的 585 个冻结来源。没有提交、推送或发布。Android/Flutter/iOS/样例的 185 个已有来源逐字节保持 3M 状态；本轮没有重建 SDK，不能把此前 Android 单测或 SDK 真机场景算成本轮新结果。

| 检查 | 结果及证据 |
| --- | --- |
| Host 全量 | 968/968，0 失败/取消/跳过；25803.041417 ms；`logs/host-release.log` |
| 干净发行包 | 新目录 npm install，原生依赖实际编译、95 项能力、Script/Intent/权限/退出重启合同通过；`package-release/report.json` |
| 发布来源 | tarball、实际安装目录与源码的 99 个发布文件及 6 个 bundled 文件逐字节一致；最终真机使用其中 90 个 bin 文件；`package-source-verification.json` |
| 安装正常与确定失败 | 正常同字节重装 completed；新路径的真实 APK hash 一致。验证专用不同 signer APK 被 PM 拒绝为 INSTALL_FAILED_UPDATE_INCOMPATIBLE，旧路径和字节未变；`device-terminal-final/report.json` |
| 原任务故障恢复 | 4 场景通过，未知期间累计 15 次多入口调用被阻断；每个已准入场景的原手机任务只 start 一次，提交前取消为零次；`device-faults-final/report.json` |
| 真实历史失败 | 原存储路径为普通文件触发 ENOTDIR；真实分段文件轮转时撤销目录写权限触发 native sfs_io。两次真实 keyevent 0 各只派发一次，原 settled 凭据保留，历史分别 unavailable/partial；`history-device-final/report.json` |
| 重启后的真实查询 | 恢复文件权限后新 Node 进程从原 FactStore 查询失败 actionId，确实没有记录；新 MCP 的只读占用查询正常 stored，不补发原动作 |
| 离线证据 | 新 MCP 从真实磁盘重开 6 个 Intent 与 2 个被阻断的 Script；8 份归档搬移后在 ADB 禁用、原存储不可用的进程全部 verified。3 份归档内安装凭据和 3 条恢复历史分别重算原响应校验值；`offline/report.json` 及 3 个 `*-recovery-disk-proof.json` |
| 最终设备状态 | 显式启动同一 sample Activity；实际截图、树和 foreground 一致，Native 计数为 0、Native/H5 初始文本可见。SDK 的 nativeAction/flutterAction/h5Action 均为空，占用 idle；`visual-review.json`、`device-final.json` |

最终测试包 SHA-256：`1205dcca791d87f6ecafeca573df4285dc33a002865c0e9a223ec528af1ad0f4`。所有最终 Host、真机与离线验证使用相同发布来源。

| 安装场景 | 原 operationId | 原 session | 客户端结果与独立结果 |
| --- | --- | --- | --- |
| 正常同字节重装 | intent-1788931275386-1 | 1773300096 | completed，实际安装路径更换且字节匹配 |
| signer 拒绝 | intent-1788931277925-2 | 1331954669 | failed，原安装路径和字节未变 |
| 准入前取消 | intent-1788930993431-1 | 未创建 | cancelled，start 为 0，旧 APK 未变 |
| 准入后回执丢失并取消 | intent-1788930997909-1 | 1617072224 | cancelled，取得原回执才恢复占用；实际重装完成 |
| 截住原结果直到超时 | intent-1788931003300-1 | 920730495 | timeout，取得原回执才恢复占用；实际重装完成 |
| Host SIGKILL | intent-1788931012690-1 | 371987204 | 原 Intent 重开为 interrupted/ambiguous，restartPolicy=none；另存原任务恢复证明，不重写原流程为成功 |

同字节重装最终 APK SHA-256 始终为 `9cdff0b4f5990b56bd34ed6d455505335557e78af65978df1eb1e8a2887faa45`。验证用不同 signer APK 为 `932d4f496f1668aa825539318f6541d7369c58d06fbbb3dfea9f0210f0f721c5`；它没有成功安装。Flutter lock 保持原 SHA-256 `363606252639dc0a29c86b14ed899c6b2da6becc4aae00c486c4eaf12527a091`。

故障控制器只在 Host ADB 回复通道截住真实结果或返回不匹配身份，手机仍执行原 PM 命令。提交后取消/超时/崩溃场景先等到真实原终态，再人为丢失返回；它们证明结果丢失后的持久恢复，不能证明正在等待安装 UI 或 Binder 的任务可以被主动终止。11 个故障 MCP 中 10 个正常 EOF 退出，一个按场景 SIGKILL；其余最终设备、历史与离线 MCP 均正常退出。

## 保留失败与尚未完成的范围

- 早期 Host 检查暴露 `_history` 序号 undefined 在 JSON 中消失，改为 null；真实 signer 预检暴露 SDK 37 的 V3.0 输出未被接受，随后修复。追加的重复请求测试暴露缓存 feedback 数组增长，修复后重新跑完 968 项。
- 历史故障第一版控制器误认为分段文件延迟创建，第二版在只读 ownership 命令传入不支持的 feedback 参数；这两次保留失败报告，第三次通过，最终发布包又独立复跑通过。没有把控制器错误改成产品成功。
- 早期安装报告使用中间包，保留作调试资料；最终验收只采用上表的 package-release 与 final 目录。`device-first/install-window.png` 是之前 SDK 安装完成页面，不作为本轮安装确认界面的证据。本轮正常安装未需要新的 UI 确认。
- 安装只覆盖 Android 单 base APK、非 staged session 和本机 OPPO。split、多 ROM/旧 Android、空间不足/系统验证、等待用户决策中的取消和完整端到端 deadline 仍需后续验收。当前 timeout 覆盖任务准备/准入/Host 等待，不含全部 APK 检查及前后身份/UI 查询。
- 取消不承诺回滚已安装 App。shell 终态缺少匹配的 commit 证明、手机换 boot、输出缺失或 OEM 不明格式时继续阻断。未知 staging、失联 session 与 shell 未确认记录的安全退役仍需设计；64 上限只是明确拒绝门槛，不等于完整回收治理。
- `_history` stored 只证明本次辅助历史追加成功，不能代表所有手机证据完整，更不能代表业务通过。真实满磁盘 ENOSPC、后台 observer 持续失败与手机 Capture 的其他淘汰/断连场景不由本轮 ENOTDIR/sfs_io 验证替代。
- 本轮没有复跑 NotallyX/LocalSend 全流程，也没有四 App、iOS/WKWebView、长时间压力或性能门禁。约 1.5 秒的同字节安装任务时间不能外推全 App 回归时间。

## 下一关

优先补 UIAutomator 语义目标的执行绑定，继续审视共享定位、取消和查询合同。其后保留 shell/安装残留的安全退役、H5 只读与多页面身份、通用 CDP/HTTP 结束证明、平台 target 和 iOS 持久查询、四 App 固定覆盖及持续运行门禁。用户已表示可接 iOS 设备；进入 iOS 真机验证前通知接入，当前不要求接设备。
