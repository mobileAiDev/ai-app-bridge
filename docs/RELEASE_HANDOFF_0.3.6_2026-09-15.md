# 0.3.6 发布与项目更新记录

0.3.6 已正式发布。Android、iOS、Flutter、Web 及相关 H5 采集的持续 UI 观察默认关闭，只在显式申请的 100–5000 ms 窗口内运行，到期由设备或页面自行释放。Flutter 界面树改为按需读取。本版还提供可选 Android 测试执行器、Flutter integration_test helper 和 Playwright 执行能力，JS/Python 共用命令与执行合同。

发行提交为 `27206a2d5c80e2b5595745da6db878135567f815`，不可变 tag 为 `0.3.6`。[GitHub 正式发布页](https://github.com/mobileAiDev/ai-app-bridge/releases/tag/0.3.6)已公开。后续示例依赖及本记录通过单独提交更新，不移动发行 tag。

## 公共渠道核验

| 渠道 | 结果 |
| --- | --- |
| npm CLI/MCP、Web SDK | `@mobileaidev/ai-app-bridge` 和 `@mobileaidev/ai-app-bridge-web` 的 latest、next 均为 0.3.6；重新下载的 tarball 与已验证包逐字节一致。 |
| JitPack | Android SDK、Gradle 插件、六个可选测试模块和两个插件 marker 均发布；构建状态 ok，提交匹配发行提交。16 个公开 POM/二进制文件下载及依赖坐标检查通过。 |
| pub.dev | `ai_app_bridge_flutter`、`ai_app_bridge_test` 的公开最新版本均为 0.3.6；下载归档分别包含 56、6 个文件，内容与发行源码一致。 |
| Swift Package | Git tag 0.3.6；从发行提交导出的干净源码完成根 Swift Package 的 iOS Simulator SDK 编译。 |

公共归档 SHA-256：

| 包 | SHA-256 |
| --- | --- |
| npm CLI | `bc573bb417212c286d12314cbe1bd5b67d083064709543a98e871798c7458df0` |
| npm Web | `be3fa7326dfaa7796e8b056eddbea3dd81e347cc75bc5adf11f03165ed9d489f` |
| Flutter SDK | `20993b1019e6de74af4c4366ed4cb16bd84ca21e0761271fc81f6103c386438c` |
| Flutter test helper | `902b585f327055dcd8540aa5c9b3de390695684dbb257e0a832e71f99b2de38b` |

实际 npm tarball 的干净安装、native 编译、121 条命令和 CLI/MCP 共享 Runtime 验证通过。打包验证发现并补齐了 `bin/ui-observation.js`，上述哈希对应修正后的公开包。

本地 Android 全模块构建、lint 和 Maven 发布检查通过，使用本机 SDK 所需的 lint 9.3.2。JitPack 最终构建及产物均成功，但其日志曾出现非致命的 lint 私有 API 缓存内存错误，保留原始日志。

## 本机状态

全局 CLI 已安装为 0.3.6。新启动 MCP 和当前 Codex 对话的实际 MCP 连接均已核验：121 条能力，三个 UI observation 命令可发现，与共享 Runtime `compatible:true`。JS 与 Python 3.9 运行环境可用。

当前连接的代码身份为 `28f1890b23534a88dd125eb8a5288d342e8523c5e3a0844532aed7ebfa40aaa1`，与全局 CLI 相同。早期旧连接不能自动热更新的问题在最终检查时已解除。Codex/Cursor 配置继续引用全局安装路径。

## 项目更新与构建范围

| 项目 | 更新 | 本轮验证 |
| --- | --- | --- |
| POS | SDK/插件共用版本 0.3.5 → 0.3.6 | SIT、UAT Debug 构建通过；未安装到收银设备。 |
| Reader | SDK、Gradle 插件 0.3.5 → 0.3.6 | Debug 构建通过。 |
| MeasureDevice / measure-assist-android | SDK 0.2.12 → 0.3.6 | Debug 构建通过。 |
| MeasureDevice / protocol-lab-android | SDK 0.2.12 → 0.3.6 | Debug 构建通过。 |
| game-mirror-mapper | SDK 0.2.8 → 0.3.6 | Debug 构建通过。 |
| Legado | SDK 0.2.8 → 0.3.6 | AppDebug 构建通过。现有 gradlew 含 CRLF，直接启动它原有的 GradleWrapperMain 完成构建，未改 wrapper。 |
| vivo-site | Web SDK 0.1.0 → 0.3.6，manifest/lock 同步 | npm check、Vite 构建和 dist 检查通过；生产产物 Bridge 引用数为零。 |
| Web remote-smoke | Web SDK 0.3.5 → 0.3.6，manifest/lock 同步 | 公开 npm 安装和 check 通过。 |
| LocalSend 示例 | Flutter SDK 0.3.5 → 公开 0.3.6；集成脚本同步 | pub get 只更新 Bridge 一项；使用现有 Flutter 3.41.9 与 Rust 工具链构建 Android Debug APK 通过。 |
| Flexify 示例 | 过期本地候选包路径 → 公开 Flutter SDK 0.3.6；集成脚本同步 | pub get 只更新 Bridge 一项；iOS Debug 无签名构建通过。 |
| NotallyX 示例 | 源码依赖跟随当前 SDK | Android Debug 构建通过。 |
| Kiwix 示例 | 源码依赖跟随当前 iOS SDK | iOS 无签名构建通过。 |

Flexify 首轮 Flutter 构建遇到本机 Xcode 27 不接受旧 deployment target；最终通过单次 xcodebuild 参数 `IPHONEOS_DEPLOYMENT_TARGET=15.0` 完成验证，未修改项目声明的最低系统版本。

其他直接引用仓库源码或本地生成 AAR 的示例随当前源码/产物更新，包括 Android/iOS native、FreeOTP、Joplin、Wikipedia、VLC、OrganicMaps、Memos；本轮未逐个重新构建或运行其业务流程。

Courier、PDA 按用户要求没有修改。Novel 按用户要求暂缓：Bridge 声明恢复为 `^0.2.3`、锁定 0.2.4；撤回本轮临时 Flutter 3.41 解析造成的其他依赖升级，保留原有 file_picker 等依赖和业务修改。没有安装或恢复 Novel 的 Flutter SDK，没有执行 App 构建。临时生成的依赖映射已移至本轮证据目录；以后继续此项目时需要在其选定环境重新 pub get。

外部项目只更新上述 Bridge 依赖，未提交它们原有的业务改动。仓库内示例版本文件与本记录独立提交。诊断原件和研究草稿保持本地。

## 验收边界与证据

发布前 CLI 1313 项、Flutter 66 项、Web 23 项及 Swift macOS 77 项检查通过，Flutter analyze 无问题。Android、iPhone 原生/H5 和真实 Flutter/iOS 观察器诊断的测量方法、数值与限制见 [UI 观察性能报告](UI_OBSERVER_PERFORMANCE_ASSESSMENT_2026-09-15.md)。没有把构建、帧事件或操作回执当成所有消费 App 的完整业务验收。

本次发布和依赖更新没有重装设备上的业务 App。手机中已有 SDK 不会因 npm 更新而改变，需要使用新版 SDK 重建并安装 App 才能获得本次性能修复。

本地原始证据位于 Git 忽略目录 `build/release-0.3.6/`：`npm-public-integrity.json`、`pub-public-integrity.json`、`jitpack/report.json`、`cli-package/report.json`、`connected-mcp-final.json`、`consumer-manifests-before.json`、`consumer-manifests-after.json`、`novel-deferred.json` 及各项目构建日志。首次失败的日志保留，最终通过状态以对应 `*-final.log` 为准。
