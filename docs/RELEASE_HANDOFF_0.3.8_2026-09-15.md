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

2026-09-15 已完成公开发布。发行标签 `0.3.8` 固定在源码提交 `d32e4a948b809b26d283921af591cbcd0dface12`，源码已推送 `origin/main`。本节在发布后以独立文档提交补齐，不移动发行标签。

| 渠道 | 核验结果 |
| --- | --- |
| [GitHub Release](https://github.com/mobileAiDev/ai-app-bridge/releases/tag/0.3.8) / iOS Swift Package | Release 已公开，非 draft、非 prerelease；公开标签指向上述源码提交。根 Swift Package iOS 编译通过。 |
| [npm CLI](https://www.npmjs.com/package/@mobileaidev/ai-app-bridge/v/0.3.8) | `0.3.8` 已发布，`latest`、`next` 均为 `0.3.8`；公开 tarball 与发布前干净安装验证的 tarball 逐字节一致。 |
| [npm Web SDK](https://www.npmjs.com/package/@mobileaidev/ai-app-bridge-web/v/0.3.8) | `0.3.8` 已发布，`latest`、`next` 均为 `0.3.8`；公开 tarball 与已验证构建逐字节一致。 |
| JitPack Android | 构建状态 `ok`，提交与发行标签一致；Android SDK、Gradle 插件、六个执行器模块共 16 个公开 POM/二进制文件下载校验通过。实际安装的 CLI 使用默认公共仓库完成 NotallyX 原工程准备和构建，29.2 秒，未使用 MavenLocal 覆盖。 |
| [pub.dev Flutter SDK](https://pub.dev/packages/ai_app_bridge_flutter/versions/0.3.8) | `0.3.8` 已发布；公开归档 SHA-256 与服务端元数据一致，56 个源码文件与发行源码一致。 |
| [pub.dev 测试辅助包](https://pub.dev/packages/ai_app_bridge_test/versions/0.3.8) | `0.3.8` 已发布；公开归档 SHA-256 与服务端元数据一致，6 个源码文件与发行源码一致。 |

安装包 SHA-256：

| 包 | SHA-256 |
| --- | --- |
| npm CLI | `533e3e70ccf89a3b065e9528120630b5f01e4bd04027ee717e8e08cafd48c8e3` |
| npm Web SDK | `c5ccbd70f062662c2c9c623220a03c0f3dded77157d43ec64807ed1b425536e3` |
| pub.dev Flutter SDK | `a8162b083f4aa23bf645f469d56c751269ad6bc5829d1cab467eb3b25e3fda32` |
| pub.dev 测试辅助包 | `1e949c2094139fc77224bd2afaf950fe9f44e31b51486857229ab2cfbf9ac2eb` |

实际 npm 包在干净目录安装通过，原生扩展编译成功，122 项命令发现、CLI/MCP 共用 Runtime、JS/Python 运行、断开连接后结果保留、重连读回等合同检查通过。安装后 iOS WDA 源码准备及缓存复用也通过。该组安装合同使用受控设备替身，真机覆盖以上文单独列出的记录为准。

本机全局 CLI 已通过 npm 更新至 `0.3.8`，原生扩展编译成功。新版 Runtime 与新建 MCP 连接 `compatible:true`，实测 CLI 启动 JS/Python、MCP 等待、CLI 读取持久化结果均通过。发布时当前对话仍持有旧 MCP 进程，状态为 `compatible:false`，需要客户端重连；不能把全局安装完成等同于现有连接已刷新。

LocalSend 的测试辅助包已从开发路径切换为公共 `ai_app_bridge_test: 0.3.8`，实际安装的 CLI 完成准备和 APK 构建，86.0 秒，业务依赖版本变化为零。该公共依赖构建未重新安装到手机；此前真机流程使用相同源码的本地测试辅助包。Pub 首次解析受业务 Git 依赖网络访问影响，使用本机已有代理后成功；没有为此更改业务依赖版本。Courier、PDA、Novel 保持本轮约定范围。

原始日志与回执保存在 Git 忽略目录 `build/executor-prepare-038/`。关键文件：`cli-check-final.log`、`final-executor-contracts.log`、`android-modules.log`、`notally-javascript-result.json`、`notally-python-result.json`、`notally-database-proof.json`、`localsend-scripts-proof.json`、`ios-scripts-proof.json`、`ios-root-package-build.log`、`web/playwright-verification.json`、`web/executor-public-script-verification.json`、`release-package/report.json`、`release-package/installed-android-prepare.json`、`localsend-hosted-prepare-proxy.json`、`npm-tags-final.json`、`npm-public-integrity.json`、`pub-public-integrity.json`、`jitpack/report.json`、`github-release-final.json`、`global-install-proof.json`、`current-connector-final.json`。首次失败证据保留，不能用后续通过结果覆盖原始失败原因。
