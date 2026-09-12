# 第三阶段 S：iOS 动作取消与原完成记录恢复

本批把 iOS SDK 动作接入受管执行。以前 Host 关闭连接后，无法证明 App 动作是否结束；现在 H5/Flutter 只有在原完成记录真实落盘后才释放占用。Host 被杀或响应丢失时，后续写操作继续受阻，新进程只能查询原记录恢复，不能重放动作。

交付对象仍是 Bridge。Android 沿用 3O 固定结果，本批没有运行 Android 样例矩阵，也没有修改样例业务。测试失败只重跑受影响的文件和编译目标，通过后冻结。

## 已完成的合同

- `ios-h5-eval` 与 `ios-flutter-action` 要求 SDK 声明受管协议。Host 冻结 `actionId/runtimeEpoch` 与剩余期限；H5 使用 SDK 进程 epoch，Flutter 使用 Dart 引擎 epoch，两种动作共用 SDK 准入槽。
- 排队动作在真正写入前取许可。排队取消撤销许可，晚到主线程块不能执行；已发许可的动作持续占用，直到原回调结束。取消确认、连接关闭、SDK idle 均不能冒充原完成记录。
- iOS Flutter 插件改为异步 MethodChannel，移除阻塞等待和超时后伪造返回；使用 `executeAction/checkAction/cancelAction`。所有平台拒绝无受管身份的 `runAction`。旧引擎 detach 只清除自己的 handler token。
- 完成记录使用 `aab.ios-completion/v1` 写入真实 C 分段存储的内部 action 分区，同步持久化成功后才报告 settled。写盘失败继续占用；后续取消请求可重试保存同一个完成结果，不再次执行动作。
- 完成查询从磁盘读取，分页游标保存实际 segment/offset 和固定提交上界，并绑定原 App/kind/actionId/epoch。公开采证事件不能充当 action 分区凭据；缺失、淘汰、损坏或身份不符不释放占用。
- 正常保留 JSON 结果及其类型。不能序列化或超出 64 KiB 的实际回调结果落盘为明确终态失败，保留原派发信息；超限结果保留摘要，避免已结束的任务永久占用。H5 eval 不把 JSON 形状的字符串暗转对象，也不把不可序列化值转字符串冒充成功。
- 所有公开 iOS mutation 共用 `ios:<UDID>` 物理设备所有权，CoreDevice ID/UDID 别名与不同 App 不能绕过。原 SDK 动作 pending 身份先持久写入 Host，Host SIGKILL 不清除它。
- 新增公开 `ios-execution status/result/cancel/reconcile`，严格区分各操作参数。reconcile 从保存的 pending 身份取原 App/action/epoch；新连接仍核验原设备和 App，新服务进程不能替换原动作 epoch。当前共 97 个命令入口。

完整公开参数与语义见 [命令合同](../desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md#ios-sdk-execution-and-recovery)。

## 验证与保留失败

原始证据目录：`build/ai_app_bridge_artifacts/command-production-phase3s-2026-09-10/`。测试重跑不累计为新增覆盖。

| 检查 | 结果与范围 |
| --- | --- |
| Host 绑定与采证 | `host-binding-01.log`，31/31。受管接线后的原 SDK 绑定、HTTP 取消和 capture 查询合同通过；使用受控 devicectl 子进程和真实本地 HTTP，未操作手机。 |
| Host 受管执行 | `host-execution-01.log`，4/4。正常 H5/Flutter、排队取消、实际 Host SIGKILL、跨 App/别名阻断、新 Host 原凭据恢复、分页与错误身份拒绝通过。替身完成文件实际写盘；它不替代 Swift 的原生存储验证。 |
| 命令合同和 iOS CLI | `host-contract-01.log` 17/17；`host-ios-cli-01.log` 6/6。共享注册表、MCP discovery、公开 CLI、安装签名错误、截图和设备不可用合同通过。Host 本批共 58 项定向检查，没有运行全套 Host 测试。 |
| Swift SDK | `swift-execution-03.log` 13/13，其中 8 项执行/真实磁盘测试、5 项身份测试；`swift-mirror.log` 1/1。包括排队/执行后取消、写盘失败只重存、错误 Flutter 回执不放行、真实分页及另一个 xctest 进程冷读；8 项中还覆盖无法序列化和超限的结果。 |
| Flutter | `flutter-execution-02.log`，41/41。保留真实 widget 手势、焦点/目标变化、短指针、取消、动作事件归属及后台事件不串 ID 的断言；增加无受管入口拒绝。 |
| iOS App 编译 | `ios-device-build-03.log`，实际 arm64 Debug 构建成功，签名关闭，未安装。 |
| Flutter iOS 框架 | `flutter-ios-typecheck-02.log`，Flutter 3.41.9 真正 iOS 框架、异步插件及完整内嵌 Swift SDK 类型检查通过。 |
| 发布内容 | `package-content/report.json`，真实 npm tarball 的 100 个运行时文件与当前源码逐字节相同，新进程从独立解压目录加载 iOS 执行模块和严格命令合同。没有重复安装验收，没有发布 npm。 |

首轮 Swift 7 项中有 2 项失败：真实分区分页错误地只传了全局 sequence，已改为保存物理游标；冷读子进程测试误把 runner 当 xctest bundle，已修正测试启动路径。第二轮 7/7，通过后为新返回值失败边界补了第 8 项。

首轮 Flutter 40 项中 16 项失败，原因是测试夹具迁移到受管方法后重叠调用 `pump`，以及旧匿名动作测试没有执行身份。修正为先观察后排队，保留匿名请求拒绝、明确身份和普通人手势的事件边界；最终 41/41。首轮 iOS arm64 编译发现嵌套闭包缺少显式 `self`，修正后编译成功；最终还移除了 H5 eval 的隐式返回值转换，重新完成受影响的 iOS 编译和 Flutter 框架类型检查。所有初始失败日志均保留。

## 退出条件和下一关

本批软件关口完成：不确定结果保持占用、原回调持久化后恢复、Host 进程死亡不绕过仲裁，SDK 与公开入口合同一致，真实编译及发布内容可核验。除相关源码变化或出现反证，不重开本批测试。

本批没有新的设备清单，也没有真机操作。3R 的设备记录是当时不可用的配对记录；本批不把它当作当前在线状态。接设备通知仍待用户回复。

下一步处理 WDA/native 的设备/App/session/语义目标绑定及未知结果恢复；安装/启动还要独立证明实际结果。iOS 真机接入后优先验收公开存查、原引用、真实 App 进程重启及 SDK 动作取消。多 WKWebView 的选择与页面身份仍需完成。

iOS Intent/Script 继续显式关闭，待必要平台合同与最小真机闭环通过后再开放。原回调结束不等于任意 App 异步业务全部成功；业务断言、长期运行、Web 及最终多 App/整机套件仍有独立退出条件，整体生产验收没有宣称完成。
