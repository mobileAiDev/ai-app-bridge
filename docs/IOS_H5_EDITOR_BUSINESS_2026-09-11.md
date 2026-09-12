# Kiwix 内真实 H5 编辑器与书签回归

2026-09-11：真实 iPhone 上，Intent 已完成 freeCodeCamp 多行代码编辑、页签切换后的状态保留和原生书签保存。连续 Script 最终 **89.306 秒、26 项设备断言通过**，包含清空、中文多行输入、编辑器重建、书签保存、App 重启及课程重新打开。独立 Core Data 核对通过。修改对象是 Bridge，Kiwix 和课程业务源码未修改。

通过范围不包含题目运行、学习进度持久化或全 App 回归。课程的 Run 在当前 WKWebView 视口外，实际拒绝与前序 Script 失败全部保留。

后续增加了[真实双标签隔离](#真实双标签隔离)：同一课程的两个 WKWebView 具有相同 URL、节点标识和编辑内容，旧页引用仍明确拒绝；新 Script 80.409 秒、28 项设备断言和 7 项外部数据库核对通过。[同一 Intent 显式选页](#同一-intent-显式选页)随后补齐可变观察目标与失败候选证据。同屏多个 WebView 的实机选择仍未验收。

## 固定样本与业务结果

- iPhone `00008150-001005143A32401C`，iOS 27.0，包 `io.github.mobileaidev.kiwix.sample`。Kiwix 固定源码与免费团队集成见 [样本说明](../examples/kiwix-sample/README.md)。WDA 授权已恢复，本轮读树、键盘控制、书签操作和新会话均有真实响应。
- 官方 `freecodecamp_en_all_2026-08.zim`，7,892,996 字节，SHA-256 `f145e4620bebb3f3e99d438934e39a05cff1ffe15b8f7988134e071dc18bfecb`。来源、ZIM UUID、固定题目和要求见 [fixture-freecodecamp.json](../examples/kiwix-sample/fixture-freecodecamp.json)。这是上游 Vue/CodeMirror 应用；没有注入替代输入框或改写课程状态。
- `kiwix-fcc-intent-20260911-03` completed，14 个 revision；从原生首页选资料，经 H5 打开加法练习，输入多行中文代码，切换页签后读取新建编辑器，再切回原生收起键盘并保存书签。
- Script [h5-editor-bookmark.js](../examples/kiwix-sample/scripts/h5-editor-bookmark.js) 来自这段 Intent 及后续清空现场。最终 `script-1789112778003-1` completed：52 次公开调用、17 份动作回执、26 项断言、3 张截图、215 个连续事件。公开 start 到 terminal 89,306 ms，主体 88,071 ms；准备、签名安装、Intent 探索、外部数据库复制和归档不计入该耗时。

Script 开始时要求当前课程的原生书签面板打开，课程和 Climate change 两个书签已保存，背后的 Code 页签包含非空代码；使用明确的 WDA session。当前搜狗键盘的收起标签由 `keyboardHideLabel` 输入提供，不是 Host 的固定文本分支。读观察可有界等待稳定，失败动作不重试。

业务证明包含两次真正的编辑器销毁与重建：清空后显示课程自己的提示，再重建仍为空；多行 `const sum = 6 + 14;` 和 `console.log('Script 复跑', sum);` 在新 elementId 中完整恢复。上游 Vue 的 solution 双向绑定，以及 CodeMirror 仅在文档长度为零时创建 placeholder 的源码，保存在 `h5-input-20260911-04/placeholder-source-proof.json`。这验证 App 接受编辑状态，不能解释为代码已经运行或重启后仍保存代码。

Script 内真实 Kiwix PID 从 3045 变为 3058。书签重新打开后，H5 URL 保留完整 `#/javascript-algorithms-and-data-structures/basic-javascript/cf1111c1c11feddfaeb3bdef` 路由，题目要求匹配。

## 独立持久化核对

Script 结束后关闭其 WDA session，核实进程属于目标包并停止 PID 3058；复制前后均确认 App 已退出。保留 `Library/Application Support` 原始 SQLite/WAL/SHM，再由 [read-bookmarks.py](../examples/kiwix-sample/validation/read-bookmarks.py) 在单独只读副本查询 Core Data。未使用 SDK 内存状态，也未使用 SQLite immutable 模式。

固定预期在读取结果前写入 [expected-editor-bookmarks.json](../examples/kiwix-sample/validation/expected-editor-bookmarks.json)。数据库恰好有两条书签：原有 Climate change 主键 4，所有已查询字段与本轮基线相同；新课程主键 8，完整 SPA URL 和 ZIM 关系正确，创建时间 `2026-09-11T07:47:23.766526Z` 落在成功 Script 内。完整性、准确内容、无重复、资料关系和原文件未改动五项核对通过；综合审计还核对了原记录不变、新记录创建时间及连续证据。

## Bridge 改动

WKWebView 观察新增 `viewport`、标准文本编辑资格 `editable` 和 DOM `interaction.status`。后者明确区分 ready、outside-viewport、obscured、hidden、disabled。Intent 摘要保留这些字段，空编辑器也不会因为没有文字而消失。滚动回执报告滚动后的交互状态，不再需要 Agent 把“请求已执行”当成“元素已进入视口”。

点击与输入复用同一份 DOM 可操作性判定，原来的页面、元素、几何和 UIKit 命中校验继续有效。输入只接受文本型 input、textarea 和 contenteditable；date、color、checkbox、file 等控件明确拒绝作为文本框处理。聚焦后再次核对编辑资格，避免编辑已变为只读的目标。

实现位于 `ios/ai-app-bridge-ios/Sources/AiAppBridgeIOS/IOSH5Bridge.swift`，与 Flutter 内嵌副本一致；Host 只增加摘要字段透传。16 项受影响检查通过，包括执行 Swift 中实际 renderer 的可编辑/视口/遮挡/聚焦反例、公开 MCP Intent/Script 和摘要检查。arm64 签名构建、严格签名核验、真机安装与 `git diff --check` 通过。未重复无关 Android 或 Flexify 全流程。

## 保留的失败与边界

| 执行 | 真实结果与处置 |
| --- | --- |
| `kiwix-fcc-intent-20260911-01`、`02` | Run 在视口外，点击拒绝，`dispatched:false`；收起键盘和请求滚动后仍无法到达。 |
| `script-1789112077055-1` | 36.800 秒，5 passed / 1 failed。清空后 App 显示 `Code goes here...`，作者错误地要求 DOM 文本等于空字符串。仅修改该样本预期，未把提示词写入 Bridge。 |
| `script-1789112440165-1` | 69.058 秒，20 passed，随后关闭书签时出现 `ios_wda_target_changed`，未派发点击。重新读树仍是同一 Kiwix 进程。后续 Script 增加截图后的原生观察，完整回放通过；该瞬态变化的根因仍未确定，不能据此声明 WDA 永远稳定。 |

官方课程 `.content` 使用固定定位及 `height:calc(100vh - 2.2rem)`。现场 Run 的 top 为 913.984375，而实际 `innerHeight` 为 744；容器自身没有可滚动余量。截图、原 CSS 和只读布局诊断均保留，Bridge 没有越过可操作性检查去调用 Run。重启后题目自行显示默认代码的测试结果，也不作为我们输入代码的执行结果。

样本 CodeMirror 深色主题存在文字对比度问题，截图不能独自证明所有代码字符；完整内容通过新建 DOM 编辑器和 App 状态重建核对。多 WebView、真实 H5 提交结果、其他表单控件及跨 App 组合仍需新的业务验收。这轮固定输入/书签流程通过后停止重跑，下一项优先补实际提交结果与多 WebView，不转去修课程产品布局。

## 真实双标签隔离

`kiwix-tabs-intent-20260911-01` completed，17 个 revision。从课程打开原生 More → Tabs Manager → New Tab，在新标签通过既有书签打开 Climate change，再通过 H5 链接进入 Greenhouse gas；Close This Tab 后恢复原课程。原 WebView `1989B4DC-…` 与新文章 WebView `02B2A405-…` 不同，恢复后原 document ID 也保持不变。隐藏与关闭标签的显式读取均返回 `ios_h5_webview_not_found`，未改选当前页。

本机 iOS 27 的工具栏将 Tabs Manager 放在溢出菜单，实际展示新建/关闭子菜单，未直接展示标签列表。本轮未修改样本工具栏，也未把这条流程写成任意标签选择能力。

[h5-tab-isolation.js](../examples/kiwix-sample/scripts/h5-tab-isolation.js) 结合这段 Intent 与已接受的编辑证据，进一步运行两个完全相同课程的编辑流程：

1. 原标签输入 `const sum = 6 + 14;` 与 `console.log('original tab', sum);`。
2. 新建标签并打开同一课程，输入相同内容。两边 URL、`e9` 节点以及完整 element 引用字段相同，只有真实 WebView/document 身份不同。
3. 用原页 `expectedTarget` 向当前编辑器输入反例文字，得到 `reobserve_required`，`dispatched:false, ambiguous:false`，当前内容不变。
4. 使用当前页绑定输入 `const sum = 9 + 11;` 与 `console.log('second tab', sum);`，新编辑器确实变化。
5. 关闭新标签，原 WebView、document、编辑器及完整原内容恢复；向已关闭 WebView 的输入返回 `ios_h5_webview_not_found`，原页再次保持不变。

连续 Script `script-1789114617382-1` 首次完整运行通过，公开 start 到 terminal **80.409 秒**，主体 79.111 秒；53 次调用、28 项断言、17 份动作回执、210 个连续事件和两张截图。3 次 call_failed 是预先声明的隐藏读取、过期页输入和关闭页输入反例，全部明确未派发；没有失败动作自动重试。截图已查看，仍保留样本 CodeMirror 对比度限制，完整内容使用 DOM 核对。时间不包含基线准备、外部数据库复制与归档。

运行前后分别关闭 WDA session、核实目标包和 PID、停止 App 并复制原始 SQLite/WAL/SHM；本轮 Script 内不重启 App。[read-tab-isolation.py](../examples/kiwix-sample/validation/read-tab-isolation.py) 在运行前写好判定规则，独立读取两份只读副本：原标签主键 1、2 及资料关系保持，Tab 的分配上界由 3 增至 4，而新增主键 4 已不存在；未访问标签的完整状态哈希和原有两条书签均不变。完整性、目标存在、原标签保留、准确创建/关闭、未访问状态、书签及源文件未改动 **7 项通过**。没有把 WebView 缓存中的代码声称为 App 重启后持久化。

这轮只增加复用 Script、独立核验器及证据说明，既有 Bridge 绑定合同通过了新的真机业务反例；未改变 Bridge 执行逻辑或样本业务，也未重跑未受影响的旧套件。源码 SHA-256 `5341dda4b1772b7b69fdb6850cacab579ff2b889129c07a92ae48ebf4ea6d284`，Script 归档 manifest `51c279f62f517e1a6cb9f9be384d7dd2160687e6451d84df13c0d035d25a79c5`，Intent manifest `8650807ebc626c181ab457313b183561a412b461b13f8b1e73690e2a5d4913e0`，两者公开 verify 通过。

这轮结束时发现 `start.target.webViewId` 会冻结选页，`observe` 尚不能更新；该入口缺口由下节修复。真实 H5 提交结果与多个 WKWebView 同屏时的实机选择仍开放。已通过的双标签 Script 不重复运行。

## 同一 Intent 显式选页

2026-09-11 后续修复将设备/App/WDA 绑定与页面选择分开。`intent start` 和 `observe` 接受 `observationTarget:{webViewId:"实际观察到的 ID"}` 或 `null`；`start.target.webViewId` 被明确拒绝，没有兼容映射。Script target 与历史证据的独立合同不变。该轮执行使用常驻 MCP；随后 CLI/MCP 已统一到独立共享运行时，单次 CLI 退出不会终止 Intent，会话由共享运行时持有，见[入口一致性实现](COMMAND_SYSTEM_REDESIGN_2026-09-08.md#cli-与-mcp-共享执行运行时)。

`observe` 省略选页时，同 provider 保留已提交选择，切换 provider 则清除为 `null`。显式 `null` 要求唯一可见 WebView；显式 ID 失效时拒绝改选其他页面。后续选择只有在观察与摘要均持久化后才提交。动作始终携带该次观察中的 page/element 身份。完整参数、失败和 revision 语义见[命令合同](../desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md)。

这次还修复了失败详情丢失：通过 SDK runtime binding 校验的 HTTP 错误响应保留其 `webViews` 候选列表，Intent 将其写成 `observation-failed` checkpoint 后才暴露 `observationFailure.evidenceId`、尝试选择和原始响应。失败不制造可用的新树，也不允许继续对旧摘要派发。后续成功会清除活动失败，历史 checkpoint 仍可导出。

真机 `kiwix-selection-intent-20260911-01` 已完成，终态 revision **21**，其中 **18 次成功观察、3 次失败观察、10 个成功动作**。原生 WDA 在本轮直接返回状态和控件树，没有再请求授权；目标进程 PID 3094，SDK epoch `928A291F-4D04-4709-8027-C187C9347545`。

1. 用上个进程的过期 WebView ID 开始，明确得到 `ios_h5_webview_not_found` 和当前候选页面；同一个 Intent 重新选择候选并打开 Code。
2. 切到 native 创建新标签、打开同一课程；选隐藏的旧 WebView 被拒绝，再依据保留的候选选择新页面。两页 URL 相同，WebView/document ID 不同。
3. 旧 revision 决策返回 `reobserve_required`、`dispatched:false`；新观察下的 Code 点击成功，其自动后置观察保持在新页。
4. 同 provider 下选隐藏旧页失败，原有新页选择仍保留；此时决策返回 `not_waiting_for_decision`，归档没有该决策或派发记录。省略选择重新观察后仍是新页，失败 checkpoint 留在历史中。
5. 通过原生关闭新标签，显式选回原 WebView，原 document 和编辑内容保持；恢复 Instructions。显式 `null` 清除选择并读到唯一可见原页，最后再次显式选定原页并完成。

原页为 `52D6D791-D973-4B7E-B2E0-45097CDA9C8E`，document `B0CAEDF4-D1D9-4F2A-A1AD-AA8F034D1F2C`；新页为 `46ACECDA-BF99-40AA-86D0-06BEA107847A`，document `6A4C8A3B-CE51-4928-94E4-E5DB9A93A85D`。本轮 72 条归档记录通过公开 verify，manifest SHA-256 `e852a09cd715e2ff5522a27a333376eaacf63a8198a6de28c288ea3a8048cef5`。关闭原 Host 后，新 Host 从磁盘恢复相同 completed/revision/显式选择；[本轮归档审计](../build/ai_app_bridge_artifacts/kiwix-ios-core-2026-09-10/observation-target-20260911-01/selection-audit.json)的 16 项核对通过。

软件验证包含 48 项 Intent/生命周期检查、49 项 iOS 绑定/执行检查，以及公开 MCP 的双同名表单 HTTP 夹具。夹具验证真实 Host 对同时可见候选的拒绝、选页输入、旧 revision、失败存证、导出和恢复；它不是同屏双 WebView 的物理设备验收。最终选页 schema、能力发现与不支持的 CLI 入口检查通过。前序并行测试曾遗漏仓库测试命令要求的 ownership sandbox，导致假设备 serial 冲突；使用 `package.json` 声明的隔离入口后 48 项通过，没有放宽生产设备所有权。另同步修正了发现测试中的过期命令数量断言。

本轮只对新选页入口做实机定向验证，未新跑 Script 或复制业务数据库；此前 28 项双标签 Script 与 7 项 Core Data 证据继续作为各自基线。最后截图位于本轮目录，已查看，与 DOM 分别采集，未包含在 Intent 归档附件中。没有新增课程提交或持久化通过声明。下一项回到真实 H5 表单提交及独立业务结果；同屏多 WebView 实机仍保留为缺口。

## 证据位置

共同根目录为 `build/ai_app_bridge_artifacts/kiwix-ios-core-2026-09-10/`：

- `h5-input-20260911-01/`：官方原始资料、源文件、原生/H5 探索与两个视口外失败。
- `h5-input-20260911-02/`：只读布局诊断、修改后构建及独立数据库基线。
- `h5-input-20260911-03/`：成功 Intent、源码摘要、前三份 Intent 的公开 export/verify。
- `h5-input-20260911-04/`：清空现场、上游 placeholder 证明、恢复 Intent 及其公开核验。
- `h5-editor-script-20260911-01/`、`02/`：原始失败 Script、冻结源码、截图及已验证归档。
- `h5-editor-script-20260911-03/`：成功 Script 的 `report.json`、`business-audit.json`、`post-snapshot/`、`post-oracle/result.json`、三张截图与公开归档。
- `h5-tabs-20260911-01/`：多标签 Intent、原始菜单探索、两次旧 WebView 拒绝、运行前数据库、公开归档和 `intent-business-audit.json`。首次 export 使用错误参数被入口拒绝，修正参数后的导出另行保存。
- `h5-tabs-script-20260911-01/`：双标签 Script 的冻结源码、`report.json`、`business-audit.json`、三次预期拒绝、两张截图、`post-snapshot/`、`post-oracle/result.json` 和归档。
- `observation-target-20260911-01/`：显式选页 Intent 的完整请求、失败候选、72 条归档、公开 verify、`selection-audit.json` 与独立最终截图；`observation-target-20260911-02/` 保存新 Host 的磁盘恢复结果。

成功 Script 源码 SHA-256 为 `0bef7b7b07e5d54a1d8b496e85543119e7678a39c5b4cfafc0d75ddc103d1adf`，归档 manifest 为 `be552ccae9a190957bd2cda4be3625add1a4b1d557fd807083dc1cca6e136d2a`，公开 verify 通过。截图与附近 DOM/原生树是分别采集，未宣称原子同帧。
