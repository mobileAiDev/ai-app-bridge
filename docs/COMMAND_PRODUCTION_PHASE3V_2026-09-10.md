# 第三阶段 V：iOS 首轮真机闭环

本轮推进 iOS 公开能力关口。iPhone 已接入，签名、安装、SDK/WDA 连接、原生点击及输入、WKWebView 操作、四流原引用跨 App 进程读取、WDA/H5 原完成回执跨进程读取均取得真机证据。启动期间采证丢失等缺口仍未关闭，iOS/Web Intent 与 Script 仍未开放，整体尚未达到生产验收条件。

## 固定目标

- iPhone 17 Pro Max / iPhone18,2，UDID `00008150-001005143A32401C`，iOS 27.0 / 24A435；Xcode 27.0 beta / 27A5194q。
- App：`io.github.mobileaidev.aiappbridge.iossample`；WDA Runner：`io.github.mobileaidev.aiappbridge.wda.xctrunner`。App 与 Runner 的 PID/epoch 分别记录，不混用。
- 签名、Developer Mode、UI Automation、开发者信任由真实设备验证。当前个人开发签名描述文件有效期至 2026-09-17，不能视为长期分发方案。
- 证据目录：`build/ai_app_bridge_artifacts/ios-device-2026-09-10/`；最终范围与摘要见 `checkpoint-01.json`。样例业务源码未改动。

## 修复了什么

1. **日志捕获导致 App 崩溃。** 首次点击准备时 XCTest 加载自动化组件，SDK 的 fishhook 写入只读符号指针页，触发 SIGBUS；原崩溃报告 `sample-090802.ips` 的故障线程与栈明确指向 `perform_rebinding_with_section`。参照 [fishhook 原实现](https://github.com/facebook/fishhook/blob/main/fishhook.c)，先取得写入权限，失败时保留原指针。同步修复 Flutter 内携带的 iOS 源码。真实只读内存页、权限拒绝和重复绑定检查通过，随后真机点击及 XCTest 树读取不再触发此崩溃。
2. **输入清空的两个错误。** XCTest 空值可为 nil；显示树中的 placeholder 不等于实际文字。另一方面，原 Command-A/Delete 在此 iPhone 上没有清除已有文字。现在使用 [上游 WDA 采用的 keyboard-clear HID 事件](https://github.com/appium/appium/issues/19389)，直接等待 XCTest daemon 的原 NSError 回调，重新检查目标、焦点和空值后输入。没有增加清空重试或备用点击路线。
3. **准备顺序引用旧状态。** 启动 WDA 会让样例退到后台；现在等 WDA 就绪后启动目标 App，再读取新的 SDK 状态。
4. **本地编译失败污染设备占用。** WDA 准备分为 Host `build-for-testing` 和设备 `test-without-building`。本地失败报告 `ios_wda_build_failed`；本地取消等待自己进程结束，但不标记设备派发。设备执行阶段的未知结果仍保留占用。
5. **明确的系统拒绝与未知结果分离。** 只凭原始 devicectl JSON 的完整参数、命令种类和结构化 Security/Locked 错误，识别已结束的启动拒绝；超时、缺失或不匹配响应继续保留未知。单纯退出码或文本匹配不能释放占用。

## 已核对的结果

| 能力 | 结果及证据 |
| --- | --- |
| 安装与准备 | 签名 App 构建、公开安装、启动、SDK/WDA 连接通过；最终 WDA 两段构建见 `setup-06-phased-1-ios-setup.json`。 |
| 原生点击 | `native-actions-02`：点击后 UIKit/XCTest 树为 Tapped 1，日志记录 count=1，状态 tapCount=1。 |
| 输入、替换、清空 | `native-input-04`：`Bridge真机 0910` → `替换 ✅` → 空字符串；每步有原完成回执、新 UIKit 树及截图，最后物理占用 idle。 |
| WKWebView | `ios-final-proof-01`：输入值及按钮结果同时被新 DOM 和 `h5-final.png` 观察到。单 WKWebView 固定夹具。 |
| 四流持久查询 | `ios-proof-01` 读取旧 log/state，`ios-final-proof-01` 读取旧 network/events；实际 App PID/epoch 已变，原 mobileFactId、原 epoch 与载荷匹配，页为 committed。查询不借用 Host 历史载荷。 |
| WDA 原回执 | `wda-before-restart-01` 与 `wda-coldread-01`：Runner 已重启，旧成功点击和旧失败输入的原 action/epoch、原结果、持久 sequence/SHA 保持一致；失败没有变成成功。 |
| H5 原回执 | `ios-final-proof-01-3-ios-execution.json`：App 重启后，公开接口仍读到旧 H5 action/epoch 的已提交原完成记录。 |
| 本地定向检查 | `log-rebinding-01.tap` 1 项通过；`wda-build-phases-01.tap` 7 项通过；`setup-order-final.tap` 验证 WDA 后前台启动及新 SDK 状态。已通过且未受影响的 Android/WDA 软件矩阵未重跑。 |

这里 network 是样例手动写入的 HTTP 夹具，不证明真实网络请求或服务端业务成功。样例的 tapCount/text 也不是业务持久化；本轮跨进程验证的是 Bridge 原始采证和完成回执。

## 保留的失败与恢复边界

最初开发者信任拒绝、锁屏拒绝，以及一次 WDA 编译失败，被旧流程记成未知占用。它们使用精确的原 Host fact、原输出摘要及 pending ID 做了一次性审阅恢复；编译失败额外核对原 xcresult 的 build failed、test cancelled、testsCount=0 和相同设备。记录是 `reviewed-launch-recovery.json`、`reviewed-locked-recovery.json`、`reviewed-wda-build-recovery.json`。没有删除占用日志或重新派发原任务。

这些审阅恢复不等于公共 `ios-execution reconcile` 已支持通用安装/启动/准备任务的冷恢复。本轮 WDA/H5 原回执冷读与上述旧命令恢复必须分开评价。真机 Host 中断、动作排队取消和执行中取消仍需专门验收；软件阶段已有的测试不能代替这些设备结果。

启动后紧接着调用 SDK recordLog/recordState 会发生挂载前丢弃：`probe-01` 与 `input-diagnosis-01` 保留 `capture_gap` 和缺失的 startup log/state。源路径是异步打开后才 attach，而公开 start 返回时后端尚未挂好。当前拒绝语义是诚实的，但 SDK 启动与写入就绪合同仍需修复，不能通过换游标或只查原引用抹掉这一缺口。

## 接下来

先关闭 SDK 启动采证丢失，要求同一 App 冷启动后原始启动记录真实落盘且失败/关闭边界清楚。再完成已列明的真机取消、Host 丢失与焦点变化边界；多 WKWebView、其余编辑器/键盘与签名生命周期仍按固定范围验收。之后接回未完成的 Web 生命周期/存查工作，再开放 iOS/Web Intent 与 Script。Android 3O 继续冻结，LocalSend 7 条语义断言仍为 inconclusive。
