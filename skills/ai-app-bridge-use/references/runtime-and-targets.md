# Runtime、目标与故障恢复

以下细节按需读取；设备/App 操作的默认入口与例外以 [SKILL.md](../SKILL.md) 为准。文中的 `docs/` 路径相对已安装 CLI 发布包根目录，定位方法见 SKILL.md 的“按需参考”。

## 共享调用合同

MCP 入口是 `capabilities` 和 `run`；`capabilities` 是独立工具，不是 `run` 的命令。命令参数全部放在 `run.arguments`，包括目标和 operation，使用当前命令名与 JSON 类型。默认 capabilities 或 domain 查询只取目录；domain 取值为 execution、evidence、core、app、action、flutter、webview、ios、web、diagnostics、advanced；android 是平台不是 domain，平台筛选只用于 Intent decide 的 `platform`。用 `command` 查合同，Intent/Script/evidence 加 `operation` 只取当前操作。Intent decide 可再加实际 `platform`、`provider`、`action`，例如 `{"command":"intent","operation":"decide","platform":"android","provider":"native","action":"tap"}`。CLI `--help COMMAND` 接受相同筛选；发现正文上限 96 KiB，宽查询超限时按提示用 command/operation 收窄，不反复读取整个 schema。

省略 `extract` 时使用 auto：预算内完整返回，重复结构可用无损表格（`partial:false`）减少字节；超预算也先尝试无损表示，仍放不下才给含完整记录或文本片段的部分视图（`partial:true`）。不要看到 `read` 就机械补读：首个回复已经包含需要的信息时直接继续。已知需要什么时用 select、regex 或 JS/Python；显式 `null` 保持原始形状。业务参数在 `arguments`；`extract/output` 属于顶层，不传入设备命令。

CLI 与 MCP 共用独立执行 Runtime、命令合同和 operationId。CLI 响应是一行紧凑 JSON，业务值在 `value`；MCP 工具正文同样是紧凑 JSON。Script 的调用返回值另见下文。客户端退出不会取消任务，用原 operationId 显式 cancel。取消不撤销已派发效果。协议不兼容才阻断共享 Runtime 调用；版本、代码或环境指纹差异按实际回复作为诊断处理，同版本 hash 不能判断新旧。决定加载当前客户端构建时，按返回提示显式 stop/start，并考虑 stop 会结束现有 Runtime 任务。

旧 MCP 实例可能与已安装 CLI 不同。缺少 Intent/Script 或参数不匹配时，核对实际入口版本，选用支持当前合同的入口；不要套用旧 batch、工具别名或外层参数。

**连接诊断：** 按需用 `doctor {serial:"设备",packageName:"可选应用"}`，或 `platform:"host"|"ios"|"web"`；CLI 例如 `ai-app-bridge doctor --serial 设备`。它分别报告各条路径与恢复调用；`ok:true` 表示诊断报告生成，问题在 checks/issueCount 中。某一路不可用不否定其他路径，正常点击不需要先跑 doctor。

**卡死 / 换 agent：** 先读 `device-ownership {operation:"status",serial:"原设备"}`。旧 Host 已消失的未知记录会归档，新明确动作可继续；archives/archive 可读原记录，reconcile-archive 只查询原动作，不取消或重放。活跃 owner 需要继续、取消，或由 agent 明确接管。决定强制接管时可用 `ai-app-bridge device-ownership --operation force-stop --serial 原设备`：无需旧回执，结束旧 Host/共享 Runtime 的相关任务并重置设备执行器；同 Host 的其他任务可能一起结束，已派发效果记为未知。读取 ownershipReleased/remoteResetPending，再观察当前状态。仅 UIA 卡住时优先考虑其 uia-runtime start/force-reset，按返回影响范围选择。

**工作期间防休眠：** 默认实际操作开启十分钟空闲保护，Intent/Script 另按自身期限保护并在终态释放；MCP 连接不能判断对话是否仍在工作。跨多个程序、子代理或长时间分析的设备任务，由主代理为 Host 和每个选中设备显式 `power acquire`，期限覆盖本轮工作，保留 `leaseId` 并在到期前续期，整项工作结束再统一释放。子任务只释放自己新增的保护。用 `power status` 核对实际保护；`power auto enabled:false` 关闭自动保护而保留显式租约。Mac/Windows 使用系统 API，Android 使用指定 serial 的独立锁；iOS 只覆盖前台 SDK App，可选 `recovery:"reacquire-ended"` 在原工作期限内恢复 SDK 明确丢失的断言。已锁屏状态和实际保持解锁分别核对；充电保活设置也要结合系统实际供电状态。保护失败作为信息返回，调用方仍可继续业务操作。更多见 `docs/POWER_LEASES.md`。

Windows x64 的原生 FactStore、常规 npm 安装、共享 Runtime、CLI/MCP、JS/Python Script 与取消/恢复已通过 Windows Server 2022 CI；电源 API 和租约生命周期也已实测，物理 Windows 电脑的屏幕/系统休眠效果仍待验证。安装范围见 `docs/INSTALLATION.md`。
## 目标与动作

高频速记：`adb-exec` 必填 `argv` 数组；`tap` 必填 `serial/tapX/tapY`，ADB 点击显式 `scope:"device"`；`tap-uia` 必填 `serial/packageName` 和 `selector/targetRef` 二选一。独立截图用 `screenshot`，设备日志用 `logcat`，以 `serial` 指定设备。

**iOS 系统权限弹窗：** 用实际观察到的系统 App 和已就绪 WDA 会话操作弹窗，再观察原 App 恢复前台。`ios-setup {startWda:true,...}` 已等待执行器就绪，先消费原启动结果再查询会话；处理已知弹窗和后续页面时用同一 Script 连续执行。SDK 不在前台不等于系统按钮不可操作。树按引用交付时，从原 `response` 读取需要的控件，或在 Script 内直接消费 `ctx.call` 的完整结果。未知动作先按原身份查询，连接修复后由 agent 决定下一动作。密码解锁是系统需要人工介入的情形，普通权限按钮由 agent 按用户意图选择。详见 `docs/SCRIPT_AUTHORING.md` 的 iOS 目标说明。

- Android：明确 `serial`，App 命令再提供 `packageName`；设备级 Script 可只设 serial。iOS：`deviceId`/`bundleId`；Native Intent 还需原 WDA Runner/session 绑定。Web：从当前连接取得 `sessionId`/`runtimeEpoch`/`targetId`。
- Intent/Script 的目标带 `platform`。执行目标保持明确指定的 App/provider；Android 前台匹配、不匹配、未知是独立观测事实，不代表动作成功或失败。更多绑定按平台合同补齐。
- selector、nodeRef、pageRef 和坐标来自当前观察。多重匹配先看 candidates 和 guidance.nextActions，按实际意图选 nodeRef/targetRef；过期引用或 `reobserve_required` 再观察。Android 前台 warning 由 agent 决定继续、观察或调整目标；无需 force。Intent 切 provider 通过 `observe`，切 Android App 显式传 `observationTarget.packageName`。
- UIA 键盘/系统节点太多时，用 `uia-tree {packageFilter:"实际包名"}` 在节点预算前筛出目标 App；省略筛选可观察系统权限弹窗。Flutter 表单可按 `{label:"账号",role:"input"}` 等组合条件定位。只需准备字段值时，输入命令或 Intent inputText 可设 `focus:false`，保留输入格式器和 onChanged，不点按、抢焦点或打开键盘；测试键盘、点按或焦点行为时保留默认输入，`hideKeyboard:true` 可在同次输入后请求收起键盘。
- Android Native/UIA selector 可组合 text、className、resourceName、contentDescription 和 clickable 等条件，text 默认精确；包含匹配显式用 textContains/contentDescriptionContains。within 可直接限定容器，或用 `{text:"行标签",ancestor:{resourceName:"行容器"}}` 找邻近按钮；容器可多匹配，最终目标须唯一。候选序号只用于在已返回列表里取实际 viewId/完整 targetRef，不把第 N 个当跨观察稳定身份。Native 在 SDK 原子校验，省去 Host 重读；同 View 属性变动给 warning，显式 selector 条件仍要满足。UIA 组合查询先筛观察再绑定 nodeRef，属性变化给 warning。
- H5/Web selector 可组合 text、ariaLabel、tag（Web 还有 role/css），所有字段共同匹配；已有 elementId 可用于部分观察。原 DOM 节点属性变动是 warning，替换节点或切换文档才需要重新绑定。
- H5/Web 可直接传 `expectedTarget:{pageRef,element:observedControl}`，保留完整观察对象，无需手工挑字段。必需身份字段仍校验；context、checked、bounds 等额外观察信息不参与身份比较，selector 和动作参数仍按合同精确传入。
- 无标签 Web 控件可带 `context.ancestors`，提供有界的真实祖先文本及截断标记，帮助判断菜单属于哪条记录；据此选择已观察的 elementId。context 不是 selector 或稳定身份，祖先可能覆盖多条记录，不清楚时再筛选页面或查看截图。
- `logcat.grep` 默认匹配字面子串；`A|B` 等表达式显式用 `grepMode:"regex"`。普通空日志不意味着没有业务事件。若返回 `filterApplied:false`，查看保留的 text 和提示，不重复清空日志。
- 已派发但结果未知（`ambiguous`）时，原结果继续记为未知。可查询原回执、观察、取消或开始新的显式动作；工具不自动重放，是否重试由 agent 结合现场决定。保留原 `error`、`message`、`dispatched` 和操作状态。
- 若使用 freeze，后续操作和结束交付前先 thaw。
## 继续与恢复

旧 Host 已退出而动作结果未知时，新显式操作可继续；`previous_execution_unknown` 给出归档位置、read 请求和重叠风险。`device-ownership archives` 可按 actionId 筛选并跟随 nextCursor；`archive` 读取原记录，`reconcile-archive` 用 archiveId/entryId 只读查询原动作，不取消、不重放、不改变当前占用。归档直到明确调用 `delete-archive` 才删除；SDK 不支持只读查询时按返回说明更新。普通 `reconcile` 可能请求取消未完成动作，不能当作纯状态查询。`target_busy` 表示仍有活跃所有者，先查状态或按任务需要取消/强停。UIA 单独异常先用 `uia-runtime start`，需要重新建立会话时用 `uia-runtime force-reset`；它归档 UIA 会话，不结束整个 Bridge Host。

候选较多时先使用已完整返回的 value；需要更多已保存候选时跟随 `control.candidatePage.read`（Intent 在 lastAction 下），不会重复动作。若 `sourceTruncated:true`，跟随实际 provider 的观察提示；Web 支持 `web-dom {query:{text:"Agree",tag:"button"},offset:20,maxControls:100}`，按 nextOffset 继续，并用当前页的 elementId 明确选择。分页是新的页面观察，序号不会被当作稳定控件身份。

需要标准命令之外的诊断、安装或传输时，用 `adb-exec` 的 `argv` 数组；`serial` 可直接绑定设备，Host ADB 查询可省略。输出含 stdout/stderr/exitCode，二进制写 `outFile`。`completionScope:adb-process` 只证明 ADB 进程结束，设备效果另行观察。

**Android 截图与 UIA 共存：** 整屏取证直接用 `run({command:"screenshot",arguments:{serial:"设备"}})`；CLI 为 `ai-app-bridge screenshot --serial 设备 --out-file /absolute/step.png`。它走 ADB screencap，无需申请另一个 UiAutomation 连接或交接现有 UIA。测试到取证点后保持页面，由 Host 截图完成再继续；App View 绘图只作为 App 内部画面证据。

**复用现有执行器：** 层级读取用 `uia-tree`，节点点击用 `tap-uia`，文字条件用 `wait-text {provider:"uia"}`；它们复用 Bridge UIA。普通 ADB 安装、传输和 shell 命令可直接用 `adb-exec`。遇到 `UiAutomationService ... already registered!`，先按实际需求选择这些命令；调用 `getUiAutomation()` 不代表需求一定要另起连接。已有动作的执行机制与未知结果仍按原回执保留。

确需 Espresso、Compose 或 AndroidX UI Automator 测试线程能力时，用 `android-executor` 一次 open 后在同一 session 内连续 observe/act，结束再 close，Host 协调 UIA 占用；open 会重启目标 App。普通命令不透明代理测试进程的权限身份或任意 UiAutomation 回调。外部测试必须保留这些语义时，再处理专门的连接协调。能力对应表及现有 JUnit 的边界见 `docs/OPTIONAL_EXECUTORS.md` **Choose an Android execution path**。

`wait-text` 会在原 timeoutMs 内继续只读观察，保留尝试次数和最后失败原因，不重放动作。已发现的完整标签可在部分树中匹配；被截断的文本前缀不是完整标签。absentText 默认要求 provider 的完整观察范围；仅检查已返回部分时显式选择 `absenceScope:"observed"`，结果会保留 partial/unknown 范围。Intent summary 与 compact tree 的 `coverage.source`、`coverage.projection` 分别表示设备采集和 Host 投影，不能把投影完整当作源头完整。
