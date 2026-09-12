# 第三阶段 H：Flutter 目标绑定、输入与嵌套滚动

Flutter 语义操作现在绑定真实 Element、编辑器或滚动位置。Intent、公开 Flutter 命令和 JS/Python Script 共用这条执行路径。LocalSend 真机完成输入、清空、取消、重新打开与指定容器滚动，独立偏好读回一致。样例业务代码没有修改。

本轮接受的是 Android/Flutter 目标绑定及固定短流程，整个命令体系仍未生产就绪。Flutter 远端取消、传输超时后的实际收尾、Native 窗口与 Flutter 执行之间的竞争，以及跨进程独占仍是接下来的关口。

## 修复的实际问题

1. **焦点切走后误写另一个输入框。** 旧实现点击后通过全局 TextInput 连接写入。Widget 测试复现 App 的 onTap 回调将焦点切到第二个输入框，旧代码随后覆盖第二框内容。现在冻结原 EditableTextState、controller 和 FocusNode，等待帧后重验，并向该编辑器自己的 TextInputClient 写入；焦点变化明确拒绝。
2. **同坐标的两个滚动容器被合并。** LocalSend 设置页位于横向 PageView 内，内外容器占据相同区域。首次真机选择观察树中的唯一容器，实际选到了已经处于最后一页的外层，返回 `flutter_scroll_boundary`。测试复现后，观察树保留每个真实 Scrollable 的身份，展示 owner nodeId、方向、pixels 和滚动边界；同一 Element 更换 ScrollPosition 也使旧引用失效。
3. **文字点击落到滚动容器中心。** 沿上述路径审查，发现文字所属的 RawGestureDetector 可能只是整个滚动区域。回归测试证明旧代码触发了位于容器中心的另一颗按钮。现在按所选 Element 自身的当前位置发送输入，测试独立记录实际 DOWN 位置并确认另一按钮未触发。非交互文字在 DOWN 后变得不可操作时可以被取消；没有将这种拒绝写成业务点击成功。

三份红灯证据分别为 `logs/phase3h-flutter-repro.log`、`logs/phase3h-nested-scroll-red.log`、`logs/phase3h-text-ancestor-red.log`。保留原始失败，没有用后续通过日志覆盖。

## 公开合同与实现边界

- 公开入口仍是 94 个，完整机器快照见 [3H 命令合同](audits/2026-09-09/command-contract-phase3h.json)。Intent Flutter 增加明确 selector 的 `inputText`、`scrollBy`；公开 `tap-flutter` 接受 selector 或逻辑坐标，`input-flutter-text` 和 `scroll-flutter` 支持 selector。Script 继续通过已有 app.interact 权限使用这些命令。
- `aab.flutter-target/v1` 引用包含 runtimeEpoch、Element 身份和语义 guard。Host 在已观察对象与新树之间核验身份，SDK 派发前再次核验。公开调用不接受自行注入 targetRef/actionId；缺少新 SDK 协议明确失败，不改用旧坐标路径完成语义动作。
- 同一 Element 移动时使用当前坐标；相同文字的替换控件、语义改变、运行实例改变、编辑器 controller/focus 改变和 ScrollPosition 改变使旧引用失效。SDK 的当前对象表随观察重建，身份使用弱引用，不保留历史 Element 强引用表。
- 空 EditableText 也能观察和选择。默认输入只接受当前焦点或唯一可见编辑器，多个未聚焦编辑器明确不唯一；只读、失去焦点、移除和覆盖分别拒绝。保留 App 原本的 formatter/onChanged 行为；App 回调的业务副作用没有事务回滚保证。
- 嵌套 Scrollable 即使同矩形也各自保留。默认滚动要求唯一容器；多个容器应由观察结果明确选择。零位移和边界返回结构化拒绝。无限滚动边界以 null 表示；滚动位置是观察状态，不是跨运行固定 selector。
- SDK 对 runAction 串行占用；目标在 DOWN 后失效时向原触摸流发送 CANCEL。**这不等于已经实现公开远端取消协议。** Host 断开 TCP 不能证明 Dart 动作已经停止，15 秒 MethodChannel 等待及取消握手仍待重整。
- 显式逻辑坐标 tap/swipe 继续作为原语保留。自动文字 provider 发现也保留；本轮没有将整套能力降格为只支持 Intent/Script 的封闭入口。

## 固定环境与安装物

基线 HEAD 为 `4da58fac5a9f8e522e85f7aa2f23cea195d75f95`，分支 `codex/script-intent-isolated-rebuild`。设备为已授权的 `b46093e6 / PKR110`，Android API 36，当前系统 brand 为 OnePlus。工作区保留此前阶段的未提交修改，本轮没有提交、推送或发布。

LocalSend 为 `1.18.2 / af0416be50770a97760f7070684bc667b759a15c`，独立测试包 `org.localsend.localsend_app.bridge_sample`。使用固定 Flutter 3.41.9 / Dart 3.11.5 及已有 Android AAR；未改变 LocalSend 业务逻辑与原接入文件。Flutter 构建使用 `--no-pub`，原有未跟踪锁文件 SHA 保持 `363606252639dc0a29c86b14ed899c6b2da6becc4aae00c486c4eaf12527a091`。

证据根目录：`build/ai_app_bridge_artifacts/command-production-phase3h-2026-09-09/`。汇总为 `acceptance-summary.json`；源码、阶段变化、安装物与原始失败分别有文件及哈希。

| 安装物 | SHA-256 | 接受依据 |
| --- | --- | --- |
| npm tarball | `4538ce64016a7448fd859e62dfc93f93e87f7e8c84551fd800073b4538de4f65` | 干净 npm 安装、原生生命周期、公开合同；后续真机控制器全部使用该安装目录 |
| 最终 LocalSend APK | `43f6af86e6a907b7128f58c74c3bbd614c0bf3deba36c70bd5d311cd6a732935` | `verified-install/002-intent.json`，手机 base.apk 字节独立核验 |
| 沿用 Android AAR | `7f8ec837afacef360f1d161f914b02b652415d4de5981ff4860071ae359018c4` | 已有集成 manifest 与实际输入文件一致；本轮未改 Android SDK |

最终 APK 的三个 Dart 运行文件与 `flutter-runtime-verified-build-source.json` 一致。npm tarball、干净安装目录和当前工作区的 96 个发布文件一致。后续改动只有验证脚本、Flutter 测试及仓库报告，未改变已验收包的运行代码。

## 验证结果

| 验证 | 结果 | 原始证据 |
| --- | --- | --- |
| Host 全量 | 904/904，0 失败/取消/跳过 | `logs/phase3h-host-all-second.log` |
| Flutter 全套 Widget/MethodChannel 测试 | 31/31；其中 19 个目标绑定场景 | `logs/phase3h-flutter-all-verified-second.log` |
| Flutter analyze | 无问题 | `logs/phase3h-flutter-analyze-verified-second.log` |
| 干净发行包 | 94 项命令、96 个发布文件核对通过 | `package/report.json`、`package-source-verification.json` |
| 真机 Intent | 11 个动作，22 项控制器外部检查通过，27386 ms | `device-verified/report.json`、`intent-archive/` |
| JavaScript Script | 22/22 设备断言 passed，21712 ms | `device-verified/javascript-archive/` |
| Python Script | 22/22 设备断言 passed，21301 ms | `device-verified/python-archive/` |
| 独立偏好读取 | 全部 7 个偏好字段一致；allowlist 设置读回亦一致 | `localsend-business-before/`、`localsend-business-reinstalled/`、`localsend-business-after/` |
| 离线归档 | 11/11 integrity verified | `offline/report.json` |

最终操作 ID：Intent `flutter-targets-1788898936820`，JavaScript `script-1788898964519-1`，Python `script-1788898986228-2`。固定流程是 Receive → Send → 文本弹窗 → 中文/表情/换行输入 → 清空 → 取消 → 重新打开并核验新空编辑器 → 取消 → Settings 指定纵向容器滚动 300 → 恢复 300 → Receive。逐个动作核对相同 actionId 和 targetRef 的手机事件，独立观察随后 UI，最终恢复截图已查看。上述约 21 秒只对应这个短流程，不能充当全 App 或整机回归时间。

Intent 的 22 项检查由控制器实施，不能冒称 Script 断言。其原始 SDK 回执与 31 页手机载荷保存在归档中；控制器额外查询、截图和检查结果在外部文件。JS/Python 则分别归档了 22 个正式断言、3 张截图以及 35/30 页手机载荷。各类证据的保存范围明确区分。

完整偏好语义哈希为 `8960f67d62cddb4c2a5fb126a7f4bac979ede7f2ad43659b109addcc42568a76`，三次全量读回一致。本轮没有发送文本、保存草稿或修改设置；没有把偏好一致推导为整个 App 文件系统恢复。

离线验证使用新目录复制品、不可用 ADB 和不可用原 FactStore。11 份包含三次安装、两次早期探索、首轮取消记录、第二轮 Intent/失败 JS，以及最终三条入口。归档完整性不改变失败或取消状态，也不证明未查询历史完整。

## 保留的失败与下一关口

首次 Host 全量为 902/904：两个旧测试仍要求坐标，迁移为检查共享目标引用后通过。早期 Flutter 修复测试还遇到测试关闭 SemanticsHandle 的顺序问题；测试生命周期修正后才进入全量接受。构建前几次失败分别来自 Flutter 参数、Rust PATH 和工具链脚本权限，均保留日志；最终使用固定工具链构建。

真机探索第一次在返回动画尚未完成的观察上请求“设置”，得到 `flutter_selector_not_found`，没有换通道派发。第二次暴露上述嵌套容器缺口。固化流程第一轮还过早要求 SDK 末尾事件已经入库；现在在有限时限内继续观察同一 actionId，并保留签发的窗口边界。第二轮 Intent 通过，但验证脚本错误地从结果顶层读取 Script actionId；修正为公开合同 `execution.actionId` 后，最终三条入口通过。上述过程没有把缺失事件或动作 ok 改判为成功。

下一步先补 **Flutter 远端取消与传输期限**：排队、执行中、Dart 主线程/MethodChannel 阻塞、断连之后是否仍有迟到输入，以及何时可以释放设备占用。随后推进 **跨进程物理设备独占**。Native 系统窗口切换与 Flutter 的竞争、UIA 执行边界、安装整体 deadline/故障、更多权限组/Android 版本、iOS/H5/Web 合同和设备验证、原四 App 固定范围及连续运行/压力/性能仍按总计划验收。
