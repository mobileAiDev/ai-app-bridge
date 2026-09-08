# Flutter 动作上下文与手机事实关联

本轮完成 Android Flutter 的一个明确关口：公开 Intent/Script 派发的 Flutter 动作，其真实路由事件可以携带相同 actionId 写入手机 CaptureStore，再按动作查询、导出并离线验证。LocalSend 继续作为 Bridge 样例，业务源码没有增加测试事件、设置回调或特殊通道。

## 原故障与修复

旧 APK 上，Intent 打开主题菜单后，手机确实记录了 `ui.route.changed`、`_DropdownRoute<ThemeMode>`、`push`，但记录没有 actionId。相同动作的过滤查询为空，coverage 完整也不能把空记录判为通过。

- Host 的 Flutter 公开命令现在携带运行时生成的动作 ID；运行时 ID 优先于 raw payload 中的 ID。
- Dart 在处理 `runAction` 时建立独立 async zone。四种 capture payload 在异步传输前冻结该 ID，后续普通异步回调保留原动作上下文，不使用“最近一次动作”全局变量。
- Android Flutter 插件将完整 capture JSON 传到 SDK 的 `recordFlutterCapture`，SDK 通过既有四种 producer 写入。MethodChannel 和现有 HTTP 入口均明确建立该记录的上下文；无 ID 的记录清除无关 native 线程上下文，再恢复调用者原上下文。
- 对字段存在但不是非空字符串的 actionId，Dart/Android 入口拒绝派发或追加。
- Script 原来没有开放 raw `flutter-action`。新增公开 `tap-flutter`，只接受 Flutter 逻辑坐标 `tapX`、`tapY`，使用 `app.interact` 权限和正常动作回执。坐标不乘 devicePixelRatio；raw 接口仍不在 Script catalog。

这证明的是异步执行上下文和实际路由语义。既有 listener、跨 isolate、native 物理输入不会因时间接近而获得 ID。路由事件也不能单独证明设置已保存或文件已传输。iOS 插件尚未保留该字段，本轮没有 iOS 实测。

## 固定环境

- 手机：OPPO PGFM10，`FYZLAU49X8OVQGJ7`；独立包 `org.localsend.localsend_app.bridge_sample`。
- LocalSend v1.18.2 / `af0416be50770a97760f7070684bc667b759a15c`；保留手机原有 CaptureStore 数据升级，没有清空历史 loss。
- APK SHA-256：`7a2b4794bfb2dda4fd373b9f6ba74e311ae6094f3045c9ee2397ddfb9a38f4f6`，已与实际安装包比对。
- 本地 AAR SHA-256：`7f8ec837afacef360f1d161f914b02b652415d4de5981ff4860071ae359018c4`。
- runtime epoch：`1788852912380-b70cb3e7-cdcd-4b8a-83f5-2c70fa73047b`。
- 源码与二进制见 [build-freeze](../build/ai_app_bridge_artifacts/localsend-flutter-action-2026-09-08/build-freeze.json)；新增公开命令后的 Host 源码另见 [final-host-freeze](../build/ai_app_bridge_artifacts/localsend-flutter-action-2026-09-08/final-host-freeze.json)。两个 freeze 对应同一 APK。

本次使用源码 SDK 和本地 AAR 接入，未把发布包升级、干净安装或 Release 构建列为通过。

## 真机 Intent 与 Script

修复后的 Intent `intent-1788852927404-1` 中，打开主题菜单的 actionId 为 `intent-1788852927404-1:theme-value`，手机路由事件 captureId 为 245；关闭菜单动作 `:dismiss` 对应 captureId 269。两页均 complete、committed、gap=false，并带真实 mobileFactId。见 [Intent 原始返回](../build/ai_app_bridge_artifacts/localsend-flutter-action-2026-09-08-intent/004-theme-value.json)。

同一观察期间，保存原查询时间窗口完成分页后读到 1,084 个事件，其中 1,079 个 Flutter 后台 frame/stable 事件没有 actionId；不存在的 actionId 查询为 complete 空页。没有把这些后台事件绑定到最近的动作。见 [后台归属检查](../build/ai_app_bridge_artifacts/localsend-flutter-action-2026-09-08-intent/background-review.json)。

[专项 Script](../examples/localsend-sample/validation/localsend-action-scope.v1.js) 由本轮主上下文编写，SHA-256 为 `d3cf883186dcc636a19c412bdfd68b35bf8c1374cd497dd81d072cc2f27b1e03`，单独放在 validation 目录，不冒充原来的独立作者冻结脚本。每个正向执行：Receive → Settings → 打开主题菜单 → Dark → 再次打开 → System → Receive。每次菜单开合核对真实路由事实，每次设置变化由控制器独立读取真实 SharedPreferences。

| 固定源码轮次 | 耗时 | 动作数 | 路由事实 | 结果 |
| --- | ---: | ---: | ---: | --- |
| positive-1 | 11.582 秒 | 6 | 4 | 18 项断言通过 |
| positive-2 | 10.598 秒 | 6 | 4 | 18 项断言通过 |
| positive-3 | 10.997 秒 | 6 | 4 | 18 项断言通过 |
| wrong-expectation | 0.418 秒 | 0 | 0 | 错误设备名断言 failed，按预期阻止动作 |
| cancel | 0.454 秒 | 0 | 0 | 等待控制器时取消，取消后无新调用 |

这些耗时只对应上述专项流程。每轮前后设置一致，6 次中间偏好读取均与预期吻合。最终回到中文 Receive。见 [专项矩阵](../build/ai_app_bridge_artifacts/localsend-action-scope-2026-09-08-matrix-2/report.json)。

5 份专项归档、修复前后 2 份 Intent 归档均在源 MCP 退出后复制，用新 MCP、不可用 ADB 和不可打开的 Host store 离线验证。专项归档包含本轮查询到的手机页、Flutter 树、动作和断言；控制器偏好文件和截图独立放在 [外部证据包](../build/ai_app_bridge_artifacts/localsend-action-scope-2026-09-08-matrix-2/external-evidence/manifest.json)。该包 55 个文件，并核对偏好读取位于对应问题与答复之间、期间没有新动作，关联到实际路由查询；没有改写手机事实或公共归档。其 manifest SHA-256 为 `977993fa2dec466e81d0a559ab452728d840cd51e58c7ef97b0fc527cbdea586`。

## 原独立脚本回归与剩余范围

原 v1.0.5 源码保持 SHA-256 `e193188913c89c76cd30769e09c70887cec74c2df5bed60475cf8937a29aa985`，重新跑完完整 acceptance 场景：1 分 36.084 秒，28 个动作、324 次调用，141 项 UI 断言通过、0 项失败，手机采证读取没有错误。3 个独立偏好检查及设置几何恢复均通过，归档离线核验通过。见 [原脚本回归](../build/ai_app_bridge_artifacts/localsend-flutter-action-2026-09-08-frozen-regression/report.json)。

其手机断言仍为 2 passed、7 inconclusive：跨包 picker 取消缺少 App 内采证边界，设置恢复和最终 Receive 没有对应 state/log 事实。原脚本的大多数坐标动作仍走 native physical tap；本轮未改动其动作来源。不能把专项路由通过改写成原脚本全部手机断言通过，更不能称全 App/整机回归验收完成。

下一关沿总计划推进：用公开 typed Flutter 操作固化可复用场景的证据合同，并进入 iOS 最小同义闭环的设备、签名及原生入口验证。受控 peer/网络、真实传输、执行中设备动作取消、断连/淘汰/重启和其余 App 矩阵继续保留。

## 验证与保留记录

- Android 121/121；Flutter 12/12。Widget 测试经过真实 `runAction` 和指针分发，覆盖 A 的延迟回调与 B 交错、四种 record API、普通点击、后台 timer、无 ID 和失败入口，并比对 MethodChannel/HTTP 传输载荷。
- Flutter 测试使用的解析锁文件另存于证据目录；预先存在的未跟踪 `pubspec.lock` 已按本轮开始时的 Git checkpoint blob `465ddc1692212151de90707ace54d232f3b16de6` 逐字节恢复，未用推测版本覆盖。
- 最终 Host 串行检查 765/765。新增公开命令的能力发现、权限、坏坐标不派发及 HTTP 动作 ID 传参均有回归；G0 历史 fixture 保留，新增命令单独断言。
- 初次在仓库根目录跑 Host 测试造成两项 artifact cwd 预期失败；新 ingress/命令造成的旧源码形状断言已按真实合同更新。并发运行期间两项性能阈值检查失败，记录保留；无负载串行复验通过，没有放宽阈值，也没有将其称为长时压力证明。
- 专项 pilot 曾因只匹配 `Text` 而漏掉真实 `NavigationDestination`，0 动作退出；下一次被 Script catalog 拒绝 raw `flutter-action`，同样没有派发设备动作。两份失败归档保留，随后增加明确的 typed 命令。
- 后台宽窗口分页首次漏传原始 `sinceMs`，改变查询窗口并得到历史 gap。保留失败页面，携带原窗口完成 6 页检查；未修改 SDK 的 loss 判断。

最终文件/源码/二进制核对见 [final-review.json](../build/ai_app_bridge_artifacts/localsend-flutter-action-2026-09-08/final-review.json)。

复验命令：

```sh
node examples/localsend-sample/validation/run-action-scope.js NEW_OUTPUT_DIR FROZEN_APK_SHA256
node examples/localsend-sample/validation/review-action-scope.js NEW_OUTPUT_DIR
```

控制器固定 PGFM10 独立样例包，要求初始中文 Receive、theme/color=system 且 locale 不存在。不会自动补造初始状态或重试变更。
