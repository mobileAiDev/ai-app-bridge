# iOS Flutter：Flexify 训练业务

本轮验证 Bridge 操作真实 Flutter App 的能力。Flexify 业务代码不作改造；仅接入本地 Bridge、Debug 启动和独立签名。训练计划、重量计算、通知、图表和 SQLite 均使用固定上游实现。

## 样本与固定预期

- Flexify 2.1.109 / build 394，源码 `9ae7a8b8f423cbd28fd5f22dc7ae14fded1fc604`，独立 Flutter 3.44.8。
- iPhone `00008150-001005143A32401C`，iOS 27.0，bundle `io.github.mobileaidev.flexify.sample`，免费 Personal Team 签名。
- [固定用例](../examples/flexify-sample/validation/workout-case.json)：Friday 计划，Barbell bench press 两组 42.5 kg × 8、45 kg × 6，编辑第二组为 47.5 kg，打开删除确认再取消，检查训练列表、History 和 Volume 图表。
- 每个新计划的独立预期：**2 组、14 次、625 kg**。用例在运行前冻结，不按实际结果回填。
- 证据根目录：`build/ai_app_bridge_artifacts/flexify-ios-core-2026-09-11/`。以下路径均相对此目录。

## Intent 已接受范围

`flexify-intent-workout-20260911-04` 在真实 App 完成上述业务，计划标题 `AAB Intent 20260911-04`，最终 `completed`、revision 56。输入和点击均从本轮观察选择控件；页面变化后的旧观察被拒绝时，先重新观察。

首次保存触发真实 iOS 通知权限框。Flutter tree 仍包含背景控件，截图显示系统框；另建绑定 SpringBoard 的 WDA session，选择实际观察到的 `Don’t Allow` 并关闭 session，原保存继续完成。**没有重复点击 Save**。此权限动作保留为独立 WDA 证据，不能声称单一 Flutter Intent 自动完成了系统跨界。

界面 JSON 证据在 `flutter-workout-intent-28/`，根目录下的清晰截图包括 `two-sets-28-60.png`、`history-28-63.png`、`volume-graph-28-72.png`。图表显示 Day/Volume，固定计划对应 625 kg。上游图表纵轴数字存在换行/裁切，记录为样本表现，不修改样本来制造验收。

独立验证先核对 bundle、运行时与 App PID，关闭本次 Flutter 调试进程并确认设备 App 已退出，再复制实际 Documents 及可能存在的 SQLite journal。直接向设备 App 发终止信号时，LLDB 曾将其保留为暂停进程；该次复制没有继续，直到 `after-debugger-close.json` 证明它已退出。

`intent-db-snapshot-04/manifest.json` 绑定设备、App、runtime、静止条件及文件哈希。`Documents/flexify.sqlite` 为 61440 bytes，SHA-256：

`4bf4961869df44b8124bb80f8970d154626c13645d2b49f0641b7d11f9c58567`

[独立校验器](../examples/flexify-sample/validation/read-workout.py) 在另一份只读数据库副本上完成 **11 项通过**：SQLite 完整性、schema 56、唯一计划、Friday、关联且启用的练习、精确两组数据、练习和类型、14 次、625 kg、运行时间内没有多余新记录、原始快照哈希不变。结果见 `intent-database-oracle-04/result.json`。运行窗口来自实际操作时间 `1789093901341` 至 `1789095003197`，不从数据库记录反推。

Intent 公开导出与离线核验通过：`intent-workout-04-archive/`，manifest SHA-256：

`ad4e6734778bd8c8d9a733bd414fb164c9b703b081c00a3e5a22e0d49cf7816d`

## 此业务暴露的 Bridge 缺陷与修复

1. **深层 Flutter 诊断树无法进入 iOS Foundation JSON。** 原始诊断载荷约 403 KB，报嵌套过深。诊断树现在独立限制深度 64、条目 4000并明确报告截断；用于动作的 operable tree 不被诊断截断替代。真机新载荷接受，诊断 1777 条、明确 `truncated:true`，可操作树完整。
2. **同一目标因 JSON 对象键序不同被拒绝。** Swift 输出 `targetRef` 的键序可变。Android/iOS Intent 用结构相等检查完整身份，保留 Element、guard、runtime 等变化拒绝。8 个定向用例覆盖键序与身份变化，实际 Plans 点击随后成功。
3. **Flutter 不知道原生键盘挡住了控件。** 可见区域现在使用实际 View 的键盘 insets。完全被覆盖的按钮和输入框不再可操作，DOWN 后被覆盖的目标收到 CANCEL。真机遮挡下的 Bench 点击明确拒绝、`dispatched:false`；显式收起键盘后才继续。
4. **连续输入暴露部分可见容器被误判消失。** 第一轮 Script 输入前后仍是同一 editor，但弹出键盘令大 Scrollable 的中心被遮挡，整个容器被错误排除，引起 guard 改变。可见区域改为控件矩形与实际 viewport 的交集，并对可见部分做 hit-test；不放松目标身份校验。新增重现测试修复前报 `flutter_target_changed`，修复后通过，覆盖、替换、焦点和取消测试继续通过。
5. **Intent 与 Script 的键盘能力缺口。** Flutter Intent 显式支持 `hideKeyboard`；Script 增加 `ios-flutter-hide-keyboard`，归入 `app.interact`，复用原 actionId、设备占用和结束回执。后续仍观察 `viewport.viewInsets.bottom === 0`，命令回执本身不等于键盘动画已结束。

最后一项 Host 改动的 iOS Intent、JS/Python Script 和 runtime binding 共 **35 项通过**。键盘可见区域最后一项 SDK 改动的目标、输入、手势及诊断树测试共 **30 项通过**，见 `keyboard-clip-tests-32-result.json` 和对应日志。真机 Flexify 使用 3.44.8，公共 SDK 测试使用自身依赖绑定的 3.41.9；曾混用引擎导致测试加载失败，改用匹配环境后取得上述结果。

## 连续 Script 进展

最终 `flexify-script-js-20260911-04` **完整通过**：公开 start 到 terminal 为 **116.478 秒（1 分 56.478 秒）**，157 次公开调用、27 个成功且无歧义的动作回执、16 项设备断言通过、5 张截图。362 个事件按页连续取得，173 个完整调用/断言载荷已记录。计时包含脚本内观察、操作、断言和截图，不包含 App 构建/安装/启动、首次 Intent 探索、外部数据库复制与归档，也不表示全 App 耗时。

本轮新计划 `AAB Script 20260911-04` 的独立 SQLite **13 项通过**：2 组、14 次、625 kg，当天同练习合计 2500 kg，没有多余的新记录。见 `script-js-04-run-summary.json`、`script-js-04-db-oracle/result.json` 和 `script-js-04-db-snapshot/manifest.json`。真实数据库 SHA-256：

`e17d3b9f5b3f15660876cb3dba9e038e38774d22b49b2e42b8938a17699a394b`

完整归档 `script-js-04-archive/` 公开导出和离线核验通过，manifest SHA-256：

`90577ce46de2663ebc8823a462e5f8ebb74a0bdc2752392aad90b9589947ac1b`

当前接受的是训练计划、两组录入、编辑、取消删除、History 与图表页面/舍入刻度检查，以及独立持久化总量。图表绘制点的精确语义仍未接受。以下保留前三轮失败及修复来源。

[业务源码](../examples/flexify-sample/validation/workout-flow.js) 来自上述 Intent 观察。它逐次选择本轮节点、等待更新且稳定的观察、明确处理键盘，并通过公开 Script Host 调用和断言保存新证据。状态等待只读轮询，失败动作不自动重放。

首轮 `flexify-script-js-20260911-01` 的 runtime 在 14.997 秒后因上文部分可见容器问题失败：18 次调用、1 项已通过断言，输入失败后未继续保存。保留原始源码、19 个记录文件和失败截图。失败归档 `script-js-01-failure-archive/` 公开导出和离线核验通过，manifest SHA-256：

`d9650f33f4b99323fb34ee59c97987c0141a3e45ce2274a243ec380b4da3e883`

第二轮 `flexify-script-js-20260911-02` 已完成建计划、两组录入、编辑、取消删除及 History，15 项断言通过，最后图表等待失败。原因是脚本把坐标刻度当成精确数据值：上游绘制 `1.2K / 1.3K`，并没有 `1250` 文本节点。公开 start 到 terminal 为 133.522 秒。此运行保留为 **failed**，不是完整 Script 通过。

`script-js-02-db-oracle/result.json` 的独立数据库 13 项检查通过：本轮计划 2 组、14 次、625 kg，2026-09-11 / Asia/Shanghai 的 Bench 数据合计 1250 kg。`script-js-02-negative-db-oracle/result.json` 故意预期 1251 kg，只有该精确总量检查失败，原始快照不变。基线快照 SHA-256 为 `d1a79ca4734b495f72c45eb69510a329e48682033dd78c673b0d6110dce97ccf`。保留第二轮数据，再次创建新计划时预先冻结当天预期 1875 kg；不删除或恢复数据库来隐藏失败。

第三轮 `flexify-script-js-20260911-03` 再次完成相同表单和 History，15 项通过，仍在图表等待失败，公开耗时 126.831 秒。原解析错误地要求至少两个不同刻度；实际多个刻度均舍入为 `1.9K`，观察只保留一个不同值。独立数据库 13 项检查通过，本轮 625 kg、当天合计 1875 kg，见 `script-js-03-db-oracle/result.json`。此次失败属于 Script 作者的断言错误，不能归因于键盘修复或记为通过。

现使用刻度的舍入区间：例如 `1.9K` 表示约 `[1850,1950)` 的范围，不等于精确 1900，也不要求出现两个不同标签。`axis-observation-checks-38.json` 直接读取 Intent 04、Script 02/03 的真实观察，三组正确预期与错误范围检查均通过；另有 4 项可重复的 `workout-axis.test.js` 检查。Script 核对 Day/Volume 页面及舍入范围，外部数据库仍核对精确总量。canvas 图表点和 tooltip 的精确可访问语义仍是观察缺口，舍入范围不能独立区分 1875 和 1876。

第三轮失败归档 `script-js-03-archive/` 已离线核验，manifest SHA-256：

`fe1d358ff974ab830d63bb981a6c843ba4f33abd1b4d82c752be38549ceb7f93`

第二轮归档 `script-js-02-archive/` 已离线核验，manifest SHA-256：

`4fb27284e9aebb60c3d5126f0a343aa59da7ccface2d8252bbf832084eb9a65f`

`flexify-script-negative-20260911-01` 用同一业务源码执行错误结果分支：1 次只读观察、1 项断言明确 failed、没有动作。归档 `script-negative-01-archive/` 已离线核验，manifest SHA-256：

`8da4f5cc1aab9ab4fbe8f84e19c93f861e12f97d996185eb2a72c6b834506b8f`

上方第四轮是单独的新运行，前三轮仍保持失败。`snapshot-workout.py` 已通过实际设备运行，先核对 installed bundle、runtime PID 与本轮 Flutter 调试进程，发送一次 SIGINT，再在复制前后核对 App 已退出；它可收集失败运行的数据库，采集成功不改变该运行的失败状态。

## 表单声明与透明占位内容：2026-09-11 定向补证

真实 Monday 训练表单中，Reps 和 Weight (kg) 起始值均为 `0`。SDK 之前只暴露值，且将上游用透明颜色绘制的 `Set 9` / `8 kg × 50` 骨架文字作为可操作内容。现在从所属标准 Material InputDecorator 取得 `label/hint/errorText`，Cupertino placeholder 单独作为 hint；Host Intent 摘要保留这些信息。标签或提示变化使旧 editor 引用失效，校验错误信息单独变化不改变身份。TextSpan 按实际继承样式排除透明文本，零透明度 Opacity/FadeTransition 下的控件也不再可操作；移除诊断字符串充当可见文字的推测。

SDK 的目标、输入和遮挡测试 **31 项通过**，Host 的摘要、Android/iOS Flutter Intent 身份及公开选择器测试 **31 项通过**。新增反例在修复前失败：透明文本和零透明度控件被暴露、字段声明缺失、单位改变后的旧引用仍能输入。真机使用新签名 build 40，`flutter-launch-41.json` 对应 App PID 2986，runtime `79494980-EE68-4C91-AD15-F41B63E27F30`。

`flexify-form-observation-20260911-01` 完成 revision 9：从真实标签选择 Weight 对应的观察节点，输入 `6.25`，Reps 仍为 `0`，显式收键盘并返回计划列表，未调用 Save。`flutter-observation-41/monday-visible-06.json` 与 `form-settled-10.json` 保留前后字段和透明文字缺席的观察；`form-observation-41-before.png` / `form-observation-41-after.png` 显示灰色骨架仍正常绘制。

据此编写的 [定向 Script](../examples/flexify-sample/validation/form-fields.js) 使用字段声明选择本轮 nodeId，不按输入框顺序或相同值定位。`flexify-form-script-20260911-01` 在 **12.199 秒**内完成 18 次调用、4 个动作、6 项设备断言与 1 张截图：打开原 Monday、只把 Weight 改为 `12.5`、收键盘、退出不保存。49 个事件连续取得，见 `form-script-41-result.json`，截图 `form-script-41.png`。这是新表单能力的短流程计时，不是重新跑完整训练业务，也不包含构建、启动、外部数据库复制和归档。

停止本轮已核对身份的 Flutter 调试进程，在复制前后确认 App 已退出。`form-observation-41-db-oracle/result.json` 的 6 项检查通过，7 条 plans、16 条 plan_exercises、66 条 gym_sets 与预先冻结的成功轮数据库逐行一致。当前数据库与原快照的 SHA-256 完全相同：`e17d3b9f5b3f15660876cb3dba9e038e38774d22b49b2e42b8938a17699a394b`。因此未保存输入没有落入训练业务数据。

两份公开导出均离线核验通过：`form-intent-41-archive/` 的 manifest SHA-256 为 `0bfbcedc77fe0d13b832ba1d435894cdadffff23162112ad4d52044e6c681b4b`；`form-script-41-archive/` 为 `868a3b018fc86716389e22c029f40cf074594be5facbda79ea3b33e403bf00fe`。

设备重连后的 WDA 首次启动在启用自动化模式时超时，保留 `../ios-automation-reconnect-20260911-02/`。用户要求再触发后，`03` 正常进入 testRunner；公开绑定的 WDA session 读取 Flexify **72 个真实 UI 节点**后关闭，见 `flutter-observation-41/wda-ready-14.json` 至 `wda-close-17.json`。这是本轮恢复事实，尚不证明重连始终稳定；Flutter 定向流程与 WDA 原生树读取分别记录。

## 尚未完成的范围

- 系统原生弹窗不会因为 Flutter insets 修复就自动进入 Flutter 可见性判断；需要实际 foreground/overlay 合同与跨 provider 流程。
- 标准输入框的标签/提示和透明骨架问题已按上节关闭。自定义 label/error Widget、Canvas、shader 的可见内容和图表点仍需要 App 语义。原完整训练脚本保留历史位置选择方式，新定向脚本已使用字段声明，不将其短流程结果外推完整脚本的新版本。
- 原始坐标专家路径与目标绑定语义操作的覆盖校验范围不同。
- `updateSnapshot` 的 iOS 原生确认与 Dart 旧固定端口 HTTP 回退仍需一起重整；不能单改失败确认，导致错误载荷被转送到别的 App。
- 本轮只覆盖冻结的训练任务，不覆盖 Flexify 全 App、LocalSend 真实收发、其他 App 或整机回归。H5 输入、多 WebView、其他原生系统跨界和最终生产门禁仍保留。
