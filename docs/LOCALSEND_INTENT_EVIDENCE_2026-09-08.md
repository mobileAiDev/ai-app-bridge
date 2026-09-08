# LocalSend：第二个复杂 App 的 Intent 证据关口

本轮推进到 **LocalSend 真机可探索、结果可独立核验、证据可搬移**。独立上下文编写 Script 及重复运行仍未完成。LocalSend 用来暴露 Bridge 的通用缺口，本轮修改只涉及接入和 Bridge，不改变其业务逻辑。

## 固定环境

- LocalSend v1.18.2，commit `af0416be50770a97760f7070684bc667b759a15c`；Flutter 3.41.9、Rust 1.97.1。
- 本地 sample：[`examples/localsend-sample`](../examples/localsend-sample/README.md)。上游源码在被 Git 忽略的 `upstream/`，接入改动可由 `integrate.py` 复现。
- 设备 OPPO PGFM10，serial `FYZLAU49X8OVQGJ7`；本轮主动设备操作均指定这台 OPPO，未对另一台 OPPO 或 iOS 做实测。
- 独立调试包 `org.localsend.localsend_app.bridge_sample`，版本 1.18.2 / 64；使用当前仓库 MCP 和本地 Android AAR。
- 最终 APK SHA-256：`19276549d5d7a7dddb4d98d2d825b79516562016117a1d84de99c4f1299d0219`。手机安装文件的 SHA-256 与冻结 APK 一致，见 [`installed-apk-final.json`](../build/ai_app_bridge_artifacts/localsend-evidence-2026-09-08/installed-apk-final.json)。
- 初始设置夹具显式保存 theme=system、color=system，locale 未存储而跟随中文系统。首次默认主题原本未存储；夹具准备时显式选为 System，不能把这一步说成原始数据零变化。

## 实际发现并修复的 Bridge 缺口

| 缺口 | 改动与证明 |
| --- | --- |
| 底部收发、设置按钮在截图中可见，Flutter 操作树缺少标签 | 读取 `NavigationDestination.label` 与各自区域。Widget 测试点击返回坐标，验证真实页面切换；OPPO 上用 Intent 复核。 |
| 三个设置项都叫“跟随系统”，文本选择隐式取第一个 | Host 要求唯一精确文本或当前观察的 nodeId；重复选择返回 `flutter_selector_not_unique`，不派发动作。保留真实负向归档。 |
| Flutter 自带 LicensePage 可见但操作树为空 | 操作树直接遍历 live Elements，不依赖省略框架子节点的诊断摘要。去重同一文本/动作区域，保留不同行，要求自身可见区域，深度限制明确报告截断。真机已从依赖列表打开 `_fe_analyzer_shared` 正文。 |
| 不同设备相同 Bridge 端口可能覆盖 Host 转发，缓存仍指向旧目标 | 自动连接复用 serial + devicePort 对应转发，缺失时由 ADB 分配本地端口；使用 `--no-rebind`，每次 HTTP 前检查转发归属。两设备同端口、显式端口冲突、转发被替换时动作未派发均有测试。 |

原始最终复核曾返回 `flutter_action_handler_absent`，主题恢复失败，独立设置读取也报不一致。App 进程和 runtime epoch 没变化，随后同一 App 的只读 Flutter 调用成功。失败瞬间没有保存转发表，**不能断言此次错误已被追溯为端口冲突，更不能宣称 Flutter 处理器生命周期已修复**。本轮修复的是已由源码和测试证实的转发覆盖风险。

修复后当前 OPPO 使用本地 51227 → 手机 18080；其他设备后来占用本地 18080 时，该 Intent 继续成功。另一个新 CLI 进程复用了 51227，见 [`forward-independent-process.json`](../build/ai_app_bridge_artifacts/localsend-evidence-2026-09-08/forward-independent-process.json)。转发表检查与 HTTP 发送不是一个跨进程原子事务，也不能约束不遵守该规则的外部 ADB 客户端。

## 真机结果与证据

最终 Intent `intent-1788839955990-1` 在主题恢复现场开始，随后覆盖许可证、收发/链接页面、系统文件选择取消、主题及语言切换，再恢复夹具并返回接收页。它是一轮交互探索，包含分析与等待；其墙钟时间不能作为 Script 性能结果。

| 检查点 | 结果与证据 |
| --- | --- |
| 框架许可证正文 | [`013-framework-license-detail-settled.json`](../build/ai_app_bridge_artifacts/localsend-evidence-2026-09-08/intent-verified/013-framework-license-detail-settled.json) 与 [`截图`](../build/ai_app_bridge_artifacts/localsend-evidence-2026-09-08/intent-verified/framework-license-screen.png)。 |
| 链接接收页面 | [`026-receive-link-settled.json`](../build/ai_app_bridge_artifacts/localsend-evidence-2026-09-08/intent-verified/026-receive-link-settled.json)，观测实际页面和地址，未发起传输。 |
| 真实 OPPO 文件选择取消 | [`032-file-picker-settled.json`](../build/ai_app_bridge_artifacts/localsend-evidence-2026-09-08/intent-verified/032-file-picker-settled.json) 有 `添加(0)`；取消跨前台观察后，重新读取 [`034-file-picker-cancel-settled.json`](../build/ai_app_bridge_artifacts/localsend-evidence-2026-09-08/intent-verified/034-file-picker-cancel-settled.json) 确认回到空的发送页。没有重放取消动作。 |
| Dark 和 English | [`settings-dark.json`](../build/ai_app_bridge_artifacts/localsend-evidence-2026-09-08/intent-verified/settings-dark.json)、[`settings-dark-english.json`](../build/ai_app_bridge_artifacts/localsend-evidence-2026-09-08/intent-verified/settings-dark-english.json)；从真实 SharedPreferences 仅读取允许的设置字段，独立于 Bridge 返回结果。 |
| 设置恢复 | [`settings-final.json`](../build/ai_app_bridge_artifacts/localsend-evidence-2026-09-08/intent-verified/settings-final.json) 对冻结基线的精确比较 `equal=true`，主题 system、locale 恢复未存储状态。 |
| 最终页面 | [`055-final-receive-settled.json`](../build/ai_app_bridge_artifacts/localsend-evidence-2026-09-08/intent-verified/055-final-receive-settled.json) 与 [`截图`](../build/ai_app_bridge_artifacts/localsend-evidence-2026-09-08/intent-verified/final-receive-screen.png)。 |

最终档案为 [`intent-verified-archive`](../build/ai_app_bridge_artifacts/localsend-evidence-2026-09-08/intent-verified-archive/manifest.json)，235 条 Host 证据记录，包括 52 次观察和 26 个动作回执。Manifest SHA-256：`3f0b6f2a8694f9009fca1f5105bb1826ef36c3fdf80368b64980e58b87e9cc4c`。`completed` 仅表示探索结束，本轮没有 Script 断言结果。

截图在 Intent 之外显式采集，不能当成观察与截图的原子快照，也未计入该档案的截图数量。交接 manifest 单独记录截图对应的 operationId、revision、文件校验和及采证响应。

六份档案（包括缺失导航、重复选择拒绝和主题恢复失败）均复制到独立目录，在新 MCP、不可用 ADB、不可用 Host FactStore 下完成核验。见 [`offline-verification/summary.json`](../build/ai_app_bridge_artifacts/localsend-evidence-2026-09-08/offline-verification/summary.json)。这是档案完整性证明，不把失败流程变为成功。

## 验证与当前限制

- Host 在包目录运行 `npm test -- --test-concurrency=1`：763/763 通过。转发修改后，5 个旧集成测试因空 ADB 替身不提供转发表而失败；补齐 HTTP 测试服务器对应的转发夹具后，全套重跑通过。
- Flutter 插件测试 10/10 通过，包含真实 NavigationBar 和 LicensePage 组件。测试在隔离副本执行，保留工作区原有未跟踪 `pubspec.lock`。
- 最终 App 构建、安装文件哈希和 `git diff --check` 通过。测试日志及当前运行时代码哈希列于 [`handoff-manifest.json`](../build/ai_app_bridge_artifacts/localsend-evidence-2026-09-08/handoff-manifest.json)。
- 最终归档有 52 页手机事件查询，但返回事件数为 0；这些动作尚没有读到与 actionId 关联的手机事件。不能从 UI 成功推出业务事件采集成功。
- 总计划中的无 peer/空发现分支仍需固定可重复前提和断言。此前截图出现空发现占位区域，但文件选择为空不等于 peer 列表为空；交接保留该项，没有从完整验收中删去。
- 未证明 LocalSend 实际文件传输、Rust 网络采集完整性、全 App/整机覆盖、双 OPPO 本轮实跑或 iOS 真机能力。本轮没有改 Flutter 处理器的注册生命周期。

## 下一项交付

使用 [`SCRIPT_HANDOFF.md`](../examples/localsend-sample/SCRIPT_HANDOFF.md) 与冻结证据，在独立上下文编写 Script；固定一份源码完成三次正向、错误预期与受控取消，每次都检查独立结果和夹具恢复。然后补移动事件关联及执行中取消/断连等可靠性关口。用户提供的 iOS 设备用于后续同场景跨平台验证，避免在当前证据复用关口未完成时扩散工作范围。
