# 0.3.6 可选执行器交付记录

本文件保留 2026-09-15 发布前的可选执行器验证记录和当时的制品哈希。后续 UI 观察性能修复的证据见 [性能评估](UI_OBSERVER_PERFORMANCE_ASSESSMENT_2026-09-15.md)；正式发布应从最终提交重新生成制品，不能直接使用下列历史归档。

2026-09-15。Android、Flutter Android 和 Web 的可选执行器已实现，并完成下述本地制品与运行验证。源码版本统一为 **0.3.6**；当前 Git HEAD 为 `295c40c0221fd5c25ad91e17131c53f1eed90edf`，本次源码仍在工作树中，尚未提交或发布到外部渠道。已有 Native 窗口、手势、selector 改动得到保留，未通过重置或清理工作树替换它们。

**Android 复用业务工程现有的 `androidTest` 和标准测试 APK，不需要独立业务 App、仓库或 Gradle 工程。** Bridge 仓库新增的是可复用的测试适配库。忽略目录中的独立消费夹具用于检查 Maven 制品能否脱离源码工程构建，不是业务方的必需接入结构。

## 已完成的能力

- [x] 保留现有 SDK 路径；新增 `android-executor`、`flutter-executor`、`web-executor`，接入 compact `capabilities + run` 和 Python／JS Script 的 `app.test` 权限。
- [x] Android 预编译常驻 JUnit 入口：启动参数、会话身份、串行执行、原始回执、取消、退出及进程恢复。每个业务流程由 Python／JS 编排，不用重新生成 Java／Kotlin 测试源码。
- [x] 同一 Instrumentation 会话中选择 AndroidX UI Automator、Espresso、可选 Espresso-Web／Compose；切换观察适配器使旧快照失效。
- [x] Flutter `integration_test` 常驻入口：WidgetTester 点击、长按、输入、滚动、导航、pump，以及原操作结束后结算取消。
- [x] Host 管理固定版本 Playwright 及匹配浏览器；页面 SDK 不引入这些依赖。支持页面、iframe、文档绑定、严格唯一定位及浏览器输入。
- [x] 统一设备占用、动作准入、持久化证据和去重；结果未知时不自动重放，也不切换执行机制。
- [x] Android 测试依赖、Flutter 开发依赖、Host 浏览器依赖分开放置。Compose 主包／测试包版本校验明确拒绝不匹配，不强制升级消费方的工具链。
- [x] 公共接入说明、可分发产物、干净安装、真实设备／浏览器验证及同语义性能比较。

固定 JUnit 入口是本版提供的测试执行服务；“远程运行任意现成 `@Test` 方法或原样兼容第三方测试脚本”不在本版命令合同内。完整依赖、示例、生命周期和动作机制见 [OPTIONAL_EXECUTORS.md](../desktop/ai-app-bridge-cli/docs/OPTIONAL_EXECUTORS.md)。

## 已验证的环境和范围

原始证据统一存放于 Git 忽略的 `build/executor-0.3.6/`。下列路径相对该目录；测试对象是 Bridge 自有样例和夹具，不是收银 App 的客户业务验收。

| 验证项 | 实际环境与结果 | 证据 |
| --- | --- | --- |
| Android 原生／H5／系统 UI | API 25 模拟器 `emulator-5580`、API 36 真机 `b46093e6`：Espresso 与 UI Automator 读取同一应用状态、中文输入、去重、旧快照拒绝、WebView DOM 与命名 iframe、系统相机权限弹窗及原生回调均通过。API 25 最终重跑使用 Maven 制品消费工程构建的主包与测试包，并独立检查 PackageManager 权限状态 | `api25/android-executor-verification.json`、`android-executor-verification.json` |
| Compose | Compose 1.8.3、Kotlin／Compose compiler 2.1.0；API 25／36 的最终 Maven 消费 APK 通过触摸点击、语义中文输入／清空、UI Automator 读回、快照失效及退出后回执 | `compose-executor-verification.json`、`api25/compose-executor-verification.json` |
| Flutter | Flutter 3.41.9／Dart 3.11 的 API 25 测试 APK，Flutter 3.44.8／Dart 3.12 的 API 36 测试 APK：取消 pump 后继续观察、点击去重、中文编辑状态、checkbox、页面跳转／返回、精确原进程退出均通过 | `api25/flutter-executor-verification.json`、`flutter-executor-verification.json` |
| Web | Playwright 1.63.0；macOS arm64 上 Chromium、Firefox、WebKit 均通过输入、选择、唯一性、去重冲突、取消、dialog、开放 Shadow DOM、跨域 iframe、上传、popup、文档失效及导航期间拒绝旧命令落到新文档 | `playwright-verification.json`、`playwright-firefox-verification.json`、`playwright-webkit-verification.json` |
| iOS 原生／内嵌 H5 | iPhone 17 Pro Max、iOS 27.0（24A437）、Xcode 27 beta；Kiwix 的 WDA／XCUITest 与 WKWebView SDK 配合完成原生搜索、键盘收起、H5 空文本及多行中文编辑、编辑器重建、书签保存／取消和真实 App 重启。JS 27 项、Python 18 项断言通过；独立 Core Data 快照核对两条书签及归属关系，5 项检查通过 | `ios-acceptance/kiwix-js/report.json`、`ios-acceptance/kiwix-python/report.json`、`ios-acceptance/kiwix-bookmark-oracle/result.json` |
| Flutter iOS | Flexify 2.1.109、Flutter 3.44.8；从实际 0.3.6 Flutter 分发文件构建并签名安装，运行时确认 SDK 0.3.6。JS 16 项断言覆盖计划创建、两组训练、重量修改、取消删除及图表；Python 4 项断言覆盖命名字段输入和未保存退出。独立 SQLite 快照确认恰有两条新增训练记录、14 次、625 kg，当日总量也是 625 kg，13 项检查通过 | `ios-acceptance/flexify-js/report.json`、`ios-acceptance/flexify-python-3/report.json`、`ios-acceptance/flexify-workout-oracle/result.json` |
| Python／JS | 真实安装的 CLI tarball 通过 Android／Web 各两种语言编排；Flutter 两套 SDK／设备组合也均通过两种语言编排，独立观察计数结果 | `executor-public-script-verification.json`、`flutter-public-script-verification.json`、`api25/flutter-public-script-verification.json` |
| CLI 分发物 | 审阅修复后的包在 Node 26.3.0 干净安装；native store 实际编译、MCP compact 工具、118 项命令发现、Script／Intent／权限／退出合同通过；最终包的 Web Python／JS 再次验证通过 | `cli-package-reviewed/report.json`、`review-public-web/executor-public-script-verification.json` |
| Android 分发物 | 六个适配 AAR、SDK 和 Gradle 插件发布到本机验证 Maven 仓库；独立消费夹具仅使用这些制品及上游依赖构建主包／测试包，未用 project/includeBuild 替代 Bridge 制品 | `android-artifact-consumer.log`、`delivery/archive-integrity.json` |
| 自动检查 | CLI 1307／1307、Web SDK 22／22、Android Debug JVM 191／191、Gradle 插件 8／8；新增执行器 Lint 零错误；Flutter helper 在两套 SDK analyze 均无问题 | `cli-review-regression-0.3.6.log`、`web-sdk-regression.log`、`android-final-checks.json`、`flutter-helper-analyze-3.41.log`、`flutter-helper-analyze-3.44.log` |

最终 CLI 包相对先前的 `cli-package-final` 修改了三个 Web 执行器文件和一份执行器文档，其余 **169 个文件逐字节相同**；iOS、Script、共享执行内核和 Android／Flutter 执行器代码均未变化，见 `cli-reviewed-equivalence.json`。Kiwix 验证使用前一分发包中相同的 iOS／Script 代码；Flutter iOS 和 Web Python／JS 使用审阅后的最终分发包。切换包前显式停止原 Runtime。

本机旧 Lint 不能解析已安装预览 SDK 的 `37.0` 字段；通过命令行 `-Pandroid.experimental.lint.version=9.3.2` 完成检查，未关闭 Lint 或修改消费方 AGP。剩余四条提示仅为 compileSdk／Compose 有更新版本，保持本版已验证的组合。

## 兼容性与故障验证

- 实测主包 Compose 1.7.4、测试包 1.8.3 会在中文替换时出现 `NoSuchMethodError`。新增 Gradle 插件实际拒绝该组合；统一主包与测试依赖的 BOM 后通过运行验证。证据：`compose-incompatible-build-rejected.log`。本版 Compose profile 是 1.8.3，不能把上游最新版本当作已验证支持。
- 旧 UIA runtime 和新的 Instrumentation 不能同时拥有 UiAutomation。Host 在原连接锁内等待原动作与回执结束，再有序移交；测试期间旧 UIA 请求明确拒绝。
- 一次 Flutter 验证中的原进程意外结束，没有完整操作回执。Host 保留“结果未知”和设备占用，经 boot ID／PID／进程启动时间核实原进程结束后，公开 `reconcile` 才释放占用；没有把该操作记成成功。其后的正常取消验证在两个环境中通过。证据：`flutter-interrupted-process-reconciliation.json`。
- API 25 上实际把 Espresso 点击的 Host 期限设为 150 ms；原触摸已经派发，取消等待原调用结束并恢复成功回执，重复 actionId 未再次点击，后续观察与关闭成功。证据：`api25/android-executor-cancellation.json`。这也证明“超时”不能被解释为点击未发生或已经回滚。
- Android 7 权限输出允许零 flags 时省略 `flags`，非零 flags 可用空格分隔；根据真实 API 25 输出和 AOSP `Settings.java` 修正严格解析，单元与实际权限流程通过。
- iOS 首次 XCTest 启动因手机尚未确认启用 UI 自动化而结束，原始结果明确结算并释放设备占用。用户要求重新触发后，WDA 14.1.1 成功启动；没有将第一次失败当成就绪。旧 WDA session 和旧 H5 pageRef 的动作均在派发前拒绝，后续观察仍为原文章。Kiwix／Flutter 两个故意错误的业务断言也分别正确判为失败，证据归档校验通过。
- Flexify 的 Plans 标签会恢复原有嵌套页面。两次 Python 前置页面等待失败均保留原始记录，未派发字段输入或保存；其中通用 `ios-flutter-back` 返回 `handled:true`，但根 Navigator 的处理并未关闭嵌套训练页面。根据真实截图和新节点观察，显式点击页面自己的返回按钮后，第三次 Python 流程通过。这个结果再次说明框架调用已处理不等于页面或业务结果已完成；没有为通过样例修改业务源码或自动切换失败动作。

## 发布审阅修复

规范审阅与功能审阅共发现三项问题，均已处理并复核；记录见 `release-review.json`。

- 观察控制项时保留空 `innerText`；没有该属性的元素按合同返回 `null`，不再使用隐藏的 `textContent` 替代。
- Web actionId 的回执目录改为整个会话共享，同时保留页面身份校验；在 popup 中重复使用同一 actionId 会在派发前拒绝，计数保持 0。4096 条容量也按整个会话计算。
- 物理 `wheel` 在悬停引发导航后可能作用于替换文档，已从本版公开动作和实现中撤出；不以合成 DOM 事件代替。`scrollIntoView` 等已有动作仍可用。

三种真实浏览器回归、最终分发包 Web Python／JS、干净安装以及 CLI 1307 项检查均在修复后通过。

## 性能结果

同一 API 36 真机、同一 APK／Activity／按钮、同一 Instrumentation 生命周期，交替执行 Espresso 触摸与现有 SDK 触摸；各 22 轮，去掉 2 轮预热，保留 20 个样本。两条路径用相同 Espresso 观察作为前后检查，每次都断言计数只增加 1。

| 指标，毫秒 | Espresso | 现有 SDK 触摸 |
| --- | ---: | ---: |
| 动作中位数 | 362 | 314 |
| 动作 p95 | 397 | 345 |
| 前后观察＋动作中位数 | 413 | 359 |

证据：`android-executor-benchmark.json`。包含 Host 执行和持久化；准备依赖、启动会话、CLI 新进程、模型、截图不计入热动作。**没有测出“接入 Instrumentation 就普遍更快”**。setter／语义输入可能很快，但不能用它与物理输入的耗时比较来证明同等交互加速。

## 交付物与本地使用

产物集中于 [delivery](../build/executor-0.3.6/delivery/manifest.json)，每个文件的 SHA-256 和长度保存在 manifest 中，归档内容已与原始文件逐字节核对：

| 文件 | 用途 |
| --- | --- |
| `mobileaidev-ai-app-bridge-0.3.6.tgz` | 本地 npm 安装 CLI；SHA-256 `a49ac7994b3f7f7eb6769df8431430ec627480c59620fd62c9f6d5a9224cc80d` |
| `mobileaidev-ai-app-bridge-web-0.3.6.tgz` | Web SDK npm 包 |
| `ai-app-bridge-android-maven-0.3.6.zip` | 本地 Maven 布局，含 SDK、插件、六个测试适配 AAR、元数据及适配器源码 JAR |
| `ai_app_bridge_test-0.3.6.tar.gz` | 可选 Flutter 测试 helper；6 个分发文件，pub dry-run 零警告 |
| `ai_app_bridge_flutter-0.3.6.tar.gz` | 同步版本的现有 Flutter SDK 源码包，55 个分发文件 |

本地验证 Maven group 为 `io.github.mobileaidev.aiappbridge`。将 Maven ZIP 解压到目录后，在消费工程的 repositories／pluginManagement 中指向该目录，依赖例如 `io.github.mobileaidev.aiappbridge:ai-app-bridge-test-instrumentation:0.3.6`。正式 JitPack group 与发布顺序见[发行说明](../desktop/ai-app-bridge-cli/docs/RELEASE.md)，不能把本机解析成功写成公共 JitPack 已发布。

Flutter 源码包可解压后作为 path dependency；helper 放入消费 App 的 `dev_dependencies`。现有 Flutter SDK 的 Android 依赖仍需相应 0.3.6 Android 制品；它与测试 helper 的独立接入要求不同。工作树内 SDK 的 pub dry-run 唯一警告是 6 个已跟踪文件尚未提交，未为消除警告擅自提交代码。同一组 55 个分发文件导出到仓库外后，pub dry-run 零警告，见 `flutter-sdk-clean-export-dry-run.log`；在 Git 忽略目录中执行 pub 会继承忽略规则，不能用该目录的打包清单代替正式导出。

收尾时两台设备的公开占用状态均为 `idle`、`active: 0`，见 `final-device-ownership.json`。本轮创建的模拟器进程在验证结束后关闭，设备记录与复现材料保留。

iOS 补验后，设备公开占用同样为 `idle`、`active: 0`，本轮绑定的 App 进程、WDA／Flutter 启动器均已结束，验证 Runtime 已停止。详情见 `ios-acceptance/report.json`；随后观察到的另一个未绑定 Kiwix 进程保留，未按旧 PID 或 App 名称扩大清理范围。

## 明确的边界

- iOS 保留已有 WDA／XCUITest 和 SDK。本轮根 Swift Package 消费工程、Kiwix、Flexify 和 WDA 均完成 iOS 构建；Kiwix／Flexify 签名校验及真机安装通过，原生／H5／Flutter 验证范围如上。根 Package 直接引用大工作树时，Xcode 卡在递归扫描生成目录；对相同的共 27 个 manifest／源码文件的干净导出构建通过，未修改包结构来绕过。实际运行覆盖本次 iPhone／iOS 27 beta 组合，不推导其他 iOS 版本均已验收。
- Flutter 测试 Host 本版支持标准 Android embedder。Flutter iOS／desktop／web 测试启动、系统弹窗和原生 platform view 的 WidgetTester 操作不在该 helper 的支持范围内。
- WebView 的 Espresso-Web 使用 JavaScript atoms；浏览器 Playwright、Android 系统触摸、Compose／Flutter 语义输入各自记录机制，不能统一称为物理用户操作。
- Android minSdk 23 是依赖声明；本轮实际设备下界为 API 25，尚未实测 API 23／24。其他 AGP／Kotlin／Compose／Flutter／Host OS 组合需要明确验证，不能由本表推出全版本兼容。
- 回执去重限于原会话，不保证跨进程丢失后的业务 exactly-once。操作框架返回不等于支付／订单成功；应观察并断言业务结果。会话回执按需归档清理，不删除未知回执来解除占用。
- 本轮未执行 Git 提交／推送、npm／pub.dev／JitPack 发布，也未修改全局 CLI 安装。公开渠道版本与具体收银 App 业务验收属于另有证据的状态。
