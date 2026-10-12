# 0.4.6 发布、本机升级与项目依赖验收

冻结发行提交：`3200529f13adf3ec36566b1a5df1cf61794d7498`。
tag `0.4.6` 指向该提交；发行源码已正常快进推送到 main 和工作分支。
[GitHub Release](https://github.com/mobileAiDev/ai-app-bridge/releases/tag/0.4.6)
已公开并设为 latest。本文与公开 Web smoke 依赖更新属于后续交付记录，
不移动发行 tag。

## 本次交付

围绕效率、能力和故障恢复完成的整体审查及实现已包含在发行提交中：

- Script 默认开放所有支持的 Bridge 命令，显式 permissions 可缩小范围；
  可以组合 Intent、Script、Bridge 命令和封装的 ADB。设备级调用无需
  虚构应用包名，独立读取支持并发，Python 调用减少中转成本。
- Intent 支持 Bridge 命令、Script 和子 Intent 的组合。前台观测与其他
  诊断作为信息返回，明确动作由实际目标和执行条件决定。
- 省略 extract 使用 auto；96 KiB 内完整返回，较大结果先尝试无损结构
  压缩，再提供明确的部分结果、引用和后续读取方式。历史调用重放完整
  返回率为 99.90%，选定真实工作流为 45/45；这些是已审计样本结果。
- 文本选择支持组合条件、可操作节点筛选和显式匹配策略。长说明包含
  “同意”与按钮“同意”的情况可通过精确文本及节点条件区分；真实歧义
  保留候选信息，交给 agent 选择。
- UIA 历史回执中的 warnings 不再导致整个运行时启动失败；历史审计、
  状态恢复、取消、强制归档和关闭提供明确入口及必要的简短恢复提示。
  已派发而结果未知的动作保留原执行记录，不将其伪装为未执行。

设计、历史调用、同类工具参考和验收边界见
[整体审查](AGENT_CHOICE_AUDIT_2026-10-12.md)、
[历史使用审查](HISTORICAL_USAGE_AUDIT_2026-10-12.md)、
[同类工具参考](AGENT_TOOLING_REFERENCE_DESIGN_2026-10-12.md)及
[结果交付审查](RESPONSE_DELIVERY_AUDIT_2026-10-12.md)。

## 发行验证

- Host 功能 1,534 项及串行性能 50 项通过。发行包中 183 个执行代码、
  runtime、recipe 和 skill 文件与完整回归使用的最终源码逐字节一致；
  版本号和文档更新后另做最终归档安装与入口验证。
- Android build/lint 通过；SDK Debug/Release 各 199 项、UIA 50 项、
  Gradle plugin 8 项测试通过。UIA bundle 从发行源码重建并核对 hash。
- Swift iPhoneOS 无签名构建通过；Flutter SDK 分析及 68 项测试通过，
  helper 分析通过且无 test 目录；两包发布 dry-run 均零警告。
- Web 27 项测试及构建通过；remote-smoke 安装公开 0.4.6 后导入成功。
- 最终 CLI tarball 在仓库外全新安装，125 个命令目录、native prebuild、
  npx、MCP、Script、Intent、权限、持久结果和关闭合同验证通过。

初次 Android lint 被本机预览 SDK 的 `37.0` 版本解析阻断；保留失败日志，
使用已安装的稳定 SDK 目录后完成 build/lint，没有关闭 lint。

## 公开渠道

| 渠道 | 0.4.6 结果 |
| --- | --- |
| npm CLI/MCP、Web | 已发布；latest/next 均为 0.4.6；公开归档与受检候选包一致 |
| Android SDK、Gradle plugin、六个 executor | JitPack 构建成功，16 个 POM/二进制下载、版本、依赖和内容检查通过 |
| iOS Swift | 公开 tag 对应冻结提交，39 个 iOS 文件的 Git blob 与冻结源码一致 |
| Flutter SDK、test helper | pub.dev 已发布；公开归档 56/6 个文件匹配冻结源码 |
| GitHub tag / Release | 已公开，tag 指向冻结提交，Release 为 latest |

公开包版本矩阵共 13 项通过。CLI 214 个文件、Web 6 个文件匹配冻结源码。
内部 segmented-fact-store-native 保持 0.2.0。

## 本机与当前 MCP

全局 CLI/MCP 已从公开 npm 升级到 0.4.6，214 个安装文件与公开归档一致。
Codex 已安装的 Bridge skill 同步发行版，旧文件已备份。Codex、Cursor、
Antigravity 配置均指向该全局安装入口。

三个原活动 Runtime 均已升级；Codex 重启后再次核验并启动已停止的两个
独立 Runtime，三者均为 0.4.6、compatible=true，原配置 fingerprint、
facts 目录及 profile 保留。原先已停止的历史 Runtime 没有启动。

用户重启 Codex 后，直接通过当前聊天 MCP 确认 0.4.6、compatible=true；
封装 ADB 查询执行成功，当前 MCP 启动的 Script 调用 runtime 并从原
operationId 读取持久结果成功。新全局 MCP 的 JavaScript 64 次并发读取、
Python 调用和 host doctor 检查通过。其他客户端的磁盘入口已经更新，
未将配置路径检查当作那些客户端现存 stdio 进程的重新加载证据。

## 近期项目依赖

| 项目 | 已更新与验证 |
| --- | --- |
| POS | SDK 与 plugin 共用的版本目录更新至 0.4.6；sitDebug 依赖解析、APK 构建通过 |
| Duo 当前 360-reference-active 工作树 | SDK 更新至公开 0.4.6；debug 依赖解析、APK 构建通过 |
| Reader | SDK 与 plugin 更新至 0.4.6；debug 依赖解析、APK 构建通过 |
| MeasureDevice | 测量助手、接收端、协议实验项目均解析 0.4.6，并完成三个 debug APK 构建 |

四个项目、六个 Android 构建目标通过。Gradle 缓存中实际下载的 0.4.6 SDK
与公开 JitPack AAR 的 SHA-256 一致；依赖版本更新及 Duo 仓库配置共修改
八个文件，完整原文件和最终差异均留存在外置证据中。

Duo 的旧 `127.0.0.1:8765` Maven 代理用于避免 Gradle 6 直接处理 TLS，
脚本只下载和缓存上游内容。本地 Bridge 0.4.1 AAR 与本轮重新下载的公开
0.4.1 AAR 逐字节一致，SHA-256 均为
`2263aa7d0fc4617fcf054958c1b2b9a9ec441608fab2da002a843b59a6296075`，
没有 Duo 专用补丁。现为 Bridge 坐标增加限定 group 的 JitPack 公开源，
使其直接解析 0.4.6；其他构建依赖沿用原配置。

项目验证覆盖依赖与构建，没有提交或推送这些项目，也没有安装覆盖手机
上的应用。构建成功不代表各应用完整业务或所有设备已经回归。

## 证据

原始证据位于仓库旁的
`ai-app-bridge-release-evidence/0.4.6-2026-10-12/`：

- `validation/release-regression-binding.json`、各平台构建与测试日志；
- `package-release-verified/report.json`、`publication/version-matrix-final.json`；
- `publication/jitpack/artifacts-report.json`、`publication/public-final-check.json`；
- `local/global-upgrade.json`、`local/global-mcp-report.json`、
  `local/runtimes-post-restart.json`、`local/connected-mcp-final.json`；
- `consumers/final-report.json`、各项目构建日志与 APK hash、
  `consumers/duo-active/local-bridge-provenance.json`。

性能提升的受控基准不能等同于手机端业务加速比例；历史重放不替代所有
OEM 实机测试。iOS 本次完成构建与发行源码核验，没有新增真机业务验收。
