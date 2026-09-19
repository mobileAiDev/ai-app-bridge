# 0.4.1 统一补丁发布与消费项目升级记录

2026-09-19，CLI/MCP、Android SDK/Gradle plugin/执行器、iOS Swift 包、
Flutter SDK/测试辅助包、Web SDK 统一发布为 **0.4.1**。发行标签固定于
`620b53fb8078c3ad7f1e17e74bec6a82fa33bc7c`；旧 0.4.0 标签及归档不变。
本记录和 remote-smoke 公开依赖升级在发布后提交，不移动发行标签。

## 修复与兼容

- iOS 观察控制不再创建物理设备动作 ownership；旧版本误记的特定
  `ios-ui-observation` marker 可通过显式 `ios-execution reconcile` 恢复。
  未知 UI 动作仍需原完成凭据，不新增 force-release，也不重放动作。
- 提取临时目录清理失败放入 `extraction.cleanupError`，保留成功结果或原始
  提取错误及对应退出码，正常释放 worker 槽位。
- 所有公开 Bridge 组件及依赖统一版本。设备与 Web SDK 执行合同未改；
  `extract` 必填、96 KiB 默认预算与超预算 reference 交付合同保持不变。

根因、修改前失败、修改后通过及真机恢复证据见
[Grok 报告复核](HOST_0.4.0_GROK_REVIEW_2026-09-19.md)。报告中的第三项
`output_budget_exceeded` 属于已冻结的正常合同，本次没有修改该行为。
嵌入式 native store 是内部依赖，仍为 0.2.0，18 个归档文件与 0.4.0 主包
逐字节一致，复用此前四平台预编译产物验收。

## 公开渠道

| 渠道 | 核验结果 |
| --- | --- |
| [GitHub Release / iOS Swift Package](https://github.com/mobileAiDev/ai-app-bridge/releases/tag/0.4.1) | 公开正式版；标签提交与发行源码一致 |
| [npm CLI/MCP](https://www.npmjs.com/package/@mobileaidev/ai-app-bridge/v/0.4.1) | latest、next 均为 0.4.1；公开 tarball 与最终候选包逐字节一致 |
| [npm Web SDK](https://www.npmjs.com/package/@mobileaidev/ai-app-bridge-web/v/0.4.1) | latest、next 均为 0.4.1；公开 tarball 与受检候选包逐字节一致 |
| JitPack Android | 构建成功且提交一致；SDK、插件、六个执行器的 16 个 POM/二进制下载、版本、依赖、ZIP 和关键类检查通过 |
| [pub.dev Flutter SDK](https://pub.dev/packages/ai_app_bridge_flutter/versions/0.4.1) | 公开归档 SHA-256 匹配服务端元数据，56 个文件与发行源码一致 |
| [pub.dev 测试辅助包](https://pub.dev/packages/ai_app_bridge_test/versions/0.4.1) | 公开归档 SHA-256 匹配服务端元数据，6 个文件与发行源码一致 |

| 归档 | SHA-256 |
| --- | --- |
| npm CLI/MCP | `79bb5ae2f6b75847c76bf0e551b3623ac9e6ec178f7db510077ee87ffd8a8275` |
| npm Web SDK | `d9fbb9a99e83c65a3bfad0a5ba2bf4089c2fba924afdfba1067e30186f88fc39` |
| pub.dev Flutter SDK | `36d1ce9dc6537c15e8659a6b72021db63548715b55a9f4e6c6a96885b7362ea8` |
| pub.dev 测试辅助包 | `ef589b13fb2ab8df6c06db07f53c036ed53ef9405e8bfe0033ec1a8a4335ae50` |

## 验证与本机入口

修复代码通过 1378 项 Host 测试。最终 0.4.1 CLI 包通过仓库外全新安装、
123 命令发现、CLI/MCP、两种语言、预算/引用恢复及三个缺陷复现探针。
安装时实际执行 native 安装脚本并加载预编译产物，编译器/Python 被拒绝调用。
SDK 版本同步后通过 Android build/lint/单测、iPhoneOS SDK 构建、Flutter
66 项测试与分析、Web 23 项测试，两份 Flutter 包发布预检均为零警告。
Flutter 测试辅助包没有 test 目录，不能将其 `flutter test` 记为通过。

本机全局 `/opt/homebrew/bin/ai-app-bridge` 已从公开 npm 安装为 0.4.1，
195 个文件与公开 tarball 一致。旧 Runtime 显式停止后，新 Runtime 为
0.4.1，`compatible:true`。新建全局 MCP 的 null、regex、JS、Python、
预期提取失败、Script runtime-status 六项检查通过。独立空 npm 缓存的
固定版本 npx MCP 初始化和 schema/Runtime 检查通过；重复 CLI 启动及缓存
195 个文件的归档对照也通过。已有 Cursor/Codex MCP 连接需要重连加载新代码。

真实 iPhone 的旧 observation marker 恢复及后续 launch 在发布前修复审核中
已通过，设备 App 的 SDK 为 0.4.0。本次 SDK 改动仅为版本/依赖同步，没有
安装新业务 APK/IPA，也没有将历史设备结果写成 0.4.1 设备或业务验收。

## 消费项目

| 项目 | 结果 |
| --- | --- |
| POS | SDK/plugin 0.4.1；SIT、UAT RuntimeClasspath 和两个 Debug 变体通过 |
| PDA | SDK/plugin 0.4.1；retailUatDebug 解析与构建通过，使用原 JDK 11 |
| Reader | SDK/plugin 0.4.1；Debug 解析与构建通过 |
| MeasureDevice 两个 Android 工程 | SDK 0.4.1；各自 Debug 解析与构建通过 |
| game-mirror-mapper | SDK 0.4.1；Debug 解析与构建通过 |
| Legado | SDK 0.4.1；appDebug 解析与构建通过，沿用原 Gradle 8.13 |
| Novel | 仅 Bridge 升至 0.4.1；严格锁文件解析、Dart analyze、Debug Dart bundle、8 项既有边界测试通过 |
| Web remote-smoke | 公开 npm 0.4.1 安装、require 检查、npm ls 通过 |
| Kiwix | 已有本地 Swift 包引用使用 0.4.1，iPhoneOS App 构建通过；本次未签名或重新安装 |
| LocalSend / Flexify | 已有接入模板同步 0.4.1；没有完整上游 checkout 的新构建证明 |
| Courier | 按用户要求排除，本次未修改 |

七个 Android 构建根共八个 RuntimeClasspath、八个 Debug 变体通过；解析的
SDK/plugin SHA-256 与公开 JitPack 产物一致。外部项目 11 个依赖文件保留在
各自工作区，未代为提交；加上本仓库 remote-smoke 两个文件，共 13 个。
保留原 CRLF 和已有工作区改动，不升级业务依赖或工具链。
Novel 使用上一轮已准备的独立 Flutter 3.35.7 / Dart 3.9.2；其他 99 个依赖的
锁文件内容逐字节不变，项目原 SDK 配置及生成设置已还原。该结果不包含 OHOS
或原生构建与设备业务流程。

## 保留的失败与证据

Android 首次 lint 受全局预览 SDK 的 `37.0` 元数据干扰，换回上一版使用的
独立稳定 SDK 目录后通过；未修改项目 AGP/compileSdk。Flutter 首次 dry-run
只提示尚未提交版本文件，提交后零警告。JitPack 首个触发请求超时，后续状态、
完整构建日志和全部公开产物通过。npm 首次认证请求失效，确认未发布后重新
认证成功；两次 next 标签认证由用户完成。

Novel 首次读取到发布前版本缓存；公开索引更新后保存并刷新该包的缓存。
第二次检查遗漏项目原镜像环境，严格锁文件模式拒绝了无关依赖变化；恢复原
镜像环境后全部检查通过。pub 对新 SHA-256 添加引号曾触发验证脚本的字节
断言，复核确认仅 Bridge 条目变化，其他依赖字节不变；没有修改业务依赖。

证据目录：
`/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/0.4.1-2026-09-19`。
发布前放行见 `prepublication-report.json`，公开渠道及本机入口见
`publication/report.json`，消费项目见 `consumer-upgrades/report.json`。
原失败日志和最终成功记录均保留，`manifest.json` 汇总证据文件校验值；
不把缓存、安装目录或派生构建目录当作独立验收报告。
