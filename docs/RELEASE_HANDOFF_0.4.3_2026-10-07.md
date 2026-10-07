# 0.4.3 前台窗口归属修复与发布交接

发行源码与标签固定于 `eaaf5c94a082355d4e32ef094b7d4d79e67e9019`。
2026-10-07，CLI/MCP、Android SDK/Gradle plugin/六个执行器、iOS Swift 包、
Flutter SDK/测试辅助包、Web SDK 已完成 **0.4.3** 公开发布及渠道核验。
本机全局安装与三个 Runtime 已升级；用户重启 Codex 后，当前对话的 MCP
连接已核验为 0.4.3、`compatible:true`。发行标签未移动，首次失败与中间状态
证据均保留。

## 修复范围与安全合同

旧版将 `mCurrentFocus` 窗口标题中的包名和 Activity 当成实际归属。普通 App
可以设置窗口标题；宿主拥有的窗口若展示客体组件名称，即使配置了正确允许名单，
仍可能被错误判为 `observed_foreground_package_mismatch`。

新版按唯一窗口 token、user、display 定位 WindowState，从实际 owner、UID、
session PID、窗口类型和绑定 Activity 确认归属，并与 PackageManager 的活动安装
记录及进程 boot/start 身份核对；窗口和进程再次读取一致后才返回可比较的
`windowIdentity`。标题仅作诊断，不参与 owner 判定，也不引入分身包名特例。

Activity 窗口须有真实 Activity 绑定；明确的非 Activity 系统窗口保留空
Activity/component，仍须通过 owner、UID 和进程验证。同包非 Activity 窗口走
UIA。Intent 在观察前后、动作进入及实际执行前复核窗口身份；缺失或变化均拒绝。
允许名单、UIA 根包名、provider、selector 唯一性及原有 epoch、快照、nodeRef、
TTL、回调和结算守卫均保留，切换到未授权第三方 App 仍在动作前拒绝。
调用方不需要提供 UID 或宿主/客体映射。

API 25 的 `mAppToken`/`stackId`、API 30 的 `mActivityRecord`/`rootTaskId`
及新版 `taskId` 按各自合同解析，不将容器 ID 当作任务 ID。更新过的预装 App
只读取 PackageManager 的活动 `Packages:` 段，不把隐藏旧系统版本当成冲突。
API 25/30 目前只有 AOSP 源码与离线 fixture 验证，尚无对应实际设备证据。

## 公开渠道

| 渠道 | 已核验结果 |
| --- | --- |
| [GitHub Release / iOS Swift Package](https://github.com/mobileAiDev/ai-app-bridge/releases/tag/0.4.3) | 公开正式版且为 latest；标签提交一致；公开 iOS 源码版本和哈希与冻结源码一致 |
| [npm CLI/MCP](https://www.npmjs.com/package/@mobileaidev/ai-app-bridge/v/0.4.3) | latest、next 均为 0.4.3；公开 tarball 与候选包逐字节一致，198 个文件与发行源码一致 |
| [npm Web SDK](https://www.npmjs.com/package/@mobileaidev/ai-app-bridge-web/v/0.4.3) | latest、next 均为 0.4.3；公开 tarball 与候选包逐字节一致，6 个文件与发行源码一致 |
| [JitPack Android](https://jitpack.io/#mobileAiDev/ai-app-bridge/0.4.3) | 同标签、同提交重建一次后成功；状态 API 中提交一致；SDK、插件、六个执行器的 16 个公开 POM/二进制全部核验通过 |
| [pub.dev Flutter SDK](https://pub.dev/packages/ai_app_bridge_flutter/versions/0.4.3) | 0.4.3 已公开；公开归档 SHA-256 与服务端元数据一致，56 个文件与发行源码一致 |
| [pub.dev 测试辅助包](https://pub.dev/packages/ai_app_bridge_test/versions/0.4.3) | 0.4.3 已公开；公开归档 SHA-256 与服务端元数据一致，6 个文件与发行源码一致 |

| 已核验公开归档 | SHA-256 |
| --- | --- |
| npm CLI/MCP | `5e85609113c751435a2756e37b665e271b4b90fde36e8c09883fca61f277bed0` |
| npm Web SDK | `4782a3a18d665e2fbd2363a54e975516fff876b4086e1ed300b3452fcbdf2dca` |
| pub.dev Flutter SDK | `affd2a07cf0d05633c05998614f846093e7f58d302a8e49e983111c47324d9cd` |
| pub.dev 测试辅助包 | `29f6c31b69d57b2017ebc20cb8b19d14d45958c37471d0949f3b13fa5a92ff92` |

公开组件的源码版本均为 0.4.3；嵌入式 native store 是内部依赖，仍为 0.2.0。
源码版本、预检通过与公开渠道完成是分别核验的状态。

## 验证

- Host 全套功能 1392 项、性能 50 项通过。最终窗口类型复核后，owner 专项
  30 项及 foreground/Intent/text-wait/install 联合回归 98 项通过；这些专项
  与全套有重叠，不累加为独立用例总数。最后补齐 API 30 的窗口类型 2042。
- 最终 CLI 归档在仓库外全新安装，禁止调用编译器/Python 的预编译 native
  安装检查、123 命令发现、CLI/MCP、提取合同、JS/Python 脚本及 Runtime 行为通过。
- Android 全模块 build/lint/单测通过：SDK debug/release 各 194 项、插件 8 项、
  UIA JVM 47 项；UIA bundle 与构建及源码 manifest 一致，最低 API 25。
- iPhoneOS unsigned Swift 构建通过；Flutter SDK 分析及 66 项测试通过；
  测试辅助包分析通过，无 test 目录；Web 23 项测试及 build 通过。
- 冻结源码提交后，两份 Flutter 包的发布预检均为零警告、exit 0。

独立 API 36 模拟器 `emulator-5590` 使用普通测试 App
`com.example.aabownerprobe`，将窗口标题设为
`com.example.projectedguest/.GuestActivity`。旧版复现 owner mismatch；最终
受检 npm 候选包通过实际 MCP 完成以下六个场景：

| 场景 | 结果 |
| --- | --- |
| 投影标题、真实宿主 owner | 观察、计数动作、弹窗及返回通过 |
| 普通 App 窗口 | 观察、动作、弹窗及返回通过 |
| 同 Activity 进程重启 | 旧身份拒绝，要求重新观察 |
| 真正切换到未授权第三方 App | 动作前拒绝 |
| 允许名单中的 SystemUI 非 Activity 窗口 | 观察通过 |
| 未列入允许名单的 SystemUI 窗口 | 拒绝 |

另在 API 36 `emulator-5584` 和 API 37 `localhost:59015` 保存实际五次 ADB
只读查询及原始输出，owner 验证通过。这两项是当前宿主 MainActivity 的归属证据。
以上验证证明通用 Bridge 修复及拒绝合同，不代表 Duo 客体业务流程已经修复或验收。

## 本机入口

全局 `/opt/homebrew/bin/ai-app-bridge` 及 MCP server 已为 0.4.3，198 个安装
文件与已核验公开 npm 归档一致。Codex、Cursor 的绝对脚本路径及 Antigravity
的 `ai-app-bridge-mcp` 启动命令均解析到这份全局 0.4.3 安装；这项入口核验
不代表已有客户端进程已重载。以下为发布升级时的三个存活 Runtime 快照，
均返回 `compatible:true`，独立 Runtime 的 facts/profile/config 保留：

| Runtime | runtimeId | PID |
| --- | --- | --- |
| 默认 | `80a490a4-3341-40e8-baf5-0d01da5920f4` | 21162 |
| 独立模拟器 | `810de7f3-3c2b-473a-ac72-1c76642bc8fc` | 22590 |
| 独立真机 | `a711acdb-7167-4dd8-a369-4b8a1dcbf5f4` | 24684 |

新建全局 MCP 连接的 null、regex、JS、Python、预期提取失败及 Script
runtime-status 六项通过。用户随后重启 Codex，当前对话通过实际 MCP 调用
确认默认 Runtime 为 0.4.3、`compatible:true`；重启后的 runtimeId 为
`82f78817-b022-4474-a698-9fab4a6d15b4`，PID 为 `36256`，取代上表默认
Runtime 的发布升级时快照。

remote-smoke 的公开 npm 依赖、锁文件及实际安装均为 Web SDK 0.4.3；
require 检查与 npm ls 通过，6 个安装文件与公开归档一致。

## 保留的失败与后续核验

旧版真实窗口查询与 MCP 观察的 owner mismatch 保留为修复前证据。设备流程中
普通启动动画曾触发原有 UIA 引用刷新拒绝；等待页面稳定并重新观察后通过，
未放宽 UIA 守卫。两份 Flutter 包首次发布预检因 Git 跟踪文件尚未提交返回
exit 65、各一条警告；冻结源码提交后重新预检通过，原记录保留。

JitPack 首次构建的 Android 单测 194 项中 1 项失败，位置为
`G8RecordOverheadBenchTest.kt:43` 的 p99 ≤ 3 ms 断言；同一日志还记录 lint
private API 缓存的 `OutOfMemoryError: Java heap space`。保留首次失败日志后，
仅删除该失败构建，同标签、同提交重建一次，最终 `BUILD SUCCESSFUL`，公开
16 个产物通过。成功日志仍有 lint 缓存 OOM 诊断，但该次构建没有因此失败；
不据此推断首次性能断言失败的原因。日志因 dubious ownership 未打印 Git
提交，提交一致性由 JitPack 构建状态 API 核验，原发行标签未变。

CLI 的 `next` 更新验证曾过期，重新验证后更新成功；CLI/Web 的 latest、next
均已从匿名 registry 确认为 0.4.3。JitPack 成功后，Flutter SDK 发布命令
exit 0，随后公开归档校验通过。

发布渠道与当前 Codex MCP 连接核验均已完成。当前连接的实际返回于
2026-10-07 11:15:22（UTC+8）保存至 `publication/connected-mcp-final.json`。

## 证据索引

外部证据根目录：
`/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/0.4.3-2026-10-07`。
以下路径均相对此目录，原始输出、失败与后续通过记录同时保留：

| 核验内容 | 证据文件 |
| --- | --- |
| 冻结源码、Host、安装归档 | `prepublication-report.json`、`candidate-source-integrity.json`、`package-release-verified/report.json`、`host-check-final.log`、`owner-final-post-review.log` |
| 各组件及两份最终发布预检 | `component-validation-report.json` |
| 修复前失败与六个实际设备场景 | `device/baseline/report.json`、`device/release-package/report.json`、`device/projected-before-window.txt` |
| AOSP 合同、API 36/37 查询及最终 98 项 | `owner-review-20261007T022745Z/{FINAL-REVIEW,SOURCE-CONTRACT-REVIEW,DEVICE-RESULTS,TEST-RESULTS}.json` |
| 公开渠道终态、归档校验 | `publication/report.json`、`publication/version-matrix-final.json`、`publication/dist-tags.json`、`publication/{cli,web,pub-sdk,pub-helper}-integrity.json` |
| 发布中间状态快照 | `publication/version-matrix-observed-20261007T024608Z.json` |
| 本机与新 MCP | `publication/local-runtime-inventory.json`、`publication/global-installed-integrity.json`、`publication/{global,emu,independent-physical}-runtime-status.json`、`publication/global-mcp/report.json`、`publication/remote-smoke.json` |
| Codex 重启后的当前 MCP 连接 | `publication/connected-mcp-final.json` |
| JitPack 首次失败、一次重建及最终核验 | `publication/jitpack/build-failed-first.log`、`publication/jitpack/delete-failed-build.json`、`publication/jitpack/rebuild-observation.json`、`publication/jitpack/build-rebuild-success.log`、`publication/jitpack/report.json` |
