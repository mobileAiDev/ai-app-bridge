# 第三阶段 I：Flutter Android 执行期限、取消与引擎交接

本轮交付是 Bridge 的执行机制。LocalSend 业务代码没有修改，继续作为真实 Flutter 验证样例。Intent、JavaScript、Python 的同义流程和执行中取消均已通过；整套体系仍未宣称达到生产就绪。

## 实现与实际发现

新增 `aab.flutter-execution/v1`。Android SDK 异步接收动作，HTTP 线程不再等待 Dart 返回；Native 保管动作 ID、Flutter runtime epoch、剩余预算和执行占用。Host 复用原预算，失败后只向原连接、原运行实例发送一次有界取消请求，不重放动作。

Dart 开始一次触摸序列、写入编辑框、发起后续滚动前取得 Native 许可。已取得许可的触摸序列由本地计时与停止信号结束；收到取消时，尚未结束的序列发送 CANCEL。帧等待和 Bridge 自己的延迟可取消，App 的不透明 Future 必须实际结束。单调时钟覆盖 Dart 被业务回调阻塞、计时器尚未运行的情况。

取消信号回执不等于执行结束。尚未取得许可的请求被撤销后，可以确认没有派发；已经取得许可而无法确认结束时，1500 毫秒收尾期后返回 `dispatched:null, ambiguous:true, settled:false`，SDK 继续拒绝新动作。只有原执行的有效完成回执解除占用。SDK 最多保留一个终态供响应丢失后的取消查询，不承诺持久幂等或撤销已发生的业务效果。

真机联调额外发现并修复三个问题：

1. 新包装给 Intent 动作重新生成 ID，使实际动作与 Intent 证据断开。现在 Intent 与直接能力统一从执行上下文传入 ID，增加真实 HTTP 边界测试。首次失败及原 SDK 回执保留在 `device-flow/`。
2. DOWN 后等待跨线程许可，会把短点击拖成长按。失败时“设置”目标取得触摸回执，页面却仍在发送页，手机记录的触摸持续 603 毫秒。现在已获准触摸的 MOVE/UP 使用本地停止与期限检查，结束动作不再等待一次额外传输。新增带长按回调的 Flutter 测试，实际页面后置条件重新通过。失败保留在 `device-flow-second/` 与 `js-failure.png`。
3. Activity 重建时旧引擎晚退出，注销会清空新引擎的回调。现在按回调对象身份注销；旧引擎不能移除新注册者。SDK 真机验证和最终 LocalSend `clearTask` 重建后的公开流程均通过。原 `flutter_action_handler_absent` 保留在 `device-cancel-second/`。

## 固定环境与制品

- 分支 `codex/script-intent-isolated-rebuild`，HEAD `4da58fac5a9f8e522e85f7aa2f23cea195d75f95`。在既有脏工作区上继续实施，本轮未提交或推送。
- 手机 `b46093e6 / PKR110 / API 36`；LocalSend 1.18.2，包 `org.localsend.localsend_app.bridge_sample`，固定上游提交 `af0416be50770a97760f7070684bc667b759a15c`。
- 最终 Android AAR：`a6d5a1f0a745202bf772346b7895c62797a7a3b192f2a3054d429ab7ea914131`。
- 最终 LocalSend APK：`0111928248585d4a1c21def8f70739525003c2ae16b59f70e3ed1c5bdf55fa68`。安装 Intent `intent-1788903926867-1` 独立比对手机安装物，`verified:true`。
- 干净安装的 npm tarball：`2eb9ab9aba1a18aa97eee1e6c910d4641e5d45adb165c74591f613b380c1a678`。94 个公开命令；91 个不含依赖的发布文件与工作区、tarball、干净安装目录逐字节一致。
- Flutter 3.41.9 / Dart 3.11.5。SDK 与插件采用工作区固定源码。原有 Flutter 锁文件保持 SHA-256 `363606252639dc0a29c86b14ed899c6b2da6becc4aae00c486c4eaf12527a091`。

证据根目录：[command-production-phase3i-2026-09-09](../build/ai_app_bridge_artifacts/command-production-phase3i-2026-09-09/)。源码、构建关联、变化清单和证据哈希见该目录的 `acceptance-summary.json`、`source-verification.json`、`localsend-build-source-final.json`、`phase-changes.json` 与 `evidence-files.json`。

## 验证结果与证据边界

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| Host 全套 | 914/914 | `logs/host-all-verified.log` |
| Android 单测 | 149/149，其中新增协调器 9 项 | `logs/android-lifecycle-fix.log`、冻结的 JUnit XML |
| Flutter 全套 | 45/45，其中新增执行期限/取消 14 项；analyze 无问题 | `logs/flutter-all-final.log`、`logs/flutter-analyze-verified.log` |
| Android SDK 真机故障 | 5/5；控制 channel peer，实际 Android 主线程与 HTTP | `logs/flutter-android-device-final.log`、`flutter-execution-tests-final.tar` |
| 干净发行包 | 安装、native 构建及公开合同通过 | `package-release/report.json` |
| Intent / JS / Python 正常同义流程 | 三条入口全部通过，每条 11 次动作、22 条检查 | `device-flow-final/report.json` |
| Intent / JS / Python 执行中取消 | 三条入口全部通过 | `device-cancel-final/report.json` |
| 导出归档离线核验 | 9/9，禁用 ADB 和 Host FactStore 后从搬移副本验证 | `offline/report.json` |

SDK 真机故障包含排队取消、无 Host 取消的排队期限、已经获准但不再响应的执行、无效合同、旧引擎晚注销。最终排队取消在主线程被阻塞时用时 6 毫秒；恢复后编辑框仍为原值。获准但不响应的 peer 在约 1507 毫秒后报告未知并继续拒绝 Native 输入，原完成回执到达后才释放。这个夹具控制的是 channel peer，不能称为真实 Dart 线程测试；Dart 阻塞、触摸与编辑器行为另由 Flutter 测试和 LocalSend 实测支撑。

正常流程仍为接收页 → 发送 → 文本草稿 → Unicode 输入 → 清空 → 取消 → 重开空编辑框 → 取消 → 设置指定纵向容器滚动及恢复 → 接收页。最终 Intent `flutter-targets-1788904160952` 用时 30047 毫秒，JavaScript `script-1788904191332-1` 用时 26437 毫秒，Python `script-1788904217764-2` 用时 27556 毫秒。Intent 的 22 项为外部控制器检查，两种 Script 各有 22 项设备断言；均要求相同动作 ID 的手机事件和独立 UI 后置条件。时间只对应这个短流程，不能代表整 App 回归性能。

取消操作分别为 `flutter-cancel-1788904071963`、`script-1788904082262-1`、`script-1788904091532-2`，从请求取消到终态分别为 321、352、283 毫秒。三次都在点击已结束、文本尚未写入时取消；记录了原动作的 started、pointer.tap、settled 事件，未出现 input.changed，取消后的新 UI 快照和截图确认同一个编辑框为空，SDK 不再占用。**这些三次不是触摸中 CANCEL 的真机证明**；触摸中 CANCEL 在 Flutter 专项测试中验证。取消已发生的点击不构成回滚。

Intent 的 11 条正常 SDK 回执及 1 条取消 SDK 回执已另外核验身份、协议和终态。Script Ledger 保留机械取消回执；详细手机事件、refs 和 SDK 终态 status 以独立观察文件纳入本轮证据包，不把它们伪装成 Script 自己发出的断言。

LocalSend 七个业务 SharedPreferences 字段在安装前、重新安装后和最终恢复后相同，语义哈希为 `8960f67d62cddb4c2a5fb126a7f4bac979ede7f2ad43659b109addcc42568a76`。这项检查覆盖 `FlutterSharedPreferences.xml` 的全部字段，不声称整个文件系统或 WebView 自身配置完全相同。

其余保留失败包括：新增测试夹具没有可命中的滚动内容、测试异步返回类型编译错误、取消验证器误把 Intent 的 `ok:false,status:cancelled` 当作控制失败。相应日志和首次输出保留；未将失败改记为通过。

## 下一关

直接继续跨进程物理设备独占与未知远端占用：统一不同 Host、包名和执行入口对同一 serial 的所有权；Host 不得在远端仍不确定时释放占用后发送 ADB/UIA 输入；恢复后须有明确结束证明。详细远端收尾凭据的持久记录也放在这一关审查。

Native 系统窗口/UIA 执行边界、安装整体期限与故障、更多权限组和 Android 版本、iOS/H5/Web 同义合同、原四 App 范围以及持续运行/压力/性能验收继续保持未完成。当前 Android Flutter 关口不代表其他平台等价。
