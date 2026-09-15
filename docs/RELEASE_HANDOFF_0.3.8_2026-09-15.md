# 0.3.8 自动准备与验证记录

本版新增 `executor-prepare`，通过 CLI、MCP 与 JS/Python Script 自动准备原工程的可选测试执行器。Android 生成临时 androidTest 入口并注入依赖；Flutter 添加 dev_dependency、生成测试入口并检查业务依赖版本；iOS 缓存并校验 WDA 工程；Web 准备固定版本 Playwright 与浏览器。公开命令数为 122。

Android 保留原 application ID 和已有 runner，不修改业务 Gradle、Manifest 或源文件。Flutter 不修改业务 main；pubspec 与 lock 的变化公开可见，依赖冲突或 Pub 中途失败会恢复原始文件。准备过程不安装或启动手机 App，也不启动持续 UI 观察。现有 SDK 执行路径继续可选。

## 本轮验证

| 范围 | 结果与边界 |
| --- | --- |
| CLI | 完整串行检查 1338/1338 通过；最终动作合同与准备检查 29/29 通过。 |
| Android | 所有模块 Maven 本地发布及相关单元检查通过；NotallyX 原工程自动生成并构建主包/测试包；现有 native sample 的 Espresso、UI Automator、Espresso-Web、Compose 组合构建通过。 |
| OPPO / API 36 | NotallyX 的 JS、Python 各执行 70 步、53 次操作、18 项断言，分别为 26.4 秒、26.8 秒，不含构建、安装和会话启动。原包名 `io.github.mobileaidev.notallyx.sample`。 |
| 独立持久化核验 | SQLite 核对新增笔记正文、置顶、标签、文件夹和清单勾选状态均通过，原有 34 条笔记保持不变。 |
| Flutter / LocalSend | 使用原工程 Flutter 3.41.9，214 个业务依赖版本不变；原包名 `org.localsend.localsend_app.bridge_sample`。JS、Python 各 24 步，12.3 秒、11.7 秒；覆盖导航、Unicode 多行编辑、取消、重新输入、选择列表读回和清理。未向其他设备发送文件。 |
| iOS / iPhone | iPhone 17 Pro Max、iOS 27.0、Xcode 27；新管理的 WDA 14.1.1 编译、签名、启动成功。现有 Kiwix 的 JS/Python 均完成 XCTest 原生书签界面和 SDK H5 页签流程。WDA 会话已关闭。 |
| iOS 编译 | 根 Swift Package 的真实 iOS 编译通过；native sample 编译通过，但该样例安装受免费签名三 App 限额限制，因此设备验证使用已有 Kiwix，未删除其他 App。 |
| Web | Playwright 1.63.0 / Chromium 实测表单、唯一选择器、重复 actionId、取消、对话框、Shadow DOM、跨源 iframe、上传、弹出页和导航身份保护通过。 |
| SDK | Flutter 66 项、Web 23 项检查及 Web 构建通过。 |

NotallyX 的完整可重复脚本见 [`scripts/validation/notally`](../desktop/ai-app-bridge-cli/scripts/validation/notally/README.md)。覆盖笔记/清单、标签、置顶、归档、回收站与搜索；附件、提醒、分享等不在本轮范围内。不能据此宣称所有 App 的全部业务功能已验收。

## 真机发现并修复的问题

标准 AGP androidTest APK 可以没有版本号。安装检查现在接受这种合法构建，仍校验实际包名、签名和安装文件哈希。

NotallyX 自定义 `setText` 会暂停业务 TextWatcher；原来的 Espresso `replaceText` 可以改变显示文字，却不保存数据。本版提供显式 `replaceTextViaInputConnection`，通过编辑器 InputConnection 提交 Unicode 文本，并保留 setter 与按键输入两个独立选项。实际成功结果经重新进入页面和 SQLite 验证。InputConnection 不等于真实物理键盘或系统 IME 流程。

Flutter 模态框动画中，旧元素指纹被拒绝为 `reobserve_required`，且 `dispatched:false`。验证脚本显式推进动画后重新观察再操作，没有绕过身份校验或重放未知结果。

## 兼容范围

自动 Android 准备使用 macOS/Linux、AGP 7.4–8.x 的现有工具链接口；实际样例使用 AGP 8.7.3。AGP 9、Windows 自动准备不在本次范围。依赖校验不会自动升级业务 AGP、Kotlin 或 Compose。

Flutter WidgetTester Host 当前支持 Android；Flutter iOS 继续使用已有 SDK/WDA。现有 Kiwix/LocalSend 的业务 SDK 为 0.3.7，本轮设备证明的是新 Host/执行器准备与编排；0.3.8 SDK 的版本同步另经编译验证。

npm 安装不会安装 Android SDK/JDK、Flutter、Xcode、Python 或业务所需 Rust。新电脑仍需这些平台工具链；Bridge 自动准备其支持的测试依赖和入口。首次 iOS 真机运行仍需要签名、信任和手机上的 UI 自动化确认。

## 发布证据

源码冻结时，公共渠道发布与实际 npm 包的干净安装仍待执行。本节在完成公开渠道核验后以独立提交更新，不移动发行标签。

原始日志与回执保存在 Git 忽略目录 `build/executor-prepare-038/`。关键文件：`cli-check-final.log`、`final-executor-contracts.log`、`android-modules.log`、`notally-javascript-result.json`、`notally-python-result.json`、`notally-database-proof.json`、`localsend-scripts-proof.json`、`ios-scripts-proof.json`、`ios-root-package-build.log`、`web/playwright-verification.json`。首次失败证据保留，不能用后续通过结果覆盖原始失败原因。
