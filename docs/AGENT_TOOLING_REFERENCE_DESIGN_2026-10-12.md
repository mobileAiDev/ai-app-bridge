# AI App Bridge：同类工具参考与交互改进方案

调研日期：2026-10-12。定位：辅助测试的工具，由 agent 选择动作、执行机制和恢复方式，Bridge 提供真实观察、可组合能力与可追溯回执。

本报告查阅了官方文档和项目源码，未运行外部模型 API，未据此操作设备。仓库比较基线是 `a76302e2bd8b`；本轮工作区正在修改，文中的“建议立即采用”是设计优先级，不代表已经发布或完成各平台验收。标为“方案”的接口是设计示意，不是当前可直接执行的命令。

## 结论与采用顺序

值得参考的不只是 ADB 入口，而是一整套减少无效往返的工具体验：可选择的候选目标、动作与观察的短循环、按需返回局部证据、代码批量编排、条件等待、能继续工作的失败状态，以及一眼能看懂的恢复入口。

建议按以下顺序推进：

| 优先级 | 改进 | 本项目的采用判断 |
| --- | --- | --- |
| P0 | 前台、焦点、历史状态等诊断与动作结果分离 | 立即采用；诊断通常提供信息，不能自动扩张为整条流程的禁止条件 |
| P0 | 多匹配返回候选、精确引用和下一次调用 | 立即采用；agent 必须有选择手段，不必重新取全树并手工解析 |
| P0 | 每种执行器都有诊断、重连、重启、归档重置入口 | 立即采用；一次未知结果不得让所有后续观察和新动作永久失效 |
| P0 | 统一专家入口，包括 ADB、现有 eval 与设备操作 | 立即采用；和普通命令共享目标信息、日志与结果格式 |
| P0 | 简短错误说明和真正可调用的下一步 | 立即采用；由当前 schema 生成并验证建议，避免给出不存在的命令 |
| P1 | 局部观察、查询候选、动作后按需观察 | 在现有树过滤、compact、response 和 Script 上扩展 |
| P1 | 条件等待、短批次、明确的重试策略 | 扩展现有 wait 和 Script；不要再增加一套编排语言 |
| P1 | 面向任务的能力发现、最小示例、常见配方 | 保留小 MCP 入口与 CLI 同源契约，降低学习成本 |
| P2 | 动作时间线、证据定位和重复流程导出 | 复用已有 evidence，不另建平行日志体系 |

## 官方资料中已确认的做法

以下只陈述资料直接支持的事实。后续采用建议是针对 Bridge 的设计判断，没有把上游的宣传或机制直接当成本项目性能结论。

| 参考对象 | 已确认的做法 | 值得采用的部分 |
| --- | --- | --- |
| OpenAI Computer use | 支持持久代码执行，单次代码可包含多动作、循环与条件；结构化 computer 调用也支持有序动作数组；短组动作后返回观察，最终验证应用状态。[官方文档](https://developers.openai.com/api/docs/guides/tools-computer-use) | 让现有 Script 成为高效的常规路径；保存执行环境并减少模型往返 |
| Anthropic Computer use | 一轮可以包含多个动作，顺序执行；失败动作与后续未执行动作分别返回，模型下一轮重规划；非截图动作可返回短文本，截图与 zoom 提供图像。[官方文档](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) | 批次逐项回执、可定位的失败、组末观察；不为每个动作都传整张图 |
| Playwright Locators | 支持 role、label、精确文本和过滤链；单目标操作对多匹配报错，同时提供 `first/last/nth` 供调用者明确选择；动作执行时重新解析 locator。[官方文档](https://playwright.dev/docs/locators) | 重复文本的解决手段必须与唯一性检查一起提供 |
| Playwright Auto-waiting | 针对具体动作等待相关条件，支持超时；部分动作有 `force` 可跳过非必要检查；断言可以重复观察到条件满足。[官方文档](https://playwright.dev/docs/actionability) | 等待代替瞬时失败；检查应与动作相关，提供显式控制 |
| Playwright MCP | 提供结构化快照，支持限定目标、树深度、文件输出和坐标框；README 说明 CLI 与 MCP 各有适用场景，并强调服务本身不是安全边界。[官方仓库](https://github.com/microsoft/playwright-mcp) | 小目录、按需 schema、局部观察；保留 CLI 与 MCP，不以单一入口替代所有用途 |
| OpenAI Tool search | 延迟加载适合大工具目录，但发现过程会增加一步；官方建议用代表性任务比较完成率、输入 token 与延迟。[官方文档](https://developers.openai.com/api/docs/guides/tools-tool-search#choose-a-function-loading-strategy) | 能力发现也要测实际总成本，不能只追求工具列表短 |
| Maestro 目标定位 | 支持 `index` 选择某次出现，也支持坐标；关系选择器能表达父子关系、上下左右和包含内容。[核心选择器](https://docs.maestro.dev/reference/selectors/core-selectors)、[关系选择器](https://docs.maestro.dev/reference/selectors/relational-selectors) | 列表行、同名按钮、无唯一 ID 的页面可组合定位 |
| Maestro 等待与重试 | `tapOn` 提供屏幕稳定等待和显式 `retryTapIfNoChange`；`retry` 对小段流程重试，文档提醒整条流程重试可能掩盖不稳定。[tapOn](https://docs.maestro.dev/reference/commands-available/tapon)、[retry](https://docs.maestro.dev/reference/commands-available/retry) | 调用者可选择重试；记录次数和实际结果，不用重试掩盖缺陷 |
| uiautomator2 | 支持组合属性、文本 contains/matches、子节点/兄弟节点和相对位置；提供 UI 层级、截图、应用操作及 shell 用法。[官方 README](https://github.com/openatx/uiautomator2/blob/master/README.md) | 语义定位和底层命令并存，便利操作不要求每次都写完整流程 |
| uiautomator2 恢复实现 | `jsonrpc_call` 捕获特定 HTTP/UiAutomation 连接错误后，会停止、启动服务，再调用一次原方法。[实现源码](https://github.com/openatx/uiautomator2/blob/master/uiautomator2/core.py) | 借鉴连接自愈；原动作是否重发必须结合 Bridge 的回执事实，不能原样照搬 |
| Mobile MCP | 同时提供可访问性树和截图坐标操作，覆盖 iOS/Android 及设备生命周期能力。[官方仓库](https://github.com/mobile-next/mobile-mcp) | 没有 SDK 或语义树不完整时仍有可用入口，显式说明选用的机制 |
| Playwright Trace Viewer | 把动作、目标、耗时、前后 DOM、错误、控制台和网络放在可定位的时间线上。[官方文档](https://playwright.dev/docs/trace-viewer) | 失败时让 agent 直接找到相关证据，减少重新跑流程 |
| Android ADB | 官方提供设备选择、shell、安装、文件传输及端口转发等能力；shell 参数的解释也有明确规则。[官方文档](https://developer.android.com/tools/adb) | 将 ADB 作为 Bridge 的专家执行能力，保留原始参数及原始结果 |

## 与当前项目的对应关系

项目已经具备跨平台 provider、`capabilities + run`、Script/Intent、条件等待、响应留存和可选执行器，改造应深化这些模块，而不是另做一个“万能 agent”或另起协议。[总体设计](/Users/macbook/Documents/CompanyProject/ai-app-bridge/docs/DESIGN.md)、[能力发现](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/command-discovery.js)、[执行合同](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/shared-kernel/execution-contracts.js)

基线源码中能直接确认：

| 现有事实 | 改进方向 |
| --- | --- |
| `run` 原来要求无剪裁需求的调用也传 `extract:null` | 缺省采用渐进披露：小结果直接返回，大结果保存原文并返回结构目录、计数、样例和读取命令；允许路径/分页提取，显式 null 请求完整值。[请求契约](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/command-request.js) |
| Script 声明为 trusted local code，却有 `DENY_PERMANENT`，包括 eval 和转发 | 将能力可用性与调用者主动选择的权限分开。当前工作区已移除这类永久拒绝列表。[Script 目录](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/script/script-catalog.js) |
| UIA 基线按单一精确字段定位，多匹配只给错误；Native 已有一定的 `within` 范围表达 | 先补候选和直接引用，再扩展组合条件；不要把已存在的范围能力重复实现。[UIA 定位](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/shared-kernel/uia-target.js)、[Native 定位](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/shared-kernel/native-target.js) |
| 已有 `wait-text`，包含条件、轮询和期限 | 统一复用其机制，补候选属性等待、瞬时观察失败处理、取消和详细超时事实。[等待实现](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/shared-kernel/text-wait.js) |
| 已有输出预算、原始响应引用和再次提取 | 避免为读回大结果重新执行动作；让错误与帮助始终保留这些事实。[公共结果](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/public-reply.js) |
| 当前工作区新增了 `adb-exec`、候选指导和 UIA `force-reset` | 应完成公开入口、Script、错误回执和恢复验证；不能只在内部 helper 可用。[ADB 实现](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/shared-kernel/adb-exec.js)、[错误指导](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/shared-kernel/action-guidance.js)、[命令注册](/Users/macbook/Documents/CompanyProject/ai-app-bridge/desktop/ai-app-bridge-cli/bin/command-registry.js) |

## 方案一：让目标选择真正可用

“同意”按钮与“阅读并同意用户协议”的长文本，在**精确文本**匹配下不是同一个候选。问题出现在 contains 查询、父节点汇总文本，或多个控件都恰好叫“同意”。这几种情况应分别显示匹配方式、节点类型和上下文，而不是统称“文本不唯一”。

建议把查询与选中做成同一条便利路径：一次查询返回候选；只有一个候选时可以直接执行；有多个时返回 `selectionRequired`，同时返回 agent 可以原样提交的 `selector/targetRef` 和调用参数。候选至少包含文字、实际角色或类名、可见性、enabled/clickable、bounds、窗口和邻近标签。缺少真实角色时保留未知，不把 Android 类名猜成网页 ARIA 角色。

**方案示意，新增字段尚需实现：**

```json
{
  "query": {"text": "同意", "match": "exact", "role": "button"},
  "within": {"ref": "observed-dialog-ref"},
  "choose": {"ref": "observed-button-ref"}
}
```

分两步交付：先实现跨 provider 的候选与现有引用路径；再实现 `text + class/role + within` 的组合条件、显式序号和相对标签。

2026-10-12 后续落实：Native/UIA 已用现有 selector 实现 AND 条件、Contains 和容器/标签祖先范围，未采用上面的示意 query/choose/role 接口。Android className 来自实际观察；序号通过当前候选数组对应的真实引用实现，不另引入跨观察 index。Native 去掉 Host 重复读树，保留 SDK 原子绑定；同 View 属性变化改为提示。实际范围和验收见[审查记录](AGENT_CHOICE_AUDIT_2026-10-12.md)。序号必须关联此次观察的候选顺序，页面换了不能悄悄选“新的第二个”。候选排序可以提示“更像按钮”，但把排序依据返回给 agent，不静默替它决定。

验收包括：长说明含关键词、两个同名按钮、不唯一列表行、父子同名、按钮仅部分露出、焦点转移、换页后旧引用。能明确选择时只执行一次；旧引用失效只影响该引用，新的查询和动作仍可继续。

## 方案二：诊断提供情报，执行事实保持精确

前台包不同、没有焦点、观察被截断、旧历史尚未清理，通常应进入 `warnings`。真正无法完成当前调用时，返回该调用的事实、可用观察和下一步，而不是把 session 或设备永久封住。

保留三个独立维度：

| 维度 | 回答的问题 | 示例 |
| --- | --- | --- |
| 执行 | 这次动作是否派发，回执是否确定 | `dispatched:true`、`ambiguous:true` |
| 观察 | 工具实际看到了什么 | 安装器在前台，目标 App 在后台 |
| 断言 | 调用者要求的结果是否成立 | 新包哈希符合预期、订单确实出现 |

失去连接不能写成“未点击”，ADB 进程退出 0 不能写成“业务成功”，旧回执未知也不应阻止 agent 观察和明确发起新动作。这三条同时成立，才能既减少误报，又不制造假成功。

错误建议采用有限的结构：`code + 一句原因 + 关键事实 + nextActions`。只有能帮助继续的错误才附操作建议。多候选给选择调用；旧引用给局部观察调用；连接错误给诊断或启动调用；已知非法字段给正确字段示例。日常校验错误不附一整篇恢复说明。所有 `nextActions` 在测试中用当前公共 schema 校验，并验证不会丢掉 serial、package 或 operationId。

## 方案三：减少观察、模型和进程的重复开销

现有 `compact`、树过滤与 `extract` 是基础。建议在获取源头补“指定子树/候选查询”，让 provider 尽量少采集，而不是先完整抓取再由 Host 丢弃。输出过大时返回真实的部分结果、`truncated`、覆盖范围和继续读取方法；读不到未返回部分不能被解释为目标不存在。

动作后观察设计成调用者可选的统一参数，按使用场景决定：

```json
{
  "afterObserve": {
    "mode": "compact",
    "scope": "affected-window",
    "screenshot": false
  }
}
```

这是方案示意。原始点击、后台安装、短批次内部动作不应被强制要求截图；需要下一步界面决策时，组末一次返回目标变化、前台事实和必要图像。截图应带真实尺寸、缩放比例、裁剪原点和时间，避免坐标混用。

后续可增加按 revision/cursor 获取变化；首版优先局部查询和组末观察，避免在多平台尚不稳定时先引入复杂增量缓存。缓存必须标出观察时间，不能把旧数据当新截图或新树。

本轮采用判断已收敛：

| 方向 | 本轮决定与理由 | 当前边界 |
| --- | --- | --- |
| 首次返回结构索引后再取值 | 不作为默认流程；它会让每次有效调用多一次往返。优先完整 inline/compact，确实超预算才随真实预览提供索引及 read | 原响应 select 和候选分页已实现；不把“必须先发现字段”设为门槛 |
| 源头局部查询 | 采用已有 Web query/分页与明确 Native/UIA 容器定位；后续 SDK 子树采集作为独立协议扩展 | Native/UIA 定位范围不等于已减少整树采集，本轮不宣称支持全平台局部树；已去掉 Native 重复根树遍历与 Host 冗余读取 |
| 增量观察 | 本轮不引入跨调用隐式基线；先使用 Script 组末观察和 Intent command 的显式 observeAfter | 要新增时必须绑定 provider、epoch、revision，显式提供基线重取入口。当前没有 delta API，不用旧缓存冒充新观察 |
| 区域截图 | 保留后续可选能力，不把裁剪设为操作前提 | 各平台截图、缩放及裁剪原点合同尚未统一；当前不宣称节省图像采集成本。agent 可先用已有节点引用和结构查询完成任务 |
| 批量编排 | 已采用现有 Script：独立读取并行，写入/检查点按调用顺序等待，超出 IPC 窗口排队 | 不新增 DSL/REPL；正常错误仍交给源码决定下一步，32 是在途窗口而非调用数量上限 |

这些是针对本轮实际调用的取舍，不是禁止后续能力。先解决已经观察到的重复采集、串行读取、重复诊断文本和无法恢复的状态，避免为尚未测得收益的增量协议增加持久状态与恢复成本。

## 方案四：以现有 Script 承接短批次与便利配方

OpenAI 的代码执行方式适合本项目现有的 JS/Python Script。建议让 Script 与单命令共享实际能力，只有调用者显式提供权限集合时才限制这次脚本。没有适配器的命令应说“该入口尚未接入”并给可用入口，不能伪装成安全拒绝。

已知小流程可以一次编排输入、点击、等待和证据提取。每步仍记录独立 actionId、目标、机制和执行结果；外部只返回简短进度和最后必要观察。普通分支失败可以由脚本处理。未知动作后不自动重发原动作，同时允许读取状态、作出新的决定和明确新动作。

优先提供可发现的小配方：填写字段并读回、滚动到目标、启动应用并等待指定页面、安装并验证包、权限对话框、批量取日志与网络证据。基于现有命令生成示例，避免另起 DSL。固定重复流程用 Script；未知分支保留 Intent 的 observe/decide 路径。

不建议第一阶段新增“跨调用任意变量永久保留”的 REPL 服务。现有运行中的 Script 已能保存变量；额外 REPL 会增加崩溃恢复、依赖版本和多客户端状态问题。先比较 Script 一次任务内的效率，存在实测瓶颈再引入。

## 方案五：等待、重试和恢复各做各的事

等待是重复观察条件；重试是再次执行动作；恢复是修复执行环境。三者应有不同事实和选项。

| 场景 | 建议行为 |
| --- | --- |
| 页面尚在加载、按钮暂时未出现 | 在调用者期限内等待目标条件；记录实际等待时间和最后观察 |
| 一次观察遇到瞬时树变化 | 在观察预算内重新观察，报告尝试次数；不因此重复点击 |
| 已确定未派发的动作 | 允许 agent 重新定位、重试，或由显式策略完成 |
| 已派发但回执未知 | 保留 unknown；可以继续观察和新决定，重发原动作必须是可见的新选择 |
| 点击成功但画面不变 | 这是观察结果；默认不推定失败。需要重复点击时由配方/agent 指定次数或条件 |
| 进程已死、转发过期 | 在明确的连接恢复合同下修复传输/启动执行器；记录恢复动作，不自动重演历史业务动作 |
| 历史数据损坏或字段演进 | 隔离该历史项并保留诊断；新执行 epoch 可启动。核心身份字段仍按其实际合同解析 |

uiautomator2 的重启并重发原方法展示了便利性，但 Bridge 有持久回执和复杂业务测试，不能直接照搬所有重发行为。应采纳“环境可自愈”，同时保留“未知动作不被伪装为没有发生”的证据语义。

恢复入口需要有范围：重建转发、重新连接执行器、重启执行器、归档并创建新 epoch、停止某个操作、整设备强制停止。返回每项影响的进程/会话以及历史归档位置。不要把“重新连接 UIA”包装成默认停止所有已记录 App。

## 方案六：ADB 作为统一专家能力

新增 `adb-exec` 的方向适合当前定位。接受 `argv` 数组，Host 直接启动 adb；调用者需要远端 shell 表达式时显式写在 argv 中。ADB 本身可能调用设备 shell，接口不能因此宣称远端命令不再有 shell 解释。

以下是当前工作区 schema 对应的调用示例；仍需随最终实现验证：

```json
{
  "command": "adb-exec",
  "arguments": {
    "serial": "<device-serial>",
    "argv": ["shell", "getprop", "ro.build.version.sdk"],
    "readOnly": true,
    "timeoutMs": 5000
  }
}
```

通过该入口可以统一执行设备诊断、文件传输、安装、端口转发和其他 ADB 能力，不用不断添加业务特定白名单。结果应保留 exitCode、stdout、stderr、实际目标、派发/未知状态、耗时；二进制 stdout 用 `outFile` 等文件引用交付。`readOnly` 是调用者对本次操作的声明，不是自动命令分类器。

整机命令无需绑定某个 App 的前台。`adb devices` 等发现操作也不需要虚构目标包名。显式 serial 应贯穿实际 argv、设备并发控制和回执；如果 argv 本身也包含设备选择器，必须明确其与外层 serial 的合同，避免日志写 A 设备而实际执行 B 设备。超时、断开、输出过大或文件写入失败不能覆盖已经发生的设备执行事实。

保留高级 `install-apk` 与原始 `adb install` 两种选择：前者负责监督流程和安装验证，后者如实返回 ADB 结果。agent 根据任务选择复杂度，Bridge 不强迫所有安装都走一种流程。

## 方案七：能力发现和错误提示共同降低学习成本

保留 `capabilities + run` 的小入口，以及同源 CLI。目录增加按目标/任务查询的视图，返回“已实现”“当前设备可用”“需要何种准备”三个不同事实。静态支持不等于某台设备已经连通，也不等于某个复杂业务已验收。

每个常用命令给一条最小示例、目标要求、结果含义及相关命令。schema 由 registry 生成，CLI help、MCP 描述、Script catalog 和指导文本共用同一个契约来源。未知命令可以建议最接近的公开名称，但不要静默把错误名称映射成另一个动作。

增加按需 `doctor` 视图，汇总 transport、Host runtime、设备执行器、App SDK、当前操作、旧未知记录。它是独立诊断工具，不能变成每个点击前强制运行的大检查。故障时返回短摘要和完整证据引用。

## 方案八：把已有证据变成可浏览、可复用的测试资产

复用已有 evidence export，增加一条失败定位视图：原始调用、候选/目标、实际派发机制、动作前后观察、回执、相关日志/网络和耗时。引用复用已有记录，默认不要复制所有原始载荷。

重复成功流程可导出 Script 草稿与断言位置，供 agent 修改和再次运行。导出不等于自动重放；旧节点引用不能在新会话中继续冒充有效目标。业务断言由任务提供，不能用“没有异常”自动填为通过。

把高频失败做成工具自己的回归夹具：重复文本、动态列表、系统安装器、权限弹窗、软键盘、旋转/裁剪截图、长树、断开重连、Host 死亡、旧回执附加诊断字段。每次发布检查这些场景，减少用户反复担当发现者。

## 不宜直接照搬的设计

- 不默认选择第一个同名节点。可以提供排序和显式序号，由 agent 选择；否则只是把拒绝改成难发现的误点。
- 不将“画面没变化”普遍等同于失败并重发。网络请求、后台安装、重复提交可能没有即时视觉变化。
- 不把任何一个工具的截图、树或 locator 当作全平台唯一机制。地图、Canvas、系统 UI 和 SDK 内部状态需要不同观察方式，切换由显式请求控制。
- 不为了显得简单删除原始回执、篡改 unknown、丢弃旧错误或给所有结果填成功。便利性来自下一步可做，而不是证据消失。
- 不照搬别人的固定重试次数、超时上限或大段工具提示。默认值应有本项目实测依据，并允许调用者选择合理预算。
- 不新增隐藏的自主 agent 替上层 agent 决策。优先提供查询、动作、等待和诊断，让已有 agent 组合。

## 验证与效率指标

先用同一版本 App、同一设备、同一交互机制比较；分别报告冷启动与热调用，避免用语义 setter 对比物理触摸证明“更快”。下列是验收方法与目标，不是本次已经测得的性能数据。

| 验证集 | 必须证明的结果 | 记录指标 |
| --- | --- | --- |
| “同意”长说明 + 按钮；两个同名按钮 | 精确匹配不误含长文本；多候选后最多一次选择调用完成，目标正确且只执行一次 | 工具往返数、误匹配数、输出字节 |
| 连续填写三个字段并提交 | 短批次逐项回执，组末观察可判断结果；中途失败后可继续决策 | 模型往返、总时延、各步耗时 |
| 有动画/加载/动态列表 | 条件等待成功率提升；不会重复已派发动作来掩盖失败 | 等待时间、观察次数、实际动作计数 |
| 转发失效/进程死亡/坏历史记录 | 能诊断或恢复到新工作；旧 unknown 和归档可读，新 epoch 不被旧 completion 污染 | 恢复调用数、恢复耗时、历史完整性 |
| 安装与后台命令 | 与无关前台状态解耦；高级安装与 ADB 路径各自正确返回事实 | 派发率、错误类型、安装后独立状态 |
| 500/2000/超限节点页面 | 查询或部分观察可用，截断明确，未返回节点不被当作不存在 | provider 获取时延、p50/p95、输出字节 |
| CLI/MCP/Script 同一请求 | 能力、参数、诊断与执行结果一致；最小示例可以直接运行 | 首次成功率、需查文档次数 |
| 不支持的设备/能力 | 返回具体缺失条件和可用替代入口，不冒充跨平台通过 | 可行动错误比例、后续成功率 |

建议建立一份小型固定任务集，每次同时报告：任务完成率、错误中的误报率、需要人工接管次数、模型回合数、输入/输出 token、Host/设备耗时和恢复成本。是否采用某项效率优化，由这组实际结果决定；“少一个工具”或“用了批量调用”本身不是成功标准。
