# 0.4.2 强制停止与统一发布记录

2026-10-06，CLI/MCP、Android SDK/Gradle plugin/六个执行器、iOS Swift 包、
Flutter SDK/测试辅助包、Web SDK 统一发布为 **0.4.2**。发行标签固定于
`510327138f7f76c8311a59dbdda166572981c78e`。
本记录及 remote-smoke 公开依赖升级通过发布后的提交保存，不移动发行标签。

## 强制停止入口

```sh
ai-app-bridge device-ownership --operation force-stop --serial SERIAL --extract null
```

MCP 使用 `run`：

```json
{"command":"device-ownership","arguments":{"operation":"force-stop","serial":"SERIAL"},"extract":null}
```

该管理入口在 CLI/MCP 客户端独立执行，在连接 Runtime、检查版本及进入普通
设备队列之前生效。旧任务没有终态、原 agent 消失、Host 卡住或旧记录损坏时，
均可显式终止占用并重置；占用错误和 unresolved 状态附简短 `recoveryHint`。

操作停止记录中的拥有者及共享 Host，停止目标手机 UIA、受管 shell worker、
记录中的 SDK/测试 App，归档原始历史并清空占用。那些 Host 中的其他任务也会
停止。原任务记录为 `force_stopped/unknown`，已发生的手机效果不会回滚。
保留原锁文件，使用独立管理门控制重置与新操作的进入；PID 身份核对避免误杀
复用该 PID 的其他进程。

手机断连时先解除本地占用，返回 `remoteResetPending:true`；重连并再次执行
同一命令完成手机重置，然后才能执行新动作。重置客户端中途崩溃留下的记录
也可再次通过此入口恢复。

## 公开渠道

| 渠道 | 核验结果 |
| --- | --- |
| [GitHub Release / iOS Swift Package](https://github.com/mobileAiDev/ai-app-bridge/releases/tag/0.4.2) | 公开正式版且为 latest；发行标签提交一致；附 CLI 与 Web 受检归档 |
| [npm CLI/MCP](https://www.npmjs.com/package/@mobileaidev/ai-app-bridge/v/0.4.2) | latest、next 均为 0.4.2；公开 tarball 与最终候选包逐字节一致，197 个文件与发行源码一致 |
| [npm Web SDK](https://www.npmjs.com/package/@mobileaidev/ai-app-bridge-web/v/0.4.2) | latest、next 均为 0.4.2；公开 tarball 与候选包逐字节一致，6 个文件与发行源码一致 |
| [JitPack Android](https://jitpack.io/#mobileAiDev/ai-app-bridge/0.4.2) | 构建成功，状态 API 中提交一致；SDK、插件、六个执行器的 16 个公开 POM/二进制校验通过 |
| [pub.dev Flutter SDK](https://pub.dev/packages/ai_app_bridge_flutter/versions/0.4.2) | 公开归档 SHA-256 与服务端元数据一致，56 个文件与发行源码一致 |
| [pub.dev 测试辅助包](https://pub.dev/packages/ai_app_bridge_test/versions/0.4.2) | 公开归档 SHA-256 与服务端元数据一致，6 个文件与发行源码一致 |

| 归档 | SHA-256 |
| --- | --- |
| npm CLI/MCP | `47bb44c18ff48771f7b3dd90ad415f2dd5472bea267f47171df99d47b5ea1bbf` |
| npm Web SDK | `6151049a82c4d65c708f783d6a6be9da9bcf468d027eb0590eb64a73b1505b80` |
| pub.dev Flutter SDK | `1dbcd11fc09aa53c938d283f2c80d5ac58cdbcfde58d2004512112245347ad61` |
| pub.dev 测试辅助包 | `dba5fedfd84a21e13e1cc942fa97c13746cdaf19ae4bb6dd994eac0173091065` |

嵌入式 native store 是内部依赖，仍为 0.2.0。

## 验证

- Host 功能 1338 项、性能 50 项，共 1388 项通过；UIA JVM 47 项通过。
- 最终 CLI 归档在仓库外全新安装，预编译 native 加载、123 命令发现、CLI/MCP、
  提取合同、两种脚本语言及 Runtime 行为通过；安装检查禁止调用编译器/Python。
- Android 全模块 build/lint/单测和本地 Maven 发布通过；iPhoneOS unsigned
  Swift 构建通过；Flutter SDK 66 项测试及分析通过，Web 23 项测试及 build 通过。
- 两份 Flutter 包发布预检均为零警告；测试辅助包仅分析通过，没有 test 目录。

真机 `b46093e6` 原 unresolved 动作在首次强制停止中完成归档和占用重置。
最终受检归档通过新 MCP 强制停止运行中的 UIA，确认新的 runtimeEpoch，
随后完成 UI 观察及 keyevent，最终 ownership 为 `idle/active=0`。
最终 resetId 为 `6875a9ed-44a8-4e21-8710-e373670de375`，新 UIA epoch 为
`667d4e98-5c50-47c0-b60b-240042b8dd78`。
该证据验证 Bridge 恢复及新会话可继续操作，不包含央视频业务问题修复验收。

## 本机入口

全局 `/opt/homebrew/bin/ai-app-bridge` 及 MCP server 已安装为 0.4.2，197 个
文件与公开 npm 归档逐字节一致。安装时使用受检候选包，公开下载后确认其与
候选包完全相同。Codex、Cursor 配置指向该全局 server；Antigravity 配置的
`ai-app-bridge-mcp` 也解析到同一个全局安装，无须修改命令或权限设置。
全局 ai-app-bridge-use skill 已同步强制停止说明。

新全局 MCP 的 null、regex、JS、Python、预期提取失败和 Script runtime-status
六项检查通过。Cursor GUI 已执行 Reload。当前 Codex 对话的旧 MCP 连接已重启，
实际能力发现包含 `force-stop`，Runtime 版本为 0.4.2、`compatible:true`，
runtimeId 为 `283e0c17-975b-4482-b16c-b14eab389f61`。
其他已运行的独立客户端会话仍需各自重连，才能加载新版客户端代码。

remote-smoke 的公开 npm 依赖、锁文件及实际安装均为 Web SDK 0.4.2；
require 检查和 npm ls 通过，6 个安装文件与公开归档一致。

## 保留的失败与证据

Android 首次 lint 受全局预览 SDK 的 `37.0` 元数据影响，独立稳定 SDK 下
全模块检查通过，未更改 AGP/compileSdk。真机首次运行中 UIA 重置暴露短名称
`app_process` 未匹配的问题；匹配逻辑及专项测试补齐后重新打包，最终真机重置通过。
首次能力发现探针错误地使用 operation 过滤器，改为该命令支持的 command 级
发现后通过；保留原失败记录。

JitPack 首次触发超时及一次产物下载失败后，公开构建与全部 16 个产物通过。
构建日志的 Git metadata 因 dubious ownership 未打印提交，提交一致性由 JitPack
构建状态 API 确认；完整日志包含 BUILD SUCCESSFUL。
npm 两次验证链接过期，新的发布验证完成后 CLI/Web 上传及 next 标签更新成功。
上传返回 202 后存在扫描等待期；最终均从匿名公开 registry 下载并核验成功。

证据目录：
`/Users/macbook/Documents/CompanyProject/ai-app-bridge-release-evidence/0.4.2-2026-10-06`。
发布前门禁见 `prepublication-report.json`；真机恢复见
`mcp-force-control/report.json`；公开渠道和本机入口见 `publication/report.json`，
当前连接见 `publication/connected-mcp-final.json`。
原始失败和最终通过记录均保留，`manifest.json` 汇总证据文件校验值。
