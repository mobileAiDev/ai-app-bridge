# 0.4.0 改善版发布与消费项目升级记录

2026-09-19，0.4.0 已完成公开发布。发行标签固定于
`dfb0016079e431c85825d3deb0cabd5892cd47ac`，源码已推送 `origin/main`。
本记录在发布后补齐，不移动发行标签。实施、四轮验收、设备与客户端证据见
[M4 验收记录](IMPROVEMENT_RELEASE_V1_M4_2026-09-19.md)。

## 核心变化与迁移

外部 CLI/MCP run 必须明确提供 `extract`：不提取时为 `null`，CLI 使用
`--extract null`。支持 regex、JavaScript、Python，最终紧凑 JSON 正文默认
96 KiB。执行结果、控制字段与提取结果分开返回；提取失败不重放动作，已保存
响应可用原 ref 重新提取。原 `_history` / `_meta` 副本不再交付。
Script 的内部 `ctx.call` 合同保持原有形式。

本版同时交付紧凑输出、可修正的错误说明、可运行的流程示例、有界 Script
诊断、启动身份检查与执行器准备预检。Node 要求为 `>=26.3.0 <27`；
FactStore 随包提供，无需单独服务。普通 MCP、JS、regex 无需 Python 或编译器。
Python 只在选择 Python 执行时需要。

## 公开渠道核验

| 渠道 | 核验结果 |
| --- | --- |
| [GitHub Release / iOS Swift Package](https://github.com/mobileAiDev/ai-app-bridge/releases/tag/0.4.0) | 已公开，非 draft、非 prerelease；Git tag 固定于上述提交 |
| [npm CLI/MCP](https://www.npmjs.com/package/@mobileaidev/ai-app-bridge/v/0.4.0) | `latest`、`next` 均为 0.4.0，公开 tarball 与最终验收包逐字节一致 |
| [npm Web SDK](https://www.npmjs.com/package/@mobileaidev/ai-app-bridge-web/v/0.4.0) | `latest`、`next` 均为 0.4.0，公开 tarball 与受检源码一致 |
| JitPack Android | 构建成功且提交一致；SDK、Gradle plugin、六个 executor 共 16 个公开 POM/二进制下载、身份、依赖、ZIP 和关键类检查通过 |
| [pub.dev Flutter SDK](https://pub.dev/packages/ai_app_bridge_flutter/versions/0.4.0) | 公开归档 SHA-256 与服务端元数据一致，56 个文件与发行源码一致 |
| [pub.dev 测试辅助包](https://pub.dev/packages/ai_app_bridge_test/versions/0.4.0) | 公开归档 SHA-256 与服务端元数据一致，6 个文件与发行源码一致 |

| 归档 | SHA-256 |
| --- | --- |
| npm CLI/MCP | `63239bda91fda7f8f89afc7d8fa8e0ed1f4aca8d9a488ff9cda03afc4adff040` |
| npm Web SDK | `1591dc55ba2e707257dfd4fbf94a66b399ea854fb74f38a8bfa1125ccf37d043` |
| pub.dev Flutter SDK | `5ad5d200c9b25566ac51daf5300a251730ebbea46f29db41605f4d2e4367ae8b` |
| pub.dev 测试辅助包 | `69a3ad3efdc5d1a31e7088e402d22d832b72cbd48e9b36442eb089a867f0b168` |

JitPack 首个触发请求曾在 120 秒后超时，后续公开 API、构建日志和全部文件均
成功；保留首次超时记录，不把它冒充构建完成。npm 登录、发布和修改 dist-tag
分别触发了官方身份验证，用户完成验证后操作成功，没有关闭认证要求。

## 本机实际入口

全局 `/opt/homebrew/bin/ai-app-bridge` 已从公开 npm 安装至 0.4.0，安装目录
195 个归档文件与公开 tarball 逐字节一致。npm 11.16 没有执行 native 包的
安装脚本；运行时直接加载随包预编译产物，实际检查通过，未调整 npm 全局
脚本许可或调用本地编译器。

更新前后台 Runtime 为旧代码，安装后检查明确显示 `compatible:false`。
随后显式停止旧 Runtime 并启动 0.4.0，新 CLI 状态为 `compatible:true`。
新建全局 MCP 连接与同一 Runtime 对齐，null、regex、JS、Python、预期提取
失败及经过 Host 的 Script runtime-status 六项检查通过，无设备查询或动作。
公开 npm 的固定版本 npx 在独立空缓存中首次、重复启动均为 0.4.0，缓存的
195 个包文件与公开归档一致；实际 npx MCP 的 initialize、required/null
schema 与同一 Runtime 的连接检查也通过。

本机 Codex 的 `ai-app-bridge-use/SKILL.md` 原本与 0.3.8 基线逐字节一致，
现已同步为公开 0.4.0 包内指引，包含必填 extract、控制字段、预算和按 ref
重读规则。保留修改前快照，没有覆盖本机定制内容。

已有 Cursor/Codex 窗口中的旧 MCP 进程未被强行结束，仍需重连。
其配置已指向上述全局安装路径，重连将加载 0.4.0；全局安装成功不等于旧连接
已刷新。发布前真实 Codex 和 Cursor 候选客户端验收另见 M4。

## 消费项目升级

更新限定为已有 Bridge 依赖，不升级业务依赖、AGP、compileSdk 或项目声明的
工具链。保留已有工作区改动与 CRLF，不代为提交外部项目；没有安装新业务
APK/IPA，也没有执行 POS 业务/设备流程。

| 项目 | 最终状态与验证 |
| --- | --- |
| POS | SDK/plugin 0.4.0；SIT、UAT 的 RuntimeClasspath 解析与两个 Debug 构建通过 |
| PDA | SDK/plugin 0.4.0；retailUatDebug 解析与构建通过，使用项目原有 JDK 11 |
| Reader | SDK/plugin 0.4.0；Debug 解析与构建通过 |
| MeasureDevice / measure-assist-android | SDK 0.4.0；Debug 解析与构建通过 |
| MeasureDevice / protocol-lab-android | SDK 0.4.0；Debug 解析与构建通过 |
| game-mirror-mapper | SDK 0.4.0；Debug 解析与构建通过 |
| Legado | SDK 0.4.0；appDebug 解析与构建通过，使用项目原先指定的 Gradle 8.13 |
| Novel | Bridge 单项依赖升级为 0.4.0；严格锁文件解析、Dart analyze、Debug Dart bundle 及 8 项现有边界测试通过；非 Bridge 锁文件内容逐字节保持 |
| Web remote-smoke | 公开 npm 安装 0.4.0，require 检查及 npm ls 通过 |
| Kiwix | 发布前已构建、安装并真机核实 SDK 0.4.0，本轮不重复安装 |
| Courier | 用户明确排除；本轮两个文件的版本修改已撤回，均与修改前快照逐字节一致，保持 0.2.12；不再继续构建 |

七个 Android 构建根共八个 RuntimeClasspath 与八个 Debug 变体通过。解析所得
SDK/plugin 二进制 SHA-256 与公开 JitPack 产物一致，没有以本地 Maven 包替代。
验证过程中临时解析探针和调用环境的问题已经修正；原失败日志保留。PDA 按
项目已有设置使用 JDK 11；Legado 的原 gradlew 带 CRLF，验证直接调用相同版本
的已缓存 Gradle，未修改脚本或升级工具链。

Novel 原配置指向的 Flutter 3.35.8-ohos-0.0.3 本机不存在。本次用隔离的官方
Flutter 3.35.7 / Dart 3.9.2 对旧锁文件和升级后分别验证，保留项目原 SDK 配置；
结果不包含 OHOS、Gradle/Xcode 原生构建或设备业务流程。镜像版本列表尚未列出
0.4.0，因此仅 Bridge 明确使用 pub.dev，其余依赖来源与锁文件保持原样。

LocalSend、Flexify 的接入脚本和模板已更新为 0.4.0，并通过最小上游夹具检查；
本机没有对应完整上游 checkout，未宣称完成新业务构建。历史 vivo-site 路径
本机不存在，不计为已升级项目。最终保留 13 个依赖文件的修改，Courier 的两个
文件只保留撤回证据。

## 证据与适用边界

持久证据目录为
`/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/0.4.0-2026-09-19`。
发布前证据由根目录 `manifest.json` 冻结；发布后回执保存在 `publication/`，
消费依赖前后快照、实际解析、构建日志保存在 `consumer-upgrades/`。
三个目录分别保留独立 manifest，发布前快照不混入发布后的运行记录。
消费项目最终对账为 `consumer-upgrades/report.json`。

| 证据清单 | 文件数 | manifest SHA-256 |
| --- | --- | --- |
| 发布前 `manifest.json` | 125 | `62db889017e067ff94c6f108ebfbd3edec457380395be802db7b332e5eb836d3` |
| `publication/manifest.json` | 148 | `7e334233ed2b8eae525dcaef44e011df5376af025bee7b5f8e91e5d491149810` |
| `consumer-upgrades/manifest.json` | 150 | `a52046eef5f2ddce46b4b288b9b0e6c2159ac4f754a6646c4a1066e463f090b0` |

发布前通过 1375 项 Host、138 项 NotallyX 夹具、66 项 Flutter、23 项 Web
检查，以及 Android/Swift 构建、四平台 native 与全新安装检查。真实设备验证
使用 OPPO 测试 App 和 iPhone Kiwix SDK 0.4.0，不代表消费者全部业务功能
验收。macOS / Linux 的 x64 验证使用 Rosetta；最低 macOS/glibc 版本与物理
x64 主机未实测。Windows / musl 不在本版支持范围。

本轮范围内没有剩余发布阻塞。外部项目依赖修改保留在各自工作区；用户已有
Cursor/Codex 会话需要重连 MCP 才会加载全局 0.4.0。
