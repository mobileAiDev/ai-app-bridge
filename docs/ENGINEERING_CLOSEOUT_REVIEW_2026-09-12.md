# Bridge 工程收尾审查（2026-09-12）

**最新结论：下述 E1–E5 已完成工程收尾，候选版本为 `0.3.0-rc.1`。共享 Runtime 与 Intent/Script 主架构可以停止继续扩展，转入候选发布和既定验收交接；不宣称未完成的全平台业务验收已经通过。完整交接见 [发布交接](RELEASE_HANDOFF_2026-09-12.md)。**

用户最新要求是把验收用于发现 Bridge 的能力和代码缺陷，停止主开发 Agent 不断扩展、重复业务测试；剩余测试可以交给其他 Agent。本文据此调整执行顺序，不删除原验收范围，也不把未执行的任务写成通过。

初次审查依据当时源码、公开包清单及已有真实反例，没有重新执行 App 回归或基础矩阵。初审时分支为 `codex/script-intent-isolated-rebuild`，HEAD 为 `4da58fa`，大量实现尚未提交。以下缺口表保留初审反例；随后修复、代码检查和候选产物验证已完成，不能把初审 HEAD 当作候选源码身份。

## 已经成立的主架构

| 范围 | 当前判断 |
| --- | --- |
| Intent / Script | 已是实际执行入口，存在复杂业务、控制、证据和独立结果核对的实现与既有真机证据；无需为了更多样本重做机制。 |
| CLI / MCP | 都通过 `runtime-client` 进入同一个独立 Runtime，共用操作身份和执行核心；客户端进程退出不是任务结束。 |
| 安装 | 使用原安装 Intent、设备任务与 PackageInstaller 回执，并独立核对 APK；没有恢复成按 ROM 文案自动点按钮。 |
| 手机存查 | Android/iOS 的持久查询走实际分段存储 `readPage`；Host 的 SQLite 是位置索引，最终内容从原存储读取。不能继续把它描述为仅查询内存。 |
| 命令重整 | 生产注册表已去除 batch、sample/smoke 和 fake/P9 原型命令。仍有下面明确指出的旧 Flutter H5 路径，不能外推成所有命令都已完成统一。 |

## 初审发现及完成条件（已处理）

| 编号 | 实质缺口及当前证据 | 收尾完成条件 |
| --- | --- | --- |
| E1 | **Script 完整最终结果没有通用持久读取闭环。** `script-spec.js` 允许 1 MiB result，`bounded-script-registry.js` 的事件环只有 256 KiB；`script-supervisor.js:commitTerminal` 的持久 checkpoint 和 `script-ledger.js:scriptPayload` 未保存完整 result，冷恢复只有状态。真实 LocalSend `script-1789180054162-1` 出现进度 `903 !== 906`；缩短回复才避开问题。 | 使用既有持久证据层保存完整结果、大小和哈希，再提交引用该结果的终态；公开入口能按 operationId 冷读取。事件容量不再决定结果能否取得。持久写入失败不能报 completed。统一容量合同，不能仅调大事件环。 |
| E2 | **旧 Flutter H5 执行家族没有统一页面/元素身份绑定。** `command-registry.js`、`device-provider.js:flutterH5Operation` 仍按 CSS/文字拼 JS 发给当前 adapter；Dart `unregisterH5Adapter` 会选择剩余第一项。导航或 adapter 切换后，旧页面预期不能按新合同拒绝。此项是代码推导，本次没有新做真机复现。 | 保留必要 H5 能力，将 adapter、document、element 身份及执行回执收敛到当前目标合同，移除隐式切换旧路径。不能仅通过删除必要能力来缩小原覆盖范围。 |
| E3 | **自动 Intent 的动作白名单与已实现动作不一致。** `execution-contracts.js:intentActionSchema` 支持 `pressKey` / `setOrientation`，但 `intentBudget.allowlist` 未列出它们，`intent-worker.js` 会拒绝；监督式已有结果不被此项否定。 | 让动作 schema、预算白名单、执行端和公开描述一致；只补相关合同检查，不重新运行全部 App。 |
| E4 | **公开接入包不等于本地已接入样本。** 根 `Package.swift` 缺少 Swift 代码强制导入的 C targets；子目录 SPM 已有而根入口没有。Flutter Android 公开依赖仍固定旧 runtime `0.2.8`。CLI 无 Node 支持版本声明但直接依赖 `node:sqlite`；发布清单还保留无生产引用的旧 FactCache 载荷。 | 修正根 SPM 依赖，统一 Flutter/Android/iOS/CLI 的候选版本和实际分发依赖，明确支持的 Node 环境并清理旧发布载荷。由干净消费端验证公开入口，而非再次证明本地 AAR 能工作。 |
| E5 | **版本与公开说明尚未收束。** 根 README、随包 skill 和公共合同仍含“iOS 未开放”“单次 CLI 不执行安装”“MCP EOF 终止 Intent”等旧描述；大量核心变更和新文件未形成提交。 | 当前注册/执行合同为唯一公开说明；清理失效示例和 skill，归类变更、形成可审阅候选提交，固定源码、包、依赖与已知限制。工程过程文档顶部的补充不能代替修正发行文档。 |

关键实现位置：

- [Script 返回容量](../desktop/ai-app-bridge-cli/bin/script/script-spec.js)、[事件环](../desktop/ai-app-bridge-cli/bin/script/bounded-script-registry.js)、[终态提交](../desktop/ai-app-bridge-cli/bin/script/script-supervisor.js)、[持久恢复](../desktop/ai-app-bridge-cli/bin/script/script-durable-restore.js)。
- [大结果真实失败及既有绕开方式](LOCALSEND_NO_PEER_2026-09-12.md)、`build/ai_app_bridge_artifacts/android-combined-localsend-20260912-07/report.json`。
- [动作/预算合同](../desktop/ai-app-bridge-cli/bin/shared-kernel/execution-contracts.js)、[当前设备 provider](../desktop/ai-app-bridge-cli/bin/device-provider.js)、[Flutter adapter](../flutter/ai_app_bridge_flutter/lib/ai_app_bridge_flutter.dart)。
- [根 SPM 清单](../Package.swift)、[已接齐的子目录 SPM](../ios/ai-app-bridge-ios/Package.swift)、[Flutter Android 发布依赖](../flutter/ai_app_bridge_flutter/android/build.gradle)、[CLI 发布清单](../desktop/ai-app-bridge-cli/package.json)。

已按 E1、并行 E2/E3/E4、最终 E5 的顺序完成收尾。只有当前改动需要的定向检查和干净消费端检查属于主开发收尾。没有新反证，不再新增 App、扩大架构或循环已经通过且未改变的矩阵。

## 交给验收 Agent 的范围

原四 App、iOS 原生/H5/Flutter、跨设备与最终生产验收仍然保留。这些任务的“尚未全部通过”不能继续等同于主架构“尚未实现”；验收只把发现的具体 Bridge 缺陷回传主开发，App 环境问题单独记录。

- Wikipedia 当前完整 P9 **仍未通过**。07 用时 69.131 秒，收藏名称/描述/文章关联已写入，独立核验发现新增文章仍为排队保存 `status=0`，未达到要求的 `STATUS_SAVED=1`，原失败归档保留。最新 Script 将核验移至收藏重开、真实下载就绪之后，未放宽数据库断言；源码哈希 `f5c04d6d3fa469566b6cb21f320bc590f2fe30e1dfd72af7ff1ad4d284ef0f98`，已更新场景清单，**尚未执行**。
- [四 App 组合控制器](../examples/device-regression/run-android-suite.js) 已接入 Wikipedia 的同一八阶段业务核验模块、同 Host 身份复核、原始结果/归档和总耗时判定；当前新组合尚未执行，不能引用旧子集耗时作为完整结果。
- 原有 iOS Kiwix、Flexify、FreeOTP 剩余范围沿现有场景验收。Kiwix 原生文件导入/取消和链接长按预览是已有源码中的候选入口，当前仅静态定位，不宣称已完成系统跨界或同屏多 WebView 验收。
- 已完成的固定矩阵保留原证据；只在当前改动影响其能力或出现新反证时复核。样本自身的问题仅做必要小修，不简单则记录环境/样本阻塞，不消耗主开发周期。

本轮 Android Activity 归属及首次显式 Activity 启动修复已有 12 项定向检查、构建和原 App 安装证明；完整主题业务仍交验收确认。不能由构建或定向检查推导全平台生产通过。

## 当前现场已收束

停止了进一步回归，没有启动第 08 次 Wikipedia Script 或新的四 App 组合。本轮临时收藏已通过原 UI 删除；独立 SQLite 副本确认只剩原默认收藏及原 Moon 记录，App 已 thaw。相关成功/失败 Intent 均保留并离线核验，自己拥有的现场与离线 Runtime 均已停止。

收尾证据：`build/ai_app_bridge_artifacts/wikipedia-save-ready-intent-20260912-01/cleanup-proof.json`。手机继续可供后续验收 Agent 使用。

**工程停止条件已达到：E1–E5 实现与公开接线关闭，干净 npm 包、根 SPM 和 Android 候选产物已核验，受影响检查已处理完成，业务验收沿上面的固定清单交接。远端 Git tag/JitPack/npm/pub 尚未发布或解析；这些发布后检查由维护者执行。最终正式生产验收仍需原范围的实际结论。**
