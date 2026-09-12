# Memos Web Intent 与 Script 业务结果

本轮接通桌面 Web 的 Intent 和 typed Script，使用真实 Memos 的 React 表单、CodeMirror 编辑器、搜索、菜单及删除确认验证公共能力。上游业务代码未修改。已通过的是固定笔记流程，Web 全部能力和整体生产验收仍未完成。

## 固定样本与环境

- Memos 0.30.0，commit `2036c1ffc1b0a1e1fa6a473738c2a5ef520df67f`；源码与官方 darwin arm64 发行物的校验值见 [source.json](../examples/memos-sample/source.json)。
- 官方二进制运行于 `http://127.0.0.1:18881`，独立 SQLite 数据目录；Chrome `152.0.7977.83`，1280×900，隔离浏览器上下文。
- 本地账户、浏览器状态和原始证据不纳入版本控制。当前源码和 SDK 由本地 MCP Host 提供；不能据此断言已安装发行包具有相同能力。
- 复跑说明、脚本和独立数据库校验器见 [Memos sample](../examples/memos-sample/README.md)。

## 业务证据与判定

本地证据根目录为 `build/ai_app_bridge_artifacts/memos-web-core-2026-09-11/`。表内路径均相对此目录，原始失败也保留。

| 执行 | 实际结果 | 证据 |
| --- | --- | --- |
| 创建 Intent `memos-intent-20260911-01` | 创建账户和笔记成功；随后故意选择两个可见 `Save` 的同名文本，收到 `web_element_ambiguous`、`dispatched:false`，所以整个 operation 为 failed。 | `explore-03/database-after-create.json`、`create-intent-archive/` |
| 编辑 Intent `memos-intent-edit-20260911-01` | 基于原观察替换 CodeMirror 内容并保存，同一数据库主键和精确 Markdown 核对通过。该 Intent 只填入搜索词，没有提交 Enter，未计作搜索验收。 | `explore-03/database-after-edit.json`、`edit-intent-archive/` |
| 首次 JS Script `memos-script-js-20260911-01` | 登录成功；首页输入前返回 `web_element_obscured`、`dispatched:false`，未创建新笔记。保留失败并为观察补充交互状态。该瞬间遮挡的具体来源尚未证明。 | `explore-05/script-failure-screen.png`、`failed-script-archive/` |
| JS Script `memos-script-js-20260911-02` | 创建→保存→搜索词＋Enter→编辑→保存→删除确认→取消→确认笔记保留。29 次公开调用，13 项 DOM 断言 passed，0 failed/inconclusive。使用已有登录状态，本次成功流程不包含登录。 | `explore-08/script-wait-01.json`、`script-recording/`、`script-final-screen.png` |
| 独立 SQLite 核对 | 12 项通过：恰好新增一条、旧笔记不变、完整编辑内容、所属用户、PRIVATE、取消删除后 NORMAL、精确标签、本轮创建/更新时间、任务列表及未完成任务属性。 | `explore-08/database-oracle-02/result.json` 与封存的 `memos.sqlite` |
| 错误预期 Script `memos-script-negative-20260911-01` | 不存在的内容预期实际 failed；1 项设备断言 failed，0 mutation。MCP wait 的 `ok:true` 不改变执行失败结果。 | `explore-08/negative-wait.json`、`negative-recording/`、`negative-archive/` |

正向 Script 公开 start 时间为 `1789088905200`，terminal 为 `1789088906526`，相差 **1.326 秒**。这不包含服务启动、浏览器/账户准备、截图、独立 SQLite 复制及归档，不能外推全 App 或整机回归时长。原 Host 的 `rollingSummary.elapsedMs` 在终态后仍随查询增长，报告未使用该错误值；源码已修复为终态冻结，原始记录不覆盖。

数据库校验器从只读连接执行 SQLite backup，再以不可变只读模式查询独立快照；没有用 UI 回调代替落盘结果。首次校验器的 WAL/连接关闭错误保留在 `database-oracle/`，修正后接受 `database-oracle-02/`。运行期间业务写入均通过公开 Bridge UI 命令。

**编辑后的勾选显示仍有差异。** 此阶段最终截图中首个任务框看起来未勾选，数据库对应 Markdown 为 `[x]`。当时 13 项 DOM 断言未检查 checkbox，SDK 也未暴露状态。下方后续阶段已补通用状态并验证重新打开后的真实点击/恢复，但未证明原页面编辑后显示差异的原因；不为通过而修改 Memos 的业务实现。

## 公共能力变化

- Web Intent 使用显式 H5 provider，与 Script/普通 MCP 共用正在服务的 Web provider 和执行租约。
- 观察保存真实 page/navigation/element identity；替换节点、离开再回到相同 URL、焦点回调替换编辑器均不能沿旧引用操作新目标。
- 动作采用 typed selector；同名多控件显式拒绝。支持表单和 contenteditable 替换、明确滚动模式，以及单次 Enter/Escape keydown。Memos 搜索必须实际发送 Enter，仅写入搜索框不足以验收。
- DOM 暴露可见、禁用、可编辑及 `interaction.status`，帮助区分等待页面就绪、滚动到视口和遮挡；执行时仍重新检查。
- Script `completed/failed/cancelled/ambiguous` 的耗时在终态冻结。

合同见 [COMMAND_CONTRACT](../desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md#web-dom-intent-and-script)，脚本授权、目标和证据语义见 [SCRIPT_AUTHORING](../desktop/ai-app-bridge-cli/docs/SCRIPT_AUTHORING.md)。

## 归档与检查范围

以下归档均通过公开 `evidence verify`，包含本轮保留的 recorded payload；本地截图和外部数据库快照仍是另列的工件，未伪装成归档内 Script 截图证据。

| 归档 | Manifest SHA-256 |
| --- | --- |
| `explore-03/create-intent-archive` | `41f2a9c3f3e23c755bba899591c079c80df13956ca2442917fd422391a9b477e` |
| `explore-03/edit-intent-archive` | `0c4741ebb5f501776a70520044f47044ffa265cde7771f6da8a3db5369a86924` |
| `explore-05/failed-script-archive` | `aa4a4295590c886c2ee72aec575199def0bd98b5f2531d6536503705e6bf53dc` |
| `explore-08/script-archive`（66 条） | `ff6825b03ffcb7b416daa331fe7735b6409546368593546dc63bb983772d14e3` |
| `explore-08/negative-archive`（4 条） | `ac97a559acdf3a69b19efe03ce4681335c1e9de94896df5a7dd8d4bee099c0d9` |

相关验证已通过：SDK 14 项；Web Intent/命令/provider 路由组合 36 项；含终态计时和 Script supervisor 的组合 56 项；真实 Chrome 控件合同 9 项（`browser-contract-02/result.json`）。不同 Host 组合包含重复项，不能相加成唯一覆盖数；控件 fixture 与真实 Memos 业务证据分别计量。本轮未声称完整 monorepo 或干净发行包门禁通过。

## 下一项与退出条件

1. 固定 Python 同义业务及 Web 复选控件观察、点击和恢复已在下方验证。保留原页面 Markdown 编辑后勾选显示与数据库不同的独立缺口，不重复未受影响的 JS 流程。
2. Web DOM 目前有 Host tree assertion refs；普通 network/log/state/event 读真实 Host FactStore，但 Script/Intent capture-window、自动 action 关联和原生截图证据入口仍需接通。完成条件是业务动作后能取回本轮关联证据，错误/缺失证据不能形成通过。
3. iOS Flutter Flexify、H5 输入、多 WebView、原四 App 和 LocalSend 真实收发关口继续保留。Web 固定流程不替代这些平台或业务验收；手机连接/签名可用后继续对应主线。


## CLI/MCP 共享运行时定向验收

2026-09-11 在原固定 Memos 0.30.0、本地服务和 Chrome 153.0.8010.37 上验证新入口。未改 `memos-flow.js`，SHA-256 `eeb94e0bbcaaa4a45b9d5fcaf5f27ac79b83d157fd32973a835bae172e736d2a`；仅使用新 marker/tag 避免撞到已有笔记。

- `memos-entry-intent-20260911-02` 由 CLI 启动真实首页观察，再由 MCP 完成。
- `memos-entry-script-20260911-02` 由 CLI 启动，MCP 读取固定创建、搜索 Enter、编辑、取消删除流程的完成结果。运行时起止间隔 1.242 秒，13 项页面断言通过。
- 独立 SQLite 快照的 12 项核对通过，包括完整编辑内容、预期用户、私有状态、取消删除保留、任务属性、本轮时间，以及原两条记录不变。
- CLI 导出 Intent/Script 后停止运行时；在无效 FactStore 配置下执行离线 CLI 验证均通过，没有创建运行时。

[本轮报告](../build/ai_app_bridge_artifacts/shared-runtime-20260911-02/memos-entry-01/report.json)和[页面截图](../build/ai_app_bridge_artifacts/shared-runtime-20260911-02/memos-entry-01/final-browser-screen.png)保留具体范围。该耗时是既有会话上的固定业务，不是启动浏览器、编译安装或整机回归耗时。截图显示已选和未选任务的渲染，但本轮没有执行复选控件点击，不能算该能力验收；Python、采证窗口与其他既定业务缺口继续保留。

## Python 同义业务与复选任务

本阶段继续使用原 Memos 0.30.0 和 Chrome 153.0.8010.37，未改上游业务。证据根目录为 `build/ai_app_bridge_artifacts/memos-python-controls-20260911-01/`，汇总见[报告](../build/ai_app_bridge_artifacts/memos-python-controls-20260911-01/report.json)。

| 流程 | 实际结果 | 证据 |
| --- | --- | --- |
| Python 创建、搜索 Enter、编辑、取消删除 | `memos-python-20260911-02` completed；30 次公开调用、11 个动作、13 项页面断言 passed。运行时 start 到 terminal 为 1.464 秒；不含浏览器准备、截图、oracle 或归档。 | `python-run-02.json`、`python-recording-02/` |
| 独立业务结果 | SQLite 12 项通过，精确编辑全文、标签、用户、可见性和保留状态一致，原 3 条笔记未变，新增 1 条。 | `python-oracle/result.json`、`python-oracle/memos.sqlite` |
| Python 错误预期 | `memos-python-negative-20260911-01` 实际 failed，报 `wrong memo content must fail:failed:None`；前后全部 4 条 memo 投影一致。 | `python-negative-run.json`、`python-negative-database-unchanged.json` |
| Intent 勾选、恢复 | 原 Intent 的唯一未勾选可见控件 `e64` 点击后为 true，独立 SQLite 7 项通过。原任务随后到期，迟到恢复被 `operation_stopped` 拒绝。新 Intent 重新观察原节点并恢复，状态 completed、另 7 项 SQLite 核对通过；不把原 timeout 改写为完成。 | `intent-checked-oracle/`、`browser-checkbox/intent-restore-task.json`、`intent-restored-oracle/` |
| 固定 Python 复选 Script | 从 Intent 证据编写 `task-toggle.py`，原 source hash 执行前后相同；CLI 启动、MCP 回答校验点。7 次调用、2 个动作、5 项页面断言通过，同一 DOM 节点勾选和恢复的 SQLite 各 7 项通过。 | `task-toggle-authorship.json`、`task-toggle-finish.json`、`script-checked-oracle/`、`script-restored-oracle/` |

复选 Script 的运行时耗时为 30.552 秒，其中 30.275 秒在等待控制器核对数据库并恢复执行。这是刻意设置的外部校验点，不能作为无人值守性能成绩。同一 Agent 根据本轮 Intent 证据编写，未声称独立作者或无上下文盲写验收。

原生 checkbox/radio 使用实时属性；Web DOM 新增 `checked: true|false|mixed|null` 与原始 `ariaChecked`，Intent 保留复选角色、状态及无文字控件。Memos 两个可交互 span 与两个视口外的原生 input 分别记录，Script 按实际 readiness 选择，不把它们去重为一个虚构节点。受影响 SDK 16/16、Host 65/65 通过；真实 App 只验证双态自定义 checkbox，混合态和原生控件在本轮属于软件测试范围。缺少 `checked` 的旧 SDK 快照被明确拒绝，不能继续混用旧 SDK。

首轮 Python 使用了错误的样本凭据文件名，进入登录页后失败，原 3 条笔记未变；校正为 `data/bridge-credentials.json` 后使用同一 Script 源码运行。恢复 Intent 的一次请求误带 `options` 被合同拒绝，正确请求另存。原失败、timeout 与拒绝记录均保留。

本阶段 5 份 Intent/Script 归档均由公开 CLI 导出，并在显式停止运行时后离线验证。截图来自独立 browser harness，已人工检查并记入报告的 SHA-256；不冒充 Script-owned screenshot refs。此前共享运行时的 npm tarball 早于本次复选控件修改，本阶段是当前源码验收，没有重新声明安装包覆盖这些新变化。

编辑后的 [Python 截图](../build/ai_app_bridge_artifacts/memos-python-controls-20260911-01/browser-python/python-final-screen.png)仍显示两个任务未勾选，而数据库为 `[x]`、`[ ]`；重新打开后的实时状态、点击、恢复与[最终截图](../build/ai_app_bridge_artifacts/memos-python-controls-20260911-01/browser-checkbox/script-restored-screen.png)一致。显示差异根因仍未建立。下一项围绕这个具体业务接通 capture-window 和动作关联，取回对应保存请求与响应，再判断 UI 与持久化的分歧；不扩展为 Memos 整个 App、其他平台或整机回归已通过。

## 编辑保存的采证窗口与二进制正文

2026-09-11，Bridge 已能围绕真实 Memos 编辑保存，取得本轮请求、响应、同步 Save 事件和独立数据库结果，并让 Script 报告页面与保存结果的差异。交付对象仍是 Bridge；本阶段没有修改 Memos 业务逻辑。

证据入口：[机器报告](../build/ai_app_bridge_artifacts/memos-web-capture-20260911-01/report.json)、[固定 Script](../examples/memos-sample/validation/memos-save-capture.js)、[Script 原始执行](../build/ai_app_bridge_artifacts/memos-web-capture-20260911-01/script-run.json)。固定对象为已有 `BridgeScriptPY20260911` 笔记：通过编辑器将第二项任务改成已完成，保存、核对后恢复原文。没有新增笔记或直接写业务数据库。

最终 Script `memos-save-capture-script-20260911-04` 执行 52 次公开调用、8 个动作，8 项断言通过、1 项失败，终态为 **failed**。运行字段为 6.143 秒；控制器观察到的公开 start 至终态为 6.340 秒。该流程含外部 SQLite 校验点及 5 秒页面等待，不作为无人值守全 App 的速度成绩。执行期间源码哈希保持 `2b7514d82bfa8801f8d624b734fff8f5cbdb6c55d1d2b55590c1b740d40f458b`。

通过的检查包括原笔记定位、保存与恢复两次请求的精确 UID/全文、两次服务端响应的精确 UID/全文、两次 Save 事件的原始动作身份以及恢复后的页面。失败项为“两项已保存任务均显示勾选”：等待 5 秒后仍显示旧状态。数据库在已勾选和恢复两个检查点各通过 7 项只读核对；四条笔记的数量、其他三条笔记、目标身份与可见性均保留，目标全文及任务/标签属性与预期一致。不能因为 HTTP 200 或数据库保存正确而接受错误页面。

实际网络使用二进制 Protobuf。SDK 现在在明确开启正文采证时保留有界原始字节，并标注 `utf8` 或 `base64`；Script 按固定上游 `memo_service.proto` 解码 UpdateMemoRequest 的 memo 字段及返回 Memo。Intent 实际捕获的两次保存中，请求与响应都精确匹配对应业务预期。异步请求保留 `actionId: null, association: "unattributed"`；它们属于观察水位之间的时间窗口，不冒充已建立的因果关系。同步点击事件则保持其真实动作 ID。

这次真实业务推动了三项公共修复：

- Web 采证上界在 SDK barrier 回到 Host 时固定并持久化；队列损失、序列缺失、未完成请求和连接变化继续保留不完整状态。Intent 同一动作的重复观察保留最初下界。Script 和 Intent 使用相同窗口及真实 Host FactStore 引用。
- Script 的生产执行器原先没有把原始动作 ID 传给 Web provider，事件和回执因此拿到另一个 UUID。已补齐公共派发路径；同一份当时冻结的 Script 随后通过两次 Save 事件关联检查。最终轮 8 个动作的 Script ID 与实际执行回执 ID 全部一致。
- 完整归档不再把 Web 引用按手机引用解析。导出及离线校验检查精确文档、流、Host globalSeq、SDK sourceSequence、载荷引用与动作来源，并保留二进制正文及 barrier 诊断。

[8 份归档结果](../build/ai_app_bridge_artifacts/memos-web-capture-20260911-01/archives.json)均已导出并在全部运行时停止后离线验证。最终 Script 包含 52 次调用、9 项断言、8 个采证页及 67 个被引用的 Web item；item 数含不同查询中重复出现的事实，不是唯一请求数。截图仍由独立 browser harness 获取，Script 归档自有截图数为 0。归档结构与关联校验通过不等于业务通过。

失败证据保留：最初把 Intent 摘要中的归一化 button 角色用于原始 DOM role 筛选，被拒绝；随后一次同时传两个身份选择字段被参数合同拒绝；旧文本采证明确报告二进制不支持；第一份 Script 的相对模块导入在临时执行目录中失败；第二份 Script 暴露上述动作 ID 缺口；第三份在恢复后持续观察到缺失 `aria-checked`，`checked` 为 null；最终轮恢复页面正常，但完成状态页面失败。null 没有被改写成 false。显示差异的根因仍未证实，这些不同结果均不删除。

受影响 Host 套件 162/162 通过；后续二进制 SDK 与窗口检查 28/28（22 SDK＋6 Host），派发路径定向检查 36/36，归档检查 25/25 通过。它们分阶段且部分重叠，不相加宣称全量通过。`git diff --check` 通过；没有提交或发布新安装包，也没有操作手机。

当前固定保存业务的窗口、正文、同步动作关联和离线归档已有真实证据。通用异步来源传播、跨页断言聚合及续页窗口绑定、Script 自有 Web 截图、Intent 摘要角色与原始 role 合同的一致性仍开放。停止重复当前 Memos 保存流程；下一阶段回到移动端真实收发或其他复杂业务，只有新反证才重开这里的已通过检查。
