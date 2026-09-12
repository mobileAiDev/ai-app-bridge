# Kiwix 原生与 H5 业务实机结果

2026-09-11 已恢复 XCTest 授权，并完成 Kiwix 固定离线阅读、书签保存/取消和重启读取的 Intent、连续混合 Script 与独立业务核对。交付对象是 Bridge，未修改 Kiwix 业务。这不是 Kiwix 全 App、完整 iOS 或整机回归验收。

后续已扩展到 Kiwix 内官方 freeCodeCamp 的真实 Vue/CodeMirror 编辑器，完成多行输入、编辑器重建、原生书签和重启后的独立核对，见 [H5 编辑业务结果](IOS_H5_EDITOR_BUSINESS_2026-09-11.md)。题目运行仍受样本布局阻挡，未列为通过。

## 固定目标

- iPhone `00008150-001005143A32401C`，iOS 27.0；独立包 `io.github.mobileaidev.kiwix.sample`。
- Kiwix 源码 `c78d229dac2b836eaeeb7137c0852f54b10b2a7b`，免费 Personal Team 签名。
- ZIM 来源见 [fixture.json](../examples/kiwix-sample/fixture.json)，本轮再次核对 8,978,471 字节和 SHA-256 `3485a2c475a2356331f33f137ce26ed7116e62c7062d73a7773362d6dff005f4`。
- 本轮证据根目录：`build/ai_app_bridge_artifacts/kiwix-ios-core-2026-09-10/automation-20260911-01/`。目录保留原样本日期，本轮请求和运行时间为 09-11。
- 后续书签证据：同级 `bookmark-20260911-01/`，其 `business-audit.json` 关联原始 Script、截图和独立数据库结果。

## 授权与业务结果

重连后的 USB tunnel 为 `fd00:90d0:5abb::1`，启动前 WDA 连接被拒绝。本轮启动原已构建 Runner，04:58 收到 `ready:true`，Runner PID 2277、epoch `A8595E5D-2AE2-4ED6-B03A-28F880B05D48`；随后新建 Kiwix session，原生点击成功。因此当前授权可用，没有把开发者开关或旧截图当成就绪证明。前一日 restart-07 的终止原因是远端连接失效；04–06 的授权超时仍保留原记录。

| 执行 | 结果 | 实际范围 |
| --- | --- | --- |
| `kiwix-native-open-20260911-01` | completed | 从新原生树选择已载入资料，打开 Wikipedia 索引。 |
| `kiwix-h5-reading-20260911-01` | failed，原记录保留 | 第一次 H5 点击被错误的原生视口高度检查拒绝，未派发 DOM 点击。 |
| `kiwix-h5-reading-20260911-02` | cancelled，未派发动作 | 更新 SDK 后 App 回到首页，没有 WebView；结束等待观察的任务，再从新原生树打开资料。 |
| `kiwix-h5-reading-20260911-03` | completed | 索引 → Climate change → Greenhouse gas；H5 点击后标题、正文、离线 URL 和新 document ID 一致。 |
| `script-1789075129011-1` | completed；13 passed，0 failed/inconclusive | 真实滚动、H5 文章跳转、原生后退/前进、3 张截图。 |
| `script-1789075177599-1` | failed，符合预期 | 实际 Greenhouse gas 基线 passed；故意期待 Paris Agreement 的新 DOM 断言 failed。 |

正向 Script 公开 start 到 terminal 为 **17,237 ms**，主体 **16,344 ms**。它以固定 Greenhouse gas 页面和明确 WDA session 为前提，不包含安装、授权、初次资料载入或书签业务，不能外推为全 App 耗时。负向读取为 1,175 ms。

源码：[hybrid-reading.js](../examples/kiwix-sample/scripts/hybrid-reading.js)，SHA-256 `b0852ec32fcdbad1d1594aa5e135b47cde31fe4346e7ec0b4ef97c8fe0d105e3`。本轮复用现有 `examples/freeotp-sample/validation/run-native.js` 公开 MCP 控制器，配置见 `hybrid-script-02-config.json`。最初控制器被仍在运行的探索 Host 以 `fact_store_writer_busy` 拒绝，`dispatched:false`；关闭原 Host 后才执行。`hybrid-script-01/` 原始拒绝保留，没有删除占用或并发操作手机。

阅读正向归档包含 16 次调用、13 项断言、3 张 PNG，共 32 个载荷文件；manifest SHA-256 为 `5a0e5fefbd3377f236cb840fa038dbde3db6eb079155380ea447edf2add40b45`。负向包含 1 次读取、2 项断言、3 个载荷文件。两者公开 export/verify 通过。独立原文件审计见阅读目录的 `business-audit.json`，原生/H5 Intent 归档也已公开核验。截图与附近 DOM/原生树是分次观察，不宣称原子同帧。阅读轮次未查询移动日志/事件，也未核对数据库；后续书签数据库验证见下文。

## 本轮修复

Kiwix 的 WKWebView 高 956 点，原生内容区域从 126 到 870；JS `innerHeight` 为 830。旧逻辑要求扣除原生 inset 后的高度等于 CSS 高度，因而把实际可点击的链接误判成遮挡。

现在用 DOM client 坐标加 DOM scroll 偏移还原文档坐标，按 UIScrollView zoomScale 转换到窗口坐标，再执行 UIKit hitTest。JS 最后一轮同时复核原元素、页面、边界和 scrollX/scrollY；原生滚动/缩放中要求重新观察。非默认 pageZoom 明确拒绝，无效坐标、原生视口外和遮挡分别报错。换算也与 [WebKit 的滚动和内容缩放实现](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/ios/WKWebViewIOS.mm) 核对，未调用私有转换 API。

真实 Script 将同一链接的 DOM top 从 650.5546875 移至 403.5546875，移动 **247 CSS 点**。随后点击记录保留 `scrollY:247`、原生 `contentOffset.y:121`、窗口点 `y:539.5546875` 和实际命中视图，真实打开 Climate change。零滚动和非零滚动均有新页面与截图。Intent 中第一次 scroll 没有移动页面，不能单独作为滚动证明；移动证据来自此 Script。

Swift SDK 与 Flutter 内嵌副本一致，摘要见 `h5-coordinate-source-01.json`。7 项执行实际 renderer 的检查通过，新增原生命中后页面滚动使旧目标失效的反例；设备构建和严格 codesign 校验通过。只复跑了受影响的 H5 检查和具名阅读业务。

## 书签混合业务与独立数据库核对

本轮先停止明确绑定的 Kiwix 进程、确认进程已退出，再用 devicectl 从该 App 容器复制 `Library/Application Support`。原始 SQLite/WAL/SHM 保留并校验 SHA-256；Python 在单独副本上以只读模式查询 `ZBOOKMARK` 和 `ZZIMFILE`，没有使用 SDK 内存状态或修改样本数据库。基线为零条书签。

| 执行 | 实际结果 |
| --- | --- |
| `kiwix-bookmark-20260911-01` | 原生搜索 Climate change、打开文章、添加书签；打开 Greenhouse gas 后从书签面板 Done 退出，没有添加第二篇。随后独立数据库只有 Climate change，主键 1、离线 URL 和资料关系正确。 |
| `kiwix-bookmark-restart-20260911-01` | 进程 2395 停止后新建进程 2415；首页展示已保存书签，点击打开文章，收藏面板显示 Remove Bookmark。 |
| `script-1789077383856-1` | 首次 Script failed，3 passed / 1 failed。删除旧书签、关闭面板和输入搜索成功，但当前文章与搜索结果存在两个同名可见 StaticText，唯一标题断言失败，未误点。原始失败归档保留。 |
| `kiwix-search-result-20260911-01` | 从失败现场的新观察选中真正搜索结果 Button，打开文章并恢复书签基线。其原生树证明结果 Button 包含准确标题子节点。 |
| `script-1789077698232-1` | 修正后连续执行 35 次调用、18 项断言全部 passed；删除旧书签、原生搜索并重新保存、H5 跳转、取消另一篇收藏、真实重启并从书签打开原文章。进程从 2415 变为 2424。 |

正向书签 Script 公开 start 到 terminal 为 **81,856 ms**，主体 **81,207 ms**。前提是固定资料已载入，Climate change 的书签面板已打开且已有该书签，并传入当前 WDA session。安装、授权、资料准备、Intent 探索和外部数据库复制不计入时间。源码为 [bookmark-regression.js](../examples/kiwix-sample/scripts/bookmark-regression.js)，SHA-256 `8fd1406913807258d19c9110d62cbdbcda1fff52df4314a4ed0546600f14a758`。Script 根据当前树中包含准确标题的搜索结果 Button 取得 elementId；不沿用前轮 UID，也不回退为坐标点击。

运行后关闭 Script 的明确 session，再核对并停止进程 2424，复制实际数据库。最终只有 **Climate change 一条书签，主键 3**，其创建时间落在本次 Script 内，URL 为 `zim://53293C1B-CED3-5244-564A-B40E435E2F0A/Climate_change`，ZIM 关系正确；Greenhouse gas 不存在。故意期待两条书签的独立核对返回 `ok:false / exactBookmarks:false`，其他完整性检查仍通过。工具为 [read-bookmarks.py](../examples/kiwix-sample/validation/read-bookmarks.py)；数据位于 WAL，不能用忽略 WAL 的 SQLite immutable 读取代替。

`bookmark-script-02/` 的正向归档含 53 条记录附件、57 个载荷文件（含 4 张实际 PNG），公开 export/verify 通过，manifest SHA-256 `4c9eba9f0eb55bb4b0373b29c26d72a886c8b064bd1e8214b174e382d061ec5e`。四张图已实际查看，分别对应保存、取消、重启后的列表、再次打开文章。三个书签 Intent 均 completed、无待决动作并通过公开归档核验。首个重启 Intent 的请求曾因误传 `policy` 被 `unsupported_argument` 拒绝，改为合同规定的 `timeoutMs` 后启动；拒绝原件保留。

书签轮次同样没有查询移动日志/事件。独立 DB 原件及核对结果在 `oracle-after-intent-01/`、`oracle-after-script-01/`、`oracle-wrong-cancelled-01/`，由本轮 `business-audit.json` 关联校验，属于外部业务证据，不冒充 SDK mobile facts。

## 真实流程暴露的摘要修正

旧 iOS 原生摘要按原树顺序截断 64 KiB，长 WKWebView 文章使底部工具栏和收藏面板的 Done/Add Bookmark 消失。先通过公开 evidence export 读取同一 revision 的原始树完成 Intent，然后固定真实树反例修复摘要。预算不足时优先保留可见按钮/输入框、再保留其他可见节点；返回时恢复原始顺序，保留原 sourceIndex、elementId 与可见性事实，不推断遮挡或可点击性。摘要仍标记 truncated，不能用它证明节点不存在。

针对性检查 12 项通过，含真实 Kiwix 反例、Android 前景窗口、其他 provider 的映射和预算/性能检查。新 Host 上的实际文章和收藏面板摘要分别为 65,342、65,251 字节，均保留所需按钮；见 `summary-live-checks.json`。未更改 Kiwix 业务源码。

## Python 同义业务（2026-09-11）

`examples/kiwix-sample/scripts/bookmark-regression.py` 经公开 Python Script 入口完成同一书签业务：原生删除/搜索/保存、H5 跳转、取消、真实进程重启与书签重新打开。公开 start 到 terminal 为 **79.210 秒**，脚本主体 **78.537 秒**，18 项通过，0 项失败或 inconclusive；进程从 2467 变为 2472。四张本轮截图均已查看，保存面板、取消后的第二篇文章、重启书签列表和重新打开的正文符合预期。

本轮证据目录为 `build/ai_app_bridge_artifacts/kiwix-ios-core-2026-09-10/bookmark-python-20260911-01/`。`business-audit-final.json` 关联 Python 源码、公开执行事件、截图、前后 Core Data 快照及 JavaScript 对照。Python 共 34 次调用、15 个受管动作；先前 JavaScript 为 35 次调用。差异仅为等待已保存书签面板关闭时多一次 `ios-uia-tree` 观察，动作参数、业务断言及其顺序一致；搜索按钮的临时 elementId 分别核对各自前一份树。首次要求原始调用列表完全相等的检查因此失败，保留在 `business-audit.json`，未重跑或删减业务动作来对齐次数。

本轮执行前停下实际进程复制数据库，确认只有 Climate change、记录 ID 3；执行后关闭确切 WDA session，停止进程并确认退出，再复制数据库，得到同一文章的新记录 ID 4。创建时间 `1789080932272.758` ms 落在 Python 脚本期间，ZIM 关系正确，取消的 Greenhouse gas 不存在。原始 SQLite/WAL/SHM 哈希保留，独立错误书签预期仍只因业务内容不符而失败。

`scripts/expect-article.py` 对实际 Climate change 页面故意要求 Greenhouse gas，在 **1.207 秒**内得到明确 failed：一次 H5 读取、一次失败断言、没有动作派发。正向与负向归档均公开 export/verify 通过，manifest SHA-256 分别为 `2bac1d74ead78cc2fe53003e05483daa536931f32c4a00b5e62ddad40304c543` 和 `6e7fbc02534716e129ad5b2efd798b32e4c84dc3caf4f76ba659aa28025e0d90`。这次关闭的是固定 iOS 原生/H5 业务在 JS/Python 两种运行时的同义执行与错误识别缺口；单次计时不构成语言性能比较，未查询的移动日志/事件不计入证据覆盖。

## 同一个 Intent 内的原生与 H5 切换（2026-09-11）

公开 `intent observe` 新增可选 `provider`，沿用同一个冻结 target、operationId 和证据链。选择只有在新 observation 与 summary 均持久化后才提交；动作引用新 revision。读取失败停在 `waiting_for_observation`，不能继续用旧 summary 派发；未指定 provider 的再次观察沿用上次成功选择。iOS 原生切换必须使用 start 时已绑定的 WDA session；安装和权限工作流保持 UIA。合同、原始目标绑定、失败持久化和取消并发检查均通过。

真机 Intent `kiwix-provider-switch-20260911-01` 完成 **native → H5 → native → H5**：从首页原生书签打开 Climate change，通过 H5 链接进入 Greenhouse gas，再使用原生工具栏打开书签面板、确认既有 Climate change 与当前文章的 Add Bookmark，点击 Done 后回到 H5 核对正文。全程 App 进程为 `2478`，WDA session 为 `24AC920E-5BCD-4008-8273-07D2A4123336`；8 个观察 revision、4 个受管动作都留在同一 operationId。H5 页面身份从 Climate change 的 documentId 变为 Greenhouse gas 的 documentId，经过原生面板后仍是后者。

额外提交的旧原生 revision 2 点击，在 H5 revision 3 得到 `reobserve_required` 和 `dispatched:false`；没有生成该决定的 decision、dispatch-marker 或 receipt。四个有效动作逐一核对原始 observation、elementId、WDA session/H5 pageRef 与 actionId。两张本轮截图已经查看，分别显示书签面板和关闭后的实际文章。

证据位于 `build/ai_app_bridge_artifacts/kiwix-ios-core-2026-09-10/provider-switch-20260911-01/`。`business-audit.json` 的 10 项核对通过；公开 export/verify 核验 31 条证据记录，manifest SHA-256 为 `a3ecdbb4ae9fe80ad59cd35d67146663cdb98917530ed801afc439318171eb34`。两张截图作为外部文件保留路径、哈希与公开请求，不计入归档附件；本轮没有新增移动日志/事件查询或数据库持久化验收。会话与本轮 MCP 控制器均已正常关闭。本轮是带 Agent 决策间隔的 Intent 验证，不作为 Script 性能比较。

## 下一步与边界

本轮关闭固定资料的书签保存、取消、重启读取与真实数据库核对缺口；不再重复这些未受影响的流程。下一步推进 Flexify Flutter 复杂业务的实机 Intent → Script → 独立结果核对，同时保留混合路径剩余验收。

同一个 Intent 内的 Native/H5 切换已有上述真机证据；JS/Python 连续 Script 已显式组合两种 provider。H5 输入、原生覆盖层反例、多 WebView、iframe/shadow DOM 和缩放仍待验收。已通过的是 App 收藏面板的 Done 取消，并非 Script 中断/取消或系统权限取消。Flexify Flutter 真机业务、LocalSend 真实收发、原四 App 与最终生产可靠性关口继续保留。
