# 0.4.5 发布与本机升级验收

冻结发行提交：`227bc0b1c619c6293f3f679bc9e3ac0a714ee766`。
tag `0.4.5` 指向该提交，main 和工作分支已正常快进推送；旧 tag 保留。
GitHub Release：https://github.com/mobileAiDev/ai-app-bridge/releases/tag/0.4.5 。

## 修复范围

Android WindowManager 改为集中按字段提取，识别标准 `mAttrs={`、
`mAttrs=WM.LayoutParams{`、合法空白和换行、字段顺序、行尾类型、数字及
平台符号类型。嵌套属性里的 `taskId` 不冒充 Activity 的实际 task。
缺字段、冲突或不支持的类型保留原始依据和具体诊断，不填预期包名，不
伪造 ownershipVerified；已有 UID、进程及窗口身份核验保留。

CLI/MCP/Script/Intent 把前台匹配、不匹配、未知和变化作为独立观测及
warning 返回，包含预期目标、实际观测、原因、来源及时间。明确动作按原
App/provider/节点执行，不因为前台判断提前否决，不要求 force，也不隐式
切 App 或降级。Intent 切 Android App 使用显式 observationTarget。

SDK/native/H5/UIA 使用原绑定窗口和节点，窗口失焦本身不使引用失效。
缺失、过期、多重匹配、不可触达等实际动作条件仍给出具体失败；UIA 回执
核验也不再要求原窗口必须 focused=true。Script 的公共结果及持久回执保留
warning。可确定的失败后，Intent/Script 仍能继续观察和接收明确命令；
已派发但结果未知沿用原执行和恢复合同。

## 测试和真机验收

- Host 最终完整功能 1,409 项、串行性能 50 项通过。
- Android build/lint/test 通过：SDK Debug/Release 各 194 项、plugin 8 项、
  UIA 47 项。UIA bundle 从本次源码重建并核对 hash。
- Swift iPhoneOS 无签名构建通过。Flutter 两包分析通过，SDK 66 项通过；
  helper 无 test 目录。两包提交后的发布 dry-run 均零警告。
- Web 23 项及构建通过；remote-smoke 安装公开 0.4.5 后导入检查通过。
- 最终 CLI tarball 在仓库外全新安装，native prebuild、npx 首次/重复启动、
  MCP、Script、提取、回执恢复、取消及动作合同验证通过。CLI 的 199 个
  文件、Web 的 6 个文件逐一匹配冻结发行提交。
- SUNMI K2 Mini API 25 实机：Bridge 点击首页“收银台”，原动作回执
  `execution.ok=true, dispatched=true, ambiguous=false, settled=true`；
  刷新 native 树和独立查看的前后截图确认进入收银页面。验收进程的
  CLI/MCP/Runtime 执行文件与冻结提交一致，设备 SDK 为 0.4.5。
- 真机 Script 故意选择不存在节点，得到 native_selector_not_found，未
  派发且无歧义；同一 Script 后续树观察成功。Intent 同样失败后仍处于
  waiting_for_decision，继续 observe 成功。验收使用 Bridge 操作；原始
  ADB 仅用于必要的只读诊断。

四轮报告覆盖细节、流程、健壮性及代码 Review 驱动回归。初始失败日志
保留：并行构建曾与 UIA bundle 校验竞态，既有 iOS 取消测试曾单次失败，
最终归档测试曾发现 Script warning 丢失。最后一项在发行前修复；最终
完整及归档回归均通过，未修改 iOS 业务逻辑来规避重跑。

## 公开渠道

| 渠道 | 0.4.5 验证结果 |
| --- | --- |
| npm CLI/MCP、Web SDK | 已发布；latest/next 均为 0.4.5；下载归档与受检原包及冻结源码一致 |
| Android SDK、Gradle plugin、六执行器 | JitPack 构建成功；8 模块共 16 个公开 POM/二进制下载、坐标、依赖及内容核验通过 |
| iOS Swift | GitHub tag 源码为 0.4.5，与冻结源码逐字节一致 |
| Flutter SDK、test helper | pub.dev 已发布；公开归档分别 56/6 文件匹配冻结源码 |
| GitHub tag / Release | 已发布，tag 对应冻结提交，Release 为 latest |

公开版本及完整性矩阵 13 项均通过。内部 segmented-fact-store-native
保持 0.2.0。临时网络超时、npm 传播期 404 和两步验证回调 404 已解决；
没有把认证 URL、OTP 或凭据写入发行证据。

## 本机安装与当前连接

全局 CLI/MCP 从公开 npm 升级到 0.4.5，199 文件与公开归档完全一致。
四个活动 Runtime 全部使用全局包，实际运行版本 0.4.5，compatible=true；
原配置 fingerprint、事实目录和 profile 保留。升级前相关设备 journal
均 idle，没有 pending 或 reservations。新全局 MCP 六项实际调用通过，
新版 MCP/CLI 再次读取 K2，设备 SDK 仍为 0.4.5。

Codex、Cursor、Antigravity 的配置入口均解析到全局 0.4.5。Codex 已安装的
Bridge skill 同步发行版，旧文件在外置证据目录备份。配置路径和磁盘版本
不代表已经运行的 stdio 客户端重新加载。

当前聊天实测仍加载 0.4.4 MCP 客户端，报告 runtime_code_mismatch 和
outdatedSide=client，新 Runtime 已为 0.4.5。界面工具明确禁止访问 Codex，
无法代为点击重连。已请用户在应用内重连 Bridge；当前连接恢复尚未验收。
没有关闭其他聊天的客户端或重启整个应用来掩盖这一限制。

POS 工作区的小票改动、原 tracked diff 和未跟踪测试文件均保持原样。
本次实机 APK 通过仓库外 Gradle init 脚本使用 SDK 0.4.5；POS 原版本目录
依赖仍保留 0.4.4，不能把该源码的后续普通构建称为已使用 0.4.5。

## 证据与验收边界

外置证据目录：
`/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/0.4.5-2026-10-08`。

关键报告：`four-round-acceptance.json`、`component-validation-report.json`、
`device-evidence-review.json`、`candidate-matches-frozen-source.json`、
`package-release-verified/report.json`、`publication/version-matrix-final.json`、
`publication/jitpack/report.json`、`publication/runtime-upgrade-results.json`、
`publication/global-mcp/report.json`、`publication/connected-mcp-final.json`。
实机原回执和截图位于 `foreground/final-cashier-click.json`、
`foreground/k2-final-home.png`、`foreground/k2-final-cashier.png`。

真机验收限于指定 K2 的导航动作与失败后续命令，不包含支付、小票物理
输出或所有 OEM。iOS 本轮是构建和发行源码核验，未做 iOS 真机回归。
剩余操作为已有应用内 MCP 连接重载；无需再次发布或升级这些 Runtime。
