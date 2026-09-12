# 0.3.0-rc.3 发行与接入交接

本文件记录候选版的依赖关系和出仓库交付入口。封版要求是同一提交的源码、发行包与公开接入合同一致；单个样本的测试进度不改变包版本或发布状态。推送 Git、创建远端标签及发布 npm/pub 包由维护者执行。

## 版本与消费方式

| 交付物 | 候选版本 | 独立消费入口 | 发布依赖 |
| --- | --- | --- | --- |
| Android SDK | `0.3.0-rc.3` | JitPack `com.github.mobileAiDev.ai-app-bridge:ai-app-bridge-android:0.3.0-rc.3` | 同名 Git tag，JitPack 对该提交成功构建 |
| Android Gradle 插件 | `0.3.0-rc.3` | JitPack `ai-app-bridge-gradle-plugin` 模块及插件 ID `io.github.mobileaidev.aiappbridge.android` | 与 SDK 相同的 Git tag；不再使用旧默认 `0.2.8` |
| 原生 iOS SDK | Git tag `0.3.0-rc.3` | Git URL 的仓库根 `Package.swift`，产品 `AiAppBridgeIOS` | 根清单包含 Swift runtime、C adapter 和 segmented C store，无外部 C 包路径 |
| Flutter 插件 | `0.3.0-rc.3` | pub `ai_app_bridge_flutter` | Android 固定依赖上述 SDK；iOS Swift/C 源码随插件分发 |
| Desktop CLI/MCP | `0.3.0-rc.3` | npm `@mobileaidev/ai-app-bridge` | 包含 UIA bundle、WDA 模板和 native store 源码；WDA 上游固定 `14.1.1` |
| Web SDK | `0.3.0-rc.3` | npm `@mobileaidev/ai-app-bridge-web` | 独立浏览器源码包，无 npm 对 CLI 的安装依赖 |
| Native store | `0.1.0` | 随 CLI 的 bundled dependency 安装 | 不要求另行发布到 npm；`file:../../native/segmented-fact-store` 是工作区构建入口，最终 tarball 必须包含该依赖源码 |

Flutter 的 podspec 是随 pub 插件消费的本地 podspec，不是独立 CocoaPods trunk 发布包；原生 iOS 使用根 Swift package。Flutter SwiftPM 的 `../FlutterFramework` 由 Flutter 的集成生成，不能当作本仓库的外部私有依赖，也不应将本机 Flutter framework 打包进插件。

Host 支持范围声明为 Node `>=26.3.0 <27`，本轮实际验证基线是 **26.3.0**。共享 runtime 与查询索引依赖 `node:sqlite`，native store 安装需要 node-gyp 所需的 Python 和 C/C++ 编译工具。未对其他 Node 版本或跨主版本兼容作实测声明。Python Script 另需可用的 `python3`，从实际 `script runtime-status` 读取环境能力。

## 发布顺序

1. 完成源码审阅并冻结一个提交，核对以下命令的产物确实来自它；包含当前 untracked 的实际源码、测试和文档，排除本机生成目录。所有候选对外版本使用同一个 `0.3.0-rc.3`，若需要改版本，先同时更新上表涉及的 manifest 与固定依赖。
2. 维护者推送提交与 `0.3.0-rc.3` 标签，让 JitPack 构建 Android SDK/插件。确认两条公开坐标可解析后，再发布依赖它们的 Flutter 包。本地 Gradle project/path/AAR 替换不能证明 JitPack 坐标可消费。
3. 原生 iOS 消费相同 Git tag 的根 package；完成根 package 的 iOS 构建，不仅构建 `ios/ai-app-bridge-ios/Package.swift`。Flutter iOS 则检查实际 pub 包内 Swift/C 源码与声明相符。
4. CLI 与 Web SDK 可分别发布到 npm 的候选 dist-tag。CLI 的 native store 已打包随行，不等待一个不存在的单独 registry 依赖。Flutter 包发布以第 2 步完成为前提。
5. 从 registry/tag 安装刚发布的确切版本，读取 `capabilities` 和版本，核对来源及支持范围，再按发布策略提升正式 dist-tag。候选发布不自动等于全平台生产验收完成。

候选发布命令需在对应目录由维护者执行，例如 npm 使用 `npm publish --tag next`；pub 使用 `flutter pub publish`。这些命令属于发布动作，不能混入本地验证脚本。

## 本地检查与最终包验证

以下检查不发布版本。路径相对仓库根；输出使用新的、Git 忽略的目录。

```sh
swift package --package-path . dump-package
swift package --package-path ios/ai-app-bridge-ios dump-package

cd desktop/ai-app-bridge-cli
npm pack --dry-run --json --ignore-scripts

cd ../../web/ai-app-bridge-web
npm pack --dry-run --json --ignore-scripts

cd ../../flutter/ai_app_bridge_flutter
flutter pub publish --dry-run
```

`dump-package` 只证明 manifest 可解析及目标声明，不能替代 iOS 编译；`npm pack --dry-run` 只证明拟打包文件清单，不能替代安装；pub dry-run 中的分析/网络检查结果应原样记录。干净安装与 Host 协议验证必须在核心源码冻结、没有运行中修改时执行：

```sh
cd desktop/ai-app-bridge-cli
npm ci
npm run verify:package -- ../../build/ai_app_bridge_artifacts/release-package-NEW
```

`verify:package` 在仓库外安装实际 tarball，检查 native 安装编译、CLI/MCP 共享运行时、控制接口与随包运行时身份。它使用受控 ADB，不声称完成新真机业务验收。报告、tgz 哈希、安装日志和源码提交身份一起交接；已运行的旧包验证不能代替后来修改过的包。

CLI 的 `files` 已排除旧 `fact-cache.js` 发布载荷及 fake/P9/旧设备 adapter；旧 fact-cache 实现仅保留为 `test-support` 测试夹具，无生产引用。各 npm 包和 Flutter 目录的 `LICENSE`/`NOTICE` 均来自仓库根原文，发行时核对内容一致，不生成替代版权说明。
