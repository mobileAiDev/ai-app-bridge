# 现有 App 组合回归

当前完整四 App 套件仍未通过。最新一次实测保留了 VLC、Organic Maps 的成功和 LocalSend 的网络前提失败。Wikipedia Script 01–06 均未通过；05 已完成目录、语言与无结果的具名检查，停在新建收藏前未派发的 UIA 拒绝，06 停在切换期间只读树无当前 Activity。SDK 前台所有权修复、两次原 App 更新及 12 项定向测试完成，完整真实主题确认待验；07 已启动，终态待填。这些接续结果不回填旧套件，详见[Wikipedia 报告](ANDROID_WIKIPEDIA_BUSINESS_2026-09-12.md)。当前顺序是 Intent/证据 → 固定 Script → 独立业务核验 → 同一 Host 原四 App 组合；只修直接阻碍路径的产品缺口或很小的样本前提，不新增 App、不重复无变化矩阵。唯一排期见[后续关口](BRIDGE_NEXT_GATES_2026-09-08.md#2026-09-12-样本收敛与当前顺序)。

本轮使用现有 Android Script、同一个公开 CLI 运行时验证跨 App 连续执行、事件连续性、归档目标归属及独立业务结果。现有 iOS 原生、H5 混合、Flutter 保留必测，Joplin 暂停；不以新增 App 或重复无变化的三轮矩阵代替组合进展。

## 最新同运行时执行：20260912-03

权威报告为 `build/ai_app_bridge_artifacts/android-suite-20260912-03/report.json`，设备 OPPO `b46093e6`、locale `zh-Hans-CN`、profile `1gb`。三项共享运行时 `636e74fe-96ad-4ed0-8881-43907d326638`，Host 代码身份 `fc43bbf31a0a59ca964d60b25638a656334802edb22b5da91fd3797ea1aee6ff`。

| App | 本轮耗时 | 结果与证据 |
| --- | ---: | --- |
| VLC | 执行 58.377 秒；含准备/导出 60.794 秒 | 11 项断言通过，146 次调用、6 张截图、18 页手机采证；独立业务核对与归档离线 verified。 |
| Organic Maps | 执行 54.570 秒；含准备/导出 57.421 秒 | 13 项断言通过，151 次调用、7 张截图、35 页手机采证；独立业务核对与归档离线 verified。 |
| LocalSend | 含准备/失败收尾 14.955 秒 | 在 `Initially connected Wi-Fi required` 前提断言停止；此前 19 项断言通过不代表后续流程完成。33 次调用、2 张截图和失败归档保留、离线 verified。没有完整执行耗时字段。 |
| Wikipedia | 未执行 | 当时缺少完成的原 P9 固定业务 Script；本次组合没有证明网络恢复。后来实际网络与 Intent 结果单独记录于[Wikipedia 报告](ANDROID_WIKIPEDIA_BUSINESS_2026-09-12.md)，不回填该轮。 |

本轮 **live wall 133.716 秒**，含运行时停止与离线核验 **134.829 秒**；`executedCasesPassed: false`、`completeAcceptance: incomplete`。它不是完整整机成绩。原运行时停止后，三份归档在独立离线配置下 verified，离线运行时也已停止。

LocalSend 原始 OS 观察同时存在已连接 Wi-Fi 和 VPN。现有 no-peer fixture 要求无 SIM、仅一个已连接网络，其错误文字没有完整表达这一限制。本轮在任何 Wi-Fi 修改之前已拒绝，`network-journal.json` 的 `active` 为 null，`networkCleanup` 为 null。不能据此声称 Wi-Fi 未连接、LocalSend 业务回归或新 Bridge 操作缺陷；本轮未关闭 VPN，也未削弱前提后继续制造通过。已有 v1.3.0 在符合前提的独立轮次通过 132.939 秒、148 项断言，见[空设备与收尾](LOCALSEND_NO_PEER_2026-09-12.md)，不能拼入本轮。

三份归档的 manifest SHA-256：

- VLC：`d6d55ed58167d0a8726e36fb6b73a8aa0bc7d649d5f16757646e448bb0840185`。
- Organic Maps：`8dbe7a607f2d2edc7cc1dc0a50caab5681a5aaca09a6a5a3fd4a147c94ae0e90`。
- LocalSend：`1b2687c19498aa2b2dcc9d8cdfc6da83bad0e6576d5a82fcc196511769e20df6`。

现有 Kiwix 的真实 H5 提交也已完成单项固定 Script，20.999 秒、6 项设备断言、14 项独立判题核对和离线归档通过，见[提交结果](IOS_H5_SUBMISSION_2026-09-12.md)。用户允许后只有课程容器高度小修；原布局失败保留。这关闭该具名提交场景，不是 iOS 组合通过。

## 历史首轮同运行时执行

入口为 [run-android-suite.js](../examples/device-regression/run-android-suite.js)，固定顺序与未执行项见[清单](../examples/device-regression/android-business-suite.v1.json)。实机为获授权 OPPO `b46093e6`，系统 locale 为 `zh-Hans-CN`。

证据目录：`build/ai_app_bridge_artifacts/android-combined-20260912-02/`。三项沿用各自原源码，运行时 ID 均为 `82b5c8a6-bcf0-438f-9796-080355ba72e8`、PID 33722，Host 代码身份为 `05ba942f176a4bab24a4429057f18a1eff1e9b8ae257ed667b239aa0a54484d9`。

| App | 公开 start 到观察终态 | 本轮结果 | 归档核对 |
| --- | ---: | --- | --- |
| VLC | 62.159 秒 | 固定媒体业务通过；11 项断言、实际 MediaSession 与设置核对 | 139 次调用、18 页手机采证；离线 verified |
| Organic Maps | 52.707 秒 | 固定离线业务通过；13 项断言、实际 KML 与设置核对 | 151 次调用、37 页手机采证；离线 verified |
| LocalSend | 7.856 秒 | 在无设备占位分支断言处失败，未执行后续场景 | 30 次调用、20 项通过、1 项失败；离线 verified |
| Wikipedia | 未执行 | 尚无完成的文章／阅读列表固定业务 Script；此前网络失败没有被本轮关闭 | 保留原四 App 的未完成项 |

首轮 live wall 为 **129.476 秒**，含前置校验、启动、三项执行与导出；含运行时停止及离线验证为 **130.555 秒**。这是带一个失败和一个未执行项的实测，不能作为完整整机回归成绩。

每份归档检查调用的 operationId、设备、App 和手机采证 targetKey。LocalSend 的系统文件选择器是显式允许的外部目标。旧运行时停止后，三份归档在不可用 ADB、独立存储配置下均 verified。

## LocalSend 定向修复与复验

首轮暴露两件不同的事：页面保留了先前测试的两个对端；旧 Script 又把现在的 `widgetInspector` 包装对象当成树根。实际结构是 `widgetInspector.root`，且当前诊断数据明确 `truncated: true`，缺少节点不能证明页面业务错误。

通过真实 Intent 点击刷新后，两条缓存记录消失，随后观察到接收页。上游源码也表明发现结果保存在 RAM，刷新按钮先清空结果再扫描。该准备 Intent 在后续代码核对期间超时，不能标成成功终态；两次动作和四次观察原样保留，16 条记录的归档离线核验通过。目录为 `localsend-combined-prep-20260912-01/`。

v1.0.11 把截断诊断树判为 inconclusive。定向运行 `android-combined-localsend-20260912-03/` 为 9.287 秒，明确停在证据不足处；组合控制器也修复了把此类正常返回错误改写成 failed 的问题。

v1.1.0 保留诊断覆盖未完成项，让有自己完整观察依据的文件选择取消、设置与许可证路径继续执行。Flutter 点击改为从新观察选择 nodeId，要求原绑定 Flutter 回执；取消使用 `tap-uia` 的精确 resourceName，删除旧 `feedback` 参数。SDK 和样本 App 业务源码未修改。

`android-combined-localsend-20260912-04/` 继续识别到系统应用锁：真实 UI 为 `com.oplus.safecenter` 的指纹／密码验证，文件选择器断言失败。用户完成验证后，新树确认实际 `com.coloros.filemanager` 的“取消”和禁用“添加(0)”。准备阶段一次过早的 Flutter 点击因前台尚未切回被拒绝，`dispatched:false`；保留该拒绝，重新观察到 LocalSend 后才发出新动作，未盲重放。

随后 `android-combined-localsend-20260912-05/` **完整走完原导航、链接页、文件选择取消、主题／语言修改恢复、关于／许可证及最终接收路径**：

- 执行 completed，`flowCompleted: true`；公开耗时 **121.608 秒**。
- 306 次调用、28 个动作、13 张截图；139 项断言通过，0 项失败，**7 项 inconclusive**。
- 深色、英文、最终恢复三个独立 SharedPreferences 核对点均通过，前后允许字段完全一致。
- 原始归档离线 verified。完整业务与 UI 聚合结论仍为 **inconclusive**。

七项未定断言分别是系统取消不能归到 App 内采证窗口的三项，以及主题恢复／最终接收的四项空 state/logs 引用。无对端前提、诊断树覆盖和真实业务采证合同继续开放；外部最终设置核对已在控制器完成，不能把 Script 自己的 checkpoint 当作该核对。后续应按实际跨包回执、业务状态及查询覆盖设计证据条件，不能伪造不存在的 App 日志来凑断言。

以上 v1.1.0 实测源码 SHA-256 为 `a4d37993b418951a0b73c6b78142912a7d17a653e4ac9fb17cb38a92872eb617`。随后仅纠正了 no-peer 提示语中“占位分支已断言”的不准确描述；原始运行与失败记录不修改。各轮目录的源码及清单分别冻结，不能把后续单项结果拼成首轮组合通过或总耗时。

## iOS 实际接续与剩余范围

本轮设备枚举确认 iPhone 有线在线，WDA `ready: true`。Kiwix 3.6.0 / 174、Flexify 2.1.109 / 394 和 WDA Runner 已安装；FreeOTP 当前不在安装列表，保留轮换验证安排。预检在 `ios-combined-preflight-20260912-01/`。

`ios-existing-apps-20260912-01/` 已实际启动现有 Kiwix、创建新的 WDA 会话并读取原生树。一次有原回执的向下滑动恢复了被阅读滚动隐藏的原生搜索、后退、书签与 More 控件。该操作符合未修改的上游 `WebView.configureBars` 行为。More → Tabs Manager 实际展示新建／关闭子菜单，没有任意标签列表；因此没有为重跑旧书签基线而删除当前标签或书签。

本轮新的 `12-current-h5.json` 与已查看的 `current-menu.png` 确认仍是原 freeCodeCamp 加法课程。DOM viewport 为 440 × 744，Run 的 top 为 913.984375、交互状态为 `outside-viewport`，与前轮问题一致。页面已有的默认测试图标不是新提交结果，本轮未调用 Run。一次关闭菜单的请求因误用 x/y 参数而在入口被拒绝，`dispatched:false`；按当前 tapX/tapY 合同发送的独立请求成功，随后原生树确认菜单关闭。最后明确关闭本轮 WDA session 和 PID 44585 的自有 Host；手机 App 保留。以上只证明当前自动化与观察入口有效，不是新业务 Script 验收，亦未关闭 H5 提交缺口。

## 尚未完成的组合范围

当前先补齐 Wikipedia 原 P9 Intent/固定 Script 及独立业务结果，再在每项前提满足时冻结完整四 App 组合，实测连续执行和端到端总耗时。LocalSend 的 VPN 前提限制显式保留，未满足时不反复执行同一失败条件。其前轮通过的系统取消、no-peer、设置恢复不因历史记录而重新打开。

继续现有 iOS App 的原生/H5/Flutter 剩余场景与组合验证，随后完成整体生产可靠性、命令与发行审计。以上范围不能由 Android 子集、Kiwix 单项或旧独立矩阵代替。已经通过且未改变的 VLC/地图等固定矩阵保持冻结。
